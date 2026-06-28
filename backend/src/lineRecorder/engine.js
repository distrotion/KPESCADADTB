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

// เช็คสเปก field → คืน list ที่หลุด (ให้ caller ไปยิง alarm)
function checkSpec(fields, station, values) {
  const viol = [];
  for (const f of (fields || [])) {
    if (f.scope === 'step' && f.station && String(f.station) !== String(station)) continue;
    const v = values[f.key]; if (v == null) continue;
    const s = f.spec || {};
    if ((s.min != null && v < s.min) || (s.max != null && v > s.max)) viol.push({ key: f.key, value: v, spec: s });
  }
  return viol;
}

class LineEngine {
  constructor({ store, getStore, getConfig }) { this.store = store; this.getStore = getStore; this.getConfig = getConfig; }
  _store(line) { return this.getStore ? this.getStore(line) : this.store; }

  // รับ canonical event → บันทึก · คืน {job, step, violations}
  async project(ev) {
    const cfg = this.getConfig(ev.line) || { fields: [] };
    const store = this._store(ev.line);
    const jobKey = jobKeyOf(ev);
    const ts = ev.ts || Date.now();

    await store.appendEvent({ ...ev, jobKey, ts });   // 1) source of truth ก่อนเสมอ

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
    if (ev.type === 'EXIT') { jobPatch.status = ev.complete ? 'complete' : 'done'; jobPatch.exitAt = ts; }
    const job = await store.upsertJob(jobPatch);

    let step = null; let violations = [];
    if ((ev.type === 'STEP' || ev.type === 'STAGE') && ev.station) {
      const values = _applyFormulas(cfg.fields, ev.station, { ...(ev.values || {}) });
      violations = checkSpec(cfg.fields, ev.station, values);
      step = await store.upsertStep(jobKey, {
        station: ev.station, name: ev.stationName, seq: ev.seq, type: ev.stationType,
        enterTs: ev.enterTs, exitTs: ev.exitTs, dwell: ev.dwell != null ? ev.dwell : null, params: values,
        inSpec: violations.length === 0, ts,
      });
    }
    return { jobKey, job, step, violations };
  }
}

module.exports = { LineEngine, jobKeyOf, checkSpec };
