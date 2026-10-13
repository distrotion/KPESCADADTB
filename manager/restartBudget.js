'use strict';
// One restart budget per service, shared by every AUTOMATIC restart: kpelink peer repair, the L1+ hang detector and the B6 watchdog.
// Two mechanisms must never restart the same service back to back, and nothing may loop forever: after `dailyCap` automatic
// restarts in 24 h the automatic ones that ask first (peer repair, L1+) stop and people are told. B6 only records (its own crash-loop
// guard already stops a tight loop). A plain crash respawn is recorded with { capped: false }: it starts a cooldown (nobody restarts a
// child that is just booting) but does not use up the daily cap. Intervals use a monotonic clock, so setting the wall clock cannot open a
// window early.
const monoMs = () => Number(process.hrtime.bigint() / 1000000n);

function createRestartBudget({ cooldownMs = 10 * 60000, dailyCap = 6, mono = monoMs, onGiveUp = () => {} } = {}) {
  const hist = new Map();        // svc -> [{ at (mono), source, capped }]
  const gaveUpNoted = new Map(); // svc -> mono of the last "gave up" notification
  const recent = (svc, t) => (hist.get(svc) || []).filter((h) => t - h.at < 86400000);

  function check(svc, { cooldown = cooldownMs, cap = dailyCap } = {}) {
    const t = mono(); const h = recent(svc, t); hist.set(svc, h);
    const counted = h.filter((x) => x.capped).length;
    if (counted >= cap) {
      if (t - (gaveUpNoted.get(svc) || -Infinity) > 3600000) { gaveUpNoted.set(svc, t); try { onGiveUp(svc, counted); } catch (_) { /* never break a check */ } }
      return { ok: false, why: 'gave-up', count: counted };
    }
    const last = h[h.length - 1];
    if (last && t - last.at < cooldown) return { ok: false, why: 'cooldown', lastSource: last.source, agoSec: Math.round((t - last.at) / 1000) };
    return { ok: true, count: counted };
  }
  function record(svc, source, { capped = true } = {}) { const t = mono(); const h = recent(svc, t); h.push({ at: t, source, capped: capped !== false }); hist.set(svc, h); }
  function status() {
    const t = mono(); const out = {};
    for (const [svc] of hist) out[svc] = recent(svc, t).map((h) => ({ source: h.source, capped: h.capped, agoSec: Math.round((t - h.at) / 1000) }));
    return out;
  }
  return { check, record, status };
}

module.exports = { createRestartBudget, monoMs };
