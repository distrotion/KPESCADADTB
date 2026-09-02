// projectSections.js — แบ่งโปรเจกต์เป็น "section" สำหรับ export/import เลือกเฉพาะส่วน
//   chem-stock    = config/stock.json
//   line-recorder = config/lines/** + lineRecorder-data.json + lineRecorder-tracker.json
//   core          = config อื่น + layout/ + ports.json + datalog/
//   shared        = config/devices.json → พ่วงทุก section เสมอ (config อ้าง device/tag — กัน import แล้ว tag/device หาย)
const PROJECT_SECTIONS = ['core', 'chem-stock', 'line-recorder'];

// คืน section เจ้าของของ path (relative ใน zip เช่น 'config/stock.json', 'layout/x', 'ports.json')
function sectionOf(rel) {
  rel = String(rel).replace(/\\/g, '/');
  if (rel === 'config/devices.json') return 'shared';
  if (rel === 'config/stock.json') return 'chem-stock';
  if (rel.startsWith('config/lines/') || rel === 'config/lineRecorder-data.json' || rel === 'config/lineRecorder-tracker.json') return 'line-recorder';
  return 'core';   // config อื่น + layout/ + ports.json + datalog/
}

// parse query ?sections=a,b → list ที่รู้จัก · ว่าง = [] (= ทั้งหมด · backward compatible)
function parseSections(q) {
  const raw = String(q || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => PROJECT_SECTIONS.includes(s));
}

// path นี้รวมอยู่ใน selection มั้ย — sel=[] = ทั้งหมด · 'shared' เข้าทุกครั้ง
function includeRel(rel, sel) {
  if (!sel || !sel.length) return true;
  const owner = sectionOf(rel);
  return owner === 'shared' || sel.includes(owner);
}

module.exports = { PROJECT_SECTIONS, sectionOf, parseSections, includeRel };
