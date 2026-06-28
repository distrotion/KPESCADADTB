/**
 * Script Automation Engine — Node-RED / Ignition style
 * ════════════════════════════════════════════════════════════════════════════
 * เขียน JavaScript ที่อ่าน tag แล้วทำงานต่อ เช่น ลง DB, คำนวณ, แจ้งเตือน
 *
 * Trigger 3 แบบ:
 *   interval   — รันทุก ๆ X ms (เช่นทุก 1 วินาที)
 *   tag_change — รันเมื่อ tag ที่กำหนดเปลี่ยนค่า
 *   cron       — รันตามตาราง cron (เช่น "0 * * * *" ทุกชั่วโมง)
 *
 * Script context (ตัวแปรที่ใช้ได้):
 *   tag(deviceId, tagId)   → ค่าปัจจุบันของ tag
 *   tags                   → object snapshot { "deviceId:tagId": value }
 *   allTags()              → array ของ tag ทั้งหมด พร้อม metadata
 *   trigger                → { deviceId, tagId, value } (เฉพาะ tag_change)
 *   db.pg(conn, sql, [p])  → query PostgreSQL → rows
 *   db.mssql(conn, sql,[p])→ query MSSQL → rows
 *   db.mongo(conn, coll, op, ...args) → MongoDB (op: find/insertOne/updateOne/aggregate/…)
 *   log(...)               → log (ดูได้ในหน้า Scripts)
 *   now()                  → Date ปัจจุบัน
 *   Math, JSON, Date, Number, String, parseInt, parseFloat
 *
 * ตัวอย่าง (ลง PostgreSQL ทุก 1 วินาที):
 *   const temp = tag('plc_1', 'D100');
 *   await db.pg(
 *     { host:'localhost', database:'scada', user:'postgres', password:'123' },
 *     'INSERT INTO logs(ts, temp) VALUES($1, $2)',
 *     [new Date(), temp]
 *   );
 *   log('saved temp =', temp);
 * ════════════════════════════════════════════════════════════════════════════
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const db   = require('./dbHelper');
const csv  = require('./csvUtil');
const { dateExpr } = require('./placeholderResolver');
const { Worker } = require('worker_threads');

const WORKER_FILE = path.join(__dirname, 'scriptWorker.js');

let cron = null;
try { cron = require('node-cron'); } catch (_) { /* optional */ }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class ScriptEngine {
  constructor(tagEngine, onLog, dbManager, onPopup, onActivity, queryBufferManager) {
    this.tagEngine = tagEngine;
    this.onLog     = onLog; // (scriptId, level, message) => void
    this.dbManager = dbManager || null;
    this.queryBufferManager = queryBufferManager || null;  // อ่าน/รัน Query Buffer ใน script
    this.onPopup   = onPopup || (() => {}); // ({action,popup,id}) => void — แสดง popup บน UI
    this.onActivity = onActivity || (() => {}); // (ev) => void — log การรัน script ลง History (เมื่อ s.logActivity)
    this.scripts   = [];
    this.intervals = new Map(); // scriptId -> intervalId
    this.crons     = new Map(); // scriptId -> cron task
    this.compiled  = new Map(); // scriptId -> AsyncFunction
    this.logs      = new Map(); // scriptId -> [{t, level, msg}]
    this.lastRun   = new Map(); // scriptId -> { t, ok, ms, error }
    this.configPath = csv.resolveConfig('scripts.json', path.join(__dirname, 'config', 'scripts.json'));

    // ── Sandbox (worker thread + timeout) — กัน script ทำ backend ค้าง ────────────
    //   default ON · ปิดได้ด้วย env KPE_SCRIPT_SANDBOX=0 (escape hatch ถ้าเจอปัญหา)
    this.sandbox = process.env.KPE_SCRIPT_SANDBOX !== '0';
    //   timeout ต่อ 1 run (ms) · override ได้ env KPE_SCRIPT_TIMEOUT_MS หรือ per-script s.timeoutMs
    this.defaultTimeout = Math.max(200, parseInt(process.env.KPE_SCRIPT_TIMEOUT_MS) || 5000);
    this._running   = new Set(); // scriptId กำลังรัน (กัน scheduled run ซ้อนกันจน worker ทับถม)
    this._timeoutHits = new Map(); // scriptId -> จำนวน timeout ติด ๆ กัน (circuit breaker)
    this.maxTimeoutHits = Math.max(1, parseInt(process.env.KPE_SCRIPT_MAX_TIMEOUT_HITS) || 3);

    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.scripts = raw.scripts || [];
      } else {
        this.scripts = [];
        this._save();
      }
    } catch (e) {
      console.error('[ScriptEngine] load error:', e.message);
      this.scripts = [];
    }
  }

  _save() {
    try {
      csv.writeJsonAtomic(this.configPath, { scripts: this.scripts });   // atomic (B3)
    } catch (e) {
      console.error('[ScriptEngine] save error:', e.message);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  start() {
    for (const s of this.scripts) {
      if (s.enabled) this._activate(s);
    }
    // tag_change hook is driven by onTagUpdate() called from outside
  }

  stop() {
    for (const id of this.intervals.keys()) this._deactivate(id);
    for (const id of this.crons.keys())     this._deactivate(id);
  }

  // โหลด scripts ใหม่จากดิสก์แล้ว reschedule (live-reload หลัง import)
  reload() {
    this.stop();
    this.compiled.clear();
    this._load();
    this.start();
  }

  // Called by server whenever any tag updates (for tag_change triggers)
  onTagUpdate(deviceId, tagId, value, quality) {
    for (const s of this.scripts) {
      if (!s.enabled) continue;
      if (s.trigger?.type !== 'tag_change') continue;
      const t = s.trigger;
      // match specific tag (deviceId+tagId) or any tag of device, or all
      const matchDev = !t.deviceId || t.deviceId === deviceId;
      const matchTag = !t.tagId    || t.tagId    === tagId;
      if (matchDev && matchTag) {
        this._run(s, { deviceId, tagId, value, quality }).catch(() => {});
      }
    }
  }

  // Called by server whenever an alarm event fires (for 'alarm' triggers)
  // evt = { type:'alarm_event', event, alarm:{...} }
  onAlarmEvent(evt) {
    if (!evt || !evt.alarm) return;
    const a = evt.alarm;
    for (const s of this.scripts) {
      if (!s.enabled) continue;
      if (s.trigger?.type !== 'alarm') continue;
      const t = s.trigger;
      // กรองตาม event (raised/cleared/acked…) / priority / alarmId ได้ (ว่าง = ทุกตัว)
      const matchEvt   = !t.event    || t.event    === evt.event;
      const matchPrio  = !t.priority || t.priority === a.priority;
      const matchId    = !t.alarmId  || t.alarmId  === a.id;
      if (matchEvt && matchPrio && matchId) {
        this._run(s, { event: evt.event, ...a }).catch(() => {});
      }
    }
  }

  // Called by server เมื่อมี serial input ดิบ (for 'serial' triggers)
  //   trigger ในสคริปต์ = { type:'serial', deviceId? }  · ว่าง deviceId = ทุก serial device
  onSerialData(deviceId, raw) {
    for (const s of this.scripts) {
      if (!s.enabled) continue;
      if (s.trigger?.type !== 'serial') continue;
      const t = s.trigger;
      if (!t.deviceId || t.deviceId === deviceId) {
        this._run(s, { deviceId, raw, value: raw }).catch(() => {});   // trigger.raw = บรรทัดดิบ
      }
    }
  }

  _activate(s) {
    this._deactivate(s.id);
    this._compile(s);

    const type = s.trigger?.type;
    if (type === 'interval') {
      const ms = Math.max(100, s.trigger.intervalMs || 1000);
      const iv = setInterval(() => this._run(s, null).catch(() => {}), ms);
      this.intervals.set(s.id, iv);
    } else if (type === 'cron' && cron) {
      const expr = s.trigger.cron || '* * * * *';
      if (cron.validate(expr)) {
        const task = cron.schedule(expr, () => this._run(s, null).catch(() => {}));
        this.crons.set(s.id, task);
      } else {
        this._log(s.id, 'error', `Invalid cron: ${expr}`);
      }
    }
    // tag_change: handled in onTagUpdate(), no timer needed
  }

  _deactivate(id) {
    const iv = this.intervals.get(id);
    if (iv) { clearInterval(iv); this.intervals.delete(id); }
    const task = this.crons.get(id);
    if (task) { try { task.stop(); } catch (_) {} this.crons.delete(id); }
  }

  _compile(s) {
    try {
      this.compiled.set(s.id, new AsyncFunction('ctx', `with(ctx){ ${s.code || ''} \n}`));
    } catch (e) {
      this.compiled.set(s.id, null);
      this._log(s.id, 'error', `Compile error: ${e.message}`);
    }
  }

  // ── Sandbox: รัน code ใน worker thread + timeout (terminate ได้แม้ติด infinite loop) ──
  //   onLog(level,msg) เรียกต่อ log แต่ละบรรทัด · คืน { ok, ms, ret, error }
  _runInWorker(code, trigger, { timeoutMs, onLog } = {}) {
    const t0 = Date.now();
    const tmo = Math.max(200, timeoutMs || this.defaultTimeout);
    // snapshot tag ปัจจุบัน (tag()/tags/allTags ใน worker อ่านจากชุดนี้)
    let snapshot = [];
    try { snapshot = this.tagEngine.getAllTags(); } catch (_) { snapshot = []; }

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let worker;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (worker) worker.terminate(); } catch (_) {}
        resolve({ ms: Date.now() - t0, ...result });
      };

      try {
        worker = new Worker(WORKER_FILE, { workerData: { code: code || '', trigger: trigger || null, snapshot } });
      } catch (e) {
        return resolve({ ok: false, ms: Date.now() - t0, error: 'worker spawn: ' + e.message });
      }

      worker.on('message', async (m) => {
        if (!m) return;
        if (m.type === 'log') {
          if (onLog) onLog(m.level || 'info', m.msg);
        } else if (m.type === 'effect') {
          try { this.onPopup(m.evt); } catch (_) {}
        } else if (m.type === 'rpc') {
          // host op (writeTag / db.*) — รันใน main thread แล้วส่งผลกลับ
          try {
            const value = await this._hostRpc(m.fn, m.args || []);
            let out; try { out = value === undefined ? null : JSON.parse(JSON.stringify(value)); }
            catch (_) { out = String(value); }
            if (!settled) worker.postMessage({ type: 'rpcResult', id: m.id, ok: true, value: out });
          } catch (e) {
            if (!settled) worker.postMessage({ type: 'rpcResult', id: m.id, ok: false, error: (e && e.message) || String(e) });
          }
        } else if (m.type === 'done') {
          done({ ok: true, ret: m.ret, resp: m.resp || null });
        } else if (m.type === 'error') {
          done({ ok: false, error: m.error });
        }
      });
      worker.on('error', (e) => done({ ok: false, error: (e && e.message) || String(e) }));
      worker.on('exit', (codeNum) => { if (!settled) done({ ok: false, error: `worker exited (${codeNum})` }); });

      timer = setTimeout(() => done({ ok: false, error: `timeout: script ทำงานเกิน ${tmo}ms — ถูกหยุด`, timeout: true }), tmo);
    });
  }

  // host op ที่ worker เรียกผ่าน RPC (เฉพาะที่ต้องแตะ tagEngine/dbManager ใน main thread)
  _hostRpc(fn, args) {
    switch (fn) {
      case 'writeTag': return this.tagEngine.writeTag(args[0], args[1], args[2]);
      case 'db.query': return this.dbManager
        ? this.dbManager.query(args[0], args[1], args[2])
        : Promise.reject(new Error('No database manager'));
      case 'db.pg': {
        const c = (typeof args[0] === 'string' && this.dbManager) ? this.dbManager.resolve(args[0]) : args[0];
        return db.pg(c, args[1], args[2]);
      }
      case 'db.mssql': {
        const c = (typeof args[0] === 'string' && this.dbManager) ? this.dbManager.resolve(args[0]) : args[0];
        return db.mssql(c, args[1], args[2]);
      }
      case 'db.mongo': {
        const c = (typeof args[0] === 'string' && this.dbManager) ? this.dbManager.resolve(args[0]) : args[0];
        return db.mongo(c, args[1], args[2], args[3]);
      }
      // Query Buffer (อ่านผลล่าสุด / รัน query เดี๋ยวนี้ / รายชื่อ)
      case 'buffer.data':    return this.queryBufferManager ? this.queryBufferManager.data(args[0]) : null;
      case 'buffer.refresh': return this.queryBufferManager ? this.queryBufferManager.refresh(args[0]) : Promise.reject(new Error('No query buffer'));
      case 'buffer.list':    return this.queryBufferManager ? this.queryBufferManager.list() : [];
      default: return Promise.reject(new Error('unknown rpc: ' + fn));
    }
  }

  // ── execution ───────────────────────────────────────────────────────────
  // log การรัน 1 ครั้งลง History (เฉพาะ script ที่เปิด logActivity) — ⚠️ interval ถี่ ๆ = entry เยอะ
  _logRunActivity(s, trigger, r) {
    if (!s.logActivity) return;
    const tt = (trigger && trigger.type) || (s.trigger && s.trigger.type) || '';
    try {
      this.onActivity({
        scriptId: s.id, name: s.name || s.id, action: 'run',
        result: r.ok ? 'ok' : 'fail',
        detail: (r.ok ? `${tt} ${r.ms ?? 0}ms` : String(r.error || 'error')).slice(0, 200),
      });
    } catch (_) {}
  }

  async _run(s, trigger) {
    if (this.sandbox) return this._runScheduledSandboxed(s, trigger);

    const fn = this.compiled.get(s.id);
    if (!fn) { this._compile(s); }
    const compiled = this.compiled.get(s.id);
    if (!compiled) return;

    const t0 = Date.now();
    try {
      const ctx = this._buildContext(s, trigger);
      await compiled(ctx);
      const ms = Date.now() - t0;
      this.lastRun.set(s.id, { t: Date.now(), ok: true, ms, error: null });
      this._logRunActivity(s, trigger, { ok: true, ms });
    } catch (e) {
      const ms = Date.now() - t0;
      this.lastRun.set(s.id, { t: Date.now(), ok: false, ms, error: e.message });
      this._log(s.id, 'error', e.message);
      this._logRunActivity(s, trigger, { ok: false, ms, error: e.message });
    }
  }

  // รัน scheduled/trigger script ใน sandbox + overlap guard + circuit breaker
  async _runScheduledSandboxed(s, trigger) {
    if (this._running.has(s.id)) return; // run เก่ายังไม่เสร็จ — ข้าม tick นี้ (กัน worker ทับถม)
    this._running.add(s.id);
    try {
      const r = await this._runInWorker(s.code, trigger, {
        timeoutMs: s.timeoutMs,
        onLog: (level, msg) => this._log(s.id, level, msg),
      });
      this.lastRun.set(s.id, { t: Date.now(), ok: r.ok, ms: r.ms, error: r.ok ? null : r.error });
      if (!r.ok) this._log(s.id, 'error', r.error);
      this._logRunActivity(s, trigger, r);

      // circuit breaker: timeout ติด ๆ กัน → ปิด script กัน worker ถูก spawn/terminate ไม่หยุด
      if (r.timeout) {
        const hits = (this._timeoutHits.get(s.id) || 0) + 1;
        this._timeoutHits.set(s.id, hits);
        if (hits >= this.maxTimeoutHits) {
          this._timeoutHits.delete(s.id);
          this._log(s.id, 'error', `ปิด script อัตโนมัติ: timeout ${hits} ครั้งติดกัน (กัน backend ค้าง)`);
          try { this.updateScript(s.id, { enabled: false }); } catch (_) { this._deactivate(s.id); }
        }
      } else {
        this._timeoutHits.delete(s.id);
      }
    } finally {
      this._running.delete(s.id);
    }
  }

  // ── HTTP trigger — รัน script เมื่อมี HTTP request เข้า hook · คืน {ok, ret, resp, error, ms} ──
  //   ไม่ใช้ overlap guard (แต่ละ request เป็นอิสระ รันพร้อมกันได้ · timeout/terminate จาก §41 ยังคุ้มครอง)
  async runHttp(s, reqData) {
    const r = await this._runInWorker(s.code, reqData, {
      timeoutMs: s.timeoutMs,
      onLog: (level, msg) => this._log(s.id, level, msg),
    });
    this.lastRun.set(s.id, { t: Date.now(), ok: r.ok, ms: r.ms, error: r.ok ? null : r.error });
    if (!r.ok) this._log(s.id, 'error', r.error);
    this._logRunActivity(s, reqData, r);
    return r;
  }

  // หา script ที่ผูกกับ hook path + method (enabled, trigger.type==='http') · method ตรงเป๊ะมาก่อน ANY
  matchHttp(path, method) {
    const m = String(method || '').toUpperCase();
    const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
    const cands = this.scripts.filter(s => s.enabled && s.trigger?.type === 'http'
      && norm(s.trigger.path) === norm(path));
    if (!cands.length) return null;
    return cands.find(s => String(s.trigger.method || '').toUpperCase() === m)
        || cands.find(s => { const mm = String(s.trigger.method || 'ANY').toUpperCase(); return mm === 'ANY' || mm === ''; })
        || null;
  }

  // ── Test run — รัน code ที่ยังไม่เซฟ ครั้งเดียว แล้วเก็บ log กลับ (สำหรับปุ่ม Run ในหน้า edit) ──
  //   รันใน sandbox worker + timeout (เหมือน scheduled) → script พังก็ไม่ทำ backend ค้าง
  async testRun(code, trigger, timeoutMs) {
    const logs = [];
    if (!this.sandbox) return this._testRunInProcess(code, trigger);
    const r = await this._runInWorker(code, trigger, {
      timeoutMs: timeoutMs,
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    if (r.ok && r.ret !== undefined && r.ret !== null) {
      logs.push({ level: 'info', msg: 'return: ' +
        (typeof r.ret === 'object' ? JSON.stringify(r.ret) : String(r.ret)) });
    }
    if (!r.ok) {
      logs.push({ level: 'error', msg: r.error });
      return { ok: false, ms: r.ms, error: r.error, logs };
    }
    return { ok: true, ms: r.ms, logs };
  }

  // fallback (ใช้เมื่อ sandbox ปิด) — รันใน process เดิม (⚠️ infinite loop ทำ backend ค้างได้)
  async _testRunInProcess(code, trigger) {
    const logs = [];
    const cap = (level) => (...a) => logs.push({ level, msg: a.map((x) =>
      typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ') });
    const ctx = this._buildContext({ id: '__test__', code }, trigger || null);
    ctx.log = cap('info');
    ctx.console = { log: cap('info'), error: cap('error'), warn: cap('warn') };
    const t0 = Date.now();
    try {
      const fn = new AsyncFunction('ctx', `with(ctx){ ${code || ''} \n}`);
      const ret = await fn(ctx);
      if (ret !== undefined) logs.push({ level: 'info', msg: 'return: ' +
        (typeof ret === 'object' ? JSON.stringify(ret) : String(ret)) });
      return { ok: true, ms: Date.now() - t0, logs };
    } catch (e) {
      logs.push({ level: 'error', msg: e.message });
      return { ok: false, ms: Date.now() - t0, error: e.message, logs };
    }
  }

  _buildContext(s, trigger) {
    const self = this;
    return {
      // tag access
      tag: (deviceId, tagId) => {
        const v = self.tagEngine.getTagValue(deviceId, tagId);
        return v ? v.value : null;
      },
      tags: (() => {
        const obj = {};
        for (const t of self.tagEngine.getAllTags()) {
          obj[`${t.deviceId}:${t.id}`] = t.value;
        }
        return obj;
      })(),
      allTags: () => self.tagEngine.getAllTags(),
      // writeTag — ส่งค่าถึง device (real = สั่ง PLC จริง, sim/virtual = buffer) — await ได้
      writeTag: (deviceId, tagId, value) => self.tagEngine.writeTag(deviceId, tagId, value),
      // setTag — ส่งค่าถึง device เหมือน writeTag (real→PLC, sim/virtual→buffer)
      // fire-and-forget: ไม่ต้อง await, error จะ log ให้ (เดิม setTag เขียนแค่ buffer → โดน poll ทับ)
      setTag: (deviceId, tagId, value) => {
        self.tagEngine.writeTag(deviceId, tagId, value)
          .catch(e => self._log(s.id, 'error', `setTag ${deviceId}.${tagId}: ${e.message}`));
      },

      trigger: trigger || null,

      // database — conn เป็นชื่อ connection ที่บันทึกไว้ หรือ config object ก็ได้
      db: {
        // db.query('myconn', sql, params) — ใช้ type ตาม config ที่บันทึก
        query: (name, sql, params) => self.dbManager
          ? self.dbManager.query(name, sql, params)
          : Promise.reject(new Error('No database manager')),
        pg: (conn, sql, params) => {
          const c = (typeof conn === 'string' && self.dbManager) ? self.dbManager.resolve(conn) : conn;
          return db.pg(c, sql, params);
        },
        mssql: (conn, sql, params) => {
          const c = (typeof conn === 'string' && self.dbManager) ? self.dbManager.resolve(conn) : conn;
          return db.mssql(c, sql, params);
        },
        // db.mongo('conn', 'collection', 'op', ...args)
        //   op: find|findOne|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|count|aggregate
        mongo: (conn, collection, op, ...args) => {
          const c = (typeof conn === 'string' && self.dbManager) ? self.dbManager.resolve(conn) : conn;
          return db.mongo(c, collection, op, args);
        },
      },

      // ── Query Buffer (อ้างชื่อ buffer ที่สร้างในแท็บ Query) ────────────────────
      //   buffer('id')        → ผลล่าสุด { columns, rows, lastRun, rowCount }
      //   buffer.rows('id')   → array ของแถว (สั้น)
      //   buffer.refresh('id')→ await รัน query เดี๋ยวนี้ → ผลใหม่
      //   buffer.list()       → [{id,name,...}]
      buffer: (() => {
        const f = (id) => self.queryBufferManager ? self.queryBufferManager.data(id) : null;
        f.rows = (id) => (self.queryBufferManager ? (self.queryBufferManager.data(id).rows || []) : []);
        f.refresh = (id) => self.queryBufferManager ? self.queryBufferManager.refresh(id) : Promise.reject(new Error('No query buffer'));
        f.list = () => self.queryBufferManager ? self.queryBufferManager.list() : [];
        return f;
      })(),

      // ── Popup / notify บน UI (broadcast ไปทุก client) ──────────────────────
      // popup('ข้อความ')  หรือ  popup({title,message,severity,kind,page,buttons,durationMs,id})
      // คืน id (ใช้ closePopup(id) ปิดได้)
      popup: (opts) => {
        const o = (typeof opts === 'string') ? { message: opts } : (opts || {});
        const p = {
          id: o.id || `pop_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          kind: o.kind || (o.page ? 'page' : 'message'),
          title: o.title || '',
          message: o.message != null ? String(o.message) : '',
          severity: o.severity || 'info',          // info | warning | error | success | confirm
          buttons: Array.isArray(o.buttons) ? o.buttons : null,
          page: o.page || null,                     // id/name ของหน้า (kind=page)
          width: o.width || null, height: o.height || null,
          durationMs: o.durationMs || null,         // auto-close (ms)
          closable: o.closable !== false,
        };
        self.onPopup({ action: 'show', popup: p });
        return p.id;
      },
      // notify('ข้อความ', 'warning') — toast เด้งหายเอง 4s
      notify: (message, severity) => {
        const id = `pop_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        self.onPopup({ action: 'show', popup: {
          id, kind: 'message', title: '', message: String(message),
          severity: severity || 'info', durationMs: 4000, closable: true } });
        return id;
      },
      closePopup: (id) => self.onPopup({ action: 'close', id: id || null }),

      // เปลี่ยนหน้า dashboard (run/deploy) — รับ id, name หรือเลขหน้า (1-based)
      //   goToPage('overview')  ·  goToPage('p123...')  ·  goToPage(2)
      goToPage: (page) => self.onPopup({ action: 'navigate', page: page != null ? String(page) : '' }),
      setPage:  (page) => self.onPopup({ action: 'navigate', page: page != null ? String(page) : '' }),

      // utils
      log:  (...a) => self._log(s.id, 'info', a.map(x =>
              typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')),
      now:  () => new Date(),
      // dateExpr('now-7d') → Date · dateExpr('now','date') → '2026-06-13' · dateExpr('now.year') → 2026
      //   (ไวยากรณ์เดียวกับ {{...}} · นาฬิกา local ของ server · pure ไม่ต้อง RPC)
      dateExpr: (expr, format) => dateExpr(expr, format),
      fetch: (typeof fetch !== 'undefined') ? fetch : undefined,
      // httpGet(url) → JSON (หรือ text) · httpPost(url, body) → JSON · ใช้ fetch ภายใน
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
      //   body object → JSON อัตโนมัติ · คืน body parse แล้ว (json/text) · opts.full=true → {status,ok,headers,data}
      httpRequest: async (url, opts = {}) => {
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
        if (opts.full) { const h = {}; r.headers.forEach((v, k) => { h[k] = v; }); return { status: r.status, ok: r.ok, headers: h, data }; }
        return data;
      },
      Math, JSON, Date, Number, String, parseInt, parseFloat, isNaN,
      console: { log: (...a) => self._log(s.id, 'info', a.join(' ')) },
    };
  }

  _log(scriptId, level, msg) {
    if (!this.logs.has(scriptId)) this.logs.set(scriptId, []);
    const arr = this.logs.get(scriptId);
    const entry = { t: Date.now(), level, msg };
    arr.push(entry);
    if (arr.length > 100) arr.shift();
    if (this.onLog) this.onLog(scriptId, level, msg);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  getScripts() {
    return this.scripts.map(s => ({
      ...s,
      _status: this.lastRun.get(s.id) || null,
      _active: this.intervals.has(s.id) || this.crons.has(s.id) ||
               (s.enabled && ['tag_change', 'serial', 'alarm', 'http'].includes(s.trigger?.type)),
    }));
  }

  getLogs(scriptId) {
    return this.logs.get(scriptId) || [];
  }

  // ตรวจ syntax ของโค้ด (compile แบบเดียวกับตอนรันจริง) — คืน {ok} หรือ {ok:false, error}
  validate(code) {
    try {
      // eslint-disable-next-line no-new
      new AsyncFunction('ctx', `with(ctx){ ${code || ''} \n}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ล้าง log ของ script (คืนจำนวนที่ลบ)
  clearLogs(scriptId) {
    const n = (this.logs.get(scriptId) || []).length;
    this.logs.set(scriptId, []);
    return n;
  }

  addScript(script) {
    if (!script.id)   script.id = 'script_' + Date.now();
    if (this.scripts.find(s => s.id === script.id))
      throw new Error(`Script ID "${script.id}" already exists`);
    const s = {
      id:      script.id,
      name:    script.name || script.id,
      enabled: script.enabled ?? false,
      trigger: script.trigger || { type: 'interval', intervalMs: 1000 },
      code:    script.code || '',
      logActivity: script.logActivity ?? false,   // log การรันลง History (default ปิด)
    };
    this.scripts.push(s);
    this._save();
    if (s.enabled) this._activate(s);
    return s;
  }

  updateScript(id, updates) {
    const idx = this.scripts.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`Script not found: ${id}`);
    const old = this.scripts[idx];
    // versioning: เก็บสแนปช็อตเดิมถ้า code/trigger/name เปลี่ยน (เก็บสูงสุด 20)
    const versions = Array.isArray(old.versions) ? old.versions.slice() : [];
    const changed = ('code' in updates && updates.code !== old.code)
                 || ('name' in updates && updates.name !== old.name)
                 || ('trigger' in updates && JSON.stringify(updates.trigger) !== JSON.stringify(old.trigger));
    if (changed) {
      versions.push({ t: Date.now(), name: old.name, code: old.code, trigger: old.trigger });
      while (versions.length > 20) versions.shift();
    }
    const s = { ...old, ...updates, id, versions };
    this.scripts[idx] = s;
    this._save();
    // re-activate with new settings
    this._deactivate(id);
    this.compiled.delete(id);
    if (s.enabled) this._activate(s);
    return s;
  }

  // ── Versioning (history + rollback) ────────────────────────────────────────
  getVersions(id) {
    const s = this.scripts.find(s => s.id === id);
    if (!s) throw new Error(`Script not found: ${id}`);
    return (s.versions || []).slice().reverse();   // ใหม่สุดก่อน
  }

  // restore เวอร์ชันที่ index (นับจากใหม่สุด=0) — สแนปช็อตปัจจุบันถูกเก็บก่อน (ผ่าน updateScript)
  restoreVersion(id, index) {
    const s = this.scripts.find(s => s.id === id);
    if (!s) throw new Error(`Script not found: ${id}`);
    const vers = (s.versions || []).slice().reverse();
    const v = vers[index];
    if (!v) throw new Error(`Version not found: ${index}`);
    return this.updateScript(id, { name: v.name, code: v.code, trigger: v.trigger });
  }

  removeScript(id) {
    const idx = this.scripts.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`Script not found: ${id}`);
    this._deactivate(id);
    this.compiled.delete(id);
    this.logs.delete(id);
    this.lastRun.delete(id);
    this.scripts.splice(idx, 1);
    this._save();
  }

  // Run once manually (for testing)
  async runOnce(id) {
    const s = this.scripts.find(s => s.id === id);
    if (!s) throw new Error(`Script not found: ${id}`);
    this._compile(s);
    await this._run(s, null);
    return this.lastRun.get(id);
  }
}

module.exports = ScriptEngine;
