/**
 * Database Connection Manager
 * เก็บ config การเชื่อมต่อ DB (PostgreSQL / MSSQL) ไว้ใช้ซ้ำ
 * Script เรียกด้วยชื่อได้:  db.pg('mydb', sql, params)  แทนการพิมพ์ config ทุกครั้ง
 */
const fs   = require('fs');
const path = require('path');
const db   = require('./dbHelper');
const csv  = require('./csvUtil');

class DatabaseManager {
  constructor() {
    this.connections = [];   // [{ id, name, type, host, port, database, user, password, ... }]
    this.configPath = csv.resolveConfig('databases.json', path.join(__dirname, 'config', 'databases.json'));
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.connections = raw.connections || [];
      } else {
        this.connections = [];
        this._save();
      }
    } catch (e) {
      console.error('[DatabaseManager] load error:', e.message);
      this.connections = [];
    }
  }

  _save() {
    try {
      csv.writeJsonAtomic(this.configPath, { connections: this.connections });   // atomic (B3)
    } catch (e) {
      console.error('[DatabaseManager] save error:', e.message);
    }
  }

  // ── resolve: รับชื่อ (string) หรือ config (object) → config object ─────────
  resolve(nameOrConfig) {
    if (typeof nameOrConfig === 'object') return nameOrConfig;
    const conn = this.connections.find(c => c.name === nameOrConfig || c.id === nameOrConfig);
    if (!conn) throw new Error(`Database connection not found: "${nameOrConfig}"`);
    return conn;
  }

  // ── query helper สำหรับ script context ─────────────────────────────────────
  async query(nameOrConfig, sql, params) {
    const conn = this.resolve(nameOrConfig);
    const type = (conn.type || 'pg').toLowerCase();
    if (type === 'mssql') return db.mssql(conn, sql, params);
    if (type === 'mysql' || type === 'mariadb') return db.mysql(conn, sql, params);
    if (type === 'sqlite') return db.sqlite(conn, sql, params);
    return db.pg(conn, sql, params);
  }

  // ── list tables (สำหรับ Query/Browse UI) — คืน array ของชื่อตาราง ──────────────
  async listTables(nameOrConfig) {
    const conn = this.resolve(nameOrConfig);
    const type = (conn.type || 'pg').toLowerCase();
    if (type === 'mongo' || type === 'mongodb') {
      const dbo = await db.mongo(conn, null, 'find');           // คืน database object
      const cols = await dbo.listCollections().toArray();
      return cols.map((c) => c.name);
    }
    let rows = [];
    if (type === 'mssql') {
      rows = await db.mssql(conn, "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    } else if (type === 'mysql' || type === 'mariadb') {
      rows = await db.mysql(conn, 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name');
    } else if (type === 'sqlite') {
      rows = await db.sqlite(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    } else {
      rows = await db.pg(conn, "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename");
    }
    return rows.map((r) => r.name || r.NAME || Object.values(r)[0]);
  }

  // ── MongoDB helper — db.mongo('myconn', collection, op, ...args) ────────────
  async mongo(nameOrConfig, collection, op, ...args) {
    const conn = this.resolve(nameOrConfig);
    return db.mongo(conn, collection, op, args);
  }

  // ── test connection ────────────────────────────────────────────────────────
  async test(conn) {
    const type = (conn.type || 'pg').toLowerCase();
    const t0 = Date.now();
    try {
      let rows = 0;
      if (type === 'mssql') {
        rows = (await db.mssql(conn, 'SELECT 1 AS ok')).length;
      } else if (type === 'mysql' || type === 'mariadb') {
        rows = (await db.mysql(conn, 'SELECT 1 AS ok')).length;
      } else if (type === 'mongo' || type === 'mongodb') {
        await db.mongoPing(conn);
      } else if (type === 'sqlite') {
        rows = (await db.sqlite(conn, 'SELECT 1 AS ok')).length;
      } else {
        rows = (await db.pg(conn, 'SELECT 1 AS ok')).length;
      }
      return { ok: true, ms: Date.now() - t0, rows };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message };
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  getAll() {
    // ซ่อน password ในการดึงรายการ (ส่ง flag ว่ามี password)
    return this.connections.map(c => ({
      ...c,
      password: undefined,
      hasPassword: !!c.password,
    }));
  }

  add(conn) {
    if (!conn.name) throw new Error('name is required');
    if (this.connections.find(c => c.name === conn.name))
      throw new Error(`Connection name "${conn.name}" already exists`);
    const type = (conn.type || 'pg').toLowerCase();
    const defPort = type === 'mssql' ? 1433
                  : (type === 'mongo' || type === 'mongodb') ? 27017
                  : (type === 'mysql' || type === 'mariadb') ? 3306
                  : 5432;
    const c = {
      id:       conn.id || 'db_' + Date.now(),
      name:     conn.name,
      type:     conn.type || 'pg',
      host:     conn.host || 'localhost',
      port:     conn.port || defPort,
      database: conn.database || '',
      user:     conn.user || '',
      password: conn.password || '',
      server:   conn.server,
      encrypt:  conn.encrypt,
      trustServerCertificate: conn.trustServerCertificate,
      uri:      conn.uri || '', // MongoDB: ใส่ connection string เต็มได้ (override host/port)
      path:     conn.path,      // SQLite: ไฟล์ (relative = ใต้ data dir) · undefined สำหรับชนิดอื่น (JSON ตัดทิ้ง)
    };
    this.connections.push(c);
    this._save();
    return { ...c, password: undefined, hasPassword: !!c.password };
  }

  update(id, updates) {
    const idx = this.connections.findIndex(c => c.id === id || c.name === id);
    if (idx === -1) throw new Error(`Connection not found: ${id}`);
    // ถ้าไม่ส่ง password มา (undefined) เก็บของเดิม
    const old = this.connections[idx];
    const merged = { ...old, ...updates, id: old.id };
    if (updates.password === undefined || updates.password === '') {
      merged.password = old.password; // keep existing
    }
    this.connections[idx] = merged;
    this._save();
    db.closeConn(old).catch(() => {});   // ทิ้ง pool เก่า → query ครั้งหน้าใช้ค่าใหม่ (กัน stale credential)
    return { ...merged, password: undefined, hasPassword: !!merged.password };
  }

  remove(id) {
    const idx = this.connections.findIndex(c => c.id === id || c.name === id);
    if (idx === -1) throw new Error(`Connection not found: ${id}`);
    const old = this.connections[idx];
    this.connections.splice(idx, 1);
    this._save();
    db.closeConn(old).catch(() => {});
  }

  // ── Export / Import (migration ย้ายเครื่อง) ────────────────────────────────
  //   export: withSecrets=true → ใส่ password (ย้ายเครื่องใช้ได้จริง) · false → มาส์ก
  exportConnections(withSecrets = true) {
    return this.connections.map(c => withSecrets ? { ...c } : { ...c, password: undefined, hasPassword: !!c.password });
  }
  // import: upsert by name/id · overwrite=true (ทับของเดิม) · false (migration · เพิ่มเฉพาะใหม่ ไม่แตะของเดิม)
  importConnections(list, overwrite = true) {
    if (!Array.isArray(list)) throw new Error('connections ต้องเป็น array');
    let add = 0, upd = 0, skip = 0;
    for (const inc of list) {
      if (!inc || !inc.name) continue;
      const idx = this.connections.findIndex(c => c.name === inc.name || (inc.id && c.id === inc.id));
      if (idx === -1) {
        this.connections.push({
          id: inc.id || `db_${Date.now()}_${add}`, name: inc.name, type: inc.type || 'pg',
          host: inc.host || 'localhost', port: inc.port || 5432, database: inc.database || '',
          user: inc.user || '', password: inc.password || '', server: inc.server,
          encrypt: inc.encrypt, trustServerCertificate: inc.trustServerCertificate, uri: inc.uri || '',
        });
        add++;
      } else if (!overwrite) {
        skip++;   // migration: มีอยู่แล้ว → ข้าม ไม่ทับ
      } else {
        const old = this.connections[idx];
        const merged = { ...old, ...inc, id: old.id };
        if (inc.password === undefined || inc.password === '') merged.password = old.password;   // คง password เดิม
        this.connections[idx] = merged;
        db.closeConn(old).catch(() => {});   // ทิ้ง pool เก่า (กัน stale credential)
        upd++;
      }
    }
    this._save();
    return { add, upd, skip };
  }
}

module.exports = DatabaseManager;
