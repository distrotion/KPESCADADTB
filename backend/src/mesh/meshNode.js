'use strict';
// MeshNode - the Pi side of the mesh. Every station is a beacon, a listener and a witness:
//   * it advertises a signed beacon about itself (alive, wifi up, rows waiting, ...)
//   * it listens for the beacons of its neighbours and keeps a NeighborTable
//   * while its own network works it tells the centre what it heard (signed witness report)
// Off unless mesh.json says node.enabled. Everything here is informational; nothing received over
// the air can make this station do anything, and no failure here may touch weighing.
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { encode } = require('./meshBeacon');
const { NeighborTable } = require('./neighborTable');
const { sign, keyStrongEnough } = require('./meshCrypto');
const { splitRef, truthy } = require('./meshCenter');
const { encodeTimeRequest, decodeTimeResponse, combineAnswers } = require('./meshTime');

function httpPostJson(url, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: timeoutMs }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

// one TCP connect: resolves true when the port accepts, false on refusal / unreachable / timeout (never throws)
function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false; const end = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* gone */ } resolve(ok); };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => end(false));
    sock.once('connect', () => end(true));
    sock.once('error', () => end(false));
  });
}

function toMinutesAgo(v, nowMs) {
  if (v == null || v === '') return null;
  let ms = null;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;          // seconds or milliseconds
  else if (/^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); ms = n < 1e11 ? n * 1000 : n; }
  else { const t = Date.parse(String(v)); ms = Number.isFinite(t) ? t : null; }
  if (ms == null) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 60000));
}

class MeshNode {
  constructor({ getConfig, now = Date.now, monoNow = () => Number(process.hrtime.bigint() / 1000000n), readTag = () => null, readStats = null, clockOk = null, peerTime = null, relayFactory = null, bootStore = null, helper, post = httpPostJson, probe = tcpProbe, serviceReport = null, log = () => {}, uptimeMin = () => Math.floor(os.uptime() / 60), random = () => crypto.randomBytes(3) } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.now = now; this.monoNow = monoNow; this.readTag = readTag; this.readStats = readStats; this.clockOk = clockOk; this.helper = helper; this.post = post; this.log = log; this.uptimeMin = uptimeMin;
    // clock from neighbours (meshTime.js): { needs(staleMs), apply(driftMs, meta), now() } from the time sync manager; null = feature off
    this.peerTime = peerTime; this.peerTimeLast = null; this.timeBusy = false; this.nextTimeTryMono = 0;
    // onlineProbe: "can this station deliver its data" measured directly; ok = null until it is known (unknown is never "offline")
    this.probe = probe; this.probeState = { ok: null, fails: 0, okAt: 0, lastAt: 0, busy: false };
    this.serviceReport = serviceReport;   // kpelink repair: what this node sees of the machines it watches (peerWatch.js), sent with the report
    // neighbour ages use a MONOTONIC clock: a wall-clock step (time sync setting the OS clock back) must not make stale neighbours look fresh
    this.table = new NeighborTable({ getConfig: this.getConfig, now: monoNow });
    // the relay needs our neighbour table and our idea of "offline", so it is built here from a factory
    this.relay = relayFactory ? relayFactory({ table: this.table, helper, now, getConfig: this.getConfig, isOffline: () => this.offlineForSure(), timeAnswer: () => this._timeAnswer(), log }) : null;
    const r = random();
    // boot = restart counter: random until the node is actually started, then taken from a file (+1 per start) so it only ever moves forward
    // (neighbours reject a restart value they have already moved past). Nothing is written while the mesh is off.
    this.bootStore = bootStore; this.bootTaken = false;
    let boot = r[0];
    this.boot = boot; this.ctr = (r[1] << 8 | r[2]) & 0xFFFF;         // random counter start
    this.stats = null; this.statsAt = 0;                              // cached { unsent, lastRecordAgeMin } - the beacon never waits on a database
    this.lastReport = null; this.lastReportTs = 0; this.lastReportOkAt = 0; this.reportBusy = false;
    this.lastBeaconHex = null; this.lastBeaconAt = 0; this.timers = []; this.running = false; this.lastErrorLogAt = 0;
    this._onBeacon = (ev) => { try { this.table.hear(ev); } catch (e) { this._warn('hear: ' + e.message); } };
  }

  _cfg() {
    const c = this.getConfig() || {}; const n = c.node || {};
    const op = n.onlineProbe || {};
    const centerUrls = [...new Set([...(Array.isArray(n.centerUrls) ? n.centerUrls : []), n.centerUrl].map((u) => String(u || '').trim().replace(/\/+$/, '')).filter(Boolean))];
    return {
      key: c.key || '', enabled: !!n.enabled, station: String(n.station || ''), sid: Number(n.stationNum) || 0, centerUrls,
      // ble: false = network-only node (a server without Bluetooth): reports, online probe and watching other machines; no beacon/scan/relay/peer time
      ble: n.ble !== false,
      onlineProbe: { on: !!(op.host && Number(op.port) > 0), host: String(op.host || ''), port: Number(op.port) || 0, everyMs: Math.max(2, Number(op.everySec) || 10) * 1000,
        timeoutMs: Math.min(10000, Math.max(500, Number(op.timeoutMs) || 3000)), failAfter: Math.max(1, Number(op.failAfter) || 3) },
      reportMs: Math.max(5, Number(n.reportSec) || 15) * 1000, advMs: Math.max(2000, Number(n.advMs) || 5000),
      scanOn: Number(n.scanOnSec) > 0 ? Number(n.scanOnSec) : 2, scanDuty: Math.min(1, Math.max(0.02, Number(n.scanDuty) || 0.2)),
      onlineTag: splitRef(n.onlineTag), recordingTag: splitRef(n.recordingTag),
      relay: !!(n.relay && n.relay.enabled), relayCfg: { enabled: !!(n.relay && n.relay.enabled), pollMs: Math.max(2, Number(n.relay && n.relay.pollSec) || 5) * 1000 }, statsMs: Math.max(5, Number(n.statsSec) || 30) * 1000,
      peerTime: ((pt) => ({ enabled: pt.enabled !== false, staleMs: Math.max(0.1, Number(pt.staleHours) || 6) * 3600000, intervalMs: Math.max(15, Number(pt.intervalSec) || 60) * 1000,
        agreeMs: Math.max(100, Number(pt.agreeMs) || 2000), maxPeers: Math.min(3, Math.max(1, Number(pt.maxPeers) || 2)) }))(n.peerTime || {}),
    };
  }

  _warn(msg) { const t = this.now(); if (t - this.lastErrorLogAt > 60000) { this.lastErrorLogAt = t; this.log('[mesh] ' + msg); } }

  ready() {
    const c = this._cfg();
    if (!c.enabled) return { ok: false, why: 'node.enabled is off' };
    if (!keyStrongEnough(c.key)) return { ok: false, why: 'mesh key missing or not a generated secret (32+ hex characters: openssl rand -hex 16)' };
    if (!c.station) return { ok: false, why: 'node.station is empty' };
    if (c.ble && !(c.sid >= 1 && c.sid <= 0xFFFE)) return { ok: false, why: 'node.stationNum must be 1..65534' };
    return { ok: true };
  }

  // true / false for a tag that has a value; null for "no tag configured / no such tag / no value yet" - unknown must never be mistaken for "no"
  _tagTruthy(ref) { if (!ref) return null; try { const v = this.readTag(ref[0], ref[1]); return v === null || v === undefined ? null : truthy(v); } catch (_) { return null; } }

  // "can this station deliver its data": the direct probe when configured (offline only after failAfter misses in a row), else the online tag;
  // null = unknown, which is never treated as offline
  _online(cfg) { return cfg.onlineProbe.on ? this.probeState.ok : this._tagTruthy(cfg.onlineTag); }

  async tickProbe() {
    const cfg = this._cfg(); const op = cfg.onlineProbe; const st = this.probeState;
    if (!op.on || st.busy) return null;
    st.busy = true;
    try {
      let ok = false; try { ok = !!(await this.probe(op.host, op.port, op.timeoutMs)); } catch (_) { ok = false; }
      st.lastAt = this.now();
      if (ok) { st.ok = true; st.fails = 0; st.okAt = st.lastAt; st.okMono = this.monoNow(); } else if (++st.fails >= op.failAfter) st.ok = false;
      return st.ok;
    } finally { st.busy = false; }
  }

  // "I am certainly cut off": the probe (or the online tag) has a value and says no. Without either we cannot tell "no network" from "the centre rejected
  // my report", and handing every row to a neighbour because of a rejected report would be wrong, so the relay treats "unknown" as online.
  offlineForSure() { return this._online(this._cfg()) === false; }

  // kpelink repair votes ask for more: the probe must have answered recently, or (no probe) the online tag must say yes.
  // Unknown or stale = do not vote.
  networkOkForVoting() {
    const cfg = this._cfg(); const op = cfg.onlineProbe; const st = this.probeState;
    if (op.on) return st.ok === true && !!st.okMono && this.monoNow() - st.okMono <= op.everyMs * (op.failAfter + 1);
    return this._tagTruthy(cfg.onlineTag) === true;
  }

  // "can I reach the centre": the configured tag, else how the last report went
  _wifi(cfg, nowMs) {
    const t = this._online(cfg);
    if (t != null) return t;
    return this.lastReportOkAt > 0 && nowMs - this.lastReportOkAt <= cfg.reportMs * 3;
  }

  // "my clock was checked against the time master lately" - informational only, a beacon never sets anybody's clock
  _clockOk() { if (!this.clockOk) return false; try { return this.clockOk() === true; } catch (_) { return false; } }

  // answer to a neighbour asking for the time: only while our own clock is verified (a clock set from a neighbour is not - one hop at most)
  _timeAnswer() {
    if (!this._cfg().peerTime.enabled) return { ok: false, why: 'time-off' };
    if (!this._clockOk()) return { ok: false, why: 'no-verified-clock' };
    let epochMs; try { epochMs = this.peerTime && this.peerTime.now ? this.peerTime.now() : this.now(); } catch (_) { epochMs = this.now(); }
    return { ok: true, epochMs };
  }

  // clock from neighbours: when the time master cannot be reached and our clock has no recent verified sync, ask up to `maxPeers` neighbours
  // whose beacon says clockOk; answers must agree; the time sync manager applies the result with its own guards (threshold, big jump, throttle)
  async tickPeerTime(nowMs = this.now()) {
    const cfg = this._cfg(); const pt = cfg.peerTime;
    if (!cfg.ble || !pt.enabled || !this.peerTime || !this.helper || !this.ready().ok || this.timeBusy) return null;
    const mono = this.monoNow();
    if (mono < this.nextTimeTryMono) return null;
    let needed = false; try { needed = !!this.peerTime.needs(pt.staleMs); } catch (_) { needed = false; }
    if (!needed) { this.peerTimeLast = { at: nowMs, skipped: 'not needed (time master reachable or synced lately)' }; return this.peerTimeLast; }
    this.nextTimeTryMono = mono + pt.intervalMs;
    const cands = this.table.snapshot().direct.filter((d) => d.alive && d.clockOk && d.station)
      .sort((a, b) => (Number(b.relay) - Number(a.relay)) || ((b.rssi == null ? -999 : b.rssi) - (a.rssi == null ? -999 : a.rssi)));
    if (!cands.length) return this._notePeerTime({ at: nowMs, ok: false, why: 'no neighbour with a verified clock in range' });
    this.timeBusy = true;
    try {
      const answers = []; const errors = [];
      for (const n of cands.slice(0, pt.maxPeers + 2)) {
        if (answers.length >= pt.maxPeers) break;
        const { frame, nonce } = encodeTimeRequest(cfg.key, cfg.station);
        const res = await this.helper.relaySend(n.sid, frame.toString('hex'), 20000);
        if (!res || !res.ok) { errors.push(`${n.station}: ${(res && res.why) || 'failed'}`); continue; }
        const d = decodeTimeResponse(res.ack, cfg.key, nonce);
        if (!d.ok) { errors.push(`${n.station}: ${d.why}`); continue; }
        if (!Number.isFinite(res.wt)) { errors.push(`${n.station}: helper did not report when the write was acknowledged`); continue; }
        answers.push({ from: n.station, epochMs: d.epochMs, at: res.wt });
      }
      const c = combineAnswers(answers, { agreeMs: pt.agreeMs });
      if (!c.ok) return this._notePeerTime({ at: nowMs, ok: false, why: c.why, spreadMs: c.spreadMs, errors });
      const r = await this.peerTime.apply(c.driftMs, { from: c.from, spreadMs: c.spreadMs, staleMs: pt.staleMs });
      if (r && ['in-sync', 'os-set', 'app-offset'].includes(r.result)) this.nextTimeTryMono = this.monoNow() + 10 * 60000;
      return this._notePeerTime({ at: this.now(), ok: true, driftMs: c.driftMs, spreadMs: c.spreadMs, from: c.from, result: r && r.result, error: r && r.error, errors });
    } catch (e) { return this._notePeerTime({ at: nowMs, ok: false, why: String(e && e.message || e).slice(0, 120) }); }
    finally { this.timeBusy = false; }
  }

  _notePeerTime(r) {
    this.peerTimeLast = r;
    if (r.ok && ['os-set', 'app-offset'].includes(r.result)) this.log(`[mesh] clock corrected from neighbours ${r.from.join('+')}: ${r.driftMs} ms (${r.result})`);
    else if (!r.ok) this._warn('clock from neighbours: ' + r.why);
    return r;
  }

  // the payload this node would advertise right now (also bumps the counter)
  buildBeacon(nowMs = this.now()) {
    const cfg = this._cfg();
    this.ctr = (this.ctr + 1) & 0xFFFF;
    const wifi = this._wifi(cfg, nowMs);
    const rec = this._tagTruthy(cfg.recordingTag);
    const st = this.stats || {};
    return encode({
      sid: cfg.sid, boot: this.boot, ctr: this.ctr, wifi, recording: rec === true, clockOk: this._clockOk(), relay: cfg.relay && wifi,
      unsent: st.unsent, lastRecordAgeMin: st.lastRecordAgeMin, uptimeMin: this.uptimeMin(), gossip: this.table.nextGossip(),
    }, cfg.key);
  }

  tickBeacon(nowMs = this.now()) {
    if (!this.ready().ok || !this.helper || !this._cfg().ble) return null;
    let buf;
    try { buf = this.buildBeacon(nowMs); } catch (e) { this._warn('beacon: ' + e.message); return null; }
    this.lastBeaconHex = buf.toString('hex'); this.lastBeaconAt = nowMs;
    try { this.helper.setBeacon(this.lastBeaconHex); } catch (e) { this._warn('helper: ' + e.message); }
    this._syncRelayServe();
    return this.lastBeaconHex;
  }

  // the beacon's "relay" flag follows the config live, so whether we accept hand-overs must follow it too
  _syncRelayServe() {
    if (!this.relay || !this.helper) return;
    const want = this._cfg().relayCfg.enabled;
    if (want !== !!this.serving) { this.serving = want; try { this.helper.relayServe(want, this._cfg().sid, this.boot); } catch (e) { this._warn('relay serve: ' + e.message); } }
  }

  async tickStats(nowMs = this.now()) {
    if (!this.readStats) return null;
    try {
      const s = await this.readStats();
      if (s) { this.stats = { unsent: s.unsent == null ? null : Number(s.unsent), lastRecordAgeMin: s.lastRecordAgeMin != null ? Number(s.lastRecordAgeMin) : toMinutesAgo(s.lastRecordTs, nowMs) }; this.statsAt = nowMs; }
    } catch (e) { this._warn('stats query: ' + e.message); }
    return this.stats;
  }

  // one witness report; resolves with the result (never throws)
  async tickReport(nowMs = this.now()) {
    const cfg = this._cfg();
    if (!this.ready().ok || !cfg.centerUrls.length || this.reportBusy) return null;
    // the legacy online tag means "the centre is reachable": skip while it says no. The direct probe measures the data path, not the centres, so with it
    // every centre is always tried (another machine being down must not stop the reports).
    if (!cfg.onlineProbe.on && this._tagTruthy(cfg.onlineTag) === false) return this._noteReport({ ts: nowMs, ok: false, skipped: 'centre unreachable (online tag is 0)' }, false);
    const seen = this.table.seenForReport();
    let services = []; try { services = this.serviceReport ? (this.serviceReport() || []) : []; } catch (_) { services = []; }
    if (!seen.length && !services.length) return this._noteReport({ ts: nowMs, ok: true, skipped: 'nothing heard' }, false);
    // two separately signed reports: the witness report (what was heard over the air) and, for kpelink repair, what this node sees of the
    // machines it watches. A centre that does not know the second kind yet still takes the first.
    const ts = Math.max(nowMs, this.lastReportTs + 1);
    const body = seen.length ? { v: 1, reporter: cfg.station, ts, seen } : null;
    if (body) body.hmac = sign(body, cfg.key);
    const svcBody = services.length ? { v: 1, kind: 'services', reporter: cfg.station, ts, services } : null;
    if (svcBody) svcBody.hmac = sign(svcBody, cfg.key);
    const send = async (url, path, b) => {
      try {
        const r = await this.post(url + path, b);
        return { ok: !!(r && r.status === 200 && r.json && r.json.ok === true), httpStatus: r && r.status, code: r && r.json && r.json.code, accepted: r && r.json && r.json.accepted };
      } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 120) }; }
    };
    this.reportBusy = true;
    try {
      // the same signed reports to every centre; each one works on its own, so one centre being down blinds nobody
      const centres = await Promise.all(cfg.centerUrls.map(async (url) => {
        const w = body ? await send(url, '/api/kpenetwork/witness', body) : null;
        const sv = svcBody ? await send(url, '/api/kpenetwork/services', svcBody) : null;
        const main = w || sv;
        return { url, ...main, services: sv ? (sv.ok ? 'ok' : sv.httpStatus || sv.error || sv.code) : undefined };
      }));
      this.lastReportTs = ts;
      const ok = centres.some((c) => c.ok);
      if (ok) this.lastReportOkAt = nowMs;
      const first = centres.find((c) => c.ok) || centres[0];
      if (ok && centres.some((c) => !c.ok)) this._warn('report: centre ' + centres.filter((c) => !c.ok).map((c) => `${c.url} (${c.httpStatus || c.error || c.code})`).join(', ') + ' failed');
      return this._noteReport({ ts, ok, httpStatus: first.httpStatus, code: first.code, accepted: first.accepted, error: first.error, sent: seen.length, centres }, true);
    } finally { this.reportBusy = false; }
  }

  _noteReport(r, attempted) {
    this.lastReport = { ...r, attempted };
    if (attempted && !r.ok) this._warn(`report failed (${r.httpStatus || ''} ${r.code || r.error || ''})`);
    return this.lastReport;
  }

  // listen to the helper (start() does this; tests can call it without starting timers)
  attach() { if (this.helper && !this.attached) { this.helper.on('beacon', this._onBeacon); this.attached = true; } }
  detach() { if (this.helper && this.attached) { this.helper.off('beacon', this._onBeacon); this.attached = false; } }

  start() {
    if (this.running) return this.status();
    const rd = this.ready();
    if (!rd.ok) { if (this.whyLogged !== rd.why) { this.whyLogged = rd.why; this.log('[mesh] node not started: ' + rd.why); } return this.status(); }
    this.whyLogged = null;
    const cfg = this._cfg();
    this.running = true;
    if (this.bootStore && !this.bootTaken) {
      this.bootTaken = true;
      try { this.boot = this.bootStore.next() & 0xFF; } catch (e) { this.log('[mesh] restart counter not persisted: ' + e.message); }
    }
    if (this.helper && cfg.ble) {
      this.attach();
      if (this.relay) this.helper.relayPeers(Object.values((this.getConfig().node || {}).peers || {}).filter((x) => Number.isInteger(x)));
      this.helper.setScan({ on: cfg.scanOn, off: cfg.scanDuty >= 1 ? 0 : Math.round((cfg.scanOn / cfg.scanDuty - cfg.scanOn) * 10) / 10 });
      this.helper.start();
    }
    const every = (ms, fn) => { const t = setInterval(() => { try { const p = fn(); if (p && p.catch) p.catch((e) => this._warn(e.message)); } catch (e) { this._warn(e.message); } }, ms); if (t.unref) t.unref(); this.timers.push(t); };
    if (cfg.ble) {
      this.tickStats().then(() => this.tickBeacon());
      every(cfg.advMs, () => this.tickBeacon());
    }
    every(cfg.reportMs, () => this.tickReport());
    if (this.relay && cfg.ble) {
      const rc = this._cfg().relayCfg;
      this.relay.attach();
      this._syncRelayServe();
      every(rc.pollMs, () => this.relay.tickOrigin());
      every(rc.pollMs, () => this.relay.tickForward());
      every(10 * 60000, () => (this._cfg().relayCfg.enabled ? this.relay.store.prune(this.now()) : null));
    }
    if (cfg.ble) {
      every(cfg.statsMs, () => this.tickStats());
      every(15000, () => this.tickPeerTime());
    }
    this.tickProbe();
    every(cfg.onlineProbe.everyMs, () => this.tickProbe());
    every(60000, () => this.table.prune());
    this.log(cfg.ble ? `[mesh] node started: ${cfg.station} (#${cfg.sid}) beacon every ${cfg.advMs / 1000}s, report every ${cfg.reportMs / 1000}s`
      : `[mesh] node started (network only, no Bluetooth): ${cfg.station}, report every ${cfg.reportMs / 1000}s`);
    return this.status();
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.detach();
    if (this.relay) this.relay.detach();
    if (this.helper) { if (this.relay && this.serving) this.helper.relayServe(false, 0, 0); this.serving = false; this.helper.stop(); }
  }

  status() {
    const cfg = this._cfg(); const nowMs = this.now();
    const rd = this.ready();
    return {
      enabled: cfg.enabled, running: this.running, ready: rd.ok, why: rd.ok ? null : rd.why, station: cfg.station, stationNum: cfg.sid, ble: cfg.ble,
      wifi: rd.ok ? this._wifi(cfg, nowMs) : null, boot: this.boot, ctr: this.ctr, beaconAgeSec: this.lastBeaconAt ? Math.round((nowMs - this.lastBeaconAt) / 1000) : null,
      stats: this.stats, statsAgeSec: this.statsAt ? Math.round((nowMs - this.statsAt) / 1000) : null,
      helper: this.helper ? this.helper.status() : null, lastReport: this.lastReport, peerTime: this.peerTimeLast,
      probe: cfg.onlineProbe.on ? { host: cfg.onlineProbe.host, port: cfg.onlineProbe.port, ok: this.probeState.ok, fails: this.probeState.fails,
        okAgeSec: this.probeState.okAt ? Math.round((nowMs - this.probeState.okAt) / 1000) : null } : null,
      neighbors: this.table.snapshot(), table: { ...this.table.stats },
    };
  }
}

module.exports = { MeshNode, httpPostJson, toMinutesAgo };
