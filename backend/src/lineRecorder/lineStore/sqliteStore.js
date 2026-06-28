// sqliteStore.js — LineStore adapter (SQLite · node:sqlite หรือ better-sqlite3 ผ่าน sqliteDriver) · ตาราง "แยกต่อไลน์"
//   port จาก sqlStore (pg): jsonb → TEXT + json1 (json_patch/json_extract) · now() → Date.now() (เครื่องเดียว ไม่มี clock-skew)
//   sync driver → ห่อ async (interface เดียวกับ sqlStore) · 1 ไฟล์ .sqlite ถือทุกไลน์ (per-line tables) · WAL กัน recorder+viewer ชน
const sqlite = require('../../sqliteDriver');
const path = require('path');
const fs = require('fs');

function r6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

class SqliteStore {
  constructor(opts = {}) {
    const conn = opts.conn || {};
    this.filePath = opts.path || conn.path || conn.file || conn.database || opts.file;
    if (!this.filePath) throw new Error('[lineStore/sqlite] ต้องระบุ path ไฟล์ .sqlite (conn.path)');
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); } catch (_) {}
    this.db = sqlite.open(this.filePath);   // สร้างไฟล์เอง + WAL + busy_timeout
    this.driver = this.db.driver;           // 'node' | 'better'
    this._ensured = new Set();
  }

  _sid(line) { return String(line).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(); }
  _t(line, kind) { return `lr_${this._sid(line)}_${kind}`; }
  _view(line) { return `lr_${this._sid(line)}_flat`; }
  _lineOf(jobKey) { const s = String(jobKey || ''); const i = s.indexOf('|'); return i >= 0 ? s.slice(0, i) : s; }

  _ddl(line) {
    const j = this._t(line, 'job'), e = this._t(line, 'event'), r = this._t(line, 'register'), l = this._t(line, 'lock');
    return `
CREATE TABLE IF NOT EXISTS ${e} (event_id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT, job_key TEXT, type TEXT,
  carrier TEXT, lane TEXT, station TEXT, ts INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS ${j} (job_key TEXT PRIMARY KEY, line TEXT, date_key TEXT, lane TEXT, carrier TEXT, run TEXT, set_id TEXT,
  status TEXT, gap INTEGER DEFAULT 0, enter_at INTEGER, register_at INTEGER, load_at INTEGER, exit_at INTEGER,
  header TEXT DEFAULT '{}', steps TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS ${r} (line TEXT PRIMARY KEY, state TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS ${l} (line TEXT PRIMARY KEY, owner TEXT, label TEXT, heartbeat_ms INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS ${j}_dt ON ${j}(date_key);
CREATE INDEX IF NOT EXISTS ${e}_tsx ON ${e}(ts);`;
  }

  async ensureSchema(line) {
    if (!line) return true;
    if (this._ensured.has(line)) return true;
    this.db.exec(this._ddl(line));
    this._ensured.add(line);
    return true;
  }

  // 1) append event = source of truth
  async appendEvent(ev) {
    this.db.prepare(`INSERT INTO ${this._t(ev.line, 'event')} (line,job_key,type,carrier,lane,station,ts,data) VALUES (?,?,?,?,?,?,?,?)`)
      .run(ev.line, ev.jobKey, ev.type, ev.carrier, ev.lane, ev.station, ev.ts,
        JSON.stringify({ enterTs: ev.enterTs, exitTs: ev.exitTs, dwell: ev.dwell, values: ev.values, gap: ev.gap, run: ev.run }));
  }

  // 2) upsert job — header merge ด้วย json_patch · gap sticky (bitwise OR)
  async upsertJob(job) {
    const ts = job.ts || Date.now();
    const jt = this._t(job.line, 'job');
    this.db.prepare(
      `INSERT INTO ${jt} (job_key,line,date_key,lane,carrier,run,set_id,status,gap,enter_at,register_at,load_at,exit_at,header,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(job_key) DO UPDATE SET
         status=COALESCE(excluded.status, status),
         enter_at=COALESCE(excluded.enter_at, enter_at),
         register_at=COALESCE(excluded.register_at, register_at),
         load_at=COALESCE(excluded.load_at, load_at),
         exit_at=COALESCE(excluded.exit_at, exit_at),
         gap=gap | excluded.gap,
         set_id=COALESCE(excluded.set_id, set_id),
         header=json_patch(header, excluded.header),
         updated_at=excluded.updated_at`
    ).run(job.jobKey, job.line, job.dateKey, job.lane, job.carrier, job.run != null ? String(job.run) : null,
      job.set != null ? String(job.set) : null, job.status || null, job.gap ? 1 : 0,
      job.enterAt != null ? job.enterAt : null, job.registerAt != null ? job.registerAt : null,
      job.loadAt != null ? job.loadAt : null, job.exitAt != null ? job.exitAt : null,
      JSON.stringify(job.data || {}), ts, ts);
    return this._mapJob(this.db.prepare(`SELECT * FROM ${jt} WHERE job_key=?`).get(job.jobKey));
  }

  // 3) step → merge เข้า <job>.steps[station] (read-modify-write · เลี่ยง json path quoting)
  async upsertStep(jobKey, step) {
    const line = this._lineOf(jobKey);
    const jt = this._t(line, 'job');
    const station = String(step.station);
    const dwell = (step.dwell != null) ? r6(step.dwell)
      : ((step.enterTs != null && step.exitTs != null) ? Math.round((step.exitTs - step.enterTs) / 1000) : null);
    const obj = {
      name: step.name || '', seq: step.seq != null ? step.seq : null, type: step.type || '',
      enterTs: step.enterTs != null ? step.enterTs : null, exitTs: step.exitTs != null ? step.exitTs : null, dwell,
      params: step.params || {}, inSpec: step.inSpec != null ? step.inSpec : null, ts: step.ts || Date.now(),
    };
    const row = this.db.prepare(`SELECT steps FROM ${jt} WHERE job_key=?`).get(jobKey);
    if (!row) return null;
    const steps = JSON.parse(row.steps || '{}');
    steps[station] = { ...(steps[station] || {}), ...obj };
    this.db.prepare(`UPDATE ${jt} SET steps=?, updated_at=? WHERE job_key=?`).run(JSON.stringify(steps), Date.now(), jobKey);
    return { station, ...obj };
  }

  _mapJob(j) {
    if (!j) return null;
    return {
      ...j, jobKey: j.job_key, dateKey: j.date_key, enterAt: j.enter_at, exitAt: j.exit_at,
      registerAt: j.register_at, loadAt: j.load_at, createdAt: j.created_at, updatedAt: j.updated_at,
      gap: !!j.gap, data: JSON.parse(j.header || '{}'), set: j.set_id,
    };
  }
  _steps(stepsObj) {
    return Object.entries(stepsObj || {}).map(([station, s]) => ({ station, ...s }))
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }

  async getJob(jobKey) {
    const j = this.db.prepare(`SELECT * FROM ${this._t(this._lineOf(jobKey), 'job')} WHERE job_key=?`).get(jobKey);
    if (!j) return null;
    return { ...this._mapJob(j), steps: this._steps(JSON.parse(j.steps || '{}')) };
  }
  async listJobs({ line = null, dateKey = null, status = null, q = null, from = null, to = null, limit = 200 } = {}) {
    if (!line) return [];
    const jt = this._t(line, 'job');
    const w = []; const p = [];
    const tcol = 'COALESCE(register_at, load_at, enter_at, created_at)';
    if (dateKey) { p.push(dateKey); w.push('date_key=?'); }
    if (status) { p.push(status); w.push('status=?'); }
    if (from != null) { p.push(from); w.push(`${tcol} >= ?`); }
    if (to != null) { p.push(to); w.push(`${tcol} <= ?`); }
    if (q) { const like = '%' + q + '%'; p.push(like, like, like); w.push('(carrier LIKE ? OR job_key LIKE ? OR header LIKE ?)'); }
    p.push(limit);
    const sql = `SELECT * FROM ${jt} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${tcol} DESC LIMIT ?`;
    return this.db.prepare(sql).all(...p).map((j) => ({ ...this._mapJob(j), steps: this._steps(JSON.parse(j.steps || '{}')) }));
  }
  async getSteps(jobKey) {
    const j = this.db.prepare(`SELECT steps FROM ${this._t(this._lineOf(jobKey), 'job')} WHERE job_key=?`).get(jobKey);
    return j ? this._steps(JSON.parse(j.steps || '{}')) : [];
  }
  async listEvents({ line = null, limit = 200 } = {}) {
    if (!line) return [];
    return this.db.prepare(`SELECT * FROM ${this._t(line, 'event')} ORDER BY event_id DESC LIMIT ?`).all(limit)
      .map((r) => { let d = {}; try { d = JSON.parse(r.data || '{}'); } catch (_) {} return { ...r, data: d }; });
  }

  // flat view ต่อไลน์ — กาง steps JSON เป็นคอลัมน์ s<station>_<param> ด้วย json_extract
  _flatViewSql(line, cfg) {
    const sid = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
    const jp = (s) => String(s).replace(/"/g, '""');   // escape สำหรับ quoted JSON path
    const view = this._view(line);
    const stations = cfg.stations || {};
    const stepFields = (cfg.fields || []).filter((f) => f.scope !== 'job');
    const jobFields = (cfg.fields || []).filter((f) => f.scope === 'job');
    const stationList = Object.keys(stations).sort((a, b) => ((stations[a].seq || 0) - (stations[b].seq || 0)));
    const cols = ['job_key', 'line', 'date_key', 'lane', 'carrier', 'run', 'set_id', 'status', 'gap', 'register_at', 'load_at', 'exit_at'];
    for (const f of jobFields) cols.push(`json_extract(header,'$."${jp(f.key)}"') AS h_${sid(f.key)}`);
    for (const st of stationList) {
      const pfx = 's' + sid(st);
      cols.push(`CAST(json_extract(steps,'$."${jp(st)}"."enterTs"') AS INTEGER) AS ${pfx}_in`);
      cols.push(`CAST(json_extract(steps,'$."${jp(st)}"."exitTs"') AS INTEGER) AS ${pfx}_out`);
      cols.push(`CAST(json_extract(steps,'$."${jp(st)}"."dwell"') AS REAL) AS ${pfx}_dwell`);
      cols.push(`json_extract(steps,'$."${jp(st)}"."inSpec"') AS ${pfx}_ok`);
      for (const f of stepFields) {
        const expr = `json_extract(steps,'$."${jp(st)}"."params"."${jp(f.key)}"')`;
        const isNum = !(f.type && f.type !== 'number');
        cols.push(`${isNum ? `CAST(${expr} AS REAL)` : expr} AS ${pfx}_${sid(f.key)}`);
      }
    }
    return `DROP VIEW IF EXISTS ${view}; CREATE VIEW ${view} AS SELECT\n  ${cols.join(',\n  ')}\nFROM ${this._t(line, 'job')};`;
  }
  async ensureFlatView(line, cfg) {
    if (!cfg) return null;
    this.db.exec(this._flatViewSql(line, cfg));
    return this._view(line);
  }

  // reset — archive (copy เป็น <kind>_<ts>) + ล้างตัวจริง · lock ไม่แตะ
  async resetLine(line, stamp) {
    const ts = String(stamp || Date.now()).replace(/[^0-9A-Za-z_]/g, '_');
    const j = this._t(line, 'job'), e = this._t(line, 'event'), r = this._t(line, 'register');
    this.db.exec(`
      CREATE TABLE ${j}_${ts} AS SELECT * FROM ${j};
      CREATE TABLE ${e}_${ts} AS SELECT * FROM ${e};
      CREATE TABLE ${r}_${ts} AS SELECT * FROM ${r};
      DELETE FROM ${j};
      DELETE FROM ${e};
      DELETE FROM sqlite_sequence WHERE name='${e}';
      DELETE FROM ${r};`);
    return ts;
  }

  // register
  async saveRegister(line, state) {
    this.db.prepare(`INSERT INTO ${this._t(line, 'register')} (line,state,updated_at) VALUES (?,?,?)
      ON CONFLICT(line) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
      .run(line, JSON.stringify(state || {}), Date.now());
  }
  async loadRegister(line) {
    const r = this.db.prepare(`SELECT state FROM ${this._t(line, 'register')} WHERE line=?`).get(line);
    if (!r) return null;
    try { return JSON.parse(r.state || '{}'); } catch (_) { return null; }
  }

  // ── Recorder lease lock (HA · 1 owner/line) — เครื่องเดียวกัน (recorder+viewer share file) → ใช้ Date.now() ได้ (ไม่มี clock-skew) ──
  async claimLock(line, owner, label) {
    const t = this._t(line, 'lock'); const now = Date.now();
    this.db.prepare(`INSERT INTO ${t} (line,owner,label,heartbeat_ms,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(line) DO UPDATE SET owner=excluded.owner, label=excluded.label, heartbeat_ms=excluded.heartbeat_ms, updated_at=excluded.updated_at
      WHERE ${t}.owner=excluded.owner OR ${t}.owner IS NULL`).run(line, owner, label, now, now);
    const r = this.db.prepare(`SELECT owner FROM ${t} WHERE line=?`).get(line);
    return !!(r && r.owner === owner);
  }
  async forceLock(line, owner, label) {
    const t = this._t(line, 'lock'); const now = Date.now();
    this.db.prepare(`INSERT INTO ${t} (line,owner,label,heartbeat_ms,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(line) DO UPDATE SET owner=excluded.owner, label=excluded.label, heartbeat_ms=excluded.heartbeat_ms, updated_at=excluded.updated_at`)
      .run(line, owner, label, now, now);
    return true;
  }
  async releaseLock(line, owner) {
    this.db.prepare(`UPDATE ${this._t(line, 'lock')} SET owner=NULL, updated_at=? WHERE line=? AND owner=?`).run(Date.now(), line, owner);
    return true;
  }
  async getLock(line) {
    const r = this.db.prepare(`SELECT line, owner, label, heartbeat_ms FROM ${this._t(line, 'lock')} WHERE line=?`).get(line);
    return r ? { ...r, now_ms: Date.now() } : null;
  }

  async stop() { try { this.db.close(); } catch (_) {} }
}

module.exports = SqliteStore;
