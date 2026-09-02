// snapshotSource.js — poll tag ที่ "เลือกไว้" ต่อตำแหน่ง → ประกอบ snapshot → CarrierTracker → engine
//   ไม่รู้จัก protocol — อ่านผ่าน tag engine เดิม (getTagValue) · select tag (ไม่ใช่ array tag)
//   config.source: { mode:"snapshot", pollMs?, positions:[ { pos, station,
//                    identityTag:{device,tag}, paramTags:{ key:{device,tag} } } ] }

const { CarrierTracker } = require('./carrierTracker');

class SnapshotSource {
  constructor({ engine, manager, tracker, intervalMs } = {}) {
    this.engine = engine; this.manager = manager;
    this.tracker = tracker || new CarrierTracker();
    this.intervalMs = Number(intervalMs) || 500;
    this._timer = null; this._busy = false;
    this._entry = {};   // line → { lastTrig, lastId } สำหรับ entry trigger
  }
  _tag(device, tag) {
    try { const v = this.engine && this.engine.getTagValue ? this.engine.getTagValue(device, tag) : null; return v ? v.value : null; }
    catch (_) { return null; }
  }
  // โหมดบ่อแรก: อ่าน job-data ระดับไลน์ (fields scope=job · tag หรือ script) → อ่านตอนงานเข้าบ่อแรก
  _jobValuesFirst(cfg) {
    const out = {};
    for (const f of (cfg.fields || [])) {
      if (f.scope !== 'job' || !f.tag) continue;
      const v = f.tag.script ? this._evalJob(f.tag.script, null) : this._tag(f.tag.device, f.tag.tag);
      if (v != null) out[f.key] = v;
    }
    return out;
  }

  // eval script ของ job-data — helper: tag(device,tag) · pad(v,width,ch='0') · identity · Math/String/Number
  //   เช่น  pad(tag('PLC02','D100'),4)  ·  'LOT'+pad(identity,4)
  _evalJob(expr, identity) {
    try {
      const tag = (d, t) => this._tag(d, t);
      const pad = (v, w, ch) => String(v == null ? '' : v).padStart(Number(w) || 0, ch != null ? String(ch) : '0');
      // eslint-disable-next-line no-new-func
      const fn = new Function('tag', 'pad', 'identity', 'Math', 'String', 'Number', `"use strict"; return (${expr});`);
      const r = fn(tag, pad, identity, Math, String, Number);
      return r == null ? null : r;
    } catch (_) { return null; }
  }

  // ทางเข้า (trigger) 1 อัน — เฝ้า tag → เปลี่ยน/เพิ่ม = งานใหม่ → registerJob (identity current/prev · barcode จาก tag ของทางเข้านี้)
  //   รองรับหลายทางเข้า: state แยกต่อ (line#idx)
  _handleEntry(cfg, e, idx, now) {
    if (!e || !e.trigger || !e.trigger.tag) return;
    const key = cfg.line + '#' + idx;
    const st = this._entry[key] || (this._entry[key] = {});
    const trig = this._tag(e.trigger.device, e.trigger.tag);
    const idr = e.identity || {};
    const curId = this._tag(idr.device, idr.tag);
    const first = st.lastTrig === undefined;
    const changed = !first && trig != null && trig !== st.lastTrig &&
      (e.triggerType === 'increase' ? Number(trig) > Number(st.lastTrig) : true);
    if (changed) {
      const identity = idr.prev ? st.lastId : curId;          // เอาเลขก่อนหน้า หรือ เลขปัจจุบัน
      const jobValues = {};                                    // barcode/ข้อมูลงาน จาก tag หรือ script ของทางเข้านี้
      for (const [k, ref] of Object.entries(e.jobTags || {})) {
        const v = (ref && ref.script) ? this._evalJob(ref.script, identity) : this._tag((ref || {}).device, (ref || {}).tag);
        if (v != null) jobValues[k] = v;
      }
      const ev = this.tracker.registerJob(cfg.line, identity, { lane: e.lane || '', jobValues, station: e.station || '' }, cfg, now);
      if (ev) this.manager.projectEvent(ev).catch((err) => console.error(`[lineRecorder/entry] ${cfg.line}:`, err.message));
    }
    st.lastTrig = trig; st.lastId = curId;
  }
  _snapLines() {
    return Object.values(this.manager.configs || {}).filter(
      (c) => c.enabled && c.source && c.source.mode === 'snapshot' && Array.isArray(c.source.positions) && c.source.positions.length,
    );
  }
  // อ่าน tag ทุกตำแหน่งของไลน์ → snapshot[{pos,station,identity,params}]
  readSnapshot(cfg) {
    const fdec = {};   // key → จุดทศนิยม (PLC ×10^n → หารคืน เช่น 647 จุด1 = 64.7)
    for (const f of (cfg.fields || [])) { if (f.scope !== 'job') fdec[f.key] = Number(f.decimals) || 0; }
    const out = [];
    for (const p of cfg.source.positions) {
      const params = {};
      for (const [k, ref] of Object.entries(p.paramTags || {})) {
        let v = this._tag((ref || {}).device, (ref || {}).tag);
        const d = (ref && ref.decimals != null) ? (Number(ref.decimals) || 0) : (fdec[k] || 0);   // จุดต่อบ่อ (override) → fallback จุดของ param
        if (v != null && d > 0) { const n = Number(v); if (Number.isFinite(n)) v = Number((n / Math.pow(10, d)).toFixed(d)); }
        params[k] = v;
      }
      if (p.kind === 'oven') {   // เตาอบ: เข้า/ออกคนละ tag (เลข carrier ตรง ๆ)
        out.push({ pos: Number(p.pos), station: p.station, kind: 'oven',
          inId: this._tag((p.inTag || {}).device, (p.inTag || {}).tag),
          outId: this._tag((p.outTag || {}).device, (p.outTag || {}).tag), params });
        continue;
      }
      const idt = p.identityTag || {};
      out.push({ pos: Number(p.pos), station: p.station, identity: this._tag(idt.device, idt.tag), params });
    }
    return out;
  }
  async _pollOnce() {
    if (this._busy || !this.engine) return; this._busy = true;
    try {
      for (const cfg of this._snapLines()) {
        if (this.manager.owned && this.manager.owned[cfg.line] === false) continue;   // viewer → ไม่ poll/เขียนไลน์นี้
        try {
          const now = Date.now();
          const entries = Array.isArray(cfg.source.entries) ? cfg.source.entries : (cfg.source.entry ? [cfg.source.entry] : []);
          for (let i = 0; i < entries.length; i++) this._handleEntry(cfg, entries[i], i, now);   // หลายทางเข้า
          const entryMode = entries.length ? 'trigger' : 'first';
          const snap = this.readSnapshot(cfg);
          const jobValues = entryMode === 'first' ? this._jobValuesFirst(cfg) : null;   // บ่อแรก: อ่าน job-data ตอนเข้าบ่อ 1
          const events = this.tracker.update(cfg.line, snap, cfg, now, { entryMode, jobValues });
          for (const ev of events) await this.manager.projectEvent(ev);
          // idle-timeout → จบสมบูรณ์ (หายจากทุกบ่อเกิน N นาที · ตั้งที่ source.idleTimeoutMin · default 5)
          const toMs = (Number(cfg.source.idleTimeoutMin) > 0 ? Number(cfg.source.idleTimeoutMin) : 5) * 60000;
          const done = this.tracker.sweepIdle(cfg.line, cfg, now, toMs);
          for (const ev of done) await this.manager.projectEvent(ev);
        } catch (e) { console.error(`[lineRecorder/snapshot] ${cfg.line}:`, e.message); }
      }
    } finally { this._busy = false; }
  }
  start() {
    if (this._timer) return;
    const n = this._snapLines().length;
    if (!n) { console.log('[lineRecorder/snapshot] ไม่มีไลน์ snapshot (source.mode=snapshot) — ข้าม'); return; }
    this._timer = setInterval(() => this._pollOnce().catch(() => {}), this.intervalMs);
    console.log(`[lineRecorder/snapshot] poll ${n} line(s) ทุก ${this.intervalMs}ms`);
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

module.exports = { SnapshotSource };
