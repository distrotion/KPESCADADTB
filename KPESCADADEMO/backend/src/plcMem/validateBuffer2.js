// plcMem/validateBuffer2.js — validate + normalize {values:[...]} สำหรับ PUT/POST buffer2
//   ใช้ร่วมกันระหว่าง routes.js (local) และ server.js (kpenetwork mirror) — กันสอง path ตรวจไม่ตรงกัน
//   (เคยเกิดมาแล้วกับ AREAS ก่อนรวมมาที่ constants.js — ดู commit review finding #2)
//
//   review finding #1/#4: width (1/2/4 = จำนวนคำของ UINT16/INT32-FLOAT32/INT64-FLOAT64) ต้องส่งคำ
//   ต่อเนื่องมาให้ครบในคำขอเดียวกันเสมอ — ไม่งั้นค่า multi-word จะถูกเขียนแค่ครึ่งเดียว (ค่า torn)
//   โดยที่ diff()/groupRuns() ฝั่ง store มองไม่เห็นปัญหานี้เลยเพราะที่มันเห็นคือ "มีแค่ address เดียว"
const { AREAS, MAX_ADDR } = require('./constants');

const VALID_WIDTHS = [1, 2, 4];

// values: [{area, addr, value, width?}] · actor: ใส่ลง updatedBy ของทุกแถว (resolve ฝั่ง server เสมอ)
// คืน rows ที่ normalize แล้ว [{area, addr, value, width, updatedBy}] หรือ throw Error พร้อมข้อความอ่านง่าย
function validateBuffer2Rows(values, actor) {
  if (!Array.isArray(values) || !values.length) throw new Error('values ต้องเป็น array ไม่ว่าง');

  const rows = values.map((v) => {
    const area = String((v && v.area) || '').toUpperCase();
    const addr = Number(v && v.addr);
    const value = Number(v && v.value);
    const width = v && v.width != null ? Number(v.width) : 1;
    if (!AREAS.includes(area)) throw new Error(`area ไม่ถูกต้อง: "${v && v.area}"`);
    if (!Number.isInteger(addr) || addr < 0) throw new Error(`addr ไม่ถูกต้อง: ${v && v.addr}`);
    if (addr > MAX_ADDR) throw new Error(`addr เกิน 0x${MAX_ADDR.toString(16)} (address 3 byte ตาม MC 3E protocol): ${v && v.addr}`);
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) throw new Error(`value ต้องเป็น UINT16 0..65535: ${v && v.value}`);
    if (!VALID_WIDTHS.includes(width)) throw new Error(`width ต้องเป็น 1, 2 หรือ 4 เท่านั้น (ได้ ${v && v.width})`);
    return { area, addr, value, width, updatedBy: actor };
  });

  // width>1 ต้องมีคำต่อเนื่อง (addr+1..addr+width-1, area เดียวกัน) อยู่ใน "ชุดเดียวกัน" นี้เสมอ —
  // ปฏิเสธทั้ง batch ถ้าไม่ครบ (all-or-nothing) ดีกว่าเขียนครึ่งเดียวแล้วรอ groupRuns ไปแก้ทีหลัง
  const byKey = new Map(rows.map((r) => [`${r.area}:${r.addr}`, r]));
  for (const r of rows) {
    if (r.width <= 1) continue;
    for (let k = 1; k < r.width; k++) {
      const key = `${r.area}:${r.addr + k}`;
      if (!byKey.has(key)) {
        throw new Error(`width=${r.width} ที่ ${r.area}${r.addr} ต้องส่งคำต่อเนื่องมาด้วยในคำขอเดียวกัน (ขาด ${r.area}${r.addr + k})`);
      }
    }
  }
  return rows;
}

module.exports = { validateBuffer2Rows, VALID_WIDTHS };
