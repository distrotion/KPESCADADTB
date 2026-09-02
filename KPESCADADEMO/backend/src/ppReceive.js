// ppReceive.js — READ-ONLY connector: รับ FG (production internal incoming · §A2)
//   แหล่ง: SAP gateway POST http://172.23.10.168:14094/03iPPGETDATACHEM/GETDATA (PP process order)
//   หน้าที่: query ออเดอร์ผลิต → กรองเฉพาะ FG (ZCFG) → รับเข้า StoreFG (lot จาก production)
//   *** read-only · กรอง semi (ZCSM) ออก (semi=parked) · dedup ฝั่งเรา ***
//   demo: qty = TOTAL_QTY (แผน) · ของจริงจะมี SQL จำนวนส่งจริง (ต่อภายหลัง)

const { httpPostJson } = require('./sapReceive');   // reuse http POST JSON helper
const { parseTag } = require('./armConnector');     // reuse barcode [MATCODE 8][Lot] parser
const TtlCache = require('./ttlCache');

const DAY_MS = 86400000;
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round6(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }
function dmy(d) { const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; }

function mapUom(uom, base) {
  const u = String(uom || '').trim().toUpperCase(); const b = (String(base || '').trim()) || 'Kg';
  switch (u) {
    case 'KG': return { uom: 'Kg', factor: 1, ok: b === 'Kg' };
    case 'G': return { uom: 'Kg', factor: 0.001, ok: b === 'Kg' };
    case 'L': return { uom: 'L', factor: 1, ok: b === 'L' };
    case 'ML': return { uom: 'L', factor: 0.001, ok: b === 'L' };
    case 'BOT': case 'CON': case 'BOX': case 'BAG': case 'CAN': case 'PCS': case 'PC': case 'EA':
      return { uom: 'PCS', factor: 1, ok: b === 'PCS' };
    case '': return { uom: b, factor: 1, ok: true, assumedBase: true };
    default: return { uom: b, factor: 1, ok: false, raw: u };
  }
}
// finish date (dd.MM.yyyy) + shelfLife · PERIOD_IND_SLED M=เดือน(×30) Y=ปี(×365) อื่น=วัน
function calcExpiry(finishDate, shelf, period) {
  const m = String(finishDate || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/); const s = num(shelf);
  if (!m || s <= 0) return null;
  const days = s * (String(period).toUpperCase() === 'M' ? 30 : String(period).toUpperCase() === 'Y' ? 365 : 1);
  const t = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return Number.isFinite(t) ? t + days * DAY_MS : null;
}
const MTART = { ZCFG: 'finished', ZCSM: 'semi' };

// 1 HEADER_INFO → receive intent (pure) · resolveItem(matCode) → {baseUom, name}|null
function mapPpOrder(row, resolveItem) {
  const matCode = String(row.MATERIAL == null ? '' : row.MATERIAL).trim().replace(/^0+/, '');
  const procOrder = String(row.PROCESS_ORDER || '').trim();
  const itemType = MTART[String(row.MTART || '').trim()] || 'finished';
  const item = (typeof resolveItem === 'function' ? resolveItem(matCode) : null) || null;
  const warnings = [];
  if (!matCode) warnings.push('no-matcode');
  if (!item) warnings.push('master-missing');
  const um = mapUom(row.UOM, item ? item.baseUom : '');
  if (um.assumedBase) warnings.push('uom-blank-assumed-base'); else if (!um.ok) warnings.push('uom-' + (um.raw || 'mismatch'));
  const qty = round6(num(row.TOTAL_QTY) * um.factor);   // demo: TOTAL_QTY (แผน) · ของจริง=SQL ส่งจริง
  if (qty <= 0) warnings.push('no-qty');
  const status = String(row.SYSTEM_STATUS || '');
  const done = /\bDLV\b/.test(status);   // DLV = goods receipt แล้ว = ผลิตเสร็จ/พร้อมรับ
  return {
    procOrder, orderType: String(row.ORDER_TYPE || '').trim(),
    matCode, matName: String(row.MATERIAL_TEXT || '').trim(), itemType,
    qty, uom: um.uom, lotNo: String(row.BATCH || '').trim(),
    stgeLoc: String(row.STGE_LOC || '').trim(),   // → คลังปลายทาง (FG)
    expiry: calcExpiry(row.BASIC_FINISH_DATE, row.TOTAL_SHELF_LIFE, row.PERIOD_IND_SLED),
    finishDate: String(row.BASIC_FINISH_DATE || '').trim(), prodSup: String(row.PROD_SUP || '').trim(),
    done, masterExists: !!item, baseUom: item ? item.baseUom : '', warnings,
    masterStore: item ? (item.defaultLocation || '') : '',   // §store-loc: store ที่ master กำหนด (defaultLocation) → UI โชว์ "ตาม master → store"
  };
}

class PpReceive {
  constructor({ stock, url = 'http://172.23.10.168:14094/03iPPGETDATACHEM/GETDATA', plant = '1000' } = {}) {
    this.stock = stock; this.url = url; this.plant = plant; this.cache = new TtlCache();
    this._lastOkAt = 0;   // epoch ms ของ fetch สำเร็จ (มีข้อมูลจริง) ล่าสุด → widget โชว์ "last sync"
  }
  lastSyncAt() { return this._lastOkAt; }
  _ttl() { const c = (this.stock && this.stock.config) || {}; const m = Number(c.ppFeedMin); return (m > 0 ? m * 60 : (Number(c.extCacheTtlSec) || 300)) * 1000; }   // รอบ buffer PP (นาที · default 5) ปรับได้
  invalidate() { this.cache.clear(); }
  _resolveItem(mc) { try { const it = this.stock && this.stock.getItem ? this.stock.getItem(mc) : null; return it ? { baseUom: it.baseUom, name: it.name, defaultLocation: it.defaultLocation } : null; } catch (_) { return null; } }
  _map(rows) { return (rows || []).map((r) => { const m = mapPpOrder(r, (mc) => this._resolveItem(mc)); m.received = !!(this.stock && this.stock.ppIsReceived && this.stock.ppIsReceived(m.procOrder)); return m; }); }

  // query ออเดอร์ผลิต → FG เท่านั้น (กรอง semi) · doneOnly=เฉพาะ DLV (ผลิตเสร็จ)
  async listIncoming({ fromDate, toDate, fgOnly = true, doneOnly = true, kind = '', noCache = false } = {}) {
    const body = { HEADER: { PLANT: this.plant, ORD_ST_DATE_FR: fromDate, ORD_ST_DATE_TO: toDate, ORDER_TYPE: '', PROD_SUP: '' },
      PROC_ORD: [{ PROCESS_ORDER: '', MATERIAL: '' }] };
    const fetcher = async () => { const r = this._map(((await httpPostJson(this.url, body)) || {}).HEADER_INFO || []); if (r.length) this._lastOkAt = Date.now(); return r; };
    const key = `pp:${fromDate}:${toDate}`;
    let lines = await this.cache.getOrFetch(key, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });   // noCache=hard refresh (ดึงสด+เขียนทับ buffer)
    const want = kind === 'cm' ? 'semi' : (kind === 'fg' ? 'finished' : null);   // kind=cm → รับ C (semi · prefix 12) · concept เดียวกับ PPtoFG แค่ 11→12
    if (want) lines = lines.filter((l) => l.itemType === want);
    else if (fgOnly) lines = lines.filter((l) => l.itemType === 'finished');   // กรอง semi ออก (semi=parked)
    if (doneOnly) lines = lines.filter((l) => l.done);
    return lines;
  }
  // ยิง barcode [MATCODE][Lot] → หาออเดอร์ FG ที่ matCode+lot ตรง (filter MATERIAL + BATCH)
  async findByTag(scan, { fromDate, toDate, kind = 'fg' } = {}) {
    const { matCode, lot } = parseTag(scan);
    if (!matCode && !lot) return { matCode, lot, lines: [] };
    const now = new Date();
    const f = fromDate || dmy(new Date(now.getTime() - 30 * DAY_MS));
    const t = toDate || dmy(now);
    const body = { HEADER: { PLANT: this.plant, ORD_ST_DATE_FR: f, ORD_ST_DATE_TO: t, ORDER_TYPE: '', PROD_SUP: '' },
      PROC_ORD: [{ PROCESS_ORDER: '', MATERIAL: matCode || '' }] };   // filter MATERIAL ที่ SAP
    let lines = this._map(((await httpPostJson(this.url, body)) || {}).HEADER_INFO || []).filter((l) => l.itemType === (kind === 'cm' ? 'semi' : 'finished'));
    if (matCode) lines = lines.filter((l) => l.matCode === matCode);
    if (lot) lines = lines.filter((l) => l.lotNo.toUpperCase() === lot.toUpperCase());
    return { matCode, lot, lines };
  }
  // re-query หา PROCESS_ORDER เดียว (verify ก่อนรับ · ดึงสด)
  async getOrder(procOrder, { fromDate, toDate } = {}) {
    const lines = await this.listIncoming({ fromDate, toDate, fgOnly: false, doneOnly: false, noCache: true });
    return lines.find((l) => l.procOrder === String(procOrder)) || null;
  }
}

module.exports = { PpReceive, mapPpOrder, mapUom, calcExpiry, MTART };
