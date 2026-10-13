'use strict';
// Datalog storage settings + sqlite rollover (task #497 · .34 froze 2026-10-13 on a 6.9 GB linerec.sqlite).
//
// With rollover on, chartStore rows of a sqlite connection go to files next to the connection's own file:
//   <file without extension>.datalog/YYYY-MM.r<days>.sqlite   then  YYYY-MM.r<days>_02.sqlite ... once a part reaches maxMB
// * rows are routed by THEIR timestamp's month (UTC): a read opens only the months its window overlaps (+ the main file, which keeps what
//   was written before rollover - it is never moved or renamed, other modules may keep their own tables in it)
// * files are grouped by the retention of the log that wrote them (r0 = keep forever, also used by chart widgets without retention):
//   a whole file is deleted once its month is entirely past that retention - no DELETE over big tables, and a log that keeps its data
//   forever never pins the files of the others. Rows stay at most one month longer than retentionDays.
// Reads keep finding existing files after rollover is switched off; only new writes go back to the main file.
const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const dbHelper = require('./dbHelper');

const DEFAULTS = { rollover: { enabled: true, maxMB: 512 }, warnMB: 1024 };
const SEG_RE = /^(\d{4})-(\d{2})\.r(\d{1,5})(?:_(\d{2,3}))?\.sqlite$/;
const LIST_TTL_MS = 5000;
const SIZE_TTL_MS = 30000;
const IDLE_CLOSE_MS = 10 * 60000;

const pad2 = (n) => String(n).padStart(2, '0');
function monthKey(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; }
function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}
const retentionKey = (days) => Math.max(0, Math.min(99999, Math.round(Number(days) || 0)));

function normConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ro = r.rollover && typeof r.rollover === 'object' ? r.rollover : {};
  const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def; };
  return {
    rollover: { enabled: ro.enabled !== false, maxMB: num(ro.maxMB, 16, 8192, DEFAULTS.rollover.maxMB) },
    warnMB: num(r.warnMB, 16, 1000000, DEFAULTS.warnMB),
  };
}

class DatalogStorage {
  constructor({ dbManager, now = Date.now, configPath = null, log = console.log } = {}) {
    this.dbManager = dbManager;
    this.now = now;
    this.log = log;
    this.configPath = configPath || csv.resolveConfig('datalog-storage.json', null);
    this._cfg = null;
    this._lists = new Map();     // segment dir -> { at, segs }
    this._sizes = new Map();     // file -> { at, bytes }
    this._used = new Map();      // segment file -> last use (ms)
    this._current = new Map();   // `${main}|r<days>` -> current write file
  }

  // ── settings (config/datalog-storage.json) ───────────────────────────────────────
  config() {
    if (!this._cfg) {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (_) { raw = null; }
      this._cfg = normConfig(raw);
    }
    return this._cfg;
  }
  save(patch) {
    const cur = this.config();
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = normConfig({ ...cur, ...p, rollover: { ...cur.rollover, ...(p.rollover || {}) } });
    csv.writeJsonAtomic(this.configPath, next);
    this._cfg = next;
    return next;
  }

  // ── paths ───────────────────────────────────────────────────────────────────────────
  _resolve(conn) {
    try { const c = this.dbManager.resolve(conn); return c && String(c.type || '').toLowerCase() === 'sqlite' ? c : null; } catch (_) { return null; }
  }
  mainPath(conn) { const c = this._resolve(conn); return c ? dbHelper.sqlitePath(c) : null; }
  segDir(main) { return main.replace(/\.(sqlite3?|db3?)$/i, '') + '.datalog'; }
  segConn(file) { return { id: `seg:${file}`, name: path.basename(file), type: 'sqlite', path: file }; }

  // writes go to segment files (rollover on, sqlite connection)
  writesRolled(conn) { return this.config().rollover.enabled && !!this.mainPath(conn); }
  // reads look at segment files whenever some exist (also after rollover was switched off)
  readsRolled(conn) { const m = this.mainPath(conn); return !!m && (this.config().rollover.enabled || this.segments(m).length > 0); }

  // segment files of one main file, oldest month first: [{ file, month, days, part, start, end }]
  segments(main, { fresh = false } = {}) {
    const dir = this.segDir(main);
    const c = this._lists.get(dir);
    const t = this.now();
    if (!fresh && c && t - c.at < LIST_TTL_MS) return c.segs;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    const segs = [];
    for (const n of names) {
      const m = SEG_RE.exec(n);
      if (!m) continue;
      const month = `${m[1]}-${m[2]}`;
      const b = monthBounds(month);
      segs.push({ file: path.join(dir, n), name: n, month, days: Number(m[3]), part: m[4] ? Number(m[4]) : 1, start: b.start, end: b.end });
    }
    segs.sort((a, b) => a.start - b.start || a.days - b.days || a.part - b.part);
    this._lists.set(dir, { at: t, segs });
    return segs;
  }

  _bytes(file) {
    const c = this._sizes.get(file); const t = this.now();
    if (c && t - c.at < SIZE_TTL_MS) return c.bytes;
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch (_) { bytes = 0; }
    this._sizes.set(file, { at: t, bytes });
    return bytes;
  }

  // the file a row with timestamp tsMs of a log with this retention goes to (a new part once the last one reached maxMB)
  writeTarget(conn, tsMs, retentionDays) {
    const main = this.mainPath(conn);
    if (!main) return null;
    const month = monthKey(tsMs); const days = retentionKey(retentionDays);
    const parts = this.segments(main).filter((s) => s.month === month && s.days === days);
    const last = parts[parts.length - 1];
    const maxBytes = this.config().rollover.maxMB * 1024 * 1024;
    let file;
    if (last && this._bytes(last.file) < maxBytes) file = last.file;
    else {
      const part = last ? last.part + 1 : 1;
      file = path.join(this.segDir(main), `${month}.r${days}${part > 1 ? '_' + pad2(part) : ''}.sqlite`);
      this._lists.delete(this.segDir(main));            // the listing must show the new part
      if (last) this.log(`[datalog] ${path.basename(last.file)} reached ${this.config().rollover.maxMB} MB → ${path.basename(file)}`);
    }
    this._used.set(file, this.now());
    if (month === monthKey(this.now())) this._current.set(`${main}|r${days}`, file);
    return this.segConn(file);
  }

  // where rows of [fromMs, untilMs] can be: the main file first (rows from before rollover), then the overlapping month files
  readTargets(conn, fromMs, untilMs) {
    const main = this.mainPath(conn);
    if (!main) return [conn];
    const until = untilMs || this.now();
    const out = [conn];
    for (const s of this.segments(main)) {
      if (s.end <= fromMs || s.start > until) continue;
      this._used.set(s.file, this.now());
      out.push(this.segConn(s.file));
    }
    return out;
  }

  // delete every file whose month is entirely past its retention (r0 = never) · returns the names deleted
  sweep(conn) {
    const main = this.mainPath(conn);
    if (!main) return [];
    const t = this.now(); const gone = [];
    for (const s of this.segments(main, { fresh: true })) {
      if (!s.days || s.end > t - s.days * 86400000) continue;
      dbHelper.sqliteClose(s.file);                      // Windows cannot delete an open file
      let ok = true;
      for (const f of [s.file, `${s.file}-wal`, `${s.file}-shm`, `${s.file}-journal`]) {
        try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') { ok = false; this.log(`[datalog] cannot delete ${path.basename(f)}: ${e.code || e.message}`); } }
      }
      if (ok) { gone.push(s.name); this._sizes.delete(s.file); this._used.delete(s.file); }
    }
    if (gone.length) { this._lists.delete(this.segDir(main)); this.log(`[datalog] retention: deleted ${gone.join(', ')}`); }
    return gone;
  }

  // close handles of files nobody wrote or read for a while (the current write files stay open)
  closeIdle() {
    const t = this.now(); const current = new Set(this._current.values()); let n = 0;
    for (const [file, at] of this._used) {
      if (current.has(file) || t - at < IDLE_CLOSE_MS) continue;
      if (dbHelper.sqliteClose(file)) n++;
      this._used.delete(file);
    }
    return n;
  }

  // sizes for the status API, tags and the size alarm
  status(conn) {
    const main = this.mainPath(conn);
    if (!main) return null;
    const mb = (b) => Math.round((b / 1048576) * 10) / 10;
    const segs = this.segments(main);
    let total = 0; let largest = 0;
    const files = segs.map((s) => { const b = this._bytes(s.file); total += b; largest = Math.max(largest, b); return { name: s.name, mb: mb(b) }; });
    const cfg = this.config();
    return { mainFile: main, mainMB: mb(this._bytes(main)), rollover: cfg.rollover.enabled, maxMB: cfg.rollover.maxMB, warnMB: cfg.warnMB,
      segmentDir: this.segDir(main), segments: files.length, segmentsMB: mb(total), largestSegmentMB: mb(largest), files };
  }
}

// ── size monitor: MESH-style managed device DATALOG_STORE + a "file too big" alarm per sqlite connection used by datalogs ──
//   tags <conn>_main_mb (the connection's own file) · <conn>_seg_mb / <conn>_seg_count (rollover files)
//   alarm dlstore_main_<conn> when the main file passes warnMB (with rollover off it is where the datalogs grow; with it on, other modules)
const tagId = (x) => String(x).replace(/[^A-Za-z0-9_]/g, '_');
function makeStorageTick({ storage, datalogManager, engine, alarmEngine, log = () => {} }) {
  const warned = new Set();
  return function tick() {
    const conns = [...new Set(datalogManager.logs.filter((l) => l.storage === 'database' && l.dbConn).map((l) => l.dbConn))];
    const out = {};
    for (const c of conns) { const st = storage.status(c); if (st) out[c] = st; }
    const ids = Object.keys(out);
    if (!ids.length) return out;
    if (engine) {
      const tags = [];
      for (const c of ids) {
        const t = tagId(c);
        tags.push({ id: `${t}_main_mb`, name: `${c}: size of the connection file`, dataType: 'REAL', unit: 'MB' },
                  { id: `${t}_seg_mb`, name: `${c}: datalog rollover files, total`, dataType: 'REAL', unit: 'MB' },
                  { id: `${t}_seg_count`, name: `${c}: datalog rollover files`, dataType: 'INT' });
      }
      try { engine.registerManagedDevice({ id: 'DATALOG_STORE', name: 'Datalog storage', tags }); } catch (e) { log('[datalog] register device: ' + e.message); }
      for (const c of ids) {
        const t = tagId(c); const st = out[c];
        try {
          engine.setTagValue('DATALOG_STORE', `${t}_main_mb`, st.mainMB, 'good');
          engine.setTagValue('DATALOG_STORE', `${t}_seg_mb`, st.segmentsMB, 'good');
          engine.setTagValue('DATALOG_STORE', `${t}_seg_count`, st.segments, 'good');
        } catch (_) { /* not registered yet */ }
      }
    }
    for (const c of ids) {
      const st = out[c]; const t = tagId(c); const aid = `dlstore_main_${t}`;
      if (st.mainMB >= st.warnMB && !warned.has(c)) { warned.add(c); log(`[datalog] ${c}: ${st.mainFile} is ${st.mainMB} MB (warn at ${st.warnMB} MB)`); }
      if (st.mainMB < st.warnMB * 0.9) warned.delete(c);
      if (!alarmEngine) continue;
      try {
        const def = (alarmEngine.defs || []).find((d) => d.id === aid);
        if (!def) {
          alarmEngine.addAlarm({ id: aid, name: `Datalog file too big: ${c}`, type: 'limit', subType: 'hi', deviceId: 'DATALOG_STORE', tagId: `${t}_main_mb`,
            setpoint: st.warnMB, deadband: Math.max(1, Math.round(st.warnMB * 0.05)), onDelaySec: 0, offDelaySec: 0, priority: 'high', group: 'DATALOG',
            message: `${c}: the sqlite file passed ${st.warnMB} MB - a big file can freeze the backend at start (check rollover / retention)` });
        } else if (Number(def.setpoint) !== st.warnMB) alarmEngine.updateAlarm(aid, { setpoint: st.warnMB, deadband: Math.max(1, Math.round(st.warnMB * 0.05)) });
      } catch (e) { log(`[datalog] size alarm ${c}: ${e.message}`); }
    }
    return out;
  };
}

function startStorageMonitor(opts, everyMs = 60000) {
  const tick = makeStorageTick(opts);
  const run = () => { try { tick(); } catch (e) { (opts.log || (() => {}))('[datalog] storage monitor: ' + e.message); } };
  const first = setTimeout(run, 15000); if (first.unref) first.unref();
  const timer = setInterval(run, everyMs); if (timer.unref) timer.unref();
  return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { DatalogStorage, normConfig, monthKey, monthBounds, makeStorageTick, startStorageMonitor, DEFAULTS, SEG_RE };
