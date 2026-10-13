'use strict';
// Clock from neighbours (kpelink time peer). A station that cannot reach its time master - typically right after a power cut with the
// network down, when the Pi (no RTC battery) starts from the time systemd saved at shutdown - asks a neighbour whose own clock was
// verified against the master lately (beacon flag clockOk) for the time, over the same GATT write + read-back the row relay uses.
//   request : 'T' | nonce(16) | len(1) | station | HMAC(time key, 'kpe-time-req|' nonce station)[:16]
//   answer  : 'U' | epoch ms (8, big endian) | HMAC(time key, 'kpe-time-resp|' nonce epoch)[:16]
// The answer is bound to the request's nonce, so a recorded answer cannot be replayed and nobody without the plant key can forge one.
// Time travels at most one hop: a clock set from a neighbour does not count as verified (no clockOk), so it is never passed on.
const crypto = require('crypto');

const REQ = 0x54;       // 'T' - never the first byte of a row frame (version 1)
const RESP = 0x55;      // 'U'
const NONCE_LEN = 16;
const MAC_LEN = 16;
const STATION_RE = /^[A-Za-z0-9_-]{1,16}$/;
// the neighbour stamps its time before it acknowledges the write; the acknowledgement reaches us one BLE connection event later
const REPLY_LAG_MS = 25;

const timeKey = (plantKey) => crypto.createHash('sha256').update('kpe-mesh-time-v1|' + String(plantKey)).digest();
const mac = (key, parts) => crypto.createHmac('sha256', timeKey(key)).update(Buffer.concat(parts)).digest().subarray(0, MAC_LEN);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const toBuf = (x) => (Buffer.isBuffer(x) ? x : (typeof x === 'string' && /^([0-9a-f]{2})+$/i.test(x) ? Buffer.from(x, 'hex') : null));

const isTimeRequest = (frame) => { const b = toBuf(frame); return !!b && b.length > 0 && b[0] === REQ; };

function encodeTimeRequest(key, station, nonce = crypto.randomBytes(NONCE_LEN)) {
  if (!key) throw new Error('mesh key required');
  if (!STATION_RE.test(String(station))) throw new Error('bad station');
  const st = Buffer.from(String(station), 'utf8');
  return { frame: Buffer.concat([Buffer.from([REQ]), nonce, Buffer.from([st.length]), st, mac(key, [Buffer.from('kpe-time-req|'), nonce, st])]), nonce };
}

function decodeTimeRequest(input, key) {
  const bad = (why) => ({ ok: false, why });
  if (!key) return bad('no-key');
  const b = toBuf(input);
  if (!b || b.length < 1 + NONCE_LEN + 1 + 1 + MAC_LEN || b[0] !== REQ) return bad('format');
  const n = b[1 + NONCE_LEN];
  if (b.length !== 1 + NONCE_LEN + 1 + n + MAC_LEN) return bad('format');
  const nonce = b.subarray(1, 1 + NONCE_LEN);
  const st = b.subarray(2 + NONCE_LEN, 2 + NONCE_LEN + n);
  if (!same(b.subarray(b.length - MAC_LEN), mac(key, [Buffer.from('kpe-time-req|'), nonce, st]))) return bad('bad-auth');
  const station = st.toString('utf8');
  if (!STATION_RE.test(station)) return bad('station');
  return { ok: true, nonce: Buffer.from(nonce), station };
}

function encodeTimeResponse(key, nonce, epochMs) {
  const e = Buffer.alloc(8); e.writeBigUInt64BE(BigInt(Math.round(epochMs)));
  return Buffer.concat([Buffer.from([RESP]), e, mac(key, [Buffer.from('kpe-time-resp|'), nonce, e])]);
}

function decodeTimeResponse(input, key, nonce) {
  const bad = (why) => ({ ok: false, why });
  const b = toBuf(input);
  if (!key || !b || b.length !== 1 + 8 + MAC_LEN || b[0] !== RESP) return bad('format');
  const e = b.subarray(1, 9);
  if (!same(b.subarray(9), mac(key, [Buffer.from('kpe-time-resp|'), nonce, e]))) return bad('bad-auth');
  return { ok: true, epochMs: Number(e.readBigUInt64BE()) };
}

// answers -> one clock correction. Each answer: { from, epochMs, at } where `at` is OUR clock when the write was acknowledged.
// Two or more answers must agree within agreeMs, otherwise nothing is applied (one of the neighbours is wrong and we cannot tell which).
function combineAnswers(answers, { agreeMs = 2000 } = {}) {
  const ok = (answers || []).filter((a) => a && Number.isFinite(a.epochMs) && Number.isFinite(a.at));
  if (!ok.length) return { ok: false, why: 'no-answer' };
  const drifts = ok.map((a) => a.epochMs + REPLY_LAG_MS - a.at);
  const spread = Math.max(...drifts) - Math.min(...drifts);
  if (spread > agreeMs) return { ok: false, why: 'peers-disagree', spreadMs: Math.round(spread), from: ok.map((a) => a.from) };
  return { ok: true, driftMs: Math.round(drifts.reduce((s, d) => s + d, 0) / drifts.length), spreadMs: Math.round(spread), from: ok.map((a) => a.from) };
}

module.exports = { isTimeRequest, encodeTimeRequest, decodeTimeRequest, encodeTimeResponse, decodeTimeResponse, combineAnswers, timeKey, REPLY_LAG_MS };
