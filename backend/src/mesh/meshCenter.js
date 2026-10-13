'use strict';
// MeshCenter - decides, per station, whether it is alive, from what the centre can see:
//   direct     the centre's own link to the station works (its __online tag is 1)
//   witnessed  the centre cannot reach it, but a neighbour heard it recently and said so
//   silent     neither: nobody has seen it -> this is the only state that should page a person
// Pure logic: no I/O, so it is tested with a fake clock. meshRuntime.js wires it to tags/alarms/HTTP.
const { verify, keyStrongEnough } = require('./meshCrypto');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_SEEN = 64;
const TOP_KEYS = new Set(['v', 'reporter', 'ts', 'seen', 'hmac']);
// kpelink repair: what each reporter sees of the machines it watches from the outside (backend/src/mesh/peerWatch.js). Sent as its own
// signed report to POST /api/kpenetwork/services, so a centre running an older version keeps accepting the witness reports.
const SVC_TOP_KEYS = new Set(['v', 'kind', 'reporter', 'ts', 'services', 'hmac']);
const SVC_KEYS = new Set(['target', 'svc', 'state', 'sinceSec']);
const SVC_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const SVC_STATES = new Set(['up', 'down', 'unreachable']);
const SVC_KINDS = new Set(['backend', 'frontend', 'host']);
const MAX_SERVICES = 32;
// service view: 2 up · 1 suspect (only one reporter says down / unreachable) · 0 down or unreachable (two or more reporters agree)
const SVC_NUM = { up: 2, suspect: 1, unreachable: 0, down: 0 };
const SEEN_KEYS = new Set(['station', 'uptimeMin', 'unsent', 'lastRecordAgeMin', 'wifi', 'recording', 'rssi', 'ageSec', 'hops']);
const MAX_STATIONS = 256;
const STATE_NUM = { silent: 0, witnessed: 1, direct: 2 };

const truthy = (v) => v === true || v === '1' || v === 'true' || (typeof v === 'number' && v !== 0);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function splitRef(ref) {
  const s = String(ref || ''); const i = s.indexOf('/');
  return i > 0 && i < s.length - 1 ? [s.slice(0, i), s.slice(i + 1)] : null;
}

class MeshCenter {
  constructor({ getConfig, readTag, now } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.readTag = readTag || (() => null);
    this.now = now || Date.now;
    this.witness = new Map();       // station -> Map(reporter -> { recv, seenAt, p })
    this.lastTs = new Map();        // reporter -> ts of the last accepted report (replay guard)
    this.lastRecv = new Map();      // reporter -> receive time of the last accepted report (rate limit)
    this.silentSince = new Map();   // station -> ms when it became silent
    this.lastDirect = new Map();    // station -> ms of the last time it was direct
    this.prevState = new Map();     // station -> last published state (for transition events)
    this.stats = { accepted: 0, rejected: {} };   // counters only; never the reporters' data
    this.services = new Map();      // target -> Map(reporter -> { recv, state, svc, sinceSec })
    this.svcDownSince = new Map();  // target -> ms when it became confirmed down / unreachable
    this.svcLastTs = new Map();     // reporter -> ts of the last accepted services report (its own replay guard)
    this.svcLastRecv = new Map();
    this.svcStats = { accepted: 0, rejected: {} };
  }

  _cfg() {
    const c = this.getConfig() || {};
    const ce = c.center || {};
    return {
      key: c.key || '', enabled: !!ce.enabled,
      ttlMs: (Number(ce.ttlSec) || 60) * 1000,
      skewMs: (Number(ce.maxSkewSec) || 300) * 1000,
      minIntervalMs: (ce.minIntervalSec == null ? 2 : Number(ce.minIntervalSec)) * 1000,
      stations: ce.stations && typeof ce.stations === 'object' ? ce.stations : {},
    };
  }

  // Validate + authenticate + store one witness report. Fail closed on anything odd.
  ingest(body, nowMs = this.now()) {
    const r = this._ingest(body, nowMs);
    if (r.ok) this.stats.accepted++; else this.stats.rejected[r.code] = (this.stats.rejected[r.code] || 0) + 1;
    return r;
  }

  _ingest(body, nowMs) {
    const cfg = this._cfg();
    const bad = (code, message) => ({ ok: false, code, message });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('bad-request', 'body must be an object');
    if (!keyStrongEnough(cfg.key)) return bad('no-key', 'mesh key is not configured (or too weak) on this node');
    // cheap shape checks BEFORE any hashing: signing walks the whole body, so anything that is not exactly the shape a node sends is turned away first
    // (known keys only, primitive values of bounded size - a chunked 50 MB body with one extra key cannot get past this)
    for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) return bad('bad-request', 'unknown field ' + k.slice(0, 20));
    if (typeof body.hmac !== 'string' || body.hmac.length !== 64) return bad('bad-hmac', 'signature does not verify');
    if (!Array.isArray(body.seen) || body.seen.length > MAX_SEEN) return bad('bad-request', 'seen must be an array (max ' + MAX_SEEN + ')');
    for (const e of body.seen) {
      if (e === null || typeof e !== 'object') continue;                       // dropped later
      if (Array.isArray(e)) return bad('bad-request', 'seen entries must be objects');
      for (const [k, v] of Object.entries(e)) {
        if (!SEEN_KEYS.has(k)) return bad('bad-request', 'unknown field in a seen entry');
        if (typeof v === 'string' ? v.length > 64 : (v !== null && typeof v !== 'number' && typeof v !== 'boolean')) return bad('bad-request', 'seen values must be small primitives');
      }
    }
    if (body.v !== 1) return bad('bad-request', 'unsupported version');
    if (typeof body.reporter !== 'string' || !ID_RE.test(body.reporter)) return bad('bad-request', 'reporter id invalid');
    if (typeof body.ts !== 'number' || !Number.isFinite(body.ts)) return bad('bad-request', 'ts must be a number (ms)');
    if (!verify(body, cfg.key)) return bad('bad-hmac', 'signature does not verify');
    if (Math.abs(nowMs - body.ts) > cfg.skewMs) {
      return bad('clock-skew', 'reporter clock is ' + Math.round((body.ts - nowMs) / 1000) + 's off the centre');
    }
    const lastTs = this.lastTs.get(body.reporter);
    if (lastTs != null && body.ts <= lastTs) return bad('replay', 'ts is not newer than the last accepted report');
    const lastRecv = this.lastRecv.get(body.reporter);
    if (lastRecv != null && nowMs - lastRecv < cfg.minIntervalMs) return bad('rate-limit', 'reports too frequent');

    let accepted = 0;
    for (const e of body.seen) {
      if (!e || typeof e.station !== 'string' || !ID_RE.test(e.station) || e.station === body.reporter) continue;
      const ageSec = typeof e.ageSec === 'number' && e.ageSec >= 0 && e.ageSec <= 3600 ? e.ageSec : 0;
      if (!this.witness.has(e.station) && this.witness.size >= MAX_STATIONS) continue;
      const p = {
        uptimeMin: int(e.uptimeMin, 0, 1e8), unsent: int(e.unsent, 0, 1e6), lastRecordAgeMin: int(e.lastRecordAgeMin, 0, 1e7),
        wifi: e.wifi === 0 || e.wifi === 1 ? e.wifi : null, recording: e.recording === 0 || e.recording === 1 ? e.recording : null,
        rssi: int(e.rssi, -120, 0), hops: int(e.hops, 1, 8) || 1,
      };
      if (!this.witness.has(e.station)) this.witness.set(e.station, new Map());
      this.witness.get(e.station).set(body.reporter, { recv: nowMs, seenAt: nowMs - ageSec * 1000, p });
      accepted++;
    }
    this.lastTs.set(body.reporter, body.ts);
    this.lastRecv.set(body.reporter, nowMs);
    return { ok: true, accepted };
  }

  // Validate + authenticate + store one services report (what a reporter sees of the machines it watches). Same rules as a witness report.
  ingestServices(body, nowMs = this.now()) {
    const r = this._ingestServices(body, nowMs);
    if (r.ok) this.svcStats.accepted++; else this.svcStats.rejected[r.code] = (this.svcStats.rejected[r.code] || 0) + 1;
    return r;
  }

  _ingestServices(body, nowMs) {
    const cfg = this._cfg();
    const bad = (code, message) => ({ ok: false, code, message });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('bad-request', 'body must be an object');
    if (!keyStrongEnough(cfg.key)) return bad('no-key', 'mesh key is not configured (or too weak) on this node');
    for (const k of Object.keys(body)) if (!SVC_TOP_KEYS.has(k)) return bad('bad-request', 'unknown field ' + k.slice(0, 20));
    if (typeof body.hmac !== 'string' || body.hmac.length !== 64) return bad('bad-hmac', 'signature does not verify');
    if (!Array.isArray(body.services) || body.services.length > MAX_SERVICES) return bad('bad-request', 'services must be an array (max ' + MAX_SERVICES + ')');
    for (const e of body.services) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('bad-request', 'services entries must be objects');
      for (const [k, v] of Object.entries(e)) {
        if (!SVC_KEYS.has(k)) return bad('bad-request', 'unknown field in a services entry');
        if (typeof v === 'string' ? v.length > 32 : typeof v !== 'number') return bad('bad-request', 'services values must be small primitives');
      }
    }
    if (body.v !== 1 || body.kind !== 'services') return bad('bad-request', 'unsupported version');
    if (typeof body.reporter !== 'string' || !ID_RE.test(body.reporter)) return bad('bad-request', 'reporter id invalid');
    if (typeof body.ts !== 'number' || !Number.isFinite(body.ts)) return bad('bad-request', 'ts must be a number (ms)');
    if (!verify(body, cfg.key)) return bad('bad-hmac', 'signature does not verify');
    if (Math.abs(nowMs - body.ts) > cfg.skewMs) return bad('clock-skew', 'reporter clock is ' + Math.round((body.ts - nowMs) / 1000) + 's off the centre');
    const lastTs = this.svcLastTs.get(body.reporter);
    if (lastTs != null && body.ts <= lastTs) return bad('replay', 'ts is not newer than the last accepted report');
    const lastRecv = this.svcLastRecv.get(body.reporter);
    if (lastRecv != null && nowMs - lastRecv < cfg.minIntervalMs) return bad('rate-limit', 'reports too frequent');
    let accepted = 0;
    for (const e of body.services) {
      if (!SVC_NAME_RE.test(String(e.target)) || !SVC_STATES.has(e.state) || !SVC_KINDS.has(e.svc)) continue;
      if (!this.services.has(e.target) && this.services.size >= MAX_STATIONS) continue;
      if (!this.services.has(e.target)) this.services.set(e.target, new Map());
      this.services.get(e.target).set(body.reporter, { recv: nowMs, state: e.state, svc: e.svc, sinceSec: Number.isFinite(e.sinceSec) ? Math.max(0, Math.min(1e7, e.sinceSec)) : 0 });
      accepted++;
    }
    this.svcLastTs.set(body.reporter, body.ts);
    this.svcLastRecv.set(body.reporter, nowMs);
    return { ok: true, accepted };
  }

  _direct(stationCfg) {
    const ref = stationCfg && splitRef(stationCfg.onlineTag);
    if (!ref) return false;
    try { return truthy(this.readTag(ref[0], ref[1])); } catch (_) { return false; }
  }

  liveness(nowMs = this.now()) {
    const cfg = this._cfg();
    const ids = new Set([...Object.keys(cfg.stations), ...this.witness.keys()]);
    const stations = {};
    for (const id of [...ids].sort()) {
      const direct = this._direct(cfg.stations[id]);
      const fresh = [...(this.witness.get(id) || new Map()).entries()]
        .filter(([, w]) => nowMs - w.seenAt <= cfg.ttlMs)
        .sort((a, b) => b[1].seenAt - a[1].seenAt);
      const state = direct ? 'direct' : (fresh.length ? 'witnessed' : 'silent');
      if (direct) this.lastDirect.set(id, nowMs);
      if (state === 'silent') { if (!this.silentSince.has(id)) this.silentSince.set(id, nowMs); }
      else this.silentSince.delete(id);
      const best = fresh.length ? fresh[0][1] : null;
      stations[id] = {
        state, stateNum: STATE_NUM[state],
        lastDirectTs: this.lastDirect.get(id) || null,
        witnessedBy: fresh.slice(0, 5).map(([r]) => r),
        lastWitnessTs: best ? best.seenAt : null,
        hops: best ? Math.min(...fresh.map(([, w]) => w.p.hops)) : null,
        unsent: best ? best.p.unsent : null,
        uptimeMin: best ? best.p.uptimeMin : null,
        lastRecordAgeMin: best ? best.p.lastRecordAgeMin : null,
        wifi: best ? best.p.wifi : null, recording: best ? best.p.recording : null, rssi: best ? best.p.rssi : null,
        silentSinceTs: this.silentSince.get(id) || null,
        silentMin: this.silentSince.has(id) ? Math.round(((nowMs - this.silentSince.get(id)) / 60000) * 10) / 10 : 0,
      };
    }
    // forget expired witnesses so memory stays bounded
    for (const [st, m] of this.witness) {
      for (const [rep, w] of m) if (nowMs - w.seenAt > cfg.ttlMs * 4) m.delete(rep);
      if (!m.size) this.witness.delete(st);
    }
    const counts = { direct: 0, witnessed: 0, silent: 0 };
    for (const s of Object.values(stations)) counts[s.state]++;
    return { generatedAt: nowMs, enabled: cfg.enabled, ttlSec: cfg.ttlMs / 1000, counts, stats: this.stats, stations, services: this.serviceView(nowMs, cfg), serviceStats: this.svcStats };
  }

  // machines watched from the outside: down / unreachable need two reporters (one alone is only a suspicion)
  serviceView(nowMs = this.now(), cfg = this._cfg()) {
    const out = {};
    for (const [target, m] of this.services) {
      for (const [rep, e] of m) if (nowMs - e.recv > cfg.ttlMs * 4) m.delete(rep);
      if (!m.size) { this.services.delete(target); this.svcDownSince.delete(target); continue; }
      const fresh = [...m.entries()].filter(([, e]) => nowMs - e.recv <= cfg.ttlMs);
      const by = (st) => fresh.filter(([, e]) => e.state === st).map(([r]) => r);
      const down = by('down'); const up = by('up'); const unreach = by('unreachable');
      // two reporters must agree before anything counts; one view alone may be that reporter's own path
      const state = down.length >= 2 ? 'down' : down.length === 1 ? 'suspect' : up.length ? 'up'
        : unreach.length >= 2 ? 'unreachable' : unreach.length === 1 ? 'suspect' : 'up';
      if (state === 'down' || state === 'unreachable') { if (!this.svcDownSince.has(target)) this.svcDownSince.set(target, nowMs); } else this.svcDownSince.delete(target);
      const svcs = [...new Set(fresh.filter(([, e]) => e.state === 'down').map(([, e]) => e.svc))];
      out[target] = { state, stateNum: SVC_NUM[state], services: svcs, downBy: down, upBy: up, unreachableBy: unreach,
        downSinceTs: this.svcDownSince.get(target) || null,
        downMin: this.svcDownSince.has(target) ? Math.round(((nowMs - this.svcDownSince.get(target)) / 60000) * 10) / 10 : 0 };
    }
    return out;
  }

  // transitions since the last call: [{station, from, to}] (first sight reports from=null)
  transitions(live) {
    const out = [];
    for (const [id, s] of Object.entries(live.stations)) {
      const prev = this.prevState.get(id);
      if (prev !== s.state) { out.push({ station: id, from: prev || null, to: s.state }); this.prevState.set(id, s.state); }
    }
    return out;
  }
}

module.exports = { MeshCenter, ID_RE, STATE_NUM, splitRef, truthy };
