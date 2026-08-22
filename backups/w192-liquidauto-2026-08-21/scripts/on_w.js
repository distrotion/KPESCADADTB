// script id: script_1782965728418 | name: on_w | enabled: True
// trigger: {"type": "interval", "intervalMs": 1000}

// on_w — ACTIVE_W = พร้อมทำงาน (loadcell + liquid2 online)
// มี debounce เฉพาะขา "ดับ" กัน blip สั้น ๆ ตัดไฟจริงแล้วงูกินหาง (USB_LOADCELL หลุด -> ACTIVE_W=0 -> ตัดไฟ -> USB_LOADCELL หลุดถาวร)
// เสียต้องต่อเนื่องครบ 20 วิ ถึงจะสั่งดับจริง · กลับมาออนไลน์ = ขึ้น 1 ทันที ไม่หน่วง
const OFF_DELAY_MS = 20000;
const ok = tag('USB_LOADCELL', '__online') === 1 && tag('liquid2', '__online') === 1;

if (ok) {
  state.badSince = null;
  setTag('GPIO', 'ACTIVE_W', 1);
} else {
  if (state.badSince == null) state.badSince = now();
  if (now() - state.badSince >= OFF_DELAY_MS) {
    setTag('GPIO', 'ACTIVE_W', 0);
  }
  // ยังไม่ครบ 20 วิ — ปล่อย ACTIVE_W ไว้ตามค่าเดิม (ไม่แตะ)
}
