const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
let cron = null;
try { cron = require('node-cron'); } catch (_) { /* optional */ }

/**
 * DbBackup — backup/export ข้อมูลจาก DB ตามตาราง (cron) → ไฟล์ CSV
 *   job: { id, name, connection, cron, sql, enabled, lastRun, lastResult }
 *   ผลลัพธ์เก็บที่ <base>/datalog/db-backups/<name>-YYYY-MM-DD_HHmmss.csv
 *   config: <base>/config/db-backup.json
 */
class DbBackup {
  constructor(dbManager) {
    this.dbManager = dbManager || null;
    this.jobs = [];
    this.tasks = new Map();      // jobId -> cron task
    this.path = csv.resolveConfig('db-backup.json', path.join(__dirname, 'config', 'db-backup.json'));
    this._load();
  }

  get outDir() { return csv.csvDir('db-backups'); }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    } catch (_) { this.jobs = []; }
  }
  _save() { try { csv.writeJsonAtomic(this.path, { jobs: this.jobs }); } catch (_) {} }

  start() { for (const j of this.jobs) this._schedule(j); }
  stop() { for (const t of this.tasks.values()) { try { t.stop(); } catch (_) {} } this.tasks.clear(); }

  _unschedule(id) { const t = this.tasks.get(id); if (t) { try { t.stop(); } catch (_) {} this.tasks.delete(id); } }
  _schedule(job) {
    this._unschedule(job.id);
    if (!cron || !job.enabled || !job.cron || !cron.validate(job.cron)) return;
    const task = cron.schedule(job.cron, () => { this.runNow(job.id).catch(() => {}); });
    this.tasks.set(job.id, task);
  }

  // รัน job ทันที → เขียน CSV · คืน { ok, rows, file, error }
  async runNow(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw new Error(`Backup job not found: ${id}`);
    const t0 = Date.now();
    try {
      if (!this.dbManager) throw new Error('No database manager');
      const rows = await this.dbManager.query(job.connection, job.sql);
      const arr = Array.isArray(rows) ? rows : [];
      const cols = arr.length ? Object.keys(arr[0]) : [];
      const esc = (v) => {
        const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [cols.join(',')];
      for (const r of arr) lines.push(cols.map(c => esc(r[c])).join(','));
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const safe = (job.name || job.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!fs.existsSync(this.outDir)) fs.mkdirSync(this.outDir, { recursive: true });
      const file = path.join(this.outDir, `${safe}-${stamp}.csv`);
      fs.writeFileSync(file, '﻿' + lines.join('\r\n'));
      job.lastRun = t0; job.lastResult = { ok: true, rows: arr.length, ms: Date.now() - t0, file: path.basename(file) };
      this._save();
      return { ok: true, rows: arr.length, file: path.basename(file) };
    } catch (e) {
      job.lastRun = t0; job.lastResult = { ok: false, error: e.message, ms: Date.now() - t0 };
      this._save();
      return { ok: false, error: e.message };
    }
  }

  getConfig() { return { jobs: this.jobs, files: this._listFiles() }; }
  _listFiles() {
    try {
      return fs.readdirSync(this.outDir).filter(f => f.endsWith('.csv')).sort().reverse().slice(0, 50);
    } catch (_) { return []; }
  }

  addJob(job) {
    const j = {
      id: job.id || 'bk_' + Date.now(),
      name: job.name || 'backup',
      connection: job.connection || '',
      cron: job.cron || '0 2 * * *',     // default ตี 2 ทุกวัน
      sql: job.sql || '',
      enabled: job.enabled !== false,
      lastRun: null, lastResult: null,
    };
    this.jobs.push(j); this._save(); this._schedule(j);
    return j;
  }
  updateJob(id, updates) {
    const i = this.jobs.findIndex(j => j.id === id);
    if (i === -1) throw new Error(`Backup job not found: ${id}`);
    this.jobs[i] = { ...this.jobs[i], ...updates, id };
    this._save(); this._schedule(this.jobs[i]);
    return this.jobs[i];
  }
  removeJob(id) {
    const i = this.jobs.findIndex(j => j.id === id);
    if (i === -1) throw new Error(`Backup job not found: ${id}`);
    this._unschedule(id);
    this.jobs.splice(i, 1); this._save();
  }
}

module.exports = DbBackup;
