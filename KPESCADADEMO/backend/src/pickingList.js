// pickingList.js — ตีความ "จำนวนที่จะเบิกขาย" จากบรรทัด SAP Picking List (Delivery)
//   ใบให้มาเป็น "หน่วยใหญ่" (S.Unit: BAG/BT/CON/CAN) · ขนาดแพ็กฝังในชื่อ (เช่น |25 KG · (100 ML./BT.))
//   กฎ: ตระกูล BT (ขวด) นับเป็น "ขวด" เสมอ — ไม่แปลงเป็น ML/L · อื่น ๆ แปลงเป็นหน่วยฐาน (KG/L)
//   *** read/parse ฝั่งเรา (field-map layer) · ไม่ยุ่ง SAP ***

function round6(n) { return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6; }

// หน่วยฐาน canonical: KG→Kg · G→Kg(×0.001) · L/LT→L · ML→L(×0.001)
function mapUom(raw) {
  const u = String(raw || '').trim().toUpperCase();
  switch (u) {
    case 'KG': return { uom: 'Kg', factor: 1 };
    case 'G': return { uom: 'Kg', factor: 0.001 };
    case 'L': case 'LT': return { uom: 'L', factor: 1 };
    case 'ML': return { uom: 'L', factor: 0.001 };
    default: return { uom: u || '', factor: 1 };
  }
}

// แพ็กไซส์จากชื่อ: เลข+หน่วย (KG/G/L/LT/ML) หลัง | หรือใน (...) — คืน {size, uom} เป็นหน่วยฐาน · ไม่เจอ=null
function parsePackSize(name) {
  const m = /(\d+(?:\.\d+)?)\s*(KG|G|L|LT|ML)\b/i.exec(String(name || ''));
  if (!m) return null;
  const mu = mapUom(m[2]);
  return { size: round6(parseFloat(m[1]) * mu.factor), uom: mu.uom, raw: `${m[1]} ${m[2].toUpperCase()}` };
}

// ตระกูล BT (ขวด) ไหม — จาก S.Unit หรือชื่อ ( …/BT. )
function isBottle(salesUom, name) {
  const su = String(salesUom || '').trim().toUpperCase();
  if (su === 'BT' || su === 'BOT' || su === 'BOTTLE') return true;
  return /\/\s*BT\b|\bBT\.\b/i.test(String(name || ''));
}

// คำนวณจำนวนที่จะเบิกขาย 1 บรรทัด → { qty, uom, basis, packSize?, warnings[] }
//   line: { matCode, name, salesQty, salesUom, baseQty?, baseUom? }
//   basis: 'bottle-count' (BT) · 'list-base' (ใบให้ base มา) · 'name-pack' (แปลงจากแพ็กในชื่อ) · 'sales-asis' (แปลงไม่ได้)
function deriveSaleQty(line = {}) {
  const sq = Number(line.salesQty) || 0;
  const su = String(line.salesUom || '').trim().toUpperCase();
  const warnings = [];
  if (sq <= 0) warnings.push('no-qty');

  // 1) ตระกูล BT → นับเป็นขวดเสมอ (ไม่แปลง)
  if (isBottle(su, line.name)) {
    return { qty: round6(sq), uom: 'BT', basis: 'bottle-count', packSize: null, warnings };
  }
  // 2) ใบให้ base qty มาตรง ๆ (ชั่ง KG/L) → ใช้เลย
  const bq = Number(line.baseQty) || 0;
  if (bq > 0) {
    const bu = mapUom(line.baseUom);
    return { qty: round6(bq * bu.factor), uom: bu.uom || String(line.baseUom || ''), basis: 'list-base', packSize: null, warnings };
  }
  // 3) แปลงจากแพ็กในชื่อ × S.qty
  const pk = parsePackSize(line.name);
  if (pk) {
    return { qty: round6(sq * pk.size), uom: pk.uom, basis: 'name-pack', packSize: pk.size, packUom: pk.uom, warnings };
  }
  // 4) แปลงไม่ได้ — คืนหน่วยขายตามใบ + เตือน
  warnings.push('no-pack-no-base');
  return { qty: round6(sq), uom: su, basis: 'sales-asis', packSize: null, warnings };
}

module.exports = { deriveSaleQty, parsePackSize, isBottle, mapUom };
