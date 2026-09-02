/**
 * modbusCodec — encode/decode ค่าตัวเลข ↔ Modbus register words (กลาง · pure functions)
 *
 * แยกจาก modbusDriver.js (§11.7) เพื่อให้ใช้ร่วมกันได้: modbus client เดิม + KPENETWORK
 * (server publish + client subscribe) → word-order ตรงกันทั้งเครือ กัน encode drift
 *
 * dataType:
 *   16-bit (1 reg):  INT16, UINT16, BOOL  (BIT จัดการนอก codec — read-modify-write)
 *   32-bit (2 reg):  INT32, UINT32, FLOAT32 (REAL)
 *   64-bit (4 reg):  INT64, UINT64, FLOAT64 (DOUBLE / LREAL)
 *
 * wordOrder (32/64-bit): 'ABCD' big-endian (default) · 'CDAB' word-swap · 'BADC' byte-swap · 'DCBA' little
 *
 * หมายเหตุ: codec คืน "ค่าดิบ" (ไม่คูณ scale / ไม่ปัดทศนิยม) — ตัวเรียกจัดการ scale/round เอง
 */

const WORD_COUNT = {
  INT16: 1, UINT16: 1, BOOL: 1, BIT: 1,
  INT32: 2, UINT32: 2, FLOAT32: 2, REAL: 2,
  INT64: 4, UINT64: 4, FLOAT64: 4, DOUBLE: 4, LREAL: 4,
};

function wordCount(dataType) {
  return WORD_COUNT[(dataType || 'INT16').toUpperCase()] || 1;
}

function signed16(raw) {
  return raw > 32767 ? raw - 65536 : raw;
}

/**
 * รวม register words (16-bit, big-endian จาก modbus-serial) → Buffer ตาม wordOrder
 */
function toBuffer(words, wordOrder) {
  const order = (wordOrder || 'ABCD').toUpperCase();
  const n = words.length;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeUInt16BE(words[i] & 0xFFFF, i * 2);

  if (order === 'ABCD') return buf;                 // big-endian ตามที่อ่าน
  if (order === 'DCBA') return Buffer.from(buf).reverse(); // little-endian เต็ม

  if (order === 'CDAB') {                            // word-swap
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.copy(out, (n - 1 - i) * 2, i * 2, i * 2 + 2);
    return out;
  }
  if (order === 'BADC') {                            // byte-swap ในแต่ละ word
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) { out[i * 2] = buf[i * 2 + 1]; out[i * 2 + 1] = buf[i * 2]; }
    return out;
  }
  return buf;
}

/** inverse ของ toBuffer — จัดลำดับ buffer big-endian กลับเป็น words ตาม wordOrder สำหรับเขียน */
function reorderForWrite(buf, wordOrder) {
  const order = (wordOrder || 'ABCD').toUpperCase();
  const n = buf.length / 2;
  if (order === 'ABCD') return buf;
  if (order === 'DCBA') return Buffer.from(buf).reverse();
  if (order === 'CDAB') {
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.copy(out, (n - 1 - i) * 2, i * 2, i * 2 + 2);
    return out;
  }
  if (order === 'BADC') {
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) { out[i * 2] = buf[i * 2 + 1]; out[i * 2 + 1] = buf[i * 2]; }
    return out;
  }
  return buf;
}

/** decode register words → ค่าดิบ (ไม่คูณ scale) */
function decodeWords(words, dataType, wordOrder) {
  const dt = (dataType || 'INT16').toUpperCase();
  const buf = toBuffer(words, wordOrder || 'ABCD');
  switch (dt) {
    case 'INT16':   return signed16(words[0]);
    case 'UINT16':  return words[0];
    case 'BOOL':    return words[0] ? 1 : 0;
    case 'INT32':   return buf.readInt32BE(0);
    case 'UINT32':  return buf.readUInt32BE(0);
    case 'FLOAT32':
    case 'REAL':    return buf.readFloatBE(0);
    case 'INT64':   return Number(buf.readBigInt64BE(0));
    case 'UINT64':  return Number(buf.readBigUInt64BE(0));
    case 'FLOAT64':
    case 'DOUBLE':
    case 'LREAL':   return buf.readDoubleBE(0);
    default:        return words[0];
  }
}

/** encode ค่าดิบ (ไม่หาร scale) → register words[] ตาม dataType + wordOrder */
function encodeValue(value, dataType, wordOrder) {
  const dt = (dataType || 'INT16').toUpperCase();
  const count = wordCount(dt);

  if (count === 1) {
    let v = Math.round(value);
    if (v < 0) v = v & 0xFFFF;       // signed → unsigned 16
    return [v & 0xFFFF];
  }

  const buf = Buffer.alloc(count * 2);
  switch (dt) {
    case 'INT32':   buf.writeInt32BE(Math.round(value), 0); break;
    case 'UINT32':  buf.writeUInt32BE(Math.round(value) >>> 0, 0); break;
    case 'FLOAT32':
    case 'REAL':    buf.writeFloatBE(value, 0); break;
    case 'INT64':   buf.writeBigInt64BE(BigInt(Math.round(value)), 0); break;
    case 'UINT64':  buf.writeBigUInt64BE(BigInt(Math.round(value)), 0); break;
    case 'FLOAT64':
    case 'DOUBLE':
    case 'LREAL':   buf.writeDoubleBE(value, 0); break;
  }
  const ordered = reorderForWrite(buf, wordOrder || 'ABCD');
  const words = [];
  for (let i = 0; i < count; i++) words.push(ordered.readUInt16BE(i * 2));
  return words;
}

module.exports = { WORD_COUNT, wordCount, signed16, toBuffer, reorderForWrite, decodeWords, encodeValue };
