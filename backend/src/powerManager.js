const path = require('path');
const csv = require('./csvUtil');

/**
 * PowerManager — คำนวณหน่วยไฟฟ้า (kW / kWh / ค่าไฟ) จาก tag ของ power meter หลายตัว
 * ════════════════════════════════════════════════════════════════════════════
 * รับค่าได้ 3 โหมด (เลือกต่อมิเตอร์):
 *   • 'vi'  : รับ V/I/PF → คำนวณ P เอง แล้ว integrate เป็น kWh
 *             - 1 เฟส        : P(kW) = V·I·PF / 1000
 *             - 3 เฟส balanced: P(kW) = √3·V_LL·I·PF / 1000
 *             - 3 เฟส perphase: P(kW) = Σ(Vn·In·PFn) / 1000
 *   • 'kw'  : รับ kW ตรง ๆ → integrate เป็น kWh
 *   • 'kwh' : รับ kWh สะสม (energy register) → consumption = register − base (กัน rollover/reset)
 *
 * ผลลัพธ์: เก็บใน snapshot (หน้า Power อ่าน) + เขียนลง virtual tag ที่ map ไว้ (outKwTag/outKwhTag/outCostTag)
 * accumulator (energyKwh / kwhBase) persist ลง config → kWh ไม่หายตอน restart
 * ════════════════════════════════════════════════════════════════════════════
 */

const SQRT3 = Math.sqrt(3);
const DEFAULT_SAMPLE = 1000;
const MIN_SAMPLE = 200;
const MAX_SAMPLE = 3600000;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }

class PowerManager {
  constructor(tagEngine) {
    this.tagEngine = tagEngine || null;
    this.meters = [];
    this._timers = new Map();        // id -> interval handle
    this._rt = new Map();            // id -> { kw, kwh, cost, lastTs, lastReg, ts, err }
    this._started = false;
    this._saveTick = 0;
    this._load();
  }

  // ── persistence ─────────────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('powermeters.json', path.join(__dirname, 'config', 'powermeters.json'));
    try {
      const raw = JSON.parse(require('fs').readFileSync(this.path, 'utf8'));
      this.meters = Array.isArray(raw.meters) ? raw.meters.map((m) => this._norm(m)) : [];
    } catch (_) { this.meters = []; }
  }
  _save() { csv.writeJsonAtomic(this.path, { meters: this.meters }); }

  _norm(m) {
    return {
      id: m.id,
      name: String(m.name || '').trim(),
      enabled: m.enabled !== false,
      source: ['kw', 'kwh'].includes(m.source) ? m.source : 'vi',
      phase: String(m.phase) === '3' ? '3' : '1',
      phase3: m.phase3 === 'perphase' ? 'perphase' : 'balanced',
      // input tags (string 'device|tag' · '' = ไม่ใช้)
      vTag: String(m.vTag || ''), iTag: String(m.iTag || ''), pfTag: String(m.pfTag || ''),
      v1Tag: String(m.v1Tag || ''), v2Tag: String(m.v2Tag || ''), v3Tag: String(m.v3Tag || ''),
      i1Tag: String(m.i1Tag || ''), i2Tag: String(m.i2Tag || ''), i3Tag: String(m.i3Tag || ''),
      pf1Tag: String(m.pf1Tag || ''), pf2Tag: String(m.pf2Tag || ''), pf3Tag: String(m.pf3Tag || ''),
      kwTag: String(m.kwTag || ''),
      kwhTag: String(m.kwhTag || ''),
      // output (virtual tag ที่จะเขียนผลลง · '' = ไม่เขียน)
      outKwTag: String(m.outKwTag || ''), outKwhTag: String(m.outKwhTag || ''), outCostTag: String(m.outCostTag || ''),
      rate: num(m.rate) || 0,                 // ค่าไฟต่อ kWh
      sampleMs: clampInt(m.sampleMs, MIN_SAMPLE, MAX_SAMPLE, DEFAULT_SAMPLE),
      // accumulator (persist)
      energyKwh: num(m.energyKwh) || 0,       // kWh สะสม (vi/kw) หรือ consumption (kwh)
      kwhBase: m.kwhBase == null ? null : num(m.kwhBase),  // ค่า register ฐาน (kwh mode)
    };
  }

  // ── อ่าน tag เป็นตัวเลข ('device|tag' → number|null) ────────────────────────────
  _tagNum(ref, def = null) {
    if (!ref || !this.tagEngine) return def;
    const bar = ref.indexOf('|');
    if (bar < 0) return def;
    try {
      const v = this.tagEngine.getTagValue(ref.slice(0, bar), ref.slice(bar + 1));
      const n = v ? num(v.value) : null;
      return n == null ? def : n;
    } catch (_) { return def; }
  }

  // ── คำนวณกำลังไฟ (kW) ของมิเตอร์ตาม source/phase ──────────────────────────────
  //   คืน { kw, reg } · reg = ค่า register (kwh mode) · null = อ่าน input ไม่ได้
  _computeKw(m) {
    if (m.source === 'kw') { const kw = this._tagNum(m.kwTag); return kw == null ? null : { kw, reg: null }; }
    if (m.source === 'kwh') { const reg = this._tagNum(m.kwhTag); return reg == null ? null : { kw: null, reg }; }
    // source 'vi'
    if (m.phase === '1') {
      const v = this._tagNum(m.vTag), i = this._tagNum(m.iTag), pf = this._tagNum(m.pfTag, 1);
      if (v == null || i == null) return null;
      return { kw: (v * i * pf) / 1000, reg: null };
    }
    if (m.phase3 === 'perphase') {
      let w = 0, any = false;
      for (const [vt, it, pt] of [[m.v1Tag, m.i1Tag, m.pf1Tag], [m.v2Tag, m.i2Tag, m.pf2Tag], [m.v3Tag, m.i3Tag, m.pf3Tag]]) {
        const v = this._tagNum(vt), i = this._tagNum(it), pf = this._tagNum(pt, 1);
        if (v != null && i != null) { w += v * i * pf; any = true; }
      }
      return any ? { kw: w / 1000, reg: null } : null;
    }
    // 3 เฟส balanced
    const v = this._tagNum(m.vTag), i = this._tagNum(m.iTag), pf = this._tagNum(m.pfTag, 1);
    if (v == null || i == null) return null;
    return { kw: (SQRT3 * v * i * pf) / 1000, reg: null };
  }

  // ── ประเมิน 1 มิเตอร์ (เรียกทุก sampleMs) ──────────────────────────────────────
  _tick(m, nowTs) {
    const rt = this._rt.get(m.id) || { kw: 0, kwh: m.energyKwh || 0, cost: 0, lastTs: null, lastReg: null };
    const c = this._computeKw(m);
    if (!c) { rt.err = 'อ่าน input tag ไม่ได้'; rt.ts = nowTs; this._rt.set(m.id, rt); return; }
    rt.err = null;
    const dtHr = rt.lastTs != null ? Math.max(0, (nowTs - rt.lastTs) / 3600000) : 0;

    if (m.source === 'kwh') {
      const reg = c.reg;
      if (m.kwhBase == null) m.kwhBase = reg;                 // ตั้งฐานครั้งแรก
      if (reg < m.kwhBase) m.kwhBase = reg;                   // register reset/rollover → rebase
      rt.kwh = reg - m.kwhBase;                                // consumption สะสม
      rt.kw = (rt.lastReg != null && dtHr > 0) ? Math.max(0, (reg - rt.lastReg) / dtHr) : (rt.kw || 0);
      rt.lastReg = reg;
    } else {
      rt.kw = c.kw;
      rt.kwh = (m.energyKwh || 0) + (dtHr > 0 ? c.kw * dtHr : 0);  // integrate
      m.energyKwh = rt.kwh;
    }
    rt.cost = rt.kwh * (m.rate || 0);
    rt.lastTs = nowTs; rt.ts = nowTs;
    this._rt.set(m.id, rt);

    // publish ลง virtual tag (ถ้า map ไว้)
    this._writeOut(m.outKwTag, rt.kw);
    this._writeOut(m.outKwhTag, rt.kwh);
    this._writeOut(m.outCostTag, rt.cost);
  }
  _writeOut(ref, value) {
    if (!ref || !this.tagEngine || value == null) return;
    const bar = ref.indexOf('|');
    if (bar < 0) return;
    try { this.tagEngine.setTagValue(ref.slice(0, bar), ref.slice(bar + 1), value, 'good'); } catch (_) {}
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────
  _arm(m) {
    this._disarm(m.id);
    if (!m.enabled) return;
    const h = setInterval(() => {
      this._tick(m, Date.now());
      // persist accumulator เป็นระยะ (กัน kWh หายตอนไฟดับ) ~ ทุก 30s รวมทุกมิเตอร์
      if (++this._saveTick % Math.max(1, Math.round(30000 / m.sampleMs)) === 0) { try { this._save(); } catch (_) {} }
    }, m.sampleMs);
    this._timers.set(m.id, h);
  }
  _disarm(id) { const h = this._timers.get(id); if (h) { clearInterval(h); this._timers.delete(id); } }

  start() {
    if (this._started) return;
    this._started = true;
    for (const m of this.meters) this._arm(m);
  }
  stop() {
    for (const id of [...this._timers.keys()]) this._disarm(id);
    try { this._save(); } catch (_) {}   // เก็บ accumulator ก่อนปิด
    this._started = false;
  }
  reload() { this.stop(); this._load(); this.start(); }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  list() { return this.meters.map((m) => ({ ...m })); }
  get(id) { return this.meters.find((m) => m.id === id) || null; }
  _genId(name) {
    const base = 'pm_' + (String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24).toLowerCase() || 'meter');
    const exist = new Set(this.meters.map((m) => m.id));
    let id = base, n = 1; while (exist.has(id)) id = `${base}_${n++}`; return id;
  }
  _dup(name, exceptId) {
    const lc = String(name).trim().toLowerCase();
    return this.meters.some((m) => m.id !== exceptId && m.name.toLowerCase() === lc);
  }

  create(def) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('name is required');
    if (this._dup(name)) throw new Error('ชื่อซ้ำ');
    const rec = this._norm({ ...def, id: this._genId(name), name, energyKwh: 0, kwhBase: null });
    this.meters.push(rec); this._save();
    if (this._started) this._arm(rec);
    return rec;
  }
  update(id, updates) {
    const i = this.meters.findIndex((m) => m.id === id);
    if (i === -1) throw new Error('not found');
    const name = updates.name != null ? String(updates.name).trim() : this.meters[i].name;
    if (this._dup(name, id)) throw new Error('ชื่อซ้ำ');
    // คง accumulator เดิม (ไม่ให้ reset ตอนแก้ config) เว้นแต่ส่งมาเอง
    const keep = { energyKwh: this.meters[i].energyKwh, kwhBase: this.meters[i].kwhBase };
    this.meters[i] = this._norm({ ...this.meters[i], ...keep, ...updates, id, name });
    this._save();
    if (this._started) this._arm(this.meters[i]);
    return this.meters[i];
  }
  remove(id) {
    const i = this.meters.findIndex((m) => m.id === id);
    if (i === -1) return false;
    this._disarm(id); this._rt.delete(id);
    this.meters.splice(i, 1); this._save();
    return true;
  }
  // รีเซ็ตหน่วยสะสม (kWh กลับ 0 · kwh-mode rebase ใหม่)
  reset(id) {
    const m = this.get(id); if (!m) return false;
    m.energyKwh = 0; m.kwhBase = null;
    const rt = this._rt.get(id); if (rt) { rt.kwh = 0; rt.cost = 0; rt.lastReg = null; }
    this._save();
    return true;
  }

  // live snapshot สำหรับหน้า Power
  live() {
    return this.meters.map((m) => {
      const rt = this._rt.get(m.id) || {};
      return { id: m.id, name: m.name, enabled: m.enabled, source: m.source, phase: m.phase,
        kw: rt.kw ?? null, kwh: rt.kwh ?? m.energyKwh ?? 0, cost: rt.cost ?? 0,
        rate: m.rate, err: rt.err || null, ts: rt.ts || null };
    });
  }
}

module.exports = PowerManager;
