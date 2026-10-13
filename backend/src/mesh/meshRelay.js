'use strict';
// MeshRelay (T8) - lets a station whose network is down hand its weigh rows to a neighbour that still has one.
//
// It is only an ACCELERATOR. The station's own uploader (`triger`) is untouched and keeps every row at
// sent=0 until the station itself reaches the server, so nothing this module does can lose or change a row
// at the station; a live row delivered twice (once by a neighbour, once by the station) is absorbed by the
// server's unique index on record_id (docs/KUBOTALOG-DEDUP.md). KNOWN GAP: a row the station voids AFTER a
// relay delivered the live copy ends up live + VOID at the server - see docs/MESH-NODE.md. Rules:
//   * origin: only while this station is CERTAINLY cut off (its online tag says so); only live rows (etc IS NULL) with a record_id;
//             a row counts as handed over only when the neighbour returned a verifiable proof of storage
//   * relay:  every incoming frame is authenticated + decrypted (AES-GCM), fresh, and strictly validated before it is even stored
//   * the sink defaults to "inbox" (keep only), so switching relay on cannot write to any server by accident
const { validateRow, encodeFrame, decodeFrame, ackFor, ackMatches } = require('./relayRow');
const { isTimeRequest, decodeTimeRequest, encodeTimeResponse } = require('./meshTime');

const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/;

class MeshRelay {
  constructor({ getConfig, now = Date.now, table, store, helper, readSource, sink, isOffline = () => false, timeAnswer = null, log = () => {} } = {}) {
    Object.assign(this, { getConfig: getConfig || (() => ({})), now, table, store, helper, readSource, sink, isOffline, timeAnswer, log });
    this.cursor = 0; this.cursorResetAt = 0;       // highest source row id whose whole prefix is already handled (so the scan window moves on)
    this.busy = { origin: false, forward: false };
    this.failUntil = new Map();            // relay sid -> ms until which it is not tried again
    this.skipIds = new Set();              // record_ids that failed validation (logged once, never retried)
    this.recent = new Map();               // origin -> [receive times] (rate limit on the relay side)
    this.last = { origin: null, forward: null };
    this.stats = { handedOut: 0, received: 0, duplicates: 0, forwarded: 0, forwardFailed: 0, invalid: 0, badAck: 0, timeServed: 0, rejected: {} };
    this.recentTime = new Map();           // requester -> [request times] (time requests share the GATT channel; rate-limited separately)
    this._onIn = (ev) => { this.onIncoming(ev).catch((e) => this._warn('incoming: ' + e.message)); };
    this.lastWarnAt = 0;
  }

  _cfg() {
    const c = this.getConfig() || {}; const n = c.node || {}; const r = n.relay || {};
    return {
      key: c.key || '', station: String(n.station || ''), enabled: !!r.enabled && !!c.key,
      batch: Math.min(50, Math.max(1, Number(r.batch) || 10)), pollMs: Math.max(2, Number(r.pollSec) || 5) * 1000,
      maxPerMin: Math.max(1, Number(r.maxPerMin) || 120), minRssi: Number.isFinite(Number(r.minRssi)) ? Number(r.minRssi) : -100,
      sinkType: (r.sink && r.sink.type) || 'inbox',
      frameSkewMs: (Number(r.maxSkewSec) > 0 ? Number(r.maxSkewSec) : 3600) * 1000,
    };
  }

  _warn(msg) { const t = this.now(); if (t - this.lastWarnAt > 60000) { this.lastWarnAt = t; this.log('[mesh] relay ' + msg); } }
  _bump(reason) { this.stats.rejected[reason] = (this.stats.rejected[reason] || 0) + 1; }

  attach() { if (this.helper && !this.attached) { this.helper.on('relay-in', this._onIn); this.attached = true; } }
  detach() { if (this.helper && this.attached) { this.helper.off('relay-in', this._onIn); this.attached = false; } }

  // ---------------------------------------------------------------- origin: hand rows to a neighbour
  async tickOrigin(nowMs = this.now()) {
    const cfg = this._cfg();
    if (!cfg.enabled) return this._done('origin', { skipped: 'relay disabled' });
    if (this.busy.origin) return null;
    if (!this.isOffline()) return this._done('origin', { skipped: 'not cut off (or no online tag, so cannot tell): this station uploads its own rows' });
    this.busy.origin = true;
    try {
      const relays = this.table.relayCandidates().filter((r) => r.rssi == null || r.rssi >= cfg.minRssi).filter((r) => (this.failUntil.get(r.sid) || 0) <= nowMs);
      if (!relays.length) return this._done('origin', { skipped: 'no relay in range' });
      const todo = await this._nextRows(cfg, nowMs);
      if (!todo.length) return this._done('origin', { skipped: 'nothing to hand over' });
      const relay = relays[0];
      let sent = 0; let failed = 0; let why = null;
      for (const r of todo) {
        const v = validateRow({ s: r.station, w: r.weig, c: r.code, r: r.record_id, n: r.note, etc: null }, nowMs);
        if (!v.ok) { this.skipIds.add(r.record_id); this.stats.invalid++; this._warn(`row ${r.record_id} is not relayable (${v.why}); it stays for the station's own upload`); continue; }
        const frame = encodeFrame({ origin: cfg.station, row: v.row, ts: this.now() }, cfg.key);
        const res = await this.helper.relaySend(relay.sid, frame.toString('hex'), 30000);
        if (res && res.ok && !ackMatches(cfg.key, frame, res.ack)) { this.stats.badAck++; res.ok = false; res.why = 'bad-ack'; }        // a neighbour that cannot prove it stored the row did not take it
        if (res && res.ok) { await this.store.markHandedOut(v.row.recordId, relay.station || String(relay.sid), this.now()); sent++; this.stats.handedOut++; }
        else { failed++; why = (res && res.why) || 'failed'; this.failUntil.set(relay.sid, this.now() + 30000); break; }
      }
      return this._done('origin', { relay: relay.station || relay.sid, sent, failed, why });
    } catch (e) { this._warn('origin: ' + e.message); return this._done('origin', { error: e.message }); }
    finally { this.busy.origin = false; }
  }

  // The next rows still to hand over. The source is read in windows after an id cursor, so a long outage (hundreds of rows, most of them
  // already handed over) never leaves the scan stuck on the same first rows; the cursor only moves past a window whose rows are ALL handled.
  async _nextRows(cfg, nowMs) {
    if (nowMs - this.cursorResetAt > 10 * 60000) { this.cursor = 0; this.cursorResetAt = nowMs; }     // a replaced / truncated table must not hide rows forever
    const win = cfg.batch * 3; const todo = []; let cursor = this.cursor;
    for (let i = 0; i < 20 && todo.length < cfg.batch; i++) {
      const rows = (await this.readSource(win, cursor)) || [];
      if (!rows.length) break;
      const handed = await this.store.handedOutIds(rows.map((r) => r.record_id));
      let allDone = true;
      for (const r of rows) {
        if (handed.has(r.record_id) || this.skipIds.has(r.record_id)) continue;
        allDone = false;
        if (todo.length < cfg.batch) todo.push(r);
      }
      const last = Number(rows[rows.length - 1].id);
      if (allDone && todo.length === 0 && Number.isFinite(last)) this.cursor = last;
      if (!Number.isFinite(last) || rows.length < win) break;
      cursor = last;
    }
    return todo;
  }

  // ---------------------------------------------------------------- relay: accept a frame from a neighbour
  async onIncoming(ev) {
    const cfg = this._cfg(); const id = ev && ev.id;
    const nack = (why) => { this._bump(why); try { this.helper.relayAck(id, false, why); } catch (_) { /* helper gone */ } return { ok: false, why }; };
    if (!cfg.enabled) return nack('relay-disabled');
    const nowMs = this.now();
    if (isTimeRequest(ev && ev.hex)) return this._answerTime(id, ev.hex, cfg, nowMs, nack);
    const d = decodeFrame(ev.hex, cfg.key, nowMs, cfg.frameSkewMs);
    if (!d.ok) return nack(d.why);
    if (d.origin === cfg.station) return nack('own-origin');
    const times = (this.recent.get(d.origin) || []).filter((t) => nowMs - t < 60000);
    if (times.length >= cfg.maxPerMin) return nack('rate-limit');
    times.push(nowMs); this.recent.set(d.origin, times);
    try {
      const r = await this.store.addIncoming({ origin: d.origin, row: d.row }, nowMs);
      if (r.duplicate) this.stats.duplicates++; else this.stats.received++;
      const frame = Buffer.from(String(ev.hex), 'hex');
      this.helper.relayAck(id, true, r.duplicate ? 'duplicate' : 'stored', ackFor(cfg.key, frame).toString('hex'));
      return { ok: true, duplicate: r.duplicate };
    } catch (e) { this._warn('store: ' + e.message); return nack('store-failed'); }
  }

  // a neighbour asks for the time (meshTime.js): answered only while our own clock is verified against the time master (timeAnswer decides)
  _answerTime(id, hex, cfg, nowMs, nack) {
    const r = decodeTimeRequest(hex, cfg.key);
    if (!r.ok) return nack('time-' + r.why);
    if (r.station === cfg.station) return nack('own-origin');
    const times = (this.recentTime.get(r.station) || []).filter((t) => nowMs - t < 60000);
    if (times.length >= 10) return nack('time-rate-limit');
    times.push(nowMs); this.recentTime.set(r.station, times);
    let t; try { t = this.timeAnswer ? this.timeAnswer() : null; } catch (_) { t = null; }
    if (!t || !t.ok || !Number.isFinite(t.epochMs)) return nack((t && t.why) || 'no-verified-clock');
    this.stats.timeServed++;
    try { this.helper.relayAck(id, true, 'time', encodeTimeResponse(cfg.key, r.nonce, t.epochMs).toString('hex')); } catch (_) { /* helper gone */ }
    return { ok: true, time: true };
  }

  // ---------------------------------------------------------------- relay: send what we hold on to the server
  async tickForward(nowMs = this.now()) {
    const cfg = this._cfg();
    if (!cfg.enabled) return this._done('forward', { skipped: 'relay disabled' });
    if (cfg.sinkType === 'inbox' || !this.sink) return this._done('forward', { skipped: 'sink is "inbox": rows are kept, not forwarded' });
    if (this.busy.forward) return null;
    if (this.isOffline()) return this._done('forward', { skipped: 'offline (the online tag says so)' });
    this.busy.forward = true;
    try {
      const pending = await this.store.pendingIncoming(nowMs, cfg.batch);
      let forwarded = 0; let failed = 0;
      for (const row of pending) {
        let res;
        try { res = await this.sink.insert(row); } catch (e) { res = { ok: false, error: e.message }; }
        if (res && res.ok) { await this.store.markForwarded(row.recordId, this.now()); forwarded++; this.stats.forwarded++; }
        else { const f = await this.store.markFailed(row.recordId, (res && res.error) || 'failed', this.now()); failed++; this.stats.forwardFailed++; this._warn(`forward ${row.recordId} failed: ${(res && res.error) || 'failed'} (attempt ${f.attempts})`); break; }
      }
      return this._done('forward', { forwarded, failed });
    } catch (e) { this._warn('forward: ' + e.message); return this._done('forward', { error: e.message }); }
    finally { this.busy.forward = false; }
  }

  _done(kind, r) { this.last[kind] = { ...r, at: this.now() }; return this.last[kind]; }

  async status() {
    let counts = null; try { counts = await this.store.counts(); } catch (_) { /* db not ready */ }
    const cfg = this._cfg();
    return { enabled: cfg.enabled, sink: cfg.sinkType, counts, stats: { ...this.stats, rejected: { ...this.stats.rejected } }, last: this.last, relaysInRange: this.table.relayCandidates().map((r) => ({ station: r.station, rssi: r.rssi })) };
  }
}

// Sink for "insert this row into a SQL table". The column set is fixed (the same the station's uploader uses).
// dialect 'mssql' binds @p0.. positionally (dbHelper), 'sqlite' binds ?; a duplicate-key error counts as delivered.
function makeSqlSink({ query, dialect = 'mssql', table }) {
  if (!table || !/^[\[\]A-Za-z0-9_.]+$/.test(table)) throw new Error('sink table name is not a plain identifier');
  // "INSERT ... WHERE NOT EXISTS (record_id)": any row already there for this record_id - live OR voided - means this copy is not needed, so a late relay
  // can never put a live duplicate next to a row the station has since voided. (The unique index still backs it up against a race.)
  const sql = dialect === 'mssql'
    ? `INSERT INTO ${table} ([station],[weig],[code],[record_id],[etc],[Reason]) SELECT @p0,@p1,@p2,@p3,NULL,@p4 WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE [record_id] = @p3)`
    : `INSERT INTO ${table} (station, weig, code, record_id, etc, Reason) SELECT ?,?,?,?,NULL,? WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE record_id = ?)`;
  return {
    async insert(row) {
      const rid = String(row.recordId).slice(0, 50);
      const params = [row.station, String(row.weig), String(row.code || ''), rid, row.reason ? String(row.reason) : null];
      try {
        await query(sql, dialect === 'mssql' ? params : [...params, rid]);
        return { ok: true };
      } catch (e) {
        if (/duplicate key|unique constraint/i.test(String(e && e.message))) return { ok: true, duplicate: true };
        return { ok: false, error: String(e && e.message || e) };
      }
    },
  };
}

function safeIdent(name, what) { if (!IDENT_RE.test(String(name))) throw new Error(`${what} must be a plain identifier`); return String(name); }

module.exports = { MeshRelay, makeSqlSink, safeIdent };
