// script id: script_1787242042712 | name: WEIGHT_RT_MIRROR | enabled: True
// trigger: {"type": "interval", "intervalMs": 2000}

// WEIGHT_RT_MIRROR — copy Weight_RT01-04 จาก .34:3012 (ผ่าน liquid2 kpenetwork) เข้า LIQUID_AUTOPACK.WEIGHT_RT0x
//   เขียนทุก tick เสมอ (ไม่เช็คว่าเปลี่ยนไหม) — เพราะ PLC ฝั่งปลายทางเคยเคลียร์ค่าเราเองอยู่นอกเหนือควบคุม
//   (เจอกับ RTNO มาก่อน) ถ้าเช็ค "เปลี่ยนไหม" แล้วข้าม จะไม่มีทางแก้ค่าที่ถูกเคลียร์ไปคืนให้
const DEV_SRC = 'liquid2';
const DEV_DST = 'LIQUID_AUTOPACK';
const MAP = { 'Liquid.Weight_RT01':'WEIGHT_RT01', 'Liquid.Weight_RT02':'WEIGHT_RT02',
              'Liquid.Weight_RT03':'WEIGHT_RT03', 'Liquid.Weight_RT04':'WEIGHT_RT04' };

for (const [srcId, dstId] of Object.entries(MAP)) {
  const v = tag(DEV_SRC, srcId);
  if (v == null) continue;
  await writeTag(DEV_DST, dstId, v);
}
