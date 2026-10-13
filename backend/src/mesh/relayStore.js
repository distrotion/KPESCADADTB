'use strict';
// SQL for the relay (T8). Two small tables in the station's own local database (a NEW table each,
// nothing existing is altered):
//   mesh_relay_in   rows another station handed to us to forward (we are the relay)
//   mesh_relay_out  record_ids we already handed to a relay, so we do not resend them every few seconds
// The store talks to any database through `db = { all(sql, params), run(sql, params) }` (both async),
// so tests use a temp sqlite file, the Pi uses the SCADA database manager, and nothing here knows which.
// SQL is portable sqlite; every value is a bound parameter.
const IN = 'mesh_relay_in';
const OUT = 'mesh_relay_out';

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${IN} (
     record_id TEXT PRIMARY KEY, origin TEXT NOT NULL, station TEXT NOT NULL, weig TEXT NOT NULL, code TEXT, reason TEXT,
     received_ms INTEGER NOT NULL, forwarded_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_try_ms INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_${IN}_pending ON ${IN}(forwarded_ms, next_try_ms)`,
  `CREATE TABLE IF NOT EXISTS ${OUT} (record_id TEXT PRIMARY KEY, relay TEXT NOT NULL, handed_ms INTEGER NOT NULL)`,
];

class RelayStore {
  constructor(db) { this.db = db; this.ready = false; }

  async init() {
    if (this.ready) return;
    for (const sql of DDL) await this.db.run(sql, []);
    this.ready = true;
  }

  // relay side: keep a row for forwarding. Idempotent: the same record_id twice is stored once.
  async addIncoming({ origin, row }, nowMs) {
    await this.init();
    const before = await this.db.all(`SELECT record_id FROM ${IN} WHERE record_id = ?`, [row.recordId]);
    if (before.length) return { stored: false, duplicate: true };
    await this.db.run(`INSERT OR IGNORE INTO ${IN} (record_id, origin, station, weig, code, reason, received_ms) VALUES (?,?,?,?,?,?,?)`,
      [row.recordId, origin, row.station, row.weig, row.code || '', row.reason || '', nowMs]);
    return { stored: true, duplicate: false };
  }

  async pendingIncoming(nowMs, limit = 10) {
    await this.init();
    return this.db.all(`SELECT record_id AS recordId, origin, station, weig, code, reason, attempts FROM ${IN}
                         WHERE forwarded_ms IS NULL AND next_try_ms <= ? ORDER BY received_ms LIMIT ?`, [nowMs, limit]);
  }

  async markForwarded(recordId, nowMs) {
    await this.db.run(`UPDATE ${IN} SET forwarded_ms = ?, last_error = NULL WHERE record_id = ?`, [nowMs, recordId]);
  }

  // failed forward: try again later, waiting longer each time (5 s, 10 s ... capped at 5 min)
  async markFailed(recordId, error, nowMs) {
    const r = await this.db.all(`SELECT attempts FROM ${IN} WHERE record_id = ?`, [recordId]);
    const attempts = (r[0] ? r[0].attempts : 0) + 1;
    const wait = Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6));
    await this.db.run(`UPDATE ${IN} SET attempts = ?, last_error = ?, next_try_ms = ? WHERE record_id = ?`, [attempts, String(error).slice(0, 200), nowMs + wait, recordId]);
    return { attempts, waitMs: wait };
  }

  async counts() {
    await this.init();
    const a = await this.db.all(`SELECT COUNT(*) AS n, SUM(CASE WHEN forwarded_ms IS NULL THEN 1 ELSE 0 END) AS pending FROM ${IN}`, []);
    const b = await this.db.all(`SELECT COUNT(*) AS n FROM ${OUT}`, []);
    return { inbox: a[0].n || 0, inboxPending: a[0].pending || 0, handedOut: b[0].n || 0 };
  }

  // origin side
  async markHandedOut(recordId, relay, nowMs) {
    await this.init();
    await this.db.run(`INSERT OR IGNORE INTO ${OUT} (record_id, relay, handed_ms) VALUES (?,?,?)`, [recordId, relay, nowMs]);
  }
  async handedOutIds(ids) {
    await this.init();
    if (!ids.length) return new Set();
    const q = ids.map(() => '?').join(',');
    return new Set((await this.db.all(`SELECT record_id FROM ${OUT} WHERE record_id IN (${q})`, ids)).map((r) => r.record_id));
  }

  // housekeeping: forwarded rows and hand-off records older than `keepMs` go
  async prune(nowMs, keepMs = 7 * 24 * 3600 * 1000) {
    await this.init();
    await this.db.run(`DELETE FROM ${IN} WHERE forwarded_ms IS NOT NULL AND forwarded_ms < ?`, [nowMs - keepMs]);
    await this.db.run(`DELETE FROM ${OUT} WHERE handed_ms < ?`, [nowMs - keepMs]);
  }
}

module.exports = { RelayStore, IN, OUT };
