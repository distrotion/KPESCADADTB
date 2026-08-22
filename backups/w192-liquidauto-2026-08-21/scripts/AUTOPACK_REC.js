// script id: script_1787243319181 | name: AUTOPACK_REC | enabled: True
// trigger: {"type": "interval", "intervalMs": 200}

// AUTOPACK_REC — เก็บข้อมูลไลน์ LIQUID_AUTOPACK ลง sqlite (sqlite-first · sent=0 → AUTOPACK_DRAIN ส่งขึ้น .39)
//  1) RealtimeData: ST0x_CONFIRM ขอบ 0→1 = บันทึกน้ำหนัก ST0x หนึ่งรายการ
//     station='AL-ST0x' · weig=ค่า ST0x · code=LotNO · record_id=station-epochms · plant=LIQUID
//  2) FinalData: CounterFinal เปลี่ยนค่า = snapshot กลุ่ม FINALCHECK ทั้งชุด
const DEV = 'LIQUID_AUTOPACK';
await db.query('DATA', 'PRAGMA busy_timeout=3000');

// ── 1) Realtime: ขอบ 0→1 ของ CONFIRM แต่ละสถานี ──
if (!state.conf) state.conf = {};
for (let i = 1; i <= 4; i++) {
  const n = 'ST0' + i;
  const c = Number(tag(DEV, n + '_CONFIRM'));
  const prev = state.conf[n];
  state.conf[n] = c;
  if (prev === undefined) continue;            // tick แรกหลัง start — ตั้งฐานก่อน ไม่บันทึก (กันยิงซ้ำตอน restart ขณะ CONFIRM ค้าง 1)
  if (c === 1 && prev !== 1) {
    const w = tag(DEV, n);
    const lot = String(tag(DEV, 'LotNO') ?? '');
    const nowMs = Date.now();
    const station = 'AL-' + n;
    try {
      await db.query('DATA',
        'INSERT INTO RealtimeData (ts,station,weig,code,record_id,plant,sent) VALUES (?,?,?,?,?,?,0)',
        [new Date(nowMs).toISOString(), station, String(w == null ? '' : w), lot, station + '-' + nowMs, 'LIQUID']);
      // สำเนาลง kubotalog_backup (หน้า .34:7000 อ่าน) ทำโดย trigger ระดับ DB `trg_realtime_mirror` อัตโนมัติ
      // — ห้ามเพิ่ม INSERT kubotalog_backup ในสคริปต์ซ้ำ (จะได้แถวคู่ เพราะตารางนั้นไม่มี UNIQUE)
      log('RT บันทึก', station, w, 'lot', lot);
    } catch (e) { log('RealtimeData insert พลาด:', e.message); }
  }
}

// ── 2) Final: CounterFinal เปลี่ยนค่า ──
const cf = Number(tag(DEV, 'CounterFinal'));
if (state.lastCounter === undefined) {
  state.lastCounter = cf;                       // tick แรก — ตั้งฐาน ไม่บันทึก
} else if (cf !== state.lastCounter) {
  state.lastCounter = cf;
  const nowMs = Date.now();
  try {
    await db.query('DATA',
      'INSERT INTO FinalData (ts,counter_final,product_name_final,lot_no_final,barcode_final,vision_ok,vision_ng,weight_final,weight_ok,weight_ng,plant,record_id,sent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)',
      [new Date(nowMs).toISOString(), cf,
       Number(tag(DEV, 'ProductNameFinal')) || 0,
       String(tag(DEV, 'LotNoFinal') ?? ''),
       String(tag(DEV, 'BarcodeFinal') ?? ''),
       Number(tag(DEV, 'VisionOKFINAL')) || 0,
       Number(tag(DEV, 'VisionNGFINAL')) || 0,
       Number(tag(DEV, 'WeightFinal')) || 0,
       Number(tag(DEV, 'WeightOK')) || 0,
       Number(tag(DEV, 'WeightNG')) || 0,
       'LIQUID', 'LIQUID_AUTO-FC-' + nowMs]);
    log('FINAL บันทึก counter', cf);
  } catch (e) { log('FinalData insert พลาด:', e.message); }
}
