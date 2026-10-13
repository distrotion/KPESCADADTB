'use strict';
// Glue between the mesh node and the station's own databases (kept free of config-file code so the bench harness can use it on its own).
// numbers the beacon reports about this station, read from its own database (optional; unknown when not configured)
function makeStatsReader({ dbManager, getConfig }) {
  return async function readStats() {
    const st = ((getConfig() || {}).node || {}).stats || {};
    if (!dbManager || !st.db || (!st.unsentSql && !st.lastRecordSql)) return null;
    const first = (rows) => { const r = Array.isArray(rows) && rows[0]; if (!r || typeof r !== 'object') return null; const k = Object.keys(r)[0]; return k == null ? null : r[k]; };
    const out = {};
    if (st.unsentSql) { const v = Number(first(await dbManager.query(st.db, st.unsentSql, []))); out.unsent = Number.isFinite(v) ? v : null; }
    if (st.lastRecordSql) out.lastRecordTs = first(await dbManager.query(st.db, st.lastRecordSql, []));
    return out;
  };
}

// Relay wiring (T8): tables + source query + sink are all read from mesh.json at the moment they are used.
function makeRelayFactory({ dbManager, getConfig }) {
  const { RelayStore } = require('./relayStore');
  const { MeshRelay, makeSqlSink, safeIdent } = require('./meshRelay');
  const relayCfg = () => (((getConfig() || {}).node || {}).relay) || {};
  const storeDb = () => { const r = relayCfg(); return (r.store && r.store.db) || (r.source && r.source.db) || ''; };
  const q = (dbName) => (sql, params) => {
    if (!dbManager || !dbName) return Promise.reject(new Error('relay database is not configured'));
    return dbManager.query(dbName, sql, params);
  };
  return function relayFactory({ table, helper, now, isOffline, timeAnswer, log }) {
    const store = new RelayStore({ all: (sql, p) => q(storeDb())(sql, p), run: (sql, p) => q(storeDb())(sql, p) });
    const readSource = async (limit, afterId = 0) => {
      const src = relayCfg().source || {};
      const t = safeIdent(src.table || 'kubotalog_backup', 'relay.source.table');
      return q(src.db)(`SELECT id, ts, station, weig, code, record_id, note FROM ${t} WHERE sent = 0 AND etc IS NULL AND record_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?`, [Number(afterId) > 0 ? Number(afterId) : 0, Math.max(1, Math.min(200, limit | 0))]);
    };
    let sinkKey = ''; let sink = null;
    const sinkProxy = { insert: async (row) => {
      const sc = relayCfg().sink || {};
      const key = JSON.stringify([sc.type, sc.db, sc.dialect, sc.table]);
      if (key !== sinkKey) { sink = sc.type === 'sql' ? makeSqlSink({ query: q(sc.db), dialect: sc.dialect === 'sqlite' ? 'sqlite' : 'mssql', table: sc.table }) : null; sinkKey = key; }
      if (!sink) return { ok: false, error: 'no sink configured' };
      return sink.insert(row);
    } };
    return new MeshRelay({ getConfig, now, table, store, helper, readSource, sink: sinkProxy, isOffline, timeAnswer, log });
  };
}


// The restart counter a station puts in its beacons: +1 on every start, kept in a small file, so neighbours can tell a real restart (forward)
// from a replayed old packet. No file / unreadable / unwritable = a random value (works, just without the protection against replay).
function makeBootStore(file) {
  const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
  return {
    next() {
      let n; try { n = Number(JSON.parse(fs.readFileSync(file, 'utf8')).boot); } catch (_) { n = NaN; }
      n = Number.isInteger(n) && n >= 0 && n <= 255 ? (n + 1) & 0xFF : crypto.randomBytes(1)[0];
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ boot: n })); fs.renameSync(tmp, file); }
      catch (e) { throw new Error('cannot write ' + file + ': ' + e.message); }
      return n;
    },
  };
}

module.exports = { makeStatsReader, makeRelayFactory, makeBootStore };
