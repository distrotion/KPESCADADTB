// fileStore.js — LineStore adapter: in-memory authoritative + flush ลงไฟล์ JSON (dev / no-DB)
//   จับคู่ interface เดียวกับ sqlStore/mongoStore → สลับได้ผ่าน factory
//   เสถียร: เขียน append event ก่อน · job/step เป็น view · debounce flush + atomic write
const fs = require('fs');
const path = require('path');

function r6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

class FileStore {
  constructor({ file } = {}) {
    // KPE_DATA_DIR (ตั้งใน test) → แยกไฟล์ต่อ run · ไม่ตั้ง (live) = path เดิม
    this.file = file || (process.env.KPE_DATA_DIR
      ? path.join(process.env.KPE_DATA_DIR, 'lineRecorder-data.json')
      : path.join(__dirname, '..', '..', '..', '..', 'config', 'lineRecorder-data.json'));
    this.db = { jobs: {}, steps: {}, events: [], register: {} };   // jobs[jobKey] · steps[jobKey][station] · events[] · register[line]
    this._dirty = false; this._timer = null;
    this._load();
  }
  _load() {
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (raw && typeof raw === 'object') this.db = { jobs: raw.jobs || {}, steps: raw.steps || {}, events: raw.events || [], register: raw.register || {} }; }
    catch (_) { /* ไฟล์ยังไม่มี = เริ่มว่าง */ }
  }
  _scheduleFlush() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, 400);
  }
  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db));
      fs.renameSync(tmp, this.file);   // atomic
    } catch (e) { this._dirty = true; console.error('[lineStore/file] flush:', e.message); }
  }

  async ensureSchema() { return true; }

  // append-only event log = source of truth (เขียนก่อนเสมอ)
  async appendEvent(ev) {
    this.db.events.push({ id: this.db.events.length + 1, ...ev });
    if (this.db.events.length > 200000) this.db.events.splice(0, this.db.events.length - 200000);   // กันบวมในโหมดไฟล์
    this._scheduleFlush();
  }

  // ENTER → สร้าง/อัปเดต job (idempotent ตาม jobKey)
  async upsertJob(job) {
    const k = job.jobKey;
    const cur = this.db.jobs[k] || {};
    this.db.jobs[k] = { ...cur, ...job, updatedAt: job.ts || cur.updatedAt };
    if (!this.db.jobs[k].createdAt) this.db.jobs[k].createdAt = job.ts || null;
    this._scheduleFlush();
    return this.db.jobs[k];
  }

  // STEP/STAGE → สร้าง/อัปเดต step ต่อ (jobKey, station) · merge params
  async upsertStep(jobKey, step) {
    const byStation = this.db.steps[jobKey] = this.db.steps[jobKey] || {};
    const cur = byStation[step.station] || {};
    const params = { ...(cur.params || {}), ...(step.params || {}) };
    const merged = { ...cur, ...step, params };
    if (merged.dwell == null && merged.enterTs != null && merged.exitTs != null) merged.dwell = Math.round((merged.exitTs - merged.enterTs) / 1000);   // วินาที
    byStation[step.station] = merged;
    this._scheduleFlush();
    return merged;
  }

  async getJob(jobKey) {
    const job = this.db.jobs[jobKey]; if (!job) return null;
    return { ...job, steps: Object.values(this.db.steps[jobKey] || {}).sort((a, b) => (a.seq || 0) - (b.seq || 0)) };
  }
  async listJobs({ line = null, dateKey = null, status = null, q = null, from = null, to = null, field = null, value = null, limit = 200 } = {}) {
    let arr = Object.values(this.db.jobs);
    const reg = (j) => j.registerAt || j.loadAt || j.enterAt || j.createdAt || 0;   // เวลาอ้างอิง = Register time
    if (line) arr = arr.filter((j) => j.line === line);
    if (dateKey) arr = arr.filter((j) => j.dateKey === dateKey);
    if (status) arr = arr.filter((j) => j.status === status);
    if (from != null) arr = arr.filter((j) => reg(j) >= from);   // ช่วงวันที่
    if (to != null) arr = arr.filter((j) => reg(j) <= to);
    if (q) { const s = String(q).toLowerCase(); arr = arr.filter((j) => `${j.carrier} ${j.jobKey} ${JSON.stringify(j.data || j.header || {})}`.toLowerCase().includes(s)); }
    // ค้นเป๊ะที่ field เจาะจง (เช่น barcode) — รองรับ keyField=carrier ด้วย
    if (field && value != null) { const fk = String(field); const v = String(value); arr = arr.filter((j) => String(j.carrier) === v || String((j.data || j.header || {})[fk] ?? '') === v); }
    arr.sort((a, b) => reg(b) - reg(a));
    return arr.slice(0, limit).map((j) => ({ ...j, steps: Object.values(this.db.steps[j.jobKey] || {}).sort((a, b) => (a.seq || 0) - (b.seq || 0)) }));   // แนบ steps (เวลาชุบต่อบ่อ)
  }
  async getSteps(jobKey) { return Object.values(this.db.steps[jobKey] || {}).sort((a, b) => (a.seq || 0) - (b.seq || 0)); }
  async listEvents({ line = null, limit = 200 } = {}) {
    let arr = this.db.events; if (line) arr = arr.filter((e) => e.line === line);
    return arr.slice(-limit).reverse();
  }
  async ensureFlatView() { return null; }   // file = test · ไม่มี view

  // register (jobKey/occupancy สด) — โหมด file = test เท่านั้น
  async saveRegister(line, state) { this.db.register[line] = state || {}; this._scheduleFlush(); }
  async loadRegister(line) { return this.db.register[line] || null; }

  // reset (file/test) — เคลียร์ job/event/register ของไลน์ (ไม่ archive · file=test)
  async resetLine(line, stamp) {
    for (const k of Object.keys(this.db.jobs)) { if (this.db.jobs[k] && this.db.jobs[k].line === line) { delete this.db.jobs[k]; delete this.db.steps[k]; } }
    this.db.events = this.db.events.filter((e) => e.line !== line);
    delete this.db.register[line];
    this._scheduleFlush();
    return String(stamp || Date.now());
  }

  // lock — file/test = local เครื่องเดียว → เป็น owner เสมอ (ไม่มี HA)
  async claimLock() { return true; }
  async forceLock() { return true; }
  async releaseLock() { return true; }
  async getLock() { return null; }

  async stop() { this._flush(); }
}

module.exports = FileStore;
