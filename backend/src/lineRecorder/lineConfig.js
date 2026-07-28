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
    scope: ['job', 'measure'].includes(f.scope) ? f.scope : 'step',   // measure = ค่าที่คนวัดเอง (คีย์ผ่านมือถือ · เก็บทุกครั้ง)
    station: f.station != null ? String(f.station) : null,
    stations: _arr(f.stations).map((x) => String(x)).filter(Boolean),   // measure: บ่อที่ให้วัด (ว่าง = ทุกบ่อ)
    show: f.show === 'avg' ? 'avg' : (f.show === 'all' ? 'all' : 'last'),   // measure: รายงานโชว์ ค่าล่าสุด(default)/เฉลี่ย/ทุกค่า
    source: _obj(f.source),                                  // {kind:plc|manual|formula, index|expr}
    tag: _obj(f.tag),                                        // {device,tag} — job-field อ่านจาก tag (เช่น barcode)
    spec: (() => {                                           // เกณฑ์ in-spec 2 mode: minmax(เลข/tag ต่อตัว) | offset(tag อ้างอิง ± offset)
      const s = _obj(f.spec);
      const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x))) ? null : Number(x);
      const tg = (x) => { const o = _obj(x); return (o.device && o.tag) ? { device: String(o.device), tag: String(o.tag) } : null; };
      return {
        mode: s.mode === 'offset' ? 'offset' : 'minmax',
        min: num(s.min), max: num(s.max),                    // fixed (minmax mode · backward compat)
        minTag: tg(s.minTag), maxTag: tg(s.maxTag),          // ถ้ามี → ใช้ tag แทนเลข (minmax mode)
        refTag: tg(s.refTag), minOff: num(s.minOff), maxOff: num(s.maxOff),   // offset mode: min=ref+minOff · max=ref+maxOff
        warn: s.warn,
      };
    })(),
    track: (() => {
      const t = _obj(f.track);
      const sum = ['avg', 'mid'].includes(t.summary) ? t.summary : 'last';   // last=ค่าตอนออก · avg=เฉลี่ย · mid=ค่ากลางเวลาในบ่อ
      return { minMax: t.minMax === true, summary: sum, graph: t.graph === true };
    })(),   // min/max + สรุป last/avg/mid + graph=เก็บ minigraph (series ระหว่างชุบ)
    display: { table: true, mimic: false, report: false, order: 0, ..._obj(f.display) },
  })).filter((f) => f.key);
  return {
    line, label: String(c.label || line), enabled: c.enabled !== false,
    source, decode, events,
    lanes: _obj(c.lanes), stations, fields,
    setNotes: _obj(c.setNotes),   // comment ต่อแถว (set → หมายเหตุ · แก้จากหน้า monitor)
    // ค่าที่คนวัดเอง (measure) — ตั้งค่าระดับไลน์ · field อยู่ใน fields[] ที่ scope='measure'
    measure: (() => {
      const m = _obj(c.measure);
      return {
        actorMode: ['login', 'device'].includes(m.actorMode) ? m.actorMode : 'list',   // ใครคีย์: list(เลือกชื่อ)/login/device
        actors: _arr(m.actors).map((x) => String(x).trim()).filter(Boolean),           // รายชื่อพนักงาน (actorMode=list)
        acceptWhenNotInLine: m.acceptWhenNotInLine !== false,                          // งานไม่ได้อยู่ในบ่อ → ยังบันทึกได้ (default: ได้)
      };
    })(),
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
