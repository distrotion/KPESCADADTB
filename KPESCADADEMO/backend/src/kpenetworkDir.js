/**
 * kpenetworkDir (§55 P7 แบบจำกัด) — encode/decode "directory" ↔ Modbus register block
 *   ใช้เมื่อ directoryMode = 'modbus'/'both' → ฝังสารบัญ tag ใน register แทน REST (เปิด port เดียว)
 *
 *   ⚠️ ข้อจำกัด (โหมด modbus): **เฉพาะ tag ตรง (hops===0)** · ไม่รองรับ relay (origin/path/hops)
 *      · ไม่มี TLS · ชื่อ/tagId จำกัด 32 ตัวอักษร (ASCII-pack 2 ตัว/word)
 *   📌 P7 เต็ม (เผื่อทำต่อ): ใส่ name แยกจาก tagId, รองรับ relay (เข้ารหัส origin/path เป็น record เสริม),
 *      versioning record-format, ข้อความ unicode (UTF-8 length-prefixed) — ดู note ใน SESSION-HANDOFF §55
 *
 *   Register layout (16-bit words · base = DIR_BASE):
 *     [0] MAGIC(0x4B50 "KP")  [1] VERSION  [2] count N  [3] reserved
 *     ต่อ entry (REC_WORDS words):
 *       [0..15] tagId ASCII (2 ตัว/word · hi=ตัวแรก · null-terminated)
 *       [16] area(0 holding/1 input/2 coil/3 discrete)  [17] address  [18] words
 *       [19] dtCode  [20] writable(0/1)  [21] scale float32 hi  [22] scale float32 lo  [23] reserved
 */

const DIR_BASE = 9000;
const MAGIC = 0x4B50;        // "KP"
const VERSION = 1;
const HEADER_WORDS = 4;
const TAGID_WORDS = 16;      // 32 chars
const REC_WORDS = 24;
const DT_LIST = ['INT16', 'UINT16', 'BOOL', 'INT32', 'UINT32', 'FLOAT32', 'REAL', 'INT64', 'UINT64', 'FLOAT64', 'DOUBLE', 'LREAL'];
const AREA_LIST = ['holding', 'input', 'coil', 'discrete'];

function _packStr(str, words) {
  const out = new Array(words).fill(0);
  const s = String(str);
  for (let i = 0; i < words * 2; i++) {
    const ch = i < s.length ? (s.charCodeAt(i) & 0xFF) : 0;
    const w = i >> 1;
    if (i % 2 === 0) out[w] |= (ch << 8); else out[w] |= ch;
  }
  return out;
}
function _unpackStr(regs, off, words) {
  let s = '';
  for (let i = 0; i < words; i++) {
    const w = regs[off + i] & 0xFFFF;
    const c0 = (w >> 8) & 0xFF; const c1 = w & 0xFF;
    if (c0 === 0) return s; s += String.fromCharCode(c0);
    if (c1 === 0) return s; s += String.fromCharCode(c1);
  }
  return s;
}
function _encFloat(v) { const b = Buffer.alloc(4); b.writeFloatBE(Number(v) || 0, 0); return [b.readUInt16BE(0), b.readUInt16BE(2)]; }
function _decFloat(hi, lo) { const b = Buffer.alloc(4); b.writeUInt16BE(hi & 0xFFFF, 0); b.writeUInt16BE(lo & 0xFFFF, 2); return b.readFloatBE(0); }

// entries (จาก server._build) → register array (index 0 = DIR_BASE) · เฉพาะ tag ตรง (hops===0)
function encode(entries) {
  const direct = (entries || []).filter((e) => (e.hops || 0) === 0);
  const regs = [MAGIC, VERSION, direct.length & 0xFFFF, 0];
  for (const e of direct) {
    const rec = new Array(REC_WORDS).fill(0);
    const id = _packStr(String(e.tag).slice(0, TAGID_WORDS * 2), TAGID_WORDS);
    for (let i = 0; i < TAGID_WORDS; i++) rec[i] = id[i];
    rec[16] = Math.max(0, AREA_LIST.indexOf(e.area));
    rec[17] = e.address & 0xFFFF;
    rec[18] = (e.words || 1) & 0xFFFF;
    rec[19] = Math.max(0, DT_LIST.indexOf((e.dataType || 'INT16').toUpperCase()));
    rec[20] = e.writable ? 1 : 0;
    const sc = _encFloat(e.scale || 1); rec[21] = sc[0]; rec[22] = sc[1];
    for (const w of rec) regs.push(w & 0xFFFF);
  }
  return regs;
}

// register array (index 0 = DIR_BASE) → entries (null ถ้า magic ผิด)
function decode(regs) {
  if (!regs || regs.length < HEADER_WORDS || (regs[0] & 0xFFFF) !== MAGIC) return null;
  const count = regs[2] & 0xFFFF;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = HEADER_WORDS + i * REC_WORDS;
    if (off + REC_WORDS > regs.length) break;
    const tag = _unpackStr(regs, off, TAGID_WORDS);
    if (!tag) continue;
    entries.push({
      tag, name: tag,
      area: AREA_LIST[regs[off + 16] & 0xFFFF] || 'holding',
      address: regs[off + 17] & 0xFFFF,
      words: (regs[off + 18] & 0xFFFF) || 1,
      dataType: DT_LIST[regs[off + 19] & 0xFFFF] || 'INT16',
      writable: (regs[off + 20] & 0xFFFF) === 1,
      scale: _decFloat(regs[off + 21], regs[off + 22]),
      origin: '', path: [], hops: 0,
    });
  }
  return entries;
}

function dirWordCount(count) { return HEADER_WORDS + count * REC_WORDS; }

module.exports = { DIR_BASE, MAGIC, VERSION, HEADER_WORDS, REC_WORDS, encode, decode, dirWordCount };
