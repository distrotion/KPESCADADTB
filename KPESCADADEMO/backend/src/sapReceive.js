// sapReceive.js — READ-ONLY connector: incoming from SAP (รับเข้า §A2)
//   แหล่ง: SAP gateway POST http://172.23.10.168:14090/DATAGW/QMI002GET (QM inspection lot + usage decision)
//   หน้าที่: query INSP_LOT (goods receipt + QC) → แปลงเป็น "receive intent" → สร้าง lot ใน StoreRM/FG
//   *** read-only (query) · ไม่เขียนกลับ SAP · บันทึก dedup ฝั่งเราเอง ***
//
//   field map (เคาะ 2026-06-16): MATERIAL(ตัดศูนย์)=MATCODE · MAT_DESC=ชื่อ · BATCH=lotNo
//     · qty=UD_POSTUR · uom INSP_UOM (BOX→PCS) · KEY_DATE+TTSL=expiry · UD_MADE='X'&VALUATION='A'=accepted
//     · PUR_DOC=poRef · SUPPLIER_NAME1=supplier · dedup ด้วย INSP_LOT (รับครั้งเดียว)

const http = require('http');
const { URL } = require('url');
const { parseTag } = require('./armConnector');   // reuse: barcode receiving tag = [MATCODE 8][Lot]

const DAY_MS = 86400000;
function dmy(d) { const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; }   // dd.MM.yyyy
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round6(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }

// SAP material 18 หลัก leading-zero → MATCODE (000000000013000153 → 13000153)
function stripMat(m) { const s = String(m == null ? '' : m).trim().replace(/^0+/, ''); return s; }

// INSP_UOM → base ของเรา (Kg/L/PCS) + factor
function mapUom(uom, itemBaseUom) {
  const u = String(uom || '').trim().toUpperCase();
  const base = (String(itemBaseUom || '').trim()) || 'Kg';
  switch (u) {
    case 'KG': return { uom: 'Kg', factor: 1, ok: base === 'Kg' };
    case 'G': return { uom: 'Kg', factor: 0.001, ok: base === 'Kg' };
    case 'L': return { uom: 'L', factor: 1, ok: base === 'L' };
    case 'ML': return { uom: 'L', factor: 0.001, ok: base === 'L' };
    case 'BOX': case 'BAG': case 'CAN': case 'CON': case 'BOT': case 'PC': case 'PCS': case 'EA':
      return { uom: 'PCS', factor: 1, ok: base === 'PCS' };
    case '': return { uom: base, factor: 1, ok: true, assumedBase: true };
    default: return { uom: base, factor: 1, ok: false, raw: u };
  }
}

// "2026-05-28" + ttsl(วัน) → expiry ms (null ถ้า parse ไม่ได้/ttsl=0)
function calcExpiry(keyDate, ttslDays) {
  const d = String(keyDate || '').trim(); const days = num(ttslDays);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || days <= 0) return null;
  const t = Date.parse(d + 'T00:00:00Z');
  return Number.isFinite(t) ? t + days * DAY_MS : null;
}

// 1 INSP_LOT → receive intent (pure) · resolveItem(matCode) → {baseUom, name}|null
function mapInspLot(row, resolveItem) {
  const matCode = stripMat(row.MATERIAL);
  const inspLot = row.INSP_LOT != null ? String(row.INSP_LOT).trim() : '';
  const item = (typeof resolveItem === 'function' ? resolveItem(matCode) : null) || null;
  const warnings = [];
  if (!matCode) warnings.push('no-matcode');
  if (!item) warnings.push('master-missing');   // กฎเหล็ก §B1: ไม่มี master = รับเข้าไม่ได้

  const um = mapUom(row.INSP_UOM, item ? item.baseUom : '');
  if (um.assumedBase) warnings.push('uom-blank-assumed-base');
  else if (!um.ok) warnings.push('uom-' + (um.raw || 'mismatch'));

  const qtyRaw = num(row.UD_POSTUR) || num(row.INSP_QTY);   // ยอดที่ปล่อยเข้าใช้ได้ (fallback INSP_QTY)
  const qty = round6(qtyRaw * um.factor);
  const accepted = String(row.UD_MADE || '').trim().toUpperCase() === 'X'
    && String(row.VALUATION || '').trim().toUpperCase() === 'A';   // usage decision = accepted
  if (qty <= 0) warnings.push('no-qty');

  return {
    inspLot, inspType: String(row.INSPTYPE || '').trim(),   // Z01-RM ฯลฯ
    matCode, matName: String(row.MAT_DESC || '').trim(),
    lotNo: String(row.BATCH || '').trim(),
    qty, uom: um.uom,
    expiry: calcExpiry(row.KEY_DATE, row.TTSL),
    keyDate: String(row.KEY_DATE || '').trim(),
    supplier: String(row.SUPPLIER_NAME1 || '').trim(), supplierCode: String(row.SUPPLIER || '').trim(),
    poRef: String(row.PUR_DOC || '').trim(),
    matDoc: String(row.MATDOC || '').trim(), mvt: String(row.MVT || '').trim(),
    accepted, masterExists: !!item, baseUom: item ? item.baseUom : '',
    masterStore: item ? (item.defaultLocation || '') : '',   // §store-loc: store ที่ master กำหนด (defaultLocation) → UI โชว์ "ตาม master → store"
    warnings,
  };
}

function httpPostJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('bad SAP url')); }
    const payload = JSON.stringify(body || {});
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: timeoutMs || 25000 },
      (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => {
        try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(new Error(`SAP ตอบไม่ใช่ JSON (HTTP ${res.statusCode})`)); } }); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('SAP timeout')));
    req.write(payload); req.end();
  });
}

const TtlCache = require('./ttlCache');

class SapReceive {
  // { stock(=stockManager), url, plant, lotOri }
  constructor({ stock, url = 'http://172.23.10.168:14090/DATAGW/QMI002GET', plant = '1000', lotOri = '01' } = {}) {
    this.stock = stock; this.url = url; this.plant = plant; this.lotOri = lotOri;
    this.cache = new TtlCache();   // buffer กลาง — ลด transaction ไป SAP gateway
    this._lastOkAt = 0;   // epoch ms ของ fetch สำเร็จ (มีข้อมูลจริง) ล่าสุด → widget โชว์ "last sync"
  }
  lastSyncAt() { return this._lastOkAt; }
  _ttl() { const c = (this.stock && this.stock.config) || {}; const m = Number(c.sapFeedMin); return (m > 0 ? m * 60 : (Number(c.extCacheTtlSec) || 300)) * 1000; }   // รอบ buffer SAP (นาที · default 5) ปรับได้
  invalidate() { this.cache.clear(); }   // เรียกหลังรับเข้า → flag received สดทันที
  _resolveItem(matCode) {
    try { const it = this.stock && this.stock.getItem ? this.stock.getItem(matCode) : null; return it ? { baseUom: it.baseUom, name: it.name, defaultLocation: it.defaultLocation } : null; }
    catch (_) { return null; }
  }
  _map(rows) { return (rows || []).map((r) => { const m = mapInspLot(r, (mc) => this._resolveItem(mc)); m.received = !!(this.stock && this.stock.sapIsReceived && this.stock.sapIsReceived(m.inspLot)); return m; }); }

  // query incoming จาก SAP (date dd.MM.yyyy) · filter material/batch/lotNo ได้ · noCache=ดึงสด (write-verify)
  async listIncoming({ fromDate, toDate, material = '', batch = '', lotNo = '', acceptedOnly = true, noCache = false } = {}) {
    const body = { HEADER: { FROM_DATE: fromDate, TO_DATE: toDate, PLANT: this.plant, LOT_ORI: this.lotOri,
      MATERIAL: material || '', BATCH: batch || '', LOT_NO: lotNo || '' } };
    const fetcher = async () => { const r = this._map(((await httpPostJson(this.url, body)) || {}).INSP_LOT || []); if (r.length) this._lastOkAt = Date.now(); return r; };   // cache แบบไม่กรอง (กรอง accepted ทีหลัง)
    const key = `inc:${fromDate}:${toDate}:${material}:${batch}:${lotNo}`;
    let lines = await this.cache.getOrFetch(key, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });   // noCache=hard refresh (ดึงสด+เขียนทับ buffer)
    return acceptedOnly ? lines.filter((l) => l.accepted) : lines;
  }

  // re-query หา INSP_LOT เดียว (verify ก่อนรับเข้า · ดึงสด ไม่ใช้ buffer) · narrow ด้วย material/batch
  async getIncoming(inspLot, { fromDate, toDate, material = '', batch = '' } = {}) {
    const lines = await this.listIncoming({ fromDate, toDate, material, batch, acceptedOnly: false, noCache: true });
    return lines.find((l) => l.inspLot === String(inspLot)) || null;
  }

  // ยิง barcode tag → หา INSP_LOT · 3 แบบ: MAT+Lot / Lot อย่างเดียว / MAT อย่างเดียว (case-insensitive)
  async findByTag(scan, { fromDate, toDate } = {}) {
    const { matCode, lot } = parseTag(scan);
    if (!lot && !matCode) return { matCode, lot, lines: [] };
    const now = new Date();
    const f = fromDate || dmy(new Date(now.getTime() - 30 * DAY_MS));   // QMI002 จำกัด span ~31 วัน → default 30 วัน
    const t = toDate || dmy(now);
    let lines = await this.listIncoming({ fromDate: f, toDate: t, material: matCode || '', batch: lot || '', acceptedOnly: false });
    if (matCode) lines = lines.filter((l) => l.matCode === matCode);
    if (lot) lines = lines.filter((l) => String(l.lotNo || '').toUpperCase() === lot.toUpperCase());
    return { matCode, lot, lines };
  }
}

module.exports = { SapReceive, mapInspLot, mapUom, stripMat, calcExpiry, httpPostJson };
