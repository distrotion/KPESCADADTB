const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const { dialectOf, ph, tsVal } = require('./dbDialect');

/**
 * AlarmEngine — ระบบ alarm ตามมาตรฐาน SCADA (ISA-18.2 / EEMUA 191)
 *
 * State machine 4 สถานะ (ISA-18.2):
 *   NORMAL   — เงื่อนไขไม่เป็นจริง + acknowledged แล้ว
 *   UNACK    — เงื่อนไขเป็นจริง (active) + ยังไม่ ack   → กระพริบ
 *   ACK      — เงื่อนไขเป็นจริง (active) + ack แล้ว      → ค้าง
 *   RTNUN    — เงื่อนไขหายแล้ว (return-to-normal) แต่ยังไม่ ack → ต้อง ack ถึงจะหลุด summary
 *
 * รองรับนิยาม 3 แบบ: limit (HiHi/Hi/Lo/LoLo) · digital (BOOL) · expression
 * + deadband (hysteresis) · on/off delay · latched · shelve · enable/disable
 * + priority 4 ระดับ (critical/high/medium/low)
 * เก็บ active alarms ในหน่วยความจำ + journal ring buffer + persist event ลง DB (optional)
 */
class AlarmEngine {
  // onAlarmEvent(evt) — เรียกทุกครั้งที่มี transition (raised/cleared/acked/normal/shelved…)
  constructor(tagEngine, onAlarmEvent, dbManager) {
    this.tagEngine = tagEngine;
    this.onAlarmEvent = onAlarmEvent || (() => {});
    this.dbManager = dbManager || null;

    this.defs = [];                 // นิยาม alarm (persist)
    // ackPolicy: 'normal' (ack ทีละตัว/Ack All ได้) | 'each' (ต้อง ack ทุกตัว — ปิด Ack All)
    // ackComment: เปิด popup ใส่ comment ตอน ack (อิสระจาก policy)
    // ackRequireComment: legacy (เดิมคุมทั้งสองอย่าง) — ยัง sync ไว้ backward-compat
    this.config = { dbConnection: '', dbTable: 'alarm_events', journalLimit: 1000,
                    ackPolicy: 'normal', ackComment: false, ackRequireComment: false };
    this.runtime = new Map();       // alarmId -> runtime state (ไม่ persist)
    this.journal = [];              // event log ring buffer (in-memory)
    this._dbReady = new Set();      // connection names ที่ ensure table แล้ว
    this._tick = null;

    this._load();
    this._loadJournalFromCsv();      // โหลด event เก่าจาก CSV กลับเข้า journal (กรณีไม่ใช้ DB)
  }

  // ── config persistence ─────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('alarms.json', path.join(__dirname, 'config', 'alarms.json'));
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.defs = Array.isArray(raw.alarms) ? raw.alarms : [];
      this.config = { ...this.config, ...(raw.config || {}) };
      // migrate: ackRequireComment เดิม (คุม require-comment + no-ack-all รวมกัน) → แยกเป็น ackPolicy + ackComment
      const rc = raw.config || {};
      if (rc.ackRequireComment === true && rc.ackPolicy == null) {
        this.config.ackPolicy = 'each';
        this.config.ackComment = true;
      }
      if (this.config.ackPolicy !== 'each') this.config.ackPolicy = 'normal';
    } catch (_) {
      this.defs = [];
    }
  }

  _save() {
    csv.writeJsonAtomic(this.path, { config: this.config, alarms: this.defs });   // atomic (B3)
  }

  // โหลด alarm defs ใหม่จากดิสก์ (live-reload หลัง import) + prune runtime ที่ไม่มี def แล้ว
  reload() {
    this._load();
    const ids = new Set(this.defs.map((d) => d.id));
    for (const id of [...this.runtime.keys()]) if (!ids.has(id)) this.runtime.delete(id);
    for (const def of this.defs) this._ensureRuntime(def);
    this._loadJournalFromCsv();
    this._touch();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  start() {
    for (const def of this.defs) this._ensureRuntime(def);
    // tick: ประเมินทุก alarm ทุก 1 วิ (จับ on/off delay + expression ที่อ้าง tag อื่น)
    this._tick = setInterval(() => this._evaluateAll(), 1000);
  }

  stop() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _ensureRuntime(def) {
    if (!this.runtime.has(def.id)) {
      this.runtime.set(def.id, {
        state: 'normal',
        active: false,        // active หลังผ่าน deadband + delay แล้ว
        rawActive: false,     // เงื่อนไขดิบ (ก่อน delay)
        candidateSince: null, // เวลาที่ rawActive เริ่มต่างจาก active (สำหรับ delay)
        value: null,
        raisedAt: null, clearedAt: null, ackAt: null, ackBy: null,
        shelvedUntil: null,
      });
    }
    return this.runtime.get(def.id);
  }

  // ── เรียกจาก server ทุกครั้งที่ tag update (ประเมินทันทีเพื่อ responsive) ─────────
  onTagUpdate(deviceId, tagId) {
    for (const def of this.defs) {
      if (def.enabled === false) continue;
      if (def.type === 'expression') continue; // expression รอ tick (อ้างหลาย tag)
      if (this._defMatchesTag(def, deviceId, tagId)) this._evaluate(def);
    }
  }

  _defMatchesTag(def, deviceId, tagId) {
    // รับ id หรือ name — เทียบผ่าน tagEngine resolve
    return (def.deviceId === deviceId || def.deviceId == null) &&
           (def.tagId === tagId || def.tagId == null) ||
           this._sameTag(def, deviceId, tagId);
  }

  _sameTag(def, deviceId, tagId) {
    if (!def.deviceId || !def.tagId || !this.tagEngine) return false;
    const dev = this.tagEngine._findDevice ? this.tagEngine._findDevice(def.deviceId) : null;
    const tag = dev && this.tagEngine._findTag ? this.tagEngine._findTag(dev, def.tagId) : null;
    return !!(dev && tag && dev.id === deviceId && tag.id === tagId);
  }

  _evaluateAll() {
    for (const def of this.defs) {
      if (def.enabled === false) { this._clearIfActive(def); continue; }
      this._evaluate(def);
    }
  }

  // ── อ่านค่า tag ที่ผูกไว้ ─────────────────────────────────────────────────────
  _tagValue(def) {
    if (!def.deviceId || !def.tagId || !this.tagEngine) return null;
    const v = this.tagEngine.getTagValue(def.deviceId, def.tagId);
    return v ? v.value : null;
  }

  // ── เงื่อนไขดิบ (พร้อม deadband สำหรับ limit) ─────────────────────────────────────
  _rawCondition(def, rt) {
    const dband = Number(def.deadband) || 0;
    if (def.type === 'digital') {
      const v = this._tagValue(def);
      rt.value = v;
      const trig = def.trigger != null ? Number(def.trigger) : 1;
      return Number(v) === trig;
    }
    if (def.type === 'expression') {
      return this._evalExpression(def, rt);
    }
    // type 'limit'
    const v = Number(this._tagValue(def));
    rt.value = isNaN(v) ? null : v;
    if (isNaN(v)) return false;
    const sp = Number(def.setpoint);
    if (isNaN(sp)) return false;
    const sub = def.subType || 'hi';
    const high = (sub === 'hi' || sub === 'hihi');
    if (high) {
      // active เมื่อ >= setpoint ; ปลด (hysteresis) เมื่อ < setpoint - deadband
      return rt.rawActive ? (v > sp - dband) : (v >= sp);
    } else {
      // lo / lolo : active เมื่อ <= setpoint ; ปลดเมื่อ > setpoint + deadband
      return rt.rawActive ? (v < sp + dband) : (v <= sp);
    }
  }

  _evalExpression(def, rt) {
    try {
      const te = this.tagEngine;
      const boundVal = (def.deviceId && def.tagId) ? this._tagValue(def) : null;
      rt.value = boundVal;
      const ctx = {
        value: boundVal,
        tag: (d, t) => { const v = te.getTagValue(d, t); return v ? v.value : null; },
        Math, Number, parseFloat, parseInt, isNaN, Boolean, String,
      };
      // eslint-disable-next-line no-new-func
      const fn = new Function('ctx', `with(ctx){ return (${def.expression || 'false'}); }`);
      return !!fn(ctx);
    } catch (_) {
      return false;
    }
  }

  // ── ประเมิน + เดิน state machine ──────────────────────────────────────────────
  _evaluate(def) {
    const rt = this._ensureRuntime(def);
    const now = Date.now();

    // shelve หมดอายุ → ปลด
    if (rt.shelvedUntil && now >= rt.shelvedUntil) {
      rt.shelvedUntil = null;
      this._emit('unshelved', def, rt);
    }

    const raw = this._rawCondition(def, rt);
    rt.rawActive = raw;

    // on/off delay (วินาที)
    const onDelay  = (Number(def.onDelaySec)  || 0) * 1000;
    const offDelay = (Number(def.offDelaySec) || 0) * 1000;
    let effective = rt.active;
    if (raw !== rt.active) {
      if (rt.candidateSince == null) rt.candidateSince = now;
      const held = now - rt.candidateSince;
      const need = raw ? onDelay : offDelay;
      if (held >= need) { effective = raw; rt.candidateSince = null; }
    } else {
      rt.candidateSince = null;
    }
    rt.active = effective;

    this._applyState(def, rt, effective);
  }

  _applyState(def, rt, active) {
    const now = Date.now();
    const prev = rt.state;

    if (active) {
      if (rt.state === 'normal' || rt.state === 'rtnun') {
        rt.state = 'unack';
        // เกิดรอบใหม่ → ล้างข้อมูล ack เก่าทั้งหมด (กัน comment/by ครั้งก่อน leak มาแสดง/บันทึก)
        rt.raisedAt = now; rt.clearedAt = null; rt.ackAt = null; rt.ackBy = null; rt.ackComment = null;
        this._emit('raised', def, rt);
      }
      // unack/ack ที่ active อยู่แล้ว — คงเดิม
    } else {
      if (rt.state === 'unack') {
        rt.state = 'rtnun';            // หายก่อน ack → ต้อง ack ถึงจะหลุด
        rt.clearedAt = now;
        this._emit('cleared', def, rt);
      } else if (rt.state === 'ack') {
        rt.state = 'normal';           // ack แล้วและหาย → กลับปกติ
        rt.clearedAt = now;
        this._emit('normal', def, rt);
      }
    }
    if (rt.state !== prev) this._touch();
  }

  _clearIfActive(def) {
    const rt = this.runtime.get(def.id);
    if (rt && (rt.state === 'unack' || rt.state === 'ack')) {
      rt.active = false; rt.rawActive = false;
      rt.state = 'normal'; rt.clearedAt = Date.now();
      this._emit('normal', def, rt);
    }
  }

  // ── acknowledge ──────────────────────────────────────────────────────────────
  acknowledge(id, by = 'operator', comment = '') {
    const def = this.defs.find(d => d.id === id);
    const rt = def && this.runtime.get(id);
    if (!def || !rt) return false;
    if (rt.state === 'unack') {
      rt.state = 'ack'; rt.ackAt = Date.now(); rt.ackBy = by; rt.ackComment = comment || '';
      this._emit('acked', def, rt);
      return true;
    }
    if (rt.state === 'rtnun') {
      rt.state = 'normal'; rt.ackAt = Date.now(); rt.ackBy = by; rt.ackComment = comment || '';
      this._emit('acked', def, rt);
      return true;
    }
    return false;
  }

  acknowledgeAll(by = 'operator') {
    if (this.config.ackPolicy === 'each') return 0;   // ต้อง ack ทุกตัว → ปิด Ack All
    let n = 0;
    for (const def of this.defs) {
      const rt = this.runtime.get(def.id);
      if (rt && (rt.state === 'unack' || rt.state === 'rtnun')) {
        if (this.acknowledge(def.id, by)) n++;
      }
    }
    return n;
  }

  shelve(id, minutes = 60) {
    const def = this.defs.find(d => d.id === id);
    const rt = def && this.runtime.get(id);
    if (!def || !rt) return false;
    rt.shelvedUntil = Date.now() + Math.max(1, minutes) * 60000;
    this._emit('shelved', def, rt);
    return true;
  }

  unshelve(id) {
    const def = this.defs.find(d => d.id === id);
    const rt = def && this.runtime.get(id);
    if (!def || !rt) return false;
    rt.shelvedUntil = null;
    this._emit('unshelved', def, rt);
    return true;
  }

  // ── snapshot สำหรับ UI ────────────────────────────────────────────────────────
  _snap(def, rt) {
    return {
      id: def.id, name: def.name, type: def.type, subType: def.subType || null,
      deviceId: def.deviceId || null, tagId: def.tagId || null,
      priority: def.priority || 'medium', group: def.group || '',
      message: def.message || def.name,
      sound: def.sound || '',         // เสียงต่อ alarm ('' = ตามระดับ default · 'none' = เงียบ · preset key)
      soundData: def.soundData || '', // เสียงอัปโหลดเอง (data-URI) ถ้า sound='custom'
      setpoint: def.setpoint != null ? def.setpoint : null,
      state: rt.state, value: rt.value,
      raisedAt: rt.raisedAt, clearedAt: rt.clearedAt,
      ackAt: rt.ackAt, ackBy: rt.ackBy, ackComment: rt.ackComment || null,
      shelved: !!rt.shelvedUntil, shelvedUntil: rt.shelvedUntil || null,
      enabled: def.enabled !== false,
    };
  }

  // alarm ที่ยัง "active" ในมุม operator (ไม่ใช่ normal) → แสดงใน summary
  activeSnapshot() {
    const out = [];
    for (const def of this.defs) {
      const rt = this.runtime.get(def.id);
      if (rt && rt.state !== 'normal') {
        const { soundData, ...s } = this._snap(def, rt);   // active list ไม่ต้องแบก base64
        out.push(s);
      }
    }
    // เรียงตาม priority แล้วเวลาล่าสุด
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    out.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) ||
                       (b.raisedAt || 0) - (a.raisedAt || 0));
    return out;
  }

  unackCount() {
    let n = 0;
    for (const rt of this.runtime.values()) {
      if (rt.state === 'unack' || rt.state === 'rtnun') n++;
    }
    return n;
  }

  summary() {
    return {
      active: this.activeSnapshot(),
      unack: this.unackCount(),
      config: this.config,
    };
  }

  getJournal(limit = 200) {
    return this.journal.slice(-limit).reverse();
  }

  // ── emit + journal + db ──────────────────────────────────────────────────────
  _emit(event, def, rt) {
    const snap = this._snap(def, rt);
    // soundData (base64 เสียงอัปโหลด อาจถึง 512KB) ไม่เก็บลง journal/CSV — ส่งสดผ่าน WS เท่านั้น
    const { soundData, ...snapForLog } = snap;
    const entry = { t: Date.now(), event, ...snapForLog };
    // comment/ackBy/ackAt บันทึกลง log เฉพาะ event 'acked' เท่านั้น
    //   (กัน comment ล่าสุดที่ค้างใน runtime ไปโผล่ในแถว raised/cleared/normal/shelved)
    if (event !== 'acked') { entry.ackComment = null; entry.ackBy = null; entry.ackAt = null; }
    this.journal.push(entry);
    const lim = Number(this.config.journalLimit) || 1000;
    if (this.journal.length > lim) this.journal.splice(0, this.journal.length - lim);

    // persist: ตั้ง dbConnection → ลง DB · ไม่ตั้ง → เก็บเป็น CSV รายวันที่ root
    if (this.config.dbConnection && this.dbManager) {
      this._logToDb(entry).catch(() => {});
    } else {
      this._logToCsv(entry);
    }

    try { this.onAlarmEvent({ type: 'alarm_event', event, alarm: snap, unack: this.unackCount(), t: entry.t }); }
    catch (_) {}
  }

  // เปลี่ยน state โดยไม่มี event (เช่น re-sort) → แจ้ง UI ให้ refresh summary
  _touch() {
    try { this.onAlarmEvent({ type: 'alarm_state', unack: this.unackCount() }); } catch (_) {}
  }

  // ── DB logging (best-effort, ไม่โยน error เข้า flow หลัก) ─────────────────────────
  async _logToDb(entry) {
    const conn = this.config.dbConnection;
    if (!conn || !this.dbManager) return;
    const table = (this.config.dbTable || 'alarm_events').replace(/[^a-zA-Z0-9_]/g, '');
    let type = 'pg';
    try { type = (this.dbManager.resolve(conn).type) || 'pg'; } catch (_) { return; }
    const isMs = type === 'mssql';
    const dialect = dialectOf(type);

    await this._ensureTable(conn, table, isMs);

    // คอลัมน์ DB = ชุดเดียวกับ CSV/EXPORT (16 ฟิลด์) · ชื่อ SQL-safe: group→group_name, value→val
    const cols = '(ts, event, alarm_id, name, type, sub_type, device_id, tag_id, priority, group_name, state, val, setpoint, message, ack_by, comment)';
    const phStr = ph(dialect, 16);
    const params = [
      tsVal(dialect, entry.t), entry.event || '', entry.id, entry.name || '',
      entry.type || '', entry.subType || '', entry.deviceId || '', entry.tagId || '',
      entry.priority || '', entry.group || '', entry.state || '',
      entry.value != null ? Number(entry.value) : null,
      entry.setpoint != null ? Number(entry.setpoint) : null,
      entry.message || '', entry.ackBy || '', entry.ackComment || '',
    ];
    try { await this.dbManager.query(conn, `INSERT INTO ${table} ${cols} VALUES ${phStr}`, params); }
    catch (_) {}
  }

  async _ensureTable(conn, table, isMs) {
    const key = `${conn}:${table}`;
    if (this._dbReady.has(key)) return;
    const sql = isMs
      ? `IF OBJECT_ID('${table}','U') IS NULL CREATE TABLE ${table} (
           id INT IDENTITY PRIMARY KEY, ts DATETIME, event VARCHAR(16), alarm_id VARCHAR(64), name NVARCHAR(200),
           type VARCHAR(16), sub_type VARCHAR(16), device_id VARCHAR(64), tag_id VARCHAR(64), priority VARCHAR(16),
           group_name NVARCHAR(64), state VARCHAR(16), val FLOAT, setpoint FLOAT, message NVARCHAR(400),
           ack_by VARCHAR(64), comment NVARCHAR(400))`
      : `CREATE TABLE IF NOT EXISTS ${table} (
           id SERIAL PRIMARY KEY, ts TIMESTAMP, event VARCHAR(16), alarm_id VARCHAR(64), name VARCHAR(200),
           type VARCHAR(16), sub_type VARCHAR(16), device_id VARCHAR(64), tag_id VARCHAR(64), priority VARCHAR(16),
           group_name VARCHAR(64), state VARCHAR(16), val DOUBLE PRECISION, setpoint DOUBLE PRECISION, message VARCHAR(400),
           ack_by VARCHAR(64), comment VARCHAR(400))`;
    try { await this.dbManager.query(conn, sql, []); this._dbReady.add(key); }
    catch (_) { /* ปล่อยให้ INSERT ลองเอง */ }
    // best-effort: เพิ่มคอลัมน์ที่อาจขาดให้ table เก่า (สร้างก่อนเวอร์ชันนี้) — มีอยู่แล้วจะ error → ปล่อยผ่าน
    const addCols = isMs
      ? [['event', 'VARCHAR(16)'], ['type', 'VARCHAR(16)'], ['sub_type', 'VARCHAR(16)'],
         ['group_name', 'NVARCHAR(64)'], ['setpoint', 'FLOAT'], ['comment', 'NVARCHAR(400)']]
      : [['event', 'VARCHAR(16)'], ['type', 'VARCHAR(16)'], ['sub_type', 'VARCHAR(16)'],
         ['group_name', 'VARCHAR(64)'], ['setpoint', 'DOUBLE PRECISION'], ['comment', 'VARCHAR(400)']];
    for (const [c, t] of addCols) {
      const alter = isMs
        ? `ALTER TABLE ${table} ADD ${c} ${t}`
        : `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c} ${t}`;
      try { await this.dbManager.query(conn, alter, []); } catch (_) { /* คอลัมน์มีอยู่แล้ว */ }
    }
  }

  // ── CSV logging (ใช้เมื่อไม่ใช้ DB) — ไฟล์รายวันใต้ base path ที่เลือก (ผ่าน csvUtil) ──────
  // getter → path เปลี่ยนตาม Setup ได้ทันที (ไม่ cache) · ⚠️ installer-first: base อยู่ใน csvUtil
  get csvDir() { return csv.csvDir('alarm-logs'); }

  // คอลัมน์ CSV = ชุดเดียวกับ DB และ EXPORT_COLUMNS (16 ฟิลด์ตรงกันหมด)
  static get CSV_COLUMNS() {
    return AlarmEngine.EXPORT_COLUMNS;
  }

  _logToCsv(entry) {
    csv.appendDailyRow(this.csvDir, 'alarm', new Date(entry.t), AlarmEngine.CSV_COLUMNS, [
      new Date(entry.t).toISOString(), entry.event, entry.id, entry.name, entry.type, entry.subType,
      entry.deviceId, entry.tagId, entry.priority, entry.group, entry.state,
      entry.value, entry.setpoint, entry.message, entry.ackBy, entry.ackComment || '',
    ]);
  }

  _csvRowToEntry(cols, row) {
    const idx = (k) => cols.indexOf(k);
    const get = (k) => { const i = idx(k); return i >= 0 ? row[i] : ''; };
    const num = (k) => { const s = get(k); return s === '' || s == null ? null : (isNaN(Number(s)) ? null : Number(s)); };
    const t = get('timestamp') ? Date.parse(get('timestamp')) : NaN;
    if (isNaN(t)) return null;
    return {
      t, event: get('event'), id: get('alarm_id'), name: get('name'),
      type: get('type') || null, subType: get('sub_type') || null,
      deviceId: get('device_id') || null, tagId: get('tag_id') || null,
      priority: get('priority') || 'medium', group: get('group') || '',
      state: get('state') || null, value: num('value'), setpoint: num('setpoint'),
      message: get('message') || '', ackBy: get('ack_by') || null,
      ackComment: get('comment') || null,
    };
  }

  // โหลด event เก่าจาก CSV (ไฟล์รายวันใหม่สุด → ย้อนหลัง) กลับเข้า journal สูงสุด journalLimit
  _loadJournalFromCsv() {
    if (this.config.dbConnection) return;   // โหมด DB ไม่ใช้ CSV
    const files = csv.listDailyFiles(this.csvDir, 'alarm');
    const lim = Number(this.config.journalLimit) || 1000;
    const collected = [];
    for (let fi = files.length - 1; fi >= 0 && collected.length < lim; fi--) {
      // tail เท่านั้น — ไฟล์วันอาจบวมผิดปกติ อ่านทั้งไฟล์ = boot ตาย OOM (ดู csvUtil.readCsvTail)
      const { cols, rows } = csv.readCsvTail(path.join(this.csvDir, files[fi]));
      const entries = [];
      for (const row of rows) { const e = this._csvRowToEntry(cols, row); if (e) entries.push(e); }
      const take = entries.slice(Math.max(0, entries.length - (lim - collected.length)));
      collected.unshift(...take);
    }
    this.journal = collected.slice(-lim);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────
  getAll() {
    return { config: this.config, alarms: this.defs.map(d => ({ ...d })) };
  }

  addAlarm(def) {
    if (!def || !def.name) throw new Error('name is required');
    const id = def.id || `alm_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const rec = { enabled: true, priority: 'medium', type: 'digital', ...def, id };
    this.defs.push(rec);
    this._ensureRuntime(rec);
    this._save();
    return rec;
  }

  updateAlarm(id, updates) {
    const i = this.defs.findIndex(d => d.id === id);
    if (i === -1) throw new Error(`Alarm not found: ${id}`);
    this.defs[i] = { ...this.defs[i], ...updates, id };
    // นิยามเปลี่ยน → reset runtime เพื่อประเมินใหม่สะอาด ๆ
    this.runtime.delete(id);
    this._ensureRuntime(this.defs[i]);
    this._save();
    this._touch();
    return this.defs[i];
  }

  removeAlarm(id) {
    const i = this.defs.findIndex(d => d.id === id);
    if (i === -1) throw new Error(`Alarm not found: ${id}`);
    this.defs.splice(i, 1);
    this.runtime.delete(id);
    this._save();
    this._touch();
    return true;
  }

  setConfig(updates) {
    this.config = { ...this.config, ...updates };
    if (this.config.ackPolicy !== 'each') this.config.ackPolicy = 'normal';
    this.config.ackComment = this.config.ackComment === true;
    this.config.ackRequireComment = this.config.ackComment;   // sync legacy ไว้ backward-compat
    this._dbReady.clear();
    this._save();
    return this.config;
  }

  // ── Export alarm history (full fields) ในช่วง [fromMs, toMs] ──────────────────────
  // คอลัมน์เต็ม: timestamp,event,alarm_id,name,type,sub_type,device_id,tag_id,
  //              priority,group,state,value,setpoint,message,ack_by,comment
  // source: DB (ถ้าตั้ง dbConnection) หรือ CSV รายวัน · enrich type/subType/group/setpoint จาก def ปัจจุบัน
  static get EXPORT_COLUMNS() {
    return ['timestamp', 'event', 'alarm_id', 'name', 'type', 'sub_type', 'device_id', 'tag_id',
            'priority', 'group', 'state', 'value', 'setpoint', 'message', 'ack_by', 'comment'];
  }

  async exportEntries(fromMs, toMs) {
    const from = Number.isFinite(fromMs) ? fromMs : 0;
    const to = Number.isFinite(toMs) ? toMs : Date.now();
    const raw = (this.config.dbConnection && this.dbManager)
      ? await this._exportFromDb(from, to)
      : this._exportFromCsv(from, to);
    const byId = new Map(this.defs.map(d => [d.id, d]));
    const v = (x) => (x == null ? '' : x);
    return raw.map((e) => {
      const d = byId.get(e.id) || {};
      return {
        timestamp: new Date(e.t).toISOString(),
        event: v(e.event), alarm_id: v(e.id), name: v(e.name || d.name),
        type: v(e.type || d.type), sub_type: v(e.subType || d.subType),
        device_id: v(e.deviceId || d.deviceId), tag_id: v(e.tagId || d.tagId),
        priority: v(e.priority || d.priority), group: v(e.group || d.group),
        state: v(e.state), value: v(e.value),
        setpoint: e.setpoint != null ? e.setpoint : v(d.setpoint),
        message: v(e.message), ack_by: v(e.ackBy), comment: v(e.ackComment),
      };
    });
  }

  _exportFromCsv(from, to) {
    const files = csv.listDailyFiles(this.csvDir, 'alarm');
    const out = [];
    for (const f of files) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (m) {
        const dayStart = Date.parse(`${m[1]}T00:00:00`);
        if (Number.isFinite(dayStart) && (dayStart + 86400000 < from || dayStart > to)) continue; // ทั้งวันนอกช่วง
      }
      const { cols, rows } = csv.readCsv(path.join(this.csvDir, f));
      for (const row of rows) {
        const e = this._csvRowToEntry(cols, row);
        if (e && e.t >= from && e.t <= to) out.push(e);
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  async _exportFromDb(from, to) {
    const conn = this.config.dbConnection;
    const table = (this.config.dbTable || 'alarm_events').replace(/[^a-zA-Z0-9_]/g, '');
    let type = 'pg';
    try { type = (this.dbManager.resolve(conn).type) || 'pg'; } catch (_) { return []; }
    const dialect = dialectOf(type);
    const b = dialect === 'mysql' ? ['?', '?'] : dialect === 'mssql' ? ['@p0', '@p1'] : ['$1', '$2'];
    const sql = `SELECT * FROM ${table} WHERE ts BETWEEN ${b[0]} AND ${b[1]} ORDER BY ts`;
    let rows = [];
    try { rows = await this.dbManager.query(conn, sql, [tsVal(dialect, from), tsVal(dialect, to)]); }
    catch (_) { return []; }
    return (rows || []).map((r) => ({
      t: r.ts ? Date.parse(r.ts) : Date.now(),
      event: r.event, id: r.alarm_id, name: r.name,
      type: r.type || '', subType: r.sub_type || '',
      deviceId: r.device_id, tagId: r.tag_id, priority: r.priority,
      group: r.group_name || '', state: r.state, value: r.val,
      setpoint: r.setpoint != null ? r.setpoint : null,
      message: r.message, ackBy: r.ack_by,
      ackComment: r.comment || '',   // คอลัมน์ใหม่เก็บตั้งแต่เวอร์ชันนี้ (table เก่าที่ยังไม่ ALTER จะว่าง)
    }));
  }
}

module.exports = AlarmEngine;
