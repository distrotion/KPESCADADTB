// stockDb.js — MSSQL blob persistence สำหรับ chem-stock (TPKstock_Prod / TPKstock_Test)
//   เก็บ state ทั้งก้อนเป็น JSON blob ต่อ DB (1 row/env) + snapshot ประวัติ (append)
//   *** แตะเฉพาะตาราง dbo.stock_state / dbo.stock_snapshot ใน DB TPKstock_* เท่านั้น · ไม่ยุ่ง DB อื่นเด็ดขาด ***
//   ใช้ dbManager.query(connName, sql, params) (param: {key:val} → @key) — รองรับ blob ใหญ่ (NVARCHAR(MAX)) ผ่าน param ไม่ inline
const ST = 'dbo.stock_state';       // (env PK, json, updatedAt)
const SN = 'dbo.stock_snapshot';    // (id, env, json, ts, reason)
const MT = 'dbo.stock_meta';        // (k PK, v, ts) — "น้ำลาย"/marker: รู้ว่า DB นี้เป็นของระบบเรา → activate ซ้ำใช้ต่อได้
const JN = 'dbo.stock_journal';     // (id, env, ts, …, by_user, actor_type, ip, …, created_at) — §B: audit รายแถว (เปิด SSMS ตรวจสอบได้ · state เป็น blob)
const SIGNATURE = 'KPESCADA-TPKstock-v1';

class StockDb {
  constructor(dbManager) { this.db = dbManager; }

  // สร้างตาราง 3 ตัวถ้ายังไม่มี (idempotent · ไม่แตะตาราง/DB อื่น)
  async ensureSchema(conn) {
    await this.db.query(conn, `IF OBJECT_ID('${ST}','U') IS NULL CREATE TABLE ${ST} (env varchar(16) NOT NULL PRIMARY KEY, json nvarchar(max) NOT NULL, updatedAt datetime2 NOT NULL CONSTRAINT DF_stock_state_u DEFAULT sysutcdatetime())`);
    await this.db.query(conn, `IF OBJECT_ID('${SN}','U') IS NULL CREATE TABLE ${SN} (id int IDENTITY(1,1) PRIMARY KEY, env varchar(16) NOT NULL, json nvarchar(max) NOT NULL, ts datetime2 NOT NULL CONSTRAINT DF_stock_snapshot_ts DEFAULT sysutcdatetime(), reason nvarchar(200) NULL)`);
    await this.db.query(conn, `IF OBJECT_ID('${MT}','U') IS NULL CREATE TABLE ${MT} (k varchar(40) NOT NULL PRIMARY KEY, v nvarchar(200) NULL, ts datetime2 NOT NULL CONSTRAINT DF_stock_meta_ts DEFAULT sysutcdatetime())`);
    // §B: journal รายแถว (audit) — ts = เวลา movement · created_at = เวลา insert จริง · ไม่แตะ state blob
    await this.db.query(conn, `IF OBJECT_ID('${JN}','U') IS NULL CREATE TABLE ${JN} (id bigint IDENTITY(1,1) PRIMARY KEY, env varchar(16) NOT NULL, ts datetime2 NOT NULL, movement_id varchar(40) NULL, type varchar(24) NULL, item varchar(48) NULL, item_name nvarchar(200) NULL, lot_no varchar(64) NULL, lot_id varchar(80) NULL, from_stock varchar(48) NULL, to_stock varchar(48) NULL, qty_base float NULL, ref varchar(80) NULL, by_user nvarchar(80) NULL, actor_type varchar(16) NULL, ip varchar(64) NULL, batch varchar(40) NULL, note nvarchar(400) NULL, created_at datetime2 NOT NULL CONSTRAINT DF_stock_journal_ca DEFAULT sysutcdatetime())`);
  }
  // §B: append 1 movement ลง journal table (audit · best-effort · ไม่ throw ออก) — env = test/prod
  async appendJournal(conn, env, mv) {
    await this.db.query(conn,
      `INSERT INTO ${JN} (env, ts, movement_id, type, item, item_name, lot_no, lot_id, from_stock, to_stock, qty_base, ref, by_user, actor_type, ip, batch, note)
       VALUES (@env, @ts, @mid, @type, @item, @iname, @lotno, @lotid, @fr, @to, @qty, @ref, @by, @at, @ip, @batch, @note)`,
      { env: String(env), ts: new Date(mv.ts || Date.now()), mid: String(mv.id || ''), type: String(mv.type || ''), item: String(mv.item || ''),
        iname: String(mv.itemName || ''), lotno: String(mv.lotNo || ''), lotid: String(mv.lotId || ''), fr: String(mv.fromStock || ''), to: String(mv.toStock || ''),
        qty: Number(mv.qtyBase) || 0, ref: String(mv.ref || ''), by: String(mv.byUser || ''), at: String(mv.actorType || ''), ip: String(mv.ip || ''),
        batch: String(mv.batch || ''), note: String(mv.note || '').slice(0, 400) });
  }
  // สร้าง DATABASE ถ้ายังไม่มี (เช็ก DB_ID ก่อน · idempotent) — ใช้ admin conn (sa) ต่อ master/default
  //   ชื่อ DB เป็น identifier (parameterize ไม่ได้) → whitelist [A-Za-z0-9_] กัน injection
  async ensureDatabase(adminConn, dbName) {
    const name = String(dbName || '');
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('ชื่อ DB ไม่ปลอดภัย (ต้องเป็น A-Z a-z 0-9 _): ' + name);
    const ex = await this.db.query(adminConn, 'SELECT DB_ID(@n) AS id', { n: name });
    if (ex && ex[0] && ex[0].id != null) return { database: name, created: false };
    await this.db.query(adminConn, `CREATE DATABASE [${name}]`);   // bare stmt (เลี่ยง "must be only statement in batch")
    return { database: name, created: true };
  }

  // marker — มี signature แล้ว = DB ของเรา (ใช้ต่อ · fresh=false) · ยังไม่มี = ทิ้งน้ำลาย (fresh=true)
  async markVerify(conn) {
    const r = await this.db.query(conn, `SELECT v FROM ${MT} WHERE k='signature'`);
    if (r && r[0]) return { fresh: false, signature: r[0].v, match: r[0].v === SIGNATURE };
    await this.db.query(conn, `INSERT INTO ${MT} (k, v) VALUES ('signature', @v)`, { v: SIGNATURE });
    return { fresh: true, signature: SIGNATURE, match: true };
  }

  // health (read-only · cheap) — connected (ต่อได้) · schema (มีตาราง) · marked (น้ำลาย) · hasState (มี blob ของ env)
  async health(conn, env) {
    const r = { connected: false, schema: false, marked: false, hasState: false };
    try { await this.db.query(conn, 'SELECT 1 AS ok'); r.connected = true; } catch (_) { return r; }
    try {
      const a = await this.db.query(conn, `SELECT CASE WHEN OBJECT_ID('${ST}','U') IS NULL THEN 0 ELSE 1 END s, CASE WHEN OBJECT_ID('${MT}','U') IS NULL THEN 0 ELSE 1 END m`);
      r.schema = !!(a[0] && a[0].s); const metaOk = !!(a[0] && a[0].m);
      if (r.schema) { const c = await this.db.query(conn, `SELECT COUNT(*) AS n FROM ${ST} WHERE env=@env`, { env: String(env) }); r.hasState = !!(c[0] && c[0].n > 0); }
      if (metaOk) { const g = await this.db.query(conn, `SELECT COUNT(*) AS n FROM ${MT} WHERE k='signature'`); r.marked = !!(g[0] && g[0].n > 0); }
    } catch (_) {}
    return r;
  }
  // อ่าน state blob (string JSON) ของ env — ไม่มี = null
  async readState(conn, env) {
    const r = await this.db.query(conn, `SELECT json FROM ${ST} WHERE env=@env`, { env: String(env) });
    return (r && r[0]) ? r[0].json : null;
  }

  // upsert state blob (MERGE · atomic) — เขียนทับ row ของ env เดียว
  async writeState(conn, env, json) {
    await this.db.query(conn,
      `MERGE ${ST} AS t USING (SELECT @env AS env, @json AS json) AS s ON t.env=s.env
       WHEN MATCHED THEN UPDATE SET json=s.json, updatedAt=sysutcdatetime()
       WHEN NOT MATCHED THEN INSERT (env, json) VALUES (s.env, s.json);`,
      { env: String(env), json: String(json) });
  }

  // append snapshot (ประวัติ · กู้คืนได้) — เก็บ blob ณ ขณะนั้น + เหตุผล
  async snapshot(conn, env, json, reason) {
    await this.db.query(conn, `INSERT INTO ${SN} (env, json, reason) VALUES (@env, @json, @reason)`,
      { env: String(env), json: String(json), reason: String(reason || '').slice(0, 200) });
  }

  // list snapshot (เรียงใหม่→เก่า · ไม่ดึง json เต็ม · เอาแค่ meta + ขนาด)
  async listSnapshots(conn, env, limit = 50) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    return await this.db.query(conn, `SELECT TOP ${lim} id, env, ts, reason, LEN(json) AS bytes FROM ${SN} WHERE env=@env ORDER BY id DESC`, { env: String(env) });
  }

  // ดึง snapshot blob ตาม id (สำหรับ restore)
  async getSnapshot(conn, id) {
    const r = await this.db.query(conn, `SELECT json FROM ${SN} WHERE id=@id`, { id: Number(id) });
    return (r && r[0]) ? r[0].json : null;
  }

  // prune snapshot เก่า เก็บล่าสุด keep ตัว (retention)
  async pruneSnapshots(conn, env, keep = 50) {
    const k = Math.max(1, Number(keep) || 50);
    await this.db.query(conn, `DELETE FROM ${SN} WHERE env=@env AND id NOT IN (SELECT TOP ${k} id FROM ${SN} WHERE env=@env ORDER BY id DESC)`, { env: String(env) });
  }
}
module.exports = StockDb;
