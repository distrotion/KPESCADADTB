// lineConfig.js — โหลด + validate config ต่อไลน์ (config/lines/*.json)
//   universal: ความต่างระหว่างไลน์อยู่ในไฟล์นี้ทั้งหมด (field-map / event grammar / stations / fields)
const fs = require('fs');
const path = require('path');

function _arr(v) { return Array.isArray(v) ? v : []; }
function _obj(v) { return (v && typeof v === 'object') ? v : {}; }

// normalize + ใส่ค่า default · throw ถ้าโครงผิดร้ายแรง
function normalizeLineConfig(raw, file) {
  const c = _obj(raw);
  const line = String(c.line || '').trim();
  if (!line) throw new Error(`[lineConfig] ไม่มี field "line" (${file || ''})`);
  const source = _obj(c.source);
  const isSnapshot = String(source.mode || '') === 'snapshot';   // snapshot ไม่ใช้ decode (CarrierTracker ทำแทน)
  const decode = _obj(c.decode);
  if (!isSnapshot && decode.eventType == null) throw new Error(`[lineConfig] ${line}: decode.eventType ต้องระบุ`);
  const events = _obj(c.events);
  for (const k of ['ENTER', 'STEP', 'STAGE', 'EXIT']) events[k] = _arr(events[k]).map(Number);
  const stations = _obj(c.stations);
  const fields = _arr(c.fields).map((f) => ({
    key: String(f.key || '').trim(),
    label: String(f.label || f.key || '').trim(),
    type: ['number', 'text', 'bool', 'time'].includes(f.type) ? f.type : 'number',
    unit: String(f.unit || ''), decimals: Number(f.decimals) || 0,
    scope: f.scope === 'job' ? 'job' : 'step',
    station: f.station != null ? String(f.station) : null,
    source: _obj(f.source),                                  // {kind:plc|manual|formula, index|expr}
    tag: _obj(f.tag),                                        // {device,tag} — job-field อ่านจาก tag (เช่น barcode)
    spec: _obj(f.spec),                                      // {min,max,warn}
    display: { table: true, mimic: false, report: false, order: 0, ..._obj(f.display) },
  })).filter((f) => f.key);
  return {
    line, label: String(c.label || line), enabled: c.enabled !== false,
    source, decode, events,
    lanes: _obj(c.lanes), stations, fields,
    setNotes: _obj(c.setNotes),   // comment ต่อแถว (set → หมายเหตุ · แก้จากหน้า monitor)
    _file: file || '',
  };
}

// โหลดทุกไฟล์ใน dir → map { line: config }
function loadLineConfigs(dir) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return out; }
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const cfg = normalizeLineConfig(raw, f);
      out[cfg.line] = cfg;
    } catch (e) { console.error(`[lineConfig] โหลด ${f} ไม่ได้:`, e.message); }
  }
  return out;
}

// บันทึก config ลงไฟล์ (runtime dir · user สร้าง/แก้/ตั้งชื่อเอง) — คืน config ที่ normalize แล้ว
function saveLineConfig(dir, raw) {
  const cfg = normalizeLineConfig(raw, '');
  const safe = cfg.line.replace(/[^A-Za-z0-9_\-]/g, '_');   // line id → filename ปลอดภัย
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, safe + '.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, path.join(dir, safe + '.json'));   // atomic
  return cfg;
}
function deleteLineConfig(dir, line) {
  const safe = String(line).replace(/[^A-Za-z0-9_\-]/g, '_');
  const f = path.join(dir, safe + '.json');
  if (fs.existsSync(f)) { fs.unlinkSync(f); return true; }
  return false;
}

module.exports = { loadLineConfigs, normalizeLineConfig, saveLineConfig, deleteLineConfig };
