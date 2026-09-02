// usbMasterKey.js — โหมด B (§11): master key บน USB "ต้องเสียบตลอด"
//   ไฟล์ kpe-master.key บน USB = Ed25519-signed (reuse format/verify เดิม) + ผูก USB volume serial
//   - portable (floating): payload ไม่มี fp → เสียบเครื่องไหนก็รัน
//   - machine-locked: payload มี fp → ต้องตรงเครื่องด้วย
//   detect: สแกน removable drive หา kpe-master.key → verify (sig + usbSerial + fp? + exp)
//   DI ได้ทั้งหมด (driveScan/usbSerial/readFile) เพื่อเทสต์โดยไม่ต้องมี USB จริง
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonical } = require('./licenseManager');

const MASTER_FILE = 'kpe-master.key';

// removable drive roots ตาม platform (Windows: D..Z · mac/linux: /Volumes,/media,/mnt)
function defaultDriveScan() {
  if (process.platform === 'win32') {
    const out = [];
    for (let c = 68; c <= 90; c++) { const root = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(root)) out.push(root); } catch (_) {} }
    return out;
  }
  const out = [];
  for (const base of ['/Volumes', '/media', '/mnt']) {
    try { for (const n of fs.readdirSync(base)) out.push(path.join(base, n)); } catch (_) {}
  }
  return out;
}

// อ่าน USB volume serial ของ drive (Windows: VolumeSerialNumber ผ่าน wmic) — *nix คืน '' (override ผ่าน DI)
function defaultUsbSerial(root) {
  if (process.platform !== 'win32') return '';
  const m = /^([A-Za-z]):/.exec(root); if (!m) return '';
  try {
    const out = require('child_process').execSync(
      `wmic logicaldisk where "DeviceID='${m[1].toUpperCase()}:'" get VolumeSerialNumber`,
      { timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const lines = out.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
    return (lines.length >= 2 ? lines[lines.length - 1] : '').toLowerCase();
  } catch (_) { return ''; }
}

class UsbMasterKey {
  // { publicKey, machineFp, driveScan, usbSerial, readFile }
  constructor(opts = {}) {
    this._pub = opts.publicKey != null ? opts.publicKey : '';
    this._machineFp = (opts.machineFp || '').toString();        // fp เครื่องนี้ (สำหรับ machine-locked)
    this._driveScan = opts.driveScan || defaultDriveScan;
    this._usbSerial = opts.usbSerial || defaultUsbSerial;
    this._readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  }

  // หา master key บน USB ใด ๆ + verify → { ok, reason, scope, features, usbSerial, drive }
  //   reason: valid | no-usb | corrupt | no-pubkey | bad-signature | wrong-usb | wrong-machine | expired
  check() {
    const drives = this._driveScan() || [];
    let lastReason = 'no-usb';
    for (const root of drives) {
      let text;
      try { text = this._readFile(path.join(root, MASTER_FILE)); } catch (_) { continue; }   // drive นี้ไม่มีไฟล์
      const serial = (this._usbSerial(root) || '').toString().trim().toLowerCase();
      const r = this._verify(text, serial);
      if (r.ok) return { ...r, drive: root };
      lastReason = r.reason;
    }
    return { ok: false, reason: lastReason, scope: null, features: [] };
  }
  present() { return this.check().ok; }

  _verify(text, usbSerial) {
    let lic;
    try { lic = JSON.parse(Buffer.from(String(text).trim(), 'base64').toString('utf8')); }
    catch (_) { return { ok: false, reason: 'corrupt' }; }
    if (!this._pub) return { ok: false, reason: 'no-pubkey' };
    const { sig, ...payload } = lic || {};
    let sigOk = false;
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(this._pub, 'base64'), format: 'der', type: 'spki' });
      sigOk = !!sig && crypto.verify(null, Buffer.from(canonical(payload)), pub, Buffer.from(sig, 'base64'));
    } catch (_) { sigOk = false; }
    if (!sigOk) return { ok: false, reason: 'bad-signature' };
    // ผูก USB serial (copy ไป USB อื่น = serial ไม่ตรง)
    if (!lic.usbSerial || String(lic.usbSerial).trim().toLowerCase() !== usbSerial) return { ok: false, reason: 'wrong-usb' };
    // machine-locked: มี fp → ต้องตรงเครื่อง (portable = ไม่มี fp → ข้าม)
    if (lic.fp && this._machineFp && lic.fp !== this._machineFp) return { ok: false, reason: 'wrong-machine' };
    if (lic.exp && Date.now() > Date.parse(lic.exp)) return { ok: false, reason: 'expired' };
    const scope = (lic.scope === 'backend' || lic.scope === 'feature') ? lic.scope : 'base';
    return { ok: true, reason: 'valid', scope, features: Array.isArray(lic.features) ? lic.features : [], usbSerial, customer: lic.customer || '' };
  }
}

module.exports = UsbMasterKey;
module.exports.MASTER_FILE = MASTER_FILE;
module.exports.defaultDriveScan = defaultDriveScan;
module.exports.defaultUsbSerial = defaultUsbSerial;
