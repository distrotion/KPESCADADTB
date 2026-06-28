const fs = require('fs');
const path = require('path');

/**
 * csvUtil — helper กลางสำหรับ feature ที่เก็บข้อมูลเป็น CSV เมื่อ "ไม่ใช้ DB"
 * ใช้ร่วมกัน: alarmEngine (alarm-logs) · deviceLogger (device-logs) · chartStore (chart-logs)
 *
 * ✅ ค่าเริ่มต้น = โฟลเดอร์หลักที่ใช้ control (root ที่มี backend/ frontend/ manager/)
 *    หามาจาก __dirname (ตำแหน่งที่ service รันจริง = backend/src) แล้วย้อนขึ้น 2 ชั้น
 *    → resolve ตอน runtime จึง "ย้ายทั้งโฟลเดอร์ไปไหน data ก็ตามไป" (portable เป็นชุดเดียว, ไม่ hardcode ต่อเครื่อง)
 *    override ได้: env KPE_DATA_DIR > config/storage.json (dataDir) > default
 *    ⚠️ ถ้าติดตั้งในที่ read-only (/opt, Program Files) ให้ override ผ่าน Setup/env ไปยัง writable dir
 */

const STORAGE_CFG = path.join(__dirname, 'config', 'storage.json');

// ค่าเริ่มต้น = โฟลเดอร์หลักที่ใช้ control — มองจากจุดที่ service รัน (__dirname = backend/src)
// ย้อนขึ้นไป root (มี backend/frontend/manager) · resolve runtime → ย้ายโฟลเดอร์แล้วตามไปเอง
function defaultDataDir() {
  return path.resolve(__dirname, '..', '..');
}

// base path ปัจจุบัน (resolve ครั้งแรก, cache ไว้) — เลือกได้ในหน้า Setup
// ลำดับความสำคัญ: env KPE_DATA_DIR > config/storage.json (dataDir) > defaultDataDir()
let _base = null;

function _readCfgDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(STORAGE_CFG, 'utf8'));
    const d = (cfg && cfg.dataDir != null) ? String(cfg.dataDir).trim() : '';
    return d || null;
  } catch (_) { return null; }
}

// base path ที่ใช้จริง (effective)
function getBase() {
  if (_base != null) return _base;
  const env = (process.env.KPE_DATA_DIR || '').trim();
  _base = env || _readCfgDir() || defaultDataDir();
  return _base;
}

// เปลี่ยน base path — p ว่าง/null = กลับไปใช้ค่าเริ่มต้น (defaultDataDir)
// คืน { ok, dataDir, error } · ตรวจว่าเขียนได้จริงก่อน persist
function setBase(p) {
  const dir = (p == null ? '' : String(p).trim());
  const target = dir || defaultDataDir();
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, '.kpe_write_test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);   // write-test
  } catch (e) {
    return { ok: false, dataDir: getBase(), error: 'เขียนไม่ได้: ' + e.message };
  }
  try {
    writeJsonAtomic(STORAGE_CFG, { dataDir: dir });  // atomic (B3) — เก็บค่าที่ผู้ใช้ใส่ ('' = default)
  } catch (_) {}
  _base = target;
  return { ok: true, dataDir: target };
}

function isDefault() { return getBase() === defaultDataDir(); }

// โครงใต้ base แยกชัด:  <base>/config/ (JSON) · <base>/datalog/<folder>/ (CSV log)
const CONFIG_SUBDIR  = 'config';
const DATALOG_SUBDIR = 'datalog';

// คืน path โฟลเดอร์ CSV log ใต้ <base>/datalog/ (เช่น csvDir('alarm-logs') → <base>/datalog/alarm-logs)
function csvDir(folder) {
  return path.join(getBase(), DATALOG_SUBDIR, folder);
}

// ── Config files (รวมทุก config ไว้ใต้ <base>/config/) ──────────────────────────────
function configDir() { return path.join(getBase(), CONFIG_SUBDIR); }
function configFile(name) { return path.join(configDir(), name); }

// ── Dashboard layout (<base>/layout/) — วาง widget/pages/popup ───────────────────────
function layoutDir() { return path.join(getBase(), 'layout'); }
function layoutFile(name) { return path.join(layoutDir(), name); }

// คืน path ของ config file ใน <base>/config + migrate ครั้งเดียว (copy ไม่ลบของเดิม)
// legacy: ลองตามลำดับ — <base>/data (ที่เก่าก่อนแยก config/datalog) แล้ว legacyPath (backend/src/config หรือ root/data)
function resolveConfig(name, legacyPath) {
  const target = configFile(name);
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { recursive: true });
    if (!fs.existsSync(target)) {
      const candidates = [path.join(getBase(), 'data', name), legacyPath].filter(Boolean);
      for (const c of candidates) {
        if (path.resolve(c) !== path.resolve(target) && fs.existsSync(c)) {
          fs.copyFileSync(c, target);   // migrate ครั้งเดียว
          break;
        }
      }
    }
  } catch (_) {}
  return target;
}

// 'YYYY-MM-DD' ตามเวลาเครื่อง (local)
function dateStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// path ไฟล์รายวัน: <dir>/<prefix>-YYYY-MM-DD.csv
function dailyFile(dir, prefix, d) {
  return path.join(dir, `${prefix}-${dateStamp(d)}.csv`);
}

// escape 1 field (ครอบ "..." + escape "" ถ้ามี comma/quote/newline)
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// สร้าง 1 บรรทัด CSV จาก array
function csvRow(vals) {
  return vals.map(csvEscape).join(',');
}

// parse 1 บรรทัด CSV (รองรับ field ครอบ "..." + escape "")
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// append 1 แถวลงไฟล์รายวัน (สร้าง dir + เขียน header แถวแรกถ้าไฟล์ใหม่) — best-effort
function appendDailyRow(dir, prefix, when, headerCols, rowVals) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = dailyFile(dir, prefix, when);
    const line = csvRow(rowVals) + '\n';
    if (!fs.existsSync(file)) fs.writeFileSync(file, headerCols.join(',') + '\n' + line);
    else fs.appendFileSync(file, line);
  } catch (_) { /* best-effort: ไม่โยน error เข้า flow หลัก */ }
}

// อ่านไฟล์ CSV → { cols:[], rows:[[...]] } (rows ไม่รวม header) — best-effort
function readCsv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split(/\r?\n/).filter((l) => l.length);
    if (!lines.length) return { cols: [], rows: [] };
    const cols = parseCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) rows.push(parseCsvLine(lines[i]));
    return { cols, rows };
  } catch (_) { return { cols: [], rows: [] }; }
}

// เขียนไฟล์แบบ atomic (กันไฟดับ/เขียนค้างกลางคัน → ไฟล์พังโหลดไม่ขึ้น)
//   เขียนลง <file>.tmp ก่อน แล้ว rename ทับ (rename เป็น atomic บน POSIX/NTFS)
//   ใช้กับ persistence สำคัญ (config/layout) — ฐานราก crash-safe สำหรับ installer/Pi
function writeFileAtomic(file, data, opts) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const mode = opts && opts.mode;   // ตั้ง perm บน tmp ก่อน rename → ไฟล์ปลายทางได้ perm ถูก (เช่น 0600 ไฟล์ลับ)
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  if (mode) { try { fs.chmodSync(tmp, mode); } catch (_) {} }   // กันกรณี umask กด perm ตอนสร้าง
  fs.renameSync(tmp, file);
}
// เขียน object เป็น JSON แบบ atomic (pretty 2-space) · opts.mode = perm ไฟล์ (เช่น 0o600)
function writeJsonAtomic(file, obj, opts) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2), opts);
}

// list ไฟล์รายวันของ prefix เรียงเก่า→ใหม่ (lexical = chronological)
function listDailyFiles(dir, prefix) {
  try {
    const re = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.csv$`);
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort();
  } catch (_) { return []; }
}

// อ่าน CSV เฉพาะ "ส่วนท้ายไฟล์" — สำหรับ loader ตอน boot ที่ต้องการแค่แถวล่าสุด
//   ไฟล์ log อาจบวมผิดปกติ (เคยเจอ 466MB จาก error วนซ้ำ) → readCsv ทั้งไฟล์ = RAM หลาย GB
//   จน backend ค้าง/ตายก่อน listen · เกิน maxBytes → อ่าน header + ก้อนท้าย แล้วทิ้งบรรทัดแรกที่อาจขาดครึ่ง
function readCsvTail(file, maxBytes = 2 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return readCsv(file);
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(64 * 1024);
      const hn = fs.readSync(fd, head, 0, head.length, 0);
      const cols = parseCsvLine(head.toString('utf8', 0, hn).split(/\r?\n/, 1)[0]);
      const tail = Buffer.alloc(maxBytes);
      const tn = fs.readSync(fd, tail, 0, maxBytes, size - maxBytes);
      const lines = tail.toString('utf8', 0, tn).split(/\r?\n/);
      lines.shift();   // บรรทัดแรกของก้อนท้ายอาจเริ่มกลางแถว → ทิ้ง
      const rows = [];
      for (const l of lines) { if (l.length) rows.push(parseCsvLine(l)); }
      return { cols, rows };
    } finally { fs.closeSync(fd); }
  } catch (_) { return { cols: [], rows: [] }; }
}

module.exports = {
  defaultDataDir, getBase, setBase, isDefault,
  configDir, configFile, resolveConfig, layoutDir, layoutFile,
  csvDir, dateStamp, dailyFile, csvEscape, csvRow,
  parseCsvLine, appendDailyRow, readCsv, readCsvTail, listDailyFiles,
  writeFileAtomic, writeJsonAtomic,
};
