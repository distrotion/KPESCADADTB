// Revision ของไฟล์ layout (working) — กันแท็บที่ถือ layout เก่ากว่าไฟล์ PUT ทับของใหม่
//   rev = hash เนื้อหาไฟล์ (เปลี่ยนทุกครั้งที่เขียน ไม่ว่าทางไหน: PUT / widget-config / import project)
//   GET /api/layout คืน rev → PUT ส่งกลับมาใน header x-layout-rev → ไม่ตรงไฟล์ปัจจุบัน = 409 stale
const crypto = require('crypto');
const fs = require('fs');

const NO_FILE_REV = 'none';   // ยังไม่มีไฟล์ layout (migrate ครั้งแรกจาก localStorage ต้องส่งค่านี้)

function revOfText(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// อ่านไฟล์ layout พร้อม rev → { text: string|null, rev }
function readLayoutWithRev(file) {
  if (!fs.existsSync(file)) return { text: null, rev: NO_FILE_REV };
  const text = fs.readFileSync(file, 'utf8');
  return { text, rev: revOfText(text) };
}

// ตัดสินว่า PUT /api/layout เขียนได้ไหม → null = ผ่าน · { status, body } = ปฏิเสธ
//   1) มีคนอื่นถือ edit lock → 409 (เหมือนเดิม)
//   2) ผู้เรียกถือ lock เอง → ผ่าน (editor เป็นเจ้าของ layout ระหว่างแก้)
//   3) ไม่มีใครถือ lock → ต้องส่ง rev ที่ตรงกับไฟล์ปัจจุบัน (แท็บโหมดดู/สคริปต์ curl ต้อง GET ก่อน)
function checkLayoutPut({ editLock, lockHeader, baseRev, currentRev }) {
  if (editLock && lockHeader !== editLock.id) {
    return { status: 409, body: { ok: false, error: 'มีผู้แก้ไขคนอื่นถือสิทธิ์อยู่', holder: editLock } };
  }
  if (editLock) return null;
  if (!baseRev) {
    return { status: 428, body: { ok: false, error: 'ต้องส่ง header x-layout-rev (ค่า rev จาก GET /api/layout)', rev: currentRev } };
  }
  if (baseRev !== currentRev) {
    return { status: 409, body: { ok: false, stale: true, error: 'layout บน server ใหม่กว่าที่แท็บนี้โหลดไว้ — โหลดใหม่ก่อนบันทึก', rev: currentRev } };
  }
  return null;
}

module.exports = { NO_FILE_REV, revOfText, readLayoutWithRev, checkLayoutPut };
