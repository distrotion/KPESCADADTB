// sqlStore.js — LineStore adapter (SQL · MVP=PostgreSQL) · DB-only · ตาราง "แยกต่อไลน์"
//   ต่อไลน์: lr_<line>_event (append-only) · lr_<line>_job (1 row/job · steps jsonb) ·
//            lr_<line>_register (occupancy/register สด) · lr_<line>_lock (recorder lease) · view lr_<line>_flat
//   reset: archive (copy เป็น lr_<line>_<kind>_<ts>) แล้ว truncate ตัวจริง → เริ่มข้อมูลใหม่ (lock ไม่แตะ)
//   conn: { host, port, user, password, database } หรือ connectionString
const { Pool } = require('pg');

function r6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

class SqlStore {
  constructor({ dialect = 'pg', conn, connectionString } = {}) {
    if (dialect !== 'pg') throw new Error(`[lineStore/sql] dialect "${dialect}" ยังไม่รองรับ (MVP=pg)`);
    this.pool = new Pool(connectionString ? { connectionString } : (conn || {}));
    this._ensured = new Map();   // line → Promise (ensureSchema ครั้งเดียวต่อไลน์)
  }

  _sid(line) { return String(line).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(); }
  _t(line, kind) { return `lr_${this._sid(line)}_${kind}`; }     // kind: job|event|register|lock
  _view(line) { return `lr_${this._sid(line)}_flat`; }
  _lineOf(jobKey) { const s = String(jobKey || ''); const i = s.indexOf('|'); return i >= 0 ? s.slice(0, i) : s; }

  _ddl(line) {
    const j = this._t(line, 'job'), e = this._t(line, 'event'), r = this._t(line, 'register'), l = this._t(line, 'lock');
    return `
CREATE TABLE IF NOT EXISTS ${e} (event_id bigserial PRIMARY KEY, line text, job_key text, type text,
  carrier text, lane text, station text, ts bigint, data jsonb);
CREATE TABLE IF NOT EXISTS ${j} (job_key text PRIMARY KEY, line text, date_key text, lane text, carrier text, run text, set_id text,
  status text, gap boolean DEFAULT false, enter_at bigint, register_at bigint, load_at bigint, exit_at bigint,
  header jsonb DEFAULT '{}'::jsonb, steps jsonb DEFAULT '{}'::jsonb, created_at bigint, updated_at bigint);
CREATE TABLE IF NOT EXISTS ${r} (line text PRIMARY KEY, state jsonb, updated_at bigint);
CREATE TABLE IF NOT EXISTS ${l} (line text PRIMARY KEY, owner text, label text, heartbeat_ms bigint, updated_at bigint);
CREATE INDEX IF NOT EXISTS ${j}_dt ON ${j}(date_key);
CREATE INDEX IF NOT EXISTS ${e}_tsx ON ${e}(ts);
`;
  }

  async ensureSchema(line) {
    if (!line) return true;   // ต้องระบุ line (per-line tables) · เรียกแบบไม่มี line = noop (compat)
    if (this._ensured.has(line)) return this._ensured.get(line);
    const p = (async () => {
      try { await this.pool.query(this._ddl(line)); }
      catch (e) { if (!['23505', '42P07', '42P06', '42710'].includes(e.code)) { this._ensured.delete(line); throw e; } }
      return true;
    })();
    this._ensured.set(line, p);
    return p;
  }

  // 1) append event = source of truth (เขียนก่อนเสมอ)
  async appendEvent(ev) {
    await this.pool.query(
      `INSERT INTO ${this._t(ev.line, 'event')} (line, job_key, type, carrier, lane, station, ts, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.line, ev.jobKey, ev.type, ev.carrier, ev.lane, ev.station, ev.ts,
       JSON.stringify({ enterTs: ev.enterTs, exitTs: ev.exitTs, dwell: ev.dwell, values: ev.values, gap: ev.gap, run: ev.run })]);
  }

  // 2) upsert job = 1 row/job · header (barcode) merge · gap sticky
  async upsertJob(job) {
    const ts = job.ts || Date.now();
    const { rows } = await this.pool.query(
      `INSERT INTO ${this._t(job.line, 'job')} (job_key,line,date_key,lane,carrier,run,set_id,status,gap,enter_at,register_at,load_at,exit_at,header,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       ON CONFLICT (job_key) DO UPDATE SET
         status=COALESCE(EXCLUDED.status, ${this._t(job.line, 'job')}.status),
         enter_at=COALESCE(EXCLUDED.enter_at, ${this._t(job.line, 'job')}.enter_at),
         register_at=COALESCE(EXCLUDED.register_at, ${this._t(job.line, 'job')}.register_at),
         load_at=COALESCE(EXCLUDED.load_at, ${this._t(job.line, 'job')}.load_at),
         exit_at=COALESCE(EXCLUDED.exit_at, ${this._t(job.line, 'job')}.exit_at),
         gap=${this._t(job.line, 'job')}.gap OR EXCLUDED.gap,
         set_id=COALESCE(EXCLUDED.set_id, ${this._t(job.line, 'job')}.set_id),
         header=${this._t(job.line, 'job')}.header || EXCLUDED.header,
         updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [job.jobKey, job.line, job.dateKey, job.lane, job.carrier, job.run != null ? String(job.run) : null,
       job.set != null ? String(job.set) : null,
       job.status || null, !!job.gap, job.enterAt != null ? job.enterAt : null,
       job.registerAt != null ? job.registerAt : null, job.loadAt != null ? job.loadAt : null,
       job.exitAt != null ? job.exitAt : null,
       JSON.stringify(job.data || {}), ts]);
    return this._mapJob(rows[0]);
  }

  // 3) step → merge เข้า <job>.steps[station]
  async upsertStep(jobKey, step) {
    const line = this._lineOf(jobKey);
    const station = String(step.station);
    const dwell = (step.dwell != null) ? r6(step.dwell)
      : ((step.enterTs != null && step.exitTs != null) ? Math.round((step.exitTs - step.enterTs) / 1000) : null);
    const obj = {
      name: step.name || '', seq: step.seq != null ? step.seq : null, type: step.type || '',
      enterTs: step.enterTs != null ? step.enterTs : null, exitTs: step.exitTs != null ? step.exitTs : null, dwell,
      params: step.params || {}, inSpec: step.inSpec != null ? step.inSpec : null, ts: step.ts || Date.now(),
    };
    const { rows } = await this.pool.query(
      `UPDATE ${this._t(line, 'job')}
         SET steps = jsonb_set(COALESCE(steps,'{}'::jsonb), ARRAY[$2::text],
               (COALESCE(steps->$2, '{}'::jsonb) || $3::jsonb), true),
             updated_at = $4
       WHERE job_key = $1
       RETURNING steps`,
      [jobKey, station, JSON.stringify(obj), Date.now()]);
    return rows[0] ? { station, ...obj } : null;
  }

  _mapJob(j) {
    if (!j) return null;
    return {
      ...j, jobKey: j.job_key, dateKey: j.date_key, enterAt: j.enter_at, exitAt: j.exit_at,
      registerAt: j.register_at, loadAt: j.load_at,
      createdAt: j.created_at, updatedAt: j.updated_at, data: j.header || {}, set: j.set_id,
    };
  }
  _steps(stepsObj) {
    return Object.entries(stepsObj || {}).map(([station, s]) => ({ station, ...s }))
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }

  async getJob(jobKey) {
    const line = this._lineOf(jobKey);
    const j = (await this.pool.query(`SELECT * FROM ${this._t(line, 'job')} WHERE job_key=$1`, [jobKey])).rows[0];
    if (!j) return null;
    return { ...this._mapJob(j), steps: this._steps(j.steps) };
  }
  async listJobs({ line = null, dateKey = null, status = null, q = null, from = null, to = null, limit = 200 } = {}) {
    if (!line) return [];   // ตาราง per-line ต้องระบุ line
    const w = []; const p = [];
    const tcol = 'COALESCE(register_at, load_at, enter_at, created_at)';
    if (dateKey) { p.push(dateKey); w.push(`date_key=$${p.length}`); }
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (from != null) { p.push(from); w.push(`${tcol} >= $${p.length}`); }
    if (to != null) { p.push(to); w.push(`${tcol} <= $${p.length}`); }
    if (q) { p.push('%' + q + '%'); w.push(`(carrier ILIKE $${p.length} OR job_key ILIKE $${p.length} OR header::text ILIKE $${p.length})`); }
    p.push(limit);
    const sql = `SELECT job_key,line,date_key,lane,carrier,run,set_id,status,gap,enter_at,register_at,load_at,exit_at,header,steps,created_at,updated_at
                 FROM ${this._t(line, 'job')} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
                 ORDER BY ${tcol} DESC LIMIT $${p.length}`;
    return (await this.pool.query(sql, p)).rows.map((j) => ({ ...this._mapJob(j), steps: this._steps(j.steps) }));
  }
  async getSteps(jobKey) {
    const line = this._lineOf(jobKey);
    const j = (await this.pool.query(`SELECT steps FROM ${this._t(line, 'job')} WHERE job_key=$1`, [jobKey])).rows[0];
    return j ? this._steps(j.steps) : [];
  }
  async listEvents({ line = null, limit = 200 } = {}) {
    if (!line) return [];
    return (await this.pool.query(`SELECT * FROM ${this._t(line, 'event')} ORDER BY event_id DESC LIMIT $1`, [limit])).rows;
  }

  // flat view ต่อไลน์ — กาง steps jsonb เป็นคอลัมน์ s<station>_<param>
  _flatViewSql(line, cfg) {
    const sid = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
    const lit = (s) => String(s).replace(/'/g, "''");
    const view = this._view(line);
    const stations = cfg.stations || {};
    const stepFields = (cfg.fields || []).filter((f) => f.scope !== 'job');
    const jobFields = (cfg.fields || []).filter((f) => f.scope === 'job');
    const stationList = Object.keys(stations).sort((a, b) => ((stations[a].seq || 0) - (stations[b].seq || 0)));
    const cols = ['job_key', 'line', 'date_key', 'lane', 'carrier', 'run', 'set_id', 'status', 'gap', 'register_at', 'load_at', 'exit_at'];
    for (const f of jobFields) cols.push(`header->>'${lit(f.key)}' AS h_${sid(f.key)}`);
    for (const st of stationList) {
      const p = 's' + sid(st);
      cols.push(`(steps->'${lit(st)}'->>'enterTs')::bigint AS ${p}_in`);
      cols.push(`(steps->'${lit(st)}'->>'exitTs')::bigint AS ${p}_out`);
      cols.push(`(steps->'${lit(st)}'->>'dwell')::double precision AS ${p}_dwell`);
      cols.push(`(steps->'${lit(st)}'->>'inSpec')::boolean AS ${p}_ok`);
      for (const f of stepFields) {
        const cast = (f.type && f.type !== 'number') ? '' : '::numeric';
        cols.push(`(steps->'${lit(st)}'->'params'->>'${lit(f.key)}')${cast} AS ${p}_${sid(f.key)}`);
      }
    }
    return `DROP VIEW IF EXISTS ${view}; CREATE VIEW ${view} AS SELECT\n  ${cols.join(',\n  ')}\nFROM ${this._t(line, 'job')};`;
  }
  async ensureFlatView(line, cfg) {
    if (!cfg) return null;
    await this.pool.query(this._flatViewSql(line, cfg));
    return this._view(line);
  }

  // reset — archive (copy เป็น <kind>_<ts>) แล้ว truncate ตัวจริง · lock ไม่แตะ (owner คงเดิม)
  async resetLine(line, stamp) {
    const ts = String(stamp || Date.now()).replace(/[^0-9A-Za-z_]/g, '_');
    const j = this._t(line, 'job'), e = this._t(line, 'event'), r = this._t(line, 'register');
    await this.pool.query(`
      CREATE TABLE ${j}_${ts} AS TABLE ${j};
      CREATE TABLE ${e}_${ts} AS TABLE ${e};
      CREATE TABLE ${r}_${ts} AS TABLE ${r};
      TRUNCATE ${j};
      TRUNCATE ${e} RESTART IDENTITY;
      TRUNCATE ${r};
    `);
    return ts;
  }

  // register
  async saveRegister(line, state) {
    await this.pool.query(
      `INSERT INTO ${this._t(line, 'register')} (line, state, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (line) DO UPDATE SET state=EXCLUDED.state, updated_at=EXCLUDED.updated_at`,
      [line, JSON.stringify(state || {}), Date.now()]);
  }
  async loadRegister(line) {
    const r = (await this.pool.query(`SELECT state FROM ${this._t(line, 'register')} WHERE line=$1`, [line])).rows[0];
    return r ? r.state : null;
  }

  // ── Recorder lease lock (HA · 1 owner/line · ตาราง per-line) — เทียบเวลาด้วย now() ของ DB ──
  async claimLock(line, owner, label) {
    const t = this._t(line, 'lock');
    const { rows } = await this.pool.query(
      `INSERT INTO ${t} (line, owner, label, heartbeat_ms, updated_at)
       VALUES ($1,$2,$3,(extract(epoch from now())*1000)::bigint,(extract(epoch from now())*1000)::bigint)
       ON CONFLICT (line) DO UPDATE SET owner=$2, label=$3,
         heartbeat_ms=(extract(epoch from now())*1000)::bigint, updated_at=(extract(epoch from now())*1000)::bigint
       WHERE ${t}.owner = $2 OR ${t}.owner IS NULL
       RETURNING owner`, [line, owner, label]);
    return rows.length > 0 && rows[0].owner === owner;
  }
  async forceLock(line, owner, label) {
    const t = this._t(line, 'lock');
    await this.pool.query(
      `INSERT INTO ${t} (line, owner, label, heartbeat_ms, updated_at)
       VALUES ($1,$2,$3,(extract(epoch from now())*1000)::bigint,(extract(epoch from now())*1000)::bigint)
       ON CONFLICT (line) DO UPDATE SET owner=$2, label=$3,
         heartbeat_ms=(extract(epoch from now())*1000)::bigint, updated_at=(extract(epoch from now())*1000)::bigint`,
      [line, owner, label]);
    return true;
  }
  async releaseLock(line, owner) {
    await this.pool.query(`UPDATE ${this._t(line, 'lock')} SET owner=NULL, updated_at=(extract(epoch from now())*1000)::bigint WHERE line=$1 AND owner=$2`, [line, owner]);
    return true;
  }
  async getLock(line) {
    const r = (await this.pool.query(
      `SELECT line, owner, label, heartbeat_ms, (extract(epoch from now())*1000)::bigint AS now_ms FROM ${this._t(line, 'lock')} WHERE line=$1`, [line])).rows[0];
    return r || null;
  }

  async stop() { try { await this.pool.end(); } catch (_) {} }
}

module.exports = SqlStore;
