// pickingManager.js — Picking List (Delivery) สำหรับ "ขาย/ส่งมอบ" · concept เดียวกับ ARM
//   input ตอนนี้ = import จาก PDF (tools/import-picking-pdf.py) · อนาคต = API (เหมือน SAP incoming)
//   เก็บบรรทัดใน memory (re-import แทนที่) · dedup "ส่งมอบแล้ว" persist ที่ stockManager.pickingShipped
//   จำนวนที่จะเบิกขาย: deriveSaleQty (BT=นับขวด · อื่น=base/แปลงจากแพ็ก) · ตัด batch เจาะจง (ไม่ FEFO)
const { deriveSaleQty } = require('./pickingList');
const { parseTag } = require('./armConnector');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

class PickingManager {
  constructor({ stock } = {}) { this.stock = stock; this.lines = []; this.importedAt = null; this.source = ''; }

  // นำเข้าชุดใหม่ (แทนที่ทั้งหมด) · lines: [{ delivery, shipTo, shipToCode?, matCode, name, salesQty, salesUom, baseQty?, baseUom?, batch, expiry?, route?, lineId? }]
  import({ lines = [], source = 'pdf' } = {}) {
    this.lines = (Array.isArray(lines) ? lines : []).map((l, i) => this._norm(l, i));
    this.source = source; this.importedAt = Date.now();
    return { count: this.lines.length, deliveries: this.deliveries().length };
  }

  _norm(l, i) {
    const matCode = String(l.matCode == null ? '' : l.matCode).trim().replace(/^0+/, '');
    const q = deriveSaleQty({ matCode, name: l.name, salesQty: l.salesQty, salesUom: l.salesUom, baseQty: l.baseQty, baseUom: l.baseUom });
    const batch = String(l.batch || '').trim();
    const delivery = String(l.delivery || '').trim();
    const lineId = String(l.lineId || `${delivery}:${matCode}:${batch}:${i}`);
    return {
      lineId, delivery, shipTo: String(l.shipTo || '').trim(), shipToCode: String(l.shipToCode || '').trim(),
      matCode, name: String(l.name || '').trim(), batch,
      salesQty: num(l.salesQty), salesUom: String(l.salesUom || '').trim().toUpperCase(),
      baseQty: num(l.baseQty), baseUom: String(l.baseUom || '').trim(),
      qty: q.qty, uom: q.uom, basis: q.basis, packSize: q.packSize || null,
      expiry: String(l.expiry || '').trim(), route: String(l.route || '').trim(), warnings: q.warnings || [],
    };
  }

  // เติม flag master/shipped (อ่านตอน list)
  _enrich(l) {
    const item = this.stock && this.stock.getItem ? this.stock.getItem(l.matCode) : null;
    const shipped = !!(this.stock && this.stock.pickingIsShipped && this.stock.pickingIsShipped(l.lineId));
    return { ...l, masterExists: !!item, itemName: item ? item.name : l.name,
      shipped, shippedInfo: shipped ? this.stock.pickingGetShipped(l.lineId) : null };
  }

  list({ delivery = null, pendingOnly = false } = {}) {
    let r = this.lines.map((l) => this._enrich(l));
    if (delivery) r = r.filter((l) => l.delivery === delivery);
    if (pendingOnly) r = r.filter((l) => !l.shipped);
    return r;
  }

  // สรุปต่อ Delivery (ลูกค้า) — สำหรับเลือก/มอนิเตอร์
  deliveries() {
    const m = new Map();
    for (const l of this.lines) {
      if (!m.has(l.delivery)) m.set(l.delivery, { delivery: l.delivery, shipTo: l.shipTo, shipToCode: l.shipToCode, total: 0, shipped: 0 });
      const e = m.get(l.delivery); e.total++;
      if (this.stock && this.stock.pickingIsShipped && this.stock.pickingIsShipped(l.lineId)) e.shipped++;
    }
    return Array.from(m.values());
  }

  // ยิง barcode [MATCODE][batch] → บรรทัดที่ตรง (เหมือน ARM findByLot)
  findByTag(scan) {
    const { matCode, lot } = parseTag(scan);
    if (!matCode && !lot) return { matCode, lot, lines: [] };
    const lines = this.list().filter((l) =>
      (!matCode || l.matCode === matCode) &&
      (!lot || l.batch.toUpperCase() === lot.toUpperCase()));
    return { matCode, lot, lines };
  }

  getLine(lineId) { const l = this.lines.find((x) => x.lineId === String(lineId)); return l ? this._enrich(l) : null; }

  // live (version API): raw lines จาก gateway → normalize + enrich (qty/master/shipped) โดย "ไม่ import" (อ่านสด เหมือน ARM monitor)
  //   shipped/master อ่านจาก stockManager ตาม lineId (เสถียร) → flag ส่งแล้วถูกต้องแม้ไม่ได้ import
  enrich(rawLines) { return (Array.isArray(rawLines) ? rawLines : []).map((l, i) => this._enrich(this._norm(l, i))); }
  // กรองชุด live ด้วย scan (MATCODE+batch) + pendingOnly
  liveFilter(lines, { scan = '', pendingOnly = false } = {}) {
    let r = lines || [];
    const s = String(scan || '').trim();
    if (s) { const { matCode, lot } = parseTag(s); r = r.filter((l) => (!matCode || l.matCode === matCode) && (!lot || (l.batch || '').toUpperCase() === lot.toUpperCase())); }
    if (pendingOnly) r = r.filter((l) => !l.shipped);
    return r;
  }
}

module.exports = { PickingManager };
