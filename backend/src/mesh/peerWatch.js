'use strict';
// kpelink repair, the watching side (docs/PEER-REPAIR-PLAN.md). Every `everySec` this node looks at the machines listed in node.watch from the
// outside and, when a service has been down for `voteAfterSec`, sends that machine's Manager a signed VOTE (manager/peerRepair.js decides).
//   front answers GET /api/health 2xx-4xx/500         -> up
//   front answers /api/health 502/503/504             -> backend down  (serve.js answers, the backend behind it does not)
//   /api/health no answer, but GET / on front answers -> backend down  (proxy waits on a hung backend; the static page still comes)
//   front accepts TCP but answers nothing at all      -> frontend down (serve.js itself hung)
//   front REFUSED, Manager port answers               -> frontend down
//   anything else (timeouts, nothing answers)         -> unreachable   (machine off, network or firewall: nothing to repair from here)
// A vote can only be delivered if this node reaches the target's Manager, which already proves the path between the two works.
// Durations use a monotonic clock; the wall clock is only the vote's timestamp (checked against the target's clock).
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { sign, keyStrongEnough } = require('./meshCrypto');

const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const GATEWAY_DOWN = new Set([502, 503, 504]);
const monoMs = () => Number(process.hrtime.bigint() / 1000000n);

function hostPort(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), base: `${u.protocol}//${u.host}`, tls: u.protocol === 'https:' };
  } catch (_) { return null; }
}
// 'open' | 'refused' | 'timeout' (anything that is not a clear refusal counts as timeout: it tells nothing about the service)
function tcpState(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false; const end = (r) => { if (done) return; done = true; try { s.destroy(); } catch (_) { /* gone */ } resolve(r); };
    const s = net.connect({ host, port }); s.setTimeout(timeoutMs, () => end('timeout'));
    s.once('connect', () => end('open')); s.once('error', (e) => end(e && e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'));
  });
}
// HTTP status, or 0 when nothing came back in time. The certificate is not checked on purpose: plant certs are self-signed, nothing is sent,
// and the only question is "did the service answer" (votes go to the Manager, and those are HMAC-signed and single use anyway)
function httpStatus(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false; const end = (v) => { if (!done) { done = true; resolve(v); } };
    const mod = String(url).startsWith('https:') ? https : http;
    let req;
    try { req = mod.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (r) => { r.resume(); end(r.statusCode); }); } catch (_) { end(0); return; }
    req.on('timeout', () => { end(0); req.destroy(); }); req.on('error', () => end(0));
  });
}
function postJson(url, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { resolve({ status: 0, error: e.message }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = mod.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (r) => {
      const ch = []; let n = 0;
      r.on('data', (c) => { n += c.length; if (n <= 64 * 1024) ch.push(c); });
      r.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (_) { /* not json */ } resolve({ status: r.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(data);
  });
}

class PeerWatch {
  constructor({ getConfig, readRepair = () => null, now = Date.now, mono = monoMs, tcp = tcpState, get = httpStatus, post = postJson, myNetworkOk = () => true, log = () => {} } = {}) {
    Object.assign(this, { getConfig: getConfig || (() => ({})), readRepair, now, mono, tcp, get, post, myNetworkOk, log });
    this.state = new Map();      // name -> { state, svc, why, since (mono), lastVote }
    this.busy = false;
  }

  _cfg() {
    const n = ((this.getConfig() || {}).node) || {};
    const seen = new Set();
    const list = (Array.isArray(n.watch) ? n.watch : []).filter((w) => w && NAME_RE.test(String(w.name || '')) && hostPort(w.front) && hostPort(w.manager)
      && !seen.has(w.name) && seen.add(w.name)).slice(0, 32);
    return { enabled: !!n.enabled && list.length > 0, list, everyMs: Math.max(10, Number(n.watchEverySec) || 30) * 1000,
      voteAfterMs: Math.max(30, Number(n.voteAfterSec) || 120) * 1000, voteEveryMs: Math.max(30, Number(n.voteEverySec) || 60) * 1000 };
  }

  async look(w) {
    const f = hostPort(w.front); const m = hostPort(w.manager);
    const front = await this.tcp(f.host, f.port);
    if (front === 'open') {
      const code = await this.get(f.base + '/api/health');
      if (code && !GATEWAY_DOWN.has(code)) return { state: 'up', svc: null, why: `/api/health ${code}` };
      if (code) return { state: 'down', svc: 'backend', why: `/api/health ${code}` };
      const page = await this.get(f.base + '/');
      if (page) return { state: 'down', svc: 'backend', why: `/api/health no answer, front page ${page}` };
      return { state: 'down', svc: 'frontend', why: `front ${f.port} accepts but answers nothing` };
    }
    if (front === 'refused' && (await this.tcp(m.host, m.port)) === 'open') return { state: 'down', svc: 'frontend', why: `front ${f.port} refused, manager answers` };
    return { state: 'unreachable', svc: null, why: front === 'refused' ? 'front refused, manager does not answer' : `front ${f.port} ${front}` };
  }

  async tick() {
    const cfg = this._cfg();
    const listed = new Set(cfg.list.map((w) => w.name));
    for (const name of [...this.state.keys()]) if (!cfg.enabled || !listed.has(name)) this.state.delete(name);   // removed from node.watch
    if (!cfg.enabled || this.busy) return null;
    this.busy = true;
    try {
      for (const w of cfg.list) {
        const prev = this.state.get(w.name) || {};
        let r; try { r = await this.look(w); } catch (e) { r = { state: 'unreachable', svc: null, why: e.message }; }
        const m = this.mono();
        const same = prev.state === r.state && prev.svc === r.svc;
        const cur = { ...r, since: same ? prev.since : m, lastVote: same ? prev.lastVote : null };
        this.state.set(w.name, cur);
        if (!same && r.state !== 'up') this.log(`[mesh] watch ${w.name}: ${r.state}${r.svc ? ' ' + r.svc : ''} (${r.why})`);
        if (r.state === 'down' && m - cur.since >= cfg.voteAfterMs && (!cur.lastVote || m - cur.lastVote.at >= cfg.voteEveryMs)) cur.lastVote = await this.vote(w, cur, m);
      }
    } finally { this.busy = false; }
    return this.status();
  }

  async vote(w, cur, m) {
    const rep = this.readRepair() || {};
    if (!keyStrongEnough(rep.key) || !NAME_RE.test(String(rep.name || ''))) return { at: m, sent: false, why: 'no repair key / name on this machine (manager peer-repair.json)' };
    let ok = false; try { ok = this.myNetworkOk() === true; } catch (_) { ok = false; }
    if (!ok) return { at: m, sent: false, why: 'my own network is not known to work - not voting' };
    const body = { v: 1, peer: rep.name, target: w.name, svc: cur.svc, ts: this.now(), nonce: crypto.randomBytes(16).toString('hex'), downSec: Math.round((m - cur.since) / 1000) };
    body.hmac = sign(body, rep.key);
    const r = await this.post(hostPort(w.manager).base + '/api/peer-repair/vote', body);
    const d = r && r.json;
    const out = { at: m, sent: true, httpStatus: r && r.status, result: d && d.decision ? d.decision.result : (d && d.code) || (r && r.error) || null };
    this.log(`[mesh] vote ${w.name} ${cur.svc} down ${body.downSec}s -> ${out.httpStatus} ${out.result}`);
    return out;
  }

  // for the centre's services report (the whole plant on one screen): only primitives, bounded
  reportEntries() {
    const m = this.mono();
    return [...this.state.entries()].slice(0, 32).map(([target, s]) => ({ target, svc: s.svc || 'host', state: s.state, sinceSec: Math.min(1e7, Math.round((m - s.since) / 1000)) }));
  }

  status() {
    const m = this.mono();
    return [...this.state.entries()].map(([name, s]) => ({ name, state: s.state, svc: s.svc, why: s.why, sinceSec: Math.round((m - s.since) / 1000),
      lastVote: s.lastVote ? { ...s.lastVote, at: undefined, agoSec: Math.round((m - s.lastVote.at) / 1000) } : null }));
  }
}

module.exports = { PeerWatch, hostPort, tcpState, httpStatus, postJson };
