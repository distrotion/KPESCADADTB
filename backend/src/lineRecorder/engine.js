// engine.js — apply canonical event → project ลง store (event-sourced)
//   ลำดับเสถียร: appendEvent (source of truth) ก่อน → upsert job/step (view)
//   idempotent: ENTER/STEP สร้าง job ให้เองถ้ายังไม่มี (กัน "UPDATE หาแถวไม่เจอ → หาย" แบบเก่า)

// run = instance ของ carrier ที่ซ้ำในวัน/lane เดียว · set = แถว (กัน carrier ซ้ำข้ามแถว) · ไม่มี set('1')/run = key เดิม (backward compatible)
function jobKeyOf(ev) {
  const k = [ev.line, ev.dateKey, ev.lane, ev.carrier];
  if (ev.set != null && ev.set !== '' && String(ev.set) !== '1') k.push('s' + ev.set);
  if (ev.run != null && ev.run !== '') k.push('r' + ev.run);
  return k.join('|');
}

// formula fields — คำนวณจาก values อื่นใน step (เช่น TA/FA → ratio) · safe eval แบบจำกัด
function _applyFormulas(fields, station, values) {
  for (const f of (fields || [])) {
    if (!f.source || f.source.kind !== 'formula' || !f.source.expr) continue;
    if (f.scope === 'step' && f.station && String(f.station) !== String(station)) continue;
    try {
      const keys = Object.keys(values);
      const args = keys.map((k) => Number(values[k]));
      // eslint-disable-next-line no-new-func
      const fn = new Function(...keys, `try{return (${f.source.expr});}catch(e){return null;}`);
      const out = fn(...args);
      if (Number.isFinite(out)) values[f.key] = Math.round(out * 1e6) / 1e6;
    } catch (_) { /* expr ผิด → ข้าม */ }
  }
  return values;
}

// resolve เกณฑ์ spec → { min, max } (ตัวเลข) · read(device,tag)=ค่าปัจจุบัน (null ได้)
//   mode 'minmax': min/max เป็นเลข หรือดึงจาก minTag/maxTag · mode 'offset': min=ref+minOff · max=ref+maxOff
function resolveSpec(spec, read) {
  if (!spec) return { min: null, max: null };
  read = read || (() => null);
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  if (spec.mode === 'offset') {
    const ref = spec.refTag ? n(read(spec.refTag.device, spec.refTag.tag)) : null;
    if (ref == null) return { min: null, max: null };   // ไม่มีค่า ref → ไม่เช็ค
    return { min: spec.minOff != null ? ref + Number(spec.minOff) : null,
             max: spec.maxOff != null ? ref + Number(spec.maxOff) : null };
  }
  return { min: spec.minTag ? n(read(spec.minTag.device, spec.minTag.tag)) : n(spec.min),
           max: spec.maxTag ? n(read(spec.maxTag.device, spec.maxTag.tag)) : n(spec.max) };
}

// เกณฑ์ของ param นี้ที่บ่อนี้ — บ่อตั้งเองไว้ = ใช้ของบ่อ · ไม่ได้ตั้ง = เกณฑ์กลางของ param
//   stationSpec = stations[<id>].spec (map key→spec) ที่ lineConfig normalize มาแล้ว
function _specFor(field, stationSpec) {
  const own = stationSpec && stationSpec[field.key];
  return own || field.spec;
}

// เกณฑ์ที่ resolve แล้วต่อ field ของ station → { key: {min,max} } (เฉพาะที่มีเกณฑ์)
function resolveSpecMap(fields, station, read, stationSpec) {
  const out = {};
  for (const f of (fields || [])) {
    if (f.scope === 'step' && f.station && String(f.station) !== String(station)) continue;
    const lim = resolveSpec(_specFor(f, stationSpec), read);
    if (lim && (lim.min != null || lim.max != null)) out[f.key] = lim;
  }
  return out;
}

// value หลุดเกณฑ์ (จาก specMap ที่ resolve แล้ว) → list ที่หลุด
function violFromMap(values, specMap) {
  const viol = [];
  for (const k in (specMap || {})) {
    const v = values[k]; if (v == null) continue;
    const l = specMap[k];
    if ((l.min != null && v < l.min) || (l.max != null && v > l.max)) viol.push({ key: k, value: v, spec: l });
  }
  return viol;
}

// เช็คสเปก field (fixed เท่านั้น · ใช้ fallback ข้อมูลเก่าที่ไม่มี spec เก็บ) → คืน list ที่หลุด
//   stationSpec (ถ้าส่งมา) = เกณฑ์เฉพาะบ่อ ทับเกณฑ์กลางของ param
function checkSpec(fields, station, values, stationSpec) {
  const viol = [];
  for (const f of (fields || [])) {
    if (f.scope === 'step' && f.station && String(f.station) !== String(station)) continue;
    const v = values[f.key]; if (v == null) continue;
    const s = _specFor(f, stationSpec) || {};
    if ((s.min != null && v < s.min) || (s.max != null && v > s.max)) viol.push({ key: f.key, value: v, spec: s });
  }
  return viol;
}

class LineEngine {
  constructor({ store, getStore, getConfig, getTagValue }) { this.store = store; this.getStore = getStore; this.getConfig = getConfig; this.getTagValue = getTagValue || null; }
  _store(line) { return this.getStore ? this.getStore(line) : this.store; }

  // รับ canonical event → บันทึก · คืน {job, step, violations}
  async project(ev) {
    const cfg = this.getConfig(ev.line) || { fields: [] };
    const store = this._store(ev.line);
    const jobKey = jobKeyOf(ev);
    const ts = ev.ts || Date.now();

    // resolve เกณฑ์ spec (เลข/tag/offset) ตอนนี้ → เก็บเกณฑ์ที่ใช้จริง (ดูย้อนหลังไม่เพี้ยนเมื่อ setpoint เปลี่ยน)
    let specMap = null;
    let dwellSp = null, dwellTol = null, dwellInSpec = null;   // time setpoint ต่อ stage (เวลาชุบเป้าหมาย)
    if ((ev.type === 'STEP' || ev.type === 'STAGE') && ev.station) {
      const read = this.getTagValue || (() => null);
      const stSpec = ((cfg.stations || {})[String(ev.station)] || {}).spec;   // เกณฑ์เฉพาะบ่อ (ทับเกณฑ์กลาง)
      const m = resolveSpecMap(cfg.fields, ev.station, read, stSpec);
      if (Object.keys(m).length) specMap = m;
      // stations[st].timeSp = { value | tag:{device,tag}, tolPct } · tolPct ว่าง = เทียบเฉย ๆ (ไม่ตัดสิน)
      const tsp = ((cfg.stations || {})[String(ev.station)] || {}).timeSp;
      if (tsp) {
        const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
        dwellSp = (tsp.tag && tsp.tag.device && tsp.tag.tag) ? n(read(tsp.tag.device, tsp.tag.tag)) : n(tsp.value);
        dwellTol = n(tsp.tolPct);
        if (dwellSp != null && dwellTol != null && ev.dwell != null) {
          const lo = dwellSp * (1 - dwellTol / 100), hi = dwellSp * (1 + dwellTol / 100);
          dwellInSpec = ev.dwell >= lo && ev.dwell <= hi;
        }
      }
    }

    await store.appendEvent({ ...ev, spec: specMap, series: undefined,   // series แยกตาราง (ไม่ฝังใน event — กัน event บวม)
      hasSeries: ev.series ? true : undefined,
      dwellSp: dwellSp != null ? dwellSp : undefined, dwellTol: dwellTol != null ? dwellTol : undefined,
      dwellInSpec: dwellInSpec != null ? dwellInSpec : undefined, jobKey, ts });   // 1) source of truth ก่อนเสมอ

    // job identity (idempotent ทุก type — ENTER/STEP/STAGE ล้วน ensure ได้)
    const jobPatch = { jobKey, line: ev.line, dateKey: ev.dateKey, lane: ev.lane, carrier: ev.carrier, ts };
    if (ev.set != null) jobPatch.set = ev.set;
    if (ev.run != null) jobPatch.run = ev.run;
    if (ev.gap) jobPatch.gap = true;
    if (ev.type === 'ENTER') {
      jobPatch.status = 'running';
      if (!ev.reentry) {                                  // reentry (กลับจาก oven) = แค่กลับเป็น running · ไม่รีเซ็ตเวลา/ข้อมูลงาน
        jobPatch.registerAt = ev.enterTs != null ? ev.enterTs : ts;   // Register time (จุดเข้า/conveyor · first-mode = เข้า stage แรก)
        jobPatch.loadAt = ts;                                          // Load time (เข้า stage 1 จริง)
        jobPatch.enterAt = ts;                                         // (compat เดิม)
        if (ev.values && Object.keys(ev.values).length) jobPatch.data = ev.values;   // ข้อมูลระดับงาน (barcode ฯลฯ)
      }
    }
    // EXIT 2 ระดับ: ออกบ่อสุดท้าย/finish = 'done' (ขาออก) · idle-timeout (ev.complete) = 'complete' (หายจากไลน์ = จบสมบูรณ์)
    // EXIT: cancel (ยกเลิกมือจาก monitor · เช่น เข้าเตาแต่ไม่มีเลขออก) > complete (idle) > done (ขาออก)
    if (ev.type === 'EXIT') { jobPatch.status = ev.cancel ? 'cancel' : (ev.complete ? 'complete' : 'done'); jobPatch.exitAt = ts; if (ev.cancel) jobPatch.cancel = true; }
    const job = await store.upsertJob(jobPatch);

    let step = null; let violations = [];
    if ((ev.type === 'STEP' || ev.type === 'STAGE') && ev.station) {
      const values = _applyFormulas(cfg.fields, ev.station, { ...(ev.values || {}) });
      violations = specMap ? violFromMap(values, specMap)
        : checkSpec(cfg.fields, ev.station, values, ((cfg.stations || {})[String(ev.station)] || {}).spec);
      if (dwellInSpec === false) {   // เวลาชุบหลุด SP±% → ✗ + alarm (ผ่าน violation hook เดิม)
        const lo = Math.round(dwellSp * (1 - dwellTol / 100) * 100) / 100, hi = Math.round(dwellSp * (1 + dwellTol / 100) * 100) / 100;
        violations.push({ key: '__dwell', value: ev.dwell, spec: { min: lo, max: hi, sp: dwellSp, tolPct: dwellTol } });
      }
      step = await store.upsertStep(jobKey, {
        station: ev.station, name: ev.stationName, seq: ev.seq, type: ev.stationType,
        enterTs: ev.enterTs, exitTs: ev.exitTs, dwell: ev.dwell != null ? ev.dwell : null, params: values,
        stats: ev.stats || null,   // min/max/avg ต่อ param (เมื่อเปิด track) · null = ไม่ track
        spec: specMap,   // เกณฑ์ที่ resolve แล้ว (tag/offset) ณ ตอนนั้น · null = ไม่มีเกณฑ์
        dwellSp, dwellTol, dwellInSpec,   // time setpoint (resolve แล้ว) + ผลตัดสิน (null = เทียบเฉย ๆ)
        hasSeries: ev.series ? true : null,   // มี minigraph ในตาราง series (ปุ่ม 📈 เปิดกราฟ LR เอง)
        inSpec: violations.length === 0, ts,
      });
      // minigraph → ตารางแยก lr_<line>_series (1 แถว/การเข้าบ่อ) · แนบเกณฑ์ spec ที่ resolve แล้ว (ถ้ามี)
      if (ev.series && typeof store.appendSeries === 'function') {
        try { await store.appendSeries({ line: ev.line, jobKey, station: String(ev.station), ts, series: ev.series, spec: specMap }); }
        catch (e) { console.error(`[lineRecorder] appendSeries ${ev.line}/${ev.station}:`, e.message); }
      }
    }
    return { jobKey, job, step, violations };
  }
}

module.exports = { LineEngine, jobKeyOf, checkSpec, resolveSpec, resolveSpecMap, violFromMap };
