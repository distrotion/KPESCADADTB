// plcSource.js — binding PLC → Line Recorder ผ่าน tag engine เดิม (ไม่พึ่ง PLC push HTTP)
//   PLC เตรียม: tag ต่าง ๆ (eventType/carrier/station/time/param) + 1 tag "seq" (บวก +1 ทุก event ใหม่)
//   poll seq ต่อไลน์ → เปลี่ยน = อ่าน tag ตาม tagMap → ประกอบ raw[index] → manager.ingest (decode เดิม)
//   config.source: { mode:"tag", device, seqTag, tagMap:{ "<index>":"<tagName>" } }
//   (ring-buffer/handshake-ack = ส่วนขยายภายหลัง · seq-based กันซ้ำได้ด้วย event-sourcing)

class PlcSource {
  constructor({ engine, manager, intervalMs } = {}) {
    this.engine = engine; this.manager = manager;
    this.intervalMs = Number(intervalMs) || 1000;
    this._timer = null; this._lastSeq = {}; this._busy = false;
  }
  _tag(device, tag) {
    try { const v = this.engine && this.engine.getTagValue ? this.engine.getTagValue(device, tag) : null; return v ? v.value : null; }
    catch (_) { return null; }
  }
  // ไลน์ที่ผูก PLC แบบ tag (มี source.mode==='tag' + seqTag + tagMap)
  _tagLines() {
    return Object.values(this.manager.configs || {}).filter((c) => c.enabled && c.source && c.source.mode === 'tag' && c.source.seqTag && c.source.tagMap);
  }
  async _pollOnce() {
    if (this._busy || !this.engine) return; this._busy = true;
    try {
      for (const cfg of this._tagLines()) {
        const s = cfg.source;
        const seq = this._tag(s.device, s.seqTag);
        if (seq == null || seq === this._lastSeq[cfg.line]) continue;   // ไม่มี event ใหม่
        const first = this._lastSeq[cfg.line] === undefined;
        this._lastSeq[cfg.line] = seq;
        if (first) continue;   // ครั้งแรก = sync baseline (ไม่ยิงย้อนหลัง)
        const raw = [];
        for (const [idx, tag] of Object.entries(s.tagMap)) raw[Number(idx)] = this._tag(s.device, tag);
        try { await this.manager.ingest(cfg.line, raw); }
        catch (e) { console.error(`[lineRecorder/plc] ingest ${cfg.line}:`, e.message); }
      }
    } finally { this._busy = false; }
  }
  start() {
    if (this._timer) return;
    const n = this._tagLines().length;
    if (!n) { console.log('[lineRecorder/plc] ไม่มีไลน์ผูก PLC (source.mode=tag) — ข้าม'); return; }
    this._timer = setInterval(() => this._pollOnce().catch(() => {}), this.intervalMs);
    console.log(`[lineRecorder/plc] poll ${n} line(s) ทุก ${this.intervalMs}ms`);
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

module.exports = { PlcSource };
