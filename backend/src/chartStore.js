const path = require('path');
const csv = require('./csvUtil');
const { dialectOf, ph, tsVal } = require('./dbDialect');

/**
 * ChartStore — เก็บ/ดึง ประวัติค่า tag สำหรับ widget Chart
 * Schema มาตรฐาน: { ts, device, tag, value }
 *  - โหมด Database: PostgreSQL / MSSQL / MongoDB (auto-create ตาราง/collection)
 *  - โหมด CSV (ไม่ใช้ DB): ไฟล์รายวันที่ root → chart-logs/chart-<table>-YYYY-MM-DD.csv
 * best-effort (ไม่โยน error เข้า flow หลัก)
 */
const CSV_FOLDER = 'chart-logs';
const CSV_COLS = ['timestamp', 'device', 'tag', 'value'];

class ChartStore {
  constructor(dbManager) {
    this.dbManager = dbManager || null;
    this._ready = new Set();
  }

  // getter → path เปลี่ยนตาม Setup ได้ทันที (ไม่ cache)
  get csvDir() { return csv.csvDir(CSV_FOLDER); }

  _type(conn) {
    try { return (this.dbManager.resolve(conn).type || 'pg').toLowerCase(); }
    catch (_) { return null; }
  }

  _safe(name, def) {
    return (String(name || def).replace(/[^a-zA-Z0-9_]/g, '') || def);
  }

  // ── เก็บ samples: [{device, tag, value, ts?}] ──────────────────────────────
  async log(conn, table, samples) {
    if (!conn || !this.dbManager || !Array.isArray(samples) || samples.length === 0) return { ok: false, error: 'no data' };
    const type = this._type(conn);
    if (!type) return { ok: false, error: 'connection not found' };

    if (type === 'mongo' || type === 'mongodb') {
      const coll = this._safe(table, 'chart_history');
      const docs = samples.map((s) => {
        const d = { ts: new Date(s.ts || Date.now()), device: String(s.device || ''), tag: String(s.tag || '') };
        if (s.valueText != null && s.valueText !== '') d.value_text = String(s.valueText);   // string tag / annotation
        else d.value = Number(s.value);
        return d;
      });
      await this.dbManager.mongo(conn, coll, 'insertMany', docs);
      return { ok: true, inserted: docs.length };
    }

    const tbl = this._safe(table, 'chart_history');
    const isMs = type === 'mssql';
    const dialect = dialectOf(type);
    await this._ensureTable(conn, tbl, dialect);
    let n = 0;
    const phStr = ph(dialect, 5);
    for (const s of samples) {
      let value = null, valueText = null;
      if (s.valueText != null && s.valueText !== '') {
        valueText = String(s.valueText);                              // string tag / annotation (comment)
      } else {
        const num = Number(s.value);
        if (s.value == null || Number.isNaN(num)) continue;           // ตัวเลขว่าง/NaN ข้าม (เดิม)
        value = num;
      }
      const params = [tsVal(dialect, s.ts || Date.now()), String(s.device || ''), String(s.tag || ''), value, valueText];
      try { await this.dbManager.query(conn, `INSERT INTO ${tbl} (ts, device, tag, value, value_text) VALUES ${phStr}`, params); n++; }
      catch (_) {}
    }
    return { ok: true, inserted: n };
  }

  async _ensureTable(conn, table, dialect) {
    const key = `${conn}:${table}`;
    if (this._ready.has(key)) return;
    // value_text = string tag / annotation (comment) · numeric ลง value · text ลง value_text
    const sql = dialect === 'mssql'
      ? `IF OBJECT_ID('${table}','U') IS NULL CREATE TABLE ${table} (
           id INT IDENTITY PRIMARY KEY, ts DATETIME, device VARCHAR(64), tag VARCHAR(64), value FLOAT, value_text NVARCHAR(512) NULL)`
      : dialect === 'sqlite'
      ? `CREATE TABLE IF NOT EXISTS ${table} (
           id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, device TEXT, tag TEXT, value REAL, value_text TEXT)`
      : `CREATE TABLE IF NOT EXISTS ${table} (
           id SERIAL PRIMARY KEY, ts TIMESTAMP, device VARCHAR(64), tag VARCHAR(64), value DOUBLE PRECISION, value_text VARCHAR(512))`;
    await this.dbManager.query(conn, sql, []);
    // เติม value_text ให้ตารางเดิม (idempotent · ถ้ายังไม่มีคอลัมน์)
    const alter = dialect === 'mssql'
      ? `IF COL_LENGTH('${table}','value_text') IS NULL ALTER TABLE ${table} ADD value_text NVARCHAR(512) NULL`
      : dialect === 'sqlite'
      ? `ALTER TABLE ${table} ADD COLUMN value_text TEXT`
      : `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS value_text VARCHAR(512)`;
    try { await this.dbManager.query(conn, alter, []); } catch (_) {}   // มีคอลัมน์อยู่แล้ว (sqlite/mysql throw) → ข้าม
    this._ready.add(key);
  }

  // ── ดึงประวัติของ series ภายในหน้าต่างเวลา ─────────────────────────────────
  //   series = [{device, tag}] · windowSec = ช่วงเวลาย้อนหลัง · limit = จำนวนแถวสูงสุด
  //   คืน rows = [{ts(ms), device, tag, value}] เรียงเวลาเก่า→ใหม่
  // range = { fromMs, toMs } (absolute) → ใช้แทน windowSec เมื่อมี fromMs · toMs ว่าง = ถึงปัจจุบัน
  async history(conn, table, series, windowSec = 300, limit = 2000, range = null) {
    if (!conn || !this.dbManager || !Array.isArray(series) || series.length === 0) return [];
    const type = this._type(conn);
    if (!type) return [];
    const hasRange = range && Number(range.fromMs) > 0;
    const since = new Date(hasRange ? Number(range.fromMs) : Date.now() - (Number(windowSec) || 300) * 1000);
    const until = hasRange && Number(range.toMs) > 0 ? new Date(Number(range.toMs)) : null;
    const lim = Math.min(Number(limit) || 2000, 50000);

    if (type === 'mongo' || type === 'mongodb') {
      const coll = this._safe(table, 'chart_history');
      const or = series.map((s) => ({ device: String(s.device || ''), tag: String(s.tag || '') }));
      const tsq = { $gte: since };
      if (until) tsq.$lte = until;
      const rows = await this.dbManager.mongo(conn, coll, 'find',
        { $or: or, ts: tsq },
        { sort: { ts: 1 }, limit: lim });
      return (rows || []).map((r) => {
        const o = { ts: new Date(r.ts).getTime(), device: r.device, tag: r.tag };
        if (r.value_text != null) o.valueText = String(r.value_text);
        else o.value = Number(r.value);
        return o;
      });
    }

    const tbl = this._safe(table, 'chart_history');
    const isMs = type === 'mssql';
    const dialect = dialectOf(type);
    // WHERE (device=? AND tag=?) OR ... AND ts >= ? (AND ts <= ?)
    const groups = [];
    const params = [];
    let i = 0;
    const P = () => dialect === 'mssql' ? `@p${i}` : (dialect === 'mysql' || dialect === 'sqlite') ? '?' : `$${i + 1}`;
    for (const s of series) {
      const a = P(); params.push(String(s.device || '')); i++;
      const b = P(); params.push(String(s.tag || '')); i++;
      groups.push(`(device = ${a} AND tag = ${b})`);
    }
    const tparam = P(); params.push(tsVal(dialect, since)); i++;
    let where = `(${groups.join(' OR ')}) AND ts >= ${tparam}`;
    if (until) { const uparam = P(); params.push(tsVal(dialect, until)); i++; where += ` AND ts <= ${uparam}`; }
    const sql = isMs
      ? `SELECT TOP ${lim} ts, device, tag, value, value_text FROM ${tbl} WHERE ${where} ORDER BY ts ASC`
      : `SELECT ts, device, tag, value, value_text FROM ${tbl} WHERE ${where} ORDER BY ts ASC LIMIT ${lim}`;
    let rows = [];
    try { rows = await this.dbManager.query(conn, sql, params); } catch (_) { rows = []; }
    return (rows || []).map((r) => {
      const o = { ts: new Date(r.ts).getTime(), device: r.device, tag: r.tag };
      if (r.value_text != null) o.valueText = String(r.value_text);   // string tag / annotation
      else o.value = Number(r.value);
      return o;
    });
  }

  // ── CSV mode (ไม่ใช้ DB) — ไฟล์รายวันที่ root, แยกตามชื่อ table ──────────────────
  _csvPrefix(table) { return `chart-${this._safe(table, 'chart_history')}`; }

  // เก็บ samples ลง CSV รายวัน: [{device, tag, value, ts?}]
  logCsv(table, samples) {
    if (!Array.isArray(samples) || samples.length === 0) return { ok: false, error: 'no data' };
    const prefix = this._csvPrefix(table);
    let n = 0;
    for (const s of samples) {
      if (s.value == null || Number.isNaN(Number(s.value))) continue;
      const when = new Date(s.ts || Date.now());
      csv.appendDailyRow(this.csvDir, prefix, when, CSV_COLS, [
        when.toISOString(), String(s.device || ''), String(s.tag || ''), Number(s.value),
      ]);
      n++;
    }
    return { ok: true, inserted: n };
  }

  // ดึงประวัติจาก CSV ภายในหน้าต่างเวลา → [{ts(ms), device, tag, value}] เรียงเก่า→ใหม่
  historyCsv(table, series, windowSec = 300, limit = 2000, range = null) {
    if (!Array.isArray(series) || series.length === 0) return [];
    const prefix = this._csvPrefix(table);
    const hasRange = range && Number(range.fromMs) > 0;
    const since = hasRange ? Number(range.fromMs) : Date.now() - (Number(windowSec) || 300) * 1000;
    const until = hasRange && Number(range.toMs) > 0 ? Number(range.toMs) : null;
    const lim = Math.min(Number(limit) || 2000, 50000);
    const sinceStamp = csv.dateStamp(new Date(since));
    const untilStamp = until ? csv.dateStamp(new Date(until)) : null;
    // คีย์จับคู่ device+tag แบบกันชนกัน (JSON.stringify = ปลอดภัย + เป็น text · เดิมใช้ NUL byte → ทำ grep พลาด)
    const matchKey = (d, t) => JSON.stringify([d || '', t || '']);
    const want = new Set(series.map((s) => matchKey(s.device, s.tag)));
    // อ่านเฉพาะไฟล์รายวันในช่วง [sinceStamp, untilStamp] (lexical compare YYYY-MM-DD)
    const files = csv.listDailyFiles(this.csvDir, prefix).filter((f) => {
      const m = f.match(/(\d{4}-\d{2}-\d{2})\.csv$/);
      return m && m[1] >= sinceStamp && (!untilStamp || m[1] <= untilStamp);
    });
    const out = [];
    for (const f of files) {  // เก่า → ใหม่
      const { cols, rows } = csv.readCsv(path.join(this.csvDir, f));
      const ti = cols.indexOf('timestamp'), di = cols.indexOf('device'),
            gi = cols.indexOf('tag'), vi = cols.indexOf('value');
      for (const row of rows) {
        const t = Date.parse(row[ti]);
        if (isNaN(t) || t < since || (until && t > until)) continue;
        const dev = row[di] || '', tag = row[gi] || '';
        if (!want.has(matchKey(dev, tag))) continue;
        const val = Number(row[vi]);
        if (Number.isNaN(val)) continue;
        out.push({ ts: t, device: dev, tag, value: val });
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.length > lim ? out.slice(out.length - lim) : out;
  }

  // ── Retention (สำหรับ named datalog) ───────────────────────────────────────────
  // ลบไฟล์ CSV รายวันของ table ที่เก่ากว่า retentionDays วัน (เทียบ stamp YYYY-MM-DD)
  //   คืนจำนวนไฟล์ที่ลบ · best-effort (ไม่โยน error)
  pruneCsv(table, retentionDays) {
    const days = Number(retentionDays);
    if (!days || days <= 0) return 0;   // 0/ว่าง = เก็บตลอด
    const fs = require('fs');
    const prefix = this._csvPrefix(table);
    const cutoff = csv.dateStamp(new Date(Date.now() - days * 86400000));
    let removed = 0;
    for (const f of csv.listDailyFiles(this.csvDir, prefix)) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})\.csv$/);
      if (m && m[1] < cutoff) {
        try { fs.unlinkSync(path.join(this.csvDir, f)); removed++; } catch (_) {}
      }
    }
    return removed;
  }

  // ลบแถวใน DB ที่เก่ากว่า retentionDays วัน — best-effort (คืน true ถ้าสั่งสำเร็จ)
  async pruneDb(conn, table, retentionDays) {
    const days = Number(retentionDays);
    if (!days || days <= 0 || !conn || !this.dbManager) return false;
    const type = this._type(conn);
    if (!type) return false;
    const cutoff = new Date(Date.now() - days * 86400000);
    try {
      if (type === 'mongo' || type === 'mongodb') {
        const coll = this._safe(table, 'chart_history');
        await this.dbManager.mongo(conn, coll, 'deleteMany', { ts: { $lt: cutoff } });
        return true;
      }
      const tbl = this._safe(table, 'chart_history');
      const dialect = dialectOf(type);
      const phx = dialect === 'mssql' ? '@p0' : (dialect === 'mysql' || dialect === 'sqlite') ? '?' : '$1';
      await this.dbManager.query(conn, `DELETE FROM ${tbl} WHERE ts < ${phx}`, [tsVal(dialect, cutoff)]);
      return true;
    } catch (_) { return false; }
  }
}

module.exports = ChartStore;
