// autorackConnector.js — READ-ONLY connector ไป autorack (Toyota AS/RS · Oracle IS200) — §C6 mirror
//   แหล่ง: Oracle 12c ORCL · user automation (read-only) · node-oracledb "thin" (ไม่ลง Instant Client)
//   *** อ่านอย่างเดียว · ไม่เขียนกลับ Oracle เด็ดขาด · autorack = source of truth ***
//   field-map (ยืนยัน 2026-06-20): DB20=stock · DB01=item master · DB03=pallet→location
//     CHINBAN=MATCODE · CHINMEI=ชื่อ · CLOTNO=lot · NZAINUM=qty · CRETSU-CREN-CDAN=location · CNKTIME=วันเข้า
//   *** password อ่านจาก env ORA_PASS เท่านั้น (ไม่ฝัง · ไม่ commit) ***
const TtlCache = require('./ttlCache');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function trim(v) { return String(v == null ? '' : v).trim(); }
// CNKTIME "20260320162231901" (YYYYMMDDHHMMSSmmm) → epoch ms (ไม่เข้าแพทเทิร์น = null)
function parseAutorackTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(trim(s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

class AutorackConnector {
  // { stock(=stockManager), connectString, user, schema }
  constructor({ stock, connectString = '172.101.5.110:1521/ORCL', user = 'automation', schema = 'IS200' } = {}) {
    this.stock = stock; this.connectString = connectString; this.user = user; this.schema = schema;
    this.cache = new TtlCache();
    this._lastErr = '';
    this._busy = false;   // กำลังดึงจาก Oracle อยู่ (สำหรับ icon "กำลัง sync")
    this._lastOkAt = 0;   // epoch ms ของ fetch สำเร็จ (มีข้อมูลจริง) ล่าสุด → widget โชว์ "last sync"
  }
  busy() { return this._busy === true; }
  lastSyncAt() { return this._lastOkAt; }
  _cfg(k) { return this.stock && this.stock.config ? this.stock.config[k] : undefined; }
  _ttl() { const m = Number(this._cfg('autorackFeedMin')); return (m > 0 ? m * 60 : (Number(this._cfg('extCacheTtlSec')) || 300)) * 1000; }   // รอบ buffer autorack (นาที · default 5) ปรับได้
  _conn() { return this._cfg('autorackConn') || this.connectString; }
  _user() { return this._cfg('autorackUser') || this.user; }
  _schema() { return this._cfg('autorackSchema') || this.schema; }
  _pass() { return this._cfg('autorackPass') || process.env.ORA_PASS || ''; }
  // autorack เก็บเป็น fixed-point ×100 เสมอ (ไม่เก็บทศนิยม · เช่น 4050=40.50 · 800=8) → หาร 100 ก่อนเสมอ → ได้ "ปริมาณ native" ของ autorack
  //   ปรับได้ผ่าน config autorackQtyDiv (default 100) · กันหาร 0
  _qtyDiv() { const d = Number(this._cfg('autorackQtyDiv')); return d > 0 ? d : 100; }
  _weightUnits() { const c = this._cfg('autorackWeightUnits'); return ((Array.isArray(c) && c.length) ? c : ['KG', 'G', 'L', 'ML']).map((u) => String(u).trim().toUpperCase()); }
  // [v3] ขนาดต่อถุงของ item (>0 = FG ที่ autorack นับเป็นถุง + track เป็นน้ำหนัก/ปริมาตร) · 0 = ไม่ใช่ของนับถุง
  //   ยึด master ก่อน: packUnit/packSize/packBaseUom (1 packUnit = packSize baseUom · เช่น 1 ถุง=25 KG) · ยังไม่ตั้ง → fallback parse ชื่อ "| 25KG" ชั่วคราว
  _itPack(matCode) {   // → { mul, unit } | null
    if (!matCode || !this.stock || !this.stock.getItem) return null;
    const it = this.stock.getItem(String(matCode).trim());
    if (!it || String(it.itemType) !== 'finished') return null;
    const u = String(it.baseUom || '').trim().toUpperCase();
    if (!this._weightUnits().includes(u)) return null;
    if (num(it.packSize) > 0 && String(it.packBaseUom || '').trim().toUpperCase() === u) return { mul: num(it.packSize), unit: String(it.packUnit || '').trim() };   // master pack (1 packUnit = packSize baseUom)
    const ps = this._packSizeFromName(it.name, u); return ps > 0 ? { mul: ps, unit: String(it.packUnit || '').trim() } : null;   // fallback ชื่อ (label ยังยึด packUnit จาก master)
  }
  _packMul(matCode) { const p = this._itPack(matCode); return p ? p.mul : 0; }
  packUnitOf(matCode) { const p = this._itPack(matCode); return p ? p.unit : ''; }
  // [v3] ÷100 → ปริมาณ native (RM/CM = น้ำหนัก KG · FG = จำนวนถุง) · ยึด master: FG+น้ำหนัก → ×ขนาดต่อถุง = น้ำหนัก master · อื่น ๆ ใช้ native ตรง
  _qty(v, matCode) { const base = num(v) / this._qtyDiv(); const ps = this._packMul(matCode); return ps > 0 ? base * ps : base; }
  // จำนวนถุง (เฉพาะ FG ที่นับเป็นถุง) — null = ไม่ใช่ของนับถุง (RM/CM/PCS)
  _pcs(v, matCode) { return this._packMul(matCode) > 0 ? num(v) / this._qtyDiv() : null; }
  // ดึงขนาดต่อถุงจากชื่อสินค้า เช่น "FERRICOAT 7M | 25KG" → 25 · "D.I. WATER | 20LT" → 20 (ยึดหน่วยตรง baseUom + alias · ไม่เจอ = 0)
  _packSizeFromName(name, unitUpper) {
    const alias = { KG: ['KGS', 'KGM', 'KG'], L: ['LITRE', 'LITER', 'LTR', 'LT', 'L'], ML: ['ML', 'CC'], G: ['GM', 'GR', 'G'] };
    const pats = (alias[unitUpper] || [unitUpper]).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));   // เรียงยาวก่อน → LT ชนะ L
    const m = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(?:' + pats.join('|') + ')\\b', 'i').exec(String(name || ''));
    return m ? num(m[1]) : 0;
  }
  invalidate() { this.cache.clear(); }
  lastError() { return this._lastErr; }

  _oracledb() {
    try { return require('oracledb'); }
    catch { throw new Error('ยังไม่ได้ลง oracledb (cd backend && npm i oracledb) — thin mode'); }
  }

  // ดึง stock สดจาก autorack (DB20⨝DB01⨝DB03) → mapped lines · cached
  async listStock({ noCache = false } = {}) {
    const fetcher = async () => {
      const oracledb = this._oracledb();
      oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
      const pass = this._pass();
      if (!pass) throw new Error('ยังไม่ตั้ง ORA_PASS (รหัส user autorack)');
      const sch = this._schema().replace(/[^A-Za-z0-9_]/g, '');   // กัน injection (schema = identifier)
      let conn;
      try {
        conn = await oracledb.getConnection({ user: this._user(), password: pass, connectString: this._conn() });
        const sql = `SELECT TRIM(s.CHINBAN) matcode, TRIM(m.CHINMEI) name, TRIM(s.CLOTNO) lot,
                            s.NZAINUM qty, l.CRETSU||'-'||l.CREN||'-'||l.CDAN location,
                            TRIM(s.CPLTNO) pallet, s.CNKTIME insttime
                       FROM ${sch}.DB20 s
                       LEFT JOIN ${sch}.DB01 m ON m.CHINBAN = s.CHINBAN
                       LEFT JOIN ${sch}.DB03 l ON l.CPLTNO  = s.CPLTNO
                      WHERE s.NZAINUM > 0`;
        const r = await conn.execute(sql);
        this._lastErr = '';
        const out = (r.rows || []).map((x) => ({
          matCode: trim(x.MATCODE), name: trim(x.NAME), lot: trim(x.LOT),
          qty: this._qty(x.QTY, trim(x.MATCODE)), pcs: this._pcs(x.QTY, trim(x.MATCODE)), packUnit: this.packUnitOf(trim(x.MATCODE)), location: trim(x.LOCATION), pallet: trim(x.PALLET),
          instTime: parseAutorackTime(x.INSTTIME),
        }));
        if (out.length) this._lastOkAt = Date.now();
        return out;
      } finally { if (conn) { try { await conn.close(); } catch (_) {} } }
    };
    this._busy = true;
    try {
      return await this.cache.getOrFetch('stock', fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });   // noCache=hard refresh (ดึงสด+เขียนทับ buffer)
    } catch (e) { this._lastErr = e.message; throw e; }
    finally { this._busy = false; }
  }

  // movement (DB26) — ความเคลื่อนไหว: เข้า(in)/ออก(out)/ย้าย(move) ตาม from→to location · ใหม่→เก่า
  async listMovements({ limit = 50, mat = '', zone = '', prefixes = '', days = 0, noCache = false } = {}) {
    const fetcher = async () => {
      const oracledb = this._oracledb();
      oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
      const pass = this._pass(); if (!pass) throw new Error('ยังไม่ตั้ง ORA_PASS');
      const sch = this._schema().replace(/[^A-Za-z0-9_]/g, '');
      const lim = Math.max(1, Math.min(5000, Number(limit) || 50));
      const m = String(mat || '').replace(/[^0-9A-Za-z]/g, '');
      // zone (autorack-FG/RM/CM) → prefix จาก config map · กรองเฉพาะ rack นั้น (มิเรอร์แยกตาม FG/RM/CM)
      const z = String(zone || '').trim();
      const wh = [];
      if (m) wh.push(`TRIM(CHINBAN)='${m}'`);
      // date window (วัน) — superset ดึงย้อนหลัง N วัน (CKANTIME = YYYYMMDDHHMMSSmmm → เทียบ string ได้)
      const d = Math.max(0, Number(days) || 0);
      if (d > 0) { const c = new Date(Date.now() - d * 86400000); const p = (x) => String(x).padStart(2, '0'); wh.push(`CKANTIME >= '${c.getFullYear()}${p(c.getMonth() + 1)}${p(c.getDate())}000000'`); }
      // prefixes (ตรง · รองรับ combo เช่น 11,91,12) มาก่อน · ไม่งั้น derive จาก zone เดี่ยว (config map)
      let pfx = String(prefixes || '').split(',').map((s) => s.trim().replace(/[^0-9A-Za-z]/g, '')).filter(Boolean);
      if (!pfx.length && z) pfx = Object.entries(this._cfg('autorackPrefixMap') || {}).filter(([, s]) => s === z).map(([p]) => String(p).replace(/[^0-9A-Za-z]/g, '')).filter(Boolean);
      if (pfx.length) wh.push(`SUBSTR(TRIM(CHINBAN),1,2) IN (${[...new Set(pfx)].map((p) => `'${p}'`).join(',')})`);
      let conn;
      try {
        conn = await oracledb.getConnection({ user: this._user(), password: pass, connectString: this._conn() });
        const sql = `SELECT CKANTIME, TRIM(CHINBAN) mat, TRIM(CHINMEI) name, TRIM(CLOTNO) lot, NNUM qty,
                            TRIM(CFROMRETSU)||'-'||TRIM(CFROMREN)||'-'||TRIM(CFROMDAN) frm,
                            TRIM(CTORETSU)||'-'||TRIM(CTOREN)||'-'||TRIM(CTODAN) too
                       FROM ${sch}.DB26 ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
                      ORDER BY CKANTIME DESC FETCH FIRST ${lim} ROWS ONLY`;
        const r = await conn.execute(sql);
        this._lastErr = '';
        const isEmpty = (s) => !s || /^[0-]+$/.test(String(s).replace(/ /g, ''));
        const out = (r.rows || []).map((x) => {
          const frm = trim(x.FRM), too = trim(x.TOO);
          const type = isEmpty(frm) ? (isEmpty(too) ? 'move' : 'in') : (isEmpty(too) ? 'out' : 'move');
          return { type, matCode: trim(x.MAT), itemName: trim(x.NAME), lot: trim(x.LOT), qty: this._qty(x.QTY, trim(x.MAT)), from: frm, to: too, ts: parseAutorackTime(x.CKANTIME) };
        });
        if (out.length) this._lastOkAt = Date.now();
        return out;
      } finally { if (conn) { try { await conn.close(); } catch (_) {} } }
    };
    this._busy = true;
    try { return await this.cache.getOrFetch(`mv:${limit}:${mat}:${zone}:${prefixes}:${days}`, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache }); }   // noCache=hard refresh (ดึงสด+เขียนทับ buffer)
    catch (e) { this._lastErr = e.message; throw e; }
    finally { this._busy = false; }
  }
}

module.exports = { AutorackConnector, parseAutorackTime };
