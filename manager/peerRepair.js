'use strict';
// kpelink repair - neighbours help a machine whose service died without its own supervisor noticing (docs/PEER-REPAIR-PLAN.md).
//
// Peers never command anything. A peer that has seen a service of this machine down from the outside for a while sends a signed VOTE;
// this Manager decides, and only after its OWN long-window evidence agrees:
//   * quorum: votes from >= `quorum` different peers, each pinned to its own IP address, for the same service inside `windowSec`
//   * the service is meant to run (not stopped by an operator, not given up by the crash-loop guard; orphans only with adoptOrphans)
//   * the restart budget shared with every other automatic restart allows it (cooldown, daily cap -> stop and tell people)
//   * the Manager's own record: no healthy answer for >= `localDownSec` (a short stall is never "dead")
//   * the optional idle gate (weigh stations), and once more "meant to run / not shutting down" right before acting
// The only actions are restarting `backend` / `frontend` through the Manager's normal restart. Votes are HMAC-signed with a repair key
// kept apart from the Bluetooth plant key, time-bound, single use and bound to this machine's name. Intervals use a monotonic clock;
// the wall clock is only compared with the vote's own timestamp.
const path = require('path');
const crypto = require('crypto');
const { sign, verify, keyStrongEnough } = require(path.join(__dirname, '..', 'backend', 'src', 'mesh', 'meshCrypto'));
const { createRestartBudget, monoMs } = require('./restartBudget');

const DEFAULTS = { enabled: false, key: '', name: '', quorum: 2, windowSec: 180, maxSkewSec: 120, cooldownMin: 10, dailyCap: 6, localDownSec: 120,
  actions: ['backend', 'frontend'], peers: {}, idleTag: '', idleValue: 'idle', adoptOrphans: false };
const VOTE_KEYS = new Set(['v', 'peer', 'target', 'svc', 'ts', 'nonce', 'downSec', 'hmac']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/;
const MAX_VOTE_BYTES = 2048;
const VOTE_GAP_MS = 20000;

function normIp(ip) { return String(ip || '').trim().toLowerCase().replace(/^::ffff:/, ''); }
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function normConfig(raw) {
  const c = { ...DEFAULTS, ...(isObj(raw) ? raw : {}) };
  c.enabled = c.enabled === true;
  c.name = typeof c.name === 'string' && NAME_RE.test(c.name) ? c.name : '';
  c.quorum = Math.max(2, Number(c.quorum) || 2);                  // one peer alone is never enough
  c.windowSec = Math.min(3600, Math.max(30, Number(c.windowSec) || 180));
  c.maxSkewSec = Math.min(600, Math.max(10, Number(c.maxSkewSec) || 120));
  c.cooldownMin = Math.max(1, Number(c.cooldownMin) || 10);
  c.dailyCap = Math.max(1, Number(c.dailyCap) || 6);
  c.localDownSec = Math.max(60, Number(c.localDownSec) || 120);   // the Manager's own evidence covers at least a minute
  c.actions = (Array.isArray(c.actions) ? c.actions : []).filter((a) => a === 'backend' || a === 'frontend');
  // every peer is pinned to an address, so one key holder cannot vote under several names from one machine
  const listed = isObj(c.peers) ? c.peers : {};
  c.peers = {}; c.unpinned = [];
  for (const [name, ip] of Object.entries(listed)) {
    if (NAME_RE.test(name) && typeof ip === 'string' && IP_RE.test(normIp(ip))) c.peers[name] = normIp(ip); else c.unpinned.push(String(name).slice(0, 32));
  }
  c.adoptOrphans = c.adoptOrphans === true;
  return c;
}

// why an enabled config cannot be used (null = usable)
function configProblem(c) {
  if (!keyStrongEnough(c.key)) return 'the repair key must be a generated secret (openssl rand -hex 16)';
  if (!c.name) return 'name (this machine, as its peers call it) is required';
  if (c.unpinned.length) return 'every peer needs its IP address: ' + c.unpinned.join(', ');
  if (Object.keys(c.peers).length < c.quorum) return `at least ${c.quorum} peers are required`;
  const ips = Object.values(c.peers);
  if (new Set(ips).size !== ips.length) return 'two peers share one IP address: one machine would count as two';
  return null;
}

function createPeerRepair({ readConfig, now = Date.now, mono = monoMs, wanted = () => true, shuttingDown = () => false, checkLocal,
  idleGate = async () => ({ ok: true }), restart, budget = null, log = () => {}, notify = () => {}, audit = () => {} }) {
  const votes = [];                // { peer, svc, at (mono), downSec }
  const nonces = new Map();        // nonce -> mono seen; insertion order = age order
  const lastVoteBy = new Map();    // `${peer}|${svc}` -> mono
  const rejectAudited = new Map(); // `${ip}|${why}` -> mono (audit of refused votes, rate-limited)
  const outcomes = [];
  let busy = false;
  let lastCfg = null;
  const bud = budget || createRestartBudget({ mono,
    onGiveUp: (svc, n) => { log(`[peer-repair] ${svc}: ${n} automatic restarts in 24 h - not restarting again, people must look`); notify(`KPE SCADA — ${svc} repair gave up`, `${n} automatic restarts in 24 h already`); } });

  const cfg = () => (lastCfg = normConfig(readConfig()));
  const note = (o) => { outcomes.push({ ...o, at: now() }); if (outcomes.length > 50) outcomes.shift(); return o; };

  // Before the signature is checked the caller learns as little as possible (one generic answer); the real reason goes to the audit.
  function refuse(status, code, why, ctx) {
    const k = `${ctx.ip}|${why}`; const m = mono();
    if (m - (rejectAudited.get(k) ?? -Infinity) > 10000) {
      if (rejectAudited.size > 500) rejectAudited.clear();
      rejectAudited.set(k, m);
      audit({ kind: 'refused', why, ip: ctx.ip, peer: ctx.peer, svc: ctx.svc });
    }
    return { status, ok: false, code, message: code === 'rejected' ? 'vote not accepted' : why };
  }

  async function vote(body, { ip = '', bytes = 0 } = {}) {
    const c = cfg(); const t = now(); const m = mono();
    const ctx = { ip: normIp(ip), peer: isObj(body) && typeof body.peer === 'string' ? body.peer.slice(0, 32) : '', svc: isObj(body) && typeof body.svc === 'string' ? body.svc.slice(0, 16) : '' };
    if (!c.enabled || configProblem(c)) return { status: 503, ok: false, code: 'disabled', message: 'peer repair is not enabled on this machine' };
    if (bytes > MAX_VOTE_BYTES) return refuse(413, 'too-large', 'too-large', ctx);
    if (!isObj(body) || Object.keys(body).some((k) => !VOTE_KEYS.has(k)) || body.v !== 1 || typeof body.peer !== 'string' || !NAME_RE.test(body.peer)
      || typeof body.target !== 'string' || !NAME_RE.test(body.target) || typeof body.svc !== 'string' || !Number.isFinite(body.ts)
      || typeof body.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce) || !Number.isFinite(body.downSec) || body.downSec < 0 || body.downSec > 86400 * 7
      || typeof body.hmac !== 'string') return refuse(400, 'bad-request', 'malformed', ctx);
    if (body.target !== c.name) return refuse(403, 'rejected', 'wrong-target', ctx);              // a vote overheard for another machine
    if (!c.actions.includes(body.svc)) return refuse(403, 'rejected', 'action-not-allowed', ctx);
    if (!Object.prototype.hasOwnProperty.call(c.peers, body.peer)) return refuse(403, 'rejected', 'unknown-peer', ctx);
    if (c.peers[body.peer] !== ctx.ip) return refuse(403, 'rejected', 'wrong-address', ctx);
    if (Math.abs(t - body.ts) > c.maxSkewSec * 1000) return refuse(403, 'rejected', 'clock-skew', ctx);
    if (!verify(body, c.key)) return refuse(403, 'rejected', 'bad-hmac', ctx);
    // authenticated from here on: rate limit first, so one peer cannot fill the nonce store; then single use
    const rk = `${body.peer}|${body.svc}`;
    if (m - (lastVoteBy.get(rk) ?? -Infinity) < VOTE_GAP_MS) return { status: 429, ok: false, code: 'rate-limit', message: 'one vote per peer and service every 20 s' };
    for (const [n, at] of nonces) { if (m - at <= c.maxSkewSec * 2000) break; nonces.delete(n); }
    if (nonces.has(body.nonce)) return refuse(409, 'replay', 'replay', ctx);
    nonces.set(body.nonce, m);
    lastVoteBy.set(rk, m);
    for (const [k, at] of lastVoteBy) { if (m - at > VOTE_GAP_MS) lastVoteBy.delete(k); }

    votes.push({ peer: body.peer, svc: body.svc, at: m, downSec: body.downSec });
    while (votes.length && m - votes[0].at > c.windowSec * 1000) votes.shift();
    audit({ kind: 'vote', peer: body.peer, svc: body.svc, downSec: body.downSec, ip: ctx.ip });
    const decision = await decide(body.svc, c);
    return { status: 200, ok: true, accepted: true, decision };
  }

  async function decide(svc, c) {
    const m = mono();
    const peers = [...new Set(votes.filter((v) => v.svc === svc && m - v.at <= c.windowSec * 1000).map((v) => v.peer))];
    if (peers.length < c.quorum) return note({ svc, result: 'waiting', peers, need: c.quorum });
    if (!wanted(svc, c)) return note({ svc, result: 'stopped-on-purpose', peers });
    const b = bud.check(svc, { cooldown: c.cooldownMin * 60000, cap: c.dailyCap });
    if (!b.ok) return note({ svc, result: b.why, peers, lastBy: b.lastSource });
    if (busy) return note({ svc, result: 'busy', peers });
    busy = true;
    try {
      let local; try { local = await checkLocal(svc, c); } catch (e) { local = { dead: false, why: 'local check failed: ' + e.message }; }
      if (!local || local.dead !== true) return note({ svc, result: 'healthy-here', peers, why: local && local.why });
      // the local check may ask for a longer window (e.g. an orphan never seen listening since the Manager started)
      const needMs = Math.max(c.localDownSec * 1000, Number(local.minDownMs) || 0);
      if (!(Number(local.downMs) >= needMs)) {
        return note({ svc, result: 'not-long-enough', peers, why: local.why, downSec: Math.round((Number(local.downMs) || 0) / 1000), need: Math.round(needMs / 1000) });
      }
      let idle; try { idle = await idleGate(svc, c); } catch (e) { idle = { ok: false, why: e.message }; }
      if (!idle || idle.ok !== true) return note({ svc, result: 'deferred-busy', peers, why: idle && idle.why });
      // the checks above take seconds: an operator may have pressed Stop, or the Manager may be shutting down, in the meantime
      if (!wanted(svc, c) || shuttingDown()) return note({ svc, result: 'stopped-on-purpose', peers, why: 'stopped or shutting down while checking' });
      const b2 = bud.check(svc, { cooldown: c.cooldownMin * 60000, cap: c.dailyCap });
      if (!b2.ok) return note({ svc, result: b2.why, peers, lastBy: b2.lastSource });
      log(`[peer-repair] ${svc} confirmed dead here (${local.why}) after votes from ${peers.join(', ')} → restart`);
      bud.record(svc, 'peer-repair');
      let r; try { r = await restart(svc); } catch (e) { r = { ok: false, msg: e.message }; }
      const a = { svc, peers, result: r && r.ok === false ? 'restart-failed' : 'restarted', why: local.why };
      clearVotes(svc);                                              // a new incident needs new votes
      audit({ kind: 'action', svc, peers, result: a.result, why: local.why, detail: r && r.msg });
      notify(`KPE SCADA — ${svc} restarted by peers`, `${peers.join(', ')} saw it down; here: ${local.why}`);
      return note(a);
    } finally { busy = false; }
  }

  function clearVotes(svc) { for (let i = votes.length - 1; i >= 0; i--) if (!svc || votes[i].svc === svc) votes.splice(i, 1); }

  function status() {
    const c = cfg(); const m = mono();
    return { enabled: c.enabled, problem: c.enabled ? configProblem(c) : null, keySet: keyStrongEnough(c.key), name: c.name, quorum: c.quorum,
      windowSec: c.windowSec, cooldownMin: c.cooldownMin, dailyCap: c.dailyCap, localDownSec: c.localDownSec, adoptOrphans: c.adoptOrphans,
      actions: c.actions, peers: Object.keys(c.peers), unpinned: c.unpinned,
      votes: votes.filter((v) => m - v.at <= c.windowSec * 1000).map(({ peer, svc, at, downSec }) => ({ peer, svc, agoSec: Math.round((m - at) / 1000), downSec })),
      restarts24h: bud.status(), recent: outcomes.slice(-10) };
  }

  return { vote, status, clearVotes, _decide: decide, _lastConfig: () => lastCfg };
}

// what a peer sends (tests; the node side builds the same body in backend/src/mesh/peerWatch.js)
function makeVote({ key, peer, target, svc, downSec, ts = Date.now(), nonce }) {
  const body = { v: 1, peer, target, svc, ts, nonce: nonce || crypto.randomBytes(16).toString('hex'), downSec: Math.max(0, Math.round(downSec || 0)) };
  body.hmac = sign(body, key);
  return body;
}

module.exports = { createPeerRepair, makeVote, normConfig, configProblem, DEFAULTS, MAX_VOTE_BYTES };
