const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const { dialectOf, ph, tsVal } = require('./dbDialect');

/**
 * DeviceLogger — บันทึก log การเชื่อมต่อ device (online/offline)
 * เก็บ in-memory journal เสมอ + persist: ตั้ง dbConnection → DB · ไม่ตั้ง → CSV รายวันที่ root
 * config.dbConnection ว่าง = ไม่ใช้ DB (เขียน device-logs/device-YYYY-MM-DD.csv แทน)
 */
const CSV_FOLDER = 'device-logs';
const CSV_PREFIX = 'device';
const CSV_COLS = ['timestamp', 'device_id', 'name', 'event', 'detail'];

class DeviceLogger {
  constructor(dbManager) {
    this.dbManager = dbManager || null;
    this.config = { dbConnection: '', dbTable: 'device_log', journalLimit: 500 };
    this.journal = [];        // [{t, deviceId, name, event, detail}]
    this._dbReady = new Set();
    this._load();
    this._loadJournalFromCsv();             // โหลด log เก่ากลับ (กรณีไม่ใช้ DB)
  }

  // getter → path เปลี่ยนตาม Setup ได้ทันที (ไม่ cache)
  get csvDir() { return csv.csvDir(CSV_FOLDER); }

  _load() {
    this.path = csv.resolveConfig('device-log.json', path.join(__dirname, 'config', 'device-log.json'));
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.config = { ...this.config, ...(raw.config || {}) };
    } catch (_) {}
  }

  _save() {
    try {
      csv.writeJsonAtomic(this.path, { config: this.config });   // atomic (B3)
    } catch (_) {}
  }

  // บันทึก 1 เหตุการณ์ — คืน entry (ให้ server broadcast ต่อได้)
  log(deviceId, name, event, detail = '') {
    const entry = { t: Date.now(), deviceId, name: name || deviceId, event, detail };
    this.journal.push(entry);
    const lim = Number(this.config.journalLimit) || 500;
    if (this.journal.length > lim) this.journal.splice(0, this.journal.length - lim);
    // persist: ตั้ง dbConnection → DB · ไม่ตั้ง → CSV รายวันที่ root
    if (this.config.dbConnection && this.dbManager) this._logToDb(entry).catch(() => {});
    else this._logToCsv(entry);
    return entry;
  }

  // ── CSV logging (ใช้เมื่อไม่ใช้ DB) ────────────────────────────────────────────
  _logToCsv(entry) {
    csv.appendDailyRow(this.csvDir, CSV_PREFIX, new Date(entry.t), CSV_COLS, [
      new Date(entry.t).toISOString(), entry.deviceId, entry.name || '', entry.event || '', entry.detail || '',
    ]);
  }

  // โหลด log เก่าจาก CSV (ไฟล์รายวันใหม่สุด→ย้อนหลัง) กลับเข้า journal สูงสุด journalLimit
  _loadJournalFromCsv() {
    if (this.config.dbConnection) return;     // โหมด DB ไม่ใช้ CSV
    const files = csv.listDailyFiles(this.csvDir, CSV_PREFIX);
    const lim = Number(this.config.journalLimit) || 500;
    const collected = [];
    for (let fi = files.length - 1; fi >= 0 && collected.length < lim; fi--) {
      // tail เท่านั้น — ไฟล์วันอาจบวมผิดปกติ อ่านทั้งไฟล์ = boot ตาย OOM (ดู csvUtil.readCsvTail)
      const { cols, rows } = csv.readCsvTail(path.join(this.csvDir, files[fi]));
      const idx = (k) => cols.indexOf(k);
      const entries = [];
      for (const row of rows) {
        const ts = row[idx('timestamp')];
        const t = ts ? Date.parse(ts) : NaN;
        if (isNaN(t)) continue;
        entries.push({
          t, deviceId: row[idx('device_id')] || '', name: row[idx('name')] || '',
          event: row[idx('event')] || '', detail: row[idx('detail')] || '',
        });
      }
      const take = entries.slice(Math.max(0, entries.length - (lim - collected.length)));
      collected.unshift(...take);
    }
    this.journal = collected.slice(-lim);
  }

  getJournal(limit = 200, deviceId = null) {
    let j = this.journal;
    if (deviceId) j = j.filter((e) => e.deviceId === deviceId);
    return j.slice(-limit).reverse(); // ใหม่สุดก่อน
  }

  getConfig() { return { ...this.config }; }
  setConfig(updates) {
    this.config = { ...this.config, ...updates };
    this._dbReady.clear();
    this._save();
    return this.config;
  }

  // ── DB logging (best-effort, ไม่โยน error เข้า flow หลัก) ─────────────────────────
  async _logToDb(entry) {
    const conn = this.config.dbConnection;
    if (!conn || !this.dbManager) return;
    const table = (this.config.dbTable || 'device_log').replace(/[^a-zA-Z0-9_]/g, '');
    let type = 'pg';
    try { type = (this.dbManager.resolve(conn).type) || 'pg'; } catch (_) { return; }
    const isMs = type === 'mssql';
    const dialect = dialectOf(type);
    await this._ensureTable(conn, table, isMs);
    const phStr = ph(dialect, 5);
    const params = [tsVal(dialect, entry.t), entry.deviceId, entry.name || '', entry.event || '', entry.detail || ''];
    try { await this.dbManager.query(conn, `INSERT INTO ${table} (ts, device_id, name, event, detail) VALUES ${phStr}`, params); }
    catch (_) {}
  }

  async _ensureTable(conn, table, isMs) {
    const key = `${conn}:${table}`;
    if (this._dbReady.has(key)) return;
    const sql = isMs
      ? `IF OBJECT_ID('${table}','U') IS NULL CREATE TABLE ${table} (
           id INT IDENTITY PRIMARY KEY, ts DATETIME, device_id VARCHAR(64),
           name NVARCHAR(200), event VARCHAR(24), detail NVARCHAR(400))`
      : `CREATE TABLE IF NOT EXISTS ${table} (
           id SERIAL PRIMARY KEY, ts TIMESTAMP, device_id VARCHAR(64),
           name VARCHAR(200), event VARCHAR(24), detail VARCHAR(400))`;
    try { await this.dbManager.query(conn, sql, []); this._dbReady.add(key); }
    catch (_) {}
  }
}

module.exports = DeviceLogger;
