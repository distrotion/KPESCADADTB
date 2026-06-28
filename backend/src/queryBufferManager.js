const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const { resolve: resolvePlaceholders } = require('./placeholderResolver');

/**
 * QueryBufferManager — ทะเบียน "Query Buffer" (รัน SQL ตามเวลา → เก็บผลล่าสุดไว้กลาง)
 *
 * แนวคิด (ต่อยอด Named Datalog แต่สำหรับ "result set ทั่วไป" ไม่ใช่ tag time-series):
 *   - สร้าง buffer ตั้งชื่อ + SQL + DB conn + ช่วงเวลา refresh ของตัวเอง
 *   - scheduler ต่อ buffer: ทุก intervalSec รัน query → เก็บ { columns, rows } ล่าสุด (JSON)
 *   - widget (Chart เลือก X/Y · DB Table) อ้างชื่อ buffer → ได้ผลชุดเดียว ป้อนได้หลายกราฟ
 *   - SQL ใส่ค่า tag สดได้ {{device|tag}} (แทนด้วย engine.getTagValue ฝั่ง server ตอนรัน)
 *
 * นิยาม buffer: { id, name, dbConn, sql, intervalSec(0=manual), maxRows, enabled }
 * persist นิยาม: <base>/config/querybuffers.json (atomic) · ผลล่าสุด: <base>/datalog/querybuffers/<id>.json
 */

const MIN_INTERVAL = 0;            // 0 = manual (ไม่ตั้งเวลา · refresh เอง)
const MAX_INTERVAL = 86400;        // วินาที
const DEFAULT_INTERVAL = 60;
const DEFAULT_MAXROWS = 5000;

const clampInt = (v, lo, hi, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

class QueryBufferManager {
  constructor(dbManager, tagEngine) {
    this.dbManager = dbManager;
    this.tagEngine = tagEngine || null;
    this.buffers = [];               // นิยาม (persist)
    this._timers = new Map();        // id -> interval handle
    this._trigIndex = new Map();     // 'device|tag' -> [bufferId] (buffer ที่ตั้ง triggerTag)
    this._trigLast = new Map();      // bufferId -> {value, tsFire} (ตรวจ edge + throttle)
    this._started = false;
    this._load();
  }

  // ── config persistence ─────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('querybuffers.json', path.join(__dirname, 'config', 'querybuffers.json'));
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.buffers = Array.isArray(raw.buffers) ? raw.buffers.map((b) => this._norm(b)) : [];
    } catch (_) { this.buffers = []; }
    this._buildTrigIndex();
  }
  _save() { csv.writeJsonAtomic(this.path, { buffers: this.buffers }); this._buildTrigIndex(); }

  // index 'device|tag' -> [bufferId] สำหรับ trigger ด้วย bit tag (rebuild ทุก load/save)
  _buildTrigIndex() {
    this._trigIndex = new Map();
    for (const b of this.buffers) {
      const t = (b.triggerTag || '').trim();
      if (!t || b.enabled === false) continue;
      if (!this._trigIndex.has(t)) this._trigIndex.set(t, []);
      this._trigIndex.get(t).push(b.id);
    }
  }

  // โฟลเดอร์เก็บผลล่าสุด (ใต้ datalog/ เหมือน csv อื่น — ติดไปกับ export project)
  _dataDir() {
    const d = csv.csvDir('querybuffers');
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    return d;
  }
  _dataFile(id) { return path.join(this._dataDir(), `${id}.json`); }

  _norm(b) {
    return {
      id: b.id,
      name: String(b.name || '').trim(),
      kind: ['rest', 'mongo', 'push'].includes(b.kind) ? b.kind : 'sql',   // sql | rest (HTTP JSON) | mongo | push (script เขียนผ่าน buffer.write)
      dbConn: String(b.dbConn || '').trim(),
      sql: String(b.sql || ''),
      // Mongo mode
      database: String(b.database || '').trim(),   // เลือกตอน query (ย้ายมาจาก connection)
      collection: String(b.collection || '').trim(),
      mongoOp: ['aggregate', 'count'].includes(b.mongoOp) ? b.mongoOp : 'find',
      mongoQuery: String(b.mongoQuery || ''),     // find=filter JSON · aggregate=pipeline JSON (รองรับ {{tag}})
      mongoOptions: String(b.mongoOptions || ''), // find options JSON (sort/limit/projection)
      // REST mode
      url: String(b.url || '').trim(),
      method: (String(b.method || 'GET').toUpperCase() === 'POST') ? 'POST' : 'GET',
      headers: String(b.headers || ''),          // หนึ่งบรรทัดต่อ header "Key: Value"
      body: String(b.body || ''),                 // body สำหรับ POST (รองรับ {{tag}})
      jsonPath: String(b.jsonPath || '').trim(),  // path ไปยัง array ใน response (เช่น data.items · ว่าง=root)
      intervalSec: clampInt(b.intervalSec, MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL),
      // trigger ด้วย bit tag (เสริม interval) — '' = ปิด · edge: rising(0→จริง) | change(เปลี่ยนค่า) | truthy(ทุกครั้งที่จริง)
      triggerTag: String(b.triggerTag || '').trim(),     // 'device|tag'
      triggerEdge: ['change', 'truthy'].includes(b.triggerEdge) ? b.triggerEdge : 'rising',
      triggerMinMs: clampInt(b.triggerMinMs, 0, 3600000, 0),   // throttle (0=ไม่จำกัด) กัน DB โดนรัวตอน bit toggle
      maxRows: clampInt(b.maxRows, 1, 100000, DEFAULT_MAXROWS),
      filterSummary: String(b.filterSummary || ''),   // สรุป filter ที่ใช้ (เช่น qc_scope: ลูกค้า/รายการ/วันที่) — widget Buffer Info โชว์
      // post-load filter (กรองหลังโหลด · กรองตอนอ่าน data() ไม่ดึงใหม่) — array ของ {column,values} (AND) · backward-compat กับ single object · [] = ไม่กรอง
      rowFilter: (() => {
        const norm1 = (o) => ({ column: String((o || {}).column || '').trim(), values: Array.isArray((o || {}).values) ? o.values.map((v) => `${v}`) : [] });
        const rf = b.rowFilter;
        if (Array.isArray(rf)) return rf.map(norm1).filter((f) => f.column);
        const one = norm1(rf); return one.column ? [one] : [];
      })(),
      enabled: b.enabled !== false,
      // runtime status (ไม่ persist ลึก — เก็บ lastRun/lastError/rowCount ไว้โชว์)
      lastRun: b.lastRun || null,
      lastError: b.lastError || null,
      rowCount: b.rowCount || 0,
    };
  }

  _genId(name) {
    const base = 'qb_' + (String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32).toLowerCase() || 'buf');
    const exist = new Set(this.buffers.map((b) => b.id));
    let id = base, n = 1;
    while (exist.has(id)) id = `${base}_${n++}`;
    return id;
  }
  _dupName(name, exceptId) {
    const lc = String(name).trim().toLowerCase();
    return this.buffers.some((b) => b.id !== exceptId && b.name.toLowerCase() === lc);
  }

  // getTag สำหรับ resolver (คืนค่า value หรือ null)
  _getTag() {
    const eng = this.tagEngine;
    if (!eng || typeof eng.getTagValue !== 'function') return null;
    return (dev, tag) => { const v = eng.getTagValue(dev, tag); return v ? v.value : null; };
  }
  // แทน {{tag}}+{{date}} ตาม target (sql/rest/mongo) ผ่าน resolver กลาง
  _resolve(text, target) {
    return resolvePlaceholders(text, { getTag: this._getTag(), target });
  }

  // ── ดึงข้อมูลจาก REST API → array ของแถว ──────────────────────────────────────
  //   parse headers (บรรทัดละ Key: Value) · แทน tag ใน url/body · นำทาง jsonPath ไปหา array
  async _fetchRest(b) {
    if (typeof fetch !== 'function') throw new Error('ต้องใช้ Node >= 18 (มี fetch)');
    const url = this._resolve(b.url, 'rest');
    if (!/^https?:\/\//i.test(url)) throw new Error('URL ต้องขึ้นต้น http(s)://');
    const headers = {};
    // resolve {{tag}}/{{date}} ใน header ด้วย (เหมือน url/body) → ใส่ค่า dynamic ได้ เช่น Authorization: Bearer {{D1|token}}
    for (const line of this._resolve(String(b.headers || ''), 'rest').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const opt = { method: b.method, headers };
    if (b.method === 'POST') {
      opt.body = this._resolve(b.body, 'rest');
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);   // timeout 15s
    let json;
    try {
      const r = await fetch(url, { ...opt, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      json = await r.json();
    } finally { clearTimeout(timer); }
    // นำทาง jsonPath (เช่น "data.items") ไปหา array
    let node = json;
    if (b.jsonPath) for (const seg of b.jsonPath.split('.')) { node = node != null ? node[seg] : undefined; }
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') return [node];        // object เดี่ยว → 1 แถว
    return node != null ? [{ value: node }] : [];               // ค่าเดี่ยว → คอลัมน์ value
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  list() { return this.buffers.map((b) => ({ ...b })); }
  get(id) { return this.buffers.find((b) => b.id === id) || null; }

  create(def) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('name is required');
    if (this._dupName(name)) throw new Error('ชื่อซ้ำ');
    const rec = this._norm({ ...def, id: this._genId(name), name });
    this.buffers.push(rec);
    this._save();
    if (this._started) this._arm(rec);
    this.refresh(rec.id).catch(() => {});   // ดึงครั้งแรกทันที
    return rec;
  }

  update(id, updates) {
    const i = this.buffers.findIndex((b) => b.id === id);
    if (i === -1) throw new Error('not found');
    const name = updates.name != null ? String(updates.name).trim() : this.buffers[i].name;
    if (this._dupName(name, id)) throw new Error('ชื่อซ้ำ');
    this.buffers[i] = this._norm({ ...this.buffers[i], ...updates, id, name });
    this._save();
    if (this._started) this._arm(this.buffers[i]);   // ตั้งเวลาใหม่ตาม interval ที่เปลี่ยน
    this.refresh(id).catch(() => {});
    return this.buffers[i];
  }

  remove(id) {
    const i = this.buffers.findIndex((b) => b.id === id);
    if (i === -1) return false;
    this._disarm(id);
    this.buffers.splice(i, 1);
    this._save();
    try { fs.unlinkSync(this._dataFile(id)); } catch (_) {}
    return true;
  }

  // รันจริงตามนิยาม (sql/rest/mongo) → คืน array ของแถว (ยังไม่ normalize)
  async _execute(b) {
    if (b.kind === 'rest') {
      if (!b.url.trim()) throw new Error('ยังไม่ตั้ง URL');
      return this._fetchRest(b);
    }
    if (b.kind === 'mongo') {
      if (!b.dbConn) throw new Error('ยังไม่ตั้ง Mongo connection');
      if (!b.collection.trim()) throw new Error('ยังไม่ตั้ง collection');
      const op = b.mongoOp || 'find';
      // database เลือกตอน query (ย้ายมาจาก connection) — override conn.database ต่อ buffer
      const base = this.dbManager.resolve(b.dbConn);
      const conn = b.database.trim() ? { ...base, database: b.database.trim() } : base;
      if (!conn.database) throw new Error('ยังไม่ตั้ง database');
      // แทน tag/date (target mongo: date→{"$date"} · string→JSON-safe) แล้ว parse ด้วย EJSON
      //   EJSON รองรับ {"$date":...} → Date จริง (find/aggregate บนคอลัมน์ date ใช้ได้)
      const { EJSON } = require('bson');
      const parse = (txt, dflt) => {
        const t = (txt || '').trim();
        if (!t) return dflt;
        try { return EJSON.parse(this._resolve(t, 'mongo')); }
        catch (e) { throw new Error(`JSON ไม่ถูกต้อง: ${e.message}`); }
      };
      if (op === 'aggregate') return this.dbManager.mongo(conn, b.collection, 'aggregate', parse(b.mongoQuery, []));
      if (op === 'count')     return this.dbManager.mongo(conn, b.collection, 'count', parse(b.mongoQuery, {}));
      return this.dbManager.mongo(conn, b.collection, 'find', parse(b.mongoQuery, {}), parse(b.mongoOptions, {}));
    }
    if (!b.dbConn || !b.sql.trim()) throw new Error('ยังไม่ตั้ง DB / SQL');
    return this.dbManager.query(b.dbConn, this._resolve(b.sql, 'sql'), []);
  }

  // normalize rows → { columns, rows } (ห่อค่าเดี่ยว · union คีย์ 20 แถวแรก)
  _shape(rows, maxRows) {
    // ผลที่ไม่ใช่ array (เช่น mongo count = number) → ห่อเป็น 1 แถว
    let arr = Array.isArray(rows) ? rows.slice(0, maxRows) : (rows != null ? [rows] : []);
    arr = arr.map((r) => (r != null && typeof r === 'object' && !Array.isArray(r)) ? r : { value: r });
    const cols = [];
    for (const r of arr.slice(0, 20)) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    return { columns: cols, rows: arr };
  }

  // ── รัน query → เก็บผลล่าสุด ────────────────────────────────────────────────
  async refresh(id) {
    const b = this.get(id);
    if (!b) return { ok: false, error: 'not found' };
    if (b.kind === 'push') return this.data(id, true);   // push = ไม่มี source · คงข้อมูลที่ script เขียนไว้ (ไม่ดึงใหม่)
    try {
      const { columns, rows } = this._shape(await this._execute(b), b.maxRows);
      const payload = { ok: true, columns, rows, lastRun: Date.now(), rowCount: rows.length };
      csv.writeJsonAtomic(this._dataFile(id), payload);
      b.lastRun = payload.lastRun; b.lastError = null; b.rowCount = rows.length;
      this._save();
      return payload;
    } catch (e) {
      b.lastError = e.message; b.lastRun = Date.now(); this._save();
      return { ok: false, error: e.message };
    }
  }

  // ── script เขียนผลลง buffer (kind 'push') — buffer.write จาก Script Automation ──
  //   auto-create ถ้ายังไม่มี (ตามชื่อ) → widget อ้าง ?buffer=<id> ได้ทันที · trigger คุมฝั่ง script
  //   rows = array ของ object (1 แถว/ตัว) · opts.maxRows ตั้งเพดานตอนสร้างใหม่
  writeFromScript(name, rows, opts = {}) {
    const nm = String(name || '').trim();
    if (!nm) throw new Error('buffer.write: ต้องระบุชื่อ buffer');
    let b = this.get(nm) || this.buffers.find((x) => x.name.toLowerCase() === nm.toLowerCase());
    if (b && b.kind !== 'push') throw new Error(`buffer "${nm}" มีอยู่แล้ว (kind=${b.kind}) — เขียนทับด้วย buffer.write ไม่ได้`);
    if (!b) {
      const maxRows = clampInt(opts.maxRows, 1, 100000, DEFAULT_MAXROWS);
      b = this._norm({ id: this._genId(nm), name: nm, kind: 'push', intervalSec: 0, maxRows, enabled: true });
      this.buffers.push(b);
      if (this._started) this._arm(b);   // push: intervalSec 0 → _arm ไม่ตั้ง timer
    }
    const { columns, rows: shaped } = this._shape(rows, b.maxRows);
    const payload = { ok: true, columns, rows: shaped, lastRun: Date.now(), rowCount: shaped.length };
    csv.writeJsonAtomic(this._dataFile(b.id), payload);
    b.lastRun = payload.lastRun; b.lastError = null; b.rowCount = shaped.length;
    this._save();
    return { ok: true, id: b.id, name: b.name, rowCount: shaped.length };
  }

  // ── ทดสอบยิง (ไม่บันทึกนิยาม/ไม่เก็บผล) — สำหรับปุ่ม "ทดสอบ" ในฟอร์มสร้าง buffer ──
  async test(def) {
    const t0 = Date.now();
    const b = this._norm({ ...def, id: '_test' });
    try {
      const { columns, rows } = this._shape(await this._execute(b), Math.min(b.maxRows, 200));
      return { ok: true, ms: Date.now() - t0, columns, rows: rows.slice(0, 100), rowCount: rows.length };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message };
    }
  }

  // อ่านผลล่าสุดที่เก็บไว้ (widget เรียก) — ไม่ rerun query
  //   ใส่ post-load filter (rowFilter) ตอนอ่าน · raw=true = ข้ามตัวกรอง (เช่น qc_scope ดึงรายชื่อ customer ครบ)
  data(id, raw = false) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(this._dataFile(id), 'utf8')); }
    catch (_) { return { ok: true, columns: [], rows: [], lastRun: null, rowCount: 0 }; }
    if (raw) return payload;
    const b = this.get(id);
    const filters = (b && Array.isArray(b.rowFilter)) ? b.rowFilter.filter((f) => f && f.column && Array.isArray(f.values) && f.values.length) : [];
    if (filters.length && Array.isArray(payload.rows)) {
      const sets = filters.map((f) => ({ col: f.column, set: new Set(f.values.map((v) => `${v}`)) }));
      const rows = payload.rows.filter((r) => r && sets.every((s) => s.set.has(`${r[s.col]}`)));   // AND ทุกตัวกรอง
      return { ...payload, rows, rowCount: rows.length, filtered: true, totalRows: payload.rows.length };
    }
    return payload;
  }

  // ── scheduler ต่อ buffer ────────────────────────────────────────────────────
  _arm(b) {
    this._disarm(b.id);
    if (!b.enabled || b.intervalSec <= 0) return;   // 0 = manual
    const h = setInterval(() => { this.refresh(b.id).catch(() => {}); }, b.intervalSec * 1000);
    this._timers.set(b.id, h);
  }
  _disarm(id) {
    const h = this._timers.get(id);
    if (h) { clearInterval(h); this._timers.delete(id); }
  }

  // ── trigger ด้วย bit tag (เรียกจาก engine.onTagUpdate) ──────────────────────
  //   rising = ขอบขาขึ้น (เท็จ→จริง) · change = ค่าต่างจากเดิม · truthy = ทุกครั้งที่เป็นจริง
  //   throttle ด้วย triggerMinMs กัน DB โดนรัวเมื่อ bit toggle ถี่
  onTagChange(device, tag, value) {
    if (!this._started || this._trigIndex.size === 0) return;
    const ids = this._trigIndex.get(`${device}|${tag}`);
    if (!ids) return;
    const now = Date.now();
    const truthy = (v) => v !== null && v !== undefined && v !== false && v !== '' && Number(v) !== 0;
    for (const id of ids) {
      const b = this.get(id);
      if (!b || b.enabled === false) continue;
      const last = this._trigLast.get(id);
      const prev = last ? last.value : undefined;
      let fire;
      if (b.triggerEdge === 'change')      fire = (prev === undefined || prev !== value);
      else if (b.triggerEdge === 'truthy') fire = truthy(value);
      else                                 fire = truthy(value) && !truthy(prev);   // rising (default)
      if (fire && b.triggerMinMs > 0 && last && (now - (last.tsFire || 0)) < b.triggerMinMs) fire = false;
      this._trigLast.set(id, { value, tsFire: fire ? now : (last ? last.tsFire || 0 : 0) });
      if (fire) this.refresh(id).catch(() => {});
    }
  }

  start() {
    if (this._started) return;
    this._started = true;
    for (const b of this.buffers) { this._arm(b); this.refresh(b.id).catch(() => {}); }
  }
  stop() {
    for (const id of [...this._timers.keys()]) this._disarm(id);
    this._started = false;
  }
  reload() {
    this.stop();
    this._load();
    this.start();
  }
}

module.exports = QueryBufferManager;
