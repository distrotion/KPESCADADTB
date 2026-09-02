const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');

/**
 * DatalogManager — ทะเบียน "named datalog" (สร้างชื่อ log ก่อน แล้วเอาชื่อไปใช้)
 *
 * แนวคิด: แทนที่จะให้ chart widget แต่ละตัว log แยกกัน (csvId/dbTable ของตัวเอง → ข้อมูลซ้ำ/ชนกัน)
 *   → สร้าง "log ที่ตั้งชื่อ" ไว้ตัวกลาง · backend เก็บข้อมูลให้ "ที่เดียว" (writer เดียวต่อ log)
 *   → ที่อื่น (chart widget / หน้า History-Trend) แค่ "อ้างชื่อ log" ไปแสดง (read-only)
 *   → โชว์ log เดียวกันได้หลายที่พร้อมกัน ข้อมูลตรงกันเป๊ะ ไม่ชนกัน
 *
 * นิยาม log: { id, name, series:[{device,tag,label,color}], storage:'csv'|'database',
 *              dbConn, sampleMs, retentionDays, enabled }
 *   - id = คีย์ table/CSV-prefix (alnum/underscore, gen จาก name) — เสถียร ไม่เปลี่ยนตามชื่อ
 *   - storage เลือกได้ต่อ log (default csv) · database ต้องมี dbConn ไม่งั้น fallback csv
 *   - sampler ต่อ log: ทุก sampleMs อ่านค่า series ผ่าน tagEngine → chartStore (csv/db)
 *   - retention: prune ข้อมูลเก่ากว่า retentionDays (0 = เก็บตลอด) ทุกชั่วโมง + ตอน start
 *
 * persist: <base>/config/datalogs.json (atomic write — B3 กันไฟดับ)
 */

const MIN_SAMPLE_MS = 500;
const MAX_SAMPLE_MS = 3600000;
const DEFAULT_SAMPLE_MS = 1000;
const DEFAULT_RETENTION = 30;          // วัน (0 = เก็บตลอด)
const PRUNE_INTERVAL_MS = 3600000;     // prune ทุก 1 ชั่วโมง
const FLUSH_MS = 5000;                  // batch: flush CSV ที่สะสม ทุก 5 วิ (ลด file-write → ลด EDR/CPU บน Windows)
const NOTE_DEVICE = '__note__';        // device พิเศษสำหรับ annotation (comment พิมพ์เอง) — เก็บใน value_text

const clampInt = (v, lo, hi, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

class DatalogManager {
  constructor(tagEngine, chartStore, dbManager) {
    this.tagEngine = tagEngine;
    this.chartStore = chartStore;
    this.dbManager = dbManager || null;
    this.logs = [];                  // นิยาม log (persist)
    this._timers = new Map();        // id -> sampler interval handle
    this._pruneTimer = null;
    this._started = false;
    this._changeIndex = new Map();   // 'device/tag' -> [logId] (logs ที่ onChange) · เร็วเวลา tag เปลี่ยน
    this._lastChange = new Map();    // 'logId|device/tag' -> {value, ts} (dedup/deadband/throttle)
    this._buf = new Map();           // id -> samples[] (batch CSV · flush เป็นช่วง ตอน _started)
    this._flushTimer = null;
    this._load();
  }

  // ── config persistence ─────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('datalogs.json', path.join(__dirname, 'config', 'datalogs.json'));
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.logs = Array.isArray(raw.logs) ? raw.logs.map((l) => this._norm(l)) : [];
    } catch (_) {
      this.logs = [];
    }
    this._rebuildChangeIndex();
  }

  _save() {
    csv.writeJsonAtomic(this.path, { logs: this.logs });   // atomic (B3)
    this._rebuildChangeIndex();
  }

  // โหลด defs ใหม่จากดิสก์ (live-reload หลัง import) + re-arm sampler
  reload() {
    this._flushAll();   // เขียนที่ค้างก่อนโหลด def ใหม่ (กันตกหล่น)
    const wasStarted = this._started;
    if (wasStarted) for (const id of [...this._timers.keys()]) this._disarm(id);
    this._load();
    if (wasStarted) for (const log of this.logs) this._arm(log);
  }

  // ── normalize / validate 1 นิยาม ───────────────────────────────────────────
  _norm(d) {
    d = d || {};
    const series = (Array.isArray(d.series) ? d.series : []).map((s) => {
      const script = String(s.script || '').trim();   // โหมด script: คำนวณค่าตอน log (tag/pad/Math/...) แทนเลือก tag
      return {
        device: script ? '__script__' : String(s.device || ''),   // script → device/tag เป็น identity ที่ตั้ง (ชื่อย่อ)
        tag: script ? String(s.tag || s.label || '') : String(s.tag || ''),
        script,
        label: s.label != null ? String(s.label) : '',
        color: typeof s.color === 'number' ? s.color : null,
        text: s.text === true,   // เก็บเป็นข้อความ (string tag · comment) → value_text · ไม่ใช่ตัวเลข/ไม่ปัด/ไม่ transform
        markerPos: ['top', 'bottom', 'none'].includes(String(s.markerPos)) ? String(s.markerPos) : 'top',   // ตำแหน่งป้าย marker บนกราฟ Trend (text)
        // transform ก่อน log (เฉพาะตอน log · แยกจาก tag.scale): logged = value*factor + offset แล้วปัด decimals ตำแหน่ง
        factor: (Number.isFinite(Number(s.factor)) && Number(s.factor) !== 0) ? Number(s.factor) : 1,   // 0 = กันหารพัง → 1
        offset: Number.isFinite(Number(s.offset)) ? Number(s.offset) : 0,
        decimals: (s.decimals == null || s.decimals === '') ? null : clampInt(s.decimals, 0, 10, 0),
      };
    }).filter((s) => s.script ? !!s.tag : (s.device && s.tag));   // script: ต้องมีชื่อย่อ (identity)
    let storage = d.storage === 'database' ? 'database' : 'csv';
    const dbConn = String(d.dbConn || '');
    if (storage === 'database' && !dbConn) storage = 'csv';   // database ต้องมี conn ไม่งั้น fallback
    const retRaw = Number(d.retentionDays);
    return {
      id: String(d.id || ''),
      name: String(d.name || '').trim(),
      group: String(d.group || '').trim(),   // กลุ่มจัดระเบียบ (ผู้ใช้ตั้งเอง · ว่าง = "ทั่วไป" ฝั่ง UI) — ไม่กระทบ logic การ log
      series,
      storage,
      dbConn,
      sampleMs: clampInt(d.sampleMs, MIN_SAMPLE_MS, MAX_SAMPLE_MS, DEFAULT_SAMPLE_MS),
      retentionDays: Number.isFinite(retRaw) && retRaw >= 0 ? Math.round(retRaw) : DEFAULT_RETENTION,
      enabled: d.enabled !== false,
      // ── โหมดเก็บ (เพิ่มได้พร้อมกัน) ──
      periodic: d.periodic !== false,          // log ตามคาบ (default true · backward compat)
      onChange: d.onChange === true,           // log เมื่อ tag เปลี่ยนค่า (เพิ่ม)
      deadband: Number.isFinite(Number(d.deadband)) && Number(d.deadband) > 0 ? Number(d.deadband) : 0,  // analog: log เมื่อ |Δ| ≥ deadband (0=ทุกการเปลี่ยน)
      changeMinMs: clampInt(d.changeMinMs, 0, MAX_SAMPLE_MS, 0),   // throttle on-change ต่อ series (0=ไม่จำกัด)
    };
  }

  // index 'device/tag' -> [logId] ของ log ที่เปิด onChange (rebuild ทุกครั้งที่ logs เปลี่ยน)
  _rebuildChangeIndex() {
    this._changeIndex = new Map();
    for (const log of this.logs) {
      if (!log.onChange) continue;
      for (const s of log.series) {
        const k = `${s.device}/${s.tag}`;
        if (!this._changeIndex.has(k)) this._changeIndex.set(k, []);
        this._changeIndex.get(k).push(log.id);
      }
    }
  }

  // gen id ปลอดภัย (alnum/underscore) จากชื่อ — รองรับชื่อไทย (slug ว่าง → 'log') + กันซ้ำ
  _genId(name) {
    let base = 'dl_' + (String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32).toLowerCase() || 'log');
    const exist = new Set(this.logs.map((l) => l.id));
    let id = base, n = 1;
    while (exist.has(id)) id = `${base}_${n++}`;
    return id;
  }

  _dupName(name, exceptId) {
    const lc = String(name).trim().toLowerCase();
    return this.logs.some((l) => l.id !== exceptId && l.name.toLowerCase() === lc);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  list() { return this.logs.map((l) => ({ ...l, series: l.series.map((s) => ({ ...s })) })); }
  get(id) { return this.logs.find((l) => l.id === id) || null; }

  create(def) {
    def = def || {};
    const name = String(def.name || '').trim();
    if (!name) throw new Error('name required');
    if (this._dupName(name)) throw new Error('duplicate name');
    const id = this._genId(name);
    const log = this._norm({ ...def, id, name });
    if (log.series.length === 0) throw new Error('series required');
    this.logs.push(log);
    this._save();
    this._arm(log);
    return log;
  }

  update(id, patch) {
    const idx = this.logs.findIndex((l) => l.id === id);
    if (idx < 0) throw new Error('not found');
    patch = patch || {};
    const cur = this.logs[idx];
    const name = patch.name != null ? String(patch.name).trim() : cur.name;
    if (!name) throw new Error('name required');
    if (this._dupName(name, id)) throw new Error('duplicate name');
    // series: ถ้า patch ไม่ส่งมา = คงเดิม
    const merged = this._norm({ ...cur, ...patch, id, name,
      series: patch.series != null ? patch.series : cur.series });
    if (merged.series.length === 0) throw new Error('series required');
    this.logs[idx] = merged;
    this._save();
    this._disarm(id);
    this._arm(merged);
    return merged;
  }

  remove(id) {
    const idx = this.logs.findIndex((l) => l.id === id);
    if (idx < 0) return false;
    this.logs.splice(idx, 1);
    this._save();
    this._disarm(id);
    return true;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  start() {
    this._started = true;
    this._lastChange.clear();   // เริ่มใหม่ → ค่าแรกของแต่ละ series หลัง start จะถูก log
    for (const log of this.logs) this._arm(log);
    this._pruneTimer = setInterval(() => this._pruneAll(), PRUNE_INTERVAL_MS);
    this._pruneAll();   // prune ตอน boot ด้วย
    // batch flush timer — เขียน CSV ที่สะสมเป็นช่วง (ลด file-write บน Windows/EDR)
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => this._flushAll(), FLUSH_MS);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  stop() {
    this._started = false;
    for (const id of [...this._timers.keys()]) this._disarm(id);
    if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; }
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
    this._flushAll();   // เขียนที่ค้างก่อนหยุด (ไม่ตกหล่น)
  }

  // เขียน buffer CSV ที่ค้างลงดิสก์ (เรียกจาก flush timer · stop · reload · flush())
  _flushAll() {
    if (this._buf.size === 0) return;
    for (const [id, samples] of this._buf) {
      if (samples && samples.length) { try { this.chartStore.logCsv(id, samples); } catch (_) {} }
    }
    this._buf.clear();
  }
  flush() { this._flushAll(); }   // public — flush ทันที (manual/ก่อนอ่าน)

  _arm(log) {
    if (!this._started || !log.enabled || log.series.length === 0) return;
    this._disarm(log.id);
    if (log.periodic === false) return;   // โหมด on-change อย่างเดียว → ไม่มี sampler timer
    const h = setInterval(() => this._sample(log.id), log.sampleMs);
    if (h && typeof h.unref === 'function') h.unref();   // ไม่กันโปรเซสปิด
    this._timers.set(log.id, h);
  }

  _disarm(id) {
    const h = this._timers.get(id);
    if (h) { clearInterval(h); this._timers.delete(id); }
  }

  // transform ค่าก่อน log (ต่อ series): logged = value*factor + offset แล้วปัด decimals ตำแหน่ง · default 1/0/ไม่ปัด = ค่าเดิม
  _applyTransform(s, num) {
    let v = num * (s.factor != null ? s.factor : 1) + (s.offset != null ? s.offset : 0);
    if (s.decimals != null) { const m = 10 ** s.decimals; v = Math.round(v * m) / m; }
    return v;
  }

  // อ่านค่าทุก series ของ log "ที่จุดเวลาเดียวกัน" → เขียนลง store ครั้งเดียว (writer เดียว, ไม่ชนกัน)
  _sample(id) {
    const log = this.get(id);
    if (!log || !log.enabled) return;
    const ts = Date.now();
    const samples = [];
    for (const s of log.series) {
      const raw = s.script ? this._evalScript(s.script) : (() => { const v = this.tagEngine.getTagValue(s.device, s.tag); return v ? v.value : null; })();
      if (raw == null) continue;
      if (s.text) { samples.push({ device: s.device, tag: s.tag, valueText: String(raw), ts }); continue; }   // ข้อความ (string/comment) → value_text
      const num = Number(raw);
      if (Number.isNaN(num)) continue;
      samples.push({ device: s.device, tag: s.tag, value: this._applyTransform(s, num), ts });
    }
    this._write(log, samples);
  }

  // eval script ของ datalog series (เหมือน LR job-field) — helper: tag(device,tag) · pad(v,w,ch='0') · Math/String/Number
  //   เช่น  pad(tag('PLC02','D100'),4)  ·  tag('PLC1','A')+tag('PLC1','B')  ·  'LOT'+tag('PLC1','SEQ')
  _evalScript(expr) {
    try {
      const tag = (d, t) => { const v = this.tagEngine.getTagValue(d, t); return v ? v.value : null; };
      const pad = (v, w, ch) => String(v == null ? '' : v).padStart(Number(w) || 0, ch != null ? String(ch) : '0');
      // eslint-disable-next-line no-new-func
      const fn = new Function('tag', 'pad', 'Math', 'String', 'Number', `"use strict"; return (${expr});`);
      const r = fn(tag, pad, Math, String, Number);
      return r == null ? null : r;
    } catch (_) { return null; }
  }

  // เขียน samples ลง store ของ log (csv/db) — ใช้ทั้ง periodic sampler + on-change
  _write(log, samples) {
    if (!samples || samples.length === 0) return;
    try {
      if (log.storage === 'database' && log.dbConn) {
        Promise.resolve(this.chartStore.log(log.dbConn, log.id, samples)).catch(() => {});   // fire-and-forget (network · ไม่ใช่ file-scan)
      } else if (this._started) {
        // batch CSV: สะสมไว้ flush เป็นช่วง (ลด file-write → ลด EDR scan/CPU บน Windows)
        const buf = this._buf.get(log.id);
        if (buf) buf.push(...samples); else this._buf.set(log.id, [...samples]);
      } else {
        this.chartStore.logCsv(log.id, samples);   // ไม่ได้รัน (เทสต์/one-shot) → เขียนทันที
      }
    } catch (_) {}
  }

  // เรียกจาก engine.onTagUpdate ทุกครั้ง tag เปลี่ยน → log "เมื่อเปลี่ยนค่า" ให้ log ที่เปิด onChange
  //   dedup ค่าซ้ำ (deadband) + throttle (changeMinMs) · เขียนเฉพาะ series ที่เปลี่ยน (long format)
  onTagChange(device, tag, value, ts) {
    if (!this._started || this._changeIndex.size === 0) return;
    const ids = this._changeIndex.get(`${device}/${tag}`);
    if (!ids) return;
    const when = ts || Date.now();
    for (const id of ids) {
      const log = this.get(id);
      if (!log || !log.enabled || !log.onChange) continue;
      const s = log.series.find((x) => x.device === device && x.tag === tag);   // หา series → ใช้ transform/text ของมัน
      const key = `${id}|${device}/${tag}`;
      const last = this._lastChange.get(key);
      if (s && s.text) {                                          // string field → dedup ด้วยข้อความ + throttle
        const txt = String(value);
        if (last) {
          if (txt === last.text) continue;                        // ข้อความเดิม → ข้าม
          if (log.changeMinMs > 0 && (when - last.ts) < log.changeMinMs) continue;
        }
        this._lastChange.set(key, { text: txt, ts: when });
        this._write(log, [{ device, tag, valueText: txt, ts: when }]);
        continue;
      }
      const raw = Number(value);
      if (Number.isNaN(raw)) continue;                            // numeric series + ค่าไม่ใช่ตัวเลข → ข้าม (series อื่นยังทำต่อ)
      const num = s ? this._applyTransform(s, raw) : raw;          // deadband เทียบค่า "หลัง transform"
      if (last) {
        const changed = log.deadband > 0 ? Math.abs(num - last.value) >= log.deadband : num !== last.value;
        if (!changed) continue;                                   // ค่าไม่เปลี่ยน (เกิน deadband) → ข้าม
        if (log.changeMinMs > 0 && (when - last.ts) < log.changeMinMs) continue;   // throttle
      }
      this._lastChange.set(key, { value: num, ts: when });
      this._write(log, [{ device, tag, value: num, ts: when }]);
    }
  }

  async _pruneAll() {
    for (const log of this.logs) {
      try {
        if (log.storage === 'database' && log.dbConn) await this.chartStore.pruneDb(log.dbConn, log.id, log.retentionDays);
        else this.chartStore.pruneCsv(log.id, log.retentionDays);
      } catch (_) {}
    }
  }

  // ── อ่านประวัติของ log (อ้างด้วย id) → ใช้ series + storage ของ log เอง ──────────
  //   opts: { windowSec, limit, fromMs, toMs }  (fromMs/toMs = ช่วงเวลาแบบ absolute)
  async history(id, opts = {}) {
    const log = this.get(id);
    if (!log) return { ok: false, error: 'not found' };
    const series = log.series.map((s) => ({ device: s.device, tag: s.tag }));
    const windowSec = opts.windowSec;
    const limit = opts.limit;
    const range = (Number(opts.fromMs) > 0) ? { fromMs: Number(opts.fromMs), toMs: Number(opts.toMs) || 0 } : null;
    let rows = [];
    if (series.length) {
      rows = (log.storage === 'database' && log.dbConn)
        ? await this.chartStore.history(log.dbConn, log.id, series, windowSec, limit, range)
        : this.chartStore.historyCsv(log.id, series, windowSec, limit, range);
    }
    // annotation (comment พิมพ์เอง · device='__note__') — ดึงแยกแล้วส่งให้กราฟวาด marker
    let annotations = [];
    try {
      const notes = (log.storage === 'database' && log.dbConn)
        ? await this.chartStore.history(log.dbConn, log.id, [{ device: NOTE_DEVICE, tag: '' }], windowSec, limit, range)
        : this.chartStore.historyCsv(log.id, [{ device: NOTE_DEVICE, tag: '' }], windowSec, limit, range);
      annotations = (notes || []).filter((r) => r.valueText != null).map((r) => ({ ts: r.ts, text: r.valueText }));
    } catch (_) {}
    return { ok: true, log: { id: log.id, name: log.name, series: log.series, storage: log.storage }, rows, annotations };
  }

  // ── เพิ่มหมายเหตุ (annotation · comment พิมพ์เอง) ณ เวลาหนึ่ง → เก็บเป็น text row (device='__note__') ──
  async addAnnotation(id, comment, ts) {
    const log = this.get(id);
    if (!log) return { ok: false, error: 'not found' };
    if (!(log.storage === 'database' && log.dbConn)) return { ok: false, error: 'annotation รองรับเฉพาะ log ที่เก็บลง database (CSV ไม่มีคอลัมน์ข้อความ)' };
    const c = String(comment || '').trim();
    if (!c) return { ok: false, error: 'empty comment' };
    const when = Number(ts) > 0 ? Number(ts) : Date.now();
    try { await this.chartStore.log(log.dbConn, log.id, [{ device: NOTE_DEVICE, tag: '', valueText: c, ts: when }]); }
    catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, ts: when, comment: c };
  }
}

module.exports = DatalogManager;
