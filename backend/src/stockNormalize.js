// stockNormalize.js — แตก chem-stock state (blob) → ตาราง 2D normalized (MSSQL)
//   เฟส 1 (B): สร้าง schema + migrate ข้อมูลจาก state ปัจจุบัน → ตารางจริง (query/join/report ได้)
//   *** read-only ต่อ state · เขียนเฉพาะตาราง stock_n_* ใน DB ที่ระบุ · idempotent (drop+recreate) ***
//   date เก็บเป็น BIGINT (epoch ms · lossless) · nested (uomChain/warnings/locationRemarks) = NVARCHAR(MAX) JSON
const N = (s) => (s == null ? null : String(s));
const J = (v) => (v == null ? null : JSON.stringify(v));
const NUM = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const BIT = (v) => (v ? 1 : 0);

// ── ตาราง: ddl + คอลัมน์ + ตัวดึงค่าต่อ row ───────────────────────────────────
const TABLES = [
  {
    name: 'stock_n_items', src: (s) => s.items || [],
    ddl: `(matcode NVARCHAR(50) NOT NULL PRIMARY KEY, item_code NVARCHAR(50), name NVARCHAR(200), item_type NVARCHAR(20),
      rawmat_code NVARCHAR(50), rawmat_name NVARCHAR(200), grp NVARCHAR(50), status NVARCHAR(20), favorite BIT, quick_code NVARCHAR(50),
      seq INT, base_uom NVARCHAR(20), uom_chain NVARCHAR(MAX), lot_controlled BIT, qc_on_receipt BIT, requires_coa BIT, sample_check BIT,
      shelf_life INT, expiry_basis NVARCHAR(20), open_shelf_life INT, pocket_eligible BIT, sale_eligible BIT, warnings NVARCHAR(MAX),
      hazard_class NVARCHAR(40), coolroom BIT, note NVARCHAR(400), pack_unit NVARCHAR(20), pack_base_uom NVARCHAR(20),
      manufacturer NVARCHAR(120), pic_code NVARCHAR(50), code_name NVARCHAR(120), source NVARCHAR(20))`,
    cols: ['matcode', 'item_code', 'name', 'item_type', 'rawmat_code', 'rawmat_name', 'grp', 'status', 'favorite', 'quick_code', 'seq', 'base_uom', 'uom_chain', 'lot_controlled', 'qc_on_receipt', 'requires_coa', 'sample_check', 'shelf_life', 'expiry_basis', 'open_shelf_life', 'pocket_eligible', 'sale_eligible', 'warnings', 'hazard_class', 'coolroom', 'note', 'pack_unit', 'pack_base_uom', 'manufacturer', 'pic_code', 'code_name', 'source'],
    row: (i) => [N(i.MATCODE), N(i.itemCode), N(i.name), N(i.itemType), N(i.rawmatCode), N(i.rawmatName), N(i.group), N(i.status), BIT(i.favorite), N(i.quickCode), NUM(i.seq), N(i.baseUom), J(i.uomChain), BIT(i.lotControlled), BIT(i.qcOnReceipt), BIT(i.requiresCoa), BIT(i.sampleCheck), NUM(i.shelfLife), N(i.expiryBasis), NUM(i.openShelfLife), BIT(i.pocketEligible), BIT(i.saleEligible), J(i.warnings), N(i.hazardClass), BIT(i.coolroom), N(i.note), N(i.packUnit), N(i.packBaseUom), N(i.manufacturer), N(i.picCode), N(i.codeName), N(i.source)],
  },
  {
    name: 'stock_n_stocks', src: (s) => s.stocks || [],
    ddl: `(stock_id NVARCHAR(50) NOT NULL PRIMARY KEY, name NVARCHAR(200), kind NVARCHAR(20), role NVARCHAR(20), parent NVARCHAR(50), qr_code NVARCHAR(100), enabled BIT, note NVARCHAR(400), source NVARCHAR(20), readonly BIT)`,
    cols: ['stock_id', 'name', 'kind', 'role', 'parent', 'qr_code', 'enabled', 'note', 'source', 'readonly'],
    row: (s) => [N(s.stockId), N(s.name), N(s.kind), N(s.role), N(s.parent), N(s.qrCode), BIT(s.enabled), N(s.note), N(s.source), BIT(s.readonly)],
  },
  {
    name: 'stock_n_lots', src: (s) => s.lots || [],
    ddl: `(lot_id NVARCHAR(50) NOT NULL PRIMARY KEY, lot_no NVARCHAR(64), matcode NVARCHAR(50), received_date BIGINT, production_date BIGINT, expiry BIGINT,
      ownership NVARCHAR(20), customer_ref NVARCHAR(50), supplier NVARCHAR(120), po_ref NVARCHAR(100), prod_ref NVARCHAR(100), source NVARCHAR(20),
      coa_ref NVARCHAR(100), qc_status NVARCHAR(20), status NVARCHAR(20), location_remarks NVARCHAR(MAX))`,
    cols: ['lot_id', 'lot_no', 'matcode', 'received_date', 'production_date', 'expiry', 'ownership', 'customer_ref', 'supplier', 'po_ref', 'prod_ref', 'source', 'coa_ref', 'qc_status', 'status', 'location_remarks'],
    row: (l) => [N(l.lotId), N(l.lotNo), N(l.item), NUM(l.receivedDate), NUM(l.productionDate), NUM(l.expiry), N(l.ownership), N(l.customerRef), N(l.supplier), N(l.poRef), N(l.prodRef), N(l.source), N(l.coaRef), N(l.qcStatus), N(l.status), J(l.locationRemarks)],
  },
  {
    name: 'stock_n_balance', src: (s) => Object.entries(s.balances || {}).map(([k, v]) => { const [m, st, lot] = k.split('|'); return { m, st, lot, ...v }; }),
    ddl: `(matcode NVARCHAR(50) NOT NULL, stock_id NVARCHAR(50) NOT NULL, lot_id NVARCHAR(50) NOT NULL, on_hand DECIMAL(18,4), reserved DECIMAL(18,4), CONSTRAINT PK_stock_n_balance PRIMARY KEY (matcode, stock_id, lot_id))`,
    cols: ['matcode', 'stock_id', 'lot_id', 'on_hand', 'reserved'],
    row: (b) => [N(b.m), N(b.st), N(b.lot || ''), NUM(b.onHand), NUM(b.reserved)],
  },
  {
    name: 'stock_n_customers', src: (s) => s.customers || [],
    ddl: `(customer_id NVARCHAR(50) NOT NULL PRIMARY KEY, cust_code NVARCHAR(50), name NVARCHAR(200), contact NVARCHAR(200), tax_id NVARCHAR(40), status NVARCHAR(20), remark NVARCHAR(400))`,
    cols: ['customer_id', 'cust_code', 'name', 'contact', 'tax_id', 'status', 'remark'],
    row: (c) => [N(c.customerId), N(c.custCode), N(c.name), N(c.contact), N(c.taxId), N(c.status), N(c.remark)],
  },
  {
    name: 'stock_n_containers', src: (s) => s.containers || [],
    ddl: `(container_id NVARCHAR(50) NOT NULL PRIMARY KEY, code NVARCHAR(50), name NVARCHAR(200), container_code NVARCHAR(50), type NVARCHAR(40), size NVARCHAR(40), capacity DECIMAL(18,4), capacity_uom NVARCHAR(20), capacity_lit DECIMAL(18,4), returnable BIT, note NVARCHAR(400), enabled BIT)`,
    cols: ['container_id', 'code', 'name', 'container_code', 'type', 'size', 'capacity', 'capacity_uom', 'capacity_lit', 'returnable', 'note', 'enabled'],
    row: (c) => [N(c.containerId), N(c.code), N(c.name), N(c.containerCode), N(c.type), N(c.size), NUM(c.capacity), N(c.capacityUom), NUM(c.capacityLit), BIT(c.returnable), N(c.note), BIT(c.enabled)],
  },
  {
    name: 'stock_n_container_balance', src: (s) => Object.entries(s.containerBalances || {}).map(([k, v]) => { const [c, st, state] = k.split('|'); return { c, st, state, qty: v }; }),
    ddl: `(container_id NVARCHAR(50) NOT NULL, stock_id NVARCHAR(50) NOT NULL, state NVARCHAR(30) NOT NULL, qty DECIMAL(18,4), CONSTRAINT PK_stock_n_cbal PRIMARY KEY (container_id, stock_id, state))`,
    cols: ['container_id', 'stock_id', 'state', 'qty'],
    row: (b) => [N(b.c), N(b.st), N(b.state), NUM(b.qty)],
  },
  {
    name: 'stock_n_location_tags', src: (s) => s.locationTags || [],
    ddl: `(id NVARCHAR(50) NOT NULL PRIMARY KEY, store_id NVARCHAR(50), label NVARCHAR(120), enabled BIT)`,
    cols: ['id', 'store_id', 'label', 'enabled'],
    row: (t) => [N(t.id), N(t.storeId), N(t.label), BIT(t.enabled)],
  },
  {
    name: 'stock_n_groups', src: (s) => s.groups || [],
    ddl: `(group_code NVARCHAR(50) NOT NULL PRIMARY KEY, name NVARCHAR(200), defaults NVARCHAR(MAX))`,
    cols: ['group_code', 'name', 'defaults'],
    row: (g) => [N(g.groupCode), N(g.name), J(g.defaults)],
  },
  {
    name: 'stock_n_ext_dedup', src: (s) => ['armIssued', 'sapReceived', 'ppReceived', 'pickingShipped'].flatMap((src) => Object.entries(s[src] || {}).map(([k, v]) => ({ src, k, v }))),
    ddl: `(source NVARCHAR(20) NOT NULL, ext_key NVARCHAR(80) NOT NULL, ts BIGINT, matcode NVARCHAR(50), payload NVARCHAR(MAX), CONSTRAINT PK_stock_n_dedup PRIMARY KEY (source, ext_key))`,
    cols: ['source', 'ext_key', 'ts', 'matcode', 'payload'],
    row: (e) => [N(e.src), N(e.k), NUM(e.v && e.v.ts), N(e.v && e.v.matCode), J(e.v)],
  },
  {
    name: 'stock_n_revoke_log', src: (s) => s.revokeLog || [],
    ddl: `(id INT IDENTITY(1,1) PRIMARY KEY, ts BIGINT, by_user NVARCHAR(100), reason NVARCHAR(400), batch NVARCHAR(40), mv_ids NVARCHAR(MAX), reverse_mv_ids NVARCHAR(MAX))`,
    cols: ['ts', 'by_user', 'reason', 'batch', 'mv_ids', 'reverse_mv_ids'],
    row: (r) => [NUM(r.ts), N(r.byUser), N(r.reason), N(r.batch), J(r.mvIds), J(r.reverseMvIds)],
  },
];

// สร้าง schema (drop+recreate · idempotent ต่อ migration) · prefix stock_n_ เท่านั้น
//   §B audit: ทุกตารางมี synced_at = เวลาเขียน row ของ migration นี้ (DEFAULT เติมเอง · INSERT ไม่ต้องส่ง)
//   หมายเหตุ: snapshot rebuild ทุกครั้ง → synced_at = ความสดของข้อมูล (ไม่ใช่เวลาสร้าง record ดั้งเดิม)
//   ประวัติการเคลื่อนไหวจริง (ใคร/เมื่อไหร่/IP ต่อรายการ) อยู่ที่ journal: CSV stock-logs + ตาราง stock_movement/stock_journal (§A/§B)
//   *** state ที่ migrate ไม่มี journal → ตาราง normalized = "ของตอนนี้" (current state) · audit รายการเดินใช้ journal ***
function _withSyncedAt(name, ddl) {
  return ddl.replace(/^\(/, `(synced_at DATETIME2 NOT NULL CONSTRAINT DF_${name}_sa DEFAULT sysutcdatetime(), `);
}
async function ensureNormalizedSchema(dbm, conn) {
  for (const t of TABLES) {
    await dbm.query(conn, `IF OBJECT_ID('dbo.${t.name}','U') IS NOT NULL DROP TABLE dbo.${t.name}`);
    await dbm.query(conn, `CREATE TABLE dbo.${t.name} ${_withSyncedAt(t.name, t.ddl)}`);
  }
}

// migrate state → ตาราง (batched multi-row insert) · คืนสรุปจำนวนต่อตาราง
async function migrateToNormalized(state, dbm, conn, opts = {}) {
  const summary = {};
  for (const t of TABLES) {
    const rows = t.src(state);
    const batchSize = Math.max(1, Math.floor(2000 / t.cols.length));   // MSSQL ≤2100 params/query → batch ตามจำนวนคอลัมน์
    let done = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const params = {};
      const valuesSql = chunk.map((r, ri) => {
        const vals = t.row(r);
        return '(' + t.cols.map((c, ci) => { const p = `p${ri}_${ci}`; params[p] = vals[ci]; return `@${p}`; }).join(',') + ')';
      }).join(',');
      await dbm.query(conn, `INSERT INTO dbo.${t.name} (${t.cols.join(',')}) VALUES ${valuesSql}`, params);
      done += chunk.length;
    }
    summary[t.name] = done;
  }
  return summary;
}

module.exports = { TABLES, ensureNormalizedSchema, migrateToNormalized };
