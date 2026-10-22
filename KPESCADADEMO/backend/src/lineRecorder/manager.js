// manager.js — LineRecorderManager: orchestrator ของ Line Recorder (pattern เดียวกับ stockManager)
//   หน้าที่: โหลด config ทุกไลน์ · ถือ LineStore · รับ event (จาก PLC/ingest) → decode → engine.project
//   MVP: ยังไม่ผูก tag engine (PLC) — รับผ่าน ingest() / API เพื่อทดสอบก่อน
const path = require('path');
const fs = require('fs');
const csv = require('../csvUtil');   // configDir() เคารพ env KPE_DATA_DIR — ใช้แยก instance
const { loadLineConfigs, saveLineConfig, deleteLineConfig } = require('./lineConfig');
const { decode } = require('./decoder');
const { LineEngine, checkSpec } = require('./engine');
const measureGraph = require('./measureGraph');   // auto Query Buffer สำหรับกราฟค่าที่คนวัดเอง

// ค่าอยู่ในเกณฑ์ที่เก็บไว้ (specMap = {key:{min,max}} ที่ resolve แล้ว) — true ถ้าไม่หลุดตัวไหนเลย
function _withinSpec(params, specMap) {
  for (const k in (specMap || {})) {
    const v = (params || {})[k]; if (v == null) continue;
    const l = specMap[k];
    if ((l.min != null && v < l.min) || (l.max != null && v > l.max)) return false;
  }
  return true;
}
const { createLineStore } = require('./lineStore');
const { PlcSource } = require('./plcSource');
const { CarrierTracker } = require('./source/carrierTracker');
const { SnapshotSource } = require('./source/snapshotSource');

class LineRecorderManager {
  constructor({ seedDir, runtimeDir, store, tagEngine, plcIntervalMs, dbManager, licenseMaxLines, queryBufferManager } = {}) {
    this._licenseMaxLines = typeof licenseMaxLines === 'function' ? licenseMaxLines : null;   // () => จำนวนไลน์สูงสุดจาก license (DLClr) · null = ไม่จำกัด
    this.seedDir = seedDir || path.join(__dirname, '..', 'config', 'lines');                       // ตัวอย่าง (committed) · backend/src/config/lines
    // user สร้าง/ตั้งชื่อเอง (per-machine · <base>/config/lines · gitignored)
    //   ⚠️ ต้องอิง csvUtil.configDir() (ซึ่งเคารพ env KPE_DATA_DIR) ไม่ใช่ path จาก __dirname ตรง ๆ
    //   ของเดิมชี้ repo-root/config/lines เสมอ → หลาย instance บนเครื่องเดียวกัน (demo server / unit
    //   ที่รันคู่กัน) อ่านไลน์ชุดเดียวกันหมด ข้อมูลไลน์จริงรั่วข้าม instance (เจอจริง: demo tenant
    //   เห็นไลน์ของเครื่อง dev) · KPE_DATA_DIR ไม่ตั้ง = ได้ path เดิม จึงไม่กระทบเครื่องลูกค้าที่ใช้อยู่
    this.runtimeDir = runtimeDir || path.join(csv.configDir(), 'lines');
    this.configs = {};
    this.dbManager = dbManager || null;          // resolve DB connection ตามชื่อ (Setup → Databases)
    this.queryBufferManager = queryBufferManager || null;   // auto-สร้าง buffer ของกราฟ measure
    this._stores = {};                           // pool: 'db:<name>' | '__file__' → LineStore (per-line เลือก DB ได้)
    if (store) this._stores.__file__ = store;    // inject (test)
    this.tagEngine = tagEngine || null;   // อ่านค่า tag (spec แบบ tag/offset · resolve ตอน STEP)
    const readTag = (device, tag) => { try { const v = tagEngine && tagEngine.getTagValue ? tagEngine.getTagValue(device, tag) : null; return v ? v.value : null; } catch (_) { return null; } };
    this.engine = new LineEngine({ getStore: (line) => this._storeFor(this.configs[line]), getConfig: (line) => this.configs[line], getTagValue: readTag });
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

  // ── ค่าที่คนวัดเอง (measure) — ยิง barcode → หา job + บ่อที่อยู่ตอนนี้ → คีย์ค่า (เก็บทุกครั้ง ไม่ทับ) ──

  // หา job จาก barcode/carrier — กำลังวิ่งก่อน แล้วค่อยล่าสุด · คืน { job, station, passNo, jobs (ถ้ากำกวม) }
  async resolveByBarcode(line, barcode, { keyField = null } = {}) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const bc = String(barcode || '').trim();
    if (!bc) throw new Error('ต้องระบุ barcode');
    const store = this._storeFor(cfg);
    const kf = keyField || ((cfg.fields || []).some((f) => f.key === 'barcode') ? 'barcode' : 'carrier');
    let jobs = await store.listJobs({ line, field: kf, value: bc, limit: 20 });
    // ไม่เจอแบบเป๊ะ → ลองอีกครั้งแบบ "ไม่สนเลข 0 นำหน้า" (สแกน 002110023393 ↔ เก็บ 2110023393 และกลับกัน)
    if (!jobs || !jobs.length) {
      const strip = (s) => String(s == null ? '' : s).trim().replace(/^0+/, '');
      const target = strip(bc);
      if (target && target !== bc) {
        jobs = await store.listJobs({ line, field: kf, value: target, limit: 20 });   // เก็บแบบไม่มี 0 นำ
      }
      if ((!jobs || !jobs.length) && target) {
        const cand = await store.listJobs({ line, q: target, limit: 50 });            // เก็บแบบมี 0 นำ → ค้นกว้างแล้วกรองเอง
        jobs = (cand || []).filter((j) => {
          const v = (j.data || j.header || {})[kf];
          return strip(v) === target || strip(j.carrier) === target;
        });
      }
    }
    if (!jobs || !jobs.length) return { job: null, jobs: [], station: null, passNo: null };
    const running = jobs.filter((j) => j.status === 'running');
    const pick = (running.length ? running : jobs).sort((a, b) => (b.updatedAt || b.enterAt || 0) - (a.updatedAt || a.enterAt || 0))[0];
    const where = await this._whereIsJob(line, pick);
    return { job: pick, jobs, ...where, ambiguous: (running.length ? running.length : jobs.length) > 1 };
  }

  // งานอยู่บ่อไหนตอนนี้ (จาก register/occupancy) — ไม่อยู่ในไลน์ = null (คีย์ได้อยู่ ตาม acceptWhenNotInLine)
  async _whereIsJob(line, job) {
    if (!job) return { station: null, passNo: null };
    const st = await this.stateFor(line);
    const carrier = String(job.carrier != null ? job.carrier : '');
    for (const pos of Object.keys(st.occ || {})) {
      const o = st.occ[pos];
      if (o && String(o.carrier) === carrier) {
        const cfgPos = (((this.configs[line] || {}).source || {}).positions || []).find((p) => String(p.pos) === String(pos));
        return { station: cfgPos ? String(cfgPos.station) : String(pos), passNo: null, inLine: true };
      }
    }
    for (const stn of Object.keys((st.oven || {}))) {          // อยู่ในเตาอบ
      const c = ((st.oven[stn] || {}).c) || {};
      if (c[carrier] != null) return { station: String(stn), passNo: null, inLine: true };
    }
    return { station: null, passNo: null, inLine: false };
  }

  // field ที่ต้องวัด (scope=measure) — ค่าผูกกับ "งาน" ไม่ผูกบ่อ → คืนทุกตัวของไลน์
  measureFields(line) {
    const cfg = this.configs[line] || {};
    return (cfg.fields || []).filter((f) => f.scope === 'measure');
  }

  // บันทึก 1 ครั้งที่วัด — append เสมอ (ไม่ทับ) · ค่าเป็นของงาน (ไม่ผูกบ่อ) → station = null เสมอ
  async addMeasure(line, { barcode = null, jobKey = null, key, value = null, textValue = null,
                          passNo = null, actor = null, ip = null, note = null } = {}) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    if (!key) throw new Error('ต้องระบุ key (ค่าที่วัด)');
    let job = null; let where = { station: null, inLine: false };
    if (jobKey) { job = await this._storeFor(cfg).getJob(jobKey); where = await this._whereIsJob(line, job); }
    else { const r = await this.resolveByBarcode(line, barcode); job = r.job; where = { station: r.station, inLine: r.inLine }; }
    if (!job) throw new Error(`ไม่พบงานของ barcode "${barcode || jobKey}"`);
    const mc = cfg.measure || {};
    if (!where.inLine && mc.acceptWhenNotInLine === false) throw new Error('งานไม่ได้อยู่ในไลน์ตอนนี้ (ปิดรับค่าไว้)');
    const row = {
      line, jobKey: job.jobKey, station: null, passNo, key: String(key),
      value: value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null,
      textValue: (value == null || value === '' || !Number.isFinite(Number(value))) ? (textValue != null ? String(textValue) : (value != null ? String(value) : null)) : null,
      ts: Date.now(), actor: actor || null, actorMode: mc.actorMode || 'list', ip: ip || null, note: note || null,
      flags: { ...(where.inLine ? {} : { offline: true }) },
    };
    const saved = await this._storeFor(cfg).appendMeasure(row);
    return { ok: true, id: saved && saved.id, jobKey: job.jobKey, station: null, inLine: !!where.inLine, ts: row.ts };
  }

  async measures(line, { jobKey = null, key = null, limit = 500 } = {}) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const st = this._storeFor(cfg);
    if (typeof st.listMeasures !== 'function') return [];
    return st.listMeasures({ line, jobKey, key, limit });
  }

  async deleteMeasure(line, id) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const st = this._storeFor(cfg);
    if (typeof st.deleteMeasure !== 'function') return false;
    return st.deleteMeasure(id, line);
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
    this.syncMeasureGraphs(cfg.line);   // มี measure field → สร้าง/อัปเดต Query Buffer ของกราฟให้อัตโนมัติ
    return c;
  }

  // ── กราฟค่าที่คนวัดเอง (measure) — auto Query Buffer ต่อ field · แกน X = ฟิวของงาน · 1 เส้นต่อ field ──
  //   idempotent: เรียกซ้ำ = update ตัวเดิม (ยึดชื่อ deterministic) ไม่สร้างซ้ำ
  syncMeasureGraphs(line) {
    const cfg = this.configs[line];
    if (!cfg || !this.queryBufferManager) return [];
    let dialect = 'pg';
    try {
      const conn = this.dbManager && this.dbManager.resolve ? this.dbManager.resolve((cfg.source || {}).storeDb) : null;
      if (conn && conn.type) dialect = conn.type === 'mariadb' ? 'mysql' : conn.type;
    } catch (_) { /* ไม่รู้ dialect → pg (ค่าเริ่มต้น) */ }
    try { return measureGraph.syncBuffers(cfg, this.queryBufferManager, { dialect }); }
    catch (e) { console.error('[lineRecorder] measure graph:', e.message); return []; }
  }

  // ข้อมูลกราฟที่ UI ต้องใช้ตั้ง chart (bufferId + แกน X + คอลัมน์ Y ของ field) · ไม่สร้างใหม่
  measureGraphs(line) {
    const cfg = this.configs[line];
    if (!cfg || !this.queryBufferManager) return [];
    const bufs = this.queryBufferManager.list();
    return (cfg.fields || []).filter((f) => f.scope === 'measure').map((f) => {
      const b = bufs.find((x) => x.name === measureGraph.bufferName(line, f.key));
      return {
        key: f.key, label: f.label || f.key, unit: f.unit || '',
        bufferId: b ? b.id : null,
        xCol: measureGraph.xColumnOf(cfg),
        yCols: [measureGraph.valueColName(cfg, f)],   // 1 เส้นต่อ field — ไม่แยกตามบ่อแล้ว
        // กติกาเมื่อมีหลายค่าที่จุดเดียวกัน — ให้ UI บอกผู้ใช้ได้ว่ากราฟนี้อ่านยังไง
        agg: measureGraph.aggOf(cfg), aggLabel: measureGraph.AGG_LABEL[measureGraph.aggOf(cfg)],
        merge: measureGraph.mergeSameX(cfg),
      };
    });
  }
  deleteLine(line) { const ok = deleteLineConfig(this.runtimeDir, line); this.reload(); return ok; }

  // แกน X ของกราฟค่าที่วัด — เปลี่ยนได้จากหน้ากราฟเลย (patch config + สร้าง SQL ของ buffer ใหม่)
  //   buffer มีตัวเดียวต่อ field → เปลี่ยนที่นี่ = เปลี่ยนให้ทุกคนที่ดูกราฟนี้ (ตั้งใจ: จุดตั้งค่าเดียว ไม่แตกเป็น state ซ้อน)
  setMeasureGraphX(line, x) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    const want = String(x == null ? '' : x).trim();
    const jobKeys = (cfg.fields || []).filter((f) => f.scope === 'job').map((f) => f.key);
    if (want !== '' && want !== 'carrier' && !jobKeys.includes(want)) {
      throw new Error(`"${want}" ไม่ใช่ข้อมูลของงาน (เลือกได้: carrier, ${jobKeys.join(', ')})`);
    }
    const file = path.join(this.runtimeDir, String(line).replace(/[^A-Za-z0-9_\-]/g, '_') + '.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { raw = JSON.parse(JSON.stringify({ ...cfg, _file: undefined })); }   // seed-only → สร้าง override ใน runtime
    raw.measure = { ...(raw.measure || {}), graphX: want };
    saveLineConfig(this.runtimeDir, raw);
    this.reload();
    this.syncMeasureGraphs(line);
    return this.measureGraphs(line);
  }

  // ฟิวที่ใช้เป็นแกน X ได้ (ให้ dropdown หน้ากราฟ) — เลขงาน + ข้อมูลของงานทุกตัว
  measureGraphXOptions(line) {
    const cfg = this.configs[line];
    if (!cfg) return [];
    return ['carrier', ...(cfg.fields || []).filter((f) => f.scope === 'job').map((f) => f.key)];
  }

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

  // หมายเหตุต่อบ่อ (คนพิมพ์เองในใบรายงาน · ใครพิมพ์ก็ได้ ไม่ต้องเลือกชื่อ) → job.steps[<บ่อ>].note
  //   "ต่อบ่อ" ไม่ใช่ต่อรอบ — งานที่ย้อนบ่อเดิม รอบหลังจะทับรอบแรก (steps เก็บบ่อละ 1 ค่า)
  async setStepNote(line, { jobKey = null, station = null, note = '' } = {}) {
    const cfg = this.configs[line];
    if (!cfg) throw new Error(`ไม่พบไลน์ "${line}"`);
    if (!jobKey) throw new Error('ต้องระบุ jobKey');
    if (station == null || String(station) === '') throw new Error('ต้องระบุบ่อ (station)');
    const store = this._storeFor(cfg);
    if (typeof store.setStepNote !== 'function') throw new Error('store นี้ยังไม่รองรับหมายเหตุต่อบ่อ');
    const ok = await store.setStepNote(jobKey, String(station), note);
    return { ok, updated: ok };
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

  // ── path: STEP events เรียงจริง (รวม revisit/ย้อนบ่อ) + enrich จาก config ──────
  //   คืน [{ passNo, station, stationName, type, seq, enterTs, exitTs, dwell, inSpec, params, ts }]
  async jobPath(jobKey) {
    const line = String(jobKey || '').split('|')[0];
    const cfg = this.configs[line] || { fields: [], stations: {} };
    const st = this.configs[line] ? this._storeFor(this.configs[line]) : this._fileStore();
    const stations = cfg.stations || {};
    const evs = await st.listEvents({ line, jobKey, type: 'STEP', order: 'asc', limit: 5000 });
    if (evs && evs.length) {
      // มี STEP event ต่อบ่อ (บันทึกสด) = เส้นทางจริง รวม revisit/ย้อนบ่อ
      return evs.map((e, i) => {
        const d = e.data || e;   // sql/sqlite: nested .data · fileStore: top-level
        const sc = stations[String(e.station)] || {};
        const params = d.values || {};
        return {
          passNo: i + 1, station: e.station != null ? String(e.station) : '',
          stationName: sc.name || '', type: sc.type || '', seq: sc.seq != null ? Number(sc.seq) : null,
          enterTs: d.enterTs != null ? d.enterTs : null, exitTs: d.exitTs != null ? d.exitTs : null,
          dwell: d.dwell != null ? d.dwell : null,
          inSpec: (d.spec ? _withinSpec(params, d.spec) : (checkSpec(cfg.fields, e.station, params, (stations[String(e.station)] || {}).spec).length === 0)) && d.dwellInSpec !== false,   // เกณฑ์ที่เก็บ (tag/offset) + เวลาชุบหลุด SP±% = ✗
          params, stats: d.stats || null,   // min/max/avg ต่อ param (เมื่อเปิด track)
          spec: d.spec || null,   // เกณฑ์ที่ใช้จริง (resolve แล้ว) → แสดง min–max
          dwellSp: d.dwellSp != null ? d.dwellSp : null, dwellTol: d.dwellTol != null ? d.dwellTol : null,
          dwellInSpec: d.dwellInSpec != null ? d.dwellInSpec : null,   // null = ไม่ตั้ง/เทียบเฉย ๆ
          hasSeries: d.hasSeries === true,   // มี minigraph ในตาราง series
          ts: e.ts, source: 'event',
        };
      });
    }
    // fallback: ไม่มี STEP event (ข้อมูล migrate/bulk เก่า) → ใช้ job.steps (เรียงตาม seq · ไม่มี revisit เพราะข้อมูลไม่มี)
    const job = await st.getJob(jobKey);
    const steps = (job && job.steps) || [];
    return steps.map((s, i) => {
      const sc = stations[String(s.station)] || {};
      const params = s.params || {};
      return {
        passNo: i + 1, station: s.station != null ? String(s.station) : '',
        stationName: sc.name || s.name || '', type: sc.type || s.type || '', seq: s.seq != null ? Number(s.seq) : null,
        enterTs: s.enterTs != null ? s.enterTs : null, exitTs: s.exitTs != null ? s.exitTs : null,
        dwell: s.dwell != null ? s.dwell : null,
        inSpec: s.inSpec != null ? s.inSpec : (s.spec ? _withinSpec(params, s.spec) : (checkSpec(cfg.fields, s.station, params, (stations[String(s.station)] || {}).spec).length === 0)),
        params, stats: s.stats || null, spec: s.spec || null,
        dwellSp: s.dwellSp != null ? s.dwellSp : null, dwellTol: s.dwellTol != null ? s.dwellTol : null,
        dwellInSpec: s.dwellInSpec != null ? s.dwellInSpec : null,
        hasSeries: s.hasSeries === true,
        ts: s.ts, source: 'steps',
      };
    });
  }

  // ── minigraph: series ระหว่างชุบของงาน (จากตาราง lr_<line>_series) ──
  async jobSeries(jobKey, { station = null, ts = null } = {}) {
    const line = String(jobKey || '').split('|')[0];
    const st = this.configs[line] ? this._storeFor(this.configs[line]) : this._fileStore();
    if (typeof st.getSeries !== 'function') return [];
    return st.getSeries({ line, jobKey, station, ts });
  }

  // ── export history (long CSV): 1 แถว/การเข้าบ่อ · ครบทุกรอบ (revisit) + ทุก param ──
  async exportHistory({ line = null, from = null, to = null, status = null, q = null, limit = 5000 } = {}) {
    const cfg = (line && this.configs[line]) || { fields: [], stations: {} };
    const jobFields  = (cfg.fields || []).filter((f) => f.scope === 'job').map((f) => f.key);
    const stepFields = (cfg.fields || []).filter((f) => f.scope !== 'job' && f.scope !== 'measure').map((f) => f.key);
    const measFields = (cfg.fields || []).filter((f) => f.scope === 'measure').map((f) => f.key);   // ค่าที่คนวัดเอง → คอลัมน์ <key>_meas (ค่าล่าสุดของงาน)
    // field ที่เปิด track → เพิ่มคอลัมน์ <key>_min / <key>_max
    const statKeys = (cfg.fields || []).filter((f) => f.scope !== 'job' && f.scope !== 'measure' && f.track && (f.track.minMax || f.track.summary === 'avg')).map((f) => f.key);
    const statCols = statKeys.flatMap((k) => [`${k}_min`, `${k}_max`]);
    const jobs = await this.jobs({ line, from, to, status, q, limit });
    const tz = (v) => (v == null ? '' : new Date(Number(v)).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }));
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const cols = ['job_key', 'carrier', 'date_key', 'status', ...jobFields, 'pass_no', 'station', 'station_name', 'enter', 'exit', 'dwell_s', 'dwell_sp', 'dwell_in_spec', 'in_spec', ...stepFields, ...statCols, ...measFields.map((k) => k + '_meas'), 'note'];
    // หมายเหตุต่อบ่อ — อยู่ใน job.steps (listJobs คืนมาให้แล้ว) ไม่ใช่ใน STEP event → map ตามเลขบ่อ
    const noteOf = (j, station) => {
      const s = (j.steps || []).find((x) => String(x.station) === String(station));
      return (s && s.note) || '';
    };
    const statVals = (p) => statKeys.flatMap((k) => { const s = (p.stats || {})[k]; return [s && s.min != null ? s.min : '', s && s.max != null ? s.max : '']; });
    // ค่าที่วัด (append log) — ดึงทีเดียวทั้งไลน์ แล้ว group ตามงาน (ค่าล่าสุดชนะ · ข้อมูลเก่าที่ผูกบ่อไว้ก็รวมมาที่งานเดียวกัน)
    const measBy = {};
    if (measFields.length && line) {
      try {
        for (const m of (await this.measures(line, { limit: 5000 }))) {
          measBy[m.jobKey + '|' + m.key] = m.value != null ? m.value : m.textValue;   // เรียงมาตาม ts ASC → ตัวท้ายคือค่าล่าสุด
        }
      } catch (_) { /* ไม่มีตาราง measure (ไลน์เก่า) → คอลัมน์ว่าง */ }
    }
    const measVals = (jk) => measFields.map((k) => { const v = measBy[jk + '|' + k]; return v != null ? v : ''; });
    const rows = [cols.join(',')];
    for (const j of (jobs || [])) {
      const jk = j.jobKey || j.job_key;
      const header = j.data || j.header || {};
      const base = [jk, j.carrier, j.dateKey || j.date_key, j.status, ...jobFields.map((k) => header[k])];
      const path = await this.jobPath(jk);
      if (!path.length) { rows.push([...base, '', '', '', '', '', '', '', '', ...stepFields.map(() => ''), ...statCols.map(() => ''), ...measFields.map(() => ''), ''].map(esc).join(',')); continue; }
      for (const p of path) {
        rows.push([...base, p.passNo, p.station, p.stationName, tz(p.enterTs), tz(p.exitTs), p.dwell,
          p.dwellSp != null ? p.dwellSp : '', p.dwellInSpec == null ? '' : (p.dwellInSpec ? 1 : 0), p.inSpec ? 1 : 0,
          ...stepFields.map((k) => (p.params[k] != null ? p.params[k] : '')), ...statVals(p), ...measVals(jk),
          noteOf(j, p.station)].map(esc).join(','));
      }
    }
    return rows.join('\n');
  }
}

module.exports = { LineRecorderManager };
