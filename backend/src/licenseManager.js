// KPE SCADA — Licensing / anti-clone (Pi-only · USB activation) · Phase A core
//   ดู docs/LICENSING.md · verify ในเครื่อง 100% (offline · Ed25519 = Node crypto built-in · ไม่เพิ่ม native dep)
//   หลักการ: บังคับบน Pi เสมอ · Windows/Linux ที่เป็น "armed build" (ฝัง pubkey) = บังคับโดย default (dev ปิดด้วย KPE_DEV=1) · Mac = dev ไม่บังคับ
//     ผูก Pi serial → clone SD ไป Pi อื่น = serial ใหม่ = fp ไม่ตรง = ไม่ผ่าน
//   dependency-inject ได้ (isPi/machineId/publicKey/licenseFile) → เทสต์ mock Pi โดยไม่ต้องรันบน Pi จริง
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── public key (Ed25519 · base64 ของ SPKI DER) — ฝังในโค้ด (ไม่ลับ · ใช้ verify เท่านั้น) ──
//   ✅ ARMED — ฝังด้วย vendor kit (genkeys --embed) · private key คู่กันอยู่บน USB ออฟไลน์ (ห้าม commit/บน Pi)
//   ว่าง = ยังไม่ arm (no-pubkey → ไม่บล็อก) · re-arm = genkeys --embed ใหม่ (license เก่าใช้ไม่ได้)
const EMBEDDED_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA6Op41HiKu7dfQyUgQBB6i2Tm9sIWhXRi8RQDrS5rXLs=';

// JSON canonical (sort key recursive · ไม่มี whitespace) — signer + verifier ต้องได้ string เดียวกัน
function canonical(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj === undefined ? null : obj);
}

// ── ตรวจว่าเป็น Raspberry Pi (default impl · inject override ได้) ──
function defaultIsPi() {
  try {
    const model = fs.readFileSync('/sys/firmware/devicetree/base/model', 'utf8');
    if (/raspberry pi/i.test(model)) return true;
  } catch (_) {}
  try { fs.accessSync('/sys/firmware/devicetree/base/serial-number'); return true; } catch (_) {}
  return false;
}

// ── platform ของเครื่อง: 'pi' | 'win' | 'linux' | 'mac' | 'other' (Pi ชนะ Linux) ──
function defaultPlatform() {
  if (defaultIsPi()) return 'pi';
  switch (process.platform) {
    case 'win32': return 'win';
    case 'linux': return 'linux';
    case 'darwin': return 'mac';
    default: return 'other';
  }
}

// ── อ่าน serial ของ Pi (fallback /proc/cpuinfo 'Serial') → strip null/space, lowercase ──
function defaultMachineIdPi() {
  try {
    const s = fs.readFileSync('/sys/firmware/devicetree/base/serial-number', 'utf8');
    const clean = s.replace(/\0/g, '').trim().toLowerCase();
    if (clean) return clean;
  } catch (_) {}
  try {
    const cpu = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m = cpu.match(/^Serial\s*:\s*(\S+)/im);
    if (m) return m[1].trim().toLowerCase();
  } catch (_) {}
  return '';
}

// ── Windows machine-id: SMBIOS UUID (wmic→PowerShell fallback) · ถ้าขยะ → baseboard serial · cache ──
let _winIdCache;
function _runWin(cmd) {
  try { return require('child_process').execSync(cmd, { timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (_) { return ''; }
}
function _pickWmicValue(out) {   // wmic คืน 2 บรรทัด: header + ค่า → เอาบรรทัดที่ไม่ใช่ header
  const lines = String(out).replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length >= 2 ? lines[lines.length - 1] : '';
}
function _badUuid(v) { return !v || /^0{8}-/.test(v) || /^f{8}-f{4}/i.test(v); }   // ว่าง/ศูนย์ล้วน/FFFF = ไม่ใช้
function defaultMachineIdWin() {
  if (_winIdCache !== undefined) return _winIdCache;
  let id = _pickWmicValue(_runWin('wmic csproduct get uuid'));
  if (_badUuid(id)) id = (_runWin('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"').trim());
  if (_badUuid(id)) id = _pickWmicValue(_runWin('wmic baseboard get serialnumber'));   // fallback baseboard
  _winIdCache = (id || '').trim().toLowerCase();
  return _winIdCache;
}

// ── Linux (non-Pi) machine-id: DMI product_uuid (fallback board_serial) — เผื่ออนาคต ──
function defaultMachineIdLinux() {
  for (const p of ['/sys/class/dmi/id/product_uuid', '/sys/class/dmi/id/board_serial']) {
    try { const v = fs.readFileSync(p, 'utf8').trim().toLowerCase(); if (v && !_badUuid(v)) return v; } catch (_) {}
  }
  return '';
}

// ── dispatcher: machine-id ตาม platform (Pi serial / Win UUID / Linux DMI / อื่น = ว่าง) ──
function defaultMachineId() {
  switch (defaultPlatform()) {
    case 'pi': return defaultMachineIdPi();
    case 'win': return defaultMachineIdWin();
    case 'linux': return defaultMachineIdLinux();
    default: return '';
  }
}

class LicenseManager {
  // opts (test/DI): { isPi, platform, enforce, machineId, publicKey, licenseFile }
  //   platform: 'pi'|'win'|'linux'|'mac'|'other' (override) · enforce: bool (override · ข้าม policy)
  constructor(opts = {}) {
    this._isPiFn = opts.isPi || defaultIsPi;
    this._platformOverride = opts.platform != null ? opts.platform : null;
    this._enforceOverride = opts.enforce != null ? !!opts.enforce : null;
    this._machineIdFn = opts.machineId || defaultMachineId;
    this._publicKeyB64 = opts.publicKey != null ? opts.publicKey : EMBEDDED_PUBLIC_KEY_B64;
    this._licenseFile = opts.licenseFile || null;   // ตั้งทีหลังได้ผ่าน setLicenseFile (server.js ใช้ csvUtil)
    this._licensesDir = opts.licensesDir || null;   // โฟลเดอร์ license เสริม (stack) · default = <dir ของ license.key>/licenses
    this._cache = null;   // ผลลัพธ์ verify ล่าสุด (เรียกหลาย API ไม่ต้อง re-verify)
  }

  // platform ของเครื่องนี้ · ถ้า inject isPi:true (legacy/test) → 'pi'
  platform() {
    if (this._platformOverride) return this._platformOverride;
    if (this._isPiFn !== defaultIsPi && this._isPiFn()) return 'pi';   // legacy inject isPi
    return defaultPlatform();
  }

  // บังคับ license บนเครื่องนี้ไหม:
  //   pi               = เสมอ
  //   win/linux        = "armed" (มี pubkey ฝัง) → บังคับ "เสมอ" (ลูกค้า set KPE_DEV=1 bypass ไม่ได้)
  //                      KPE_DEV=1 ปิดได้เฉพาะ build ที่ "ยังไม่ arm" (dev จริง) · KPE_ENFORCE=1 ยัง force ได้
  //                      ไม่ armed = ยังไม่ arm → ไม่บังคับ (ปลอดภัยตอน rollout)
  //   mac/other        = ไม่ (เครื่อง dev)
  //   ⚠️ เจตนา: enforce ต้องไม่พึ่ง flag ที่ launcher/ลูกค้า ตั้งได้ (start_windows.bat ไม่ตั้ง KPE_ENFORCE · armed ไม่ฟัง KPE_DEV)
  //      ไม่งั้นรัน node ตรง ๆ + set env = เลี่ยง gate ได้ · armed-always ปิดช่องนั้น (รู #1)
  isEnforced() {
    if (this._enforceOverride != null) return this._enforceOverride;
    const p = this.platform();
    if (p === 'pi') return true;
    if (p === 'win' || p === 'linux') {
      if (process.env.KPE_ENFORCE === '1') return true;    // force ชัดเจน (legacy / Manager)
      if (this._publicKeyB64) return true;                 // armed build → บังคับเสมอ (ไม่ฟัง KPE_DEV — กันลูกค้า set env bypass · รู #1)
      if (process.env.KPE_DEV === '1') return false;       // dev opt-out เฉพาะ build ที่ยังไม่ arm
      return false;                                         // ไม่ armed + ไม่ force = ไม่บังคับ (rollout-safe)
    }
    return false;
  }

  setLicenseFile(p) { this._licenseFile = p; this._cache = null; }
  refresh() { this._cache = null; return this.verify(); }   // re-verify สด (hot-swap: เพิ่ม/ถอด license ไม่ต้อง restart)
  licenseFile() {
    if (this._licenseFile) return this._licenseFile;
    try { return require('./csvUtil').configFile('license.key'); } catch (_) { return null; }
  }
  // โฟลเดอร์ license เสริม (stack add-on) — default = <dir ของ license.key>/licenses
  licensesDir() {
    if (this._licensesDir) return this._licensesDir;
    const f = this.licenseFile();
    return f ? path.join(path.dirname(f), 'licenses') : null;
  }
  // รวมข้อความ license ทุกใบ: legacy license.key + licenses/*.key (stack) — คืน [text]
  _collectLicenses() {
    const out = [];
    try { const f = this.licenseFile(); if (f && fs.existsSync(f)) out.push(fs.readFileSync(f, 'utf8')); } catch (_) {}
    try {
      const d = this.licensesDir();
      if (d && fs.existsSync(d)) {
        for (const name of fs.readdirSync(d).sort()) {
          if (!/\.key$/i.test(name)) continue;
          try { out.push(fs.readFileSync(path.join(d, name), 'utf8')); } catch (_) {}
        }
      }
    } catch (_) {}
    return out;
  }

  publicKeyB64() { return this._publicKeyB64; }   // embedded pubkey (ให้ usbMasterKey verify master key)
  isPi() { return !!this._isPiFn(); }
  machineId() { return (this._machineIdFn() || '').toString(); }
  // fingerprint เต็ม = sha256(serial) hex 64 ตัว — ใช้ใน license.fp + ให้ vendor เซ็น (ผ่าน --show-id)
  fingerprint() { return crypto.createHash('sha256').update(this.machineId()).digest('hex'); }
  // โชว์ผู้ใช้ = 16 hex แรกของ fingerprint (อ่านง่าย · ระบุเครื่อง)
  machineIdShort() { return this.fingerprint().slice(0, 16); }

  // verify license (stack หลายใบ → union grants) → { ok, reason, tier, features, ... }
  //   reason: not-enforced|valid|no-license|corrupt|no-pubkey|bad-signature|wrong-machine|expired|no-base
  //   tier: 'base'|'backend'|null (สูงสุดของใบ valid) · features: union (active เฉพาะ tier=base · L3 ต้องมี L2)
  verify() {
    const platform = this.platform();
    // ไม่ enforced (mac/dev/win-linux ที่ไม่มี flag) → ข้ามเช็ค รันปกติ (ตัดปัญหา dev-bypass · เหมือน Pi-only เดิม)
    if (!this.isEnforced()) {
      return (this._cache = { ok: true, reason: 'not-enforced', enforced: false, platform, isPi: this.isPi(), tier: 'base', edition: 'base', features: [], maxLines: 9999, machineId: '', fingerprint: '', customer: '' });
    }
    const meta = { enforced: true, platform, isPi: this.isPi(), machineId: this.machineIdShort(), fingerprint: this.fingerprint(), customer: '' };
    const texts = this._collectLicenses();
    if (texts.length === 0) return (this._cache = { ok: false, reason: 'no-license', tier: null, features: [], ...meta });

    const results = texts.map((t) => this._verifyRaw(t));
    const valid = results.filter((r) => r.ok);
    if (valid.length === 0) {
      // ทุกใบ fail → ถ้าทั้งหมด no-pubkey (ยังไม่ arm) = no-pubkey (ไม่บล็อก) · ไม่งั้นเอา reason ที่ไม่ใช่ no-pubkey
      const reasons = results.map((r) => r.reason);
      const reason = reasons.every((x) => x === 'no-pubkey') ? 'no-pubkey' : (reasons.find((x) => x !== 'no-pubkey') || reasons[0]);
      return (this._cache = { ok: false, reason, tier: null, features: [], ...meta });
    }
    // tier สูงสุด (base > linerec > backend) · DLC ต้องมีฐานก่อน (no-base)
    const tiers = valid.map((r) => r.scope === 'backend' ? 'backend' : r.scope === 'linerec' ? 'linerec' : (r.scope === 'feature' ? null : 'base'));
    const tier = tiers.includes('base') ? 'base' : tiers.includes('linerec') ? 'linerec' : tiers.includes('backend') ? 'backend' : null;
    if (!tier) return (this._cache = { ok: false, reason: 'no-base', tier: null, edition: null, features: [], maxLines: 0, ...meta });   // มีแต่ใบ feature ไม่มีฐาน
    const features = tier === 'base' ? [...new Set(valid.flatMap((r) => Array.isArray(r.features) ? r.features : []))] : [];   // general DLC (chem-store ฯลฯ) active เฉพาะ base
    // DLClr (จำนวนไลน์ Line Recorder): active บน base หรือ linerec (line record set) · ใบ line-pack replace ใบเดียว → เอาค่ามากสุด (กัน edge) · ไม่มี = 1
    const maxLines = (tier === 'base' || tier === 'linerec') ? Math.max(1, ...valid.map((r) => Number.isFinite(r.lines) ? r.lines : 0)) : 1;
    const first = valid[0];
    // sig ของใบ "ฐาน" (ตาม tier) → ใช้ derive instance-lock port · add-on (feature/line-pack) ไม่เปลี่ยน = port นิ่ง
    const scopeToTier = (r) => r.scope === 'backend' ? 'backend' : r.scope === 'linerec' ? 'linerec' : (r.scope === 'feature' ? null : 'base');
    const tierLic = valid.find((r) => scopeToTier(r) === tier) || first;
    return (this._cache = { ok: true, reason: 'valid', tier, edition: tier, features, maxLines, _lockSig: tierLic.sig || '', ...meta, customer: first.customer || '', issued: first.issued || null, exp: first.exp || null });
  }

  // ตรวจ license string (base64) เทียบเครื่องนี้ — สมมติ enforced แล้ว · ไม่อ่าน/เขียนไฟล์ (ใช้ทั้ง verify + install candidate)
  _verifyRaw(raw) {
    const base = { enforced: true, platform: this.platform(), isPi: this.isPi(), machineId: this.machineIdShort(), fingerprint: this.fingerprint(), customer: '' };
    let lic;
    try { lic = JSON.parse(Buffer.from(String(raw).trim(), 'base64').toString('utf8')); }
    catch (_) { return { ok: false, reason: 'corrupt', ...base }; }
    base.customer = (lic && lic.customer) || '';

    if (!this._publicKeyB64) return { ok: false, reason: 'no-pubkey', ...base };

    // (1) ลายเซ็น Ed25519 ถูกด้วย public key ที่ฝัง
    const { sig, ...payload } = lic || {};
    let sigOk = false;
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(this._publicKeyB64, 'base64'), format: 'der', type: 'spki' });
      sigOk = !!sig && crypto.verify(null, Buffer.from(canonical(payload)), pub, Buffer.from(sig, 'base64'));
    } catch (_) { sigOk = false; }
    if (!sigOk) return { ok: false, reason: 'bad-signature', ...base };

    // (2) fp ตรง serial เครื่องนี้ (clone ไป Pi อื่น = fp ไม่ตรง)
    if (lic.fp !== base.fingerprint) return { ok: false, reason: 'wrong-machine', ...base };

    // (3) exp — perpetual (null) ข้าม
    if (lic.exp && Date.now() > Date.parse(lic.exp)) return { ok: false, reason: 'expired', ...base, exp: lic.exp };

    // scope (v2): 'backend'|'base'|'feature' · v1/ไม่มี = 'base' (ของเก่าได้ base เต็ม)
    const scope = ['backend', 'feature', 'linerec'].includes(lic.scope) ? lic.scope : 'base';
    const lines = (Number.isFinite(+lic.lines) && +lic.lines > 0) ? Math.floor(+lic.lines) : null;   // DLClr: จำนวนไลน์ในใบ (line-pack)
    return { ok: true, reason: 'valid', ...base, scope, lines, sig: String(sig || ''), issued: lic.issued || null, exp: lic.exp || null, features: Array.isArray(lic.features) ? lic.features : [] };
  }

  // log ทุกครั้งที่ register/activate/deactivate → <config>/license-activations.log (JSONL · per-machine · append · audit)
  _logActivation(res, event) {
    try {
      const file = this.licenseFile(); if (!file) return;
      const rec = {
        ts: new Date().toISOString(), event: event || 'activate',
        serial: this.machineId(), fingerprint: this.fingerprint(), machineId: this.machineIdShort(),
        customer: (res && res.customer) || '', ok: !!(res && res.ok), reason: (res && res.reason) || '',
      };
      fs.appendFileSync(path.join(path.dirname(file), 'license-activations.log'), JSON.stringify(rec) + '\n');
    } catch (_) {}
  }

  // ── Instance lock: 1 ใบ license = 1 instance ที่รันได้บนเครื่องเดียว ───────────
  //   ผูก TCP port บน 127.0.0.1 ที่ derive จาก "ลายเซ็นใบฐาน" → instance ที่ 2 (copy โฟลเดอร์ ใบเดียวกัน)
  //   bind ไม่ได้ (EADDRINUSE) = ถือว่า license ถูกใช้อยู่ · ใบต่างกัน = port ต่างกัน (ซื้อ 2 ใบรัน 2 instance ได้)
  //   process ตาย = OS ปล่อย port เอง (ไม่มี stale lock · ไม่ต้อง heartbeat) · dep-inject net/portFn ได้ (เทส)
  _lockPort() {
    const sig = (this._cache && this._cache._lockSig) || '';
    if (!sig) return null;
    const h = crypto.createHash('sha256').update('kpe-lock|' + sig).digest();
    return 41000 + (h.readUInt32BE(0) % 20000);   // 41000..60999 (เลี่ยง port ระบบ/แอป)
  }
  // ยึด lock ตอน start (เรียกครั้งเดียวจาก backend) → { held, port, reason }
  async acquireInstanceLock(net) {
    if (this._instanceLock && (this._instanceLock.held || this._instanceLock.skipped)) return this._instanceLock;   // สำเร็จแล้ว = idempotent · ล้มเหลว = ให้ลองใหม่ได้ (instance เก่าตาย)
    if (!this._cache) this.verify();
    const c = this._cache || {};   // ใช้ raw validity (ไม่ใช่ status ที่รวม lock แล้ว = feedback loop)
    if (!c.enforced || !c.ok) return (this._instanceLock = { held: true, skipped: true, port: null });   // dev/ใบ invalid → ไม่ต้องล็อก (gate อื่นจัดการ)
    const port = this._lockPort();
    if (!port) return (this._instanceLock = { held: true, skipped: true, port: null });
    const netMod = net || require('net');
    return await new Promise((resolve) => {
      const srv = netMod.createServer((s) => { try { s.end('kpe-license-lock'); } catch (_) {} });
      srv.once('error', (e) => resolve(this._instanceLock = { held: false, port, reason: e && e.code === 'EADDRINUSE' ? 'license-in-use' : 'lock-error' }));
      srv.listen(port, '127.0.0.1', () => { try { srv.unref(); } catch (_) {} this._lockSrv = srv; resolve(this._instanceLock = { held: true, port }); });
    });
  }
  releaseInstanceLock() { try { this._lockSrv && this._lockSrv.close(); } catch (_) {} this._lockSrv = null; this._instanceLock = null; }
  instanceLocked() { return !!(this._instanceLock && this._instanceLock.held === false); }   // ใบถูกใช้โดย instance อื่น

  // นโยบาย gate (ใช้ทั้ง Manager + backend) — บล็อกเฉพาะ enforced + invalid + "armed" (มี pubkey ฝัง)
  //   not-enforced (mac/dev/win-linux ไม่มี flag) → ไม่บล็อก · no-pubkey (ยังไม่ฝัง key) = ยังไม่ arm → ไม่บล็อก (ปลอดภัยตอน rollout)
  //   + instance-lock: ใบถูกใช้โดย instance อื่นบนเครื่องนี้ = บล็อก (license-in-use)
  blocked() {
    const st = this.status();
    return !!(st.enforced && !st.ok && st.reason !== 'no-pubkey');
  }

  // ผล verify (cache) — ใช้ใน gate/API · force=true เพื่อ re-verify (หลัง install)
  status(force) {
    if (force || !this._cache) this.verify();
    const c = this._cache || {};
    const locked = this.instanceLocked();   // ใบซ้ำ instance อื่น → present เป็น blocked
    return { ok: !!c.ok && !locked, reason: locked ? 'license-in-use' : (c.reason || ''), enforced: !!c.enforced, platform: c.platform || this.platform(), isPi: !!c.isPi, tier: c.tier || null, edition: c.edition || c.tier || null, features: c.features || [], maxLines: c.maxLines != null ? c.maxLines : 1, machineId: c.machineId || '', fingerprint: c.fingerprint || '', customer: c.customer || '', exp: c.exp || null, lockPort: (this._instanceLock && this._instanceLock.port) || null };
  }

  // ── grant (3-tier · §10) ────────────────────────────────────────────────────
  tier() { return this.status().tier; }                                  // 'base'|'backend'|null
  grants() { const s = this.status(); return { tier: s.tier, features: s.features }; }
  hasFeature(name) { const s = this.status(); return s.tier === 'base' && (s.features || []).includes(name); }
  // ฟีเจอร์พรีเมียมเข้าถึงได้ไหม: ไม่ enforced (dev) = ได้หมด · enforced = ต้องมี base + feature นั้น
  featureAllowed(name) { return !this.isEnforced() || this.hasFeature(name); }
  // จำนวนไลน์ Line Recorder สูงสุด (DLClr) — not-enforced(dev)=ไม่จำกัด · base/linerec=1+ใบ line-pack · อื่น=1
  maxLines() { const s = this.status(); return s.maxLines != null ? s.maxLines : 1; }
  edition() { return this.status().edition; }   // base | linerec | backend | null
  // front HMI ถูกล็อกไหม (tier=backend → backend รัน แต่ front lock) — enforced เท่านั้น
  frontLocked() { return this.isEnforced() && this.status().tier === 'backend'; }

  // ติดตั้ง license (base64 จาก USB/upload) → validate โครงสร้าง → เขียนไฟล์ atomic → verify ใหม่
  install(b64) {
    const text = (b64 || '').toString().trim();
    let lic;
    try { lic = JSON.parse(Buffer.from(text, 'base64').toString('utf8')); }
    catch (_) { return { ...this.status(), ok: false, reason: 'corrupt' }; }
    if (!lic || typeof lic !== 'object' || !lic.sig || !lic.fp) {
      return { ...this.status(), ok: false, reason: 'corrupt' };
    }
    // กันทับ license ดีเดิมด้วยตัวเสีย: enforced → verify candidate ก่อนเขียน (not-enforced/dev → เขียนได้เลย)
    if (this.isEnforced()) {
      const cand = this._verifyRaw(text);
      if (!cand.ok) { this._logActivation(cand); return { ...this.status(), ok: false, reason: cand.reason }; }
    }
    const file = this.licenseFile();
    if (!file) return { ...this.status(), ok: false, reason: 'no-path' };
    try {
      try { require('./csvUtil').writeFileAtomic(file, text + '\n'); }
      catch (_) { fs.writeFileSync(file, text + '\n'); }
    } catch (e) { return { ...this.status(), ok: false, reason: 'write-failed', error: e.message }; }
    this._cache = null;
    const out = this.status(true);
    this._logActivation(out);   // register สำเร็จ → เก็บ log (serial + เวลา + customer)
    return out;
  }

  // [DLC] เพิ่มใบ add-on แบบ stack — เขียนลง licenses/*.key (union กับ Base · ไม่ทับ license.key)
  //   ใบต้อง valid + fp ตรงเครื่องนี้ · ตั้งชื่อไฟล์จาก features (กันซ้ำ feature เดิม) → activate DLC โดยไม่แตะ Base
  installAddon(b64) {
    const text = (b64 || '').toString().trim();
    let lic;
    try { lic = JSON.parse(Buffer.from(text, 'base64').toString('utf8')); }
    catch (_) { return { ...this.status(), ok: false, reason: 'corrupt' }; }
    if (!lic || typeof lic !== 'object' || !lic.sig || !lic.fp) return { ...this.status(), ok: false, reason: 'corrupt' };
    const cand = this._verifyRaw(text);                    // ใบ add-on ต้อง valid + fp ตรง (เซ็นถูก) เสมอ
    if (!cand.ok) { this._logActivation(cand); return { ...this.status(), ok: false, reason: cand.reason }; }
    const dir = this.licensesDir();
    if (!dir) return { ...this.status(), ok: false, reason: 'no-path' };
    const feats = (Array.isArray(cand.features) && cand.features.length) ? cand.features.join('-').replace(/[^A-Za-z0-9_-]/g, '') : ('addon-' + Date.now());
    const file = path.join(dir, `${feats}.key`.slice(0, 120));
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { require('./csvUtil').writeFileAtomic(file, text + '\n'); }
      catch (_) { fs.writeFileSync(file, text + '\n'); }
    } catch (e) { return { ...this.status(), ok: false, reason: 'write-failed', error: e.message }; }
    this._cache = null;
    const out = this.status(true);
    this._logActivation(out);
    return out;
  }

  // ถอด license ออกจากเครื่องนี้ (ลบไฟล์ · backup ไว้กู้คืนได้) → re-verify (Pi+armed = กลับเป็น blocked) + log
  remove() {
    const file = this.licenseFile();
    let removed = false;
    if (file && fs.existsSync(file)) {
      try {
        try { fs.renameSync(file, `${file}.removed-${Date.now()}`); }   // backup ไม่ลบทิ้ง
        catch (_) { fs.unlinkSync(file); }
        removed = true;
      } catch (e) { return { ...this.status(true), removed: false, reason: 'remove-failed', error: e.message }; }
    }
    this._cache = null;
    const out = this.status(true);
    if (removed) this._logActivation(out, 'deactivate');   // audit: ถอดเมื่อไร เครื่องไหน
    return { ...out, removed };
  }
}

module.exports = LicenseManager;
module.exports.canonical = canonical;
module.exports.defaultIsPi = defaultIsPi;
module.exports.defaultPlatform = defaultPlatform;
module.exports.defaultMachineId = defaultMachineId;
