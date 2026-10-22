// KPE SCADA — Remote access consent (R2) · ฝั่ง serverB ยินยอมให้ gateway (serverA) เข้าถึงไหม
//   serve.js (frontend public port) เรียก decide(clientIp) ก่อนรับ connection
//   gateway forward TCP ดิบ → serverB เห็น source IP = ของ serverA (gateway) → ใช้ allowlist + toggle คุม
//   หลักการ consent: ระบุ IP ของ gateway ที่ยอมรับ (allowGatewayIps) + toggle เปิด/ปิด
//     - IP ที่อยู่ใน allowlist: เปิด=ผ่าน · ปิด=บล็อก (ถอนความยินยอม)
//     - IP อื่น (local/direct บน networkB): ไม่กระทบ ทำงานปกติ
//   auth ของ user จัดการที่ access-gate ของ serverB เอง (gateway ไม่เพิ่มชั้น)
const fs = require('fs');
const path = require('path');

function normIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1').trim().toLowerCase();
}

class RemoteAccess {
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.cfg = { enabled: false, allowGatewayIps: [] };
    this._loaded = 0;
    this._ttl = opts.ttlMs != null ? opts.ttlMs : 2000;   // re-read ทุก 2s → toggle มีผลโดยไม่ restart
    this._logThrottle = new Map();                         // key=ip|reason → lastTs (กัน log ทุก request)
    this._throttleMs = opts.logThrottleMs != null ? opts.logThrottleMs : 30000;
  }
  _logFile() { return this.file ? path.join(path.dirname(this.file), 'remote-access.log') : null; }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cfg = {
        enabled: raw.enabled === true,
        allowGatewayIps: Array.isArray(raw.allowGatewayIps) ? raw.allowGatewayIps.map(String) : [],
      };
    } catch (_) { this.cfg = { enabled: false, allowGatewayIps: [] }; }
    this._loaded = Date.now();
    return this.cfg;
  }
  get(forceFresh) {
    if (forceFresh || !this._loaded || (Date.now() - this._loaded) > this._ttl) this.load();
    return this.cfg;
  }
  save(input) {
    const next = {
      enabled: !!(input && input.enabled),
      allowGatewayIps: (input && Array.isArray(input.allowGatewayIps))
        ? input.allowGatewayIps.map((s) => String(s).trim()).filter(Boolean) : [],
    };
    if (this.file) {
      const tmp = this.file + '.tmp';
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(tmp, this.file);   // atomic
    }
    this.cfg = next; this._loaded = Date.now();
    return next;
  }

  // ตัดสินว่า connection จาก clientIp อนุญาตไหม → { allow, reason }
  //   reason: direct | gateway-allowed | remote-disabled
  decide(clientIp) {
    const cfg = this.get();
    const ip = normIp(clientIp);
    const known = (cfg.allowGatewayIps || []).map(normIp);
    if (known.includes(ip)) {
      return cfg.enabled ? { allow: true, reason: 'gateway-allowed' } : { allow: false, reason: 'remote-disabled' };
    }
    return { allow: true, reason: 'direct' };   // ไม่ใช่ gateway ที่รู้จัก = ปกติ (ไม่กระทบ local)
  }

  // audit log การเข้าผ่าน gateway (R4) → <config>/remote-access.log (JSONL) · throttle ต่อ (ip|reason)
  logAccess(ip, decision) {
    const file = this._logFile(); if (!file) return;
    const key = `${normIp(ip)}|${decision.reason}`;
    const now = Date.now();
    if ((this._logThrottle.get(key) || 0) > now - this._throttleMs) return;
    this._logThrottle.set(key, now);
    try {
      const rec = { ts: new Date().toISOString(), ip: normIp(ip), reason: decision.reason, allow: !!decision.allow };
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (_) {}
  }
  // อ่าน log ล่าสุด (สำหรับ API/UI) — คืน array ของ entry ล่าสุด limit รายการ
  readLog(limit = 50) {
    const file = this._logFile(); if (!file) return [];
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).reverse();
    } catch (_) { return []; }
  }
}

module.exports = RemoteAccess;
module.exports.normIp = normIp;
