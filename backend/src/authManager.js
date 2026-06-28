const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const csv = require('./csvUtil');
const { dialectOf, ph } = require('./dbDialect');

/**
 * AuthManager — ผู้ใช้ + สิทธิ์สำหรับ run mode (department × ระดับขั้นต่ำ)
 *  - config (levels/departments/settings/secret) เก็บที่ data/auth.json เสมอ
 *  - ข้อมูลผู้ใช้เลือกได้: JSON (data/users.json) หรือ Database (ผ่าน databaseManager, ตาราง scada_users)
 *  - hash รหัสผ่านด้วย scrypt (built-in crypto) · token = HMAC-SHA256 stateless
 *  - ไม่ login = guest (ระดับ levels[0]) · best-effort: DB ใช้ไม่ได้ → fallback JSON
 */
// ที่เก่า (ก่อนรวมมาที่ <base>/data) — ใช้ migrate ครั้งแรกเท่านั้น
const LEGACY_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_TABLE = 'scada_users';

const DEFAULT_CONFIG = {
  version: 1,
  secret: '',
  levels: ['guest', 'viewer', 'operator', 'supervisor', 'manager', 'admin'],
  departments: ['Production', 'Packaging', 'QC'],
  settings: {
    idleLogoutSec: 600,
    requireLoginForRun: false,
    requireLoginForEdit: false,  // บังคับ login ก่อนเข้าโหมด edit (designer) — กันคนนอกใน LAN แก้

    tokenTtlSec: 28800,
    userStore: 'json',   // 'json' | 'database'
    dbConnection: '',     // ชื่อ connection (เมื่อ userStore = database)
    // ── Tag Monitor tab (run/deploy) — ใครเห็นแท็บ + ใคร force เขียนค่าได้ ──
    // '' / [] = ไม่จำกัด (ทุกคนรวม Guest) · ตั้งใน Setup → "Tag Monitor (Run mode)"
    tagTabMinLevel: '',        // ระดับขั้นต่ำที่เห็นแท็บ Tags ในโหมด run
    tagTabDepartments: [],     // แผนกที่เห็น ([] = ทุกแผนก)
    tagForceMinLevel: '',      // ระดับขั้นต่ำที่ force เขียนค่าได้ (แยกจากการเห็นแท็บ)
    tagForceDepartments: [],   // แผนกที่ force ได้ ([] = ทุกแผนก)
    showLoginChip: false,      // โชว์ปุ่ม login (IdentityChip) มุมบนขวาในโหมด run/deploy (default ปิด)
  },
};

class AuthManager {
  constructor(dbManager) {
    this.dbManager = dbManager || null;
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this._dbReady = new Set();
    // รวมไว้ที่ <base>/data/ (migrate จากที่เก่าครั้งแรก)
    this.authPath  = csv.resolveConfig('auth.json',  path.join(LEGACY_DATA_DIR, 'auth.json'));
    this.usersPath = csv.resolveConfig('users.json', path.join(LEGACY_DATA_DIR, 'users.json'));
    this._loadConfig();
    // seed admin (async สำหรับ DB; JSON เร็ว) — best effort
    this._ensureSeed().catch((e) => console.error('[Auth] seed error:', e.message));
  }

  // ── Config (data/auth.json) ─────────────────────────────────────────────────
  _loadConfig() {
    try {
      if (fs.existsSync(this.authPath)) {
        const raw = JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
        this.config = {
          ...DEFAULT_CONFIG, ...raw,
          settings: { ...DEFAULT_CONFIG.settings, ...(raw.settings || {}) },
        };
        if (!Array.isArray(this.config.levels) || this.config.levels.length === 0) {
          this.config.levels = [...DEFAULT_CONFIG.levels];
        }
      }
    } catch (e) { console.error('[Auth] config load error:', e.message); }
    if (!this.config.secret) {
      this.config.secret = crypto.randomBytes(32).toString('hex'); // gen ครั้งเดียว
    }
    this._saveConfig();
  }

  _saveConfig() {
    try {
      csv.writeJsonAtomic(this.authPath, this.config);   // atomic (B3)
    } catch (e) { console.error('[Auth] config save error:', e.message); }
  }

  getConfig() {
    // ไม่คืน secret
    return {
      levels: [...this.config.levels],
      departments: [...this.config.departments],
      settings: { ...this.config.settings },
    };
  }

  setConfig(updates = {}) {
    if (Array.isArray(updates.levels) && updates.levels.length) this.config.levels = updates.levels;
    if (Array.isArray(updates.departments)) this.config.departments = updates.departments;
    if (updates.settings && typeof updates.settings === 'object') {
      this.config.settings = { ...this.config.settings, ...updates.settings };
    }
    this._saveConfig();
    return this.getConfig();
  }

  get _levels() { return this.config.levels; }

  guestIdentity() {
    return { username: 'guest', name: 'Guest', level: this._levels[0] || 'guest', departments: [] };
  }

  // ── Password hashing (scrypt) ───────────────────────────────────────────────
  _hash(password, salt) {
    return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex');
  }

  _verify(password, user) {
    try {
      const h = this._hash(password, user.salt);
      return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.passwordHash, 'hex'));
    } catch (_) { return false; }
  }

  _makeUser({ id, username, name, password, level, departments, enabled }) {
    const salt = crypto.randomBytes(16).toString('hex');
    const uid = String(username);
    return {
      id: id || 'u_' + crypto.randomBytes(6).toString('hex'),
      username: uid, // = ID ที่ใช้ login
      name: (name != null && String(name).trim()) ? String(name).trim() : uid, // ชื่อแสดงผล
      passwordHash: this._hash(password ?? '', salt),
      salt,
      level: level || this._levels[0],
      departments: Array.isArray(departments) ? departments : [],
      enabled: enabled !== false,
    };
  }

  // ── Token (stateless HMAC-SHA256) ───────────────────────────────────────────
  _b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  _sign(payloadB64) {
    return this._b64url(crypto.createHmac('sha256', this.config.secret).update(payloadB64).digest());
  }

  issueToken(identity) {
    const payload = {
      u: identity.username, nm: identity.name, lvl: identity.level, dep: identity.departments || [],
      exp: Date.now() + (this.config.settings.tokenTtlSec || 28800) * 1000,
    };
    const p = this._b64url(JSON.stringify(payload));
    return `${p}.${this._sign(p)}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [p, sig] = token.split('.');
    if (!p || !sig) return null;
    const expected = this._sign(p);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch (_) { return null; }
    if (!payload || (payload.exp && Date.now() > payload.exp)) return null;
    return { username: payload.u, name: payload.nm || payload.u, level: payload.lvl, departments: payload.dep || [] };
  }

  identityFromToken(token) {
    return this.verifyToken(token) || this.guestIdentity();
  }

  // ── User store (JSON หรือ Database) ─────────────────────────────────────────
  _dbConn() {
    if ((this.config.settings.userStore || 'json') !== 'database') return null;
    const conn = this.config.settings.dbConnection;
    if (!conn || !this.dbManager) return null;
    try { this.dbManager.resolve(conn); return conn; } catch (_) { return null; }
  }

  async _ensureDbTable(conn) {
    const key = `${conn}:${USERS_TABLE}`;
    if (this._dbReady.has(key)) return;
    const type = (this.dbManager.resolve(conn).type || 'pg').toLowerCase();
    if (type === 'mongo' || type === 'mongodb') { this._dbReady.add(key); return; }
    const isMs = type === 'mssql';
    const sql = isMs
      ? `IF OBJECT_ID('${USERS_TABLE}','U') IS NULL CREATE TABLE ${USERS_TABLE} (
           id VARCHAR(40) PRIMARY KEY, username NVARCHAR(120), name NVARCHAR(120), password_hash VARCHAR(128),
           salt VARCHAR(64), level VARCHAR(40), departments NVARCHAR(800), enabled BIT,
           created_at DATETIME2 NULL, updated_at DATETIME2 NULL)`
      : `CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
           id VARCHAR(40) PRIMARY KEY, username VARCHAR(120), name VARCHAR(120), password_hash VARCHAR(128),
           salt VARCHAR(64), level VARCHAR(40), departments VARCHAR(800), enabled BOOLEAN,
           created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL)`;
    await this.dbManager.query(conn, sql, []);
    // §B: เติม created_at/updated_at ให้ตารางเดิม (idempotent · ถ้ายังไม่มีคอลัมน์)
    for (const col of ['created_at', 'updated_at']) {
      const alter = isMs
        ? `IF COL_LENGTH('${USERS_TABLE}','${col}') IS NULL ALTER TABLE ${USERS_TABLE} ADD ${col} DATETIME2 NULL`
        : `ALTER TABLE ${USERS_TABLE} ADD COLUMN IF NOT EXISTS ${col} TIMESTAMP NULL`;
      try { await this.dbManager.query(conn, alter, []); } catch (_) {}
    }
    this._dbReady.add(key);
  }

  // อ่าน users ทั้งหมด (พร้อม hash/salt) — fallback JSON ถ้า DB พลาด
  async _allUsers() {
    const conn = this._dbConn();
    if (conn) {
      try {
        const type = (this.dbManager.resolve(conn).type || 'pg').toLowerCase();
        if (type === 'mongo' || type === 'mongodb') {
          const rows = await this.dbManager.mongo(conn, USERS_TABLE, 'find', {}, {});
          return (rows || []).map((r) => ({
            id: r.id, username: r.username, name: r.name || r.username, passwordHash: r.passwordHash, salt: r.salt,
            level: r.level, departments: Array.isArray(r.departments) ? r.departments : [],
            enabled: r.enabled !== false,
          }));
        }
        await this._ensureDbTable(conn);
        const rows = await this.dbManager.query(conn, `SELECT id, username, name, password_hash, salt, level, departments, enabled FROM ${USERS_TABLE}`, []);
        return (rows || []).map((r) => ({
          id: r.id, username: r.username, name: r.name || r.username, passwordHash: r.password_hash, salt: r.salt,
          level: r.level, departments: _parseDeps(r.departments),
          enabled: r.enabled === true || r.enabled === 1 || r.enabled === '1',
        }));
      } catch (e) {
        console.error('[Auth] DB read failed → fallback JSON:', e.message);
      }
    }
    return this._jsonUsers();
  }

  _jsonUsers() {
    try {
      if (fs.existsSync(this.usersPath)) {
        const raw = JSON.parse(fs.readFileSync(this.usersPath, 'utf8'));
        return Array.isArray(raw.users) ? raw.users : [];
      }
    } catch (e) { console.error('[Auth] users.json read error:', e.message); }
    return [];
  }

  _saveJsonUsers(users) {
    try {
      csv.writeJsonAtomic(this.usersPath, { users });   // atomic (B3)
    } catch (e) { console.error('[Auth] users.json save error:', e.message); }
  }

  // insert/update 1 user (เก็บตาม store)
  async _putUser(user) {
    const conn = this._dbConn();
    if (conn) {
      try {
        const type = (this.dbManager.resolve(conn).type || 'pg').toLowerCase();
        if (type === 'mongo' || type === 'mongodb') {
          await this.dbManager.mongo(conn, USERS_TABLE, 'replaceOne', { id: user.id }, user, { upsert: true });
          return;
        }
        await this._ensureDbTable(conn);
        const dialect = dialectOf(type);
        const idp = dialect === 'mssql' ? '@p0' : (dialect === 'mysql' || dialect === 'sqlite') ? '?' : '$1';
        // §B: เก็บ created_at เดิมไว้ (delete+insert → กันรีเซ็ตเวลาสร้าง) · updated_at = now
        let createdAt = null;
        try { const ex = await this.dbManager.query(conn, `SELECT created_at FROM ${USERS_TABLE} WHERE id=${idp}`, [user.id]); createdAt = (ex && ex[0] && ex[0].created_at) || null; } catch (_) {}
        const now = new Date();
        await this.dbManager.query(conn, `DELETE FROM ${USERS_TABLE} WHERE id=${idp}`, [user.id]);
        const phStr = ph(dialect, 10);
        const params = [user.id, user.username, user.name || user.username, user.passwordHash, user.salt, user.level,
          JSON.stringify(user.departments || []), user.enabled !== false, createdAt || now, now];
        await this.dbManager.query(conn,
          `INSERT INTO ${USERS_TABLE} (id, username, name, password_hash, salt, level, departments, enabled, created_at, updated_at) VALUES ${phStr}`, params);
        return;
      } catch (e) {
        console.error('[Auth] DB write failed → fallback JSON:', e.message);
      }
    }
    const users = this._jsonUsers();
    const i = users.findIndex((u) => u.id === user.id);
    if (i >= 0) users[i] = user; else users.push(user);
    this._saveJsonUsers(users);
  }

  async _deleteUser(id) {
    const conn = this._dbConn();
    if (conn) {
      try {
        const type = (this.dbManager.resolve(conn).type || 'pg').toLowerCase();
        if (type === 'mongo' || type === 'mongodb') {
          await this.dbManager.mongo(conn, USERS_TABLE, 'deleteOne', { id });
          return;
        }
        await this._ensureDbTable(conn);
        const dialect = dialectOf(type);
        const idp = dialect === 'mssql' ? '@p0' : (dialect === 'mysql' || dialect === 'sqlite') ? '?' : '$1';
        await this.dbManager.query(conn, `DELETE FROM ${USERS_TABLE} WHERE id=${idp}`, [id]);
        return;
      } catch (e) { console.error('[Auth] DB delete failed → fallback JSON:', e.message); }
    }
    const users = this._jsonUsers().filter((u) => u.id !== id);
    this._saveJsonUsers(users);
  }

  async _ensureSeed() {
    const users = await this._allUsers();
    if (users.length > 0) return;
    const admin = this._makeUser({
      username: 'admin', password: 'admin',
      level: this._levels[this._levels.length - 1], // ระดับสูงสุด
      departments: [...this.config.departments],
      enabled: true,
    });
    await this._putUser(admin);
    console.warn('[Auth] seeded default user "admin" / "admin" — โปรดเปลี่ยนรหัสผ่าน');
  }

  // ── Auth flow ───────────────────────────────────────────────────────────────
  async login(username, password) {
    const users = await this._allUsers();
    const u = users.find((x) => x.username === username);
    if (!u || u.enabled === false) return { ok: false, error: 'ไม่พบผู้ใช้ หรือถูกปิดใช้งาน' };
    if (!this._verify(password, u)) return { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' };
    const identity = { username: u.username, name: u.name || u.username, level: u.level, departments: u.departments || [] };
    return { ok: true, token: this.issueToken(identity), identity };
  }

  // เปลี่ยนรหัสผ่านตัวเอง (ยืนยันรหัสเดิม) — ใช้กับปุ่ม widget เปลี่ยนรหัส
  async changePassword(token, oldPassword, newPassword) {
    const identity = this.verifyToken(token);
    if (!identity) return { ok: false, error: 'ต้องเข้าสู่ระบบก่อน' };
    if (!newPassword || !String(newPassword).length) return { ok: false, error: 'รหัสผ่านใหม่ว่าง' };
    const users = await this._allUsers();
    const u = users.find((x) => x.username === identity.username);
    if (!u) return { ok: false, error: 'ไม่พบผู้ใช้' };
    if (!this._verify(oldPassword, u)) return { ok: false, error: 'รหัสผ่านเดิมไม่ถูกต้อง' };
    u.salt = crypto.randomBytes(16).toString('hex');
    u.passwordHash = this._hash(newPassword, u.salt);
    await this._putUser(u);
    return { ok: true };
  }

  // ── User CRUD (admin) ───────────────────────────────────────────────────────
  async listUsers() {
    const users = await this._allUsers();
    return users.map((u) => ({
      id: u.id, username: u.username, name: u.name || u.username, level: u.level,
      departments: u.departments || [], enabled: u.enabled !== false,
    }));
  }

  async addUser(input) {
    if (!input.username) throw new Error('username is required');
    const users = await this._allUsers();
    if (users.some((u) => u.username === input.username)) throw new Error(`username "${input.username}" มีอยู่แล้ว`);
    const user = this._makeUser(input);
    await this._putUser(user);
    return { id: user.id, username: user.username, name: user.name, level: user.level, departments: user.departments, enabled: user.enabled };
  }

  async updateUser(id, updates) {
    const users = await this._allUsers();
    const old = users.find((u) => u.id === id || u.username === id);
    if (!old) throw new Error('ไม่พบผู้ใช้');
    const merged = { ...old };
    if (updates.username) merged.username = updates.username;
    if (updates.name !== undefined) merged.name = String(updates.name).trim() || merged.username;
    if (updates.level) merged.level = updates.level;
    if (Array.isArray(updates.departments)) merged.departments = updates.departments;
    if (updates.enabled !== undefined) merged.enabled = updates.enabled !== false;
    if (updates.password) { // เปลี่ยนรหัส → salt ใหม่
      merged.salt = crypto.randomBytes(16).toString('hex');
      merged.passwordHash = this._hash(updates.password, merged.salt);
    }
    await this._putUser(merged);
    return { id: merged.id, username: merged.username, name: merged.name, level: merged.level, departments: merged.departments, enabled: merged.enabled };
  }

  async removeUser(id) {
    const users = await this._allUsers();
    const u = users.find((x) => x.id === id || x.username === id);
    if (!u) throw new Error('ไม่พบผู้ใช้');
    await this._deleteUser(u.id);
    return { ok: true };
  }
}

function _parseDeps(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  return [];
}

module.exports = AuthManager;
