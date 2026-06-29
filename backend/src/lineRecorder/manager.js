// manager.js — LineRecorderManager: orchestrator ของ Line Recorder (pattern เดียวกับ stockManager)
//   หน้าที่: โหลด config ทุกไลน์ · ถือ LineStore · รับ event (จาก PLC/ingest) → decode → engine.project
//   MVP: ยังไม่ผูก tag engine (PLC) — รับผ่าน ingest() / API เพื่อทดสอบก่อน
const path = require('path');
const fs = require('fs');
const { loadLineConfigs, saveLineConfig, deleteLineConfig } = require('./lineConfig');
const { decode } = require('./decoder');
const { LineEngine } = require('./engine');
const { createLineStore } = require('./lineStore');
const { PlcSource } = require('./plcSource');
const { CarrierTracker } = require('./source/carrierTracker');
const { SnapshotSource } = require('./source/snapshotSource');

class LineRecorderManager {
  constructor({ seedDir, runtimeDir, store, tagEngine, plcIntervalMs, dbManager, licenseMaxLines } = {}) {
    this._licenseMaxLines = typeof licenseMaxLines === 'function' ? licenseMaxLines : null;   // () => จำนวนไลน์สูงสุดจาก license (DLClr) · null = ไม่จำกัด
    this.seedDir = seedDir || path.join(__dirname, '..', 'config', 'lines');                       // ตัวอย่าง (committed) · backend/src/config/lines
    this.runtimeDir = runtimeDir || path.join(__dirname, '..', '..', '..', 'config', 'lines');     // user สร้าง/ตั้งชื่อเอง (per-machine · /config/lines · gitignored)
    this.configs = {};
    this.dbManager = dbManager || null;          // resolve DB connection ตามชื่อ (Setup → Databases)
    this._stores = {};                           // pool: 'db:<name>' | '__file__' → LineStore (per-line เลือก DB ได้)
    if (store) this._stores.__file__ = store;    // inject (test)
    this.engine = new LineEngine({ getStore: (line) => this._storeFor(this.configs[line]), getConfig: (line) => this.configs[line] });
    this.plc = new PlcSource({ engine: tagEngine, manager: this, intervalMs: plcIntervalMs });   // seq-based (mode=tag) อ่าน PLC ผ่าน tag engine
    this.tracker = new CarrierTracker();                                                         // จำตำแหน่ง + diff (snapshot)
    this.snap = new SnapshotSource({ engine: tagEngine, manager: this, tracker: this.tracker, intervalMs: plcIntervalMs });   // mode=snapshot (select tag)
    this._started = false;
    this._onViolation = null;   // hook → alarm (set จาก server)
    this.owned = {};            // line → true(recorder) | false(viewer) — gate poll/flush/sweep
    this._lockTtlMs = 15000;    // heartbeat เก่าเกินนี้ = owner ถือว่าตาย (เตือน · ไม่แย่งเอง)
    this._identity = this._loadIdentity();   // { id (stable/machine), label, role: 'recorder'|'viewer' }
  }

  // identity ต่อเครื่อง (stable · ไม่ sync) — owner กลับมา renew ได้ · role กำหนดว่าแข่ง lock ไหม
  _loadIdentity() {
    const os = require('os');
    const file = path.join(this.runtimeDir, '..', 'line-recorder-instance.json');   // <base>/config/line-recorder-instance.json (gitignored)
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    if (!d.id) d.id = `${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!d.label) d.label = os.hostname();
    if (d.role !== 'viewer') d.role = 'recorder';   // default = recorder (แข่ง lock)
    this._identityFile = file;
    // env override (per-process · รันหลาย instance/เทส) — ถ้ามี id จาก env ไม่เขียนทับไฟล์ของเครื่องหลัก
    const envId = process.env.KPE_LR_INSTANCE_ID;
    if (envId) {
      d.id = envId;
      if (process.env.KPE_LR_INSTANCE_LABEL) d.label = process.env.KPE_LR_INSTANCE_LABEL;
      if (process.env.KPE_LR_ROLE) d.role = process.env.KPE_LR_ROLE === 'viewer' ? 'viewer' : 'recorder';
      this._identityFile = null;   // env-driven → ไม่ persist
    } else {
      try { fs.writeFileSync(file, JSON.stringify(d, null, 2)); } catch (_) {}
    }
    return d;
  }
  getIdentity() { return { ...this._identity }; }
  setRole(role) {
    this._identity.role = role === 'viewer' ? 'viewer' : 'recorder';
    try { fs.writeFileSync(this._identityFile, JSON.stringify(this._identity, null, 2)); } catch (_) {}
    this._lockTick().catch(() => {});   // ประเมินใหม่ทันที
    return this._identity.role;
  }

  // file store (test เท่านั้น) — shared
  _fileStore() { return this._stores.__file__ || (this._stores.__file__ = createLineStore({ type: 'file' })); }
  get store() { return this._fileStore(); }   // backward-compat (test เรียก m.store)

  // เลือก store ตามไลน์ — source.storeDb = ชื่อ DB ใน Setup · ว่าง/'file' = test (file)
  _storeFor(cfg) {
    const sd = cfg && cfg.source && cfg.source.storeDb;
    if (!sd || sd === 'file' || sd === '__test__') return this._fileStore();
    const key = 'db:' + sd;
    if (this._stores[key]) return this._stores[key];
    let conn = null;
    try { conn = this.dbManager && this.dbManager.resolve ? this.dbManager.resolve(sd) : null; } catch (_) {}
    if (!conn) { console.warn(`[lineRecorder] DB "${sd}" ไม่พบใน Databases → ใช้ file (test)`); return this._fileStore(); }
    let type, storeConn;
    if (conn.type === 'sqlite') {
      const sqlite = require('../sqliteDriver');
      if (!sqlite.available()) { console.warn(`[lineRecorder] DB "${sd}" = sqlite แต่ driver ไม่พร้อม (Node<22.5 + ไม่มี better-sqlite3) → ใช้ file`); return this._fileStore(); }
      const csv = require('../csvUtil');
      const p = conn.path || conn.file || conn.database || (`${sd}.sqlite`);
      const abs = path.isAbsolute(p) ? p : path.join(csv.getBase(), p);   // relative → ใต้ base dir (move-safe)
      type = 'sqlite'; storeConn = { path: abs };
    } else {
      type = conn.type === 'mssql' ? 'mssql' : conn.type === 'mysql' ? 'mysql' : 'pg';
      storeConn = { host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database };
    }
    const st = createLineStore({ type, conn: storeConn });
    this._stores[key] = st;
    return st;
  }
  // สร้างตาราง (ตาม spec) + flat view บน DB ของไลน์ — ปุ่ม "สร้างตาราง"
  async ensureSchema(line) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const st = this._storeFor(cfg);
    await st.ensureSchema(line);   // per-line tables
    if (st.ensureFlatView) { try { await st.ensureFlatView(line, cfg); } catch (e) { console.error(`[lineRecorder] flat view ${line}:`, e.message); } }
    return true;
  }
  // reset — archive ตารางเดิม (ใส่วันเวลา) + สร้างใหม่ว่าง + เคลียร์ RAM tracker · lock คงเดิม
  async resetLine(line, stamp) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const st = this._storeFor(cfg);
    if (!st.resetLine) throw new Error('store นี้ไม่รองรับ reset (file/test)');
    const ts = await st.resetLine(line, stamp);
    this.tracker.reset(line);                                    // เคลียร์ RAM (เริ่มจำลองใหม่)
    if (st.ensureFlatView) { try { await st.ensureFlatView(line, cfg); } catch (_) {} }
    return ts;
  }

  async start() {
    if (this._started) return;
    this.reload();
    for (const line of Object.keys(this.configs)) {                        // สร้างตาราง + view + กู้ register ต่อไลน์ (ตาม DB ที่เลือก)
      try { await this.ensureSchema(line); } catch (e) { console.error(`[lineRecorder] ensureSchema ${line}:`, e.message); }
    }
    await this._loadTracker();                                             // กู้ register (restart-safe) จาก DB
    this._started = true;
    await this._lockTick();                                                // ประเมิน owner/viewer ก่อนเริ่ม poll (กันเขียนทับ)
    try { this.plc.start(); } catch (e) { console.error('[lineRecorder/plc] start:', e.message); }
    try { this.snap.start(); } catch (e) { console.error('[lineRecorder/snapshot] start:', e.message); }
    this._flushTimer = setInterval(() => this._saveTracker().catch(() => {}), 5000);   // flush register (เฉพาะไลน์ที่ owned)
    this._lockTimer = setInterval(() => this._lockTick().catch(() => {}), 5000);       // renew/claim lock + ประเมิน role ทุก 5 วิ
    console.log(`[lineRecorder] start · instance ${this._identity.label}(${this._identity.role}) · ${Object.keys(this.configs).length} line(s):`, Object.keys(this.configs).join(', ') || '(none)');
  }
  async stop() {
    try { this.plc.stop(); } catch (_) {}
    try { this.snap.stop(); } catch (_) {}
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
    if (this._lockTimer) { clearInterval(this._lockTimer); this._lockTimer = null; }
    await this._saveTracker().catch(() => {});
    for (const line of Object.keys(this.configs)) {   // ปล่อย lock ที่ถือ (graceful → failover เร็ว)
      if (this.owned[line]) { try { await this._storeFor(this.configs[line]).releaseLock(line, this._identity.id); } catch (_) {} }
    }
    for (const k of Object.keys(this._stores)) { try { await this._stores[k].stop(); } catch (_) {} }
    this._started = false;
  }

  // ── Recorder lease: claim/renew lock ต่อไลน์ → set this.owned[line] · gain → reload register จาก DB ──
  async _lockTick() {
    for (const line of Object.keys(this.configs)) {
      const store = this._storeFor(this.configs[line]);
      let own;
      try {
        if (this._identity.role === 'viewer') {                  // viewer ไม่แข่ง lock + ปล่อยที่ถืออยู่ (ส่งมอบทันที)
          if (this.owned[line]) { try { await store.releaseLock(line, this._identity.id); } catch (_) {} }
          own = false;
        } else { own = await store.claimLock(line, this._identity.id, this._identity.label); }
      } catch (_) { own = false; }   // เข้า DB ไม่ได้ → ถือว่าไม่ owned (หยุดเขียน · split-brain safe)
      if (own && this.owned[line] === false) {   // เพิ่งได้เป็น owner → resume จาก state ล่าสุดใน DB
        try { const s = await store.loadRegister(line); if (s) this.tracker.state[line] = s; } catch (_) {}
      }
      this.owned[line] = own;
    }
  }
  // state สำหรับ monitor/entrance — owner(recorder): RAM สด · viewer: lr_register จาก DB (ของ recorder)
  async stateFor(line) {
    if (this.owned[line] === false) {
      try { return (await this._storeFor(this.configs[line]).loadRegister(line)) || { occ: {}, jobs: {}, runs: {}, oven: {} }; }
      catch (_) { return { occ: {}, jobs: {}, runs: {}, oven: {} }; }
    }
    return this.tracker.snapshotState(line);
  }

  // สถานะ lock ต่อไลน์ (ให้ UI โชว์ badge + เตือน)
  async lockStatus(line) {
    const store = this._storeFor(this.configs[line]);
    let lk = null; try { lk = await store.getLock(line); } catch (_) {}
    const me = this._identity;
    const amOwner = this.owned[line] === true;
    const now = lk ? Number(lk.now_ms) : Date.now();
    const stale = lk && lk.owner && lk.heartbeat_ms != null ? (now - Number(lk.heartbeat_ms) > this._lockTtlMs) : true;
    const hasOwner = !!(lk && lk.owner) && !stale;
    return {
      line, role: me.role, instance: me.label, amOwner,
      owner: lk ? lk.owner : null, ownerLabel: lk ? lk.label : null,
      heartbeatAgoMs: (lk && lk.heartbeat_ms != null) ? now - Number(lk.heartbeat_ms) : null,
      hasActiveRecorder: hasOwner, noRecorder: !hasOwner,
    };
  }
  // manual promote (ยึดเป็นตัวบันทึก) / release (ปล่อย)
  async promote(line) {
    if (!this.configs[line]) throw new Error('ไม่พบไลน์');
    if (this._identity.role === 'viewer') {   // ยึด = ตั้งใจเป็นตัวบันทึก → เปลี่ยน role เป็น recorder (ไม่งั้น lockTick ปล่อยทันที)
      this._identity.role = 'recorder';
      if (this._identityFile) { try { fs.writeFileSync(this._identityFile, JSON.stringify(this._identity, null, 2)); } catch (_) {} }
    }
    await this._storeFor(this.configs[line]).forceLock(line, this._identity.id, this._identity.label);
    await this._lockTick();
    return this.owned[line] === true;
  }
  async release(line) {
    if (!this.configs[line]) throw new Error('ไม่พบไลน์');
    await this._storeFor(this.configs[line]).releaseLock(line, this._identity.id);
    this.owned[line] = false;
    return true;
  }

  // register (jobKey/occupancy) → DB ต่อไลน์ (store ของไลน์นั้น) · DB-only · file=test
  async _loadTracker() {
    for (const line of Object.keys(this.configs)) {
      try { const s = await this._storeFor(this.configs[line]).loadRegister(line); if (s) { this.tracker.state[line] = s; this.tracker.migrateRegistersToPending(line); } }
      catch (e) { console.error(`[lineRecorder] loadRegister ${line}:`, e.message); }
    }
  }
  async _saveTracker() {
    for (const line of Object.keys(this.configs)) {
      if (this.owned[line] === false) continue;   // viewer → ไม่เขียนทับ register ของ recorder
      try { await this._storeFor(this.configs[line]).saveRegister(line, this.tracker.state[line] || {}); }
      catch (e) { console.error(`[lineRecorder] saveRegister ${line}:`, e.message); }
    }
  }
  // โหลด seed (ตัวอย่าง) + runtime (user สร้างเอง) · runtime ทับ seed (line id ซ้ำ = ใช้ของ user)
  reload() {
    this.configs = { ...loadLineConfigs(this.seedDir), ...loadLineConfigs(this.runtimeDir) };
    if (this._started) { try { this.plc.start(); } catch (_) {} try { this.snap.start(); } catch (_) {} }
    return Object.keys(this.configs);
  }

  // รับ canonical event ที่ decode แล้ว (จาก snapshot/CarrierTracker) → project ตรง ๆ
  async projectEvent(ev) {
    const res = await this.engine.project(ev);
    if (res.violations && res.violations.length && typeof this._onViolation === 'function') {
      try { this._onViolation(ev.line, ev, res.violations); } catch (_) {}
    }
    return res;
  }

  // ยกเลิกมือจาก monitor — carrier ที่ค้างในเตา (เข้าเตาแต่ไม่มีเลขออก) → EXIT(cancel) บันทึกเป็น "manual cancel" + ลบจากเตา
  async cancelOven(line, station, carrier) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error('ไม่พบไลน์');
    if (this.owned[line] === false) throw new Error('เครื่องนี้เป็น viewer — ยกเลิกได้เฉพาะเครื่อง recorder');
    const st = this.tracker.state[line] || {};
    const stn = String(station);
    const cr = String(carrier);
    const ov = st.oven && st.oven[stn];
    const rec = (ov && ov.c) ? ov.c[cr] : null;
    const ctx = this.tracker._findCtxByCarrier(st, Number(cr)) || null;
    const now = Date.now();
    const sc = (cfg.stations || {})[stn] || {};
    const ev = {
      line, type: 'EXIT', carrier: cr, lane: (ctx && ctx.lane) || '',
      dateKey: (ctx && ctx.dateKey) || '', set: ctx ? ctx.set : null, run: (ctx && ctx.run != null) ? ctx.run : null,
      station: stn, stationName: sc.name || '', stationType: sc.type || 'oven', seq: sc.seq != null ? Number(sc.seq) : null,
      enterTs: rec ? rec.inTime : (ctx ? ctx.enterTs : null), exitTs: now,
      dwell: (rec && rec.inTime) ? Math.round((now - rec.inTime) / 1000) : null,
      values: rec ? rec.params : (ctx && ctx.lastParams ? ctx.lastParams : {}),
      complete: true, cancel: true, ts: now,
    };
    const res = await this.projectEvent(ev);
    if (ov && ov.c) delete ov.c[cr];                                  // ออกจากเตา (monitor หยุดโชว์)
    if (ctx) { for (const k of Object.keys(st.jobs || {})) { if (st.jobs[k] === ctx) delete st.jobs[k]; } }
    try { await this._storeFor(cfg).saveRegister(line, st); } catch (_) {}
    return { ok: true, jobKey: res.jobKey };
  }

  listLines() { return Object.values(this.configs).map((c) => ({ line: c.line, label: c.label, enabled: c.enabled, stations: Object.keys(c.stations).length, fields: c.fields.length, editable: true })); }
  getConfig(line) { return this.configs[line] || null; }
  maxLines() { try { return this._licenseMaxLines ? this._licenseMaxLines() : 9999; } catch (_) { return 9999; } }   // DLClr limit (9999 = ไม่จำกัด/dev)
  lineCount() { return Object.keys(this.configs).length; }

  // user สร้าง/แก้/ตั้งชื่อไลน์เอง → เขียนลง runtime dir + reload · คืน config (+ auto สร้างตารางบน DB ที่เลือก)
  saveLine(raw) {
    const id = String((raw || {}).line || '').trim();
    // ไลน์ใหม่ → บังคับ id เป็น DB identifier (ใช้เป็นชื่อ flat view/lock/table) · ไลน์เดิม grandfather
    if (!this.configs[id] && !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(id)) {
      throw new Error('ชื่อไลน์ (id) ต้องเป็น A-Z a-z 0-9 _ · ขึ้นต้นด้วยตัวอักษร · ห้ามเว้นวรรค/ขีด(-)/อักขระพิเศษ (ใช้ "ชื่อแสดง" สำหรับชื่อไทย)');
    }
    // DLClr line-limit — เฉพาะ "ไลน์ใหม่" (แก้ไลน์เดิม/import ทับ ไม่นับ) · ครบ = ปฏิเสธ (ซื้อ DLC เพิ่ม)
    if (!this.configs[id]) {
      const max = this.maxLines(), cur = this.lineCount();
      if (cur >= max) { const e = new Error('line-limit'); e.code = 'line-limit'; e.maxLines = max; e.current = cur; throw e; }
    }
    const cfg = saveLineConfig(this.runtimeDir, raw); this.reload();
    const c = this.configs[cfg.line];
    this.ensureSchema(cfg.line).catch((e) => console.error('[lineRecorder] auto ensureSchema:', e.message));   // สร้างตาราง + view ให้อัตโนมัติ
    return c;
  }
  deleteLine(line) { const ok = deleteLineConfig(this.runtimeDir, line); this.reload(); return ok; }

  // comment ต่อแถว (set) — แก้จากหน้า monitor · patch setNotes ในไฟล์ config + reload (ไม่แตะตาราง)
  setSetNote(line, set, note) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const file = path.join(this.runtimeDir, String(line).replace(/[^A-Za-z0-9_\-]/g, '_') + '.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { raw = JSON.parse(JSON.stringify({ ...cfg, _file: undefined })); }   // seed-only → สร้าง override ใน runtime
    raw.setNotes = raw.setNotes || {};
    const s = String(set);
    if (note != null && String(note).trim()) raw.setNotes[s] = String(note).trim(); else delete raw.setNotes[s];
    saveLineConfig(this.runtimeDir, raw);
    this.reload();
    return raw.setNotes;
  }

  // comment field (manual job-field · user พิมพ์เองรายแถว) → header ของ job · entrance ที่ยัง pending → register ctx.data
  //   body: { jobKey?, carrier?, set?, key, value } — เขียนทั้ง live register (entrance) + job header (Job/history) ให้สอดคล้อง
  async setComment(line, { jobKey = null, carrier = null, set = null, key = null, value = '' } = {}) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    if (!key) throw new Error('ต้องระบุ key');
    const v = value == null ? '' : String(value);
    const store = this._storeFor(cfg);
    let updated = false;
    // 1) live register ctx (entrance: pending '@:<carrier>' / running '<set>:<carrier>') → data[key]
    const st = this.tracker.state[line];
    if (st && st.jobs && carrier != null) {
      let touched = false;
      for (const k of [`@:${carrier}`, `${set}:${carrier}`]) {
        if (st.jobs[k]) { st.jobs[k].data = { ...(st.jobs[k].data || {}), [key]: v }; touched = true; updated = true; }
      }
      if (touched && this.owned[line] !== false) { try { await store.saveRegister(line, st); } catch (_) {} }
    }
    // 2) job header (Job/history) — เฉพาะ job ที่มีจริง (กันสร้าง phantom จาก entrance ที่ยังไม่เข้าบ่อ)
    if (jobKey) {
      try { const j = await store.getJob(jobKey); if (j) { await store.upsertJob({ jobKey, line, dateKey: j.dateKey, data: { [key]: v } }); updated = true; } }
      catch (_) {}
    }
    return { ok: true, updated };
  }

  // รับ 1 message ดิบ (array) ของไลน์ → decode → project · คืนผลหรือ null
  async ingest(line, raw, ts) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบ config line "${line}"`);
    const ev = decode(raw, cfg, ts || Date.now());
    if (!ev) return { skipped: true, reason: 'eventType ไม่รู้จัก' };
    const res = await this.engine.project(ev);
    if (res.violations && res.violations.length && typeof this._onViolation === 'function') {
      try { this._onViolation(line, ev, res.violations); } catch (_) {}
    }
    return { ...res, event: ev };
  }

  // query (อ่าน) — route ไป store ของไลน์นั้น
  async jobs(filter) { const f = filter || {}; const st = f.line ? this._storeFor(this.configs[f.line]) : this._fileStore(); return st.listJobs(f); }
  async job(jobKey) { const line = String(jobKey || '').split('|')[0]; const st = this.configs[line] ? this._storeFor(this.configs[line]) : this._fileStore(); return st.getJob(jobKey); }
  async events(filter) { const f = filter || {}; const st = f.line ? this._storeFor(this.configs[f.line]) : this._fileStore(); return st.listEvents(f); }
}

module.exports = { LineRecorderManager };
