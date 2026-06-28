/**
 * Database helper — รองรับ PostgreSQL + MSSQL + MongoDB
 * ใช้ใน script context: db.pg(conn, sql, params) / db.mssql(conn, sql, params)
 *                       db.mongo(conn, collection, op, [args])
 * Cache connection pool/client ตาม connection config (กันสร้างใหม่ทุกครั้ง)
 */
const _pgPools    = new Map();
const _mssqlPools = new Map();
const _mysqlPools = new Map();
const _mongoClients = new Map();

// cache key — รวม credential/option ที่มีผลต่อ connection ด้วย
//   (เดิมไม่รวม password/ssl → เปลี่ยนรหัสแล้ว pool เก่ายังใช้รหัสเดิม — audit MEDIUM)
function _key(conn) {
  return JSON.stringify({
    host: conn.host, port: conn.port, database: conn.database,
    user: conn.user, server: conn.server, password: conn.password,
    encrypt: conn.encrypt, trust: conn.trustServerCertificate, uri: conn.uri,
  });
}

// ── PostgreSQL ────────────────────────────────────────────────────────────
async function pgQuery(conn, sql, params = []) {
  const { Pool } = require('pg');
  const key = _key(conn);
  let pool = _pgPools.get(key);
  if (!pool) {
    const cfg = {
      host:     conn.host || 'localhost',
      port:     conn.port || 5432,
      user:     conn.user,
      password: conn.password,
      max:      conn.max || 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
    // database ว่าง = ใช้ default (ระบุใน query เองได้)
    if (conn.database) cfg.database = conn.database;
    pool = new Pool(cfg);
    pool.on('error', (e) => console.error('[DB:pg] pool error:', e.message));
    _pgPools.set(key, pool);
  }
  const res = await pool.query(sql, params);
  return res.rows;
}

// ── MSSQL ─────────────────────────────────────────────────────────────────
async function mssqlQuery(conn, sql, params = []) {
  const mssql = require('mssql');
  const key = _key(conn);
  let pool = _mssqlPools.get(key);
  if (!pool || !pool.connected) {
    const cfg = {
      server:   conn.server || conn.host || 'localhost',
      port:     conn.port || 1433,
      user:     conn.user,
      password: conn.password,
      pool:     { max: conn.max || 5, min: 0, idleTimeoutMillis: 30000 },
      options:  {
        encrypt: conn.encrypt ?? false,
        trustServerCertificate: conn.trustServerCertificate ?? true,
      },
    };
    // database ว่าง = ต่อ default DB (ใช้ fully-qualified ใน query เช่น [DB].[dbo].[tbl])
    if (conn.database) cfg.database = conn.database;
    pool = new mssql.ConnectionPool(cfg);
    await pool.connect();
    _mssqlPools.set(key, pool);
  }
  const request = pool.request();
  // bind params: @p0, @p1, ... (positional) หรือ {key}→@key
  //   string ยาว > 4000 → NVarChar(MAX) ชัดเจน (กัน inferred length ตัด blob ใหญ่ เช่น JSON state ~MB ของ TPKstock)
  const bind = (name, v) => { if (typeof v === 'string' && v.length > 4000) request.input(name, mssql.NVarChar(mssql.MAX), v); else request.input(name, v); };
  if (Array.isArray(params)) params.forEach((v, i) => bind(`p${i}`, v));
  else if (params && typeof params === 'object') for (const [k, v] of Object.entries(params)) bind(k, v);
  const result = await request.query(sql);
  return result.recordset || [];
}

// ── MySQL / MariaDB (mysql2, pure JS) ───────────────────────────────────────
//   placeholder = ?  เช่น  db.mysql('conn', 'INSERT INTO t(a,b) VALUES(?,?)', [1,2])
async function mysqlQuery(conn, sql, params = []) {
  const mysql = require('mysql2/promise');
  const key = _key(conn);
  let pool = _mysqlPools.get(key);
  if (!pool) {
    const cfg = {
      host: conn.host || 'localhost',
      port: conn.port || 3306,
      user: conn.user,
      password: conn.password,
      connectionLimit: conn.max || 5,
      connectTimeout: 5000,
      waitForConnections: true,
    };
    if (conn.database) cfg.database = conn.database;
    pool = mysql.createPool(cfg);
    _mysqlPools.set(key, pool);
  }
  const [rows] = await pool.query(sql, Array.isArray(params) ? params : []);
  return Array.isArray(rows) ? rows : [];   // INSERT/UPDATE คืน ResultSetHeader → []
}

// ── MongoDB ─────────────────────────────────────────────────────────────────
function _mongoUri(conn) {
  if (conn.uri) return conn.uri; // ใส่ connection string เต็มได้ (เช่น mongodb+srv://…)
  const host = conn.host || 'localhost';
  const port = conn.port || 27017;
  const auth = conn.user
    ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password || '')}@`
    : '';
  return `mongodb://${auth}${host}:${port}`;
}

async function _mongoClient(conn) {
  const { MongoClient } = require('mongodb');
  const uri = _mongoUri(conn);
  const key = uri;
  let client = _mongoClients.get(key);
  if (!client) {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: conn.timeout || 5000 });
    await client.connect();
    _mongoClients.set(key, client);
  }
  return client;
}

/**
 * db.mongo(conn, collection, op, [args])
 *  op: find | findOne | insertOne | insertMany | updateOne | updateMany |
 *      deleteOne | deleteMany | replaceOne | count(countDocuments) | aggregate
 *  args = อาร์กิวเมนต์ของ op นั้น ๆ เช่น find → [filter, options]
 */
async function mongoQuery(conn, collection, op, args = []) {
  const client = await _mongoClient(conn);
  const database = client.db(conn.database || undefined);
  if (!collection) return database; // เผื่อใช้งานระดับ database (เช่น listCollections)
  const col = database.collection(collection);
  const a = Array.isArray(args) ? args : [args];
  switch ((op || 'find').toLowerCase()) {
    case 'find':           return col.find(a[0] || {}, a[1] || {}).toArray();
    case 'findone':        return col.findOne(a[0] || {}, a[1] || {});
    case 'insertone':      return col.insertOne(a[0] || {});
    case 'insertmany':     return col.insertMany(a[0] || []);
    case 'updateone':      return col.updateOne(a[0] || {}, a[1] || {}, a[2] || {});
    case 'updatemany':     return col.updateMany(a[0] || {}, a[1] || {}, a[2] || {});
    case 'replaceone':     return col.replaceOne(a[0] || {}, a[1] || {}, a[2] || {});
    case 'deleteone':      return col.deleteOne(a[0] || {});
    case 'deletemany':     return col.deleteMany(a[0] || {});
    case 'count':
    case 'countdocuments': return col.countDocuments(a[0] || {});
    case 'aggregate':      return col.aggregate(a[0] || [], a[1] || {}).toArray();
    default: throw new Error(`Unknown mongo op: "${op}"`);
  }
}

// ใช้ทดสอบ connection — ping server
async function mongoPing(conn) {
  const client = await _mongoClient(conn);
  return client.db(conn.database || 'admin').command({ ping: 1 });
}

// ── SQLite (node:sqlite / better-sqlite3 ผ่าน sqliteDriver) — ไฟล์ · sync→async · cache handle ต่อ path ──
const _sqliteHandles = new Map();   // absPath → handle
function _sqliteOpen(conn) {
  const sqlite = require('./sqliteDriver');
  const path = require('path');
  const fs = require('fs');
  let p = conn.path || conn.file || conn.database;
  if (!p) throw new Error('[DB:sqlite] ต้องระบุ path ไฟล์');
  if (!path.isAbsolute(p)) { try { p = path.join(require('./csvUtil').getBase(), p); } catch (_) {} }
  let h = _sqliteHandles.get(p);
  if (!h) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}   // สร้างโฟลเดอร์แม่ถ้ายังไม่มี (idempotent · ไม่ทับ)
    h = sqlite.open(p);                                                         // เปิดของเดิม/สร้างไฟล์ใหม่ + WAL (ไม่เคยทับไฟล์เดิม)
    _sqliteHandles.set(p, h);
  }
  return h;
}
async function sqliteQuery(conn, sql, params = []) {
  const h = _sqliteOpen(conn);
  // pg-style DDL ที่ module ใช้ร่วม (chart/alarm/device/activity/auth): SERIAL/BIGSERIAL PRIMARY KEY → sqlite autoincrement
  //   (ชนิดอื่น TIMESTAMP/VARCHAR/DOUBLE PRECISION/BOOLEAN sqlite รับได้ด้วย type affinity · DML ไม่มี SERIAL = no-op)
  const sqlS = String(sql).replace(/\b(?:BIG)?SERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
  const s = sqlS.trimStart();
  if (/^(SELECT|PRAGMA|WITH)/i.test(s)) return h.prepare(sqlS).all(...(params || []));   // อ่าน → rows[]
  if (!(params && params.length)) { h.exec(sqlS); return []; }                           // DDL (อาจหลาย statement)
  h.prepare(sqlS).run(...(params || []));                                                // INSERT/UPDATE/DELETE
  return [];
}

// ── ปิด/ทิ้ง pool ของ connection หนึ่ง (เรียกตอน update/remove เพื่อกัน stale credential) ──
async function closeConn(conn) {
  const key = _key(conn);
  const pg = _pgPools.get(key);    if (pg)    { try { await pg.end(); }   catch (_) {} _pgPools.delete(key); }
  const ms = _mssqlPools.get(key); if (ms)    { try { await ms.close(); } catch (_) {} _mssqlPools.delete(key); }
  const my = _mysqlPools.get(key); if (my)    { try { await my.end(); }   catch (_) {} _mysqlPools.delete(key); }
  const mg = _mongoClients.get(conn.uri || _mongoUri(conn));
  if (mg) { try { await mg.close(); } catch (_) {} _mongoClients.delete(conn.uri || _mongoUri(conn)); }
}

// ── Close all pools (on shutdown) ──────────────────────────────────────────
async function closeAll() {
  for (const pool of _pgPools.values())    { try { await pool.end(); }   catch (_) {} }
  for (const pool of _mssqlPools.values()) { try { await pool.close(); } catch (_) {} }
  for (const pool of _mysqlPools.values()) { try { await pool.end(); }   catch (_) {} }
  for (const client of _mongoClients.values()) { try { await client.close(); } catch (_) {} }
  for (const h of _sqliteHandles.values()) { try { h.close(); } catch (_) {} }
  _pgPools.clear();
  _mssqlPools.clear();
  _mysqlPools.clear();
  _mongoClients.clear();
  _sqliteHandles.clear();
}

module.exports = {
  pg:    pgQuery,
  mssql: mssqlQuery,
  mysql: mysqlQuery,
  mongo: mongoQuery,
  sqlite: sqliteQuery,
  mongoPing,
  closeConn,
  closeAll,
};
