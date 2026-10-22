// decode กลุ่ม bit ต่อเนื่อง (MULTI_BIT) → ค่า ตาม mode · ใช้ร่วมทุก driver (MC/FINS/Modbus parity)
//   'decimal' (เดิม)    : ฐาน 2 · bit0 = LSB → sum 2^i   (on on off → 1+2 = 3)
//   'sequence' (ลำดับ)  : นับ ON ต่อเนื่องจาก bit0 · ถ้ามี ON หลัง OFF (ข้ามลำดับ) = 0
//      1 1 0 0 0 → 2   ·   1 1 1 0 0 → 3   ·   1 0 1 0 0 → 0 (ข้าม)   ·   0 .... → 0
function decodeMultiBit(bits, mode) {
  if (String(mode || '').toLowerCase() === 'sequence') {
    let count = 0, gap = false;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) { if (gap) return 0; count++; }   // ON หลังเจอ OFF = ข้ามลำดับ → 0
      else gap = true;
    }
    return count;
  }
  let v = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) v += 2 ** i;   // decimal (default)
  return v;
}
module.exports = { decodeMultiBit };
