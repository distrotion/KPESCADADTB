'use strict';
// Beacon codec for the Pi mesh.
//
// Budget: this hardware does legacy advertising only (31 bytes per packet, no extended adv), and the
// packet is one manufacturer-specific AD structure:  len | 0xFF | company id (2) | payload.
// Company id 0xFFFF is the reserved "internal use" id. The payload is PAYLOAD_LEN = 26 bytes, so the
// whole AD structure is 1 + 1 + 2 + 26 = 30 bytes and one spare byte is left.
//
// payload (big endian):
//    0      ver << 4 | flags        ver = 1 · flags: 1 wifi (centre reachable) · 2 recording · 4 clockOk · 8 relay
//    1-2    sid                     station number; the peers map in mesh.json turns it into a name
//    3      boot                    restart counter: +1 at every start of the node (kept in a file), so it only moves forward; a new value restarts `ctr`
//    4-5    ctr                     bumped on every refresh, wraps at 65536
//    6-7    unsent                  rows waiting to upload; saturates at 0xFFFE; 0xFFFF = unknown
//    8-9    lastRecAgeMin           minutes since the last row was recorded; saturates; 0xFFFF = unknown
//    10-11  uptimeH                 hours since boot; saturates; 0xFFFF = unknown
//    12-17  gossip                  2 x { sid u16, age u8 } — neighbours this node heard lately; sid 0 = empty
//    18-25  mac                     first 8 bytes of HMAC-SHA256(key, payload[0..17])
//
// A beacon is information, never a command: nothing in it can make another station do anything.
const { shortMac, verifyShortMac } = require('./meshCrypto');

const VER = 1;
const PAYLOAD_LEN = 26;
const BODY_LEN = 18;
const MAC_LEN = 8;
const COMPANY_ID = 0xFFFF;
const UNKNOWN = 0xFFFF;
const MAX_KNOWN = 0xFFFE;
const GOSSIP_SLOTS = 2;
const GOSSIP_AGE_UNIT_SEC = 10;
const FLAG = { wifi: 1, recording: 2, clockOk: 4, relay: 8 };

const clampU16 = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? UNKNOWN : Math.min(MAX_KNOWN, Math.floor(Number(v))));
const unknownToNull = (v) => (v === UNKNOWN ? null : v);

// two counters: how far `cur` is ahead of `prev` (0 = same beacon heard again, 1..32767 = newer,
// 32768.. = older, i.e. a replay or a reordered packet)
function ctrDelta(prev, cur) { return ((cur - prev) & 0xFFFF) >>> 0; }
const isNewer = (prev, cur) => { const d = ctrDelta(prev, cur); return d >= 1 && d <= 0x7FFF; };

function encode(b, key) {
  if (!key) throw new Error('mesh key required to build a beacon');
  const sid = Number(b.sid);
  if (!Number.isInteger(sid) || sid < 1 || sid > 0xFFFE) throw new Error('sid must be 1..65534');
  const flags = (b.wifi ? FLAG.wifi : 0) | (b.recording ? FLAG.recording : 0) | (b.clockOk ? FLAG.clockOk : 0) | (b.relay ? FLAG.relay : 0);
  const buf = Buffer.alloc(PAYLOAD_LEN);
  buf.writeUInt8(((VER & 0x0F) << 4) | flags, 0);
  buf.writeUInt16BE(sid, 1);
  buf.writeUInt8((Number(b.boot) || 0) & 0xFF, 3);
  buf.writeUInt16BE((Number(b.ctr) || 0) & 0xFFFF, 4);
  buf.writeUInt16BE(clampU16(b.unsent), 6);
  buf.writeUInt16BE(clampU16(b.lastRecordAgeMin), 8);
  buf.writeUInt16BE(b.uptimeMin == null ? UNKNOWN : clampU16(Math.floor(Number(b.uptimeMin) / 60)), 10);
  const gossip = Array.isArray(b.gossip) ? b.gossip : [];
  for (let i = 0; i < GOSSIP_SLOTS; i++) {
    const g = gossip[i];
    const at = 12 + i * 3;
    if (g && Number.isInteger(g.sid) && g.sid >= 1 && g.sid <= 0xFFFE && g.sid !== sid) {
      buf.writeUInt16BE(g.sid, at);
      buf.writeUInt8(Math.max(0, Math.min(0xFF, Math.round(Math.max(0, Number(g.ageSec) || 0) / GOSSIP_AGE_UNIT_SEC))), at + 2);
    }
  }
  shortMac(buf.subarray(0, BODY_LEN), key, MAC_LEN).copy(buf, BODY_LEN);
  return buf;
}

// -> { ok: true, beacon } | { ok: false, reason: 'length' | 'version' | 'mac' | 'sid' }
function decode(input, key) {
  const buf = Buffer.isBuffer(input) ? input : (typeof input === 'string' && /^([0-9a-f]{2})+$/i.test(input) ? Buffer.from(input, 'hex') : null);
  if (!buf || buf.length !== PAYLOAD_LEN) return { ok: false, reason: 'length' };
  const head = buf.readUInt8(0);
  if ((head >> 4) !== VER) return { ok: false, reason: 'version' };
  if (!verifyShortMac(buf.subarray(0, BODY_LEN), buf.subarray(BODY_LEN, PAYLOAD_LEN), key)) return { ok: false, reason: 'mac' };
  const sid = buf.readUInt16BE(1);
  if (sid < 1 || sid > 0xFFFE) return { ok: false, reason: 'sid' };
  const gossip = [];
  for (let i = 0; i < GOSSIP_SLOTS; i++) {
    const gs = buf.readUInt16BE(12 + i * 3);
    if (gs >= 1 && gs !== sid) gossip.push({ sid: gs, ageSec: buf.readUInt8(14 + i * 3) * GOSSIP_AGE_UNIT_SEC });
  }
  const uptimeH = unknownToNull(buf.readUInt16BE(10));
  return {
    ok: true,
    beacon: {
      ver: head >> 4, sid, boot: buf.readUInt8(3), ctr: buf.readUInt16BE(4),
      wifi: !!(head & FLAG.wifi), recording: !!(head & FLAG.recording), clockOk: !!(head & FLAG.clockOk), relay: !!(head & FLAG.relay),
      unsent: unknownToNull(buf.readUInt16BE(6)), lastRecordAgeMin: unknownToNull(buf.readUInt16BE(8)),
      uptimeMin: uptimeH == null ? null : uptimeH * 60, gossip,
    },
  };
}

module.exports = { encode, decode, ctrDelta, isNewer, VER, PAYLOAD_LEN, BODY_LEN, MAC_LEN, COMPANY_ID, UNKNOWN, MAX_KNOWN, GOSSIP_SLOTS, FLAG };
