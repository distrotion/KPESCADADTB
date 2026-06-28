const express = require('express');
const { spawn, exec } = require('child_process');
const net    = require('net');
const path   = require('path');
const http   = require('http');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const app    = express();
const server = http.createServer(app);
const ROOT   = path.resolve(__dirname, '..');
const bus    = new EventEmitter();
bus.setMaxListeners(50);

// crash guard (B5) — Manager เป็นตัวคุม service ทั้งหมด ห้ามล้มจาก error เดี่ยว → log แล้วไปต่อ
// stdout/stderr พัง (เปิดจาก terminal แล้วปิดหน้าต่าง ฯลฯ) → กลืนเงียบ กัน EPIPE วนใน handler
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (err) => console.error('[manager][uncaughtException]', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (r) => console.error('[manager][unhandledRejection]', r && r.message ? r.message : r));

// ── ที่เก็บ config ของ Manager (installer-safe) ───────────────────────────────────
//   KPE_DATA_DIR (installer/Setup ตั้ง · เขียนได้) > __dirname (dev: ข้าง source)
//   ⚠️ installer-first: บนตัวติดตั้ง dir แอปมัก read-only → ต้องเขียนใต้ data dir
//   อ่าน: ลองที่ใหม่ก่อน · ไม่มี → migrate จากที่เก่า (ข้าง source) อัตโนมัติ
function mgrCfgFile(name) {
  const base = process.env.KPE_DATA_DIR;
  // ใช้ subdir 'config/manager/' แยกจาก backend (csvUtil เขียน config/ เดียวกัน) — กันไฟล์ชื่อซ้ำชนกัน
  if (base) { const dir = path.join(base, 'config', 'manager'); try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} return path.join(dir, name); }
  return path.join(__dirname, name);
}
function mgrReadCfg(name) {
  const target = mgrCfgFile(name);
  try { if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) {}
  const legacy = path.join(__dirname, name);          // migrate จากข้าง source (dev/อัปเกรด)
  if (legacy !== target) { try { if (fs.existsSync(legacy)) return JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch (_) {} }
  return null;
}
// เขียน JSON แบบ atomic (tmp+rename) — กัน config พังตอนไฟดับ/ครึ่งไฟล์ (B3) · opts.mode = perm (เช่น 0o600)
function mgrWriteJson(file, obj, opts) {
  const dir = path.dirname(file);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const tmp = `${file}.tmp`;
  const mode = opts && opts.mode;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), mode ? { mode } : undefined);
  if (mode) { try { fs.chmodSync(tmp, mode); } catch (_) {} }
  fs.renameSync(tmp, file);
}

// ── API token (Manager เป็นเจ้าของ) — แชร์ให้ backend+serve+deploy ผ่าน env KPE_API_TOKEN ──
//   token "ตายตัว" · toggle เปิด/ปิด · reset ได้ · เก็บ api-token.json (perm 0600, installer-safe)
//   enabled=false → ไม่ส่ง env → ไม่มีใคร enforce (เริ่มต้นปิด ตามที่เลือก)
function _genToken() { return crypto.randomBytes(32).toString('hex'); }     // 64 hex
function readApiToken() {
  const r = mgrReadCfg('api-token.json');
  if (r && typeof r.token === 'string' && r.token) return { token: r.token, enabled: r.enabled === true };
  // ครั้งแรก/ไฟล์พัง → gen token ใหม่ (ยังไม่เปิด)
  const fresh = { token: _genToken(), enabled: false };
  writeApiToken(fresh);
  return fresh;
}
function writeApiToken(obj) {
  try { mgrWriteJson(mgrCfgFile('api-token.json'), obj, { mode: 0o600 }); } catch (e) { console.error('[token] save error:', e.message); }
}
function maskToken(t) { return t && t.length > 10 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••'; }
// เทียบแบบ constant-time (กัน timing attack)
function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}
function bearerOf(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-token'] || '');
}
// Manager login-gate session token — header (UI fetch) หรือ query (EventSource ตั้ง header ไม่ได้)
function gateTokenOf(req) {
  return req.headers['x-gate-token'] || (req.query && req.query.gate) || '';
}
function isLoopback(req) {
  const ip = req.socket && req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ── Platform helpers (cross-platform Mac / Windows / Linux) ────────────────────
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME   = os.homedir();

// เปิด URL ในเบราว์เซอร์ default ของแต่ละ OS
function openBrowser(url) {
  const cmd = IS_WIN ? `start "" "${url}"` : IS_MAC ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// exec แบบ promise — คืน { ok, out } (รวม stdout+stderr)
function sh(command, timeout = 8000) {
  return new Promise(resolve => {
    exec(command, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

// หา full path ของ command ใน PATH (which / where)
function findInPath(name) {
  return new Promise(resolve => {
    const cmd = IS_WIN ? `where ${name}` : `command -v ${name}`;
    exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = (stdout || '').trim().split(/\r?\n/)[0];
      resolve(first || null);
    });
  });
}

// เทียบเวอร์ชันแบบ semver — คืน 1 ถ้า a>b, -1 ถ้า a<b, 0 ถ้าเท่ากัน
function cmpVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ── Version (version.json ที่ repo root · stamp อัตโนมัติทุก commit · ดู tools/stamp-version.js) ──
const VERSION_FILE = path.join(__dirname, '..', 'version.json');
function readVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch (_) { return null; }
}

// ── Ports (resolver กลาง: env > ports.json > default · ส่งต่อให้ลูกอัตโนมัติ) ──────────
const portsMod = require('../ports.js');
const _ports = portsMod.ports();
const PORTS = { frontend: _ports.frontend, backend: _ports.backend, manager: _ports.manager, deploy: _ports.deploy };
const BACKEND_HOST = _ports.backendHost;

// ── License gate (Pi-only anti-clone · ดู docs/LICENSING.md) — Manager = จุดบังคับหลัก: invalid → ไม่ spawn ลูก ──
//   นโยบาย rollout: non-Pi (Mac/Win/dev) = not-pi → ไม่บล็อก · no-pubkey (Phase A ยังไม่ฝัง key) = ยังไม่ arm → ไม่บล็อก
const LicenseManager = require('../backend/src/licenseManager');
const license = new LicenseManager();
try { license.setLicenseFile(require('../backend/src/csvUtil').configFile('license.key')); } catch (_) {}
// ── โหมด B: USB master key "เสียบตลอด" (§11 · env KPE_LICENSE_USB=1) — Manager เป็นตัวคุม: ดึง USB → หยุดลูกทั้งหมด ──
const USB_MODE = process.env.KPE_LICENSE_USB === '1';
let usbOk = !USB_MODE, usbReason = 'mode-a', usbMaster = null;
function _usbCheck() {   // poll USB · คืน true ถ้าสถานะเปลี่ยน
  if (!usbMaster) return false;
  const r = usbMaster.check();
  const changed = r.ok !== usbOk || r.reason !== usbReason;
  usbOk = r.ok; usbReason = r.reason;
  return changed;
}
if (USB_MODE) {
  try {
    const UsbMasterKey = require('../backend/src/usbMasterKey');
    usbMaster = new UsbMasterKey({ publicKey: license.publicKeyB64(), machineFp: license.fingerprint() });
    _usbCheck();
  } catch (e) { console.error('[LICENSE-USB] manager init:', e && e.message); usbOk = false; usbReason = 'init-error'; }
}
// blocked รวม: mode B = ตาม USB master key · mode A = ตาม disk license
function blockedNow() { return USB_MODE ? (license.isEnforced() && !usbOk) : license.blocked(); }
function licenseStatus() {
  const s = { ...license.status(), blocked: blockedNow() };
  return USB_MODE ? { ...s, mode: 'usb', usbPresent: usbOk, usbReason } : s;
}
license.status(true);   // ประเมินครั้งแรก (populate cache)
{ const s = licenseStatus(); if (s.blocked) console.error(`[LICENSE] blocked (${USB_MODE ? 'usb-' + usbReason : s.reason}) · machine-id ${s.machineId} → ไม่ start ลูก · ${USB_MODE ? 'เสียบ USB master key' : 'activate (Manager UI / CLI -Activate)'}`); }

// ── Remote HMI Gateway (R1 · serverA → serverB เต็มจอ ผ่าน "พอร์ตต่อ site") ──
const RemoteGateway = require('./gateway');
const gateway = new RemoteGateway({
  file: (() => { try { return require('../backend/src/csvUtil').configFile('remote-sites.json'); } catch (_) { return null; } })(),
  onLog: (m) => console.log('[gateway]', m),
});
// พอร์ตของ KPE เอง (ห้าม listenPort ของ gateway ชน)
function reservedPorts() { const p = portsMod.ports(); return [p.frontend, p.backend, p.manager, p.deploy]; }

// ── Service definitions ───────────────────────────────────────────────────────
const SERVICES = {
  backend:  { proc: null, logs: [], label: 'Backend',  port: PORTS.backend },
  frontend: { proc: null, logs: [], label: 'Frontend', port: PORTS.frontend },
  deploy:   { proc: null, logs: [], label: 'Deploy (run-mode)', port: PORTS.deploy },
};

// ── Port state cache (updated every second) ───────────────────────────────────
const portState = {};   // port → { open: bool, pids: string[] }

// ── Desktop notification (cross-platform) ──────────────────────────────────────
function notify(title, msg) {
  const safe = s => String(s).replace(/"/g, '\\"');
  if (IS_MAC) {
    exec(`osascript -e 'display notification "${safe(msg)}" with title "${safe(title)}" sound name "Funk"'`, () => {});
  } else if (IS_WIN) {
    // Windows toast ผ่าน PowerShell BurntToast-less balloon
    const ps = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') > $null;`
      + `$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;`
      + `$n.BalloonTipTitle="${safe(title)}";$n.BalloonTipText="${safe(msg)}";$n.Visible=$true;$n.ShowBalloonTip(4000)`;
    exec(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true }, () => {});
  }
  // linux: no-op (optional notify-send)
}

// ── Check if a port is actually listening ─────────────────────────────────────
function checkPort(port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error',   () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

// รอจนพอร์ตว่าง (ไม่มีใคร listening) — poll สูงสุด timeoutMs · กัน EADDRINUSE ตอน spawn แทน delay ตายตัว (B4)
//   หลัง killPort พอร์ตมักว่างเร็ว (connect→ECONNREFUSED ทันที) → ไม่หน่วงเกินจำเป็น · ถ้า TIME_WAIT ช้า ก็รอจนว่างจริง
async function waitPortFree(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkPort(port))) return true;        // ว่างแล้ว
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;   // ยังไม่ว่างใน timeout → ปล่อย spawn ลองต่อ (ดีกว่าค้างถาวร)
}

// ── Get PIDs using a port (cross-platform) ────────────────────────────────────
function getPidsOnPort(port) {
  return new Promise(resolve => {
    if (IS_WIN) {
      // netstat: หา LISTENING บน port → คอลัมน์สุดท้าย = PID
      exec(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`,
        { windowsHide: true }, (err, stdout) => {
          const pids = new Set();
          (stdout || '').trim().split(/\r?\n/).forEach(line => {
            const m = line.trim().match(/:(\d+)\s.*\s(\d+)\s*$/);
            if (m && Number(m[1]) === port) pids.add(m[2]);
          });
          resolve([...pids].filter(p => p && p !== '0'));
        });
    } else {
      // -sTCP:LISTEN = เอาเฉพาะตัวที่ "เปิดพอร์ตรอรับ" — ห้ามตัดออก!
      //   lsof -ti:PORT เฉย ๆ จับ connection ที่เลขพอร์ตตรงกัน "ฝั่ง remote" ด้วย
      //   เช่น gateway (ใน Manager) ต่อออกไป serverB:3012 → killPort(3012) ตอน start frontend
      //   จะ kill -9 ตัว Manager เอง (boot แล้วตายทันทีทุกครั้ง) รวมถึง browser ที่ต่อพอร์ตค้างอยู่
      exec(`lsof -ti:${port} -sTCP:LISTEN`, (err, stdout) => {
        resolve((stdout || '').trim().split('\n').filter(Boolean));
      });
    }
  });
}

// ── Kill all processes on a port (cross-platform) ─────────────────────────────
async function killPort(port) {
  const pids = await getPidsOnPort(port);
  if (!pids.length) return { killed: 0, pids: [] };
  const cmd = IS_WIN
    ? pids.map(p => `taskkill /F /PID ${p}`).join(' & ')
    : `kill -9 ${pids.join(' ')}`;
  await new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (e) => {
      if (e && !/No such process|not found|ไม่พบ/i.test(e.message)) return reject(e);
      resolve();
    });
  });
  return { killed: pids.length, pids };
}

// ── Real-time port polling (every 1 second) ───────────────────────────────────
const WATCHED_PORTS = [PORTS.frontend, PORTS.backend, PORTS.manager];

async function pollPorts() {
  const cp = portsMod.ports();
  for (const port of [cp.frontend, cp.backend, cp.manager, cp.deploy]) {
    const open = await checkPort(port);
    const pids = open ? await getPidsOnPort(port) : [];
    const prev = portState[port];

    if (!prev || prev.open !== open || JSON.stringify(prev.pids) !== JSON.stringify(pids)) {
      portState[port] = { open, pids };
      bus.emit('port', { port, open, pids });
    }
  }
}

setInterval(pollPorts, 1000);
pollPorts(); // initial

// ── Process log helper ────────────────────────────────────────────────────────
function pushLog(name, line) {
  const entry = { t: Date.now(), line: line.trimEnd() };
  SERVICES[name].logs.push(entry);
  if (SERVICES[name].logs.length > 300) SERVICES[name].logs.shift();
  bus.emit('log', { name, ...entry });
}

function isRunning(name) { return !!SERVICES[name].proc; }

// ── (B1) respawn ลูกเมื่อตายไม่ตั้งใจ — backoff + crash-loop guard ───────────────
//   ตายรัว ๆ (เช่น config พัง/พอร์ตชน) → ยอมแพ้ + แจ้งเตือน ไม่ปลุกวนไม่จบ (กิน CPU/log ท่วม)
const RESPAWN_WINDOW_MS = 60000;   // หน้าต่างนับการตาย
const RESPAWN_MAX = 5;             // ตายเกินนี้ใน window → หยุด auto-restart
function scheduleRespawn(name) {
  const svc = SERVICES[name];
  const now = Date.now();
  svc._restartTimes = (svc._restartTimes || []).filter(t => now - t < RESPAWN_WINDOW_MS);
  svc._restartTimes.push(now);
  if (svc._restartTimes.length > RESPAWN_MAX) {
    svc.wantRunning = false;
    pushLog(name, `── ⚠️ crash-loop (ตาย ${svc._restartTimes.length} ครั้งใน ${RESPAWN_WINDOW_MS / 1000}s) → หยุด auto-restart · กด Start เพื่อลองใหม่ ──`);
    notify(`KPE SCADA — ${svc.label} crash-loop`, 'หยุด auto-restart แล้ว · กด Start เพื่อลองใหม่');
    return;
  }
  const delay = Math.min(svc._restartTimes.length * 1000, 5000);   // backoff 1→5s
  pushLog(name, `── auto-restart ใน ${delay}ms (ครั้งที่ ${svc._restartTimes.length}) ──`);
  svc._respawnTimer = setTimeout(() => {
    svc._respawnTimer = null;
    if (svc.wantRunning && !_mgrShuttingDown && !svc.proc) startService(name);
  }, delay);
}

// ── Start / Stop service ──────────────────────────────────────────────────────
async function startService(name) {
  // License gate — invalid (Pi + armed) → ปฏิเสธ spawn (ทั้ง auto-start และปุ่ม Start)
  { const s = licenseStatus(); if (s.blocked) return { ok: false, msg: `license invalid (${s.reason}) · machine-id ${s.machineId}` }; }
  if (isRunning(name)) return { ok: false, msg: 'Already running' };
  const svc = SERVICES[name];
  svc.wantRunning = true;   // (B1) ตั้งใจให้รัน → exit handler ใช้ตัดสินใจ respawn เมื่อตายไม่ตั้งใจ
  if (svc._respawnTimer) { clearTimeout(svc._respawnTimer); svc._respawnTimer = null; }
  svc.logs = [];

  // อ่านพอร์ต "สด" จาก ports.json ทุกครั้งที่ start → แก้ผ่าน UI แล้ว Start/Stop มีผลทันที (ไม่ต้อง relaunch Manager)
  const cur = portsMod.ports();
  const portEnv = {
    KPE_PORT: String(cur.frontend),
    KPE_BACKEND_PORT: String(cur.backend),
    KPE_MANAGER_PORT: String(cur.manager),
    KPE_BACKEND_HOST: cur.backendHost,
    KPE_DEPLOY_PORT: String(cur.deploy),
    KPE_DEPLOY_BACKEND_HOST: cur.deployBackendHost,
    KPE_DEPLOY_BACKEND_PORT: String(cur.deployBackendPort),
  };
  // API token — ส่งให้ลูกเฉพาะตอนเปิดใช้ (backend enforce · serve/deploy ฉีด header)
  const _tok = readApiToken();
  if (_tok.enabled) portEnv.KPE_API_TOKEN = _tok.token;
  // ฆ่า process ที่ค้างบนพอร์ตนี้ก่อน spawn (กัน EADDRINUSE จาก orphan/ตัวเก่าที่ manager ไม่ได้ track)
  // → start ติดตั้งแต่ครั้งแรก ไม่ต้องกดซ้ำ
  //   (B4) poll จนพอร์ตว่างจริงแทน delay 400ms ตายตัว — แก้ deploy/backend กดครั้งแรก EADDRINUSE ตอน OS ปล่อยพอร์ตช้า (TIME_WAIT)
  const svcPort = { backend: cur.backend, frontend: cur.frontend, deploy: cur.deploy }[name];
  if (svcPort) { try { await killPort(svcPort); await waitPortFree(svcPort, 3000); } catch (_) {} }

  let cmd, args, cwd;
  // ใช้ node ตัวเดียวกับที่รัน Manager (process.execPath) → ลูกได้ node เดียวกับ Manager (bundled vendor\node) · ไม่พึ่งลำดับ PATH
  const NODE = process.execPath;
  if (name === 'backend') { cmd = NODE; args = ['src/server.js']; cwd = path.join(ROOT, 'backend'); }
  else if (name === 'deploy') { cmd = NODE; args = ['deploy.js']; cwd = path.join(ROOT, 'frontend'); }
  else { cmd = NODE; args = ['serve.js']; cwd = path.join(ROOT, 'frontend'); }
  const env = { ...process.env, ...portEnv };

  const child = spawn(cmd, args, { cwd, env });
  svc.proc = child;

  child.stdout.on('data', d => pushLog(name, d.toString()));
  child.stderr.on('data', d => pushLog(name, d.toString()));
  child.on('exit', code => {
    svc.proc = null;
    pushLog(name, `── Process exited (code ${code ?? 0}) ──`);
    bus.emit('proc', { name, running: false });
    notify(`KPE SCADA — ${svc.label} stopped`, `Exit code: ${code ?? 0}`);
    if (svc.wantRunning && !_mgrShuttingDown) scheduleRespawn(name);   // (B1) ตายไม่ตั้งใจ → ปลุกใหม่
  });

  notify(`KPE SCADA — ${svc.label} started`, `Port ${svc.port}`);
  bus.emit('proc', { name, running: true });
  return { ok: true };
}

function stopService(name) {
  const svc = SERVICES[name];
  svc.wantRunning = false;   // (B1) ตั้งใจหยุด → exit handler จะไม่ respawn
  if (svc._respawnTimer) { clearTimeout(svc._respawnTimer); svc._respawnTimer = null; }   // ยกเลิก respawn ที่ค้างคิว
  if (!svc.proc) return { ok: false, msg: 'Not running' };
  svc.proc.kill('SIGTERM');
  setTimeout(() => { if (svc.proc) svc.proc.kill('SIGKILL'); }, 3000);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// System Requirements — ตรวจเวอร์ชัน + ติดตั้งเอง (cross-platform)
// ═══════════════════════════════════════════════════════════════════════════════
const REQUIREMENTS = {
  node:    { label: 'Node.js', min: '18.0.0', regex: /v?(\d+\.\d+\.\d+)/,        desc: 'Runtime ของ Backend + Manager' },
  npm:     { label: 'npm',     min: '9.0.0',  regex: /(\d+\.\d+\.\d+)/,          desc: 'ตัวจัดการ package (มากับ Node.js)' },
  flutter: { label: 'Flutter', min: '3.16.0', regex: /Flutter\s+(\d+\.\d+\.\d+)/i, desc: 'ใช้ build Frontend (Flutter Web)' },
};

// path ของ flutter ที่ติดตั้งแบบ git clone ลง home (ตรงกับ setup เดิม ~/flutter)
function flutterHome() { return path.join(HOME, 'flutter'); }
function flutterBin()  { return path.join(flutterHome(), 'bin', IS_WIN ? 'flutter.bat' : 'flutter'); }

// resolve ตัวสั่งของแต่ละ tool (full path หรือ command name) — null ถ้าไม่เจอ
async function resolveBin(tool) {
  if (tool === 'node') return process.execPath;            // เรากำลังรันบน node อยู่แล้ว
  if (tool === 'npm')  return (await findInPath(IS_WIN ? 'npm.cmd' : 'npm')) || (await findInPath('npm'));
  if (tool === 'flutter') {
    const inPath = await findInPath('flutter');
    if (inPath) return inPath;
    if (fs.existsSync(flutterBin())) return flutterBin();   // ~/flutter/bin/flutter
    return null;
  }
  if (tool === 'git') return await findInPath('git');
  return null;
}

async function detectTool(tool) {
  const r   = REQUIREMENTS[tool];
  const bin = await resolveBin(tool);
  if (!bin) return { tool, label: r.label, desc: r.desc, min: r.min, installed: false, version: null, status: 'missing', path: null };

  // node = ใช้ process.versions เลย (เร็ว+ชัวร์), อื่น ๆ เรียก --version
  let out;
  if (tool === 'node') out = process.versions.node;
  else                 out = (await sh(`"${bin}" --version`, tool === 'flutter' ? 25000 : 8000)).out;

  const m = String(out).match(r.regex);
  const version = m ? m[1] : null;
  const status  = !version ? 'unknown' : (cmpVer(version, r.min) >= 0 ? 'ok' : 'outdated');
  return { tool, label: r.label, desc: r.desc, min: r.min, installed: true, version, status, path: bin };
}

async function detectAll() {
  const tools = Object.keys(REQUIREMENTS);
  const list  = await Promise.all(tools.map(detectTool));
  return { platform: process.platform, list };
}

// ── Install state + streaming ──────────────────────────────────────────────────
const installState = {};   // tool → { running, logs:[], ok }

function installLog(tool, line) {
  const st = installState[tool] || (installState[tool] = { running: false, logs: [], ok: null });
  st.logs.push(line);
  if (st.logs.length > 500) st.logs.shift();
  bus.emit('install', { tool, line });
}

// รัน 1 step (command string) แบบ stream output → resolve true ถ้า exit 0
function runStep(tool, commandString, opts = {}) {
  return new Promise(resolve => {
    installLog(tool, `$ ${commandString}`);
    const child = spawn(commandString, { shell: true, windowsHide: true, ...opts });
    const onData = d => d.toString().split(/\r?\n/).forEach(l => { if (l.trim()) installLog(tool, l); });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => { installLog(tool, `ERROR: ${err.message}`); resolve(false); });
    child.on('exit', code => { installLog(tool, `(exit code ${code})`); resolve(code === 0); });
  });
}

// แผนติดตั้งของแต่ละ tool ต่อ OS — คืน async function ที่รันจริง
async function runInstall(tool) {
  installState[tool] = { running: true, logs: [], ok: null };
  let ok = false;
  try {
    if (tool === 'node' || tool === 'npm') {
      // npm มากับ node → ติดตั้ง node ก็ได้ npm ด้วย
      if (IS_MAC) {
        const brew = await findInPath('brew');
        if (!brew) {
          installLog(tool, '✗ ไม่พบ Homebrew — ติดตั้ง Homebrew ก่อนที่ https://brew.sh');
          installLog(tool, '  หรือดาวน์โหลด Node.js installer: https://nodejs.org/en/download');
        } else {
          ok = await runStep(tool, `"${brew}" install node`);
        }
      } else if (IS_WIN) {
        const winget = await findInPath('winget');
        if (winget) {
          ok = await runStep(tool, `winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements`);
        } else {
          const choco = await findInPath('choco');
          if (choco) ok = await runStep(tool, `choco install nodejs-lts -y`);
          else installLog(tool, '✗ ไม่พบ winget/choco — ดาวน์โหลด Node.js: https://nodejs.org/en/download');
        }
      } else {
        installLog(tool, 'ใช้ package manager ของระบบ เช่น: sudo apt install nodejs npm');
      }
    } else if (tool === 'flutter') {
      const dest = flutterHome();
      if (fs.existsSync(dest)) {
        // มีอยู่แล้ว → upgrade
        installLog(tool, `พบ Flutter ที่ ${dest} → กำลัง upgrade`);
        ok = await runStep(tool, `"${flutterBin()}" upgrade`);
      } else {
        // ต้องมี git ก่อน
        let git = await findInPath('git');
        if (!git) {
          installLog(tool, 'ไม่พบ Git — กำลังพยายามติดตั้ง Git ก่อน…');
          if (IS_WIN) {
            const winget = await findInPath('winget');
            if (winget) await runStep(tool, `winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements`);
            else installLog(tool, '✗ ไม่พบ winget — ติดตั้ง Git: https://git-scm.com/download/win');
          } else if (IS_MAC) {
            installLog(tool, '→ รัน "xcode-select --install" เพื่อติดตั้ง Git (เปิดหน้าต่างติดตั้งของ macOS)');
            await runStep(tool, `xcode-select --install`);
          }
          git = await findInPath('git');
        }
        if (git) {
          installLog(tool, `กำลัง clone Flutter SDK (stable) → ${dest} … (อาจใช้เวลาสักครู่)`);
          const cloned = await runStep(tool, `git clone --depth 1 -b stable https://github.com/flutter/flutter.git "${dest}"`);
          if (cloned) {
            installLog(tool, 'clone สำเร็จ — กำลังรัน flutter --version เพื่อ warm-up (ดาวน์โหลด Dart SDK)…');
            ok = await runStep(tool, `"${flutterBin()}" --version`);
            installLog(tool, IS_WIN
              ? `⚠ เพิ่ม "${path.join(dest, 'bin')}" เข้า PATH ของ Windows เพื่อใช้คำสั่ง flutter ได้ทุกที่`
              : `⚠ เพิ่ม "export PATH=\\$PATH:${path.join(dest, 'bin')}" ใน ~/.zshrc เพื่อใช้คำสั่ง flutter ได้ทุกที่`);
          }
        }
      }
    }
  } catch (e) {
    installLog(tool, 'ERROR: ' + e.message);
  }
  installState[tool].running = false;
  installState[tool].ok = ok;
  installLog(tool, ok ? '✅ เสร็จสิ้น' : '⚠ ยังไม่สำเร็จ — ดู log ด้านบน');
  bus.emit('install_done', { tool, ok });
  // ตรวจเวอร์ชันใหม่แล้ว broadcast
  detectTool(tool).then(d => bus.emit('requirement', d)).catch(() => {});
  return ok;
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '8mb' }));   // เผื่อ logo data URL

// API token guard — บังคับ auth สำหรับ request "ข้ามเครื่อง" (ยกเว้น loopback)
//   loopback (UI ที่ :5012 + serve.js proxy /mgr) ผ่านได้ · remote direct :5012 ต้องมี auth อย่างใดอย่างหนึ่ง:
//     (1) API token (Bearer) — สำหรับ client/script ภายนอก
//     (2) Manager login-gate session (x-gate-token / ?gate=) — สำหรับ UI ที่เข้าจาก LAN แล้ว login ผ่าน managerLogin
//   endpoint ใน TOKEN_GUARD_EXEMPT เปิดให้ LAN เข้าถึงก่อน auth ได้ (เพื่อ render + ทำ login) — endpoint เหล่านี้ self-protect เอง
//   (req.path ในนี้ตัด mount '/api' ออกแล้ว → เช่น '/access-gate/verify')
const TOKEN_GUARD_EXEMPT = new Set(['/access-gate', '/access-gate/check', '/access-gate/verify', '/license']);
function tokenGuardExempt(req) {
  if (req.path === '/branding') return req.method === 'GET';   // โลโก้บนหน้า login (อ่านอย่างเดียว)
  return TOKEN_GUARD_EXEMPT.has(req.path);
}
app.use('/api', (req, res, next) => {
  const t = readApiToken();
  if (!t.enabled || isLoopback(req)) return next();
  if (tokenGuardExempt(req)) return next();
  if (tokenEq(bearerOf(req), t.token)) return next();
  const g = readGate();
  if (g.managerLogin && g.secret && gateValid(g.secret, gateTokenOf(req))) return next();
  res.status(401).json({ error: 'unauthorized (ต้องมี API token หรือ login Manager)' });
});

// ── Branding ของ Manager เอง (ชื่อ + โลโก้) — manager/branding.json (อิสระจาก backend) ──
const MGR_BRANDING_FIT = ['contain', 'cover', 'fill', 'scaleDown'];
const MGR_BRANDING_DEFAULT = { appName: 'KPE SCADA Manager', logo: '', logoFit: 'contain' };
function readMgrBranding() {
  const r = mgrReadCfg('branding.json');
  return r ? { ...MGR_BRANDING_DEFAULT, ...r } : { ...MGR_BRANDING_DEFAULT };
}
// ── License (Pi-only activation · ดู docs/LICENSING.md) — GET status · POST install (USB/upload base64) ──
app.get('/api/license', (_req, res) => res.json(licenseStatus()));
app.post('/api/license', (req, res) => {
  const b64 = (req.body && (req.body.license || req.body.key || req.body.b64)) || '';
  const r = license.install(b64);
  const st = licenseStatus();
  // valid แล้ว → auto-start ลูกทันที (recover ไม่ต้อง restart Manager เอง)
  if (!st.blocked && st.ok && process.env.KPE_NO_AUTOSTART !== '1') {
    (async () => {
      try { await startService('backend'); } catch (_) {}
      try { await startService('frontend'); } catch (_) {}
    })();
  }
  res.json({ ...st, installed: !!r.ok, installReason: r.reason });
});
// [DLC] เพิ่มใบ add-on แบบ stack (union กับ Base · ไม่ทับ) → ปลด DLC feature · backend อ่าน union ตอน restart/live
app.post('/api/license/addon', (req, res) => {
  const b64 = (req.body && (req.body.license || req.body.key || req.body.b64)) || '';
  const r = license.installAddon(b64);
  const st = licenseStatus();
  res.json({ ...st, installed: !!r.ok, installReason: r.reason });
});
// ถอด license (ลบที่เครื่องนี้) → ถ้ากลายเป็น blocked (Pi+armed) หยุดลูกให้เข้าสถานะ gated · activate ใหม่เพื่อ start
app.delete('/api/license', (req, res) => {
  const r = license.remove();
  const st = licenseStatus();
  if (st.blocked) { try { stopService('backend'); } catch (_) {} try { stopService('frontend'); } catch (_) {} }
  res.json({ ...st, removed: !!r.removed });
});

// ── Remote sites (Gateway · R1) — CRUD + status · listenPort ห้ามชนพอร์ต KPE เอง ──
app.get('/api/remote-sites', (_req, res) => res.json(gateway.list()));
app.post('/api/remote-sites', (req, res) => {
  if (blockedNow()) return res.status(403).json({ ok: false, error: 'license' });
  try {
    const lp = parseInt((req.body || {}).listenPort, 10);
    if (reservedPorts().includes(lp)) return res.status(400).json({ ok: false, error: `listenPort ${lp} ชนกับพอร์ตของ KPE เอง` });
    res.json({ ok: true, site: gateway.add(req.body || {}) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/remote-sites/:id', (req, res) => {
  if (blockedNow()) return res.status(403).json({ ok: false, error: 'license' });
  try {
    const lp = (req.body || {}).listenPort;
    if (lp !== undefined && reservedPorts().includes(parseInt(lp, 10))) return res.status(400).json({ ok: false, error: 'listenPort ชนกับพอร์ตของ KPE เอง' });
    res.json({ ok: true, site: gateway.update(req.params.id, req.body || {}) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/remote-sites/:id', (req, res) => blockedNow() ? res.status(403).json({ ok: false, error: 'license' }) : res.json({ ok: gateway.remove(req.params.id) }));

// ── Embed proxy allowlist (โดเมนที่อนุญาตฝังผ่าน serverA /embed-proxy · serve.js อ่านไฟล์เดียวกัน) ──
const EMBED_PROXY_FILE = (() => { try { return require('../backend/src/csvUtil').configFile('embed-proxy.json'); } catch (_) { return null; } })();
function readEmbedAllow() {
  if (!EMBED_PROXY_FILE) return [];
  try { const j = JSON.parse(fs.readFileSync(EMBED_PROXY_FILE, 'utf8')); return Array.isArray(j) ? j : (j.allow || []); } catch (_) { return []; }
}
function normEmbedDomain(s) {
  return String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
}
app.get('/api/embed-proxy', (_req, res) => res.json({ ok: true, allow: readEmbedAllow() }));
app.put('/api/embed-proxy', (req, res) => {
  try {
    const raw = (req.body && req.body.allow) || [];
    if (!Array.isArray(raw)) return res.status(400).json({ ok: false, error: 'allow ต้องเป็น array' });
    const allow = [...new Set(raw.map(normEmbedDomain).filter(Boolean))];
    if (EMBED_PROXY_FILE) mgrWriteJson(EMBED_PROXY_FILE, allow);
    res.json({ ok: true, allow });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/branding', (_req, res) => res.json(readMgrBranding()));
app.put('/api/branding', (req, res) => {
  try {
    const cur = readMgrBranding();
    const b = req.body || {};
    const next = {
      appName: (typeof b.appName === 'string' && b.appName.trim()) ? b.appName.trim().slice(0, 60) : cur.appName,
      logo: (typeof b.logo === 'string') ? b.logo : cur.logo,
      logoFit: MGR_BRANDING_FIT.includes(b.logoFit) ? b.logoFit : cur.logoFit,
    };
    mgrWriteJson(mgrCfgFile('branding.json'), next);   // atomic (B3)
    res.json({ ok: true, ...next });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── API token (เปิด/ปิด · reset) — เปลี่ยนแล้ว restart backend+frontend+deploy ให้ token ตรงกัน ──
async function restartOne(name) {
  const svc = SERVICES[name];
  if (!svc || !svc.proc) return;            // restart เฉพาะตัวที่รันอยู่
  try { svc.proc.removeAllListeners('exit'); } catch (_) {}
  svc.proc = null;
  await startService(name);                 // killPort+spawn ด้วย env ใหม่ (token ล่าสุด)
}
async function restartForToken() {
  for (const n of ['backend', 'frontend', 'deploy']) await restartOne(n);
}
app.get('/api/token', (_req, res) => {
  const t = readApiToken();
  res.json({ enabled: t.enabled, masked: maskToken(t.token) });
});
app.post('/api/token/enable', async (req, res) => {
  const cur = readApiToken();
  writeApiToken({ token: cur.token, enabled: req.body?.enabled === true });
  res.json({ ok: true, enabled: req.body?.enabled === true });
  restartForToken();   // async (เบื้องหลัง) — service จะมี/ไม่มี token ตามสถานะใหม่
});
app.post('/api/token/reset', async (req, res) => {
  const cur = readApiToken();
  const next = { token: _genToken(), enabled: cur.enabled };
  writeApiToken(next);
  res.json({ ok: true, enabled: next.enabled, masked: maskToken(next.token) });
  if (next.enabled) restartForToken();   // กระจาย token ใหม่ให้ลูก (ถ้าเปิดอยู่)
});

// ── Access gate ของ Manager (login เข้า UI Manager) — UI-level · แยกจาก §21 · default ปิด ──
function readGate() {
  const def = { managerLogin: false, salt: '', hash: '', secret: '' };
  const r = mgrReadCfg('access-gate.json');
  return r ? { ...def, ...r } : def;
}
function writeGate(g) { try { mgrWriteJson(mgrCfgFile('access-gate.json'), g, { mode: 0o600 }); } catch (e) { console.error('[gate] save:', e.message); } }
function gateHash(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function gateVerifyPw(pw, g) {
  if (!g.hash || !g.salt) return false;
  try { return crypto.timingSafeEqual(Buffer.from(gateHash(pw, g.salt)), Buffer.from(g.hash)); } catch (_) { return false; }
}
function gateSign(secret) {
  const exp = Date.now() + 12 * 3600 * 1000;
  const sig = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
  return Buffer.from(`${exp}.${sig}`).toString('base64');
}
function gateValid(secret, token) {
  try {
    const [exp, sig] = Buffer.from(token, 'base64').toString().split('.');
    if (!exp || !sig || Date.now() > Number(exp)) return false;
    const good = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  } catch (_) { return false; }
}
app.get('/api/access-gate', (_req, res) => { const g = readGate(); res.json({ managerLogin: g.managerLogin === true, hasPassword: !!g.hash }); });
app.put('/api/access-gate', (req, res) => {
  try {
    const g = readGate(); const b = req.body || {};
    const changingPw = typeof b.password === 'string' && !!b.password;
    const disabling = b.managerLogin === false;
    // hardening: ถ้ามีรหัสอยู่แล้ว — เปลี่ยนรหัส/ปิดล็อก ต้อง "ล็อกอินอยู่ (token) หรือทำจาก localhost"
    //   (เปิดล็อก/ตั้งรหัสครั้งแรก = เปิดให้ทำได้) · ลืมรหัส → กู้จาก localhost (ดู §33.4)
    if (g.hash && (changingPw || disabling)) {
      if (!(isLoopback(req) || gateValid(g.secret, b.token || ''))) {
        return res.status(403).json({ ok: false, error: 'ต้องล็อกอินอยู่ หรือทำจากเครื่อง server (localhost)' });
      }
    }
    if (changingPw) {
      g.salt = crypto.randomBytes(16).toString('hex');
      g.hash = gateHash(b.password, g.salt);
      if (!g.secret) g.secret = crypto.randomBytes(32).toString('hex');
    }
    if (typeof b.managerLogin === 'boolean') {
      if (b.managerLogin && !g.hash) return res.status(400).json({ ok: false, error: 'ต้องตั้งรหัสผ่านก่อนเปิดล็อก' });
      g.managerLogin = b.managerLogin;
    }
    writeGate(g);
    res.json({ ok: true, managerLogin: g.managerLogin === true, hasPassword: !!g.hash });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/access-gate/verify', (req, res) => {
  const g = readGate();
  if (gateVerifyPw(req.body?.password, g)) return res.json({ ok: true, token: gateSign(g.secret) });
  res.status(401).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
});
app.get('/api/access-gate/check', (req, res) => {
  const g = readGate();
  if (!g.managerLogin) return res.json({ required: false, ok: true });
  res.json({ required: true, ok: gateValid(g.secret, req.query.token || '') });
});

// ตรวจเวอร์ชันทั้งหมด
app.get('/api/requirements', async (_req, res) => {
  try { res.json(await detectAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// เริ่มติดตั้ง/อัปเดต tool (async — ดู log ผ่าน SSE)
app.post('/api/requirements/:tool/install', (req, res) => {
  const { tool } = req.params;
  if (!REQUIREMENTS[tool]) return res.status(404).json({ error: 'Unknown tool' });
  if (installState[tool]?.running) return res.json({ ok: false, msg: 'กำลังติดตั้งอยู่แล้ว' });
  runInstall(tool);   // fire-and-forget
  res.json({ ok: true, started: true });
});

app.get('/api/status', (_req, res) => {
  const cfg = portsMod.ports();
  const svcPort = { backend: cfg.backend, frontend: cfg.frontend, deploy: cfg.deploy };
  const result = {};
  for (const [name, svc] of Object.entries(SERVICES)) {
    const p = svcPort[name];
    result[name] = {
      running:   isRunning(name),
      portOpen:  portState[p]?.open ?? false,
      pids:      portState[p]?.pids ?? [],
      logs:      svc.logs.slice(-80),
    };
  }
  result.ports = { ...portState };
  result.config = cfg;   // พอร์ตจริงปัจจุบัน (UI ใช้ปรับ label/link/kill ให้ dynamic)
  result.lanIps = lanIPv4();   // IP ใน LAN สำหรับเปิดจากเครื่องอื่น (edit :frontend / deploy :deploy)
  result.version = readVersion();   // เวอร์ชันแอป (โชว์ใน header Manager)
  res.json(result);
});

// เวอร์ชันแอป (เดี่ยว ๆ) — { version, build, date, commit }
app.get('/api/version', (_req, res) => res.json(readVersion() || {}));

// IPv4 ที่ใช้ใน LAN (ไม่เอา loopback/internal) — ให้เครื่องอื่นเปิด http://<ip>:<port>
function lanIPv4() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// ── Ports config (อ่าน/แก้พอร์ตจาก Manager โดยตรง) ──────────────────────────────────
app.get('/api/ports', (_req, res) => res.json({ ok: true, ports: portsMod.ports(), file: portsMod.FILE }));
app.put('/api/ports', (req, res) => {
  try {
    const saved = portsMod.save(req.body || {});
    res.json({ ok: true, ports: portsMod.ports(), saved, restartRequired: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── TLS self-signed cert (best-effort · ต้องมี openssl) → เก็บใต้ <data>/config/tls/ ──
function tlsDir() {
  const base = process.env.KPE_DATA_DIR || ROOT;
  const d = path.join(base, 'config', 'tls');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
app.post('/api/tls/selfsign', (req, res) => {
  const host = String((req.body || {}).host || '').trim() || 'localhost';
  const dir = tlsDir();
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const san = `subjectAltName=DNS:localhost,IP:127.0.0.1${isIp ? `,IP:${host}` : (host !== 'localhost' ? `,DNS:${host}` : '')}`;
  const cmd = `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 825 -subj "/CN=${host}" -addext "${san}"`;
  exec(cmd, { windowsHide: true }, (e) => {
    if (e) return res.status(500).json({ ok: false, error: 'สร้าง cert ไม่สำเร็จ (ต้องมี openssl ในเครื่อง): ' + e.message });
    try { portsMod.save({ tls: { cert, key } }); } catch (_) {}
    res.json({ ok: true, cert, key });
  });
});

app.post('/api/:name/start', async (req, res) => {
  const { name } = req.params;
  if (!SERVICES[name]) return res.status(404).json({ error: 'Unknown service' });
  res.json(await startService(name));   // startService ฆ่าพอร์ตค้างก่อน spawn → ติดครั้งแรก
});

app.post('/api/:name/stop', (req, res) => {
  const { name } = req.params;
  if (!SERVICES[name]) return res.status(404).json({ error: 'Unknown service' });
  res.json(stopService(name));
});

// restart = ตัด ref ตัวเก่าทิ้ง (กัน startService ติด early-return "Already running") แล้ว
// startService จะ killPort พอร์ตนั้นก่อน spawn (ฆ่าตัวเก่า+orphan ตามพอร์ต) → start ใหม่ติดครั้งเดียว
app.post('/api/:name/restart', async (req, res) => {
  const { name } = req.params;
  const svc = SERVICES[name];
  if (!svc) return res.status(404).json({ error: 'Unknown service' });
  if (svc.proc) { try { svc.proc.removeAllListeners('exit'); } catch (_) {} svc.proc = null; }
  const r = await startService(name);   // killPort(port) ฆ่าตัวเก่าตามพอร์ต + spawn ใหม่ (รอจน spawn เสร็จ)
  res.json({ ok: true, restarting: name, ...r });
});

// Kill any process on a port
app.post('/api/port/:port/kill', async (req, res) => {
  const port = parseInt(req.params.port);
  if (isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  try {
    const result = await killPort(port);
    // ถ้าพอร์ตนี้เป็นของ managed service → ถือว่า "ตั้งใจหยุด" (เหมือน stopService)
    //   ไม่งั้น B1 supervisor จะ respawn กลับมาใน 1–5s (kill กลายเป็น restart) → ขัดแย้งกับเจตนาปุ่ม Kill
    //   set wantRunning=false + clear respawn timer → กันทั้งสองลำดับ race (exit fire ก่อน/หลัง killPort)
    for (const svc of Object.values(SERVICES)) {
      if (svc.port === port) {
        svc.wantRunning = false;
        if (svc._respawnTimer) { clearTimeout(svc._respawnTimer); svc._respawnTimer = null; }
        if (svc.proc) svc.proc = null;
      }
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── SSE — real-time events ────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Immediately send current port snapshot
  res.write(`data: ${JSON.stringify({ type: 'ports_snapshot', ports: portState })}\n\n`);

  const send = type => data => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  const onLog     = send('log');
  const onProc    = send('proc');
  const onPort    = send('port');
  const onInstall = send('install');
  const onInstallDone = send('install_done');
  const onRequirement = send('requirement');

  bus.on('log',  onLog);
  bus.on('proc', onProc);
  bus.on('port', onPort);
  bus.on('install', onInstall);
  bus.on('install_done', onInstallDone);
  bus.on('requirement', onRequirement);

  // Heartbeat every 15s to keep connection alive
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  req.on('close', () => {
    bus.off('log',  onLog);
    bus.off('proc', onProc);
    bus.off('port', onPort);
    bus.off('install', onInstall);
    bus.off('install_done', onInstallDone);
    bus.off('requirement', onRequirement);
    clearInterval(hb);
  });
});

// ── Serve UI ──────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const MGR_PORT = PORTS.manager;
server.listen(MGR_PORT, () => {
  console.log(`KPE SCADA Manager → http://localhost:${MGR_PORT}  (${process.platform})`);
  console.log(`Public UI (frontend) → http://localhost:${PORTS.frontend}  ·  backend(internal) ${BACKEND_HOST}:${PORTS.backend}`);
  if (!blockedNow()) { try { gateway.start(); } catch (e) { console.error('[gateway] start:', e && e.message); } }   // R1: เปิด tunnel ตาม remote-sites.json (blocked → ไม่เปิด · ฟีเจอร์ gateway ต้องมี license)
  else console.error('[LICENSE] gateway not started — Manager gated');
  openBrowser(`http://localhost:${MGR_PORT}`);
  // (B1) auto-start ลูกตอนบูต — backend+frontend+deploy เสมอ (systemd/launchd ปลุก Manager → ลูกขึ้นเอง ไม่ต้องกด Start)
  //   ปิด auto-start ทั้งหมดด้วย env KPE_NO_AUTOSTART=1 (dev/test) · เลี่ยง deploy ตัวเดียวด้วย KPE_NO_AUTOSTART_DEPLOY=1
  async function autoStartChildren() {
    try { await startService('backend'); }  catch (e) { console.error('[manager] auto-start backend:', e && e.message); }
    try { await startService('frontend'); } catch (e) { console.error('[manager] auto-start frontend:', e && e.message); }
    if (process.env.KPE_NO_AUTOSTART_DEPLOY !== '1') {
      try { await startService('deploy'); } catch (e) { console.error('[manager] auto-start deploy:', e && e.message); }
    }
  }
  if (process.env.KPE_NO_AUTOSTART !== '1') {
    const _ls = licenseStatus();
    if (_ls.blocked) {
      console.error(`[LICENSE] Manager gated — ไม่ auto-start ลูก (${USB_MODE ? 'usb-' + usbReason : _ls.reason}) · machine-id ${_ls.machineId} · ${USB_MODE ? 'เสียบ USB master key' : 'activate (Manager UI / CLI -Activate)'}`);
    } else autoStartChildren();
  }
  // USB poller (mode B) — ดึง master key = หยุดลูก "ทั้งหมด" (Manager gate · Pi-like เหลือ 5012 ตัวเดียว) · เสียบคืน = start
  if (USB_MODE) {
    const iv = setInterval(() => {
      if (!_usbCheck()) return;
      if (usbOk) { console.log('[LICENSE-USB] master key inserted → start children'); if (process.env.KPE_NO_AUTOSTART !== '1') autoStartChildren(); }
      else {
        console.error('[LICENSE-USB] master key REMOVED → stop ALL children (เหลือ Manager 5012)');
        for (const name of Object.keys(SERVICES)) { try { stopService(name); } catch (_) {} }
        try { notify('KPE License', 'USB master key ถูกถอด — ระบบหยุด (เสียบคืนเพื่อรันต่อ)'); } catch (_) {}
      }
    }, 2000);
    if (iv && typeof iv.unref === 'function') iv.unref();
  }
});

// graceful shutdown — รับทั้ง SIGINT และ SIGTERM (systemd/launchd/Windows Service สั่งหยุด) (B2)
//   หยุดลูก (backend/frontend/deploy) ก่อน แล้วค่อยออก — กัน orphan ค้างพอร์ต
let _mgrShuttingDown = false;
function mgrShutdown(sig) {
  if (_mgrShuttingDown) return; _mgrShuttingDown = true;
  console.log(`[manager] ${sig} → stopping services`);
  try { gateway.stop(); } catch (_) {}
  for (const name of Object.keys(SERVICES)) { try { stopService(name); } catch (_) {} }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT',  () => mgrShutdown('SIGINT'));
process.on('SIGTERM', () => mgrShutdown('SIGTERM'));
