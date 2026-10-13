'use strict';
// NeighborTable - what this node has heard on the air, and how far to trust it.
// Pure logic with an injectable clock; meshNode.js feeds it from the BLE helper.
//
// Freshness rule (replay guard): hearing the same bytes again proves nothing - a recorded beacon
// can be replayed. A neighbour counts as alive only while its counter keeps ADVANCING, and only
// forward. The counter never goes back within a restart value; the restart value (a counter the
// station keeps in a file) only moves forward too (modular, 1..127 ahead) measured against the last
// value CONFIRMED for that station, which is remembered for bootFloorSec even after the neighbour is
// forgotten. A different (forward) restart value is only a rival: it cannot displace a neighbour that
// is confirmed and still advancing, it takes over once it has advanced AND the current one has gone
// quiet. Duplicates never count as life (they do not refresh the entry), so an entry whose station is
// gone expires on time whatever is replayed at it.
// Residual risk (accepted, nothing can close it without a time field): beacons the station really sent
// but this node never heard, and recordings that are "ahead" of the remembered restart value (after
// the counter wrapped, or from before it was persisted), can make a dead station look alive for one
// alive window per recorded run, or - for a rival taking over a silent entry - hide a returning station
// for up to bootFloorSec from this one receiver (the centre still sees it directly, or through others).
const { decode, ctrDelta } = require('./meshBeacon');

const RSSI_ALPHA = 0.3;
const BOOT_AHEAD_MAX = 127;           // a boot value this many steps ahead (mod 256) is a restart; anything else is a stale or replayed packet
const REORDER_WINDOW = 8;           // counter steps behind that still count as "heard out of order", not as an attack

class NeighborTable {
  constructor({ getConfig, now } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.now = now || Date.now;
    this.entries = new Map();      // sid -> direct neighbour
    this.floor = new Map();        // sid -> { boot, at }: the last restart value confirmed for that station (survives forgetting it)
    this.second = new Map();       // sid -> { via, seenAt } heard about through a neighbour's gossip
    this.stats = { heard: 0, advanced: 0, duplicates: 0, rejected: {} };
  }

  _cfg() {
    const c = this.getConfig() || {}; const n = c.node || {};
    const peers = n.peers && typeof n.peers === 'object' ? n.peers : {};
    const nameOf = new Map(); for (const [name, num] of Object.entries(peers)) if (Number.isInteger(num)) nameOf.set(num, name);
    return {
      key: c.key || '', ownSid: Number(n.stationNum) || 0, nameOf,
      aliveMs: (Number(n.aliveSec) > 0 ? Number(n.aliveSec) : 30) * 1000,
      forgetMs: (Number(n.forgetSec) > 0 ? Number(n.forgetSec) : 900) * 1000,
      floorMs: (Number(n.bootFloorSec) > 0 ? Number(n.bootFloorSec) : 6 * 3600) * 1000,
      maxEntries: 128,
      ignore: new Set(Array.isArray(n.testIgnoreSids) ? n.testIgnoreSids.map(Number) : []),   // lab topology tests only
    };
  }

  _reject(reason) { this.stats.rejected[reason] = (this.stats.rejected[reason] || 0) + 1; return { ok: false, reason }; }

  // one advertising report from the radio: { hex, rssi }
  hear({ hex, rssi, addr } = {}, nowMs = this.now()) {
    const cfg = this._cfg();
    if (!cfg.key) return this._reject('no-key');
    const r = decode(hex, cfg.key);
    if (!r.ok) return this._reject(r.reason);
    const b = r.beacon;
    if (b.sid === cfg.ownSid) return this._reject('own-sid');
    if (cfg.ignore.has(b.sid)) return this._reject('ignored');
    let e = this.entries.get(b.sid);
    const fl = this.floor.get(b.sid);
    const ref = fl && nowMs - fl.at <= cfg.floorMs ? fl.boot : (e && e.confirmed && nowMs - e.advancedAt <= cfg.floorMs ? e.boot : null);      // the restart value we have actually seen advance lately
    if (ref != null && b.boot !== ref && ((b.boot - ref) & 0xFF) > BOOT_AHEAD_MAX) return this._reject('old-boot');   // a restart we have already moved past
    let advanced = false;
    if (!e) {
      if (this.entries.size >= cfg.maxEntries) return this._reject('table-full');
      e = { sid: b.sid, firstHeardAt: nowMs, advancedAt: 0, lastHeardAt: nowMs, confirmed: false, restarts: 0, boot: b.boot, ctr: b.ctr, lastGossipedAt: 0, rival: null };
      this.entries.set(b.sid, e);
      advanced = true;
    } else if (e.boot === b.boot) {
      const d = ctrDelta(e.ctr, b.ctr);
      if (d === 0) { this.stats.duplicates++; }                          // heard again: proves nothing, refreshes nothing
      else if (d <= 0x7FFF) {
        e.ctr = b.ctr; e.confirmed = true; e.advancedAt = nowMs; advanced = true; e.rival = null;
        this._confirm(e, nowMs);
      } else if (((e.ctr - b.ctr) & 0xFFFF) <= REORDER_WINDOW) {
        return this._reject('reordered');     // the previous beacon heard after the new one: two advertisements overlap for a moment while the payload is swapped
      } else return this._reject('replay');   // older than what we already have by more than that: a replay
    } else {
      // a different restart value (already known to be forward of what we have confirmed): a rival
      let rv = e.rival;
      if (!rv || rv.boot !== b.boot) { rv = e.rival = { boot: b.boot, ctr: b.ctr, n: 0 }; }
      else {
        const d = ctrDelta(rv.ctr, b.ctr);
        if (d === 0) this.stats.duplicates++;
        else if (d <= 0x7FFF) { rv.ctr = b.ctr; rv.n++; }
        else return this._reject('replay');
      }
      const currentLive = e.confirmed && nowMs - e.advancedAt <= cfg.aliveMs;
      if (rv.n >= 1 && !currentLive) {       // it has advanced, and the one it would replace has gone quiet (or never proved itself): a real restart
        e.boot = rv.boot; e.ctr = rv.ctr; e.confirmed = true; e.advancedAt = nowMs; e.restarts++; e.rival = null; advanced = true;
        this._confirm(e, nowMs);
      } else return this._reject('rival-boot');
    }
    if (advanced) e.lastHeardAt = nowMs;     // only real progress keeps an entry from expiring
    if (typeof addr === 'string' && /^[0-9A-Fa-f:]{17}$/.test(addr)) e.addr = addr.toUpperCase();     // where to connect for a relay hand-over
    if (typeof rssi === 'number' && Number.isFinite(rssi)) {
      e.rssi = rssi; e.rssiAvg = e.rssiAvg == null ? rssi : e.rssiAvg + RSSI_ALPHA * (rssi - e.rssiAvg);
    }
    this.stats.heard++;
    if (advanced) {
      this.stats.advanced++;
      e.beacon = b;
      for (const g of e.confirmed ? b.gossip : []) {   // second-hand: only from a beacon that is new AND from a neighbour already proven alive, so its ages are current and it is not a replayed first sight
        if (g.sid === cfg.ownSid) continue;         // (testIgnoreSids only blocks the radio, not what neighbours say - that is how a bench builds a 2-hop chain)
        const seenAt = nowMs - g.ageSec * 1000;
        const cur = this.second.get(g.sid);
        if (!cur || seenAt > cur.seenAt) this.second.set(g.sid, { via: b.sid, seenAt });
      }
    }
    return { ok: true, sid: b.sid, advanced };
  }

  _confirm(e, nowMs) {
    this.floor.delete(e.sid); this.floor.set(e.sid, { boot: e.boot, at: nowMs });      // (delete + set keeps the oldest first)
    if (this.floor.size > 512) this.floor.delete(this.floor.keys().next().value);
  }

  _alive(e, cfg, nowMs) { return e.confirmed && nowMs - e.advancedAt <= cfg.aliveMs; }

  // tidy view for the local API and the tests
  snapshot(nowMs = this.now()) {
    const cfg = this._cfg();
    const direct = [...this.entries.values()].sort((a, b) => a.sid - b.sid).map((e) => {
      const b = e.beacon || {};
      return {
        sid: e.sid, station: cfg.nameOf.get(e.sid) || null, addr: e.addr || null, hops: 1, alive: this._alive(e, cfg, nowMs), confirmed: e.confirmed,
        rssi: e.rssiAvg == null ? null : Math.round(e.rssiAvg),
        ageSec: e.advancedAt ? Math.round((nowMs - e.advancedAt) / 1000) : null, restarts: e.restarts,
        wifi: !!b.wifi, recording: !!b.recording, clockOk: !!b.clockOk, relay: !!b.relay,
        unsent: b.unsent == null ? null : b.unsent, lastRecordAgeMin: b.lastRecordAgeMin == null ? null : b.lastRecordAgeMin, uptimeMin: b.uptimeMin == null ? null : b.uptimeMin,
      };
    });
    const secondHand = [];
    for (const [sid, s] of [...this.second.entries()].sort((a, b) => a[0] - b[0])) {
      const e = this.entries.get(sid);
      if (e && this._alive(e, cfg, nowMs)) continue;          // heard directly: second-hand adds nothing
      secondHand.push({ sid, station: cfg.nameOf.get(sid) || null, hops: 2, via: cfg.nameOf.get(s.via) || s.via, alive: nowMs - s.seenAt <= cfg.aliveMs, ageSec: Math.round((nowMs - s.seenAt) / 1000) });
    }
    return { direct, secondHand };
  }

  // the "seen" list of a witness report (only neighbours that are alive AND named in the peers map)
  seenForReport(nowMs = this.now()) {
    const snap = this.snapshot(nowMs);
    const out = [];
    for (const d of snap.direct) {
      if (!d.alive || !d.station) continue;
      out.push({ station: d.station, uptimeMin: d.uptimeMin, unsent: d.unsent, lastRecordAgeMin: d.lastRecordAgeMin, wifi: d.wifi ? 1 : 0, recording: d.recording ? 1 : 0, rssi: d.rssi, ageSec: d.ageSec, hops: 1 });
    }
    for (const s of snap.secondHand) {
      if (!s.alive || !s.station) continue;
      out.push({ station: s.station, uptimeMin: null, unsent: null, lastRecordAgeMin: null, wifi: null, recording: null, rssi: null, ageSec: s.ageSec, hops: 2 });
    }
    return out;
  }

  // neighbours a row can be handed to: alive, and they say they can reach the centre and relay
  relayCandidates(nowMs = this.now()) {
    const cfg = this._cfg();
    return [...this.entries.values()]
      .filter((e) => this._alive(e, cfg, nowMs) && e.beacon && e.beacon.relay && e.beacon.wifi)
      .sort((a, b) => (b.rssiAvg == null ? -200 : b.rssiAvg) - (a.rssiAvg == null ? -200 : a.rssiAvg))
      .map((e) => ({ sid: e.sid, station: cfg.nameOf.get(e.sid) || null, rssi: e.rssiAvg == null ? null : Math.round(e.rssiAvg) }));
  }

  // up to `slots` alive neighbours to name in the next beacon; rotates so with many neighbours
  // every one is announced in turn
  nextGossip(nowMs = this.now(), slots = 2) {
    const cfg = this._cfg();
    const alive = [...this.entries.values()].filter((e) => this._alive(e, cfg, nowMs)).sort((a, b) => a.lastGossipedAt - b.lastGossipedAt || a.sid - b.sid).slice(0, slots);
    for (const e of alive) e.lastGossipedAt = nowMs;
    return alive.map((e) => ({ sid: e.sid, ageSec: Math.max(0, Math.round((nowMs - e.advancedAt) / 1000)) }));
  }

  prune(nowMs = this.now()) {
    const cfg = this._cfg();
    for (const [sid, e] of this.entries) if (nowMs - e.lastHeardAt > cfg.forgetMs) this.entries.delete(sid);
    for (const [sid, f] of this.floor) if (nowMs - f.at > cfg.floorMs) this.floor.delete(sid);
    for (const [sid, s] of this.second) if (nowMs - s.seenAt > cfg.forgetMs) this.second.delete(sid);
  }
}

module.exports = { NeighborTable };
