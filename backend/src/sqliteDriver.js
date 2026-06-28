// sqliteDriver.js — unified SQLite driver (auto-detect A+C) — ดู docs/SQLITE-STORAGE-PLAN.md §0
//   A) node:sqlite  (built-in · Node>=22.5 + --experimental-sqlite/22.13+ · 0 native dep) — primary
//   C) better-sqlite3 (native · arm64 prebuild · optionalDependency)                       — fallback
//   detect ตอนเรียกครั้งแรก: ลอง A → C → ไม่มีทั้งคู่ = available()=false (frontend ไม่โชว์ SQLite)
//   2 driver API sync เหมือนกัน (new Db(path) · exec · prepare→run/get/all · close) → ห่อ interface เดียว
let _probe = null;

function _detect() {
  if (_probe) return _probe;
  // A) node:sqlite — 0 native dep
  try {
    const { DatabaseSync } = require('node:sqlite');
    _probe = { name: 'node', _open: (p) => new DatabaseSync(p) };
    return _probe;
  } catch (_) { /* Node<22.5 หรือยังไม่เปิด flag → ลอง fallback */ }
  // C) better-sqlite3 — native fallback
  try {
    const Better = require('better-sqlite3');
    _probe = { name: 'better', _open: (p) => new Better(p) };
    return _probe;
  } catch (_) { /* ไม่ได้ติดตั้ง/ไม่มี prebuild ของ arch นี้ */ }
  _probe = { name: null, _open: null };   // ไม่มี SQLite driver บนเครื่องนี้
  return _probe;
}

function available() { return _detect().name != null; }
function driverName() { return _detect().name; }   // 'node' | 'better' | null

// เปิด/สร้างไฟล์ (สร้างเองถ้ายังไม่มี) + WAL (หลาย process · recorder+viewer) → handle interface เดียว
function open(filePath) {
  const d = _detect();
  if (!d.name) throw new Error('SQLite driver ไม่พร้อม (ต้อง Node>=22.5 หรือ better-sqlite3)');
  const db = d._open(filePath);
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;'); } catch (_) {}
  // node:sqlite bind เข้มกว่า better: undefined/boolean ไม่ได้ → normalize (undefined→null · bool→1/0) ให้ 2 driver เหมือนกัน
  const nb = (v) => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const norm = (a) => a.map(nb);
  return {
    driver: d.name,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => { const st = db.prepare(sql); return { run: (...a) => st.run(...norm(a)), get: (...a) => st.get(...norm(a)), all: (...a) => st.all(...norm(a)) }; },
    close: () => { try { db.close(); } catch (_) {} },
  };
}

module.exports = { available, driverName, open, _detect };
