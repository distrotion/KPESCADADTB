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
const HISTORY_MAX_LIMIT = 50000;
const CHUNK_ROWS = 10000;        // rows per bounded query while scanning a window larger than `limit`
const SQLITE_CHUNK_ROWS = 2500;  // sqlite runs on the event loop: ~25 ms per chunk instead of ~100 ms (2.6 GB test file)
const MAX_SCAN_ROWS = 2000000;   // hard stop for one windowed history request
// retention without a table scan (sqlite drivers are synchronous: one big statement blocks the whole backend - .34 2026-10-13)
const PRUNE_CHUNK = 5000;         // rows per bounded step of the primary-key walk
const PRUNE_MAX_CHUNKS = 400;     // per table per pass (2M rows); the rest waits for the next pass
// an existing sqlite table this big without the (device, tag, ts) index is not indexed at runtime: CREATE INDEX would block for minutes
const INDEX_BUILD_MAX_ROWS = 200000;
const yieldLoop = () => new Promise((r) => setImmediate(r));

// fromMs = window start · untilMs = explicit end or null (open end = up to now)
function resolveWindow(windowSec, range) {
  const hasRange = range && Number(range.fromMs) > 0;
  const fromMs = hasRange ? Number(range.fromMs) : Date.now() - (Number(windowSec) || 300) * 1000;
  const untilMs = hasRange && Number(range.toMs) > 0 ? Number(range.toMs) : null;
  return { fromMs, untilMs };
}

// Downsamples a time-ordered row stream to about `budget` rows over [fromMs, toMs]:
//   numeric series -> min and max row of every time bucket (peaks/dips keep their real ts) + first/last row
//   text series    -> every change point; thinned evenly only if they alone exceed the leftover budget
class WindowSampler {
  constructor(fromMs, toMs, seriesCount, budget) {
    const n = Math.max(1, seriesCount);
    this.fromMs = fromMs;
    this.span = Math.max(1, toMs - fromMs + 1);
    this.budget = budget;
    this.buckets = Math.max(1, Math.floor((budget - 2 * n) / (2 * n)));
    this.series = new Map();
  }

  add(r) {
    const key = JSON.stringify([r.device || '', r.tag || '']);
    let s = this.series.get(key);
    if (!s) { s = { buckets: new Map(), first: null, last: null, texts: [], lastText: undefined }; this.series.set(key, s); }
    if (r.valueText != null) {
      if (r.valueText !== s.lastText) { s.texts.push(r); s.lastText = r.valueText; }
      return;
    }
    if (!s.first) s.first = r;
    s.last = r;
    let k = Math.floor(((r.ts - this.fromMs) / this.span) * this.buckets);
    if (k < 0) k = 0; else if (k >= this.buckets) k = this.buckets - 1;
    const b = s.buckets.get(k);
    if (!b) s.buckets.set(k, { min: r, max: r });
    else { if (r.value < b.min.value) b.min = r; if (r.value > b.max.value) b.max = r; }
  }

  result() {
    const picked = new Set();
    for (const s of this.series.values()) {
      if (s.first) picked.add(s.first);
      if (s.last) picked.add(s.last);
      for (const b of s.buckets.values()) { picked.add(b.min); picked.add(b.max); }
    }
    let texts = [];
    for (const s of this.series.values()) texts = texts.concat(s.texts);
    const room = Math.max(0, this.budget - picked.size);
    if (texts.length > room) {
      texts.sort((a, b) => a.ts - b.ts);
      const keep = [];
      for (let i = 0; i < room; i++) keep.push(texts[Math.floor((i * texts.length) / room)]);
      texts = keep;
    }
    for (const t of texts) picked.add(t);
    // ts order; equal ts -> device/tag so the result never depends on DB tie order or chunking
    return [...picked].sort((a, b) => a.ts - b.ts
      || String(a.device).localeCompare(String(b.device)) || String(a.tag).localeCompare(String(b.tag)));
  }
}

class ChartStore {
  // storage = DatalogStorage (sqlite rollover · backend/src/datalogStorage.js) · null = everything in the connection's own file/table
  constructor(dbManager, { storage = null } = {}) {
    this.dbManager = dbManager || null;
    this.storage = storage;
    this._ready = new Set();
    this._unindexed = new Set();   // `${connKey}:${table}` of big sqlite tables without the history index (skipped by reads)
    this._readable = new Map();    // `${connKey}:${table}` -> true | retry-at ms (reads of sqlite tables)
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
  //   opts.retentionDays: which rollover file group the rows belong to (named datalogs pass theirs; chart widgets = keep)
  async log(conn, table, samples, opts = {}) {
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
    const rows = [];
    for (const s of samples) {
      let value = null, valueText = null;
      if (s.valueText != null && s.valueText !== '') {
        valueText = String(s.valueText);                              // string tag / annotation (comment)
      } else {
        const num = Number(s.value);
        if (s.value == null || Number.isNaN(num)) continue;           // ตัวเลขว่าง/NaN ข้าม (เดิม)
        value = num;
      }
      const tsMs = new Date(s.ts || Date.now()).getTime();
      rows.push({ tsMs, p: [tsVal(dialect, tsMs), String(s.device || ''), String(s.tag || ''), value, valueText] });
    }
    if (dialect === 'sqlite' && this.storage && this.storage.writesRolled(conn)) {
      // rollover: each row to the file of its month and retention group (one statement per file)
      const groups = new Map();
      for (const r of rows) {
        const target = this.storage.writeTarget(conn, r.tsMs, opts.retentionDays);
        const g = groups.get(target.path);
        if (g) g.rows.push(r.p); else groups.set(target.path, { target, rows: [r.p] });
      }
      let inserted = 0;
      for (const { target, rows: rs } of groups.values()) {
        await this._ensureTable(target, tbl, dialect);
        inserted += await this._insertRows(target, tbl, dialect, rs);
      }
      return { ok: true, inserted };
    }
    await this._ensureTable(conn, tbl, dialect);
    return { ok: true, inserted: await this._insertRows(conn, tbl, dialect, rows.map((r) => r.p)) };
  }

  // all rows of one call in one statement = one commit (was one commit per row); a failing batch falls back to row by row
  async _insertRows(conn, tbl, dialect, rows) {
    if (!rows.length) return 0;
    const cols = `INSERT INTO ${tbl} (ts, device, tag, value, value_text) VALUES `;
    if (rows.length > 1 && rows.length <= 200) {
      let i = 0;
      const P = () => (dialect === 'mssql' ? `@p${i++}` : (dialect === 'mysql' || dialect === 'sqlite') ? (i++, '?') : `$${++i}`);
      const groups = rows.map(() => `(${P()}, ${P()}, ${P()}, ${P()}, ${P()})`);
      try { await this.dbManager.query(conn, cols + groups.join(', '), rows.flat()); return rows.length; } catch (_) { /* row by row below */ }
    }
    const phStr = ph(dialect, 5);
    let n = 0;
    for (const params of rows) {
      try { await this.dbManager.query(conn, cols + phStr, params); n++; } catch (_) {}
    }
    return n;
  }

  async _ensureTable(conn, table, dialect) {
    const key = `${this._connKey(conn)}:${table}`;
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
    // index (device, tag, ts) — history() query WHERE (device=? AND tag=?) ... AND ts>=? ORDER BY ts
    //   ไม่มี index เดิม = full table scan ทุกครั้ง โตขึ้นเรื่อย ๆ ตามอายุ log (retentionDays=0 = ไม่มีเพดาน)
    //   บล็อก event loop นาน (sqlite driver เป็น sync) ยิ่งมี concurrent history request ยิ่งหนัก — สงสัยเป็นสาเหตุ backend ค้าง/ตาย 2026-08-25
    const idxName = `idx_${table}_devtagts`;
    if (dialect === 'sqlite' && !(await this._sqliteIndexOk(conn, table, idxName))) { this._ready.add(key); return; }
    const createIndex = dialect === 'mssql'
      ? `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${idxName}') CREATE INDEX ${idxName} ON ${table} (device, tag, ts)`
      : `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (device, tag, ts)`;
    try { await this.dbManager.query(conn, createIndex, []); } catch (_) {}
    this._ready.add(key);
  }

  // sqlite: true when the (device, tag, ts) index exists or may be built now (table small enough). A big table without it is left
  //   alone: building it would block the backend, and reading it would scan it - so it is marked and history skips it (with a warning).
  async _sqliteIndexOk(conn, table, idxName) {
    try {
      const has = await this.dbManager.query(conn, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [idxName]);
      if (has && has.length) return true;
      const r = await this.dbManager.query(conn, `SELECT MIN(id) AS a, MAX(id) AS b FROM ${table}`, []);   // rowid min/max: two seeks
      const rows = r && r[0] && r[0].b != null ? Number(r[0].b) - Number(r[0].a) + 1 : 0;
      if (rows <= INDEX_BUILD_MAX_ROWS) return true;
      if (!this._unindexed.has(`${this._connKey(conn)}:${table}`)) {
        this._unindexed.add(`${this._connKey(conn)}:${table}`);
        console.warn(`[chart] ${table}: ~${rows} rows without the (device, tag, ts) index - not building it while running (it would block); history skips it`);
      }
      return false;
    } catch (_) { return true; }
  }

  // reads: a big sqlite table without the index would be scanned on every query (and block) -> skipped. Cached: yes for good, no for 10 min.
  async _sqliteReadable(conn, tbl) {
    const key = `${this._connKey(conn)}:${tbl}`;
    const c = this._readable.get(key);
    if (c === true || (c && Date.now() < c)) return c === true;
    const ok = await this._sqliteIndexOk(conn, tbl, `idx_${tbl}_devtagts`);
    this._readable.set(key, ok ? true : Date.now() + 600000);
    return ok;
  }

  _connKey(conn) { return typeof conn === 'object' && conn ? (conn.path || conn.file || conn.database || conn.id || '') : String(conn); }

  // ── ดึงประวัติของ series ภายในหน้าต่างเวลา ─────────────────────────────────
  //   series = [{device, tag}] · windowSec = ช่วงเวลาย้อนหลัง · limit = จำนวนแถวสูงสุด
  //   คืน rows = [{ts(ms), device, tag, value}] เรียงเวลาเก่า→ใหม่
  // range = { fromMs, toMs } (absolute) → ใช้แทน windowSec เมื่อมี fromMs · toMs ว่าง = ถึงปัจจุบัน
  //   NOTE: returns the OLDEST `limit` rows of the window (ORDER BY ts ASC LIMIT) — use historyWindow() to cover it all
  async history(conn, table, series, windowSec = 300, limit = 2000, range = null) {
    if (!conn || !this.dbManager || !Array.isArray(series) || series.length === 0) return [];
    const { fromMs, untilMs } = resolveWindow(windowSec, range);
    const lim = Math.min(Number(limit) || 2000, HISTORY_MAX_LIMIT);
    return this._queryRows(conn, table, series, fromMs, untilMs, lim);
  }

  // History that always covers the whole window in at most ~`limit` rows.
  //   rows <= limit -> exactly what history() returns (sampled: false)
  //   rows >  limit -> WindowSampler over a scan in bounded chunks (sampled: true)
  //   truncated: true only if the scan hit MAX_SCAN_ROWS or 1 ms held more than a chunk
  async historyWindow(conn, table, series, windowSec = 300, limit = 2000, range = null) {
    if (!conn || !this.dbManager || !Array.isArray(series) || series.length === 0) return { rows: [], sampled: false, truncated: false };
    const { fromMs, untilMs } = resolveWindow(windowSec, range);
    const lim = Math.min(Number(limit) || 2000, HISTORY_MAX_LIMIT);
    const probe = await this._queryRows(conn, table, series, fromMs, untilMs, lim + 1);
    if (probe.length <= lim) return { rows: probe, sampled: false, truncated: false };

    const lastProbeTs = probe[probe.length - 1].ts;
    const endMs = untilMs || Math.max(Date.now(), lastProbeTs);
    const sampler = new WindowSampler(fromMs, endMs, series.length, lim);
    const chunkRows = Math.max(2, Number(this.chunkRows) || (this._type(conn) === 'sqlite' ? SQLITE_CHUNK_ROWS : CHUNK_ROWS));
    const density = probe.length / Math.max(1, lastProbeTs - fromMs + 1);   // rows per ms, from the probe
    let span = Math.max(1, Math.floor(chunkRows / 2 / density));
    let a = fromMs;
    let scanned = 0;
    let truncated = false;
    for (;;) {
      const last = a + span - 1 >= endMs;
      const b = last ? untilMs : a + span - 1;   // last chunk keeps the caller's open end
      const rows = await this._queryRows(conn, table, series, a, b, chunkRows);
      if (rows.length >= chunkRows && span > 1) { span = Math.max(1, Math.floor(span / 2)); continue; }   // too dense -> retry smaller
      if (rows.length >= chunkRows) truncated = true;   // more than chunkRows rows inside 1 ms
      for (const r of rows) sampler.add(r);
      scanned += rows.length;
      if (last) break;
      if (scanned >= MAX_SCAN_ROWS) { truncated = true; break; }
      a += span;
      if (rows.length < chunkRows / 4) span *= 2;      // sparse stretch -> bigger steps
      await new Promise((r) => setImmediate(r));       // sync drivers (sqlite) never yield on await -> let HTTP/WS run
    }
    return { rows: sampler.result(), sampled: true, truncated };
  }

  // one bounded query: rows of `series` with fromMs <= ts (<= untilMs when given), oldest first, at most `lim`
  async _queryRows(conn, table, series, fromMs, untilMs, lim) {
    const type = this._type(conn);
    if (!type) return [];
    const since = new Date(fromMs);
    const until = untilMs ? new Date(untilMs) : null;

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
    const dialect = dialectOf(type);
    if (dialect === 'sqlite' && this.storage && this.storage.readsRolled(conn)) {
      // the main file (rows from before rollover) + every month file the window overlaps, merged oldest first
      const targets = this.storage.readTargets(conn, fromMs, untilMs);
      let all = [];
      for (let k = 0; k < targets.length; k++) {
        if (k) await yieldLoop();
        all = all.concat(await this._queryRowsSql(targets[k], tbl, dialect, series, since, until, lim));
      }
      if (targets.length > 1) {
        all.sort((a, b) => a.ts - b.ts || String(a.device).localeCompare(String(b.device)) || String(a.tag).localeCompare(String(b.tag)));
        if (all.length > lim) all.length = lim;
      }
      return all;
    }
    return this._queryRowsSql(conn, tbl, dialect, series, since, until, lim);
  }

  // one SQL source (a connection or one rollover file)
  async _queryRowsSql(conn, tbl, dialect, series, since, until, lim) {
    const isMs = dialect === 'mssql';
    if (dialect === 'sqlite' && !(await this._sqliteReadable(conn, tbl))) return [];
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
  //   NOTE: keeps the NEWEST `limit` rows of the window — use historyCsvWindow() to cover it all
  historyCsv(table, series, windowSec = 300, limit = 2000, range = null) {
    const lim = Math.min(Number(limit) || 2000, HISTORY_MAX_LIMIT);
    const out = this._csvRows(table, series, windowSec, range);
    return out.length > lim ? out.slice(out.length - lim) : out;
  }

  // CSV counterpart of historyWindow(): whole window in at most ~`limit` rows
  historyCsvWindow(table, series, windowSec = 300, limit = 2000, range = null) {
    const lim = Math.min(Number(limit) || 2000, HISTORY_MAX_LIMIT);
    const rows = this._csvRows(table, series, windowSec, range);
    if (rows.length <= lim) return { rows, sampled: false, truncated: false };
    const { fromMs, untilMs } = resolveWindow(windowSec, range);
    const sampler = new WindowSampler(fromMs, untilMs || Math.max(Date.now(), rows[rows.length - 1].ts), series.length, lim);
    for (const r of rows) sampler.add(r);
    return { rows: sampler.result(), sampled: true, truncated: false };
  }

  // every CSV row of `series` inside the window, oldest first
  _csvRows(table, series, windowSec = 300, range = null) {
    if (!Array.isArray(series) || series.length === 0) return [];
    const prefix = this._csvPrefix(table);
    const { fromMs: since, untilMs: until } = resolveWindow(windowSec, range);
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
    return out;
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
  //   SQL: never `DELETE ... WHERE ts < ?` over the whole table (a full scan; with the synchronous sqlite driver it froze the whole backend
  //   for hours on .34, 2026-10-13). Instead walk the primary key oldest first in PRUNE_CHUNK steps (rows are inserted in time order),
  //   delete the expired rows of each step, stop at the first step with nothing expired, and yield between steps.
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
      // with rollover the month files are deleted as whole files (sweepFiles); rows here = the connection's own file/table
      const r = await this._pruneTable(conn, this._safe(table, 'chart_history'), dialectOf(type), cutoff.getTime());
      return r.ok;
    } catch (_) { return false; }
  }

  // rollover: delete the month files past their retention + close idle handles (called once per prune pass for each sqlite connection)
  sweepFiles(conn) {
    if (!this.storage || !this.storage.readsRolled(conn)) return [];
    const gone = this.storage.sweep(conn);
    this.storage.closeIdle();
    return gone;
  }

  // one table: { ok, deleted, chunks, done } - done = no expired rows left in front (false = PRUNE_MAX_CHUNKS reached, next pass goes on)
  async _pruneTable(conn, tbl, dialect, cutoffMs) {
    const P = (n) => (dialect === 'mssql' ? `@p${n}` : (dialect === 'mysql' || dialect === 'sqlite') ? '?' : `$${n + 1}`);
    const pick = dialect === 'mssql'
      ? `SELECT TOP ${PRUNE_CHUNK} id, ts FROM ${tbl} WHERE id > ${P(0)} ORDER BY id`
      : `SELECT id, ts FROM ${tbl} WHERE id > ${P(0)} ORDER BY id LIMIT ${PRUNE_CHUNK}`;
    const del = `DELETE FROM ${tbl} WHERE id >= ${P(0)} AND id <= ${P(1)} AND ts < ${P(2)}`;
    const cutoffVal = tsVal(dialect, cutoffMs);
    let after = -1; let deleted = 0; let chunks = 0;
    for (;;) {
      let rows;
      try { rows = await this.dbManager.query(conn, pick, [after]); } catch (_) { return { ok: false, deleted, chunks, done: false }; }
      if (!rows || !rows.length) return { ok: true, deleted, chunks, done: true };
      const first = Number(rows[0].id); const last = Number(rows[rows.length - 1].id);
      const expired = rows.filter((r) => new Date(r.ts).getTime() < cutoffMs).length;
      if (!expired) return { ok: true, deleted, chunks, done: true };              // reached rows inside retention
      try { await this.dbManager.query(conn, del, [first, last, cutoffVal]); } catch (_) { return { ok: false, deleted, chunks, done: false }; }
      deleted += expired; chunks++;
      if (rows.length < PRUNE_CHUNK) return { ok: true, deleted, chunks, done: true };
      if (chunks >= PRUNE_MAX_CHUNKS) return { ok: true, deleted, chunks, done: false };
      after = last;
      await yieldLoop();                                                           // sqlite never yields on await: let HTTP/WS run
    }
  }
}

module.exports = ChartStore;
