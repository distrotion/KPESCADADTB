// armConnector.js — READ-ONLY connector ไปยัง ARM (ระบบเตรียมเคมี)
//   แหล่ง: MSSQL [ScadaReport].[dbo].[SOI8_Order_SAP] @172.23.10.39 (databases.json conn "autoDB")
//   หน้าที่: อ่าน production order + การใช้วัตถุดิบจริง → แปลงเป็น "issue intent"
//            สำหรับ "เบิกวัตถุดิบจาก StoreRM ตาม production order" (§C4 ฝั่ง ARM)
//   *** อ่านอย่างเดียว (SELECT) ไม่เขียนกลับ ARM เด็ดขาด ***
//
//   field map (เคาะ 2026-06-16): Mat_CP=MATCODE · Mat_Name=ชื่อ · OrderNo=PO(ref)
//     · lot+qty = Mat_SAP_Lot1-3 + Mat_SAP_QTY1-3 (planned · base = ×factor)
//     · committed (เบิกจริง) = Mat_Status IN (Finish, All_Full)
//     · dedup ด้วย ID (PK · (OrderNo,Mat_Count) ไม่ unique)

const COMMITTED = ['Finish', 'All_Full'];   // Mat_Status ที่ถือว่า "ใช้จริง"
const SELECT_COLS = `ID, OrderNo, Tank, Mat_Count, Mat_CP, Mat_Name, Mat_Quantity, Mat_UOM, Mat_Status,
  Mat_SAP_Lot1, Mat_SAP_QTY1, Mat_SAP_Lot2, Mat_SAP_QTY2, Mat_SAP_Lot3, Mat_SAP_QTY3, Mat_Full_Act_Lot, Complete_Time`;

function round6(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }

// แยก barcode จาก receiving tag = [MATCODE 8 หลัก][Lot] ติดกัน
//   เช่น "13000109260423A" → { matCode:'13000109', lot:'260423A' } (8 หลักหน้า = Mat_CP)
//   ถ้าไม่เข้าแพทเทิร์น (พิมพ์ lot ล้วน เช่น "260423A") → { matCode:'', lot:'260423A' }
// แยก barcode → 3 แบบ: MAT+Lot (8 หลัก + ต่อท้าย) · MAT อย่างเดียว (8 หลักล้วน) · Lot อย่างเดียว
//   matCode = 8 หลัก (MATCODE) · lot = ส่วนที่เหลือ (เทียบแบบไม่สนพิมพ์เล็ก/ใหญ่ที่ปลายทาง)
function parseTag(raw) {
  const s = String(raw || '').trim();
  if (/^\d{8}$/.test(s)) return { matCode: s, lot: '' };          // MAT only
  const m = /^(\d{8})(.+)$/.exec(s);
  if (m) return { matCode: m[1], lot: m[2].trim() };              // MAT + Lot
  return { matCode: '', lot: s };                                 // Lot only
}

function parseNum(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (s === '' || s === '-') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// แปลง Mat_UOM (KG/G/L/ML/...) → base ของเรา (Kg/L/PCS) + factor (ตาม baseUom ของ item)
function mapUom(armUom, itemBaseUom) {
  const u = String(armUom || '').trim().toUpperCase();
  const base = (String(itemBaseUom || '').trim()) || 'Kg';
  switch (u) {
    case 'KG': return { uom: 'Kg', factor: 1, ok: base === 'Kg' };
    case 'G': return { uom: 'Kg', factor: 0.001, ok: base === 'Kg' };
    case 'L': return { uom: 'L', factor: 1, ok: base === 'L' };
    case 'ML': return { uom: 'L', factor: 0.001, ok: base === 'L' };
    case '': return { uom: base, factor: 1, ok: true, assumedBase: true };
    default: return { uom: base, factor: 1, ok: false, raw: u };   // CON/BOT/PCS ฯลฯ → pass + flag
  }
}

// 1 แถว ARM → issue intent (pure) · resolveItem(matCode) → {baseUom, name}|null (null = ไม่มี master)
function mapArmRow(row, resolveItem) {
  const matCode = String(row.Mat_CP || '').trim();
  const orderNo = String(row.OrderNo || '').trim();
  const armId = row.ID != null ? String(row.ID).trim() : '';
  const status = String(row.Mat_Status || '').trim();
  const item = (typeof resolveItem === 'function' ? resolveItem(matCode) : null) || null;
  const warnings = [];
  if (!matCode) warnings.push('no-matcode');
  if (!item) warnings.push('master-missing');   // กฎเหล็ก §B1: ไม่มี master = ตัดไม่ได้

  const um = mapUom(row.Mat_UOM, item ? item.baseUom : '');
  if (um.assumedBase) warnings.push('uom-blank-assumed-base');
  else if (!um.ok) warnings.push('uom-' + (um.raw || 'mismatch'));

  // lot + qty: planned Mat_SAP_Lot1-3 / Mat_SAP_QTY1-3 → base (×factor)
  const lots = [];
  for (let i = 1; i <= 3; i++) {
    const lotNo = String(row['Mat_SAP_Lot' + i] || '').trim();
    const q = parseNum(row['Mat_SAP_QTY' + i]);
    if (lotNo && Number.isFinite(q) && q > 0) lots.push({ lotNo, qty: round6(q * um.factor) });
  }
  // fallback: ไม่มี SAP lot/qty → ใช้ Mat_Quantity กับ lot เดียว (Mat_SAP_Lot1 / Mat_Full_Act_Lot)
  if (lots.length === 0) {
    const q = parseNum(row.Mat_Quantity);
    const lotNo = String(row.Mat_SAP_Lot1 || row.Mat_Full_Act_Lot || '').trim();
    if (Number.isFinite(q) && q > 0) lots.push({ lotNo, qty: round6(q * um.factor), assumed: true });
  }
  if (lots.length === 0) warnings.push('no-qty');

  return {
    armId, orderNo, location: String(row.Tank || '').trim(),
    matCount: String(row.Mat_Count || '').trim(),
    matCode, matName: String(row.Mat_Name || '').trim(),
    status, committed: COMMITTED.includes(status),
    uom: um.uom, lots, totalQty: round6(lots.reduce((s, l) => s + l.qty, 0)),
    masterExists: !!item, baseUom: item ? item.baseUom : '',
    completeTime: row.Complete_Time || null,
    warnings,
  };
}

const TtlCache = require('./ttlCache');

class ArmConnector {
  // { dbManager, stock(=stockManager), connName, database, table }
  constructor({ dbManager, stock, connName = 'autoDB', database = 'ScadaReport', table = 'SOI8_Order_SAP' } = {}) {
    this.db = dbManager; this.stock = stock;
    this.connName = connName; this.database = database; this.table = table;
    this.cache = new TtlCache();   // buffer กลาง — หลาย widget/admin อ่านร่วม (ลด transaction ไป ARM MSSQL)
    this._lastOkAt = 0;   // epoch ms ของ fetch สำเร็จ (มีข้อมูลจริง) ล่าสุด → widget โชว์ "last sync"
  }
  lastSyncAt() { return this._lastOkAt; }
  _ttl() { const c = (this.stock && this.stock.config) || {}; const m = Number(c.armFeedMin); return (m > 0 ? m * 60 : (Number(c.extCacheTtlSec) || 300)) * 1000; }   // รอบ buffer ARM (นาที · default 5) ปรับได้
  invalidate() { this.cache.clear(); }   // เรียกหลังตัด → flag issued สดทันที
  _resolveItem(matCode) {
    try { const it = this.stock && this.stock.getItem ? this.stock.getItem(matCode) : null; return it ? { baseUom: it.baseUom, name: it.name } : null; }
    catch (_) { return null; }
  }
  _src() { return `${this.database}.dbo.${this.table}`; }
  _statusList() { return COMMITTED.map((s) => `'${s.replace(/'/g, "''")}'`).join(','); }
  _loc(location) { const v = String(location || '').trim().replace(/'/g, "''"); return v ? ` AND Tank='${v}'` : ''; }   // filter ตาม location (Tank)
  _map(rows) { return (rows || []).map((r) => { const m = mapArmRow(r, (mc) => this._resolveItem(mc)); m.issued = !!(this.stock && this.stock.armIsIssued && this.stock.armIsIssued(m.armId)); return m; }); }

  // committed RM consumption (สำหรับ list/เลือก) · incremental ด้วย sinceId
  async listConsumption({ sinceId = 0, limit = 200, asc = false, location, noCache = false } = {}) {
    const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
    const since = Math.max(0, Number(sinceId) || 0);
    // ค่าเริ่มต้น = ใหม่→เก่า (ORDER BY ID DESC) · asc=true เฉพาะตอน incremental sync (เก่า→ใหม่ · ID > checkpoint)
    const where = (asc ? `WHERE Mat_Status IN (${this._statusList()}) AND ID > ${since}`
      : `WHERE Mat_Status IN (${this._statusList()})`) + this._loc(location);
    const sql = `SELECT TOP ${lim} ${SELECT_COLS} FROM ${this._src()} ${where} ORDER BY ID ${asc ? 'ASC' : 'DESC'}`;
    const fetcher = async () => { const r = this._map(await this.db.query(this.connName, sql)); if (r.length) this._lastOkAt = Date.now(); return r; };
    return this.cache.getOrFetch(`cons:${lim}:${since}:${asc}:${location || ''}`, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });   // noCache=hard refresh (ดึงสด+เขียนทับ buffer · client อื่นได้ตาม) · sticky=ผลว่างชั่วคราวไม่ทับ last-good
  }

  // ยิง tag → committed line · รองรับ 3 แบบ: MAT+Lot / Lot อย่างเดียว / MAT อย่างเดียว (case-insensitive)
  async findByLot(scan, location, { noCache = false } = {}) {
    const { matCode, lot } = parseTag(scan);
    const v = String(lot || '').replace(/'/g, "''");
    const cp = matCode ? matCode.replace(/'/g, "''") : '';
    if (!v && !cp) return [];
    let cond;
    if (v && cp) cond = `Mat_CP='${cp}' AND (UPPER(Mat_SAP_Lot1)=UPPER('${v}') OR UPPER(Mat_SAP_Lot2)=UPPER('${v}') OR UPPER(Mat_SAP_Lot3)=UPPER('${v}') OR UPPER(Mat_Full_Act_Lot)=UPPER('${v}'))`;
    else if (v) cond = `(UPPER(Mat_SAP_Lot1)=UPPER('${v}') OR UPPER(Mat_SAP_Lot2)=UPPER('${v}') OR UPPER(Mat_SAP_Lot3)=UPPER('${v}') OR UPPER(Mat_Full_Act_Lot)=UPPER('${v}'))`;
    else cond = `Mat_CP='${cp}'`;   // MAT only
    const sql = `SELECT TOP 100 ${SELECT_COLS} FROM ${this._src()}
      WHERE Mat_Status IN (${this._statusList()}) AND ${cond}${this._loc(location)} ORDER BY ID DESC`;
    const fetcher = async () => this._map(await this.db.query(this.connName, sql));
    return this.cache.getOrFetch(`lot:${cp}:${v}:${location || ''}`, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });
  }

  // Fuzzy — ค้นใกล้เคียง %q% บน MATCODE / ชื่อ / lot (committed lines) · ไม่สนพิมพ์เล็ก/ใหญ่
  async searchFuzzy(q, location, { noCache = true } = {}) {
    const t = String(q || '').trim().replace(/'/g, "''");
    if (t.length < 2) return [];
    const like = `'%${t}%'`;
    const sql = `SELECT TOP 100 ${SELECT_COLS} FROM ${this._src()}
      WHERE Mat_Status IN (${this._statusList()})
        AND (Mat_CP LIKE ${like} OR Mat_Name LIKE ${like}
          OR Mat_SAP_Lot1 LIKE ${like} OR Mat_SAP_Lot2 LIKE ${like} OR Mat_SAP_Lot3 LIKE ${like} OR Mat_Full_Act_Lot LIKE ${like})${this._loc(location)}
      ORDER BY ID DESC`;
    const fetcher = async () => this._map(await this.db.query(this.connName, sql));
    return this.cache.getOrFetch(`fz:${t}:${location || ''}`, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });
  }

  // distinct location (Tank) ของ committed lines — สำหรับ dropdown filter
  async listLocations() {
    const sql = `SELECT Tank AS location, COUNT(*) n FROM ${this._src()}
      WHERE Mat_Status IN (${this._statusList()}) AND Tank<>'' GROUP BY Tank ORDER BY Tank`;
    return this.cache.getOrFetch('locs', async () => { const rows = await this.db.query(this.connName, sql); return (rows || []).map((r) => ({ location: r.location, count: r.n })); }, this._ttl(), { stickyNonEmpty: true });
  }

  // ดู order line เดียวด้วย ARM ID (ยืนยันก่อนตัด)
  async getById(id) {
    const n = Number(id); if (!Number.isFinite(n)) return null;
    const sql = `SELECT TOP 1 ${SELECT_COLS} FROM ${this._src()} WHERE ID = ${n}`;
    const rows = this._map(await this.db.query(this.connName, sql));
    return rows[0] || null;
  }
}

module.exports = { ArmConnector, mapArmRow, mapUom, parseNum, parseTag, round6, COMMITTED };
