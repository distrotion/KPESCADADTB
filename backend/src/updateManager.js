// KPE SCADA — Self-update: verify library (U1 · ฝั่งผู้รับ B) · ดู docs/SELF-UPDATE-PLAN.md
//   หน้าที่ U1: ตรวจ bundle เท่านั้น (ลายเซ็น Ed25519 · hash ไฟล์ · version monotonic · platform) — ยังไม่ติดตั้ง
//   reuse: canonical JSON + Ed25519 (Node crypto) แบบเดียวกับ licenseManager (verify offline 100% · ไม่เพิ่ม native dep)
//   ⛔ กติกาเหล็ก: ไม่มีทาง "ยอมรับ bundle ไม่เซ็น" — ไม่มี pubkey = reject (armed) · pubkey ฝัง = pubkey เดียวกับ license
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonical, defaultPlatform } = require('./licenseManager');

// version 4 ส่วน "a.b.c.d" → array int (เทียบ monotonic) · ส่วนขาด = 0 · ไม่ใช่ตัวเลข = -1 (เก่ากว่าเสมอ)
function parseVer(v) {
  const p = String(v || '').trim().split('.').map((x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : -1; });
  while (p.length < 4) p.push(0);
  return p.slice(0, 4);
}
// cmp(a,b): >0 ถ้า a ใหม่กว่า b · =0 เท่ากัน · <0 เก่ากว่า
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 4; i++) { if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}

// ── whitelist: path (relative จาก root) ที่ update "ทับได้" — ทุกอย่างนอกนี้ = ปฏิเสธ ──
//   ⛔ ส่งแค่โค้ด: config/data/runtime/secret อยู่นอก whitelist → ต่อให้ bundle ปนมาก็เขียนทับไม่ได้ (defense-in-depth)
const WL_PREFIX = ['backend/', 'frontend/build/', 'manager/', 'tools/', 'installer/', 'docs/'];
const WL_FILE = new Set(['version.json', 'package.json', 'README.md', 'frontend/serve.js', 'frontend/pubspec.lock']);
const RUNTIME_FILE = new Set(['api-token.json', 'access-gate.json', 'branding.json', 'license.key',
  'line-recorder-instance.json', 'remote-sites.json', 'update-policy.json', 'update-targets.json']);
function allowedPath(rel) {
  rel = String(rel).replace(/\\/g, '/');
  if (rel.includes('..') || rel.startsWith('/')) return false;         // path traversal
  const base = rel.split('/').pop();
  if (RUNTIME_FILE.has(base)) return false;                            // runtime/secret เด็ดขาด (แม้อยู่ใน manager/)
  if (WL_FILE.has(rel)) return true;
  return WL_PREFIX.some((p) => rel.startsWith(p));
}

class UpdateManager {
  // opts (DI สำหรับเทส): { publicKey, platform, currentVersion, root, stateDir, restart, health, versionFile }
  constructor(opts = {}) {
    // pubkey เดียวกับ license (armed build ฝังไว้แล้ว) — inject ได้ตอนเทส
    this._publicKeyB64 = opts.publicKey != null ? opts.publicKey
      : (() => { try { return require('./licenseManager').EMBEDDED_PUBLIC_KEY_B64 || ''; } catch (_) { return ''; } })();
    this._platform = opts.platform || defaultPlatform();
    this._versionFile = opts.versionFile || path.join(__dirname, '..', '..', 'version.json');
    this._curVer = opts.currentVersion || this._readVersion();
    // ── install (U2) ──
    this._root = opts.root || null;                 // dir ที่จะอัปเดต (deploy root) · null = verify-only
    this._stateDir = opts.stateDir || (this._root ? path.join(this._root, 'updates') : null);
    this._restart = typeof opts.restart === 'function' ? opts.restart : async () => {};   // restart children → คืน void
    this._health = typeof opts.health === 'function' ? opts.health : async () => true;     // health check → bool
    this._policyFile = opts.policyFile || (this._stateDir ? path.join(this._stateDir, '..', 'update-policy.json') : null);
  }

  _readVersion() { try { return JSON.parse(fs.readFileSync(this._versionFile, 'utf8')).version || '0.0.0.0'; } catch (_) { return '0.0.0.0'; } }

  publicKeyB64() { return this._publicKeyB64; }
  platform() { return this._platform; }
  currentVersion() { return this._curVer; }

  // ── ตรวจลายเซ็น manifest (Ed25519 ของ canonical(manifest)) ──
  verifySignature(manifest, sigB64) {
    if (!this._publicKeyB64) return { ok: false, reason: 'no-pubkey' };   // armed build ต้องมี pubkey — ไม่มี = ปฏิเสธ (ไม่ใช่ปล่อยผ่าน)
    if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'bad-manifest' };
    if (!sigB64) return { ok: false, reason: 'no-signature' };
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(this._publicKeyB64, 'base64'), format: 'der', type: 'spki' });
      const ok = crypto.verify(null, Buffer.from(canonical(manifest)), pub, Buffer.from(sigB64, 'base64'));
      return ok ? { ok: true } : { ok: false, reason: 'bad-signature' };
    } catch (_) { return { ok: false, reason: 'bad-signature' }; }
  }

  // ── ตรวจ bundle ทั้งชุด (ยังไม่ติดตั้ง) → { ok, reason, version, platform, full, ... } ──
  //   opts: { allowDowngrade } (operator ติ๊กเองบนจอ B)
  check(manifest, sigB64, opts = {}) {
    const sig = this.verifySignature(manifest, sigB64);
    const version = manifest && manifest.version;
    const base = { version: version || null, platform: manifest && manifest.platform || null, full: !!(manifest && manifest.full) };
    if (!sig.ok) return { ok: false, reason: sig.reason, ...base };

    // (1) โครง manifest จำเป็น
    if (!version || parseVer(version).includes(-1)) return { ok: false, reason: 'bad-version', ...base };
    if (!manifest.files || typeof manifest.files !== 'object' || !Object.keys(manifest.files).length) return { ok: false, reason: 'no-files', ...base };

    // (2) platform ต้องตรงเครื่องนี้ (win-x64 ≠ linux-arm64 · JS ใช้ร่วมได้แต่ native deps ไม่ได้)
    if (manifest.platform && manifest.platform !== this._platform) return { ok: false, reason: 'wrong-platform', ...base, expected: this._platform };

    // (3) minFrom — release นี้ต้องมาจาก version ขั้นต่ำ (เช่นต้อง migration ก่อน)
    if (manifest.minFrom && cmpVer(this._curVer, manifest.minFrom) < 0) return { ok: false, reason: 'below-minfrom', ...base, minFrom: manifest.minFrom, current: this._curVer };

    // (4) version monotonic — ห้าม downgrade เว้น operator อนุญาต
    const d = cmpVer(version, this._curVer);
    if (d === 0) return { ok: false, reason: 'same-version', ...base, current: this._curVer };
    if (d < 0 && !opts.allowDowngrade) return { ok: false, reason: 'downgrade-blocked', ...base, current: this._curVer };

    return { ok: true, reason: d < 0 ? 'ok-downgrade' : 'ok', ...base, current: this._curVer, notes: manifest.notes || '' };
  }

  // ── ตรวจ hash ไฟล์จริงหลัง extract (dir = payload ที่แตกแล้ว) → { ok, reason, mismatch:[] } ──
  //   ใช้ก่อน swap (U2) · U1 มีไว้ให้ครบ + เทสได้
  verifyPayload(dir, manifest) {
    const files = (manifest && manifest.files) || {};
    const mismatch = [];
    for (const rel of Object.keys(files)) {
      const fp = path.join(dir, rel);
      let h = null;
      try { h = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); } catch (_) { h = null; }
      if (h !== files[rel]) mismatch.push(rel);
    }
    return { ok: mismatch.length === 0, reason: mismatch.length ? 'hash-mismatch' : 'ok', mismatch };
  }

  // ทุก path ใน manifest อยู่ใน whitelist ไหม → กัน bundle ปน path อันตราย (config/secret/traversal)
  unsafePaths(manifest) { return Object.keys((manifest && manifest.files) || {}).filter((r) => !allowedPath(r)); }

  // ════════════════ U2: install / state / rollback ════════════════
  // policy: { mode:'off'|'manual'|'auto', pairedFrom:[fingerprint...] } · default off
  policy() {
    try { const p = JSON.parse(fs.readFileSync(this._policyFile, 'utf8')); return { mode: ['manual', 'auto'].includes(p.mode) ? p.mode : 'off', pairedFrom: Array.isArray(p.pairedFrom) ? p.pairedFrom : [] }; }
    catch (_) { return { mode: 'off', pairedFrom: [] }; }
  }
  setPolicy(patch) {
    const cur = this.policy();
    const next = { mode: ['off', 'manual', 'auto'].includes(patch.mode) ? patch.mode : cur.mode, pairedFrom: patch.pairedFrom || cur.pairedFrom };
    fs.mkdirSync(path.dirname(this._policyFile), { recursive: true });
    fs.writeFileSync(this._policyFile, JSON.stringify(next, null, 2));
    return next;
  }

  noteRejected(reason, version) { return this._setState({ phase: 'rejected', reason, version: version || null }); }   // endpoint บันทึก reject ก่อนแตก tar เต็ม (#1)
  _stateFile() { return path.join(this._stateDir, 'state.json'); }
  getState() { try { return JSON.parse(fs.readFileSync(this._stateFile(), 'utf8')); } catch (_) { return { phase: 'idle', version: null }; } }
  _setState(s) { fs.mkdirSync(this._stateDir, { recursive: true }); fs.writeFileSync(this._stateFile(), JSON.stringify({ ...s, at: this._now() }, null, 2)); return s; }
  _now() { try { return new Date().toISOString(); } catch (_) { return ''; } }

  // รับ bundle ที่ extract แล้ว (dir มี manifest.json/manifest.sig/payload/) → verify + policy → install หรือค้าง consent
  //   from = fingerprint/ตัวระบุผู้ส่ง (A) · opts.allowDowngrade
  // resume ตอน boot — ถ้าเจอ state ค้างกลางติดตั้ง (ไฟดับ/ปิดเครื่อง) → ถอยกลับให้ปลอดภัย (#4)
  async checkResume() {
    const st = this.getState();
    if (['installing', 'restarting'].includes(st.phase)) {
      await this._restoreBackup(st.backupDir);
      return this._setState({ ...st, phase: 'rolled-back', reason: 'interrupted' });
    }
    return st;
  }

  async receiveExtracted(dir, { from = null, allowDowngrade = false, consented = false } = {}) {
    if (!this._root) throw new Error('updateManager: ไม่ได้ตั้ง root (verify-only)');
    if (this._busy) return { phase: 'rejected', reason: 'busy' };   // กันติดตั้งซ้อน (#2)
    let manifest, sig;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); sig = fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8'); }
    catch (_) { return this._setState({ phase: 'rejected', reason: 'bad-bundle', version: null }); }

    const chk = this.check(manifest, sig, { allowDowngrade });
    if (!chk.ok) return this._setState({ phase: 'rejected', reason: chk.reason, version: chk.version, detail: chk });

    const unsafe = this.unsafePaths(manifest);
    if (unsafe.length) return this._setState({ phase: 'rejected', reason: 'unsafe-path', version: chk.version, unsafe: unsafe.slice(0, 5) });

    const ph = this.verifyPayload(path.join(dir, 'payload'), manifest);
    if (!ph.ok) return this._setState({ phase: 'rejected', reason: 'hash-mismatch', version: chk.version, mismatch: ph.mismatch.slice(0, 5) });

    const pol = this.policy();
    // consented = อัปโหลดมือบนจอเครื่องนี้ (loopback) = ยืนยันในตัว → ข้าม policy gate + ติดตั้งเลย
    // (ด่านลายเซ็น/version/platform/hash/unsafe-path/busy ด้านบน ยังบังคับครบ)
    if (!consented) {
      if (pol.mode === 'off') return this._setState({ phase: 'rejected', reason: 'policy-off', version: chk.version });
      if (pol.mode === 'auto' && from && pol.pairedFrom.length && !pol.pairedFrom.includes(from)) return this._setState({ phase: 'rejected', reason: 'not-paired', version: chk.version });
    }

    // staging = payload ที่ verify แล้ว (ให้ install() ใช้) · เก็บ path ไว้ใน state
    const installNow = consented || pol.mode === 'auto';
    this._setState({ phase: installNow ? 'verified' : 'waiting-consent', version: chk.version, from, staging: path.join(dir, 'payload'), manifestFiles: Object.keys(manifest.files), notes: manifest.notes || '' });
    if (installNow) return this.install();
    return this.getState();   // manual → รอ approve()
  }

  async approve() {
    const st = this.getState();
    if (st.phase !== 'waiting-consent') return { ok: false, reason: 'not-waiting' };
    return this.install();
  }

  // backup → swap → restart → health → done | rollback
  async install() {
    if (this._busy) return { ok: false, reason: 'busy' };   // กันซ้อน (#2)
    const st = this.getState();
    if (!['verified', 'waiting-consent'].includes(st.phase)) return { ok: false, reason: 'bad-phase', phase: st.phase };
    const staging = st.staging; const files = st.manifestFiles || [];
    if (!staging || !fs.existsSync(staging)) return this._setState({ ...st, phase: 'rejected', reason: 'staging-missing' });
    this._busy = true;
    try { return await this._install(st, staging, files); } finally { this._busy = false; }
  }
  async _install(st, staging, files) {

    const backupDir = path.join(this._stateDir, 'backup', String(st.version).replace(/[^0-9A-Za-z._-]/g, '_'));
    this._setState({ ...st, phase: 'installing', backupDir });
    const newFiles = [];
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
      // 1) backup: ไฟล์เดิมที่จะโดนทับ (มีอยู่=copy · ไม่มี=จำไว้ลบตอน rollback)
      for (const rel of files) {
        if (!allowedPath(rel)) throw new Error('unsafe path หลุด verify: ' + rel);
        const cur = path.join(this._root, rel);
        if (fs.existsSync(cur)) { const b = path.join(backupDir, rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(cur, b); }
        else newFiles.push(rel);
      }
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, '_new.json'), JSON.stringify(newFiles));
      // 2) swap: payload → root
      for (const rel of files) {
        const dst = path.join(this._root, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(staging, rel), dst);
      }
    } catch (e) {
      // ล้มระหว่าง backup/swap → พยายาม rollback ทันที
      await this._restoreBackup(backupDir, newFiles);
      return this._setState({ ...st, phase: 'rolled-back', reason: 'swap-failed', error: e.message, backupDir });
    }

    // 3) restart children + health
    this._setState({ ...st, phase: 'restarting', backupDir });
    try { await this._restart(); } catch (_) {}
    let healthy = false;
    try { healthy = await this._health(); } catch (_) { healthy = false; }
    if (!healthy) {
      await this._restoreBackup(backupDir, newFiles);
      try { await this._restart(); } catch (_) {}
      return this._setState({ ...st, phase: 'rolled-back', reason: 'health-failed', backupDir });
    }
    // สำเร็จ — โค้ด Manager บนดิสก์ใหม่แล้ว (running ยังเก่า) → ต้อง restart Manager เอง (service/operator)
    return this._setState({ ...st, phase: 'done', from: st.from, backupDir, managerRestartPending: files.some((r) => r.startsWith('manager/')) });
  }

  async _restoreBackup(backupDir, newFilesHint) {
    if (!backupDir || !fs.existsSync(backupDir)) return false;
    let newFiles = newFilesHint || [];
    try { newFiles = JSON.parse(fs.readFileSync(path.join(backupDir, '_new.json'), 'utf8')); } catch (_) {}
    // คืนไฟล์ที่ backup ไว้
    const walk = (d, base = d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, base); else if (e.isFile() && path.relative(base, f) !== '_new.json') { const rel = path.relative(base, f); const dst = path.join(this._root, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(f, dst); } } };
    try { walk(backupDir); } catch (_) {}
    // ลบไฟล์ที่เป็นของใหม่ (ตอน swap สร้างขึ้น)
    for (const rel of newFiles) { try { fs.rmSync(path.join(this._root, rel), { force: true }); } catch (_) {} }
    return true;
  }

  // ถอยกลับ version ก่อนหน้า (manual · จาก backup ล่าสุด)
  async rollback() {
    const st = this.getState();
    const backupDir = st.backupDir;
    if (!backupDir || !fs.existsSync(backupDir)) return { ok: false, reason: 'no-backup' };
    await this._restoreBackup(backupDir);
    try { await this._restart(); } catch (_) {}
    this._setState({ phase: 'rolled-back', reason: 'manual', version: st.version, backupDir });
    return { ok: true };
  }
}

module.exports = UpdateManager;
module.exports.parseVer = parseVer;
module.exports.cmpVer = cmpVer;
