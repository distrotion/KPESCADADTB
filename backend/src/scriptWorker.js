/**
 * Script Sandbox Worker — รัน user script ใน worker thread แยกจาก backend หลัก
 * ════════════════════════════════════════════════════════════════════════════
 * เหตุผล: script ที่ติด infinite loop (`while(true){}`) จะบล็อก event loop ทั้ง
 * process ถ้ารันใน thread เดียวกับ backend → server ค้าง. การรันใน worker ทำให้
 * main thread terminate worker นี้ได้เมื่อเกิน timeout (ดู scriptEngine._runInWorker)
 *
 * สถาปัตยกรรม (รักษา context API เดิมทุกตัว):
 *   • อ่าน tag (tag/tags/allTags)        → จาก snapshot ที่ส่งเข้ามา (sync, ไม่ต้อง RPC)
 *   • db.* / writeTag                    → RPC กลับ main thread (await ได้)
 *   • setTag/popup/notify/closePopup/
 *     goToPage/setPage/log               → fire-and-forget post (popup/notify gen id เองใน
 *                                          worker → คืน id ทันทีเหมือนเดิม)
 *   • httpGet/httpPost/fetch             → รันใน worker ตรง ๆ (Node ≥18 มี global fetch)
 *
 * snapshot semantics: tag()/tags อ่าน "ค่า ณ ตอนเริ่มรัน" (ไม่ใช่ live ระหว่างรัน) —
 *   เหมือน tags เดิม. ถ้าเขียนแล้วอยากอ่านค่ากลับสด ให้ใช้ผลจาก writeTag/db แทน
 * ════════════════════════════════════════════════════════════════════════════
 */
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { dateExpr } = require('./placeholderResolver');   // pure/local — date คำนวณในเธรดได้ (tz เดียวกับ main · ไม่ต้อง RPC)

const { code, trigger, snapshot } = workerData;
const tagList = Array.isArray(snapshot) ? snapshot : [];

// HTTP trigger: respond() ตั้งค่า response ที่ HTTP handler จะส่งกลับ (status/headers/body)
let _resp = null;

// ── กัน error แบบ detached ใน script ไม่ให้ฆ่า worker (และ backend) ──────────────────
//   await fn(ctx) มี try/catch จับ error ปกติ/awaited-reject อยู่แล้ว · แต่ error ที่หลุดบริบทนั้น
//   (promise ที่ไม่ await แล้ว reject · throw ใน setTimeout/callback) จะทำให้ worker thread ตาย
//   → ดักไว้ log แทน (post กลับ main → โชว์ใน console) ให้ worker อยู่รอดจน main สั่ง terminate
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? reason.message : String(reason);
  try { parentPort.postMessage({ type: 'log', level: 'error', msg: 'unhandledRejection: ' + msg }); } catch (_) {}
});
process.on('uncaughtException', (err) => {
  const msg = (err && err.message) ? err.message : String(err);
  try { parentPort.postMessage({ type: 'log', level: 'error', msg: 'uncaughtException: ' + msg }); } catch (_) {}
});

// ── RPC กลับ main thread (สำหรับ op ที่ต้อง await: writeTag, db.*) ──────────────
let _rpcId = 0;
const _pending = new Map();
function rpc(fn, args) {
  return new Promise((resolve, reject) => {
    const id = ++_rpcId;
    _pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', id, fn, args });
  });
}
parentPort.on('message', (m) => {
  if (m && m.type === 'rpcResult') {
    const p = _pending.get(m.id);
    if (p) {
      _pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error || 'rpc error'));
    }
  }
});

function emitLog(level, ...a) {
  parentPort.postMessage({ type: 'log', level, msg: a.map((x) =>
    (x !== null && typeof x === 'object') ? safeJson(x) : String(x)).join(' ') });
}
function safeJson(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }
function effect(evt) { parentPort.postMessage({ type: 'effect', evt }); }
function popupId() { return `pop_${Date.now()}_${Math.floor(Math.random() * 1000)}`; }

// HTTP client เต็มรูปแบบ (ใช้โดย httpRequest) — ทุก method + header + body · auto-JSON
async function _httpRequest(url, opts = {}) {
  if (typeof fetch === 'undefined') throw new Error('fetch ไม่พร้อม (ต้อง Node ≥18)');
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body != null && typeof body !== 'string') {
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const init = { method, headers };
  if (body != null && method !== 'GET' && method !== 'HEAD') init.body = body;
  const r = await fetch(url, init);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (opts.full) {
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, ok: r.ok, headers: h, data };
  }
  return data;
}

// ── tag resolver (เลียนแบบ tagEngine._findDevice/_findTag: id ก่อน แล้ว name) ──
function findTag(deviceRef, tagRef) {
  let cands = tagList.filter((t) => t.deviceId === deviceRef);
  if (!cands.length) cands = tagList.filter((t) => t.deviceName === deviceRef);
  if (!cands.length) return null;
  return cands.find((t) => t.id === tagRef) || cands.find((t) => t.name === tagRef) || null;
}

// ── สร้าง context (หน้าตาเหมือน scriptEngine._buildContext) ────────────────────
function buildContext() {
  const tags = {};
  for (const t of tagList) tags[`${t.deviceId}:${t.id}`] = t.value;

  return {
    tag: (deviceId, tagId) => { const m = findTag(deviceId, tagId); return m ? m.value : null; },
    tags,
    allTags: () => tagList,

    writeTag: (deviceId, tagId, value) => rpc('writeTag', [deviceId, tagId, value]),
    setTag: (deviceId, tagId, value) => {
      rpc('writeTag', [deviceId, tagId, value])
        .catch((e) => emitLog('error', `setTag ${deviceId}.${tagId}: ${e.message}`));
    },

    trigger: trigger || null,

    db: {
      query: (name, sql, params) => rpc('db.query', [name, sql, params]),
      pg:    (conn, sql, params) => rpc('db.pg', [conn, sql, params]),
      mssql: (conn, sql, params) => rpc('db.mssql', [conn, sql, params]),
      mongo: (conn, collection, op, ...args) => rpc('db.mongo', [conn, collection, op, args]),
    },

    // Query Buffer — อ่านผลล่าสุด / รัน / รายชื่อ (ทุกตัว await ได้ · ผ่าน RPC ไป main)
    buffer: (() => {
      const f = (id) => rpc('buffer.data', [id]);
      f.rows = async (id) => ((await rpc('buffer.data', [id]))?.rows || []);
      f.refresh = (id) => rpc('buffer.refresh', [id]);
      f.list = () => rpc('buffer.list', []);
      return f;
    })(),

    // popup / notify / navigate — fire-and-forget (gen id ใน worker → คืน id ทันที)
    popup: (opts) => {
      const o = (typeof opts === 'string') ? { message: opts } : (opts || {});
      const p = {
        id: o.id || popupId(),
        kind: o.kind || (o.page ? 'page' : 'message'),
        title: o.title || '',
        message: o.message != null ? String(o.message) : '',
        severity: o.severity || 'info',
        buttons: Array.isArray(o.buttons) ? o.buttons : null,
        page: o.page || null,
        width: o.width || null, height: o.height || null,
        durationMs: o.durationMs || null,
        closable: o.closable !== false,
      };
      effect({ action: 'show', popup: p });
      return p.id;
    },
    notify: (message, severity) => {
      const id = popupId();
      effect({ action: 'show', popup: {
        id, kind: 'message', title: '', message: String(message),
        severity: severity || 'info', durationMs: 4000, closable: true } });
      return id;
    },
    closePopup: (id) => effect({ action: 'close', id: id || null }),
    goToPage: (page) => effect({ action: 'navigate', page: page != null ? String(page) : '' }),
    setPage:  (page) => effect({ action: 'navigate', page: page != null ? String(page) : '' }),

    // respond(body, {status, headers, type}) — กำหนด HTTP response (สำหรับ trigger 'http')
    //   ถ้าไม่เรียก → ใช้ค่าที่ script return เป็น body (200, JSON)
    respond: (body, opts = {}) => {
      _resp = { body, status: opts.status || 200, headers: opts.headers || {}, type: opts.type || null };
      return body;
    },

    log: (...a) => emitLog('info', ...a),
    now: () => new Date(),
    // dateExpr('now-7d') → Date · dateExpr('now','date') → string · dateExpr('now.year') → number
    dateExpr: (expr, format) => dateExpr(expr, format),
    fetch: (typeof fetch !== 'undefined') ? fetch : undefined,
    httpGet: async (url, opts) => {
      if (typeof fetch === 'undefined') throw new Error('fetch ไม่พร้อม (ต้อง Node ≥18)');
      const r = await fetch(url, opts);
      const ct = r.headers.get('content-type') || '';
      return ct.includes('json') ? r.json() : r.text();
    },
    httpPost: async (url, body, opts = {}) => {
      if (typeof fetch === 'undefined') throw new Error('fetch ไม่พร้อม (ต้อง Node ≥18)');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...opts,
      });
      const ct = r.headers.get('content-type') || '';
      return ct.includes('json') ? r.json() : r.text();
    },
    // httpRequest(url, {method, headers, body}) — client เต็มรูปแบบ (ทุก method · header · body)
    //   body เป็น object → ส่ง JSON ให้อัตโนมัติ (ตั้ง Content-Type ให้ถ้ายังไม่มี)
    //   คืน body ที่ parse แล้ว (json/text) · ใส่ opts.full=true → { status, ok, headers, data }
    httpRequest: (url, opts = {}) => _httpRequest(url, opts),
    Math, JSON, Date, Number, String, parseInt, parseFloat, isNaN,
    console: { log: (...a) => emitLog('info', ...a),
               error: (...a) => emitLog('error', ...a),
               warn: (...a) => emitLog('warn', ...a) },
  };
}

// ── รัน ───────────────────────────────────────────────────────────────────────
(async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const ctx = buildContext();
    const fn = new AsyncFunction('ctx', `with(ctx){ ${code || ''} \n}`);
    const ret = await fn(ctx);
    let retOut;
    try { retOut = ret === undefined ? undefined : JSON.parse(JSON.stringify(ret)); }
    catch (_) { retOut = String(ret); }
    let respOut = null;
    if (_resp) {
      try { respOut = { ..._resp, body: _resp.body === undefined ? null : JSON.parse(JSON.stringify(_resp.body)) }; }
      catch (_) { respOut = { ..._resp, body: String(_resp.body) }; }
    }
    parentPort.postMessage({ type: 'done', ret: retOut, resp: respOut });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: (e && e.message) ? e.message : String(e) });
  }
})();
