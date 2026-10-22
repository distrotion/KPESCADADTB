// visionManager.js — เมนู Vision (plugin-based) · จัดการ "แหล่งกล้อง" (sources) + allowlist host (กัน SSRF ตอน proxy)
//   KPE ไม่อ่านกล้องเอง — source แค่ชี้ว่ากล้องอยู่ที่ไหน (host:port HTTP + mqtt device ที่ ingest สถานะ)
//   source: { id, name, type, host, port, live?, gateId?, mqttDevice?, enabled }
//   ดู docs/VISION-INTEGRATION-PROMPT.md
const csv = require('./csvUtil');

function _slug(name, existing) {
  const base = String(name || 'cam').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'cam';
  let id = base, i = 2;
  while (existing.some((s) => s.id === id)) id = `${base}-${i++}`;
  return id;
}
function _int(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }

class VisionManager {
  constructor({ file } = {}) {
    this.file = file || csv.configFile('vision-sources.json');
    this.sources = this._load();
  }
  _load() { try { const j = JSON.parse(require('fs').readFileSync(this.file, 'utf8')); return Array.isArray(j) ? j : (j.sources || []); } catch (_) { return []; } }
  _save() { try { csv.writeJsonAtomic(this.file, this.sources); } catch (_) {} }

  list() { return this.sources.map((s) => ({ ...s })); }
  get(id) { return this.sources.find((s) => s.id === id) || null; }

  _norm(input, id) {
    return {
      id, name: String(input.name || input.host || 'กล้อง').trim(),
      type: String(input.type || 'face').trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || 'face',
      host: String(input.host || '').trim(),
      port: _int(input.port, 8099),
      live: String(input.live || '/'),                       // path หน้าเว็บภาพสด
      gateId: String(input.gateId || 'gate1').trim(),
      mqttDevice: input.mqttDevice ? String(input.mqttDevice).trim() : null,   // device id ที่ ingest MQTT ของกล้องนี้
      enabled: input.enabled !== false,
    };
  }
  add(input) {
    const s = this._norm(input, _slug(input.name || input.host, this.sources));
    if (!s.host) throw new Error('ต้องระบุ host (IP เครื่องกล้อง)');
    this.sources.push(s); this._save(); return s;
  }
  update(id, patch) {
    const s = this.get(id); if (!s) throw new Error('ไม่พบ source');
    const next = this._norm({ ...s, ...patch }, id);
    if (!next.host) throw new Error('ต้องระบุ host');
    Object.assign(s, next); this._save(); return s;
  }
  remove(id) { const i = this.sources.findIndex((s) => s.id === id); if (i < 0) return false; this.sources.splice(i, 1); this._save(); return true; }

  // base URL ของกล้อง (สำหรับ proxy/live) · null ถ้าไม่พบ
  baseUrl(id) { const s = this.get(id); return s && s.host ? `http://${s.host}:${s.port}` : null; }
  // host:port นี้อยู่ใน allowlist ไหม (source ใด ๆ) — กัน proxy ยิงมั่ว (SSRF)
  isAllowed(host, port) { return this.sources.some((s) => s.host === host && Number(s.port) === Number(port)); }
}

module.exports = VisionManager;
