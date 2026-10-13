'use strict';
// HMAC signing for the Pi mesh. Everything that crosses the air or a shared port is informational
// ("this station looks alive") and never a command, but a forged "alive" would hide a dead station,
// so every report and beacon is authenticated with a per-plant shared key.
const crypto = require('crypto');

// JSON with sorted keys at every level: signer and verifier must serialise identically
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function strip(obj) { const { hmac, ...rest } = obj || {}; return rest; }

function sign(obj, key) {
  return crypto.createHmac('sha256', String(key)).update(canonical(strip(obj))).digest('hex');
}

function verify(obj, key) {
  if (!key || !obj || typeof obj.hmac !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.hmac)) return false;
  const want = Buffer.from(sign(obj, key), 'hex');
  const got = Buffer.from(obj.hmac.toLowerCase(), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// short MAC for BLE beacons (31-byte advertising budget): first `len` bytes of HMAC-SHA256
function shortMac(buf, key, len = 8) {
  return crypto.createHmac('sha256', String(key)).update(buf).digest().subarray(0, len);
}
function verifyShortMac(buf, mac, key) {
  if (!key || !Buffer.isBuffer(mac) || mac.length < 4) return false;
  const want = shortMac(buf, key, mac.length);
  return crypto.timingSafeEqual(want, mac);
}

// The key is what stops a stranger forging beacons and relay frames; a beacon shows 18 bytes in clear plus a 64-bit MAC, so a guessable key can be found
// offline by anyone in radio range. Only a GENERATED secret is accepted: at least 32 hex characters (openssl rand -hex 16) or at least 43 base64url
// characters (openssl rand -base64 32), with enough different characters that it cannot be a pattern. Human passphrases are refused on purpose.
function keyStrongEnough(key) {
  const k = String(key || '');
  if (!(/^[0-9a-fA-F]{32,}$/.test(k) || /^[A-Za-z0-9_+\/=-]{43,}$/.test(k))) return false;
  if (new Set(k.toLowerCase()).size < 10) return false;
  for (let p = 1; p <= 16; p++) if (k.slice(p) === k.slice(0, -p)) return false;          // a repeating pattern such as 0123456789 over and over
  return true;
}

module.exports = { canonical, sign, verify, shortMac, verifyShortMac, keyStrongEnough };
