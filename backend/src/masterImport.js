// masterImport.js — import/update master จากไฟล์ (Excel ตอนนี้ · API อนาคต) ผ่าน field-map layer
//   flow เดียว (source-agnostic): rows (Excel/API) → field-map (column→field) → sanitize → upsert by MATCODE
//   *** ภายใน Stock field ยังไม่ freeze → external I/O ต้องผ่าน field-map (constraint) ***
const XLSX = require('xlsx');

function num(v) { const n = Number(String(v == null ? '' : v).replace(/[, ]/g, '')); return Number.isFinite(n) ? n : null; }
// normalize header → key (trim · lower · ตัด space/._()-/ ออก) → จับ alias ได้แม้รูปแบบต่าง
function nk(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s._()/-]+/g, ''); }

// alias header(normalized) → internal field — default field-map (ครอบ Excel master เดิม + PackSTD)
const DEFAULT_ALIASES = {
  matcode: 'MATCODE', matcp: 'MATCODE', materialcode: 'MATCODE', material: 'MATCODE', 'รหัสสินค้า': 'MATCODE', 'รหัส': 'MATCODE',
  name: 'name', productname: 'name', itemname: 'name', 'ชื่อ': 'name', 'ชื่อสินค้า': 'name',
  itemtype: 'itemType', type: 'itemType', 'ประเภท': 'itemType',
  baseuom: 'baseUom', 'หน่วยฐาน': 'baseUom',
  group: 'group', 'กลุ่ม': 'group', itemcode: 'itemCode', sku: 'itemCode',
  defaultlocation: 'defaultLocation', location: 'defaultLocation', store: 'defaultLocation',
  status: 'status', 'สถานะ': 'status',
  shelflife: 'shelfLife', totalshelflife: 'shelfLife',                                       // Total shelf life
  openshelflife: 'openShelfLife', minshelflife: 'openShelfLife', minimumshelflife: 'openShelfLife',
  minremshelflife: 'openShelfLife', minremainingshelflife: 'openShelfLife',                  // Min. Rem. Shelf Life
  // หน่วยอายุ (period indicator · SAP PERIOD_IND_SLED/IPRKZ) D/W/M/Y → คุม shelfLife+openShelfLife
  periodindsled: 'shelfLifeUnit', iprkz: 'shelfLifeUnit', periodindicator: 'shelfLifeUnit', periodind: 'shelfLifeUnit',
  shelflifeunit: 'shelfLifeUnit', unitofshelflife: 'shelfLifeUnit',
  safetystock: 'safetyStock', lotcontrolled: 'lotControlled',
  // PackSTD (SOI8_RM_PackSTD_Master)
  package: 'packUnit', netweight: 'packSize', packsize: 'packSize', unit: 'packBaseUom',
  manufacturer: 'manufacturer', 'ผู้ผลิต': 'manufacturer', piccode: 'picCode', codename: 'codeName',
};

// อ่าน workbook (base64) → rows [{header:val}] (sheet แรก · แถวแรก = header · raw:false = ได้ string ตามที่เห็น)
function rowsFromBase64(b64, { sheet } = {}) {
  const wb = XLSX.read(b64, { type: 'base64' });
  const name = (sheet && wb.Sheets[sheet]) ? sheet : wb.SheetNames[0];
  if (!name) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false });
}

// field-mapped row → sanitized item (+ warnings)
function sanitizeItem(it) {
  const w = [];
  const o = { MATCODE: String(it.MATCODE == null ? '' : it.MATCODE).trim().replace(/^0+/, '') };   // SAP export = เลข 0 นำหน้า 18 หลัก → ตัดให้ตรง MATCODE จริง (เหมือน connector อื่น) ไม่งั้นสร้าง stub ซ้ำ
  if (it.name != null && String(it.name).trim()) o.name = String(it.name).trim();
  if (it.itemType != null && String(it.itemType).trim()) o.itemType = String(it.itemType).trim().toLowerCase();
  if (it.baseUom != null && String(it.baseUom).trim()) o.baseUom = String(it.baseUom).trim();
  for (const k of ['group', 'itemCode', 'defaultLocation', 'status', 'manufacturer', 'picCode', 'codeName']) if (it[k] != null && String(it[k]).trim()) o[k] = String(it[k]).trim();
  if (it.packUnit != null && String(it.packUnit).trim()) o.packUnit = String(it.packUnit).trim().toUpperCase().replace(/^DERUM$/, 'DRUM');   // normalize typo
  if (it.packBaseUom != null && String(it.packBaseUom).trim()) o.packBaseUom = String(it.packBaseUom).trim().toUpperCase();
  for (const k of ['packSize', 'safetyStock']) {
    if (it[k] == null || String(it[k]).trim() === '') continue;
    const n = num(it[k]); if (n != null) o[k] = n; else w.push(`${k} ไม่เป็นตัวเลข ("${it[k]}") — ข้าม`);
  }
  // shelfLife / openShelfLife(min) → "วัน" เสมอ
  //   1) ถ้ามีคอลัมน์หน่วย (period indicator D/W/M/Y) → แปลงตรง (แม่นยำ · เหมือน calcExpiry)
  //   2) ไม่มีหน่วย → เดา: ค่า < 60 = เดือน ×30 (ข้อมูลจริงเดือนสูงสุด 30 · วันต่ำสุด 720 → ช่องว่างกว้าง)
  const unit = String(it.shelfLifeUnit || '').trim().toUpperCase();
  const uf = (unit === 'Y' || unit === 'J') ? 365 : unit === 'M' ? 30 : unit === 'W' ? 7 : (unit === 'D' || unit === 'T') ? 1 : null;
  for (const k of ['shelfLife', 'openShelfLife']) {
    if (it[k] == null || String(it[k]).trim() === '') continue;
    const n = num(it[k]); if (n == null) { w.push(`${k} ไม่เป็นตัวเลข ("${it[k]}") — ข้าม`); continue; }
    o[k] = uf != null ? Math.round(n * uf) : ((n > 0 && n < 60) ? Math.round(n * 30) : n);
  }
  return { item: o, warnings: w };
}

// rows → items (field-map + sanitize + dedup by MATCODE · แถวหลังทับ)
function mapRows(rows, { aliases } = {}) {
  const al = aliases || DEFAULT_ALIASES;
  const items = new Map(); const warnings = []; let skipped = 0, merged = 0; const unknownCols = new Set();
  const fieldsSeen = {};   // field → ชื่อหัวคอลัมน์ที่จับได้ (โชว์ใน preview ว่า map อะไรได้บ้าง)
  let sawShelf = false, sawUnit = false;
  (rows || []).forEach((r, idx) => {
    const mapped = {};
    for (const [h, v] of Object.entries(r)) { const f = al[nk(h)]; if (f) { mapped[f] = v; if (!fieldsSeen[f]) fieldsSeen[f] = h; } else if (String(h).trim()) unknownCols.add(h); }
    if (String(mapped.shelfLife ?? '').trim() || String(mapped.openShelfLife ?? '').trim()) sawShelf = true;
    if (String(mapped.shelfLifeUnit ?? '').trim()) sawUnit = true;
    const { item, warnings: w } = sanitizeItem(mapped);
    if (!item.MATCODE) { skipped++; return; }
    w.forEach((x) => warnings.push(`แถว ${idx + 2}: ${x}`));
    const prev = items.get(item.MATCODE);
    if (prev) { Object.assign(prev, item); merged++; }   // MATCODE ซ้ำในไฟล์ → รวม field (non-empty ทับ · เก็บของที่อีกแถวมี) → upsert เดียว
    else items.set(item.MATCODE, item);
  });
  if (sawShelf && !sawUnit) warnings.unshift('⚠ ไม่พบคอลัมน์หน่วย shelf life (period indicator D/W/M/Y) → เดาหน่วย: ค่า < 60 = เดือน ×30');
  return { items: [...items.values()], warnings, skipped, merged, unknownCols: [...unknownCols], fieldsSeen };
}

module.exports = { rowsFromBase64, mapRows, sanitizeItem, DEFAULT_ALIASES, nk };
