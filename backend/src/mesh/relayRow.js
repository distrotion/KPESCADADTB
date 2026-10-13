'use strict';
// A weigh row travelling through the mesh (T8). It is DATA that ends up in the production kubotalog
// table, so unlike a beacon it is encrypted (nobody in Bluetooth range can read it) and authenticated
// (AES-256-GCM with a key derived from the plant key - a frame nobody with the key made is refused),
// and validated strictly after decryption:
//   * only rows the origin itself would upload (etc IS NULL - VOID rows never travel, see docs/KUBOTALOG-DEDUP.md)
//   * the origin's own station value and record_id are kept unchanged (the unique index on record_id
//     at the server is what makes a double delivery harmless)
//   * every text field is whitelisted, the weight must look like a decimal number, the record_id must look like STATION-epochms
const crypto = require('crypto');

const MAX_FRAME_BYTES = 480;                                 // stays inside one ATT write with the default 517-byte MTU
const STATION_RE = /^[A-Za-z0-9_-]{1,16}$/;
const CODE_RE = /^[A-Za-z0-9_. \-]{0,32}$/;
const REASON_RE = /^[A-Za-z0-9_ .,:;@#()/\-]{0,64}$/;
const RECORD_ID_RE = /^([A-Za-z0-9_-]{1,16})-(\d{10,14})$/;
const ORIGIN_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_FUTURE_MS = 24 * 3600 * 1000;

// -> { ok: true, row } | { ok: false, why }
function validateRow(r, nowMs = Date.now()) {
  const bad = (why) => ({ ok: false, why });
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('row must be an object');
  if (typeof r.s !== 'string' || !STATION_RE.test(r.s)) return bad('station');
  // the weight stays the TEXT the station stored ('25.14'): the server column gets exactly what the station's own uploader would send
  const weig = typeof r.w === 'number' && Number.isFinite(r.w) ? String(r.w) : r.w;
  if (typeof weig !== 'string' || !/^-?\d{1,7}(\.\d{1,6})?$/.test(weig)) return bad('weight');
  const code = r.c == null ? '' : r.c;
  if (typeof code !== 'string' || !CODE_RE.test(code)) return bad('code');
  if (typeof r.r !== 'string' || r.r.length > 40) return bad('record_id');
  const m = RECORD_ID_RE.exec(r.r);
  if (!m || m[1] !== r.s) return bad('record_id');                     // STATION-epochms, and the station part must be this row's own station
  if (Number(m[2]) > nowMs + MAX_FUTURE_MS) return bad('record_id in the future');
  const reason = r.n == null ? '' : r.n;
  if (typeof reason !== 'string' || !REASON_RE.test(reason)) return bad('reason');
  if (r.etc != null && r.etc !== '') return bad('only live rows (etc IS NULL) may travel');
  return { ok: true, row: { station: r.s, weig, code, recordId: r.r, reason } };
}

const FRAME_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const relayKey = (plantKey) => crypto.createHash('sha256').update('kpe-mesh-relay-v1|' + String(plantKey)).digest();

// one row -> one encrypted, authenticated frame (Buffer) for one GATT write:  version(1) | nonce(12) | ciphertext | tag(16)
function encodeFrame({ origin, row, ts }, key) {
  if (!key) throw new Error('mesh key required');
  if (!ORIGIN_RE.test(String(origin))) throw new Error('bad origin');
  const plain = Buffer.from(JSON.stringify({ o: String(origin), t: ts, row: { s: row.station, w: row.weig, c: row.code || '', r: row.recordId, n: row.reason || '' } }), 'utf8');
  const nonce = crypto.randomBytes(NONCE_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', relayKey(key), nonce);
  c.setAAD(Buffer.from([FRAME_VERSION]));
  const buf = Buffer.concat([Buffer.from([FRAME_VERSION]), nonce, c.update(plain), c.final(), c.getAuthTag()]);
  if (buf.length > MAX_FRAME_BYTES) throw new Error('frame too large: ' + buf.length);
  return buf;
}

// frame bytes -> { ok, origin, ts, row } | { ok: false, why }   (authentication first, then strict validation)
function decodeFrame(input, key, nowMs = Date.now(), maxSkewMs = 24 * 3600 * 1000) {
  const bad = (why) => ({ ok: false, why });
  if (!key) return bad('no-key');
  const buf = Buffer.isBuffer(input) ? input : (typeof input === 'string' && /^([0-9a-f]{2})+$/i.test(input) ? Buffer.from(input, 'hex') : null);
  if (!buf || buf.length < 1 + NONCE_LEN + TAG_LEN + 2 || buf.length > MAX_FRAME_BYTES) return bad('length');
  if (buf[0] !== FRAME_VERSION) return bad('version');
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', relayKey(key), buf.subarray(1, 1 + NONCE_LEN));
    d.setAAD(Buffer.from([FRAME_VERSION]));
    d.setAuthTag(buf.subarray(buf.length - TAG_LEN));
    plain = Buffer.concat([d.update(buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN)), d.final()]);
  } catch (_) { return bad('bad-auth'); }
  let body; try { body = JSON.parse(plain.toString('utf8')); } catch (_) { return bad('json'); }
  if (!body || typeof body !== 'object') return bad('json');
  if (typeof body.o !== 'string' || !ORIGIN_RE.test(body.o)) return bad('origin');
  if (typeof body.t !== 'number' || !Number.isFinite(body.t) || Math.abs(nowMs - body.t) > maxSkewMs) return bad('clock-skew');
  const v = validateRow(body.row, nowMs);
  if (!v.ok) return bad('row: ' + v.why);
  return { ok: true, origin: body.o, ts: body.t, row: v.row };
}

// The relay proves it really stored a frame by returning HMAC(relay key, "ack" | nonce of that frame): a stranger's device that merely
// answers a BLE write cannot produce it, so the origin only treats a row as handed over when this matches.
const ackFor = (key, frame) => crypto.createHmac('sha256', relayKey(key)).update(Buffer.concat([Buffer.from('kpe-relay-ack|'), frame.subarray(1, 1 + NONCE_LEN)])).digest().subarray(0, 16);
function ackMatches(key, frame, ackHex) {
  if (typeof ackHex !== 'string' || !/^[0-9a-f]{32}$/i.test(ackHex)) return false;
  const want = ackFor(key, frame); const got = Buffer.from(ackHex, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { validateRow, encodeFrame, decodeFrame, ackFor, ackMatches, MAX_FRAME_BYTES };
