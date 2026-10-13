'use strict';
// Liveness of the Manager's children as seen from the Manager itself (L1+ hang detector, kpelink repair local check).
//
// One probe = one HTTP GET, classified:
//   ok       any HTTP status came back (401/403/5xx included): the event loop works
//   hung     TCP connected, but no HTTP answer in time: the process holds the port and does nothing
//   refused  nothing listens on the port
//   unknown  anything else (address gone with the WiFi, unreachable, too many files, reset by a TLS mismatch...):
//            tells nothing about the service, so it is never evidence and it breaks a running streak
// Evidence must be uninterrupted. "hung" alone feeds the hang detector; "hung" or "refused" feed the repair check, except while a child
// the Manager spawned has never listened yet (booting) - that only counts after bootGraceMs. Times are monotonic.
const http = require('http');
const https = require('https');

const monoMs = () => Number(process.hrtime.bigint() / 1000000n);
const RANK = { ok: 3, hung: 2, refused: 1, unknown: 0 };

// the address a child listening on `host` answers on locally (0.0.0.0 -> 127.0.0.1, :: -> ::1, localhost -> both)
function loopbackHosts(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h || h === '0.0.0.0') return ['127.0.0.1'];
  if (h === '::') return ['::1'];
  if (h === 'localhost') return ['127.0.0.1', '::1'];   // Node may bind 'localhost' to ::1 only
  return [h];
}

// local liveness probe only (nothing is sent): serve.js may use a self-signed cert, so the certificate is not checked
function probeOnce({ tls = false, host, port, path = '/', timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    let done = false; let connected = false;
    const end = (r) => { if (!done) { done = true; resolve(r); } };
    let req;
    try {
      req = (tls ? https : http).get({ host, port, path, timeout: timeoutMs, agent: false, rejectUnauthorized: false }, (res) => {
        res.resume(); end({ kind: 'ok', why: `HTTP ${res.statusCode}` });
      });
    } catch (e) { end({ kind: 'unknown', why: e.message }); return; }
    req.on('socket', (s) => { if (!s.connecting) connected = true; else s.once('connect', () => { connected = true; }); });
    req.on('timeout', () => {
      end(connected ? { kind: 'hung', why: `${port} accepts but gave no HTTP answer in ${timeoutMs / 1000}s` }
        : { kind: 'unknown', why: `no TCP connect to ${host}:${port} in ${timeoutMs / 1000}s` });
      req.destroy();
    });
    req.on('error', (e) => end(e && e.code === 'ECONNREFUSED' ? { kind: 'refused', code: e.code, why: `${port} refused` }
      : { kind: 'unknown', code: e && e.code, connected, why: `${host}:${port} ${(e && (e.code || e.message)) || 'error'}` }));
  });
}

// probe a child: every loopback address of its listen host; frontends get one more try in the other scheme when the first one could not
// even speak (serve.js falls back to plain http when its cert cannot be loaded). The most alive answer wins.
async function probeTarget(t, probe = probeOnce) {
  let best = null;
  for (const host of loopbackHosts(t.host)) {
    let r = await probe({ tls: !!t.tls, host, port: t.port, path: t.path, timeoutMs: t.timeoutMs });
    if (t.schemeFallback && r.kind === 'unknown') {
      const r2 = await probe({ tls: !t.tls, host, port: t.port, path: t.path, timeoutMs: t.timeoutMs });
      if (RANK[r2.kind] > RANK[r.kind]) r = r2;
    }
    if (!best || RANK[r.kind] > RANK[best.kind]) best = r;
    if (best.kind === 'ok') break;
  }
  return best || { kind: 'unknown', why: 'no address to probe' };
}

function createHealthTracker({ mono = monoMs, bootGraceMs = 15 * 60000 } = {}) {
  const st = new Map();
  const startedAt = mono();
  // okAt / spawnAt / hungSince / badSince: monotonic ms, null = never / no run going
  const get = (n) => { if (!st.has(n)) st.set(n, { okAt: null, spawnAt: null, seenOpen: false, hungSince: null, badSince: null, last: '', kind: '' }); return st.get(n); };

  // the Manager just spawned it: forget the old process
  function spawned(n) { Object.assign(get(n), { spawnAt: mono(), seenOpen: false, hungSince: null, badSince: null }); }

  // owned = the Manager runs this child right now (a refused port of a child that never listened yet = booting)
  function note(n, r, { owned = false } = {}) {
    const h = get(n); const t = mono();
    h.last = r.why; h.kind = r.kind;
    if (r.kind === 'ok') { Object.assign(h, { okAt: t, seenOpen: true, hungSince: null, badSince: null }); return h; }
    if (r.kind === 'hung') { h.seenOpen = true; h.hungSince = h.hungSince ?? t; h.badSince = h.badSince ?? t; return h; }
    if (r.kind === 'refused') {
      h.hungSince = null;
      if (owned && !h.seenOpen && h.spawnAt != null && t - h.spawnAt < bootGraceMs) { h.badSince = null; return h; }   // still booting
      h.badSince = h.badSince ?? t;
      return h;
    }
    h.hungSince = null; h.badSince = null;          // unknown: no evidence either way, a streak has to start again
    return h;
  }

  const since = (x) => (x == null ? 0 : mono() - x);
  return {
    spawned, note,
    hungMs: (n) => since(get(n).hungSince),         // uninterrupted "connected, no answer"
    deadMs: (n) => since(get(n).badSince),          // uninterrupted "hung or refused" (booting excluded)
    view: (n) => { const h = get(n); return { kind: h.kind, last: h.last, seenOpen: h.seenOpen, hungSec: Math.round(since(h.hungSince) / 1000),
      deadSec: Math.round(since(h.badSince) / 1000), okAgoSec: h.okAt == null ? null : Math.round((mono() - h.okAt) / 1000),
      sinceManagerStartSec: Math.round((mono() - startedAt) / 1000) }; },
  };
}

module.exports = { createHealthTracker, probeOnce, probeTarget, loopbackHosts, monoMs };
