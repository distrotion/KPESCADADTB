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
const CSV_FOLDER = 'power';          // history รายวัน (ปิดวัน append) — <data>/power/power-YYYY-MM-DD.csv
const CSV_PREFIX = 'power';
const DAILY_COLUMNS = ['date', 'meter_id', 'meter_name', 'kwh_total', 'kwh_peak', 'kwh_offpeak', 'cost', 'kw_max', 'by_period'];
const POWER_DEVICE = 'POWER';        // managed virtual device — tag ต่อมิเตอร์ <id>_kw/_kwh/_cost (record/widget)

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampInt(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
function hm(s, def) { return /^\d{1,2}:\d{2}$/.test(String(s || '')) ? String(s) : def; }   // 'HH:MM'
function hmMin(s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; }

class PowerManager {
  constructor(tagEngine, datalogManager) {
    this.tagEngine = tagEngine || null;
    this.datalogManager = datalogManager || null;   // record: auto-สร้าง datalog ต่อมิเตอร์ (ตั้งทีหลังได้ผ่าน setDatalogManager)
    this.meters = [];
    this.tou = this._normTou(null);
    this._timers = new Map();        // id -> interval handle
    this._rt = new Map();            // id -> { kw, kwh, cost, lastTs, lastReg, ts, err }
    this._started = false;
    this._saveTick = 0;
    this._load();
  }
  setDatalogManager(dm) { this.datalogManager = dm || null; }

  // ── persistence ─────────────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('powermeters.json', path.join(__dirname, 'config', 'powermeters.json'));
    try {
      const raw = JSON.parse(require('fs').readFileSync(this.path, 'utf8'));
      this.meters = Array.isArray(raw.meters) ? raw.meters.map((m) => this._norm(m)) : [];
      this.tou = this._normTou(raw.tou);
    } catch (_) { this.meters = []; this.tou = this._normTou(null); }
  }
  _save() { csv.writeJsonAtomic(this.path, { meters: this.meters, tou: this.tou }); }

  // ── TOU config (global 1 ชุด — สัญญาไฟของโรงงาน) ─────────────────────────────
  //   period ไม่ match = 'offpeak' · วันหยุด (holidays) = offpeak ทั้งวัน · default = มาตรฐานการไฟฟ้าไทย
  _normTou(t) {
    t = t || {};
    const periods = (Array.isArray(t.periods) && t.periods.length ? t.periods : [
      { key: 'peak', label: 'Peak', days: [1, 2, 3, 4, 5], start: '09:00', end: '22:00' },
    ]).map((p) => ({
      key: String(p.key || 'peak').replace(/[^a-zA-Z0-9_]/g, '') || 'peak',
      label: String(p.label || p.key || ''),
      days: (Array.isArray(p.days) ? p.days : [1, 2, 3, 4, 5]).map(Number).filter((d) => d >= 0 && d <= 6),
      start: hm(p.start, '09:00'), end: hm(p.end, '22:00'),
    }));
    const rates = {};
    for (const [k, v] of Object.entries(t.rates || {})) { const n = num(v); if (n != null && n >= 0) rates[k] = n; }
    if (rates.peak == null) rates.peak = 0;
    if (rates.offpeak == null) rates.offpeak = 0;
    return {
      periods, rates,
      ft: num(t.ft) || 0,                                  // Ft บาท/kWh (บวกทุกหน่วย)
      serviceCharge: num(t.serviceCharge) || 0,            // ค่าบริการรายเดือน (บวกท้ายบิลตอนสรุป)
      holidays: (Array.isArray(t.holidays) ? t.holidays : []).map(String).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
      billingDay: clampInt(t.billingDay, 1, 28, 1),        // วันตัดรอบเดือน
    };
  }
  getTou() { return JSON.parse(JSON.stringify(this.tou)); }
  setTou(updates) { this.tou = this._normTou({ ...this.tou, ...(updates || {}) }); this._save(); return this.getTou(); }

  // period key ณ เวลา ts (local): วันหยุด → offpeak ทั้งวัน · เทียบ periods ตามลำดับ · ไม่ match = offpeak
  periodKeyAt(ts) {
    const d = new Date(ts);
    if (this.tou.holidays.includes(csv.dateStamp(d))) return 'offpeak';
    const day = d.getDay(), min = d.getHours() * 60 + d.getMinutes();
    for (const p of this.tou.periods) {
      if (!p.days.includes(day)) continue;
      const s = hmMin(p.start), e = hmMin(p.end);
      const inRange = s <= e ? (min >= s && min < e) : (min >= s || min < e);   // ข้ามเที่ยงคืนได้
      if (inRange) return p.key;
    }
    return 'offpeak';
  }
  _rateOf(key) { const r = this.tou.rates[key]; return (r != null ? r : (this.tou.rates.offpeak || 0)) + (this.tou.ft || 0); }

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
      rate: num(m.rate) || 0,                 // ค่าไฟต่อ kWh (โหมด flat)
      rateMode: m.rateMode === 'tou' ? 'tou' : 'flat',   // flat (เดิม) | tou (คิดตามช่วงเวลา global TOU)
      record: m.record === true,              // บันทึกต่อเนื่องลง Datalog (auto-สร้าง log · ดูกราฟหน้า Trend)
      recordLogId: String(m.recordLogId || ''),           // id ของ datalog ที่ระบบสร้างให้ (ว่าง = ยังไม่สร้าง)
      sampleMs: clampInt(m.sampleMs, MIN_SAMPLE, MAX_SAMPLE, DEFAULT_SAMPLE),
      // accumulator (persist)
      energyKwh: num(m.energyKwh) || 0,       // kWh สะสม (vi/kw) หรือ consumption (kwh)
      kwhBase: m.kwhBase == null ? null : num(m.kwhBase),  // ค่า register ฐาน (kwh mode)
      energyByPeriod: (m.energyByPeriod && typeof m.energyByPeriod === 'object')
        ? Object.fromEntries(Object.entries(m.energyByPeriod).map(([k, v]) => [k, num(v) || 0])) : {},   // kWh สะสมแยก period (tou)
      dayAcc: (m.dayAcc && typeof m.dayAcc === 'object' && m.dayAcc.date)
        ? { date: String(m.dayAcc.date), kwh: { ...(m.dayAcc.kwh || {}) }, cost: num(m.dayAcc.cost) || 0, kwMax: num(m.dayAcc.kwMax) || 0 }
        : null,                                            // bucket วันปัจจุบัน (ปิดวัน → append CSV)
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
    const prevKwh = rt.kwh || 0;

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

    // ── TOU + history: พลังงานส่วนเพิ่มรอบนี้ dE → สะสมแยก period + bucket รายวัน ──
    const first = rt.lastTs == null;                           // tick แรกของ session (เพิ่ง start/restart) = ยังไม่มี baseline จริง
    const dE = first ? 0 : Math.max(0, (rt.kwh || 0) - prevKwh);  // rebase/reset/tick แรก → dE=0 (กัน spike ยอดสะสม reg-kwhBase อัดรวดเดียวตอน restart โหมด kwh)
    const period = this.periodKeyAt(nowTs);
    if (dE > 0) m.energyByPeriod[period] = (m.energyByPeriod[period] || 0) + dE;
    const stamp = csv.dateStamp(new Date(nowTs));
    if (!m.dayAcc) m.dayAcc = { date: stamp, kwh: {}, cost: 0, kwMax: 0 };
    else if (m.dayAcc.date !== stamp) { this._closeDay(m); m.dayAcc = { date: stamp, kwh: {}, cost: 0, kwMax: 0 }; }   // ข้ามวัน → append แถวเมื่อวาน
    if (dE > 0) {
      m.dayAcc.kwh[period] = (m.dayAcc.kwh[period] || 0) + dE;
      m.dayAcc.cost += dE * (m.rateMode === 'tou' ? this._rateOf(period) : (m.rate || 0));   // cost ของวัน (ตาม rate ขณะเกิด)
    }
    if ((rt.kw || 0) > (m.dayAcc.kwMax || 0)) m.dayAcc.kwMax = rt.kw || 0;

    // cost สะสมทั้งก้อน: flat = เดิม · tou = Σ(หน่วยต่อ period × (rate+ft))
    rt.cost = m.rateMode === 'tou'
      ? Object.entries(m.energyByPeriod).reduce((s, [k, v]) => s + v * this._rateOf(k), 0)
      : rt.kwh * (m.rate || 0);
    rt.lastTs = nowTs; rt.ts = nowTs;
    this._rt.set(m.id, rt);

    // publish ลง virtual tag (ถ้า map ไว้) + tag ของ device POWER (มีเสมอ · record/widget ใช้)
    this._writeOut(m.outKwTag, rt.kw);
    this._writeOut(m.outKwhTag, rt.kwh);
    this._writeOut(m.outCostTag, rt.cost);
    this._writePower(m.id, rt);
  }

  _writePower(id, rt) {
    if (!this.tagEngine) return;
    try {
      this.tagEngine.setTagValue(POWER_DEVICE, `${id}_kw`, rt.kw ?? 0, 'good');
      this.tagEngine.setTagValue(POWER_DEVICE, `${id}_kwh`, rt.kwh ?? 0, 'good');
      this.tagEngine.setTagValue(POWER_DEVICE, `${id}_cost`, rt.cost ?? 0, 'good');
    } catch (_) {}
  }

  // ปิดวัน: append bucket ลงไฟล์รายวัน (power-YYYY-MM-DD.csv · แถวต่อมิเตอร์)
  _closeDay(m) {
    const a = m.dayAcc;
    if (!a || !a.date) return;
    const total = Object.values(a.kwh).reduce((s, v) => s + v, 0);
    if (total <= 0 && !a.kwMax) return;   // วันว่าง (ไม่มีข้อมูล) ไม่ต้องเขียน
    const peak = a.kwh.peak || 0;
    const offpeak = total - peak;         // รวม period อื่นที่ไม่ใช่ peak (custom keys อยู่ใน by_period เต็ม)
    try {
      csv.appendDailyRow(csv.csvDir(CSV_FOLDER), CSV_PREFIX, new Date(`${a.date}T12:00:00`), DAILY_COLUMNS, [
        a.date, m.id, m.name, total.toFixed(4), peak.toFixed(4), offpeak.toFixed(4),
        (a.cost || 0).toFixed(2), (a.kwMax || 0).toFixed(3), JSON.stringify(a.kwh),
      ]);
    } catch (_) {}
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
    if (h.unref) h.unref();   // ไม่ค้ำ process (server.listen ค้ำอยู่แล้ว · test/CLI จบได้)
    this._timers.set(m.id, h);
  }
  _disarm(id) { const h = this._timers.get(id); if (h) { clearInterval(h); this._timers.delete(id); } }

  start() {
    if (this._started) return;
    this._started = true;
    this._ensurePowerDevice();
    for (const m of this.meters) { this._arm(m); this._syncRecord(m); }
  }
  stop() {
    for (const id of [...this._timers.keys()]) this._disarm(id);
    try { this._save(); } catch (_) {}   // เก็บ accumulator + dayAcc ก่อนปิด (วันปิดตอนข้ามวันเท่านั้น)
    this._started = false;
  }
  reload() { this.stop(); this._load(); this.start(); }

  // ── managed device POWER: tag ต่อมิเตอร์ <id>_kw/_kwh/_cost (สร้างใหม่ทั้งชุดให้ตรงรายการมิเตอร์) ──
  _ensurePowerDevice() {
    if (!this.tagEngine || typeof this.tagEngine.registerManagedDevice !== 'function') return;
    try {
      this.tagEngine.unregisterManagedDevice(POWER_DEVICE);   // ล้าง tag มิเตอร์ที่ถูกลบ
      if (!this.meters.length) return;
      const tags = [];
      for (const m of this.meters) {
        tags.push({ id: `${m.id}_kw`, name: `${m.name} kW`, dataType: 'FLOAT', unit: 'kW', group: m.name });
        tags.push({ id: `${m.id}_kwh`, name: `${m.name} kWh`, dataType: 'FLOAT', unit: 'kWh', group: m.name });
        tags.push({ id: `${m.id}_cost`, name: `${m.name} ค่าไฟ`, dataType: 'FLOAT', unit: 'บาท', group: m.name });
      }
      this.tagEngine.registerManagedDevice({ id: POWER_DEVICE, name: 'Power Meters (ระบบ)', tags });
    } catch (_) {}
  }

  // ── record: toggle บันทึกต่อเนื่อง → auto-สร้าง/เปิด-ปิด datalog `Power <name>` (series จาก device POWER) ──
  _syncRecord(m) {
    const dm = this.datalogManager;
    if (!dm) return;
    try {
      let log = m.recordLogId ? dm.get(m.recordLogId) : null;
      if (m.record) {
        const series = [
          { device: POWER_DEVICE, tag: `${m.id}_kw`, label: `${m.name} kW` },
          { device: POWER_DEVICE, tag: `${m.id}_kwh`, label: `${m.name} kWh` },
          { device: POWER_DEVICE, tag: `${m.id}_cost`, label: `${m.name} ค่าไฟ` },
        ];
        if (!log) {
          log = dm.create({ name: `Power ${m.name}`, group: 'Power', series, sampleMs: 60000, storage: 'csv', enabled: true });
          m.recordLogId = log.id; this._save();
        } else if (!log.enabled) dm.update(log.id, { enabled: true });
      } else if (log && log.enabled) dm.update(log.id, { enabled: false });   // ปิด = หยุดบันทึก (ข้อมูลเก่าอยู่)
    } catch (_) {}
  }

  // ── สรุป: แถวรายวันจากไฟล์ + วันนี้สด (dayAcc) · from/to = 'YYYY-MM-DD' ─────────
  summary(fromStamp, toStamp, meterId) {
    const rows = [];
    const dir = csv.csvDir(CSV_FOLDER);
    for (const f of csv.listDailyFiles(dir, CSV_PREFIX)) {
      const dm = f.match(/(\d{4}-\d{2}-\d{2})\.csv$/);
      if (!dm || (fromStamp && dm[1] < fromStamp) || (toStamp && dm[1] > toStamp)) continue;
      try {
        const { cols, rows: rs } = csv.readCsv(path.join(dir, f));
        const gi = (k) => cols.indexOf(k);
        for (const r of rs) {
          const row = {
            date: r[gi('date')], meterId: r[gi('meter_id')], meterName: r[gi('meter_name')],
            kwhTotal: Number(r[gi('kwh_total')]) || 0, kwhPeak: Number(r[gi('kwh_peak')]) || 0,
            kwhOffpeak: Number(r[gi('kwh_offpeak')]) || 0, cost: Number(r[gi('cost')]) || 0, kwMax: Number(r[gi('kw_max')]) || 0,
          };
          if (!meterId || row.meterId === meterId) rows.push(row);
        }
      } catch (_) {}
    }
    // วันนี้ (สด · ยังไม่ปิดวัน)
    const today = csv.dateStamp(new Date());
    if ((!toStamp || today <= toStamp) && (!fromStamp || today >= fromStamp)) {
      for (const m of this.meters) {
        if (meterId && m.id !== meterId) continue;
        const a = m.dayAcc;
        if (!a || a.date !== today) continue;
        const total = Object.values(a.kwh).reduce((s, v) => s + v, 0);
        if (total <= 0 && !a.kwMax) continue;
        const peak = a.kwh.peak || 0;
        rows.push({ date: today, meterId: m.id, meterName: m.name, kwhTotal: total, kwhPeak: peak,
          kwhOffpeak: total - peak, cost: a.cost || 0, kwMax: a.kwMax || 0, live: true });
      }
    }
    rows.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : String(x.meterId).localeCompare(String(y.meterId)));
    return rows;
  }

  // ── สรุปรายเดือนตามรอบบิล (billingDay): cycle = วันที่ตัดรอบ → คืนต่อ (cycle, meter) ──
  //   ยอดบิลประมาณการ = Σcost + serviceCharge (frontend บวกโชว์ · คืน serviceCharge แยก)
  monthly(months, meterId) {
    const n = clampInt(months, 1, 60, 12);
    const bd = this.tou.billingDay;
    const cycleOf = (stamp) => {   // 'YYYY-MM-DD' → stamp วันเริ่มรอบบิล
      const [y, mo, d] = stamp.split('-').map(Number);
      let cy = y, cm = mo;
      if (d < bd) { cm -= 1; if (cm < 1) { cm = 12; cy -= 1; } }
      return `${cy}-${String(cm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`;
    };
    const from = new Date(); from.setDate(1); from.setMonth(from.getMonth() - n);   // setDate(1) ก่อน = กัน setMonth ล้นวันสิ้นเดือน (อ่านจากต้นเดือน n เดือนก่อน)
    const rows = this.summary(csv.dateStamp(from), null, meterId);
    const byKey = new Map();   // 'cycle|meter' → agg
    for (const r of rows) {
      const cycle = cycleOf(r.date);
      const k = `${cycle}|${r.meterId}`;
      const a = byKey.get(k) || { cycle, meterId: r.meterId, meterName: r.meterName, kwhTotal: 0, kwhPeak: 0, kwhOffpeak: 0, cost: 0, kwMax: 0, days: 0 };
      a.kwhTotal += r.kwhTotal; a.kwhPeak += r.kwhPeak; a.kwhOffpeak += r.kwhOffpeak; a.cost += r.cost;
      if (r.kwMax > a.kwMax) a.kwMax = r.kwMax;
      a.days++;
      byKey.set(k, a);
    }
    const out = [...byKey.values()].sort((x, y) => x.cycle < y.cycle ? 1 : x.cycle > y.cycle ? -1 : String(x.meterId).localeCompare(String(y.meterId)));
    return { cycles: out, serviceCharge: this.tou.serviceCharge, billingDay: bd };
  }

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
    if (this._started) { this._ensurePowerDevice(); this._arm(rec); this._syncRecord(rec); }
    return rec;
  }
  update(id, updates) {
    const i = this.meters.findIndex((m) => m.id === id);
    if (i === -1) throw new Error('not found');
    const name = updates.name != null ? String(updates.name).trim() : this.meters[i].name;
    if (this._dup(name, id)) throw new Error('ชื่อซ้ำ');
    // คง accumulator เดิม (ไม่ให้ reset ตอนแก้ config) เว้นแต่ส่งมาเอง
    const cur = this.meters[i];
    const keep = { energyKwh: cur.energyKwh, kwhBase: cur.kwhBase, energyByPeriod: cur.energyByPeriod, dayAcc: cur.dayAcc, recordLogId: cur.recordLogId };
    this.meters[i] = this._norm({ ...cur, ...keep, ...updates, id, name, recordLogId: cur.recordLogId });
    this._save();
    if (this._started) { this._ensurePowerDevice(); this._arm(this.meters[i]); this._syncRecord(this.meters[i]); }
    return this.meters[i];
  }
  remove(id) {
    const i = this.meters.findIndex((m) => m.id === id);
    if (i === -1) return false;
    const m = this.meters[i];
    this._disarm(id); this._rt.delete(id);
    // ปิด datalog ที่ record อยู่ (ไม่ลบข้อมูล)
    try { if (m.recordLogId && this.datalogManager) this.datalogManager.update(m.recordLogId, { enabled: false }); } catch (_) {}
    this.meters.splice(i, 1); this._save();
    if (this._started) this._ensurePowerDevice();
    return true;
  }
  // รีเซ็ตหน่วยสะสม (kWh กลับ 0 · kwh-mode rebase ใหม่ · ล้างสะสม period + bucket วัน)
  reset(id) {
    const m = this.get(id); if (!m) return false;
    m.energyKwh = 0; m.kwhBase = null; m.energyByPeriod = {}; m.dayAcc = null;
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
        rate: m.rate, rateMode: m.rateMode, record: m.record,
        kwhByPeriod: { ...m.energyByPeriod },   // สะสมแยก period (โชว์ Peak/Off-Peak บนการ์ด)
        err: rt.err || null, ts: rt.ts || null };
    });
  }
}

module.exports = PowerManager;
