const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const { dialectOf, ph, qcol, tsVal } = require('./dbDialect');

/**
 * ActivityLog — บันทึก "ประวัติการทำงานของระบบ" (audit/event log)
 *   หมวด (category): auth (login/logout) · deploy · tag (write/force) · system (config/service/project)
 *   เก็บ in-memory journal เสมอ + persist: ตั้ง dbConnection → DB · ไม่ตั้ง → CSV รายวัน (ผ่าน csvUtil)
 *   ฟิลด์ CSV = DB เท่ากัน (convention เดียวกับ alarm/device log: CSV ใช้ 'timestamp', DB ใช้ 'ts')
 *
 *   เปิด/ปิด log แต่ละหมวดได้ (config.categories) เพื่อกัน noise
 */
const CSV_FOLDER = 'activity-logs';
const CSV_PREFIX = 'activity';

class ActivityLog {
  constructor(dbManager) {
    this.dbManager = dbManager || null;
    this.config = {
      dbConnection: '', dbTable: 'activity_log', journalLimit: 2000,
      // เปิด/ปิด log ต่อหมวด (tag = log เฉพาะ tag ที่ตั้ง logActivity ไว้ ถึงหมวดนี้จะเปิด)
      categories: { auth: true, deploy: true, tag: true, system: true, script: true },
    };
    this.journal = [];
    this._dbReady = new Set();
    this._load();
    this._loadJournalFromCsv();
  }

  get csvDir() { return csv.csvDir(CSV_FOLDER); }

  // คอลัมน์มาตรฐาน (CSV = DB · ใช้ร่วม export) — DB ใช้ชื่อ ts แทน timestamp
  static get COLUMNS() {
    return ['timestamp', 'category', 'action', 'user', 'target', 'detail', 'result', 'ip', 'actor_type'];   // §C8: actor_type (user/designer/ip/autorack) · 'user' = ชื่อ actor
  }

  _load() {
    this.path = csv.resolveConfig('activity-log.json', path.join(__dirname, 'config', 'activity-log.json'));
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.config = { ...this.config, ...(raw.config || {}) };
      this.config.categories = { auth: true, deploy: true, tag: true, system: true, script: true, ...(raw.config?.categories || {}) };
    } catch (_) {}
  }

  _save() {
    try {
      csv.writeJsonAtomic(this.path, { config: this.config });
    } catch (_) {}
  }

  // หมวดนี้เปิด log ไหม
  enabled(category) { return this.config.categories?.[category] !== false; }

  // บันทึก 1 เหตุการณ์ — { category, action, user, target, detail, result, ip }
  log(ev) {
    const category = ev.category || 'system';
    if (!this.enabled(category)) return null;
    const entry = {
      t: Date.now(),
      category,
      action: ev.action || '',
      user: ev.user || '-',
      target: ev.target || '',
      detail: ev.detail || '',
      result: ev.result || 'ok',
      ip: ev.ip || '',
      actorType: ev.actorType || '',   // §C8
    };
    this.journal.push(entry);
    const lim = Number(this.config.journalLimit) || 2000;
    if (this.journal.length > lim) this.journal.splice(0, this.journal.length - lim);
    if (this.config.dbConnection && this.dbManager) this._logToDb(entry).catch(() => {});
    else this._logToCsv(entry);
    return entry;
  }

  getJournal(limit = 300, category = null) {
    let j = this.journal;
    if (category) j = j.filter((e) => e.category === category);
    return j.slice(-limit).reverse();  // ใหม่สุดก่อน
  }

  getConfig() { return { ...this.config }; }
  setConfig(updates) {
    const cats = { ...this.config.categories, ...(updates.categories || {}) };
    this.config = { ...this.config, ...updates, categories: cats };
    this._dbReady.clear();
    this._save();
    return this.config;
  }

  // ── Export (full fields) ช่วง [fromMs,toMs] → array ของ row (object) ───────────────
  async exportEntries(fromMs, toMs) {
    const from = Number.isFinite(fromMs) ? fromMs : 0;
    const to = Number.isFinite(toMs) ? toMs : Date.now();
    const raw = (this.config.dbConnection && this.dbManager)
      ? await this._exportFromDb(from, to)
      : this._exportFromCsv(from, to);
    return raw.map((e) => ({
      timestamp: new Date(e.t).toISOString(),
      category: e.category || '', action: e.action || '', user: e.user || '',
      target: e.target || '', detail: e.detail || '', result: e.result || '', ip: e.ip || '', actor_type: e.actorType || '',
    }));
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  _logToCsv(entry) {
    csv.appendDailyRow(this.csvDir, CSV_PREFIX, new Date(entry.t), ActivityLog.COLUMNS, [
      new Date(entry.t).toISOString(), entry.category, entry.action, entry.user,
      entry.target, entry.detail, entry.result, entry.ip, entry.actorType || '',
    ]);
  }

  _csvRowToEntry(cols, row) {
    const get = (k) => { const i = cols.indexOf(k); return i >= 0 ? row[i] : ''; };
    const t = get('timestamp') ? Date.parse(get('timestamp')) : NaN;
    if (isNaN(t)) return null;
    return {
      t, category: get('category'), action: get('action'), user: get('user') || '-',
      target: get('target'), detail: get('detail'), result: get('result'), ip: get('ip'), actorType: get('actor_type'),
    };
  }

  _loadJournalFromCsv() {
    if (this.config.dbConnection) return;
    const files = csv.listDailyFiles(this.csvDir, CSV_PREFIX);
    const lim = Number(this.config.journalLimit) || 2000;
    const collected = [];
    for (let fi = files.length - 1; fi >= 0 && collected.length < lim; fi--) {
      // tail เท่านั้น — ไฟล์วันอาจบวมผิดปกติ (เคยเจอ 466MB) อ่านทั้งไฟล์ = boot ตาย OOM
      const { cols, rows } = csv.readCsvTail(path.join(this.csvDir, files[fi]));
      const entries = [];
      for (const row of rows) { const e = this._csvRowToEntry(cols, row); if (e) entries.push(e); }
      const take = entries.slice(Math.max(0, entries.length - (lim - collected.length)));
      collected.unshift(...take);
    }
    this.journal = collected.slice(-lim);
  }

  _exportFromCsv(from, to) {
    const files = csv.listDailyFiles(this.csvDir, CSV_PREFIX);
    const out = [];
    for (const f of files) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (m) {
        const dayStart = Date.parse(`${m[1]}T00:00:00`);
        if (Number.isFinite(dayStart) && (dayStart + 86400000 < from || dayStart > to)) continue;
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

  // ── DB (best-effort) ─────────────────────────────────────────────────────────
  async _logToDb(entry) {
    const conn = this.config.dbConnection;
    if (!conn || !this.dbManager) return;
    const table = (this.config.dbTable || 'activity_log').replace(/[^a-zA-Z0-9_]/g, '');
    let type = 'pg';
    try { type = (this.dbManager.resolve(conn).type) || 'pg'; } catch (_) { return; }
    const dialect = dialectOf(type);
    await this._ensureTable(conn, table, dialect);
    const phStr = ph(dialect, 9);
    const params = [
      tsVal(dialect, entry.t), entry.category, entry.action, entry.user,
      entry.target, entry.detail, entry.result, entry.ip, entry.actorType || '',
    ];
    try {
      await this.dbManager.query(conn,
        `INSERT INTO ${table} (ts, category, action, ${qcol('user', dialect)}, target, detail, result, ip, actor_type) VALUES ${phStr}`, params);
    } catch (_) {}
  }

  async _ensureTable(conn, table, dialect) {
    const key = `${conn}:${table}`;
    if (this._dbReady.has(key)) return;
    const isMs = dialect === 'mssql';
    const uq = qcol('user', dialect);   // mssql [user] · mysql `user` · pg "user"
    const sql = isMs
      ? `IF OBJECT_ID('${table}','U') IS NULL CREATE TABLE ${table} (
           id INT IDENTITY PRIMARY KEY, ts DATETIME, category VARCHAR(24), action VARCHAR(48),
           ${uq} NVARCHAR(120), target NVARCHAR(200), detail NVARCHAR(400), result VARCHAR(24), ip VARCHAR(64), actor_type VARCHAR(20))`
      : `CREATE TABLE IF NOT EXISTS ${table} (
           id SERIAL PRIMARY KEY, ts TIMESTAMP, category VARCHAR(24), action VARCHAR(48),
           ${uq} VARCHAR(120), target VARCHAR(200), detail VARCHAR(400), result VARCHAR(24), ip VARCHAR(64), actor_type VARCHAR(20))`;
    try { await this.dbManager.query(conn, sql, []); this._dbReady.add(key); }
    catch (_) {}
    // §C8: ตารางเก่า (สร้างก่อนมี actor_type) → เพิ่ม column (best-effort · ต่าง dialect — mysql ไม่รองรับ IF NOT EXISTS → plain + catch "duplicate")
    const alter = isMs
      ? `IF COL_LENGTH('${table}','actor_type') IS NULL ALTER TABLE ${table} ADD actor_type VARCHAR(20)`
      : dialect === 'pg'
        ? `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20)`
        : `ALTER TABLE ${table} ADD COLUMN actor_type VARCHAR(20)`;   // mysql: รันครั้งแรกเพิ่ม · ครั้งถัดไป error (มีแล้ว) = catch ข้าม
    try { await this.dbManager.query(conn, alter, []); } catch (_) {}
  }

  async _exportFromDb(from, to) {
    const conn = this.config.dbConnection;
    const table = (this.config.dbTable || 'activity_log').replace(/[^a-zA-Z0-9_]/g, '');
    let type = 'pg';
    try { type = (this.dbManager.resolve(conn).type) || 'pg'; } catch (_) { return []; }
    const dialect = dialectOf(type);
    const ucol = qcol('user', dialect);
    const b = dialect === 'mysql' ? ['?', '?'] : dialect === 'mssql' ? ['@p0', '@p1'] : ['$1', '$2'];
    const sql = `SELECT ts, category, action, ${ucol} AS user_, target, detail, result, ip FROM ${table} WHERE ts BETWEEN ${b[0]} AND ${b[1]} ORDER BY ts`;
    let rows = [];
    try { rows = await this.dbManager.query(conn, sql, [tsVal(dialect, from), tsVal(dialect, to)]); }
    catch (_) { return []; }
    return (rows || []).map((r) => ({
      t: r.ts ? Date.parse(r.ts) : Date.now(),
      category: r.category, action: r.action, user: r.user_, target: r.target,
      detail: r.detail, result: r.result, ip: r.ip,
    }));
  }
}

module.exports = ActivityLog;
