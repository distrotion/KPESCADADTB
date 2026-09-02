const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const { dialectOf, ph, tsVal } = require('./dbDialect');

/**
 * StockManager — Stock for Chemical Factory (ระบบสต็อกโรงงานเคมี)
 * ════════════════════════════════════════════════════════════════════════════
 * อ้างอิง: docs/SPEC.md · docs/SCHEMA.md · docs/MASTER-FIELDS.md · docs/STOCK-PLAN.md
 *
 * โมเดลหลัก (lot-centric):
 *   Group ─< Item(MATCODE) ─< Lot ─< Balance(item×stock×lot)
 *   Item = master (กฎเหล็ก: ไม่มี master = บันทึก stock ไม่ได้) · key = MATCODE (MATFG/RAWMAT)
 *   Group = taxonomy + defaults สืบทอด→item (override รายตัว)
 *   Lot   = layer อายุ+คุณภาพ (expiry = productionDate + shelfLife) · status quarantine/available
 *   Movement engine เดียว: receive/issue/adjust/transfer/return/produce/sale (FEFO · no-negative)
 *
 * ⚠️ ระบบนี้ "ไม่คิดเงิน" — ไม่มีราคา/ต้นทุน/มูลค่า/COGS (โฟกัส ของ+จำนวน+lot/อายุ/สถานะ เท่านั้น)
 *
 * ครอบคลุม: Master(Group/Item+inheritance) · Container master+bulk stock · Stock node · Lot · Balance
 *   Movement receive/issue/adjust/transfer/return · produce · sale(ship gate) · FEFO · alerts(reorder/expiry)
 *   reserve(IStockProvider) · QC/COA gate · customer
 * ── toll subsystem (§C3): Core ✅ (role=toll คลังแยก · ส่งมอบผูกลูกค้า · KPI · outstanding) · เหลือผลิต toll
 * ── ยังไม่ทำ: sealed/loose+open-container · fill/container loop · pocket · ผลิต toll (RM toll→FG toll)
 * ════════════════════════════════════════════════════════════════════════════
 */

const CSV_FOLDER = 'stock-logs';
const CSV_PREFIX = 'stock';
const CSV_COLS = ['timestamp', 'movement_id', 'type', 'item', 'item_name', 'lot_no', 'from_stock', 'to_stock', 'qty_base', 'ref', 'by_user', 'note', 'batch', 'src_map', 'src_key', 'lot_id', 'actor_type', 'ip'];   // §C8: actor_type (user/guest/autorack) · by_user = ชื่อ actor · §A: ip = เก็บทุก movement (audit)

const ITEM_TYPES = ['rawmat', 'merchandise', 'finished', 'semi', 'container'];
// role คลัง (นิยามล่วงหน้า · §store-expand) — rw/fg/toll มี routing แล้ว · ที่เหลือยังไม่ยึด logic (รับ/เบิกเสรี รอปล่อย concept)
const STORE_ROLES = ['rw', 'fg', 'toll', 'cm', 'brm', 'bfg', 'ngrm', 'ngfg', 'soi12', 'hes', 'gw'];
// autorack monitor (§C6→v3) — 3 store แยกตาม prefix (= zone rule เรา) · v3: virtual monitor (ไม่นับยอด · derive จาก feed)
const AUTORACK_STORES = { 'autorack-RM': { role: 'rw', name: 'Autorack RM' }, 'autorack-FG': { role: 'fg', name: 'Autorack FG' }, 'autorack-CM': { role: 'cm', name: 'Autorack CM' } };
// [v3] คลังรับของ auto-receive ที่ item ไม่มี defaultLocation (counted ปกติ · รอจัด location) — แยกตาม prefix เหมือน autorack
const NOMASTER_STORES = { 'NOMASTER-RM': { role: 'rw', name: 'NOMASTER RM (รอจัด location)' }, 'NOMASTER-FG': { role: 'fg', name: 'NOMASTER FG (รอจัด location)' }, 'NOMASTER-CM': { role: 'cm', name: 'NOMASTER CM (รอจัด location)' } };
const NOMASTER_OF = (mat) => { const p = String(mat || '').slice(0, 2); return (p === '11' || p === '91') ? 'NOMASTER-FG' : (p === '12' ? 'NOMASTER-CM' : 'NOMASTER-RM'); };
const AUTORACK_ITEMTYPE = (mat) => { const p = String(mat || '').slice(0, 2); return (p === '11' || p === '91') ? 'finished' : (p === '12' ? 'semi' : 'rawmat'); };
// §store-loc (2026-06-19): จัดหมวด store จาก "X (ตัวแรกของ stockId)" → role/store-tab · Y(ตัวสอง)=หลัก · Z(ตัวสาม)=ย่อย
//   X=4 แยกด้วย I (ตัวที่ 4): I=0→rw/StoreRM · I=1→fg/StoreFG · X อื่น (C/2/3/5) ไม่สน I · X นอกตาราง = คง role เดิม
const STORE_LOC_X_ROLE = {
  'C': 'cm',     // StoreCM
  '2': 'soi12',  // StoreSOI12
  '3': 'gw',     // StoreGW
  '5': 'hes',    // StoreHES
};   // X=4 (RM/FG) จัดการแยกใน _roleFromStockId เพราะต้องดู I
const WARNINGS = ['flammable', 'corrosive', 'toxic', 'oxidizer', 'explosive', 'irritant', 'environmental', 'coolroom'];   // คำเตือน multi-select (hazard + coolroom)
const CONTAINER_STATES = ['empty-clean', 'filled', 'at-customer', 'returned-dirty', 'cleaning', 'scrapped'];
const DEFAULT_TICK = 60000;
const DAY_MS = 86400000;

// field ที่ group ตั้ง default แล้ว item สืบทอดได้ (override รายตัวได้)
const INHERITABLE = ['lotControlled', 'qcOnReceipt', 'requiresCoa', 'qcSpec', 'shelfLife', 'openShelfLife',
  'expiryBasis', 'lotNumberRule', 'hazardClass', 'compatibilityGroup', 'defaultLocation',
  'safetyStock', 'pocketEligible', 'saleEligible'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function r6(n) { return Math.round(n * 1e6) / 1e6; }
function posQty(v) { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error('qty ต้องมากกว่า 0'); return n; }
function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
function slugCode(s, pfx) { return pfx + (String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28).toUpperCase() || 'X'); }

class StockManager {
  constructor(tagEngine, opts = {}) {
    this.tagEngine = tagEngine || null;
    this.dbManager = opts.dbManager || null;
    this.onAlert = opts.onAlert || (() => {});
    this.groups = [];
    this.items = [];          // master (key = MATCODE)
    this.stocks = [];
    this.lots = [];
    this.containers = [];     // master ภาชนะ (แยกจาก items · bulk count ตามสถานะ)
    this.containerBalances = {}; // "containerId|stockId|state" -> count
    this.customers = [];      // ลูกค้า (sale/toll)
    this.coas = [];           // COA artifact (ผูก lot)
    this.qcRecords = [];      // ผล QC ต่อ lot
    this.balances = {};       // "MATCODE|stockId|lotId" -> { onHand, reserved }
    this.reservations = {};   // woId -> [ {matcp, stockId, qty} ]
    this.armIssued = {};      // ARM ID -> { ts, orderNo, matCode } — ตัดแล้ว (ตัดซ้ำไม่ได้)
    this.sapReceived = {};    // SAP INSP_LOT -> { ts, matCode, lotNo } — รับเข้าแล้ว (รับซ้ำไม่ได้)
    this.ppReceived = {};     // PP PROCESS_ORDER -> { ts, matCode, lotNo } — รับ FG แล้ว (รับซ้ำไม่ได้)
    this.pickingShipped = {}; // picking lineId -> { ts, delivery, matCode, batch, qty } — ส่งมอบแล้ว (ตัดซ้ำไม่ได้)
    this.revokeLog = [];      // ประวัติการถอย (revoke) — { ts, byUser, reason, batch, mvIds, reverseMvIds, cleared:[{srcMap,srcKey}] }
    this.locationTags = [];   // §H ตำแหน่งเก็บในโซน — { id, storeId, label, enabled } · super user สร้าง · เลือกตอนรับเข้า (remark)
    this._batchSeq = 0;       // กลุ่ม movement ต่อ 1 action (ถอยเป็นชุด)
    this.journal = [];
    this.config = {
      dbConnection: '', dbTable: 'stock_movement', journalLimit: 800,
      allowNegative: false, expiryWarnDays: 30, defaultShelfLifeDays: 365, shelfLifeSource: 'item', tickMs: DEFAULT_TICK,   // expiryWarnDays=เกณฑ์เตือน global · defaultShelfLifeDays=อายุสินค้า default · shelfLifeSource: 'item'=ต่อรายการก่อน(global=สำรอง · default) | 'global'=บังคับใช้ global ทุกตัว (เปลี่ยนที่ Setup)
      outLowCountTag: '', outExpiryCountTag: '',
      // master kill-switch ของทุกแหล่งเชื่อมต่อภายนอก (ARM/SAP/PP) — default ปิดเสมอ
      // *** ห้าม persist ค่า true ติดไปกับ clone/install ใหม่: ไม่มีไฟล์ config = ใช้ default = ปิด ***
      extEnabled: false,
      // storage switch (เปิดใช้ DB ตอน alpha §F) — แยก 2 env: test / production (ชุดข้อมูลแยกขาดกัน)
      storage: 'file',                      // 'file' | 'db'
      env: 'test',                          // 'test' | 'prod' — เลือกชุดข้อมูล (ใช้ตอน storage='db')
      dbTest: { conn: '', database: '' },   // test DB target (databases.json conn id/name + ชื่อ DB)
      dbProd: { conn: '', database: '' },   // production DB target
      dbAdminConn: 'autoDB',                // admin conn (มีสิทธิ์ CREATE DATABASE) สำหรับปุ่ม provision
      revokeUsers: '',                      // ผู้มีสิทธิ์ถอยรายการ (revoke) — ชื่อผู้ใช้ csv · ว่าง=ไม่มีใครถอยได้
      sapDaysBack: 10,                      // SAP incoming: ช่วงวันที่ default = วันนี้ - N (auto · จำ)
      sapDaysFwd: 0,                        // ... ถึง วันนี้ + N (เช่น -9/+1 = back 9, fwd 1)
      fgDaysBack: 10, fgDaysFwd: 0,         // รับ FG (PP): ช่วงวันที่ default (auto · จำ · เหมือน SAP)
      extCacheTtlSec: 600,                  // buffer กลาง ARM/SAP/PP — ดึงของจริงทุก N วิ (default 600=10นาที) · ระหว่างนั้นคืน buffer · รับ/ตัดแล้ว invalidate สดทันที · 0=ปิด
      // autorack mirror (§C6 · read-only · Oracle IS200) — pass อยู่ env ORA_PASS เท่านั้น
      autorackEnabled: false,               // เปิด sync (อยู่ใต้ extEnabled kill-switch ด้วย)
      autorackConn: '172.101.5.110:1521/ORCL', autorackUser: 'automation', autorackSchema: 'IS200',
      autorackSyncSec: 600,                 // poll cadence (0=manual เท่านั้น)
      autorackQtyDiv: 100,                  // น้ำหนัก autorack เก็บ fixed-point ×100 → หารก่อนใช้ (4050→40.50 KG)
      autorackPrefixMap: { 11: 'autorack-FG', 91: 'autorack-FG', 13: 'autorack-RM', 14: 'autorack-RM', 12: 'autorack-CM' },
      autorackAutoReceive: 'off',           // [v2 P2b] auto-receive เคส 2: 'off'=ปิด · 'log'=dry-run(log เฉย ๆ) · 'on'=รับจริง (ยังไม่เทสสด · external ดับ)
      autorackLastSync: 0,                  // runtime: epoch ms ของ sync ล่าสุด (staleness)
      // จัดประเภทจาก prefix ของ MATCODE (ผู้ใช้ตั้งเพิ่ม/ลดได้ในหน้า setup) — ใช้ route รับเข้า/เบิก (rawmat→StoreRM · อื่น→StoreFG)
      matPrefixRules: [
        { prefix: '13', type: 'rawmat' }, { prefix: '14', type: 'rawmat' },   // ZCRM
        { prefix: '12', type: 'semi' },                                        // ZCSM
        { prefix: '11', type: 'finished' },                                    // ZCFG (ผลิตเอง)
        { prefix: '91', type: 'merchandise' },                                 // Z9TR (Trading · ซื้อมาขาย)
      ],
    };
    this._seq = { mv: 0, lot: 0, coa: 0, qc: 0 };
    this._dbReady = new Set();
    this._timer = null;
    this._started = false;
    this._load();
    this._loadJournalFromCsv();
  }

  get csvDir() { return csv.csvDir(CSV_FOLDER); }

  // ── persistence ─────────────────────────────────────────────────────────────
  // โหลด state จาก object (ใช้ร่วม file + db) → normalize เข้า core
  _applyRaw(raw) {
    raw = raw || {};
    this.groups = Array.isArray(raw.groups) ? raw.groups.map((g) => this._normGroup(g)) : [];
    this.items = Array.isArray(raw.items) ? raw.items.map((i) => this._normItem(i)) : [];
    this.stocks = Array.isArray(raw.stocks) ? raw.stocks.map((s) => this._normStock(s)) : [];
    this.lots = Array.isArray(raw.lots) ? raw.lots.map((l) => this._normLot(l)) : [];
    this.containers = Array.isArray(raw.containers) ? raw.containers.map((c) => this._normContainer(c)) : [];
    this.containerBalances = (raw.containerBalances && typeof raw.containerBalances === 'object') ? raw.containerBalances : {};
    this.customers = Array.isArray(raw.customers) ? raw.customers : [];
    this.coas = Array.isArray(raw.coas) ? raw.coas : [];
    this.qcRecords = Array.isArray(raw.qcRecords) ? raw.qcRecords : [];
    this.balances = (raw.balances && typeof raw.balances === 'object') ? raw.balances : {};
    this.reservations = (raw.reservations && typeof raw.reservations === 'object') ? raw.reservations : {};
    this.armIssued = (raw.armIssued && typeof raw.armIssued === 'object') ? raw.armIssued : {};
    this.sapReceived = (raw.sapReceived && typeof raw.sapReceived === 'object') ? raw.sapReceived : {};
    this.ppReceived = (raw.ppReceived && typeof raw.ppReceived === 'object') ? raw.ppReceived : {};
    this.pickingShipped = (raw.pickingShipped && typeof raw.pickingShipped === 'object') ? raw.pickingShipped : {};
    this.revokeLog = Array.isArray(raw.revokeLog) ? raw.revokeLog : [];
    this.locationTags = Array.isArray(raw.locationTags) ? raw.locationTags : [];
    // *** deployment config ของ instance นี้ (storage/env/db target) ห้ามถูก blob ทับ ***
    //   (blob จาก DB/refresh-test/restore พก config มาด้วย — ถ้าทับ env → test instance อาจกลายเป็น prod → เขียนทับ prod DB)
    const _localDeploy = {}; for (const k of ['storage', 'env', 'dbProd', 'dbTest']) if (this.config[k] !== undefined) _localDeploy[k] = this.config[k];
    this.config = { ...this.config, ...(raw.config || {}), ..._localDeploy };
    this._seq = { mv: Number(raw.seq && raw.seq.mv) || 0, lot: Number(raw.seq && raw.seq.lot) || 0, coa: Number(raw.seq && raw.seq.coa) || 0, qc: Number(raw.seq && raw.seq.qc) || 0 };
    this._migrate();
  }
  _load() {
    this.path = csv.resolveConfig('stock.json', path.join(__dirname, 'config', 'stock.json'));
    try { this._applyRaw(JSON.parse(fs.readFileSync(this.path, 'utf8'))); } catch (_) { /* ไฟล์ใหม่ */ }
  }
  // ล้างข้อมูลค้างจากก่อนแยก kind: container balance ที่อยู่ในคลังที่ไม่ใช่ container
  _migrate() {
    let changed = false;
    for (const k of Object.keys(this.containerBalances)) {
      const st = this.getStock(k.split('|')[1]);
      if (!st || st.kind !== 'container') { delete this.containerBalances[k]; changed = true; }
    }
    // §store-loc: reclassify store ที่มีอยู่ — role/store-tab จาก X ของ stockId (เช่น C*→cm → ย้ายไป StoreCM) · X นอกตาราง = คง role เดิม
    for (const st of this.stocks) {
      if (st.kind === 'container') continue;
      const role = this._roleFromStockId(st.stockId);
      if (role && st.role !== role) { st.role = role; changed = true; }
    }
    if (changed) { try { this._save(); } catch (_) {} }
  }
  // payload ที่ persist (ใช้ร่วม file + db blob)
  _serialize() {
    return {
      groups: this.groups, items: this.items, stocks: this.stocks, lots: this.lots,
      containers: this.containers, containerBalances: this.containerBalances,
      customers: this.customers, coas: this.coas, qcRecords: this.qcRecords,
      balances: this.balances, reservations: this.reservations, armIssued: this.armIssued, sapReceived: this.sapReceived, ppReceived: this.ppReceived, pickingShipped: this.pickingShipped, revokeLog: this.revokeLog, locationTags: this.locationTags, config: this.config, seq: this._seq,
    };
  }
  _save() {
    if (this.isDbStorage() && this._stockDb) { this._scheduleDbFlush(); return; }   // DB mode (§F): in-memory authoritative → flush async · file mode: เขียนไฟล์ atomic เหมือนเดิม
    csv.writeJsonAtomic(this.path, this._serialize());
  }
  // ── DB persistence (storage='db' · TPKstock_Prod/Test · §F) — inject dbManager ที่ server.js ──
  attachDb(dbManager) { this._stockDb = new (require('./stockDb'))(dbManager); }
  async initDb() {
    if (!this.isDbStorage() || !this._stockDb) return;
    const env = this.config.env;
    const t = this.activeDbTarget(); if (!t || !t.conn) throw new Error('storage=db แต่ยังไม่ตั้ง dbProd/dbTest (conn)');
    if (env === 'prod') {
      // *** DBprod หลังบ้านทำได้แค่ DDL (สร้าง table / เพิ่ม field) — ห้ามเขียน/แก้ "ข้อมูล" (seed/state) อัตโนมัติ ***
      //     การ seed/แก้ข้อมูล prod ต้องผ่านหน้าบ้าน (Activate/รับเข้า/เบิก/ขาย) เท่านั้น
      try { await this._stockDb.ensureSchema(t.conn); }              // DDL: สร้าง table/เพิ่ม field ได้ (idempotent)
      catch (e) { this._dbErr = `prod schema: ${e.message} (provision ผ่านหน้าบ้านก่อน)`; return; }
      let blob = null;
      try { blob = await this._stockDb.readState(t.conn, 'prod'); }
      catch (e) { this._dbErr = `prod อ่านไม่ได้: ${e.message}`; return; }
      if (blob != null) { this._applyRaw(JSON.parse(blob)); this._dbErr = ''; this._dbHydrated = true; try { this.ensureAutorackStores(); } catch (_) {} }   // โหลดสำเร็จ → เปิด flush · [v2] ปลด readonly + purge AR: เก่า หลัง hydrate
      else { this._dbErr = 'DBprod ยังไม่มี state (seed/activate ผ่านหน้าบ้านเท่านั้น) — ไม่ seed อัตโนมัติ'; }   // ไม่ writeState · ไม่ hydrate → ล็อก
      return;
    }
    // test: boot สร้าง schema + seed อัตโนมัติได้ (disposable)
    await this._stockDb.ensureSchema(t.conn);
    const blob = await this._stockDb.readState(t.conn, env);
    if (blob) this._applyRaw(JSON.parse(blob));                                              // มีใน DB → โหลดทับ in-memory
    else await this._stockDb.writeState(t.conn, env, JSON.stringify(this._serialize()));     // ว่าง → seed จาก state ปัจจุบัน (ไฟล์)
    this._dbHydrated = true;
    try { this.ensureAutorackStores(); } catch (_) {}   // [v2] หลัง hydrate → ปลด readonly + purge AR: เก่า (hydrate ทับค่าที่ start() ตั้ง · ต้องรันซ้ำหลังโหลด db)
  }
  // flush state → DB (coalesce หลาย _save เป็นการเขียนเดียว · ไม่ await ใน _save · dirty-retry กันข้อมูลหาย)
  _scheduleDbFlush() {
    if (!this._dbHydrated) return;   // ยังไม่ load/seed สำเร็จ (ล็อก) → ห้าม flush (กันเขียนทับ state เดิม + กัน seed อัตโนมัติ)
    const t = this.activeDbTarget(); if (!t || !t.conn) { this._dbErr = `storage=db แต่ไม่มี conn (${this.config.env})`; return; }   // กัน retry-loop ตอน misconfig
    this._dbDirty = true;
    if (this._dbFlushing) return;
    this._dbFlushing = true;
    (async () => {
      try {
        while (this._dbDirty) {
          this._dbDirty = false;
          const t = this.activeDbTarget();
          await this._stockDb.writeState(t.conn, this.config.env, JSON.stringify(this._serialize()));
        }
        this._dbErr = '';
      } catch (e) { this._dbDirty = true; this._dbErr = e.message; }
      finally { this._dbFlushing = false; if (this._dbDirty && !this._dbRetry) { this._dbRetry = setTimeout(() => { this._dbRetry = null; this._scheduleDbFlush(); }, 2000); } }
    })();
  }
  // ── DB ops (§F · snapshot / refresh-test / restore) — ใช้ conn ของ env (dbProd/dbTest) ──
  _connFor(env) { const t = env === 'prod' ? this.config.dbProd : this.config.dbTest; return (t && t.conn) ? t.conn : ''; }
  _assertDb() { if (!this.isDbStorage() || !this._stockDb) throw new Error('storage ไม่ใช่ db (เปิด storage=db + ตั้ง dbProd/dbTest ก่อน)'); }
  async dbStatus() {
    const env = this.config.env;
    const out = { storage: this.config.storage, env, dirty: !!this._dbDirty, flushing: !!this._dbFlushing, hydrated: !!this._dbHydrated,
      err: this._dbErr || '', prodConn: this._connFor('prod'), testConn: this._connFor('test'),
      mode: this.isDbStorage() ? (env === 'prod' ? 'db-prod' : 'db-test') : 'file',
      connected: false, schema: false, marked: false, hasState: false, ready: false, locked: false };
    if (this.isDbStorage() && this._stockDb) {
      const conn = this._connFor(env);
      if (conn) { try { const h = await this._stockDb.health(conn, env); Object.assign(out, h); out.ready = h.connected && h.schema && h.hasState; } catch (e) { out.err = e.message; } }
      out.locked = !out.ready;   // อยู่โหมด db แต่ยังไม่พร้อม = ระบบถูกล็อก
    }
    return out;
  }
  // snapshot blob ปัจจุบันของ env (default = env ที่รันอยู่) → ตาราง snapshot
  async dbSnapshot(env, reason) {
    this._assertDb(); env = env || this.config.env; const conn = this._connFor(env);
    if (!conn) throw new Error('ยังไม่ตั้ง conn ของ ' + env);
    const blob = await this._stockDb.readState(conn, env);
    if (blob == null) throw new Error('ไม่มี state ใน DB (' + env + ')');
    await this._stockDb.snapshot(conn, env, blob, reason || 'manual');
    return { env, bytes: blob.length };
  }
  // refresh test ← prod: snapshot prod ก่อน → copy prod blob → test (+ reload ถ้า instance นี้คือ test)
  async dbRefreshTest(reason) {
    this._assertDb(); const pc = this._connFor('prod'), tc = this._connFor('test');
    if (!pc || !tc) throw new Error('ยังไม่ตั้ง dbProd/dbTest');
    const prodBlob = await this._stockDb.readState(pc, 'prod');
    if (prodBlob == null) throw new Error('prod ยังไม่มี state');
    await this._stockDb.snapshot(pc, 'prod', prodBlob, reason || 'before test refresh');   // snapshot prod ทุกครั้งที่ทดลอง (ตามโจทย์)
    await this._stockDb.writeState(tc, 'test', prodBlob);                                   // copy prod → test
    if (this.config.env === 'test') this._applyRaw(JSON.parse(prodBlob));                   // instance นี้คือ test → โหลดทับทันที
    return { copiedBytes: prodBlob.length, snapshotted: 'prod' };
  }
  async dbListSnapshots(env, limit) { this._assertDb(); env = env || this.config.env; return this._stockDb.listSnapshots(this._connFor(env), env, limit); }
  // restore env จาก snapshot id (snapshot ปัจจุบันก่อนทับ · reload ถ้าเป็น env ที่รันอยู่)
  async dbRestore(env, id) {
    this._assertDb(); env = env || this.config.env; const conn = this._connFor(env);
    const blob = await this._stockDb.getSnapshot(conn, id);
    if (blob == null) throw new Error('ไม่พบ snapshot id ' + id);
    const cur = await this._stockDb.readState(conn, env);
    if (cur != null) await this._stockDb.snapshot(conn, env, cur, 'before restore #' + id);   // กันพลาด: snapshot ก่อน restore
    await this._stockDb.writeState(conn, env, blob);
    if (env === this.config.env) this._applyRaw(JSON.parse(blob));
    return { env, restoredFrom: id, bytes: blob.length };
  }
  // เปิดใช้ DB (Activate) — ensureSchema + marker · มี state เดิม(โครง+น้ำลาย)→ใช้ต่อ · ว่าง→seed จากไฟล์ · flip storage=db + persist ลงไฟล์
  //   *** ต้องสร้าง DB+login มาก่อน (provision SQL) — activate ทำระดับตาราง/ข้อมูล ไม่ได้สร้าง DB ***
  async dbActivate() {
    if (!this._stockDb) throw new Error('ยังไม่ attach dbManager');
    const env = this.config.env; const conn = this._connFor(env);
    if (!conn) throw new Error(`ยังไม่ตั้ง conn ของ ${env} (Setup → DB storage)`);
    await this._stockDb.ensureSchema(conn);                 // สร้างตารางถ้ายังไม่มี (DB ต้องมีก่อน)
    const mark = await this._stockDb.markVerify(conn);      // ทิ้ง/อ่านน้ำลาย
    const blob = await this._stockDb.readState(conn, env);
    let mode;
    if (blob != null) { this._applyRaw(JSON.parse(blob)); mode = 'reused'; }   // มี state เดิม (โครงเดียวกัน + marker) → ใช้ต่อ ไม่ reseed
    else { await this._stockDb.writeState(conn, env, JSON.stringify(this._serialize())); mode = 'seeded'; }   // ว่าง → seed จาก state ปัจจุบัน (ไฟล์)
    this.config.storage = 'db';
    this._dbHydrated = true;                                                   // load/seed สำเร็จ → เปิด flush (พร้อมใช้)
    try { csv.writeJsonAtomic(this.path, this._serialize()); } catch (_) {}    // persist storage=db ลงไฟล์ → restart รู้ + เป็น fallback
    return { env, conn, mode, fresh: mark.fresh, signature: mark.signature, items: this.items.length };
  }
  // Provision (§F) — ปุ่มสร้าง DB เอง · idempotent (เช็กก่อนว่ายังไม่มีค่อยสร้าง):
  //   1) CREATE DATABASE TPKstock_Prod/Test ถ้ายังไม่มี (ผ่าน admin conn = sa ต่อ master)
  //   2) สร้าง connection tpkStockProd/tpkStockTest ใน databases.json ถ้ายังไม่มี (clone creds admin · ชี้ database)
  //   3) ensureSchema ทั้งสอง → พร้อมกด Activate ทันที · ไม่ flip storage (ปล่อยให้ Activate ทำ)
  //   *** แตะเฉพาะ DB TPKstock_* · ไม่ยุ่ง DB อื่น · ไม่ลบ/overwrite connection เดิม ***
  async dbProvision(opts = {}) {
    if (!this._stockDb || !this.dbManager) throw new Error('ยังไม่ attach dbManager');
    const adminName = opts.adminConn || this.config.dbAdminConn || 'autoDB';
    let admin; try { admin = this.dbManager.resolve(adminName); } catch (_) { throw new Error(`ไม่พบ admin connection "${adminName}" (สร้างใน CONFIG → Database ก่อน · ต้องมีสิทธิ์ CREATE DATABASE)`); }
    if ((admin.type || '').toLowerCase() !== 'mssql') throw new Error('admin connection ต้องเป็น mssql: ' + adminName);
    const targets = [
      { env: 'prod', cfg: { ...(this.config.dbProd || {}), ...(opts.dbProd || {}) }, defConn: 'tpkStockProd', defDb: 'TPKstock_Prod' },
      { env: 'test', cfg: { ...(this.config.dbTest || {}), ...(opts.dbTest || {}) }, defConn: 'tpkStockTest', defDb: 'TPKstock_Test' },
    ];
    const result = { adminConn: adminName, databases: [], connections: [] };
    for (const tg of targets) {
      const dbName = (tg.cfg.database || '').trim() || tg.defDb;
      const connName = (tg.cfg.conn || '').trim() || tg.defConn;
      // 1) DATABASE (เช็กก่อน)
      const d = await this._stockDb.ensureDatabase(adminName, dbName);
      result.databases.push({ env: tg.env, ...d });
      // 2) connection (เช็ก dup ก่อน · ไม่ overwrite เดิม)
      let connCreated = false;
      try { this.dbManager.resolve(connName); }
      catch (_) {
        this.dbManager.add({ name: connName, type: 'mssql', host: admin.host, port: admin.port, server: admin.server,
          database: dbName, user: admin.user, password: admin.password, encrypt: admin.encrypt, trustServerCertificate: admin.trustServerCertificate });
        connCreated = true;
      }
      result.connections.push({ env: tg.env, name: connName, database: dbName, created: connCreated });
      // ผูกกลับเข้า config (ให้ตรงกับที่ provision จริง)
      const slot = tg.env === 'prod' ? 'dbProd' : 'dbTest';
      this.config[slot] = { ...(this.config[slot] || {}), conn: connName, database: dbName };
      // 3) schema (idempotent)
      await this._stockDb.ensureSchema(connName);
    }
    try { csv.writeJsonAtomic(this.path, this._serialize()); } catch (_) {}   // persist dbProd/dbTest ที่ provision ลงไฟล์
    return result;
  }
  // Switch storage แบบ runtime (ไม่ต้อง restart) — isDbStorage()/​_save() เป็น dynamic อยู่แล้ว
  //   → db: ตรวจความพร้อมก่อน · ถ้า DB ไม่พร้อม = ไม่สลับเลย (คงอยู่ที่ไฟล์ · ใช้งานต่อได้) ไม่ flip/ไม่ล็อก
  //         ถ้าพร้อม → activate (ensureSchema + load/seed แล้วค่อย flip storage=db) → พร้อมใช้ทันที
  //   → file: setConfig storage=file → _save ดัมพ์ in-memory ล่าสุด → ไฟล์ (ข้อมูลตามมา · ไม่เสีย)
  async dbSwitch(opts = {}) {
    const want = opts.storage === 'file' ? 'file' : 'db';
    const upd = {}; for (const k of ['env', 'dbProd', 'dbTest', 'dbAdminConn']) if (opts[k] !== undefined) upd[k] = opts[k];
    if (want === 'file') {
      upd.storage = 'file';
      this.setConfig(upd);          // setConfig → _save (file mode) เขียน in-memory ล่าสุดลงไฟล์
      this._dbErr = '';
      return { storage: 'file', mode: 'file' };
    }
    // → db: ตั้ง conn/env ก่อน (ยังไม่แตะ storage → ยังเป็น file/เดิม) → ตรวจความพร้อม
    if (!this._stockDb) throw new Error('ยังไม่ attach dbManager');
    if (Object.keys(upd).length) this.setConfig(upd);   // storage ยังเดิม → _save เขียนไฟล์ (ปลอดภัย · ไม่แตะ DB)
    const conn = this._connFor(this.config.env);
    if (!conn) { this._dbErr = `ยังไม่ได้ตั้ง conn ของ ${this.config.env}`; throw new Error(`ยังไม่ได้ตั้ง connection ของ ${this.config.env} — กด "สร้าง/ตรวจ DB (Provision)" หรือกรอก conn ก่อนสลับ`); }
    const h = await this._stockDb.health(conn, this.config.env);
    if (!(h.connected && h.schema)) {   // DB ไม่พร้อม → ห้าม switch · คง storage เดิม (ไฟล์) · ไม่ flip/ไม่ล็อก
      this._dbErr = `DB ไม่พร้อม (connected=${h.connected} schema=${h.schema}) — ไม่สลับ (ยังใช้ ${this.config.storage})`;
      const e = new Error(`DB ไม่พร้อม — ไม่สลับเข้าโหมด DB (connected=${h.connected} · schema=${h.schema}) · provision/เชื่อมต่อให้พร้อมก่อน`);
      e.notReady = true; e.health = h;
      throw e;
    }
    this._dbHydrated = false;          // พร้อม → activate (flush ถูกระงับจนกว่าจะ load/seed เสร็จ · กันเขียนทับ)
    const r = await this.dbActivate();  // load/seed + flip storage=db + hydrate
    return { ...r, storage: 'db', ready: true, locked: false };
  }
  // ARM dedup — ตัดแล้วต้องจำ · ตัดได้ครั้งเดียว (key = ARM ID)
  armIsIssued(id) { return !!this.armIssued[String(id)]; }
  armGetIssued(id) { return this.armIssued[String(id)] || null; }
  armMarkIssued(id, info = {}) { this.armIssued[String(id)] = { ts: Date.now(), ...info }; this._save(); return this.armIssued[String(id)]; }
  // SAP incoming dedup — รับเข้าแล้วต้องจำ · รับซ้ำไม่ได้ (key = INSP_LOT)
  sapIsReceived(id) { return !!this.sapReceived[String(id)]; }
  sapGetReceived(id) { return this.sapReceived[String(id)] || null; }
  sapMarkReceived(id, info = {}) { this.sapReceived[String(id)] = { ts: Date.now(), ...info }; this._save(); return this.sapReceived[String(id)]; }
  // PP รับ FG dedup — รับแล้วต้องจำ · รับซ้ำไม่ได้ (key = PROCESS_ORDER)
  ppIsReceived(id) { return !!this.ppReceived[String(id)]; }
  ppGetReceived(id) { return this.ppReceived[String(id)] || null; }
  ppMarkReceived(id, info = {}) { this.ppReceived[String(id)] = { ts: Date.now(), ...info }; this._save(); return this.ppReceived[String(id)]; }
  // Picking (ขาย) dedup — ส่งมอบแล้วต้องจำ · ตัดซ้ำไม่ได้ (key = lineId)
  pickingIsShipped(id) { return !!this.pickingShipped[String(id)]; }
  pickingGetShipped(id) { return this.pickingShipped[String(id)] || null; }
  pickingMarkShipped(id, info = {}) { this.pickingShipped[String(id)] = { ts: Date.now(), ...info }; this._save(); return this.pickingShipped[String(id)]; }
  // หาคลังที่ถือ lot (batch) นี้อยู่ (onHand มากสุด) — ใช้ resolve stockId ตอนตัดตาม picking
  lotStockId(matcp, lotNo) {
    const lot = this._findLotByNo(matcp, lotNo); if (!lot) return null;
    let best = null, bestQ = 0;
    for (const k of Object.keys(this.balances)) { const p = k.split('|'); if (p[2] === lot.lotId) { const q = this.balances[k].onHand || 0; if (q > bestQ) { bestQ = q; best = p[1]; } } }
    return best;
  }

  // ── normalize ─────────────────────────────────────────────────────────────
  _normGroup(g) {
    return {
      groupCode: g.groupCode, name: String(g.name || '').trim(),
      parentGroup: String(g.parentGroup || '').trim(), seq: num(g.seq) || 0,
      itemTypeScope: ITEM_TYPES.includes(g.itemTypeScope) ? g.itemTypeScope : '',
      defaults: (g.defaults && typeof g.defaults === 'object') ? g.defaults : {},
    };
  }
  _normItem(i) {
    const t = ITEM_TYPES.includes(i.itemType) ? i.itemType : 'rawmat';
    let warns = Array.isArray(i.warnings) ? i.warnings.filter((w) => WARNINGS.includes(w)) : [];
    if (!warns.length) { if (i.hazardClass && WARNINGS.includes(i.hazardClass)) warns.push(i.hazardClass); if (i.coolroom === true) warns.push('coolroom'); }
    return {
      MATCODE: i.MATCODE != null ? i.MATCODE : i.MATCP,   // รหัสสินค้า (MATFG/RAWMAT) · อ่าน MATCP เดิมได้
      itemCode: String(i.itemCode || '').trim(),
      name: String(i.name || '').trim(),
      itemType: t,
      rawmatCode: String(i.rawmatCode || '').trim(),    // เฉพาะ itemType=rawmat: รหัสวัตถุดิบ (block ตามประเภท)
      rawmatName: String(i.rawmatName || '').trim(),    // เฉพาะ itemType=rawmat: ชื่อวัตถุดิบ
      group: String(i.group || '').trim(),
      status: ['active', 'hold', 'discontinued'].includes(i.status) ? i.status : 'active',
      favorite: i.favorite === true, quickCode: String(i.quickCode || '').trim(), seq: num(i.seq) || 0,
      // UOM
      baseUom: String(i.baseUom || 'ea').trim().toUpperCase(),   // baseUom เก็บเป็น CAPITAL เสมอ (KG/L/PCS) — ตรง master + uom logic case-insensitive

      uomChain: Array.isArray(i.uomChain) ? i.uomChain.map((u) => ({ uom: String(u.uom || '').trim(), factorToChild: num(u.factorToChild) || 1, divisible: u.divisible === true, containerRef: String(u.containerRef || '').trim() })) : [],
      // Lot/Expiry/QC (อาจ undefined = สืบทอดจาก group)
      lotControlled: i.lotControlled, qcOnReceipt: i.qcOnReceipt, requiresCoa: i.requiresCoa, sampleCheck: i.sampleCheck === true,
      qcSpec: i.qcSpec, shelfLife: i.shelfLife == null ? undefined : num(i.shelfLife),
      expiryBasis: i.expiryBasis, openShelfLife: i.openShelfLife == null ? undefined : num(i.openShelfLife),
      lotNumberRule: i.lotNumberRule,
      // Stock policy
      // safetyStock (เดิมชื่อ reorderPoint) — เกณฑ์เตือนของใกล้หมด · migrate ค่าเก่า reorderPoint อัตโนมัติ
      defaultLocation: i.defaultLocation, safetyStock: i.safetyStock != null ? num(i.safetyStock) : (i.reorderPoint != null ? num(i.reorderPoint) : undefined),
      min: i.min == null ? undefined : num(i.min), max: i.max == null ? undefined : num(i.max),
      pocketEligible: t === 'rawmat' || t === 'semi', saleEligible: !(t === 'rawmat' || t === 'semi'),   // derived: rawmat+semi→pocket (StoreRM) · merchandise/finished→sale (StoreFG)
      // Hazard
      warnings: warns, hazardClass: warns.find((w) => w !== 'coolroom') || '', coolroom: warns.includes('coolroom'), compatibilityGroup: i.compatibilityGroup, msdsRef: i.msdsRef,
      note: String(i.note || ''),
      // PackSTD (SOI8_RM_PackSTD_Master) — 1 container = packSize packBaseUom · ใช้ count↔base ตอนรับเข้านับ container
      packUnit: String(i.packUnit || '').trim(),                                            // ชนิดบรรจุ (BAG/DRUM/BT/CAN...)
      packSize: (i.packSize == null || i.packSize === '') ? undefined : num(i.packSize),    // จำนวนต่อ 1 container
      packBaseUom: String(i.packBaseUom || '').trim().toUpperCase(),                         // หน่วยฐานของ pack
      manufacturer: String(i.manufacturer || '').trim(), picCode: String(i.picCode || '').trim(), codeName: String(i.codeName || '').trim(),
      source: String(i.source || '').trim(),   // ''=ปกติ · 'autorack'=auto-create stub จาก mirror (§C6)
    };
  }
  _normStock(s) {
    const kind = s.kind === 'container' ? 'container' : 'product';
    return {
      stockId: s.stockId, name: String(s.name || '').trim(),
      kind,                                                     // product (คลังสินค้า) vs container (คลังภาชนะ)
      role: kind === 'container' ? '' : (STORE_ROLES.includes(s.role) ? s.role : 'rw'),   // rw/fg/toll + cm/brm/bfg/ngrm/ngfg/soi12/hes/gw (ยังไม่ยึด logic)
      parent: String(s.parent || '').trim(),                    // ว่าง = main store · มีค่า = คลังย่อยใต้ main
      qrCode: String(s.qrCode || s.stockId || '').trim(),
      enabled: s.enabled !== false, note: String(s.note || ''),
      source: String(s.source || '').trim(),                    // ''=native · 'autorack'=mirror (read-only · §C6)
      readonly: s.readonly === true,                            // mirror = observe-only (รับ/เบิก disable)
      monitorOnly: s.monitorOnly === true,                      // [v3] virtual monitor — derive จาก autorack feed สด · ไม่นับยอด (ตัดจาก total/trace) · readonly เสมอ
      nomaster: s.nomaster === true,                            // [v3] คลังรับของที่ไม่มี defaultLocation (รอจัด location) · counted ปกติ
    };
  }
  _normLot(l) {
    return {
      lotId: l.lotId, lotNo: String(l.lotNo || '').trim(), item: l.item,
      receivedDate: num(l.receivedDate) || Date.now(),
      productionDate: l.productionDate == null ? null : num(l.productionDate),
      expiry: l.expiry == null ? null : num(l.expiry),
      ownership: l.ownership === 'toll' ? 'toll' : 'own',
      customerRef: String(l.customerRef || '').trim(),
      supplier: String(l.supplier || '').trim(), poRef: String(l.poRef || '').trim(), prodRef: String(l.prodRef || '').trim(),
      source: ['purchase', 'production'].includes(l.source) ? l.source : 'purchase',
      coaRef: String(l.coaRef || '').trim(),
      qcStatus: ['pending', 'pass', 'fail', 'conditional'].includes(l.qcStatus) ? l.qcStatus : 'pending',
      status: ['quarantine', 'available', 'hold', 'consumed', 'expired', 'rejected'].includes(l.status) ? l.status : 'available',
      locationRemarks: Array.isArray(l.locationRemarks) ? l.locationRemarks.map((s) => String(s).trim()).filter(Boolean) : [],   // §H ตำแหน่งเก็บในโซน (remark · เลือก+พิมพ์)
    };
  }

  _normContainer(c) {
    const cap = num(c.capacity != null ? c.capacity : c.capacityLit) || 0;   // backward compat: capacityLit
    return {
      containerId: c.containerId, code: String(c.code || '').trim(), name: String(c.name || '').trim(),
      containerCode: String(c.containerCode || '').trim(),   // รหัสภายนอก (external CODE · จับคู่ตอน import/map · ดู STOCK-PLAN field-map)
      type: String(c.type || '').trim(),               // ชนิดภาชนะ (drum/tank/bag/bottle/IBC/box/…)
      size: String(c.size || '').trim(),
      capacity: cap, capacityUom: String(c.capacityUom || 'L').trim(),       // หน่วยฐานที่ภาชนะนี้บรรจุ (L/kg/…)
      capacityLit: cap,                                                       // alias (legacy reader)
      returnable: c.returnable !== false,
      note: String(c.note || ''), enabled: c.enabled !== false,
    };
  }

  // ── inheritance: effective config (group defaults chain → item override) ──────
  _groupChainDefaults(groupCode) {
    const out = {};
    const chain = [];
    let g = this.getGroup(groupCode), guard = 0;
    while (g && guard++ < 20) { chain.unshift(g); g = g.parentGroup ? this.getGroup(g.parentGroup) : null; }
    for (const grp of chain) Object.assign(out, grp.defaults || {});   // ใบล่างทับใบบน
    return out;
  }
  // item ที่ resolve ค่าสืบทอดแล้ว (ค่าที่ item ไม่ได้ override = เอาจาก group · แล้ว default ระบบ)
  effectiveItem(matcp) {
    const it = this.getItem(matcp);
    if (!it) return null;
    const gd = this._groupChainDefaults(it.group);
    const pick = (k, def) => (it[k] !== undefined && it[k] !== null && it[k] !== '') ? it[k] : (gd[k] !== undefined ? gd[k] : def);
    return {
      ...it,
      lotControlled: pick('lotControlled', false) === true,
      qcOnReceipt: pick('qcOnReceipt', false) === true,
      requiresCoa: pick('requiresCoa', false) === true,
      qcSpec: pick('qcSpec', null),
      shelfLife: num(pick('shelfLife', 0)) || 0,
      openShelfLife: num(pick('openShelfLife', 0)) || 0,
      expiryBasis: pick('expiryBasis', 'productionDate'),
      lotNumberRule: pick('lotNumberRule', null),
      hazardClass: pick('hazardClass', ''),
      defaultLocation: pick('defaultLocation', ''),
      safetyStock: num(pick('safetyStock', pick('reorderPoint', 0))) || 0,   // fallback ค่าเก่า reorderPoint (group/item)
      pocketEligible: pick('pocketEligible', true) === true,
      saleEligible: pick('saleEligible', false) === true,
    };
  }

  // ── UOM → base ──────────────────────────────────────────────────────────────
  _factorToBase(item, uom) {
    const U = (s) => String(s || '').trim().toUpperCase();   // uom เทียบแบบ case-insensitive (KG = Kg = kg) — support master หลายเคส
    if (!uom || U(uom) === U(item.baseUom)) return 1;
    const chain = item.uomChain || [];
    const idx = chain.findIndex((u) => U(u.uom) === U(uom));
    if (idx < 0) return 1;                       // ไม่รู้จัก → ถือเป็น base
    let f = 1;
    for (let k = idx; k < chain.length; k++) f *= (chain[k].factorToChild || 1);
    return f;                                    // product ของ factorToChild ตั้งแต่ตัวมันถึง leaf
  }
  toBase(matcp, qty, uom) { const it = this.getItem(matcp); return it ? r6(qty * this._factorToBase(it, uom)) : qty; }

  // ── balance helpers (item × stock × lot) ────────────────────────────────────
  _bkey(matcp, stockId, lotId) { return `${matcp}|${stockId}|${lotId || ''}`; }
  _bal(matcp, stockId, lotId) { return this.balances[this._bkey(matcp, stockId, lotId)] || { onHand: 0, reserved: 0 }; }
  _setBal(matcp, stockId, lotId, b) {
    const k = this._bkey(matcp, stockId, lotId);
    if ((b.onHand || 0) === 0 && (b.reserved || 0) === 0) delete this.balances[k];
    else this.balances[k] = { onHand: r6(b.onHand || 0), reserved: r6(b.reserved || 0) };
  }
  _addOnHand(matcp, stockId, lotId, delta) {
    const b = this._bal(matcp, stockId, lotId);
    this._setBal(matcp, stockId, lotId, { onHand: (b.onHand || 0) + delta, reserved: b.reserved || 0 });
  }
  // รวม onHand ของ item (ทุกคลัง/ทุก lot) — ไม่รวม toll (ของลูกค้า)
  onHandTotal(matcp, { includeToll = false } = {}) {
    let oh = 0;
    for (const k of Object.keys(this.balances)) {
      const [m, , lotId] = k.split('|');
      if (m !== matcp) continue;
      if (!includeToll && lotId) { const lot = this.getLot(lotId); if (lot && lot.ownership === 'toll') continue; }
      oh += this.balances[k].onHand || 0;
    }
    return r6(oh);
  }
  reservedTotal(matcp) {
    let r = 0;
    for (const woId of Object.keys(this.reservations)) for (const it of this.reservations[woId]) if (it.matcp === matcp) r += num(it.qty) || 0;
    return r6(r);
  }
  available(matcp) { return r6(this.onHandTotal(matcp) - this.reservedTotal(matcp)); }
  onHandAt(matcp, stockId, lotId = null) {
    if (lotId != null) return this._bal(matcp, stockId, lotId).onHand || 0;
    let oh = 0; for (const k of Object.keys(this.balances)) { const [m, s] = k.split('|'); if (m === matcp && s === stockId) oh += this.balances[k].onHand || 0; } return r6(oh);
  }

  // ── Group CRUD ──────────────────────────────────────────────────────────────
  getGroup(code) { return this.groups.find((g) => g.groupCode === code) || null; }
  listGroups() { return this.groups.map((g) => ({ ...g })); }
  _isLeafGroup(code) { return !this.groups.some((g) => g.parentGroup === code); }
  createGroup(def) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('group name is required');
    let code = String(def.groupCode || '').trim() || slugCode(name, 'G-');
    if (this.getGroup(code)) throw new Error('groupCode ซ้ำ');
    if (def.parentGroup && !this.getGroup(def.parentGroup)) throw new Error('ไม่พบ parentGroup');
    const rec = this._normGroup({ ...def, groupCode: code, name });
    this.groups.push(rec); this._save();
    return rec;
  }
  updateGroup(code, updates) {
    const i = this.groups.findIndex((g) => g.groupCode === code);
    if (i === -1) throw new Error('not found');
    if (updates.parentGroup === code) throw new Error('parentGroup ห้ามเป็นตัวเอง');
    this.groups[i] = this._normGroup({ ...this.groups[i], ...updates, groupCode: code });
    this._save();
    return this.groups[i];
  }
  removeGroup(code) {
    if (this.groups.some((g) => g.parentGroup === code)) throw new Error('มี group ลูก — ลบลูกก่อน');
    if (this.items.some((i) => i.group === code)) throw new Error('มี item ผูกอยู่');
    const i = this.groups.findIndex((g) => g.groupCode === code);
    if (i === -1) return false;
    this.groups.splice(i, 1); this._save();
    return true;
  }

  // ── Item (master) CRUD ──────────────────────────────────────────────────────
  getItem(matcp) { return this.items.find((i) => i.MATCODE === matcp) || null; }
  // §store-loc: role/store-tab ของคลังจาก X (ตัวแรกของ stockId) — null = X นอกตาราง (คง role เดิม) · ตัวที่ 4 (I) ยังไม่ใช้
  _roleFromStockId(stockId) {
    const s = String(stockId || '').trim().toUpperCase();
    if (s[0] === '4') return s[3] === '1' ? 'fg' : 'rw';   // X=4 → ดู I (ตัวที่ 4): 1→FG(fg) · อื่น(0)→RM(rw)
    return STORE_LOC_X_ROLE[s[0]] || null;
  }

  // import master + คลัง จาก SAP (idempotent upsert · SAP-owned ทับ · local preserve · ชื่อเล่นคลังคงไว้) — seed/demo
  importMaster({ stocks = [], items = [] } = {}) {
    let sNew = 0, sUpd = 0, iNew = 0, iUpd = 0;
    for (const s of stocks) {
      if (!s || !s.stockId) continue;
      const ex = this.getStock(s.stockId);
      // §store-loc: X ของ stockId กำหนด role/store-tab (เช่น C*→cm/StoreCM) · X นอกตาราง = ใช้ role ที่ส่งมา/เดิม
      const role = this._roleFromStockId(s.stockId) || (STORE_ROLES.includes(s.role) ? s.role : (ex ? ex.role : 'rw'));
      if (ex) { ex.role = role; if (s.parent != null) ex.parent = s.parent; sUpd++; }   // คง name (ชื่อเล่น) ที่ user ตั้ง
      else { this.stocks.push(this._normStock({ ...s, role, name: s.name || s.stockId })); sNew++; }
    }
    const SAP = ['name', 'itemType', 'baseUom', 'lotControlled', 'shelfLife', 'openShelfLife', 'group', 'itemCode', 'defaultLocation', 'status', 'safetyStock',   // safetyStock = SAP master col Q (Safety Stock)
      'packUnit', 'packSize', 'packBaseUom', 'manufacturer', 'picCode', 'codeName'];   // PackSTD-owned (import/update จาก SOI8_RM_PackSTD_Master)
    for (const it of items) {
      if (!it || !it.MATCODE) continue;
      const ex = this.getItem(it.MATCODE);
      if (ex) { const m = { ...ex }; for (const k of SAP) { if (it[k] !== undefined && it[k] !== '') m[k] = it[k]; } Object.assign(ex, this._normItem(m)); iUpd++; }   // ทับ SAP-owned · local คงเดิม
      else { this.items.push(this._normItem(it)); iNew++; }
    }
    this._save();
    return { stockNew: sNew, stockUpd: sUpd, itemNew: iNew, itemUpd: iUpd, totalStocks: this.stocks.length, totalItems: this.items.length };
  }
  // หา item จาก MATCODE
  resolveItem(code) { return this.items.find((i) => i.MATCODE === code) || null; }
  listItems() { return this.items.map((i) => ({ ...i })); }
  _validateItem(it, exceptMatcp) {
    if (!it.MATCODE) throw new Error('MATCODE is required');
    if (!it.name) throw new Error('name is required');
    if (this.items.some((x) => x.MATCODE !== exceptMatcp && x.MATCODE === it.MATCODE)) throw new Error('MATCODE ซ้ำ');
    if (it.itemCode && this.items.some((x) => x.MATCODE !== exceptMatcp && x.itemCode && x.itemCode === it.itemCode)) throw new Error('itemCode ซ้ำ');
    if (it.quickCode && this.items.some((x) => x.MATCODE !== exceptMatcp && x.quickCode && x.quickCode === it.quickCode)) throw new Error('quickCode ซ้ำ');
    if (it.group) { const g = this.getGroup(it.group); if (!g) throw new Error('ไม่พบ group'); if (!this._isLeafGroup(it.group)) throw new Error('ผูกได้เฉพาะ leaf-group'); }
    for (const u of (it.uomChain || [])) if (!(u.factorToChild > 0)) throw new Error('uomChain factor ต้อง > 0');
  }
  // หน่วยใหญ่ที่อ้าง container master → uom/factor มาจาก container (capacityLit) ให้สอดคล้องกัน
  _applyContainerUoms(rec) {
    for (const u of (rec.uomChain || [])) {
      if (!u.containerRef) continue;
      const cont = this.getContainer(u.containerRef);
      if (!cont) throw new Error(`หน่วย "${u.uom || u.containerRef}" ต้องอ้าง ภาชนะ (container master) ที่มีอยู่`);
      if (!(cont.capacity > 0)) throw new Error(`ภาชนะ ${cont.name} ยังไม่ตั้ง capacity`);
      // หน่วยภาชนะต้องตรงหน่วยฐานสินค้า (เช่น ถุง=kg ใช้กับสินค้า base kg · drum=L ใช้กับ base L)
      if (cont.capacityUom && rec.baseUom && String(cont.capacityUom).trim().toUpperCase() !== String(rec.baseUom).trim().toUpperCase()) throw new Error(`ภาชนะ ${cont.name} หน่วย ${cont.capacityUom} ไม่ตรงหน่วยฐานสินค้า (${rec.baseUom})`);
      u.factorToChild = cont.capacity;             // 1 [ภาชนะ] = capacity หน่วยฐาน
      u.uom = (cont.name || cont.code || cont.containerId).trim();
    }
  }
  createItem(def) {
    const matcp = String(def.MATCODE || '').trim() || slugCode(def.name, 'CP-');
    const rec = this._normItem({ ...def, MATCODE: matcp });
    this._applyContainerUoms(rec);
    this._validateItem(rec);
    this.items.push(rec); this._save();
    return rec;
  }
  updateItem(matcp, updates) {
    const i = this.items.findIndex((x) => x.MATCODE === matcp);
    if (i === -1) throw new Error('not found');
    const rec = this._normItem({ ...this.items[i], ...updates, MATCODE: matcp });
    this._applyContainerUoms(rec);
    this._validateItem(rec, matcp);
    this.items[i] = rec; this._save();
    return rec;
  }
  removeItem(matcp) {
    if (this.onHandTotal(matcp, { includeToll: true }) !== 0) throw new Error('ยังมีของในสต็อก — ปรับเป็น 0 ก่อนลบ');
    const i = this.items.findIndex((x) => x.MATCODE === matcp);
    if (i === -1) return false;
    this.items.splice(i, 1);
    this.lots = this.lots.filter((l) => l.item !== matcp);
    this._save();
    return true;
  }
  // รวม MATCODE ซ้ำเชิง logical (trim + ตัด 0 นำหน้า · เช่น "13000004" กับ "000…13000004") — เก็บตัวหลัก · เติม field ที่ขาดจากตัวซ้ำ · ย้าย lot/balance · ลบตัวซ้ำ
  //   ตัวหลัก = คะแนนสูงสุด: มีของ(+4) · มีชื่อ(+2) · MATCODE ไม่มี 0 นำหน้า(+1) · apply=false = dry-run (ไม่แก้)
  dedupeMaster({ apply = false } = {}) {
    const norm = (s) => String(s == null ? '' : s).trim().replace(/^0+/, '');
    const g = new Map();
    for (const it of this.items) { const k = norm(it.MATCODE); if (!k) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
    const dups = [...g.values()].filter((a) => a.length > 1);
    const score = (x) => (this.onHandTotal(x.MATCODE, { includeToll: true }) > 0 ? 4 : 0) + (String(x.name || '').trim() ? 2 : 0) + (norm(x.MATCODE) === String(x.MATCODE).trim() ? 1 : 0);
    let removed = 0, filled = 0, blocked = 0, lotsMoved = 0; const sample = [], blockedList = [];
    for (const a of dups) {
      const sorted = [...a].sort((x, y) => score(y) - score(x));
      const keep = sorted[0]; const drop = [];
      for (const o of sorted.slice(1)) {
        const oh = this.onHandTotal(o.MATCODE, { includeToll: true });
        if (oh !== 0) { blocked++; if (blockedList.length < 20) blockedList.push(`${o.MATCODE} มีของ ${oh} — ข้าม`); continue; }
        for (const [k, v] of Object.entries(o)) { if (k === 'MATCODE') continue; const cur = keep[k]; if ((cur == null || cur === '' || (Array.isArray(cur) && !cur.length)) && v != null && v !== '' && !(Array.isArray(v) && !v.length)) { keep[k] = v; filled++; } }
        if (apply) {
          for (const l of this.lots) if (l.item === o.MATCODE) { l.item = keep.MATCODE; lotsMoved++; }
          for (const bk of Object.keys(this.balances)) { const p = bk.split('|'); if (p[0] === o.MATCODE) { this.balances[[keep.MATCODE, p[1], p[2]].join('|')] = this.balances[bk]; delete this.balances[bk]; } }
          const idx = this.items.indexOf(o); if (idx >= 0) this.items.splice(idx, 1);
        }
        drop.push(o.MATCODE); removed++;
      }
      if (drop.length && sample.length < 12) sample.push({ keep: keep.MATCODE, name: keep.name, drop: drop.join(',') });
    }
    if (apply) this._save();
    return { dupGroups: dups.length, removed, filled, lotsMoved, blocked, blockedList, sample };
  }

  // ── Stock node CRUD ─────────────────────────────────────────────────────────
  getStock(id) { return this.stocks.find((s) => s.stockId === id) || null; }
  listStocks(kind = null) { return this.stocks.filter((s) => !kind || s.kind === kind).map((s) => ({ ...s })); }
  // ของในแต่ละคลัง: product → {items:จำนวนรายการที่มีของ} · container → {containers:จำนวนใบ}
  storeLevels() {
    const out = {};
    for (const s of this.stocks) out[s.stockId] = s.kind === 'container' ? { containers: 0 } : { items: 0 };
    const seen = {};
    for (const k of Object.keys(this.balances)) {
      const [m, st] = k.split('|'); const oh = this.balances[k].onHand || 0;
      if (oh <= 1e-9 || !out[st] || out[st].items === undefined) continue;
      (seen[st] = seen[st] || new Set()).add(m);
    }
    for (const st of Object.keys(seen)) out[st].items = seen[st].size;
    // [v3] คลัง autorack-* (virtual monitor) — นับรายการจาก feed สด (ไม่มี balance จริง)
    for (const s of this.stocks) { if (s.monitorOnly && out[s.stockId]) out[s.stockId].items = this._autorackMonitorContents(s.stockId).length; }
    for (const k of Object.keys(this.containerBalances)) {
      const [, st] = k.split('|');
      if (out[st] && out[st].containers !== undefined) out[st].containers = r6((out[st].containers || 0) + (num(this.containerBalances[k]) || 0));
    }
    return out;
  }
  createStock(def) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('stock name is required');
    const kind = def.kind === 'container' ? 'container' : 'product';
    let id = String(def.stockId || '').trim() || slugCode(name, kind === 'container' ? 'CST-' : 'ST-');
    if (this.getStock(id)) throw new Error('stockId ซ้ำ');
    if (this.stocks.some((s) => s.kind === kind && s.name.toLowerCase() === name.toLowerCase())) throw new Error('ชื่อคลังซ้ำ');
    if (def.parent) {
      const p = this.getStock(def.parent);
      if (!p) throw new Error('ไม่พบคลังหลัก (parent)');
      if (p.kind !== kind) throw new Error('คลังย่อยต้องอยู่ใต้คลังชนิดเดียวกัน');
    }
    const rec = this._normStock({ ...def, stockId: id, kind });
    this.stocks.push(rec); this._save();
    return rec;
  }
  updateStock(id, updates) {
    const i = this.stocks.findIndex((s) => s.stockId === id);
    if (i === -1) throw new Error('not found');
    const { kind, ...rest } = updates;   // กันเปลี่ยน kind
    if (rest.parent) { const p = this.getStock(rest.parent); if (!p || p.kind !== this.stocks[i].kind) throw new Error('คลังหลักไม่ถูกต้อง'); if (rest.parent === id) throw new Error('parent ห้ามเป็นตัวเอง'); }
    this.stocks[i] = this._normStock({ ...this.stocks[i], ...rest, stockId: id, kind: this.stocks[i].kind });
    this._save();
    return this.stocks[i];
  }
  removeStock(id) {
    if (this.stocks.some((s) => s.parent === id)) throw new Error('มีคลังย่อยอยู่ใต้คลังนี้ — ลบคลังย่อยก่อน');
    for (const k of Object.keys(this.balances)) if (k.split('|')[1] === id && this.balances[k].onHand) throw new Error('ยังมีของในคลังนี้');
    for (const k of Object.keys(this.containerBalances)) if (k.split('|')[1] === id && this.containerBalances[k]) throw new Error('ยังมีภาชนะในคลังนี้');
    const i = this.stocks.findIndex((s) => s.stockId === id);
    if (i === -1) return false;
    this.stocks.splice(i, 1); this._save();
    return true;
  }
  // [v3] contents ของคลัง autorack-* (virtual monitor) — derive จาก feed สด (ไม่ใช่ balance) · group ตาม matCode+lot · ไม่นับเข้า CSdb
  _autorackMonitorContents(stockId) {
    const map = (this.config || {}).autorackPrefixMap || {};
    const byItem = {};
    for (const ln of (this._autorackFeed || [])) {
      const m = String(ln.matCode || '').trim(); if (!m || map[m.slice(0, 2)] !== stockId) continue;
      const lot = String(ln.lot || '').trim(); const qty = num(ln.qty) || 0; const pcs = (ln.pcs == null) ? null : (num(ln.pcs) || 0);
      const e = byItem[m] = byItem[m] || { onHand: 0, pcs: null, packUnit: String(ln.packUnit || '').trim(), lots: {}, lotPcs: {} };
      e.onHand = r6(e.onHand + qty);
      if (pcs != null) e.pcs = r6((e.pcs || 0) + pcs);   // จำนวนถุงรวม (เฉพาะ FG นับถุง)
      if (lot) { e.lots[lot] = r6((e.lots[lot] || 0) + qty); if (pcs != null) e.lotPcs[lot] = r6((e.lotPcs[lot] || 0) + pcs); }
    }
    return Object.keys(byItem).map((m) => { const it = this.getItem(m); const e = byItem[m]; return {
      matcp: m, name: it ? it.name : m, baseUom: it ? it.baseUom : '', onHand: e.onHand, pcs: e.pcs, packUnit: e.packUnit,
      lots: Object.entries(e.lots).map(([lotNo, qty]) => ({ lotNo, qty, pcs: (e.lotPcs[lotNo] == null ? null : e.lotPcs[lotNo]), expiry: null, status: 'available', inAutorack: true, monitorOnly: true, locationRemarks: [] })) };
    });
  }
  // รายละเอียดคลัง: คลังย่อย + ของในคลัง (รายการ/ภาชนะ)
  storeDetail(id) {
    const st = this.getStock(id); if (!st) throw new Error('ไม่พบคลัง');
    const subStores = this.stocks.filter((s) => s.parent === id).map((s) => ({ stockId: s.stockId, name: s.name }));
    if (st.monitorOnly) return { stock: { ...st }, subStores, contents: this._autorackMonitorContents(id) };   // [v3] autorack-* = view feed สด
    const contents = [];
    if (st.kind === 'container') {
      const byC = {};
      for (const k of Object.keys(this.containerBalances)) {
        const [cid, s, state] = k.split('|'); if (s !== id) continue;
        (byC[cid] = byC[cid] || {})[state] = r6((byC[cid][state] || 0) + (num(this.containerBalances[k]) || 0));
      }
      for (const cid of Object.keys(byC)) { const c = this.getContainer(cid); contents.push({ containerId: cid, name: c ? c.name : cid, byState: byC[cid], total: r6(Object.values(byC[cid]).reduce((a, b) => a + b, 0)) }); }
    } else {
      const byItem = {};
      for (const k of Object.keys(this.balances)) {
        const [m, s, lotId] = k.split('|'); if (s !== id) continue; const oh = this.balances[k].onHand || 0; if (oh <= 1e-9) continue;
        byItem[m] = byItem[m] || { onHand: 0, lots: [] }; byItem[m].onHand = r6(byItem[m].onHand + oh);
        if (lotId) { const lot = this.getLot(lotId); byItem[m].lots.push({ lotNo: lot ? lot.lotNo : '', qty: oh, expiry: lot ? lot.expiry : null, status: lot ? lot.status : '', inAutorack: lot ? !!lot.inAutorack : false, locationRemarks: lot ? (lot.locationRemarks || []) : [] }); }
      }
      for (const m of Object.keys(byItem)) { const it = this.getItem(m); contents.push({ matcp: m, name: it ? it.name : m, baseUom: it ? it.baseUom : '', onHand: byItem[m].onHand, lots: byItem[m].lots }); }
    }
    return { stock: { ...st }, subStores, contents };
  }

  // ── Lot ──────────────────────────────────────────────────────────────────────
  getLot(lotId) { return this.lots.find((l) => l.lotId === lotId) || null; }
  listLots({ matcp = null, stockId = null, status = null } = {}) {
    return this.lots.filter((l) => (!matcp || l.item === matcp) && (!status || l.status === status)
      && (!stockId || this.onHandAt(l.item, stockId, l.lotId) > 0)).map((l) => ({ ...l }));
  }
  // รายละเอียด lot + อยู่คลังไหนเท่าไร + COA/QC
  lotDetail(lotId) {
    const lot = this.getLot(lotId); if (!lot) throw new Error('ไม่พบ lot');
    const it = this.getItem(lot.item);
    const perStock = {}; let total = 0;
    for (const k of Object.keys(this.balances)) { const [, s, l] = k.split('|'); if (l !== lotId) continue; const oh = this.balances[k].onHand || 0; if (oh <= 1e-9) continue; perStock[s] = r6((perStock[s] || 0) + oh); total += oh; }
    const stockNames = {}; for (const s of Object.keys(perStock)) { const st = this.getStock(s); stockNames[s] = st ? st.name : s; }
    const coa = lot.coaRef ? this.coas.find((c) => c.coaId === lot.coaRef) : null;
    const qc = this.qcRecords.filter((q) => q.lotRef === lotId);
    return { lot: { ...lot }, itemName: it ? it.name : '', baseUom: it ? it.baseUom : '', perStock, stockNames, total: r6(total), coa: coa ? { ...coa } : null, qcRecords: qc };
  }
  _genLotNo(eff, stockId) {
    const rule = eff.lotNumberRule;
    const d = new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    const seq = ++this._seq.lot;
    if (rule && rule.template) {
      return rule.template
        .replace(/\{YYYY\}/g, d.getFullYear()).replace(/\{YY\}/g, pad(d.getFullYear() % 100, 2))
        .replace(/\{MM\}/g, pad(d.getMonth() + 1, 2)).replace(/\{DD\}/g, pad(d.getDate(), 2))
        .replace(/\{itemCode\}/g, eff.itemCode || eff.MATCODE).replace(/\{stock\}/g, stockId || '')
        .replace(/\{seq\}/g, pad(seq, 4)).replace(/\{seq\|(\d+)\}/g, (_, w) => pad(seq, +w));
    }
    return `${eff.MATCODE}-${d.getFullYear()}${pad(d.getMonth() + 1, 2)}-${pad(seq, 4)}`;
  }
  _calcExpiry(eff, productionDate, receivedDate, manualExpiry) {
    if (eff.expiryBasis === 'manual') return manualExpiry != null ? num(manualExpiry) : null;
    const g = Number(this.config.defaultShelfLifeDays) || 0;
    const sl = this.config.shelfLifeSource === 'global' ? g : (eff.shelfLife || g);   // 'global'=บังคับใช้ global ทุกตัว · default 'item'=ต่อรายการก่อน (ไม่ตั้ง → global)
    if (!sl) return manualExpiry != null ? num(manualExpiry) : null;
    const basis = eff.expiryBasis === 'receivedDate' ? receivedDate : (productionDate != null ? productionDate : receivedDate);
    return basis + sl * DAY_MS;
  }

  // ── movement log ──────────────────────────────────────────────────────────────
  _logMovement(mv) {
    this.journal.push(mv);
    const lim = Number(this.config.journalLimit) || 800;
    if (this.journal.length > lim) this.journal.splice(0, this.journal.length - lim);
    if (this.config.dbConnection && this.dbManager) this._logToDb(mv).catch(() => {});
    else this._logToCsv(mv);
    // §B: TPKstock DB mode (hydrated) → append journal รายแถว (audit · best-effort · CSV ยังเป็น source of truth ของ journal)
    if (this._dbHydrated && this._stockDb && this.isDbStorage()) {
      const t = this.activeDbTarget();
      if (t && t.conn) this._stockDb.appendJournal(t.conn, this.config.env, mv).catch(() => {});
    }
    return mv;
  }
  _newMovement(f) {
    const id = 'mv' + (++this._seq.mv).toString(36) + Date.now().toString(36).slice(-4);
    const it = this.getItem(f.item);
    const lot = f.lotId ? this.getLot(f.lotId) : null;
    return {
      id, ts: f.ts || Date.now(), type: f.type, item: f.item, itemName: it ? it.name : '',
      lotId: f.lotId || '', lotNo: lot ? lot.lotNo : '',
      fromStock: f.fromStock || '', toStock: f.toStock || '',
      qtyBase: r6(f.qtyBase), uom: f.uom || (it ? it.baseUom : ''),
      ref: String(f.ref || ''), byUser: String(f.byUser || ''), note: String(f.note || ''),
      override: f.override || null,
      batch: String(f.batch || ''),                                         // กลุ่ม action (ถอยเป็นชุด)
      ...(f.actorType ? { actorType: String(f.actorType) } : {}),           // §C8: ใครทำ (user/guest/autorack) · byUser = ชื่อ
      ...(f.ip ? { ip: String(f.ip) } : {}),                                // §A: IP ผู้ทำ (เก็บทุก movement → audit)
      ...(f.srcMap ? { srcMap: String(f.srcMap), srcKey: String(f.srcKey) } : {}),   // ผูก dedup ภายนอก → ล้างตอนถอย
      ...(f.toll ? { toll: true } : {}),                                    // KPI flag (§C3: นับยอดขายแยก toll)
      ...(f.customerRef ? { customerRef: String(f.customerRef) } : {}),
    };
  }
  // batch id ต่อ 1 action (receive/issue/sale/transfer/produce) → ถอยเป็นชุด all-or-nothing
  newBatchId() { return 'bt' + Date.now().toString(36) + (this._batchSeq = (this._batchSeq || 0) + 1).toString(36); }
  _logToCsv(mv) {
    csv.appendDailyRow(this.csvDir, CSV_PREFIX, new Date(mv.ts), CSV_COLS, [
      new Date(mv.ts).toISOString(), mv.id, mv.type, mv.item, mv.itemName || '', mv.lotNo || '',
      mv.fromStock || '', mv.toStock || '', mv.qtyBase, mv.ref || '', mv.byUser || '', mv.note || '',
      mv.batch || '', mv.srcMap || '', mv.srcKey || '', mv.lotId || '',   // persist → revoke รอด restart (lotId ผูก balance)
      mv.actorType || '',   // §C8 actor_type
      mv.ip || '',          // §A ip
    ]);
  }
  _loadJournalFromCsv() {
    if (this.config.dbConnection) return;
    const files = csv.listDailyFiles(this.csvDir, CSV_PREFIX);
    const lim = Number(this.config.journalLimit) || 800;
    const collected = [];
    for (let fi = files.length - 1; fi >= 0 && collected.length < lim; fi--) {
      const { cols, rows } = csv.readCsvTail(path.join(this.csvDir, files[fi]));
      const idx = (k) => cols.indexOf(k);
      const entries = [];
      for (const row of rows) {
        const t = Date.parse(row[idx('timestamp')]); if (isNaN(t)) continue;
        const bi = idx('batch'), smi = idx('src_map'), ski = idx('src_key'), lii = idx('lot_id'), ati = idx('actor_type'), ipi = idx('ip');   // คอลัมน์ใหม่ (ไฟล์เก่าไม่มี → -1)
        const e = { id: row[idx('movement_id')] || '', ts: t, type: row[idx('type')] || '', item: row[idx('item')] || '',
          itemName: row[idx('item_name')] || '', lotNo: row[idx('lot_no')] || '', lotId: lii >= 0 ? (row[lii] || '') : '', fromStock: row[idx('from_stock')] || '',
          toStock: row[idx('to_stock')] || '', qtyBase: num(row[idx('qty_base')]) || 0,
          ref: row[idx('ref')] || '', byUser: row[idx('by_user')] || '', note: row[idx('note')] || '', batch: bi >= 0 ? (row[bi] || '') : '' };
        if (ati >= 0 && row[ati]) e.actorType = row[ati];   // §C8
        if (ipi >= 0 && row[ipi]) e.ip = row[ipi];   // §A
        if (smi >= 0 && row[smi]) { e.srcMap = row[smi]; e.srcKey = ski >= 0 ? (row[ski] || '') : ''; }
        entries.push(e);
      }
      collected.unshift(...entries.slice(Math.max(0, entries.length - (lim - collected.length))));
    }
    this.journal = collected.slice(-lim);
  }
  async _logToDb(mv) {
    const conn = this.config.dbConnection; if (!conn || !this.dbManager) return;
    const table = (this.config.dbTable || 'stock_movement').replace(/[^a-zA-Z0-9_]/g, '');
    let type = 'pg'; try { type = (this.dbManager.resolve(conn).type) || 'pg'; } catch (_) { return; }
    const isMs = type === 'mssql'; const dialect = dialectOf(type);
    await this._ensureTable(conn, table, isMs);
    const phStr = ph(dialect, 16);
    const params = [tsVal(dialect, mv.ts), mv.id, mv.type, mv.item, mv.itemName || '', mv.lotNo || '', mv.lotId || '',
      mv.fromStock || '', mv.toStock || '', mv.qtyBase, mv.ref || '', mv.byUser || '', mv.actorType || '', mv.ip || '', mv.batch || '', mv.note || ''];
    try { await this.dbManager.query(conn, `INSERT INTO ${table} (ts, movement_id, type, item, item_name, lot_no, lot_id, from_stock, to_stock, qty_base, ref, by_user, actor_type, ip, batch, note) VALUES ${phStr}`, params); } catch (_) {}
  }
  async _ensureTable(conn, table, isMs) {
    const key = `${conn}:${table}`; if (this._dbReady.has(key)) return;
    const sql = isMs
      ? `IF OBJECT_ID('${table}','U') IS NULL CREATE TABLE ${table} (id INT IDENTITY PRIMARY KEY, ts DATETIME, movement_id VARCHAR(40), type VARCHAR(24), item VARCHAR(48), item_name NVARCHAR(200), lot_no VARCHAR(64), lot_id VARCHAR(80), from_stock VARCHAR(48), to_stock VARCHAR(48), qty_base FLOAT, ref VARCHAR(80), by_user NVARCHAR(80), actor_type VARCHAR(16), ip VARCHAR(64), batch VARCHAR(40), note NVARCHAR(400), created_at DATETIME2 CONSTRAINT DF_${table}_ca DEFAULT sysutcdatetime())`
      : `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, ts TIMESTAMP, movement_id VARCHAR(40), type VARCHAR(24), item VARCHAR(48), item_name VARCHAR(200), lot_no VARCHAR(64), lot_id VARCHAR(80), from_stock VARCHAR(48), to_stock VARCHAR(48), qty_base DOUBLE PRECISION, ref VARCHAR(80), by_user VARCHAR(80), actor_type VARCHAR(16), ip VARCHAR(64), batch VARCHAR(40), note VARCHAR(400), created_at TIMESTAMP DEFAULT now())`;
    try { await this.dbManager.query(conn, sql, []); this._dbReady.add(key); } catch (_) {}
  }

  // ── guards ─────────────────────────────────────────────────────────────────
  _requireItem(matcp) { const it = this.getItem(matcp); if (!it) throw new Error(`ไม่พบ master (MATCODE ${matcp}) — ต้องสร้าง master ก่อน`); return it; }
  _requireStock(id) { const s = this.getStock(id); if (!s) throw new Error('ไม่พบคลัง'); return s; }
  _assertWritable(id) { const s = this.getStock(id); if (s && s.readonly) throw new Error(`คลัง "${s.name || id}" เป็น mirror อ่านอย่างเดียว (${s.source || 'readonly'}) — รับ/เบิก/ปรับด้วยมือไม่ได้`); }   // กัน mutate mirror (autorack §C6)
  // §I คลัง "กลุ่ม" (มีคลังย่อย · ไม่ใช่ autorack mirror) = หัวกลุ่มเฉย ๆ → เก็บของไม่ได้ · ต้องเข้าคลังย่อย (ใบ)
  isGroupStore(id) { const s = this.getStock(id); if (!s || s.kind === 'container' || s.source === 'autorack' || s.readonly) return false; return this.stocks.some((x) => x.parent === id); }
  _assertHoldable(id) { if (this.isGroupStore(id)) { const s = this.getStock(id); throw new Error(`คลัง "${s.name || id}" เป็นคลังกลุ่ม (มีคลังย่อย) — เก็บของไม่ได้ · เลือกคลังย่อย`); } }
  // §C5: routing ตาม itemType → role ของคลัง (rawmat + semi → rw/StoreRM · merchandise/finished → fg/StoreFG · container=คลังแยก)
  _roleForItemType(itemType) { return (itemType === 'rawmat' || itemType === 'semi') ? 'rw' : 'fg'; }
  // §C5 routing · ownership='toll' → ต้องเข้าคลัง toll แยก (role='toll') ไม่ว่า itemType ใด (§C3)
  _guardRouting(master, st, ownership = 'own') {
    if (ownership === 'toll') {
      if (st.kind === 'product' && st.role !== 'toll') {
        throw new Error(`§C3: ของ toll (ลูกค้าฝาก) ต้องเข้าคลัง toll (role=toll) · คลัง '${st.name}' เป็น role=${st.role}`);
      }
      return;
    }
    // §C5 บังคับเฉพาะ role ที่นิยามแล้ว (rw/fg/toll) — own ต้องเข้า rw/fg ตาม itemType (toll รับเฉพาะ toll)
    // role ใหม่ (cm/brm/bfg/ngrm/ngfg/soi12/hes/gw) ยังไม่ยึด logic → รับ/เบิกเสรี
    if (st.kind !== 'product' || (st.role !== 'rw' && st.role !== 'fg' && st.role !== 'toll')) return;
    const want = this._roleForItemType(master.itemType);
    if (st.role !== want) {
      throw new Error(`§C5: '${master.itemType}' ต้องเข้า ${want === 'rw' ? 'StoreRM' : 'StoreFG'} (role=${want}) · คลัง '${st.name}' เป็น role=${st.role}`);
    }
  }
  _guardNeg(after, matcp) { if (after < -1e-9 && !this.config.allowNegative) { const it = this.getItem(matcp); throw new Error(`สต็อกไม่พอ (${it ? it.name : matcp})`); } }

  // ── Movement: receive (purchase) ────────────────────────────────────────────
  receive({ item, stockId, qty, uom, productionDate, ownership, customerRef, expiry, lotNo,
            supplier, poRef, coaRef, byUser, actorType, ip, ref, note, srcMap, srcKey, locationRemarks }) {
    this._assertWritable(stockId);
    const master = this._requireItem(item);
    const eff = this.effectiveItem(item);
    const st = this._requireStock(stockId || eff.defaultLocation);
    this._assertHoldable(st.stockId);   // §I คลังกลุ่มรับเข้าไม่ได้
    this._guardRouting(master, st, ownership === 'toll' ? 'toll' : 'own');   // §C5 + §C3: toll→คลัง toll
    const q = posQty(qty);
    const qtyBase = r6(q * this._factorToBase(master, uom || master.baseUom));
    let lotId = '';
    if (eff.lotControlled) {
      const recvTs = Date.now();
      const prod = productionDate != null ? num(productionDate) : null;
      const exp = expiry != null ? num(expiry) : this._calcExpiry(eff, prod, recvTs, expiry);
      // gate: ต้อง QC หรือ COA → quarantine ก่อน
      const needGate = eff.qcOnReceipt || (eff.requiresCoa && !coaRef);
      const lot = this._normLot({
        lotId: 'lot' + (this._seq.lot + 1).toString(36) + Date.now().toString(36).slice(-4),
        lotNo: String(lotNo || '').trim() || this._genLotNo({ ...eff, MATCODE: master.MATCODE }, st.stockId),
        item: master.MATCODE, receivedDate: recvTs, productionDate: prod, expiry: exp,
        ownership: ownership === 'toll' ? 'toll' : 'own', customerRef,
        supplier, poRef, coaRef, qcStatus: eff.qcOnReceipt ? 'pending' : 'pass',
        status: needGate ? 'quarantine' : 'available',
        locationRemarks: Array.isArray(locationRemarks) ? locationRemarks : [],   // §H ตำแหน่งเก็บในโซน
      });
      this._seq.lot += 1; this.lots.push(lot); lotId = lot.lotId;   // ต้อง bump seq กัน lotId ชนกันเมื่อรับหลาย lot ใน ms เดียว
    }
    this._addOnHand(master.MATCODE, st.stockId, lotId, qtyBase);
    // §H จำตำแหน่งที่พิมพ์ใหม่ → เพิ่มเป็น tag ของคลังนี้ (ครั้งหน้าเป็นตัวเลือก) · ข้าม label ที่มี prefix store (ของ sub-store) + ที่มีอยู่แล้ว
    if (Array.isArray(locationRemarks)) {
      for (const rm of locationRemarks) {
        const lb = String(rm || '').trim(); if (!lb || lb.includes(' · ')) continue;
        const exists = this.locationTags.some((t) => String(t.label || '').trim() === lb && (t.storeId === st.stockId || !t.storeId || this.stocks.some((s) => s.stockId === t.storeId && s.parent === st.stockId)));
        if (!exists) { try { this.addLocationTag({ storeId: st.stockId, label: lb }); } catch (_) {} }
      }
    }
    this._save();
    return { movement: this._logMovement(this._newMovement({ type: 'receive', item: master.MATCODE, lotId, toStock: st.stockId, qtyBase, uom: uom || master.baseUom, ref: ref || poRef, byUser, actorType, ip, note, batch: this.newBatchId(), srcMap, srcKey })),
      lotId };
  }

  // §H ตั้ง/แก้ remark ตำแหน่งในโซน ที่ตัว lot โดยตรง (เผื่อของเดิม · ไม่แตะ stock)
  setLotRemarks(lotId, remarks) {
    const lot = this.getLot(lotId); if (!lot) throw new Error('ไม่พบ lot');
    lot.locationRemarks = Array.isArray(remarks) ? remarks.map((s) => String(s).trim()).filter(Boolean) : [];
    this._save(); return { ...lot };
  }
  // ปล่อย lot จาก quarantine → available (manual QC/COA gate · เฟสนี้)
  releaseLot(lotId, { coaRef, qcStatus, byUser } = {}) {
    const lot = this.getLot(lotId); if (!lot) throw new Error('ไม่พบ lot');
    if (coaRef) lot.coaRef = String(coaRef);
    if (qcStatus) lot.qcStatus = qcStatus;
    const eff = this.effectiveItem(lot.item);
    if (eff.requiresCoa && !lot.coaRef) throw new Error('ต้องแนบ COA ก่อนปล่อย');
    if (lot.qcStatus === 'fail') throw new Error('lot QC ไม่ผ่าน (fail)');
    lot.status = 'available'; this._save();
    return { ...lot };
  }

  // ── เลือก lot ตาม FEFO (ใกล้หมดอายุก่อน · available เท่านั้น) ──────────────────
  // ownership: null=ไม่กรอง (เบิก/โอน/ผลิต) · 'own'=เฉพาะของเรา (ขายเลย) · 'toll'=เฉพาะของลูกค้า (toll-out)
  // custRef: toll-out ผูกลูกค้า — ตัดได้เฉพาะ lot ของลูกค้ารายนั้น (§C3: ขายให้คนอื่นไม่ได้)
  _pickLots(matcp, stockId, qtyBase, eff, allowOverride, ownership = null, custRef = null) {
    const cands = this.lots
      .filter((l) => l.item === matcp && l.status === 'available' && this.onHandAt(matcp, stockId, l.lotId) > 0)
      .filter((l) => ownership == null || (ownership === 'toll' ? l.ownership === 'toll' : l.ownership !== 'toll'))
      .filter((l) => !(ownership === 'toll' && custRef) || (l.customerRef || '') === custRef)   // toll ผูกลูกค้า
      .filter((l) => allowOverride || !l.expiry || l.expiry >= Date.now());   // ข้ามหมดอายุไม่ได้ ถ้าไม่ override
    cands.sort((a, b) => (a.expiry || Infinity) - (b.expiry || Infinity) || a.receivedDate - b.receivedDate);  // FEFO
    const picks = []; let need = qtyBase;
    for (const l of cands) {
      if (need <= 1e-9) break;
      const avail = this.onHandAt(matcp, stockId, l.lotId);
      const take = Math.min(avail, need);
      if (take > 0) { picks.push({ lot: l, qty: r6(take) }); need = r6(need - take); }
    }
    return { picks, shortfall: r6(Math.max(0, need)) };
  }

  // ── Movement: issue (FEFO · lot-aware) ───────────────────────────────────────
  issue({ item, stockId, qty, uom, byUser, actorType, ip, ref, purpose, note, override, lotNo, _batch, srcMap, srcKey }) {
    this._assertWritable(stockId);
    const batch = _batch || this.newBatchId();   // 1 การเบิก = 1 batch (FEFO หลาย lot → หลาย mv batch เดียวกัน) · produce ส่ง _batch มา
    const master = this._requireItem(item);   // กฎเหล็ก: ไม่มี master = throw (ตัดไม่ได้)
    // เบิกวัตถุดิบ (rawmat) ต้องระบุ PO เสมอ (เพื่อ trace by PO) · production-consume ส่ง ref=prodRef มาแล้ว
    if (master.itemType === 'rawmat' && !(ref != null && String(ref).trim())) throw new Error('เบิกวัตถุดิบ (rawmat) ต้องระบุ PO');
    const eff = this.effectiveItem(item);
    const st = this._requireStock(stockId);
    this._assertHoldable(st.stockId);   // §I คลังกลุ่มเบิกไม่ได้
    const qtyBase = r6(posQty(qty) * this._factorToBase(master, uom || master.baseUom));
    const wantLot = lotNo != null && String(lotNo).trim() ? String(lotNo).trim() : null;   // ARM = ระบุ lot มา
    const movements = [];
    const picked = [];
    const negatives = [];   // balance ที่ติดลบหลังตัด → ให้ UI popup เตือน
    const trackNeg = (lotId, ln) => { const after = this.onHandAt(master.MATCODE, st.stockId, lotId); if (after < -1e-9) negatives.push({ lotId, lotNo: ln || '', balance: r6(after) }); };
    const done = () => ({ movements, picked, wentNegative: negatives.length > 0, negatives });

    if (!eff.lotControlled && !wantLot) {
      const cur = this.onHandAt(master.MATCODE, st.stockId, '');
      if (cur - qtyBase < -1e-9 && !this.config.allowNegative) this._guardNeg(cur - qtyBase, master.MATCODE);
      this._addOnHand(master.MATCODE, st.stockId, '', -qtyBase);
      trackNeg('', '');
      movements.push(this._logMovement(this._newMovement({ type: 'issue', item: master.MATCODE, fromStock: st.stockId, qtyBase, uom: uom || master.baseUom, ref, byUser, actorType, ip, note: note || purpose, override, batch, srcMap, srcKey })));
      picked.push({ lotId: '', lotNo: '', qty: qtyBase });
      this._save();
      return done();
    }
    // เลือก lot: lot ที่ระบุ (ARM) ก่อน > FEFO
    let picks, shortfall = 0;
    if (wantLot) {
      let lot = this._findLotByNo(master.MATCODE, wantLot);
      if (!lot) lot = this._makeLot(master, wantLot);   // lot ไม่เจอ → สร้างยอด 0 (ไส่ทีหลัง · ตัดติดลบ)
      const avail = this.onHandAt(master.MATCODE, st.stockId, lot.lotId);
      shortfall = Math.max(0, r6(qtyBase - avail));
      if (shortfall > 1e-9 && !this.config.allowNegative) throw new Error(`สต็อกไม่พอ lot ${wantLot} (${master.name}) ขาด ${shortfall} ${master.baseUom}`);
      picks = [{ lot, qty: qtyBase }];
    } else {
      const r = this._pickLots(master.MATCODE, st.stockId, qtyBase, eff, !!override);
      picks = r.picks; shortfall = r.shortfall;
      if (shortfall > 1e-9 && !this.config.allowNegative) throw new Error(`สต็อกไม่พอ (${master.name}) ขาด ${shortfall} ${master.baseUom}`);
      // allowNegative + ของขาด → ตัดส่วนที่ขาดเพิ่ม (lot แรก FEFO ถ้ามี · ไม่มี = lotless) → balance ติดลบจริง
      if (shortfall > 1e-9 && this.config.allowNegative) {
        if (picks.length) picks[0].qty = r6(picks[0].qty + shortfall);
        else picks = [{ lot: { lotId: '', lotNo: '' }, qty: qtyBase }];
      }
    }
    for (const p of picks) {
      this._addOnHand(master.MATCODE, st.stockId, p.lot.lotId, -p.qty);
      trackNeg(p.lot.lotId, p.lot.lotNo);
      if (p.lot.lotId && this.onHandAt(master.MATCODE, st.stockId, p.lot.lotId) <= 1e-9 && this.onHandTotal(master.MATCODE, { includeToll: true }) >= 0) {
        if (this._lotEmpty(p.lot.lotId)) p.lot.status = 'consumed';
      }
      movements.push(this._logMovement(this._newMovement({ type: 'issue', item: master.MATCODE, lotId: p.lot.lotId, fromStock: st.stockId, qtyBase: p.qty, uom: master.baseUom, ref, byUser, actorType, ip, note: note || purpose, override, batch, srcMap, srcKey })));
      picked.push({ lotId: p.lot.lotId, lotNo: p.lot.lotNo, qty: p.qty, fromStock: st.stockId, remarks: (p.lot.locationRemarks || []) });   // §H โชว์ store+remark ตอนเบิก
    }
    this._save();
    return done();
  }
  _lotEmpty(lotId) { for (const k of Object.keys(this.balances)) { if (k.split('|')[2] === lotId && this.balances[k].onHand > 1e-9) return false; } return true; }
  _findLotByNo(matcp, lotNo) { const ln = String(lotNo).trim().toLowerCase(); return this.lots.find((l) => l.item === matcp && String(l.lotNo || '').trim().toLowerCase() === ln) || null; }
  // สร้าง lot placeholder (ยอด 0) ตอน ARM ตัด lot ที่ยังไม่ได้รับเข้า → ตัดติดลบ · ไส่ทีหลัง (receive)
  _makeLot(master, lotNo) {
    const lot = this._normLot({ lotId: 'lot' + (this._seq.lot + 1).toString(36) + Date.now().toString(36).slice(-4),
      lotNo: String(lotNo).trim(), item: master.MATCODE, receivedDate: Date.now(), status: 'available', qcStatus: 'pass' });
    this._seq.lot += 1; this.lots.push(lot); return lot;
  }

  // ── adjust / transfer / return ──────────────────────────────────────────────
  adjust({ item, stockId, lotId = '', qty, mode = 'set', byUser, actorType, ip, ref, note }) {
    const master = this._requireItem(item); this._requireStock(stockId); this._assertWritable(stockId); this._assertHoldable(stockId);
    const cur = this.onHandAt(master.MATCODE, stockId, lotId);
    const target = mode === 'delta' ? cur + (num(qty) || 0) : (num(qty) || 0);
    if (target < -1e-9 && !this.config.allowNegative) throw new Error('ปรับเป็นติดลบไม่ได้');
    const delta = r6(target - cur);
    this._addOnHand(master.MATCODE, stockId, lotId, delta);
    this._save();
    return this._logMovement(this._newMovement({ type: 'adjust', item: master.MATCODE, lotId, toStock: stockId, qtyBase: delta, uom: master.baseUom, ref, byUser, actorType, ip, note }));
  }
  transfer({ item, fromStock, toStock, lotId = '', qty, uom, byUser, actorType, ip, ref, note }) {
    const batch = this.newBatchId();
    const master = this._requireItem(item); this._requireStock(fromStock); this._requireStock(toStock);
    this._assertWritable(fromStock); this._assertWritable(toStock); this._assertHoldable(fromStock); this._assertHoldable(toStock);
    if (fromStock === toStock) throw new Error('คลังต้นทาง/ปลายทางต้องต่างกัน');
    const qtyBase = r6(posQty(qty) * this._factorToBase(master, uom || master.baseUom));
    const eff = this.effectiveItem(item);
    if (eff.lotControlled && !lotId) {
      // ไม่ระบุ lot → FEFO หลาย lot
      const { picks, shortfall } = this._pickLots(master.MATCODE, fromStock, qtyBase, eff, false);
      if (shortfall > 1e-9 && !this.config.allowNegative) throw new Error(`สต็อกไม่พอที่คลังต้นทาง (${master.name})`);
      const mvs = [];
      for (const p of picks) {
        this._addOnHand(master.MATCODE, fromStock, p.lot.lotId, -p.qty);
        this._addOnHand(master.MATCODE, toStock, p.lot.lotId, p.qty);
        mvs.push(this._logMovement(this._newMovement({ type: 'transfer', item: master.MATCODE, lotId: p.lot.lotId, fromStock, toStock, qtyBase: p.qty, uom: master.baseUom, ref, byUser, actorType, ip, note, batch })));
      }
      this._save();
      return { movements: mvs };
    }
    this._guardNeg(this.onHandAt(master.MATCODE, fromStock, lotId) - qtyBase, master.MATCODE);
    this._addOnHand(master.MATCODE, fromStock, lotId, -qtyBase);
    this._addOnHand(master.MATCODE, toStock, lotId, qtyBase);
    this._save();
    return { movements: [this._logMovement(this._newMovement({ type: 'transfer', item: master.MATCODE, lotId, fromStock, toStock, qtyBase, uom: master.baseUom, ref, byUser, actorType, ip, note, batch }))] };
  }
  returnStock({ item, toStock, fromStock = '', lotId = '', qty, uom, byUser, actorType, ip, ref, note }) {
    const master = this._requireItem(item); this._requireStock(toStock); this._assertWritable(toStock); if (fromStock) this._assertWritable(fromStock);
    const qtyBase = r6(posQty(qty) * this._factorToBase(master, uom || master.baseUom));
    if (fromStock) { this._requireStock(fromStock); this._guardNeg(this.onHandAt(master.MATCODE, fromStock, lotId) - qtyBase, master.MATCODE); this._addOnHand(master.MATCODE, fromStock, lotId, -qtyBase); }
    this._addOnHand(master.MATCODE, toStock, lotId, qtyBase);
    this._save();
    return this._logMovement(this._newMovement({ type: 'return', item: master.MATCODE, lotId, fromStock, toStock, qtyBase, uom: master.baseUom, ref, byUser, actorType, ip, note }));
  }

  // ── Reserve (IStockProvider · soft) ─────────────────────────────────────────
  reserve(woId, items) {
    if (!woId) throw new Error('woId is required');
    const list = (items || []).map((it) => { this._requireItem(it.item || it.matcp); return { matcp: it.item || it.matcp, stockId: it.stockId || '', qty: posQty(it.qty) }; });
    this.reservations[woId] = (this.reservations[woId] || []).concat(list);
    this._save();
    return list.map((it) => ({ ...it, available: this.available(it.matcp) }));
  }
  release(woId) { if (this.reservations[woId]) { delete this.reservations[woId]; this._save(); return true; } return false; }
  issueForWo(woId, items, byUser) {
    const mvs = [];
    for (const it of (items || [])) { const r = this.issue({ item: it.item || it.matcp, stockId: it.stockId, qty: it.qty, byUser, ref: woId, note: 'WO issue' }); mvs.push(...r.movements); }
    this.release(woId); return mvs;
  }
  returnForWo(woId, items, byUser) { return (items || []).map((it) => this.returnStock({ item: it.item || it.matcp, toStock: it.stockId, qty: it.qty, byUser, ref: woId, note: 'WO return' })); }

  // ── Alerts / summary / balance ──────────────────────────────────────────────
  reorderAlerts() {
    const out = [];
    for (const it of this.items) {
      if (it.status !== 'active') continue;
      const eff = this.effectiveItem(it.MATCODE);
      if (!(eff.safetyStock > 0)) continue;   // safetyStock=0 = "ไม่ตั้งขั้นต่ำ" (ตั้งใจไม่เตือน · ส่วนใหญ่ของ master เป็น 0 → กัน flood)
      const avail = this.available(it.MATCODE);
      if (avail <= eff.safetyStock) out.push({ matcp: it.MATCODE, name: it.name, baseUom: it.baseUom, available: avail, safetyStock: eff.safetyStock });
    }
    return out;
  }
  expiryAlerts(days = null) {
    const explicit = days != null;                                                  // ระบุ days ตรง ๆ (filter UI) = หน้าต่างคงที่ทุก lot
    const gWin = explicit ? days : (Number(this.config.expiryWarnDays) || 30);       // ไม่ระบุ = เกณฑ์เตือน global (วัน)
    const now = Date.now(); const out = [];
    for (const l of this.lots) {
      if (!l.expiry || l.status === 'consumed' || l.status === 'rejected') continue;
      const oh = this.onHandTotal(l.item, { includeToll: true }) > 0 ? this._lotOnHand(l.lotId) : 0;
      if (oh <= 0) continue;
      const eff = this.effectiveItem(l.item);
      const winDays = (!explicit && Number(eff.openShelfLife) > 0) ? Number(eff.openShelfLife) : gWin;   // item มี min remaining (จาก master) → override เกณฑ์เตือนของตัวเอง
      const left = l.expiry - now;
      if (left <= winDays * DAY_MS) out.push({ lotId: l.lotId, lotNo: l.lotNo, matcp: l.item, expiry: l.expiry, daysLeft: Math.floor(left / DAY_MS), onHand: oh, expired: left < 0, warnDays: winDays });
    }
    return out.sort((a, b) => a.expiry - b.expiry);
  }
  _lotOnHand(lotId) { let oh = 0; for (const k of Object.keys(this.balances)) if (k.split('|')[2] === lotId) oh += this.balances[k].onHand || 0; return r6(oh); }

  // ── autorack mirror (§C6 · read-only · one-way · snapshot replace) ────────────
  autorackStoreIds() { return Object.keys(AUTORACK_STORES); }
  // Set ของ MATCODE ที่มี lot อยู่ใน autorack mirror (มี AR: lot ใด ๆ · แม้ onHand=0 = option ก)
  autorackMats() { const set = new Set(); for (const l of this.lots) { if (String(l.lotId || '').startsWith('AR:') && l.item) set.add(String(l.item)); } return set; }
  // item นี้ autorack คุมไหม (autorack auto เบิกเอง) → กัน ARM/manual ตัด/เบิกซ้ำ (เบิกเกิน · interim รอเคาะ flow จริง)
  inAutorack(matCode) { const m = String(matCode || ''); return m ? this.autorackMats().has(m) : false; }
  // lot เฉพาะตัวนี้ autorack รับไปแล้วไหม (มี AR:{mat}:{lotNo}) → กันรับซ้ำ lot ที่ autorack มีแล้ว (autorack เป็นตัวหลัก · §C6)
  // [v2] lot (MATCODE+lot) อยู่ใน autorack จริงไหม — เช็คจาก _autorackSet (live listStock) · ใช้ได้แม้ยังไม่อยู่ CSdb
  //   (จอ monitor SAP/PP incoming โชว์ "รับผ่าน autorack" · AR badge) · ต้อง refresh ก่อน (autorack ถึง)
  lotInAutorack(matCode, lotNo) { const m = String(matCode || ''), ln = String(lotNo || '').trim(); return (m && ln && this._autorackSet) ? this._autorackSet.has(m + '|' + ln) : false; }
  // [v3] เลือกคลังปลายทาง auto-receive: defaultLocation ของ item (ต้อง holdable + ไม่ใช่ monitor) · ไม่มี/ไม่ผ่าน → NOMASTER-* ตาม prefix
  autoReceiveStoreFor(matCode) {
    let dl = '';
    try { const eff = this.effectiveItem(matCode); dl = eff && eff.defaultLocation; } catch (_) {}
    if (dl) { const st = this.getStock(dl); if (st && !st.monitorOnly && !st.readonly && !this.isGroupStore(dl)) return dl; }
    return NOMASTER_OF(matCode);
  }
  // [v2 P2b] lot (MATCODE+lotNo) มีใน CSdb แล้วไหม (มี balance ที่ไหนก็ได้) — ใช้กัน auto-receive ซ้ำ (dedup เคส 1)
  lotExists(matCode, lotNo) {
    const m = String(matCode || ''), ln = String(lotNo || '').trim(); if (!m || !ln) return false;
    return this.lots.some((l) => String(l.item || '') === m && String(l.lotNo || '') === ln);
  }
  // [v2] คลัง autorack = คลังปกติ (เลิก readonly) · เก็บไว้ "view ของใน autorack" · เติมด้วย auto-receive (P2)
  //   + migrate ครั้งเดียว: ล้าง balance/lot mirror เก่า (จาก §C6 snapshot) เพราะ autorack ไม่เป็นใหญ่แล้ว · CSdb นับเอง
  ensureAutorackStores() {
    let changed = false;
    // [v3] autorack-* = virtual monitor (ดูของใน autorack จริง · ไม่นับยอด · readonly) · derive จาก feed (storeDetail/storeLevels)
    for (const [id, d] of Object.entries(AUTORACK_STORES)) {
      const ex = this.getStock(id);
      if (!ex) { this.stocks.push(this._normStock({ stockId: id, name: d.name, role: d.role, kind: 'product', source: 'autorack', readonly: true, monitorOnly: true })); changed = true; }
      else if (!ex.monitorOnly || !ex.readonly || ex.source !== 'autorack') { ex.source = 'autorack'; ex.readonly = true; ex.monitorOnly = true; changed = true; }
    }
    // [v3] NOMASTER-* = คลังรับ auto-receive ที่ item ไม่มี defaultLocation (counted · รอจัด location)
    for (const [id, d] of Object.entries(NOMASTER_STORES)) {
      const ex = this.getStock(id);
      if (!ex) { this.stocks.push(this._normStock({ stockId: id, name: d.name, role: d.role, kind: 'product', nomaster: true })); changed = true; }
      else if (!ex.nomaster) { ex.nomaster = true; changed = true; }
    }
    // [v3] migration: คลัง autorack-* ต้องไม่มี real balance/lot (เป็น virtual) — ล้าง balance + lot จริงที่ค้างจาก v2 · auto-receive รอบใหม่จะ re-route ไป zone/NOMASTER (lotExists กันซ้ำ)
    const arSet = new Set(this.autorackStoreIds());
    const movedLotIds = new Set();
    for (const k of Object.keys(this.balances)) { const [, s, lotId] = k.split('|'); if (arSet.has(s)) { delete this.balances[k]; if (lotId) movedLotIds.add(lotId); changed = true; } }
    const before = this.lots.length;
    this.lots = this.lots.filter((l) => {
      if (String(l.lotId || '').startsWith('AR:')) return false;                                  // AR: stub (v1)
      if (movedLotIds.has(l.lotId) && this._lotOnHand(l.lotId) <= 1e-9) return false;             // lot ที่อยู่เฉพาะใน autorack-* (v2) · ไม่เหลือ balance ที่ไหนเลย
      return true;
    });
    if (this.lots.length !== before) changed = true;
    if (!this.config.autorackV2) { this.config.autorackV2 = true; changed = true; }
    if (changed) this._save();
  }
  // [v2 · docs/STOCK-CONCEPT-V2.md] เลิก snapshot-replace/reconcile — autorack ไม่เป็นใหญ่แล้ว · CSdb นับเอง
  //   no-op (กันของเก่า/manual "Sync now" มา overwrite ยอด) · การเติม autorack จะทำผ่าน auto-receive (matched · P2)
  syncAutorack() {
    this.ensureAutorackStores();
    return { ok: true, disabled: true, note: 'autorack snapshot ปิดใน v2 — autorack = view-only + auto-receive (P2) · ยอดจริงอยู่ CSdb', stores: this.autorackStoreIds(), lastSync: this.config.autorackLastSync || 0 };
  }

  // [v2 P2a] อัปเดต flag inAutorack บน lot (match MATCODE+lot กับ autorack listStock) → frontend โชว์ icon AR
  //   ไม่แตะยอด · in-memory (ติดไปกับ API · ไม่ persist · recompute ตอน boot/refresh) · ของออกจาก autorack → flag หาย
  refreshAutorackFlags(lines) {
    const set = new Set();
    for (const ln of (lines || [])) {
      const m = String(ln.matCode || '').trim(); const l = String(ln.lot || '').trim();
      if (m && l) set.add(m + '|' + l);
    }
    this._autorackSet = set;   // ของที่อยู่ใน autorack จริง (MATCODE|lot) — ใช้โดย lotInAutorack (จอ monitor + AR badge)
    if (Array.isArray(lines)) this._autorackFeed = lines;   // [v3] เก็บ feed สด → คลัง autorack-* (virtual monitor) derive จากตรงนี้ (storeDetail/storeLevels)
    let flagged = 0;
    for (const lot of this.lots) {
      const v = set.has(String(lot.item || '') + '|' + String(lot.lotNo || ''));
      lot.inAutorack = v;
      if (v) flagged++;
    }
    this.config.autorackFlagsAt = Date.now();
    return { ok: true, autorackItems: set.size, flagged };
  }

  balance(matcp) {
    const it = this._requireItem(matcp);
    const perStock = {}; const perLot = [];
    for (const k of Object.keys(this.balances)) {
      const [m, s, lotId] = k.split('|'); if (m !== matcp) continue;
      const oh = this.balances[k].onHand || 0;
      perStock[s] = (perStock[s] || 0) + oh;
      if (lotId) { const lot = this.getLot(lotId); perLot.push({ stockId: s, lotId, lotNo: lot ? lot.lotNo : '', onHand: oh, expiry: lot ? lot.expiry : null, status: lot ? lot.status : '', inAutorack: lot ? !!lot.inAutorack : false }); }
    }
    const eff = this.effectiveItem(matcp);
    return { matcp, name: it.name, baseUom: it.baseUom, itemType: it.itemType,
      hazardClass: it.hazardClass || eff.hazardClass || '', safetyStock: eff.safetyStock, max: it.max || 0,
      onHand: this.onHandTotal(matcp), available: this.available(matcp), reserved: this.reservedTotal(matcp),
      perStock, lots: perLot };
  }
  overview() {
    return this.items.map((it) => {
      const eff = this.effectiveItem(it.MATCODE);
      const onHand = this.onHandTotal(it.MATCODE);
      const available = this.available(it.MATCODE);
      return { MATCODE: it.MATCODE, name: it.name, itemType: it.itemType, group: it.group,
        baseUom: it.baseUom, status: it.status, defaultLocation: it.defaultLocation, hazardClass: it.hazardClass || eff.hazardClass || '',
        onHand, available, safetyStock: eff.safetyStock, low: eff.safetyStock > 0 && available <= eff.safetyStock,   // 0 = ไม่ตั้งขั้นต่ำ → ไม่ low (เหมือน reorderAlerts §865)
        lotControlled: eff.lotControlled };
    });
  }
  summary() {
    const low = this.reorderAlerts(); const exp = this.expiryAlerts();
    return { items: this.items.length, groups: this.groups.length, stocks: this.stocks.length, containers: this.containers.length, lots: this.lots.filter((l) => l.status !== 'consumed').length,
      lowCount: low.length, expiringCount: exp.filter((e) => !e.expired).length, expiredCount: exp.filter((e) => e.expired).length,
      quarantineCount: this.lots.filter((l) => l.status === 'quarantine').length };
  }
  getMovements({ limit = 200, item = null, stockId = null, prefixes = null } = {}) {
    let j = this.journal;
    if (item) j = j.filter((m) => m.item === item);
    if (stockId) j = j.filter((m) => m.fromStock === stockId || m.toStock === stockId);
    if (Array.isArray(prefixes) && prefixes.length) j = j.filter((m) => prefixes.some((p) => String(m.item || '').startsWith(p)));   // กรองตาม prefix MATCODE (zone FG/RM/CM)
    return j.slice(-limit).reverse();
  }
  // ── History (audit) เต็ม — อ่านจาก CSV ทั้งหมด (ไม่จำกัด journal 800) · filter ได้ · ล่าสุดก่อน ──
  readHistory({ from = null, to = null, item = null, stockId = null, type = null, ref = null, limit = 3000 } = {}) {
    const fromTs = from != null && from !== '' ? num(from) : null;
    const toTs = to != null && to !== '' ? num(to) : null;
    const refQ = ref != null && String(ref).trim() ? String(ref).trim().toLowerCase() : null;
    const match = (m) => (!item || m.item === item) && (!type || m.type === type)
      && (!stockId || m.fromStock === stockId || m.toStock === stockId)
      && (!refQ || (m.ref || '').toLowerCase().includes(refQ))
      && (fromTs == null || m.ts >= fromTs) && (toTs == null || m.ts <= toTs);
    // DB mode: query แบบ async ทำตอน alpha · ตอนนี้ fallback journal (in-memory)
    if (this.config.dbConnection && this.dbManager) return this._annotateHistory(this.journal.filter(match).slice(-limit).reverse());
    const out = [];
    for (const f of csv.listDailyFiles(this.csvDir, CSV_PREFIX)) {
      const { cols, rows } = csv.readCsv(path.join(this.csvDir, f));
      const idx = (k) => cols.indexOf(k);
      for (const row of rows) {
        const t = Date.parse(row[idx('timestamp')]); if (isNaN(t)) continue;
        const m = { id: row[idx('movement_id')] || '', ts: t, type: row[idx('type')] || '', item: row[idx('item')] || '',
          itemName: row[idx('item_name')] || '', lotNo: row[idx('lot_no')] || '', fromStock: row[idx('from_stock')] || '',
          toStock: row[idx('to_stock')] || '', qtyBase: num(row[idx('qty_base')]) || 0,
          ref: row[idx('ref')] || '', byUser: row[idx('by_user')] || '', note: row[idx('note')] || '',
          actorType: idx('actor_type') >= 0 ? (row[idx('actor_type')] || '') : '', ip: idx('ip') >= 0 ? (row[idx('ip')] || '') : '' };   // §C8/§A
        if (match(m)) out.push(m);
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return this._annotateHistory(out.slice(-limit).reverse());
  }
  // เติม flag ให้ History: batch · revoked · revocable (ถอยได้เมื่ออยู่ใน journal + ชนิดรองรับ + ไม่ใช่ autorack/ถอยแล้ว)
  _annotateHistory(rows) {
    const jIdx = {}; for (const m of this.journal) jIdx[m.id] = m;
    const revokedIds = new Set(); for (const e of this.revokeLog) for (const id of (e.mvIds || [])) revokedIds.add(id);
    const REVOCABLE = new Set(['receive', 'issue', 'sale', 'transfer', 'production-receive', 'production-consume']);
    return rows.map((r) => {
      const j = jIdx[r.id];
      const batch = (j && j.batch) || r.batch || '';
      const revoked = !!(j && j.revokedTs) || revokedIds.has(r.id);
      const arLot = j ? String(j.lotId || '').startsWith('AR:') : false;
      const revocable = REVOCABLE.has(r.type) && !revoked && !String(r.type).endsWith('-revoke') && !arLot && !!j && !!batch;
      const external = !!(j && j.srcMap);   // มาจาก SAP/ARM/PP/Picking → เตือน reconcile (R6)
      const itemType = (this.getItem(r.item) || {}).itemType || '';   // แยก history ตามชนิดสินค้า
      return { ...r, batch, revoked, revocable, external, itemType, actor: r.byUser || '', actorType: r.actorType || (j && j.actorType) || '', ip: r.ip || (j && j.ip) || '', ...(j && j.revokedBy ? { revokedBy: j.revokedBy, revokeReason: j.revokeReason || '' } : {}) };   // §C8/§A
    });
  }
  // ── Kardex ต่อ item (+stock) — รับ/จ่าย/คงเหลือ running + opening ──
  getCard({ item, stockId = null, from = null, to = null } = {}) {
    if (!item) throw new Error('item required');
    const fromTs = from != null && from !== '' ? num(from) : null;
    const toTs = to != null && to !== '' ? num(to) : null;
    const all = this.readHistory({ item, stockId, to: toTs, limit: 100000 }).slice().reverse();   // เก่า→ใหม่
    const signed = (m) => {
      if (stockId) return m.toStock === stockId ? m.qtyBase : (m.fromStock === stockId ? -m.qtyBase : 0);
      if (['receive', 'return', 'production-receive'].includes(m.type)) return m.qtyBase;
      if (['issue', 'sale', 'production-consume'].includes(m.type)) return -m.qtyBase;
      if (m.type === 'adjust') return m.qtyBase;   // delta (อาจ +/-)
      return 0;   // transfer = ภายใน item รวมไม่เปลี่ยน
    };
    let running = 0, opening = 0; const rows = [];
    for (const m of all) {
      const d = signed(m);
      if (fromTs != null && m.ts < fromTs) { opening += d; running = opening; continue; }
      running += d;
      rows.push({ ts: m.ts, type: m.type, ref: m.ref, lotNo: m.lotNo, fromStock: m.fromStock, toStock: m.toStock,
        in: d > 0 ? r6(d) : 0, out: d < 0 ? r6(-d) : 0, balance: r6(running), byUser: m.byUser, actor: m.byUser || '', actorType: m.actorType || '' });   // §C8
    }
    return { item, stockId: stockId || '', opening: r6(opening), closing: r6(running), rows };
  }

  // ── Container master (แยกจาก items) + bulk stock ตามสถานะ ──────────────────────
  getContainer(id) { return this.containers.find((c) => c.containerId === id || c.code === id) || null; }
  listContainers() { return this.containers.map((c) => ({ ...c })); }
  createContainer(def) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('container name is required');
    if (!(num(def.capacity != null ? def.capacity : def.capacityLit) > 0)) throw new Error('capacity ต้อง > 0');
    let id = String(def.containerId || def.code || '').trim() || slugCode(name, 'CT-');
    if (this.getContainer(id)) throw new Error('container code ซ้ำ');
    const rec = this._normContainer({ ...def, containerId: id, code: String(def.code || id).trim() });
    this.containers.push(rec); this._save();
    return rec;
  }
  updateContainer(id, updates) {
    const i = this.containers.findIndex((c) => c.containerId === id || c.code === id);
    if (i === -1) throw new Error('not found');
    if (!(num(updates.capacity != null ? updates.capacity : this.containers[i].capacity) > 0)) throw new Error('capacity ต้อง > 0');
    this.containers[i] = this._normContainer({ ...this.containers[i], ...updates, containerId: this.containers[i].containerId });
    // sync uomChain ที่อ้าง container นี้ (capacity เปลี่ยน → factor ตาม)
    for (const it of this.items) { if ((it.uomChain || []).some((u) => u.containerRef === this.containers[i].containerId)) { try { this._applyContainerUoms(it); } catch (_) {} } }
    this._save();
    return this.containers[i];
  }
  removeContainer(id) {
    const cont = this.getContainer(id); if (!cont) return false;
    if (this.items.some((it) => (it.uomChain || []).some((u) => u.containerRef === cont.containerId))) throw new Error('มีสินค้าใช้ภาชนะนี้เป็นหน่วย — แก้ก่อน');
    for (const k of Object.keys(this.containerBalances)) if (k.split('|')[0] === cont.containerId && this.containerBalances[k]) throw new Error('ยังมีภาชนะคงเหลือ');
    this.containers.splice(this.containers.findIndex((c) => c.containerId === cont.containerId), 1); this._save();
    return true;
  }

  // bulk balance ต่อ (container × stock × state)
  _cbKey(id, stockId, state) { return `${id}|${stockId}|${state}`; }
  containerCount(id, stockId, state) { return num(this.containerBalances[this._cbKey(id, stockId, state)]) || 0; }
  _addContainerCount(id, stockId, state, delta) {
    const k = this._cbKey(id, stockId, state);
    const v = r6((num(this.containerBalances[k]) || 0) + delta);
    if (v <= 0) delete this.containerBalances[k]; else this.containerBalances[k] = v;
  }
  _cbLog(type, f) {
    return this._logMovement(this._newMovement({ type, item: f.containerId, toStock: f.toStock || '', fromStock: f.fromStock || '', qtyBase: f.qty, uom: 'ea', byUser: f.byUser, actorType: f.actorType, ip: f.ip || '', note: f.note || '' }));
  }
  _reqContainer(id) { const c = this.getContainer(id); if (!c) throw new Error('ไม่พบภาชนะ'); return c; }
  _reqCStock(id) { const s = this.getStock(id); if (!s || s.kind !== 'container') throw new Error('ต้องเลือกคลังภาชนะ (kind=container)'); return s; }
  _validState(s) { if (!CONTAINER_STATES.includes(s)) throw new Error('state ภาชนะไม่ถูกต้อง'); return s; }

  // รับภาชนะเข้า (ปกติ empty-clean)
  containerReceive({ containerId, stockId, qty, state = 'empty-clean', byUser, actorType, ip, note }) {
    this._reqContainer(containerId); this._reqCStock(stockId); this._validState(state);
    const q = posQty(qty);
    this._addContainerCount(containerId, stockId, state, q); this._save();
    return this._cbLog('container-receive', { containerId, toStock: stockId, qty: q, byUser, actorType, ip, note: note || state });
  }
  // ปรับจำนวน (set/delta) ต่อ state
  containerAdjust({ containerId, stockId, state, qty, mode = 'set', byUser, actorType, ip, note }) {
    this._reqContainer(containerId); this._reqCStock(stockId); this._validState(state);
    const cur = this.containerCount(containerId, stockId, state);
    const target = mode === 'delta' ? cur + (num(qty) || 0) : (num(qty) || 0);
    if (target < -1e-9) throw new Error('ติดลบไม่ได้');
    this._addContainerCount(containerId, stockId, state, r6(target - cur)); this._save();
    return this._cbLog('container-adjust', { containerId, toStock: stockId, qty: r6(target - cur), byUser, actorType, ip, note: `${state}` });
  }
  // เปลี่ยนสถานะ/ย้ายคลัง (เช่น clean→filled, filled→at-customer, returned-dirty→cleaning→empty-clean)
  containerMove({ containerId, stockId, fromState, toState, qty, toStock, byUser, actorType, ip, note }) {
    this._reqContainer(containerId); this._reqCStock(stockId); this._validState(fromState); this._validState(toState);
    const dest = toStock || stockId; if (dest !== stockId) this._reqCStock(dest);
    const q = posQty(qty);
    if (this.containerCount(containerId, stockId, fromState) - q < -1e-9) throw new Error('ภาชนะไม่พอใน state ต้นทาง');
    this._addContainerCount(containerId, stockId, fromState, -q);
    this._addContainerCount(containerId, dest, toState, q);
    this._save();
    return this._cbLog('container-move', { containerId, fromStock: stockId, toStock: dest, qty: q, byUser, actorType, ip, note: `${fromState}→${toState}` });
  }
  listContainerBalances() {
    const out = [];
    for (const k of Object.keys(this.containerBalances)) {
      const [id, stockId, state] = k.split('|');
      out.push({ containerId: id, name: (this.getContainer(id) || {}).name || id, stockId, state, count: this.containerBalances[k] });
    }
    return out;
  }
  containerSummary() {
    return this.containers.map((c) => {
      const byState = {};
      let total = 0;
      for (const s of CONTAINER_STATES) {
        let n = 0;
        for (const st of this.stocks) { if (st.kind !== 'container') continue; n += this.containerCount(c.containerId, st.stockId, s); }
        if (n) byState[s] = r6(n);
        total += n;
      }
      return { containerId: c.containerId, code: c.code, name: c.name, type: c.type, size: c.size, capacity: c.capacity, capacityUom: c.capacityUom, returnable: c.returnable, total: r6(total), byState };
    });
  }

  // ── Customer CRUD ────────────────────────────────────────────────────────────
  getCustomer(id) { return this.customers.find((c) => c.customerId === id || c.custCode === id) || null; }
  listCustomers() { return this.customers.map((c) => ({ ...c })); }
  createCustomer(def) {
    const name = String(def.name || '').trim(); const custCode = String(def.custCode || '').trim();
    if (!name) throw new Error('customer name is required');
    if (!custCode) throw new Error('custCode is required');
    if (this.customers.some((c) => c.custCode.toLowerCase() === custCode.toLowerCase())) throw new Error('custCode ซ้ำ');
    const rec = { customerId: 'cust' + Date.now().toString(36), custCode, name, contact: def.contact || {}, taxId: String(def.taxId || ''), status: def.status === 'hold' ? 'hold' : 'active', remark: String(def.remark || '') };
    this.customers.push(rec); this._save();
    return rec;
  }
  updateCustomer(id, updates) {
    const i = this.customers.findIndex((c) => c.customerId === id || c.custCode === id);
    if (i === -1) throw new Error('not found');
    this.customers[i] = { ...this.customers[i], ...updates, customerId: this.customers[i].customerId };
    this._save();
    return this.customers[i];
  }
  removeCustomer(id) { const i = this.customers.findIndex((c) => c.customerId === id || c.custCode === id); if (i === -1) return false; this.customers.splice(i, 1); this._save(); return true; }

  // ── COA / QC (gate คุณภาพ) ────────────────────────────────────────────────────
  recordQc({ lotId, inspector, measured, result }) {
    const lot = this.getLot(lotId); if (!lot) throw new Error('ไม่พบ lot');
    const rec = { qcId: 'qc' + (++this._seq.qc).toString(36), lotRef: lotId, inspector: String(inspector || ''), ts: Date.now(),
      measured: Array.isArray(measured) ? measured : [], result: ['pass', 'fail', 'conditional'].includes(result) ? result : 'pass' };
    this.qcRecords.push(rec);
    lot.qcStatus = rec.result;
    this._save();
    return rec;
  }
  attachCoa({ lotId, source, docRef, issuedBy, results, remark }) {
    const lot = this.getLot(lotId); if (!lot) throw new Error('ไม่พบ lot');
    const rec = { coaId: 'coa' + (++this._seq.coa).toString(36), lotRef: lotId, itemRef: lot.item,
      source: source === 'internal' ? 'internal' : 'supplier', status: 'issued', issuedBy: String(issuedBy || ''), issuedAt: Date.now(),
      docRef: String(docRef || ''), results: Array.isArray(results) ? results : [], revision: 1, remark: String(remark || '') };
    this.coas.push(rec);
    lot.coaRef = rec.coaId;
    this._save();
    return rec;
  }
  listCoas({ lotId = null } = {}) { return this.coas.filter((c) => !lotId || c.lotRef === lotId).map((c) => ({ ...c })); }

  // ── Production (consume rawmat FEFO → receive finished ใต้ MATCODE · source=production) ──
  //   outputItem = MATCODE
  produce({ outputItem, qty, uom, toStock, consume, byUser, actorType, ip, prodRef, note }) {
    const master = this.resolveItem(outputItem); if (!master) throw new Error(`ไม่พบ master (${outputItem})`);
    const eff = this.effectiveItem(master.MATCODE);
    const st = this._requireStock(toStock || eff.defaultLocation); this._assertWritable(st.stockId); this._assertHoldable(st.stockId);
    this._guardRouting(master, st);   // §C5: production-receive (finished→StoreFG · semi→StoreRM)
    const outQtyBase = r6(posQty(qty) * this._factorToBase(master, uom || master.baseUom));
    const pr = String(prodRef || ('PRD-' + Date.now().toString(36)));
    const batch = this.newBatchId();   // ผูก consume + output เป็นชุดเดียว → ถอยทั้งแบตช์
    // 1) consume วัตถุดิบ (production-consume) ผ่าน FEFO
    const consumed = [];
    for (const c of (consume || [])) {
      const r = this.issue({ item: c.item, stockId: c.stockId, qty: c.qty, uom: c.uom, byUser, actorType, ip, ref: pr, note: 'production-consume', _batch: batch });
      for (const m of r.movements) m.type = 'production-consume';
      consumed.push(...r.movements);
    }
    // 2) receive finished ใต้ MATCODE · source=production
    let lotId = '';
    if (eff.lotControlled) {
      const recvTs = Date.now();
      const exp = this._calcExpiry(eff, recvTs, recvTs, null);
      const lot = this._normLot({ lotId: 'lot' + (this._seq.lot + 1).toString(36) + Date.now().toString(36).slice(-4),
        lotNo: this._genLotNo({ ...eff, MATCODE: master.MATCODE }, st.stockId), item: master.MATCODE, receivedDate: recvTs, productionDate: recvTs, expiry: exp,
        ownership: 'own', prodRef: pr, source: 'production',
        qcStatus: eff.qcOnReceipt ? 'pending' : 'pass', status: eff.qcOnReceipt || eff.requiresCoa ? 'quarantine' : 'available' });
      this.lots.push(lot); lotId = lot.lotId;
    }
    this._addOnHand(master.MATCODE, st.stockId, lotId, outQtyBase);
    this._save();
    const recv = this._logMovement(this._newMovement({ type: 'production-receive', item: master.MATCODE, lotId, toStock: st.stockId, qtyBase: outQtyBase, uom: uom || master.baseUom, ref: pr, byUser, actorType, ip, note: note || `ผลิต ${master.MATCODE}`, batch }));
    return { prodRef: pr, receive: recv, lotId, consumed };
  }

  // ── Sale / dispatch (FEFO + ship gate QC/COA) ──────────────────────────────────
  // saleMode: 'sell'=ขายเลย (ตัดของเรา · ownership own) · 'toll'=ส่งคืน toll (ตัดของลูกค้า · ownership toll · บังคับระบุลูกค้า)
  sale({ item, stockId, qty, uom, customerRef, byUser, actorType, ip, soRef, note, override, saleMode, lotNo, srcMap, srcKey }) {
    this._assertWritable(stockId);
    const batch = this.newBatchId();
    const master = this._requireItem(item);
    const eff = this.effectiveItem(item);
    if (!eff.saleEligible) throw new Error(`${master.name} ขายไม่ได้ (saleEligible=false)`);
    const mode = saleMode === 'toll' ? 'toll' : 'sell';
    const cust = String(customerRef || '').trim();
    if (mode === 'toll' && !cust) throw new Error('ขายแบบ toll ต้องระบุลูกค้า (เจ้าของของ)');
    const own = mode === 'toll' ? 'toll' : 'own';
    const saleNote = [mode === 'toll' ? 'toll-out' : null, note].filter(Boolean).join(' · ');
    const st = this._requireStock(stockId); this._assertHoldable(st.stockId);   // §I คลังกลุ่มขายไม่ได้
    const qtyBase = r6(posQty(qty) * this._factorToBase(master, uom || master.baseUom));
    const movements = []; const picked = [];   // §H picked: store + remark ของ lot ที่ตัด (โชว์ตอนส่งมอบ)
    if (!eff.lotControlled) {
      // non-lotControlled: ไม่ track ownership ระดับ lot → toll = ป้ายกำกับเท่านั้น
      this._guardNeg(this.onHandAt(master.MATCODE, st.stockId, '') - qtyBase, master.MATCODE);
      this._addOnHand(master.MATCODE, st.stockId, '', -qtyBase);
      movements.push(this._logMovement(this._newMovement({ type: 'sale', item: master.MATCODE, fromStock: st.stockId, qtyBase, uom: uom || master.baseUom, ref: soRef || cust, byUser, actorType, ip, note: saleNote, toll: mode === 'toll', customerRef: cust, batch, srcMap, srcKey })));
    } else {
      let picks, shortfall;
      if (lotNo) {   // ตัด batch เจาะจง (เช่น picking list ระบุ batch) — ไม่ใช่ FEFO
        const lot = this._findLotByNo(master.MATCODE, lotNo);
        if (!lot) {
          if (!this.config.allowNegative) throw new Error(`ไม่พบ lot ${lotNo} (${master.name})`);
          picks = [{ lot: { lotId: '', lotNo: String(lotNo) }, qty: qtyBase }]; shortfall = 0;
        } else {
          const avail = this.onHandAt(master.MATCODE, st.stockId, lot.lotId);
          const take = Math.min(avail, qtyBase);
          picks = take > 0 ? [{ lot, qty: r6(take) }] : []; shortfall = r6(qtyBase - take);
          if (shortfall > 1e-9 && this.config.allowNegative) { if (picks.length) picks[0].qty = r6(picks[0].qty + shortfall); else picks = [{ lot, qty: qtyBase }]; shortfall = 0; }
        }
      } else {
        const r = this._pickLots(master.MATCODE, st.stockId, qtyBase, eff, !!override, own, mode === 'toll' ? cust : null);
        picks = r.picks; shortfall = r.shortfall;
      }
      if (shortfall > 1e-9 && !this.config.allowNegative) throw new Error(`สต็อก${mode === 'toll' ? ` toll ของ ${cust}` : ''}ไม่พอ (${master.name})`);
      for (const p of picks) {
        // ship gate: lot ต้อง QC pass + มี COA (ถ้า requiresCoa) — ข้ามได้ด้วย override · ข้าม lotless
        if (!override && p.lot.lotId) {
          if (p.lot.qcStatus === 'fail') throw new Error(`lot ${p.lot.lotNo} QC fail — ส่งไม่ได้`);
          if (eff.requiresCoa && !p.lot.coaRef) throw new Error(`lot ${p.lot.lotNo} ไม่มี COA — ส่งไม่ได้ (ship gate)`);
        }
        this._addOnHand(master.MATCODE, st.stockId, p.lot.lotId, -p.qty);
        if (this._lotEmpty(p.lot.lotId)) p.lot.status = 'consumed';
        movements.push(this._logMovement(this._newMovement({ type: 'sale', item: master.MATCODE, lotId: p.lot.lotId, fromStock: st.stockId, qtyBase: p.qty, uom: master.baseUom, ref: soRef || cust, byUser, actorType, ip, note: saleNote, toll: mode === 'toll', customerRef: cust, override: override ? { byUser, reason: 'ship-gate override' } : null, batch, srcMap, srcKey })));
        picked.push({ lotNo: p.lot.lotNo, fromStock: st.stockId, qty: p.qty, remarks: (p.lot.locationRemarks || []) });
      }
    }
    this._save();
    return { movements, picked, customerRef: cust, saleMode: mode };
  }

  // ── Revoke (ถอยรายการรับ/เบิก/ขาย/โอน/ผลิต ที่ผิด) — compensating movement · ถอยเป็นชุด (batch) ──
  //   reverse onHand · log movement `*-revoke` · mark ตัวเดิม revoked · ล้าง dedup ภายนอก · เก็บ revokeLog
  _reverseOf(m) {
    const t = m.type, q = m.qtyBase, lot = m.lotId || '';
    switch (t) {
      case 'receive': case 'production-receive':              // เคยเพิ่มที่ toStock → ดึงออก
        return { deltas: [{ stock: m.toStock, lotId: lot, delta: -q }], rev: { type: t + '-revoke', fromStock: m.toStock, toStock: '' } };
      case 'issue': case 'production-consume':                // เคยตัดที่ fromStock → คืนกลับ
        return { deltas: [{ stock: m.fromStock, lotId: lot, delta: +q }], rev: { type: t + '-revoke', fromStock: '', toStock: m.fromStock } };
      case 'sale':                                            // เคยตัดที่ fromStock → คืนกลับ
        return { deltas: [{ stock: m.fromStock, lotId: lot, delta: +q }], rev: { type: 'sale-revoke', fromStock: '', toStock: m.fromStock } };
      case 'transfer':                                        // ย้ายกลับ to→from
        return { deltas: [{ stock: m.toStock, lotId: lot, delta: -q }, { stock: m.fromStock, lotId: lot, delta: +q }], rev: { type: 'transfer-revoke', fromStock: m.toStock, toStock: m.fromStock } };
      default: throw new Error(`ถอยรายการชนิด "${t}" ไม่รองรับ`);
    }
  }
  revokeMovement(mvId, { byUser = '', reason = '', actorType = '', ip = '' } = {}) {
    const mv = this.journal.find((m) => m.id === mvId);
    if (!mv) throw new Error('ไม่พบรายการในประวัติล่าสุด (อาจเก่าเกิน journal — ถอยไม่ได้)');
    if (String(mv.type).endsWith('-revoke')) throw new Error('ถอยรายการที่เป็น "การถอย" ไม่ได้');
    // กันถอยซ้ำ — ข้าม restart ด้วย (revokedTs เป็น in-memory · revokeLog persist)
    const revokedSet = new Set(); for (const e of this.revokeLog) for (const id of (e.mvIds || [])) revokedSet.add(id);
    if (mv.revokedTs || revokedSet.has(mvId)) throw new Error('รายการนี้ถูกถอยไปแล้ว');
    // ถอยเป็นชุด (batch เดียวกัน) — all-or-nothing (R3: 1 action = หลาย movement)
    const group = (mv.batch ? this.journal.filter((m) => m.batch === mv.batch) : [mv]).filter((m) => !String(m.type).endsWith('-revoke') && !revokedSet.has(m.id));
    for (const m of group) {
      if (m.revokedTs) throw new Error('บางรายการในชุดนี้ถูกถอยไปแล้ว');
      if (String(m.lotId || '').startsWith('AR:')) throw new Error('รายการจาก autorack mirror ถอยไม่ได้ (R7)');
    }
    // pre-check ติดลบ (atomic · รวม delta ต่อ key ก่อน apply) — R1/R10
    const net = {};
    const plans = group.map((m) => { const r = this._reverseOf(m); for (const d of r.deltas) { const k = m.item + '|' + d.stock + '|' + d.lotId; net[k] = r6((net[k] || 0) + d.delta); } return { m, r }; });
    for (const k of Object.keys(net)) {
      const [it, stock, lotId] = k.split('|');
      if (r6(this.onHandAt(it, stock, lotId) + net[k]) < -1e-6) {
        const lot = lotId ? this.getLot(lotId) : null;
        throw new Error(`ถอยไม่ได้ — ${it}${lot ? ' lot ' + (lot.lotNo || lotId) : ''} ที่ ${stock} จะติดลบ (ของถูกใช้ต่อแล้ว · ต้องถอยรายการที่ใช้ต่อก่อน)`);
      }
    }
    // apply (in-memory ครบก่อน save ครั้งเดียว — R5)
    const revBatch = this.newBatchId();
    const mvIds = [], reverseMvIds = [], cleared = [];
    for (const { m, r } of plans) {
      for (const d of r.deltas) {
        this._addOnHand(m.item, d.stock, d.lotId, d.delta);
        if (d.delta > 0 && d.lotId) { const lot = this.getLot(d.lotId); if (lot && lot.status === 'consumed') lot.status = 'available'; }   // R11: คืน lot ที่หมดแล้ว
      }
      const rev = this._logMovement(this._newMovement({ type: r.rev.type, item: m.item, lotId: m.lotId, fromStock: r.rev.fromStock, toStock: r.rev.toStock, qtyBase: m.qtyBase, uom: m.uom, ref: 'revoke:' + m.id, byUser, actorType, ip, note: reason || 'ถอยรายการ', batch: revBatch }));
      m.revokedTs = Date.now(); m.revokedBy = String(byUser); m.revokeReason = String(reason || ''); m.revokedByMv = rev.id;
      mvIds.push(m.id); reverseMvIds.push(rev.id);
      if (m.srcMap && m.srcKey && this[m.srcMap] && this[m.srcMap][m.srcKey]) { cleared.push({ srcMap: m.srcMap, srcKey: m.srcKey }); delete this[m.srcMap][m.srcKey]; }   // R4: ล้าง dedup หลัง reverse สำเร็จ
    }
    this.revokeLog.push({ ts: Date.now(), byUser: String(byUser), ip: String(ip || ''), reason: String(reason || ''), batch: mv.batch || '', mvIds, reverseMvIds, cleared });
    this._save();
    return { revoked: mvIds.length, reverseMvIds, clearedDedup: cleared, batch: mv.batch || '', external: cleared.length > 0 };
  }

  // ── §H Location tags (ตำแหน่งเก็บในโซน) — super user สร้าง · เลือกตอนรับเข้า (remark · ไม่แตะ stock) ──
  listLocationTags() { return this.locationTags.map((t) => ({ ...t })); }
  addLocationTag({ storeId, label }) {
    const lb = String(label || '').trim(); if (!lb) throw new Error('ต้องระบุ label ตำแหน่ง');
    const sid = String(storeId || '').trim(); if (sid && !this.getStock(sid)) throw new Error('ไม่พบคลัง (storeId)');
    const t = { id: 'loc' + Date.now().toString(36) + (this._locSeq = (this._locSeq || 0) + 1).toString(36), storeId: sid, label: lb, enabled: true };
    this.locationTags.push(t); this._save(); return t;
  }
  updateLocationTag(id, updates = {}) {
    const t = this.locationTags.find((x) => x.id === id); if (!t) throw new Error('ไม่พบ location tag');
    if (updates.label !== undefined) t.label = String(updates.label).trim();
    if (updates.storeId !== undefined) t.storeId = String(updates.storeId || '').trim();
    if (updates.enabled !== undefined) t.enabled = updates.enabled !== false;
    this._save(); return { ...t };
  }
  removeLocationTag(id) { const i = this.locationTags.findIndex((x) => x.id === id); if (i === -1) throw new Error('ไม่พบ location tag'); this.locationTags.splice(i, 1); this._save(); return true; }

  // ── Toll (§C3)

  // ── Toll (§C3) — ของลูกค้าฝากที่ค้างอยู่ (ยังไม่ส่งคืน) group by ลูกค้า → item ──
  //   อ่านจาก toll lot ที่ยังมี onHand · ใช้ติดตาม/reconcile ว่าค้างของใครเท่าไร
  tollOutstanding({ customerRef = null } = {}) {
    const want = customerRef ? String(customerRef).trim() : null;
    const map = new Map();   // custRef → { customerRef, name, totalQty, items: Map }
    for (const k of Object.keys(this.balances)) {
      const oh = this.balances[k].onHand || 0;
      if (oh <= 1e-9) continue;
      const [m, stockId, lotId] = k.split('|');
      if (!lotId) continue;
      const lot = this.getLot(lotId);
      if (!lot || lot.ownership !== 'toll') continue;
      const c = (lot.customerRef || '').trim() || '(ไม่ระบุ)';
      if (want && c !== want) continue;
      if (!map.has(c)) { const cm = this.getCustomer(c); map.set(c, { customerRef: c, name: cm ? cm.name : '', totalQty: 0, items: new Map() }); }
      const e = map.get(c);
      const it = this.getItem(m);
      if (!e.items.has(m)) e.items.set(m, { matCode: m, name: it ? it.name : '', uom: it ? it.baseUom : '', qty: 0, lots: [] });
      const ie = e.items.get(m);
      ie.qty = r6(ie.qty + oh); e.totalQty = r6(e.totalQty + oh);
      ie.lots.push({ lotId, lotNo: lot.lotNo, stockId, qty: r6(oh), receivedDate: lot.receivedDate || null, expiry: lot.expiry || null });
    }
    return Array.from(map.values())
      .map((e) => ({ customerRef: e.customerRef, name: e.name, totalQty: e.totalQty, items: Array.from(e.items.values()) }))
      .sort((a, b) => b.totalQty - a.totalQty);
  }

  // KPI ยอดส่งมอบ (§C3) — รวม own-sale + toll (flag แยก) · นับปริมาณ (ไม่มีเงิน) · อ่านจาก history (sale)
  //   toll ตรวจจาก flag m.toll หรือ note 'toll-out' (ทน CSV ที่ไม่มีคอลัมน์ toll)
  salesKpi({ from = null, to = null, item = null } = {}) {
    const rows = this.readHistory({ from, to, item, type: 'sale', limit: 100000 });
    let own = 0, toll = 0, ownN = 0, tollN = 0;
    for (const m of rows) {
      const q = num(m.qtyBase) || 0;
      const isToll = m.toll === true || /toll-out/.test(m.note || '');
      if (isToll) { toll = r6(toll + q); tollN++; } else { own = r6(own + q); ownN++; }
    }
    return { own, toll, total: r6(own + toll), ownCount: ownN, tollCount: tollN };
  }

  // Fuzzy — ค้นใกล้เคียง %q% ใน master (MATCODE/ชื่อ) + lot (lotNo) · ไม่สนพิมพ์เล็ก/ใหญ่
  searchMaster(q, { limit = 50 } = {}) {
    const t = String(q || '').trim().toUpperCase();
    if (t.length < 1) return { items: [], lots: [] };
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const items = this.items
      .filter((i) => String(i.MATCODE || '').toUpperCase().includes(t) || String(i.name || '').toUpperCase().includes(t))
      .slice(0, lim)
      .map((i) => ({ MATCODE: i.MATCODE, name: i.name, itemType: i.itemType, baseUom: i.baseUom }));
    // onHand รวมของ lot (ทุกคลัง) + คลังที่มีของมากสุด — ใช้ resolve lot→item+stock
    const lotBal = (lotId) => { let oh = 0; let best = ''; let bestQ = 0; for (const k of Object.keys(this.balances)) { const p = k.split('|'); if (p[2] === lotId) { const q = this.balances[k].onHand || 0; oh += q; if (q > bestQ) { bestQ = q; best = p[1]; } } } return { onHand: r6(oh), stockId: best }; };
    const lots = this.lots
      .filter((l) => String(l.lotNo || '').toUpperCase().includes(t))
      .map((l) => { const b = lotBal(l.lotId); return { lotNo: l.lotNo, item: l.item, name: (this.getItem(l.item) || {}).name || '', ownership: l.ownership, onHand: b.onHand, stockId: b.stockId }; })
      .filter((l) => l.onHand > 0)
      .slice(0, lim);
    return { items, lots };
  }

  // ── config + tick ──────────────────────────────────────────────────────────
  getConfig() { return { ...this.config }; }
  setConfig(updates) { this.config = { ...this.config, ...updates }; this._dbReady.clear(); this._save(); return this.config; }
  // DB target ที่ active ตาม env (ใช้ตอน storage='db' · เปิด alpha) — ARM source (SOI8) แยกต่างหาก read-only
  // จัดประเภทจาก prefix ของ MATCODE (longest match) → itemType ('' ถ้าไม่ตรง rule) · ใช้ route รับเข้า/เบิก
  classifyMatcode(matCode) {
    const code = String(matCode || '').trim();
    const rules = Array.isArray(this.config.matPrefixRules) ? this.config.matPrefixRules : [];
    let best = null;
    for (const r of rules) { const p = String(r && r.prefix || '').trim(); if (p && code.startsWith(p) && (!best || p.length > best.prefix.length)) best = { prefix: p, type: r.type }; }
    return best ? best.type : '';
  }
  isDbStorage() { return this.config.storage === 'db'; }
  activeDbTarget() { return this.config.env === 'prod' ? (this.config.dbProd || { conn: '', database: '' }) : (this.config.dbTest || { conn: '', database: '' }); }
  _publish(ref, value) { if (!ref || !this.tagEngine || value == null) return; const bar = ref.indexOf('|'); if (bar < 0) return; try { this.tagEngine.setTagValue(ref.slice(0, bar), ref.slice(bar + 1), value, 'good'); } catch (_) {} }
  evaluate() {
    // หมดอายุ → mark lot expired
    const now = Date.now();
    for (const l of this.lots) if (l.expiry && l.expiry < now && l.status === 'available') l.status = 'expired';
    const low = this.reorderAlerts(); const exp = this.expiryAlerts();
    this._publish(this.config.outLowCountTag, low.length);
    this._publish(this.config.outExpiryCountTag, exp.length);
    return { low, expiry: exp };
  }
  start() { if (this._started) return; this._started = true; try { this.ensureAutorackStores(); } catch (_) {}   // [v2] unlock autorack stores + migrate ครั้งเดียว
    const ms = clampInt(this.config.tickMs, 5000, 3600000, DEFAULT_TICK); this._timer = setInterval(() => { try { this.evaluate(); } catch (_) {} }, ms); try { this.evaluate(); } catch (_) {} }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } this._started = false; }
  reload() { this.stop(); this._load(); this._loadJournalFromCsv(); this.start(); }
}

module.exports = StockManager;
