const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os        = require('os');
const { exec, execFile } = require('child_process');
// archiver loaded lazily (v5 = CJS, safe to require)
const archiver = require('archiver');
const TagEngine       = require('./tagEngine');
const ScriptEngine    = require('./scriptEngine');
const DatabaseManager = require('./databaseManager');
const AlarmEngine     = require('./alarmEngine');
const DeviceLogger    = require('./deviceLogger');
const ChartStore      = require('./chartStore');
const DatalogManager  = require('./datalogManager');
const AuthManager     = require('./authManager');
const csvUtil         = require('./csvUtil');
const { resolve: placeholderResolve } = require('./placeholderResolver');
const AdmZip          = require('adm-zip');
const portsCfg        = require('../../ports.js');

const FRONTEND_DIR  = path.resolve(__dirname, '../../frontend');
const ASSETS_DIR    = path.join(FRONTEND_DIR, 'assets');
const BUILD_DIR     = path.join(FRONTEND_DIR, 'build', 'web');  // flutter output (always here)
const DEPLOY_DIR    = path.join(os.tmpdir(), 'kpe_scada_deploy'); // staging dir (cross-platform: win=%TEMP%, mac/linux=/tmp)
const BACKEND_SRC   = __dirname;                                 // backend/src (this file's dir)
const BACKEND_DIR   = path.resolve(__dirname, '..');             // backend/

const app = express();
app.use(cors());
// 50mb: dashboard layouts can embed base64 images (background/Image widget/lamps),
// which easily exceed the default 100kb body limit → /api/build would 413.
app.use(express.json({ limit: '50mb' }));

// ── API token guard — บังคับ Bearer token ทุก /api (ยกเว้น /health) + WS ──────────────
//   token มาจาก env KPE_API_TOKEN (ตั้งโดย Manager) · ว่าง = ไม่ enforce (dev / ไม่เปิด toggle)
//   serve.js/deploy.js ฉีด header ให้ตอน proxy → browser ไม่ต้องถือ token
const API_TOKEN = process.env.KPE_API_TOKEN || '';
function _bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-token'] || '');
}
function _tokenOk(tok) {
  if (!API_TOKEN) return true;
  if (typeof tok !== 'string' || tok.length !== API_TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(API_TOKEN)); } catch (_) { return false; }
}
app.use('/api', (req, res, next) => {
  // health = monitor/port-check · hooks = REST trigger (external webhook ไม่มี token → ยกเว้น,
  //   auth ของ hook ใช้ per-script API key ที่ header แทน — ดู /api/hooks/:path ด้านล่าง)
  if (!API_TOKEN || req.path === '/health' || req.path === '/license' || req.path === '/time' || req.path.startsWith('/hooks/')
      || req.path === '/kpenetwork/directory' || req.path === '/kpenetwork/values') return next();  // /time = peer time-sync (เวลา · ไม่ sensitive) · directory/values ข้าม node = ใช้ requireApiKey แทน (§9.1)
  if (_tokenOk(_bearer(req))) return next();
  res.status(401).json({ error: 'unauthorized (API token required)' });
});

// ── License gate (Pi-only anti-clone · ดู docs/LICENSING.md · defense-in-depth — จุดหลักคือ Manager) ──
//   invalid + "armed" (มี pubkey ฝัง) → /api ตอบ 403 ยกเว้น /health,/license + ไม่สตาร์ท engine
//   นโยบาย rollout: no-pubkey (Phase A ยังไม่ฝัง key) = ยังไม่ arm → ไม่บล็อก · non-Pi = not-pi → ไม่บล็อก
const LicenseManager = require('./licenseManager');
const license = new LicenseManager();
try { license.setLicenseFile(csvUtil.configFile('license.key')); } catch (_) {}
function licenseState() {
  return { ...license.status(), blocked: license.blocked() };
}
let LIC = licenseState();   // ประเมินตอน boot · re-verify สดทุก 10s (hot-swap feature: เพิ่ม/ถอด license ไม่ต้อง restart)
if (LIC.blocked) console.error(`[LICENSE] invalid (${LIC.reason}) · machine-id ${LIC.machineId} → backend gated (/api 403, engine off)`);
// hot-swap: re-verify license สด → feature-gate ปลด/ล็อกตามไฟล์ที่เพิ่ม/ถอด live (base-block ยังต้อง restart engine — phase U3)
// _engineStoppedByLicense = สถานะที่ "หยุด engine เพราะ license" (mode A) · debounce กัน stop จาก transient read
let _engineStoppedByLicense = LIC.blocked;
let _blockStreak = LIC.blocked ? 99 : 0;
const LIC_BLOCK_DEBOUNCE = 2;   // ต้อง blocked ติดกัน N tick (~N×10s) ก่อนหยุด engine — กัน license.key อ่านพลาดชั่วคราว (เช่น CrowdStrike/EDR ล็อกไฟล์ระหว่างสแกน) → engine สะดุดโดยไม่จำเป็น
const _licTimer = setInterval(() => {
  try {
    license.refresh(); LIC = licenseState();
    if (USB_MODE) return;   // mode B ใช้ USB poller ด้านล่างแทน
    if (license.instanceLocked()) license.acquireInstanceLock().catch(() => {});   // retry: instance อื่นตายแล้ว → ยึด lock คืนได้ (มีผล tick ถัดไป)
    // หมายเหตุ: /api 403 + WS close ใช้ blockedNow() สด = บล็อก "ทันที" อยู่แล้ว · debounce นี้คุมเฉพาะการ "หยุด engine" (กระทบการคุมงานจริง)
    const nb = blockedNow();
    _blockStreak = nb ? _blockStreak + 1 : 0;
    if (!_engineStoppedByLicense && nb && _blockStreak >= LIC_BLOCK_DEBOUNCE) {
      _engineStoppedByLicense = true;
      console.error(`[LICENSE] invalid ต่อเนื่อง ${_blockStreak} tick → stop engine (instant block · /api 403)`);
      stopEngine();
    } else if (_engineStoppedByLicense && !nb) {
      _engineStoppedByLicense = false;
      console.log('[LICENSE] valid → start engine');
      startEngine().then(startServicesOnce);
    }
  } catch (_) {}
}, 10000);
if (_licTimer && typeof _licTimer.unref === 'function') _licTimer.unref();

// ── โหมด B: USB master key "เสียบตลอด" (§11 · เปิดด้วย env KPE_LICENSE_USB=1) — ดึง USB = instant block ──
//   mode A (default · KPE_LICENSE_USB ไม่ตั้ง) = ตาม disk license เดิม ไม่เปลี่ยนพฤติกรรม
const USB_MODE = process.env.KPE_LICENSE_USB === '1';
let usbOk = !USB_MODE, usbReason = 'mode-a', usbFeatures = new Set(), usbTier = null, usbMaster = null;
function _usbCheck() {   // poll USB → อัปเดต state · คืน true ถ้าสถานะเปลี่ยน
  if (!usbMaster) return false;
  const r = usbMaster.check();
  const ok = r.ok, feats = new Set(r.features || []);
  const changed = ok !== usbOk || r.reason !== usbReason;
  usbOk = ok; usbReason = r.reason; usbFeatures = feats; usbTier = ok ? (r.scope === 'backend' ? 'backend' : 'base') : null;
  return changed;
}
if (USB_MODE) {
  try {
    const UsbMasterKey = require('./usbMasterKey');
    usbMaster = new UsbMasterKey({ publicKey: license.publicKeyB64(), machineFp: license.fingerprint() });
    _usbCheck();
    console.log(`[LICENSE-USB] mode B · master key ${usbOk ? 'present' : 'MISSING'} (${usbReason})`);
  } catch (e) { console.error('[LICENSE-USB] init:', e && e.message); usbOk = false; usbReason = 'init-error'; }
}
// blocked รวม: mode B = ตาม USB master key (เสียบ/ไม่เสียบ) · mode A = ตาม disk license
function blockedNow() { return USB_MODE ? (license.isEnforced() && !usbOk) : LIC.blocked; }
// DLC อนุญาตไหม: mode B = features จาก USB · mode A = จาก disk license
function allowFeature(f) { return USB_MODE ? (!license.isEnforced() || usbFeatures.has(f)) : license.featureAllowed(f); }
function gateInfo() { return USB_MODE ? { reason: usbOk ? 'valid' : ('usb-' + usbReason), machineId: license.machineIdShort() } : { reason: LIC.reason, machineId: LIC.machineId }; }

app.get('/api/license', (_req, res) => res.json(USB_MODE
  ? { ...license.status(), blocked: blockedNow(), mode: 'usb', usbPresent: usbOk, usbReason, tier: usbTier, features: [...usbFeatures] }
  : licenseState()));   // status (exempt token + gate)

// ── Remote access consent (R2) — serverB ยอมให้ gateway (serverA) เข้าถึงไหม · serve.js อ่านไฟล์นี้บังคับใช้ ──
const RemoteAccess = require('./remoteAccess');
const remoteAccess = new RemoteAccess({ file: csvUtil.configFile('remote-access.json') });
app.get('/api/remote-access', (_req, res) => res.json(remoteAccess.get(true)));
app.put('/api/remote-access', (req, res) => {
  if (blockedNow()) return res.status(403).json({ ok: false, error: 'license' });   // gate: route นี้อยู่ก่อน license middleware → เช็คเองในนี้
  try { res.json({ ok: true, config: remoteAccess.save(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/remote-access/log', (_req, res) => res.json(remoteAccess.readLog(100)));   // R4 audit
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/license' || req.path === '/time') return next();
  if (blockedNow()) { const g = gateInfo(); return res.status(403).json({ error: 'license', reason: g.reason, machineId: g.machineId }); }
  next();
});
// feature-gate (§10 L1): ฟีเจอร์พรีเมียม (L3 add-on) ต้องมี license feature นั้น (ไม่ enforced/dev = ผ่านหมด)
//   chem-store (Stock เคมี) = L3 feature "ตัวแรก" → /api/stock/* · ฟีเจอร์อื่น (power/ฯลฯ) = อยู่ใน base (ไม่ gate)
//   (boot snapshot · live re-verify ทุก 10s ที่ _licTimer → hot-swap)
function featureGate(feature) {
  return (req, res, next) => {
    if (allowFeature(feature)) return next();
    return res.status(403).json({ error: 'feature', feature, reason: 'license' });
  };
}
app.use('/api/stock', featureGate('chem-store'));

// backend = HTTP ภายในเสมอ (bind 127.0.0.1) — TLS ทำที่ขอบ (serve.js/deploy.js) แล้ว proxy มา
//   ถ้าจะเปิด backend ออก LAN + TLS เอง ค่อยเพิ่มภายหลัง (ระวัง proxy serve.js→backend ต้องเป็น https ด้วย)
const server = http.createServer(app);
// WS: enforce token เดียวกัน (header มาจาก serve.js/deploy.js ตอน upgrade)
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, cb) => {
    if (!API_TOKEN) return cb(true);
    cb(_tokenOk(_bearer(info.req)) ? true : false, 401, 'unauthorized');
  },
});

// tag engine
const engine = new TagEngine((deviceId, tagId, value, quality, timestamp) => {
  // coalesce: เก็บค่าล่าสุดต่อ tag → flush เป็นเฟรมเดียวทุก TAG_FLUSH_MS (ลด ws.send() syscall → ลด System/kernel CPU บน Windows/EDR)
  _pendingTags.set(deviceId + ' ' + tagId, { deviceId, tagId, value, quality, timestamp });
  // KPENETWORK WS (§76): push ค่าที่เปลี่ยนให้ peer ที่ subscribe ผ่าน WebSocket
  if (kpeNet) kpeNet.onTagChange(deviceId, tagId, value);
  // feed tag updates to script engine (tag_change triggers)
  if (scriptEngine) scriptEngine.onTagUpdate(deviceId, tagId, value, quality);
  // feed tag updates to alarm engine (limit/digital alarms — ประเมินทันที)
  if (alarmEngine) alarmEngine.onTagUpdate(deviceId, tagId);
  // datalog "เมื่อ tag เปลี่ยนค่า" (on-change · เสริม sampler ตามคาบ) — log ที่เปิด onChange
  if (datalogManager) datalogManager.onTagChange(deviceId, tagId, value, timestamp);
  // Query Buffer: bit tag trigger (รัน query เมื่อ tag ขึ้น/เปลี่ยน · เสริม interval)
  if (queryBufferManager) queryBufferManager.onTagChange(deviceId, tagId, value);
}, (deviceId, connected) => {
  // device online/offline เปลี่ยน → แจ้ง UI ทันที
  broadcast({ type: 'device_status', deviceId, connected });
  // บันทึก connection log (in-memory + DB ถ้าตั้งค่า)
  if (deviceLogger) {
    const dev = engine.allDevices.find((d) => d.id === deviceId);
    const entry = deviceLogger.log(deviceId, dev ? dev.name : deviceId,
        connected ? 'connected' : 'disconnected');
    broadcast({ type: 'device_log', entry });
  }
});
// serial input ดิบ → script trigger 'serial' + broadcast ให้ UI listen (debug)
engine.onSerialRaw = (deviceId, raw) => {
  if (scriptEngine) scriptEngine.onSerialData(deviceId, raw);
  broadcast({ type: 'serial_raw', deviceId, raw, t: Date.now() });
};

// database connection manager
const dbManager = new DatabaseManager();

// device connection logger (in-memory journal + optional DB)
const deviceLogger = new DeviceLogger(dbManager);

// chart history store (เก็บ/ดึงประวัติค่า tag สำหรับ widget Chart โหมด Database)
const chartStore = new ChartStore(dbManager);

// named datalog registry (สร้างชื่อ log ก่อน → backend เก็บให้ที่เดียว → อ้างชื่อไปแสดงได้หลายที่)
const datalogManager = new DatalogManager(engine, chartStore, dbManager);

// query buffer registry (รัน SQL ตามเวลา → เก็บผลล่าสุด → widget อ้างชื่อไปทำกราฟ/ตาราง)
const QueryBufferManager = require('./queryBufferManager');
const queryBufferManager = new QueryBufferManager(dbManager, engine);
const PowerManager = require('./powerManager');
const powerManager = new PowerManager(engine);
const TimeSyncManager = require('./timeSyncManager');
const timeSyncManager = new TimeSyncManager({ tagEngine: engine,
  onLog: (detail) => { try { activityLog.log({ category: 'system', action: 'timesync', detail, user: 'timesync', actorType: 'system' }); } catch (_) {} } });

// activity log (audit) — login/logout, deploy, tag write/force, config/system
const ActivityLog = require('./activityLog');
const activityLog = new ActivityLog(dbManager);

// Stock / Inventory — items/stocks/balance(item×stock) · movement · checkout · reorder · IStockProvider
const StockManager = require('./stockManager');
const stockManager = new StockManager(engine, {
  dbManager,
  onAlert: (a) => {
    try { broadcast({ type: 'stock_alert', ...a, t: Date.now() }); } catch (_) {}   // broadcast = function (hoisted)
    if (a && a.kind === 'outstanding-aged') {
      try {
        activityLog.log({ category: 'system', action: 'stock_outstanding_aged',
          target: (a.holder && (a.holder.name || a.holder.ref)) || a.checkoutId,
          detail: `ค้าง ${Math.round(a.agedHours)} ชม. · เหลือ ${a.remaining}` });
      } catch (_) {}
    }
  },
});
// Line Recorder (universal process recorder · §LR) — โมดูลบันทึกการผลิตต่อ job/ไลน์ชุบ · MVP: file store · ingest ผ่าน API (ยังไม่ผูก PLC)
const { LineRecorderManager } = require('./lineRecorder/manager');
const { mountLineRecorder } = require('./lineRecorder/routes');
const lineRecorder = new LineRecorderManager({ tagEngine: engine, dbManager, licenseMaxLines: () => license.maxLines() });   // DLClr line-limit (disk license · USB ไม่เกี่ยว)
lineRecorder._onViolation = (line, ev, viol) => { try { broadcast({ type: 'line_spec_violation', line, station: ev.station, carrier: ev.carrier, viol, t: Date.now() }); } catch (_) {} };
engine.setLineRecorder(lineRecorder);   // device type 'lr' อ่าน job field ผ่าน LR manager
mountLineRecorder(app, lineRecorder);

// §F DB storage (TPKstock_Prod/Test) — attach dbManager + init (db mode เท่านั้น · file mode ข้ามทันที) · best-effort ตอน boot
stockManager.attachDb(dbManager);
let _stockDbInited = false;
function ensureStockDbInit() {   // ต่อ stock DB ครั้งเดียว (idempotent) — เรียกตอน boot + ตอน activate DLC แบบ live
  if (_stockDbInited || !stockManager.isDbStorage()) return;
  _stockDbInited = true;
  stockManager.initDb()
    .then(() => console.log(`[stock] DB storage init ok · env=${stockManager.config.env}`))
    .catch((e) => { _stockDbInited = false; console.error('[stock] DB init FAILED (ใช้ in-memory/ไฟล์ต่อ):', e.message); });
}
// DLC gate: ต่อ stock DB เฉพาะเมื่อมี license 'chem-store' (enforced) — ไม่มี DLC = ไม่แตะ DB เลย (live activate → ต่อใน publishChemStockStatus)
if (allowFeature('chem-store')) ensureStockDbInit();
const { createStockProvider } = require('./stockProvider');
const stockProvider = createStockProvider('native', { stockManager });   // PM/connector ใช้ผ่าน interface นี้

// ARM (ระบบเตรียมเคมี) — read-only connector → เบิกวัตถุดิบจาก StoreRM ตาม production order (§C4)
const { ArmConnector, parseTag } = require('./armConnector');
const armConnector = new ArmConnector({ dbManager, stock: stockManager,
  connName: stockManager.config.armConn || 'autoDB',
  database: stockManager.config.armDb || 'ScadaReport',
  table: stockManager.config.armTable || 'SOI8_Order_SAP' });

// SAP incoming (รับเข้า §A2) — read-only query QMI002GET → field-map → สร้าง lot
const { SapReceive } = require('./sapReceive');
const sapReceive = new SapReceive({ stock: stockManager,
  url: stockManager.config.sapIncomingUrl || 'http://172.23.10.168:14090/DATAGW/QMI002GET',
  plant: stockManager.config.sapPlant || '1000', lotOri: stockManager.config.sapLotOri || '01' });

// รับ FG (PP production · internal incoming) — read-only · FG only (กรอง semi)
const { PpReceive } = require('./ppReceive');
const ppReceive = new PpReceive({ stock: stockManager,
  url: stockManager.config.ppUrl || 'http://172.23.10.168:14094/03iPPGETDATACHEM/GETDATA',
  plant: stockManager.config.ppPlant || '1000' });

const { PickingManager } = require('./pickingManager');
const pickingManager = new PickingManager({ stock: stockManager });
const { PickingSource } = require('./pickingSource');
const pickingSource = new PickingSource({ stock: stockManager });   // SECRET_KEY/url อ่าน dynamic จาก config (pickingApiKey/pickingApiUrl)
const { AutorackConnector } = require('./autorackConnector');
const autorackConnector = new AutorackConnector({ stock: stockManager });   // Oracle read-only mirror (§C6) · pass=env ORA_PASS · conn/user/schema จาก config
// [Concept v2 · docs/STOCK-CONCEPT-V2.md] autorack ไม่เป็นใหญ่แล้ว — CSdb นับเดี่ยว
//   P2a: refresh flag inAutorack (icon AR) จาก listStock — ไม่แตะยอด · ทุก 5 นาที + boot
let _arFlagBusy = false;
async function refreshAutorackFlags() {
  if (!allowFeature('chem-store')) return;   // DLC gate: ไม่มี license 'chem-store' = ไม่ sync autorack เลย
  const c = stockManager.config || {};
  if (c.extEnabled !== true || c.autorackEnabled !== true) return;
  if (_arFlagBusy) return; _arFlagBusy = true;
  try {
    const lines = await autorackConnector.listStock({});
    const r = stockManager.refreshAutorackFlags(lines); console.log(`[autorack] AR flags: ${r.flagged} lots in autorack (${r.autorackItems} items)`);
    await autorackAutoReceive(lines);   // P2b เคส 2 (gated · default off)
  } catch (e) { /* เงียบ — autorack ไม่ถึง = ไม่อัปเดต flag (ของเดิมคงไว้) */ }
  finally { _arFlagBusy = false; }
}
// [v2 P2b] auto-receive เคส 2 — autorack รับ + มีที่มา 3 ทาง (SAP/PP incoming) + ยังไม่อยู่ CSdb → รับเข้าคลัง autorack-* แทน user
//   mode: off (ปิด) · log (dry-run · log เฉย ๆ) · on (รับจริง · ใช้ qty/uom จาก "ที่มา") · dedup ด้วย lotExists · orphan ข้าม
//   ⚠️ ยังไม่เทสสด (autorack/SAP/PP ดับ) — แนะนำ 'log' ก่อน เปิด 'on'
async function autorackAutoReceive(arLines) {
  const mode = String((stockManager.config || {}).autorackAutoReceive || 'off');
  if (mode !== 'log' && mode !== 'on') return;
  const seen = new Set();   // dedup ต่อ MATCODE+lot — autorack มีหลายพาเลท/lot · รับครั้งเดียว/lot (กันนับเกิน)
  const cand = (arLines || []).filter((ln) => {
    if (!ln.matCode || !ln.lot) return false;
    const k = ln.matCode + '|' + ln.lot;
    if (seen.has(k)) return false; seen.add(k);
    return !stockManager.lotExists(ln.matCode, ln.lot);
  });
  if (!cand.length) return;
  const from = _dmyAgo(_sapDays()), to = _dmyToday();
  const src = new Map();   // "mat|lot" → {qty, uom} จาก 3 ทาง (ที่มา)
  try { for (const l of await sapReceive.listIncoming({ fromDate: from, toDate: to, acceptedOnly: true })) if (l.matCode && l.lotNo) src.set(l.matCode + '|' + l.lotNo, { qty: l.qty, uom: l.uom }); } catch (_) {}
  try { for (const l of await ppReceive.listIncoming({ fromDate: from, toDate: to })) if (l.matCode && l.lotNo) src.set(l.matCode + '|' + l.lotNo, { qty: l.qty, uom: l.uom }); } catch (_) {}
  let done = 0;
  for (const ln of cand) {
    const key = ln.matCode + '|' + ln.lot;
    const s = src.get(key); if (!s) continue;                 // ไม่มีที่มา → orphan ข้าม
    const store = stockManager.autoReceiveStoreFor(ln.matCode);   // [v3] zone จริง = defaultLocation · ไม่มี → NOMASTER-* (ไม่ใช่คลัง autorack monitor)
    if (!store || !stockManager.getStock(store)) continue;
    if (mode === 'log') { console.log(`[autorack] (dry-run) would auto-receive ${key} qty ${s.qty} → ${store}`); done++; continue; }
    try {
      stockManager.receive({ item: ln.matCode, stockId: store, qty: s.qty, uom: s.uom, lotNo: ln.lot,
        byUser: 'autorack-auto', actorType: 'autorack', srcMap: 'autorackAuto', srcKey: key, note: 'auto-receive: autorack + มีที่มา 3 ทาง (zone ' + store + ')' });
      done++; console.log(`[autorack] auto-received ${key} qty ${s.qty} → ${store}`);
    } catch (e) { console.error('[autorack] auto-receive:', e.message); }
  }
  if (done) { try { stockManager.refreshAutorackFlags(arLines); } catch (_) {} }   // lot ที่รับใหม่ → ติด flag AR
}
setInterval(refreshAutorackFlags, 5 * 60 * 1000);
setTimeout(refreshAutorackFlags, 8000);   // boot (หลัง stock hydrate)

// ── CHEMstock — managed virtual device รายงานสถานะระบบ Chem Stock เป็น tag (read-only · ใช้ widget/alarm เดิม) ──
//   publish ทุก 10s · register device+tag idempotent (รอด reload ที่ล้าง device) · bool=1/0 · mode=string
const CHEMSTOCK_TAGS = [
  { id: 'mode',                   name: 'โหมดข้อมูล (file/db-test/db-prod)', dataType: 'STRING' },
  { id: 'db_online',              name: 'DB ออนไลน์',                        dataType: 'INT' },
  { id: 'db_ready',               name: 'DB พร้อมใช้งาน',                    dataType: 'INT' },
  { id: 'db_locked',              name: 'ระบบถูกล็อก (db ไม่พร้อม)',         dataType: 'INT' },
  { id: 'db_dirty',               name: 'มีข้อมูลค้างยังไม่บันทึก',          dataType: 'INT' },
  { id: 'ext_enabled',            name: 'เปิดแหล่งภายนอก',                   dataType: 'INT' },
  { id: 'autorack_enabled',       name: 'เปิด autorack sync',                dataType: 'INT' },
  { id: 'autorack_online',        name: 'autorack ออนไลน์',                  dataType: 'INT' },
  { id: 'autorack_last_sync_min', name: 'autorack sync ล่าสุด', unit: 'min', dataType: 'REAL' },
];
async function publishChemStockStatus() {
  if (!stockManager) return;
  // DLC gate: ไม่มี license 'chem-store' (enforced) → ดับ stock สนิท: หยุด eval timer + ถอด device · ไม่ต่อ DB/ไม่ publish
  //   license ถูกถอน live → tick ถัดไป (<=10s) หยุด · activate ใหม่ → start (idempotent) + initDb + กลับมา publish เอง
  if (!allowFeature('chem-store')) {
    try { stockManager.stop(); } catch (_) {}
    try { engine.unregisterManagedDevice('CHEMstock'); } catch (_) {}
    return;
  }
  try { stockManager.start(); } catch (_) {}   // idempotent · รองรับ activate license DLC แบบ live (start() ห่อ try/catch ในตัว)
  ensureStockDbInit();                          // ต่อ DB ถ้ายังไม่ต่อ (เคส activate live)
  try { engine.registerManagedDevice({ id: 'CHEMstock', name: 'Chem Stock (สถานะระบบ)', tags: CHEMSTOCK_TAGS }); } catch (_) { return; }
  let st = {}; try { st = await stockManager.dbStatus(); } catch (_) {}
  const c = stockManager.config || {};
  const b = (x) => (x ? 1 : 0);
  const set = (id, v) => { try { engine.setTagValue('CHEMstock', id, v, 'good'); } catch (_) {} };
  const dbMode = !!(st.mode && st.mode !== 'file');
  set('mode', st.mode || 'file');
  set('db_online', dbMode ? b(st.connected) : 1);   // โหมด file = ไม่พึ่ง DB → ถือว่าปกติ (1)
  set('db_ready',  dbMode ? b(st.ready) : 1);
  set('db_locked', b(st.locked));
  set('db_dirty',  b(st.dirty));
  set('ext_enabled', b(c.extEnabled));
  set('autorack_enabled', b(c.autorackEnabled));
  const last = Number(c.autorackLastSync) || 0;
  const ageMin = last ? (Date.now() - last) / 60000 : -1;
  const syncSec = Number(c.autorackSyncSec) || 0;
  const thr = syncSec > 0 ? (syncSec * 2) / 60 : 30;   // online = sync ล่าสุดภายใน 2× รอบ (หรือ 30 นาที)
  set('autorack_online', b(c.autorackEnabled && ageMin >= 0 && ageMin <= thr));
  set('autorack_last_sync_min', ageMin < 0 ? -1 : Math.round(ageMin * 10) / 10);
}
publishChemStockStatus();
setInterval(publishChemStockStatus, 10000);

// scheduled DB backup/export (cron → CSV)
const DbBackup = require('./dbBackup');
const dbBackup = new DbBackup(dbManager);

// KPENETWORK — Modbus TCP server เผยแพร่ tag ที่แชร์ให้ KPE node อื่น (§55 · P1 publish+directory)
const KpeNetworkServer = require('./kpenetworkServer');
const kpeNet = new KpeNetworkServer(engine);
// log การเขียนกลับจาก peer (§37 · two-way P4)
kpeNet.onPeerWrite = (deviceId, tagId, value) => {
  try { activityLog.log({ category: 'tag', action: 'write', user: 'kpenet', target: `${deviceId}/${tagId}`, detail: `= ${value}`, result: 'ok' }); } catch (_) {}
};
// §76 C: peer WS connect/disconnect เปลี่ยน → push รายชื่อให้ Setup ทันที (ไม่ต้องรอ poll 2s)
//   broadcast() ข้าม ws._kpe อยู่แล้ว → peer ไม่รับ message dashboard นี้
kpeNet.onPeersChange = () => {
  try { broadcast({ type: 'kpenetwork_peers', wsPeers: kpeNet.getWsPeers(), clients: kpeNet.getClients() }); } catch (_) {}
};
// network tag เปลี่ยน (driver discover เสร็จ) → rebuild server (relay re-share §3.5)
//   + broadcast snapshot เต็ม → frontend เห็น network tag ใหม่ทันที (tag_update ปกติส่งแค่ค่า ไม่เพิ่ม tag)
engine.onTagsChanged = () => {
  try { kpeNet.rebuild(); } catch (_) {}
  try { broadcastSnapshot(); } catch (_) {}
};

// ── Safety net: กัน script/async ที่ error แล้วทำ server ล่ม ────────────────────────
//   Node ≥15 ปิด process เมื่อ unhandledRejection (เช่น script ทำ db.pg(...) แบบไม่ await แล้ว reject)
//   → ดักไว้ log แทนการตาย · scriptEngine._run มี try/catch อยู่แล้วสำหรับโค้ดที่ await ตรง ๆ
// stdout/stderr พัง (Manager/parent ตาย → pipe ขาด) ต้องกลืนเงียบ — ห้ามให้กลายเป็น uncaughtException
//   ไม่งั้น handler ข้างล่าง console.error → EPIPE ซ้ำ → วนไม่จบ + flood activity log
//   (เคสจริง 2026-06-12: activity CSV บวม 466MB/6.4M แถวใน 2 ชม. → backend boot ตาย OOM)
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
// error ซ้ำข้อความเดิมรัว ๆ → log ครั้งเดียวต่อ 5s (กัน loop/พายุ error ถล่ม journal+CSV)
let _lastSysErr = '', _lastSysErrAt = 0;
function _logSysError(target, msg) {
  const now = Date.now();
  if (msg === _lastSysErr && now - _lastSysErrAt < 5000) return;
  _lastSysErr = msg; _lastSysErrAt = now;
  try { activityLog.log({ category: 'system', action: 'error', target, detail: msg, result: 'fail' }); } catch (_) {}
}
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? reason.message : String(reason);
  console.error('[unhandledRejection]', msg);
  _logSysError('unhandledRejection', msg);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  _logSysError('uncaughtException', err && err.message ? err.message : String(err));
  // ไม่ exit — ให้ SCADA ทำงานต่อ (ไม่มี supervisor respawn ตอนนี้) · ดู AUDIT C6/Phase2
});
// ปิดแบบ graceful (service stop/restart) → flush datalog buffer ที่ค้าง (กัน sample ≤5s หาย) แล้วออก
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { datalogManager && datalogManager._flushAll(); } catch (_) {} process.exit(0); });
}
// helper: ดึง user (จาก header x-kpe-user ที่ frontend ส่งมา) + ip จาก req แล้ว log
function logActivity(req, ev) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const { actor, actorType } = resolveActor(req);   // §C8: user > ip (ไม่เป็น '-' อีก) + actorType
  const user = ev.user || actor || '-';
  return activityLog.log({ ...ev, user, ip, actorType: ev.actorType || actorType });
}

// auth manager (ผู้ใช้ + สิทธิ์ run mode) — เก็บที่ data/ (JSON) หรือ Database
const authManager = new AuthManager(dbManager);

// script automation engine (รับ dbManager เพื่อให้ db.pg('name', ...) เรียกด้วยชื่อได้)
const scriptEngine = new ScriptEngine(engine, (scriptId, level, msg) => {
  broadcast({ type: 'script_log', scriptId, level, msg, t: Date.now() });
}, dbManager, (evt) => {
  // navigate (เปลี่ยนหน้า) → broadcast แยก type · อื่น ๆ = popup
  if (evt && evt.action === 'navigate') broadcast({ type: 'navigate', page: evt.page || '' });
  else broadcast({ type: 'popup', ...evt });
}, (ev) => {
  // log การรัน script ลง History (เฉพาะ script ที่เปิด logActivity)
  try { activityLog.log({ category: 'script', action: ev.action || 'run', user: 'script',
    target: ev.name || ev.scriptId, detail: ev.detail || '', result: ev.result || 'ok' }); } catch (_) {}
}, queryBufferManager);

// alarm engine (ISA-18.2) — ประเมิน alarm จาก tag, broadcast event, persist ลง DB (optional)
const alarmEngine = new AlarmEngine(engine, (evt) => {
  broadcast(evt); // { type:'alarm_event'|'alarm_state', ... }
  // alarm trigger สำหรับ script
  if (evt.type === 'alarm_event' && scriptEngine) scriptEngine.onAlarmEvent(evt);
}, dbManager);

// WebSocket broadcast
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws._kpe) continue;   // KPENETWORK WS peer — ไม่ส่ง message ของ dashboard ให้
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ── tag_update coalescing ───────────────────────────────────────────────────
//   เดิม: ทุก tag เปลี่ยนค่า → broadcast 1 เฟรม → ws.send() นับร้อยครั้ง/วิ = syscall ถี่ → System/kernel CPU พุ่ง (EDR filter ขยาย)
//   ใหม่: เก็บค่าล่าสุดต่อ tag ใน buffer → flush รวมเป็นเฟรม 'tag_update_batch' เดียวทุก TAG_FLUSH_MS (ลด syscall + ลด repaint ฝั่ง client)
//   หมายเหตุ: alarm/script/datalog ประเมินทันทีอยู่แล้ว (ใน callback · ไม่ผ่าน buffer นี้) → ไม่กระทบ latency alarm
const _pendingTags = new Map();   // 'deviceId tagId' -> {deviceId,tagId,value,quality,timestamp} (ค่าล่าสุดเท่านั้น)
const TAG_FLUSH_MS = 150;
function _flushTagUpdates() {
  if (_pendingTags.size === 0) return;
  let hasClient = false;
  for (const ws of wss.clients) { if (!ws._kpe && ws.readyState === WebSocket.OPEN) { hasClient = true; break; } }
  if (!hasClient) { _pendingTags.clear(); return; }   // ไม่มี dashboard client → ทิ้ง buffer (ไม่ต้องส่ง)
  const updates = Array.from(_pendingTags.values());
  _pendingTags.clear();
  broadcast({ type: 'tag_update_batch', updates });
}
const _tagFlushTimer = setInterval(_flushTagUpdates, TAG_FLUSH_MS);
if (_tagFlushTimer && typeof _tagFlushTimer.unref === 'function') _tagFlushTimer.unref();

// ── Editor lock (Node-RED style) — กันแก้ทับ: แก้ได้ทีละคน, คนอื่น view-only, เตะได้ ──────
//   id = clientId ต่อแท็บ (frontend gen) · holder ถือสิทธิ์เขียน layout · heartbeat กันค้าง
let editLock = null;          // { id, name, since } | null
let editLockSeen = 0;         // เวลา heartbeat ล่าสุด (ms)
const EDIT_LOCK_TTL = 15000;  // ไม่ heartbeat เกินนี้ → ปล่อย lock อัตโนมัติ (editor ปิด/หลุด)
function setEditLock(lock) {
  editLock = lock;
  editLockSeen = lock ? Date.now() : 0;
  broadcast({ type: 'editlock', holder: editLock });
}
// sweep ปล่อย lock ถ้า editor หาย (ไม่ heartbeat ภายใน TTL)
setInterval(() => {
  if (editLock && Date.now() - editLockSeen > EDIT_LOCK_TTL) setEditLock(null);
}, 5000);

wss.on('connection', (ws, req) => {
  // license gate (defense-in-depth · middleware 403 ของ /api ไม่คุม WS upgrade) — blocked → ปิด WS ทันที (กัน snapshot/stream/write รั่วผ่าน WS)
  if (blockedNow()) { try { ws.close(1008, 'license'); } catch (_) {} return; }
  // KPENETWORK WS peer (node-to-node §76) — แยกจาก dashboard client (path /api/kpenetwork/ws)
  if ((req.url || '').split('?')[0] === '/api/kpenetwork/ws') {
    ws._kpe = true;
    try { kpeNet.handleWsPeer(ws, req); } catch (e) { try { ws.close(1011, 'kpenet error'); } catch (_) {} }
    return;
  }
  // เก็บ ip ของ client ไว้ใช้ตอน log activity (WS write จาก dashboard/run mode)
  ws._ip = ((req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '') + '').split(',')[0].trim();
  // send full snapshot on connect
  ws.send(JSON.stringify({ type: 'snapshot', data: engine.getAllValues() }));
  // send current alarm summary (active list + unack count)
  ws.send(JSON.stringify({ type: 'alarm_summary', ...alarmEngine.summary() }));
  // send current editor-lock state (ใครกำลังแก้อยู่)
  ws.send(JSON.stringify({ type: 'editlock', holder: editLock }));

  ws.on('message', async (raw) => {
    try {
      // กันกรณี connection เปิดตอน licensed แล้วโดนถอด license ระหว่างทาง → block write/run_script/ack
      if (blockedNow()) { try { ws.send(JSON.stringify({ type: 'error', message: 'license' })); } catch (_) {} return; }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'write') {
        const r = await engine.writeTag(msg.deviceId, msg.tagId, msg.value);
        // log เฉพาะ tag ที่ตั้ง logActivity (path WS = dashboard widget / Tag Monitor force)
        try {
          const dev = engine._findDevice(msg.deviceId);
          const tag = dev ? engine._findTag(dev, msg.tagId) : null;
          if (tag && tag.logActivity) {
            activityLog.log({ category: 'tag', action: msg.force ? 'force' : 'write',
              user: msg.user ? decodeURIComponent(String(msg.user)) : '-',
              target: `${dev.name || dev.id}›${tag.name || tag.id}`,
              detail: `value=${msg.value}${r?.simulated ? ' (sim)' : ''}`, result: 'ok', ip: ws._ip });
          }
        } catch (_) {}
        ws.send(JSON.stringify({ type: 'write_ack', deviceId: msg.deviceId, tagId: msg.tagId, success: true }));
      } else if (msg.type === 'run_script') {
        try {
          await scriptEngine.runOnce(msg.id);
          ws.send(JSON.stringify({ type: 'script_ack', id: msg.id, success: true }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'script_ack', id: msg.id, success: false, error: e.message }));
        }
      } else if (msg.type === 'ack_alarm') {
        // บังคับ comment แต่ไม่ส่งมา → ไม่ ack (ปิดช่องโหว่ path WS ข้ามการบังคับ)
        if (!(alarmEngine.config.ackRequireComment && !(msg.comment || '').trim())) {
          alarmEngine.acknowledge(msg.id, msg.by || 'operator', msg.comment || '');
        }
      } else if (msg.type === 'ack_all') {
        alarmEngine.acknowledgeAll(msg.by || 'operator');   // no-op ถ้า ackRequireComment
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });
});

// REST API
app.get('/api/devices', (req, res) => {
  res.json(engine.getDevices());
});

app.get('/api/values', (req, res) => {
  res.json(engine.getAllValues());
});

// TODO(auth-enforcement): wrap with requireAuth(minLevel, departments) — เฟสหลัง
//   ตรวจ req.query.token / Authorization → authManager.verifyToken → 403 ถ้าไม่ผ่าน
app.post('/api/write', async (req, res) => {
  const { deviceId, tagId, value } = req.body;
  try {
    const r = await engine.writeTag(deviceId, tagId, value); // { value, simulated }
    // log เฉพาะ tag ที่ตั้ง logActivity ไว้ (default ปิด)
    try {
      const dev = engine._findDevice(deviceId);
      const tag = dev ? engine._findTag(dev, tagId) : null;
      if (tag && tag.logActivity) {
        logActivity(req, { category: 'tag', action: req.body.force ? 'force' : 'write',
          target: `${dev.name || dev.id}›${tag.name || tag.id}`,
          detail: `value=${value}${r.simulated ? ' (sim)' : ''}`, result: 'ok' });
      }
    } catch (_) {}
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Database Connection API ───────────────────────────────────────────────
app.get('/api/databases', (_req, res) => {
  res.json(dbManager.getAll());
});
// SQLite capability — frontend โชว์ type 'sqlite' เฉพาะเมื่อเครื่องนี้มี driver (node:sqlite / better-sqlite3)
app.get('/api/databases/sqlite-capability', (_req, res) => {
  try { const sq = require('./sqliteDriver'); res.json({ available: sq.available(), driver: sq.driverName() }); }
  catch (_) { res.json({ available: false, driver: null }); }
});

app.post('/api/databases', (req, res) => {
  try { res.json({ success: true, connection: dbManager.add(req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Export connections (migration) — ?secrets=0 = มาส์ก password · default = ใส่ password (ย้ายเครื่อง)
app.get('/api/databases/export', (req, res) => {
  try { res.json({ connections: dbManager.exportConnections(req.query.secrets !== '0') }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Import connections (bulk · migration) — body { connections:[...] } · upsert by name
app.post('/api/databases/import', (req, res) => {
  try { const b = req.body || {}; res.json({ success: true, ...dbManager.importConnections(b.connections || [], b.overwrite !== false) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.put('/api/databases/:id', (req, res) => {
  try { res.json({ success: true, connection: dbManager.update(req.params.id, req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.delete('/api/databases/:id', (req, res) => {
  try { dbManager.remove(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Test a connection — รับ config ตรง ๆ (ยังไม่บันทึก) หรือชื่อที่บันทึกไว้
app.post('/api/databases/test', async (req, res) => {
  try {
    const conn = req.body.id ? dbManager.resolve(req.body.id) : req.body;
    res.json(await dbManager.test(conn));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// list ตารางใน connection (Query/Browse UI)
app.get('/api/databases/:id/tables', async (req, res) => {
  try { res.json({ ok: true, tables: await dbManager.listTables(req.params.id) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// รัน SQL/query บน connection → คืน rows (Query/Browse UI) — sql + params(optional)
app.post('/api/databases/:id/query', async (req, res) => {
  const t0 = Date.now();
  try {
    const conn = dbManager.resolve(req.params.id);
    const type = (conn.type || 'pg').toLowerCase();
    if (type === 'mongo' || type === 'mongodb') {
      return res.status(400).json({ ok: false, error: 'MongoDB ใช้ db.mongo ใน script — query นี้สำหรับ SQL' });
    }
    // แทน {{tag}}+{{date}} ใน SQL (DB Table ส่ง SQL ดิบมา · resolve ที่นี่ ใช้นาฬิกา/tag ฝั่ง server)
    let sql = req.body.sql || '';
    if (sql.includes('{{')) {
      sql = placeholderResolve(sql, { target: 'sql',
        getTag: (d, t) => { const v = engine.getTagValue(d, t); return v ? v.value : null; } });
    }
    const rows = await dbManager.query(req.params.id, sql, req.body.params || []);
    const arr = Array.isArray(rows) ? rows : [];
    const cols = arr.length ? Object.keys(arr[0]) : [];
    res.json({ ok: true, ms: Date.now() - t0, columns: cols, rows: arr.slice(0, 1000), total: arr.length });
  } catch (e) { res.status(400).json({ ok: false, ms: Date.now() - t0, error: e.message }); }
});

// ── Scheduled DB backup ─────────────────────────────────────────────────────
app.get('/api/db-backup', (_req, res) => res.json(dbBackup.getConfig()));
app.post('/api/db-backup', (req, res) => {
  try { res.json({ ok: true, job: dbBackup.addJob(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/db-backup/:id', (req, res) => {
  try { res.json({ ok: true, job: dbBackup.updateJob(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/db-backup/:id', (req, res) => {
  try { dbBackup.removeJob(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/db-backup/:id/run', async (req, res) => {
  try { res.json(await dbBackup.runNow(req.params.id)); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── KPENETWORK (§55 · P1) — config + directory (node-to-node) ────────────────
app.get('/api/kpenetwork', (_req, res) => res.json(kpeNet.getConfig()));
app.put('/api/kpenetwork', (req, res) => {
  try { res.json({ ok: true, config: kpeNet.setConfig(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// directory = สารบัญ tag ที่แชร์ (peer device kpenetwork เรียก) · ยกเว้น token · auth = requireApiKey (§9.1)
app.get('/api/kpenetwork/directory', (req, res) => {
  if (!kpeNet.checkApiKey(req.get('x-api-key'))) return res.status(401).json({ ok: false, error: 'invalid api key' });
  res.json(kpeNet.getDirectory());
});
// values = ค่าปัจจุบันของ tag ที่แชร์แบบ REST (STRING ฯลฯ) — peer poll ผ่าน REST · auth = requireApiKey เหมือน directory
app.get('/api/kpenetwork/values', (req, res) => {
  if (!kpeNet.checkApiKey(req.get('x-api-key'))) return res.status(401).json({ ok: false, error: 'invalid api key' });
  res.json({ ok: true, values: kpeNet.getRestValues() });
});
// peer-directory = UI picker: ดึงรายการ tag ที่ "ต้นทาง" (peer) แชร์ ตาม connection ที่กรอกในฟอร์ม device
//   (backend proxy ให้ frontend — เพราะ frontend ยิงข้ามเครื่อง/อ่าน Modbus เองไม่ได้) · ต้อง token (admin)
app.post('/api/kpenetwork/peer-directory', async (req, res) => {
  try {
    const KpenetworkDriver = require('./drivers/kpenetworkDriver');
    const drv = new KpenetworkDriver({ id: '_probe', type: 'kpenetwork', name: 'probe', tags: [], connection: req.body || {} }, () => {});
    const dir = await drv.probeDirectory();
    try { drv.disconnect(); } catch (_) {}
    res.json({ ok: true, nodeId: dir.nodeId || '', entries: dir.entries || [] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// device-directory = picker ตอน "สร้าง tag" — ดึง directory ตาม connection ที่เซฟไว้ของ device + คืน subscribeTags ปัจจุบัน
app.get('/api/kpenetwork/device-directory/:deviceId', async (req, res) => {
  try {
    const dev = (engine.allDevices || []).find((d) => d.id === req.params.deviceId);
    if (!dev) return res.status(404).json({ ok: false, error: 'device not found' });
    if (dev.type !== 'kpenetwork') return res.status(400).json({ ok: false, error: 'ไม่ใช่ device kpenetwork' });
    const KpenetworkDriver = require('./drivers/kpenetworkDriver');
    const drv = new KpenetworkDriver({ id: '_probe', type: 'kpenetwork', name: 'probe', tags: [], connection: dev.connection || {} }, () => {});
    const dir = await drv.probeDirectory();
    try { drv.disconnect(); } catch (_) {}
    res.json({ ok: true, nodeId: dir.nodeId || '', entries: dir.entries || [],
      current: (dev.connection && Array.isArray(dev.connection.subscribeTags)) ? dev.connection.subscribeTags : [] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Script Automation API ─────────────────────────────────────────────────
app.get('/api/scripts', (_req, res) => {
  res.json(scriptEngine.getScripts());
});

app.get('/api/scripts/:id/logs', (req, res) => {
  res.json(scriptEngine.getLogs(req.params.id));
});

// ตรวจ syntax ของโค้ด JS (live validation จาก editor)
app.post('/api/scripts/validate', (req, res) => {
  res.json(scriptEngine.validate(req.body.code || ''));
});

// test-run code ที่ยังไม่เซฟ → คืน { ok, logs, error, ms } (ปุ่ม Run ในหน้า edit)
app.post('/api/scripts/test', async (req, res) => {
  try { res.json(await scriptEngine.testRun(req.body.code || '', req.body.trigger || null, req.body.timeoutMs)); }
  catch (e) { res.status(400).json({ ok: false, error: e.message, logs: [] }); }
});

// Format Document (Prettier) — คลิกขวาในหน้า edit
app.post('/api/scripts/format', async (req, res) => {
  try {
    const prettier = await import('prettier');   // ESM lazy import (Node ≥18)
    const code = await prettier.format(req.body.code || '', {
      parser: 'babel', semi: true, singleQuote: true, printWidth: 100, tabWidth: 2,
    });
    res.json({ ok: true, code });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Help: CREATE TABLE DDL ของ log ทุกชนิด (อ้างอิงใน Scripts) — ?dialect=pg|mssql
const logSchemas = require('./logSchemas');
app.get('/api/help/log-schemas', (req, res) => {
  res.json(logSchemas.allSchemas(req.query.dialect));
});

// ล้าง log ของ script
app.delete('/api/scripts/:id/logs', (req, res) => {
  try { res.json({ success: true, cleared: scriptEngine.clearLogs(req.params.id) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post('/api/scripts', (req, res) => {
  try { res.json({ success: true, script: scriptEngine.addScript(req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.put('/api/scripts/:id', (req, res) => {
  try { res.json({ success: true, script: scriptEngine.updateScript(req.params.id, req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.delete('/api/scripts/:id', (req, res) => {
  try { scriptEngine.removeScript(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Script versioning: list versions + restore
app.get('/api/scripts/:id/versions', (req, res) => {
  try { res.json({ success: true, versions: scriptEngine.getVersions(req.params.id) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.post('/api/scripts/:id/restore', (req, res) => {
  try { res.json({ success: true, script: scriptEngine.restoreVersion(req.params.id, parseInt(req.body?.index) || 0) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Run a script once (test)
app.post('/api/scripts/:id/run', async (req, res) => {
  try { res.json({ success: true, result: await scriptEngine.runOnce(req.params.id) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── REST trigger (hook) — script ทำตัวเป็น HTTP endpoint ────────────────────────
//   external system ยิง request เข้า /api/hooks/<path> → script ที่ผูก path+method นั้นรัน
//   (มี trigger.{method,path,query,body,headers,ip}) · ค่าที่ script return = response (JSON)
//   หรือเรียก respond(body,{status,headers,type}) เพื่อคุม status/header
//   auth: ยกเว้น API token ของระบบ · ใช้ per-script API key ที่ header แทน (เปิด/ปิดได้)
//   - trigger.requireKey=true → ตรวจ header (default 'x-api-key' หรือ trigger.keyHeader) ให้ตรง trigger.apiKey
//   - requireKey=false → เปิดโล่ง (ไม่ป้องกัน)
app.all('/api/hooks/:path', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  // broadcast ทุก request ที่เข้ามา (ก่อน match) → Listen mode หน้า edit เห็นสด แม้ script ยังไม่ enable
  broadcast({ type: 'hook_request', path: req.params.path, method: req.method,
    query: req.query || {}, body: req.body ?? null, ip, t: Date.now() });
  const s = scriptEngine.matchHttp(req.params.path, req.method);
  if (!s) return res.status(404).json({ error: `no hook for ${req.method} /${req.params.path}` });

  // auth: per-script API key ที่ header (ถ้าเปิด requireKey)
  const tr = s.trigger || {};
  if (tr.requireKey) {
    const headerName = (tr.keyHeader || 'x-api-key').toLowerCase();
    const got = String(req.headers[headerName] || '');
    const want = String(tr.apiKey || '');
    const ok = want.length > 0 && got.length === want.length &&
      (() => { try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; } })();
    if (!ok) {
      try { logActivity(req, { category: 'system', action: 'hook', target: req.params.path, detail: `${req.method} (unauthorized)`, result: 'fail' }); } catch (_) {}
      return res.status(401).json({ error: 'unauthorized (invalid API key)' });
    }
  }

  const reqData = {
    type: 'http', method: req.method, path: req.params.path,
    query: req.query || {}, body: req.body, headers: req.headers, ip,
  };
  try {
    const r = await scriptEngine.runHttp(s, reqData);
    try { logActivity(req, { category: 'system', action: 'hook', target: req.params.path, detail: `${req.method} → ${s.name || s.id}`, result: r.ok ? 'ok' : 'fail' }); } catch (_) {}
    if (!r.ok) return res.status(500).json({ error: r.error || 'script error' });
    // respond() มี → ใช้ status/headers/body ที่กำหนด · ไม่งั้นใช้ค่า return เป็น JSON body
    if (r.resp) {
      if (r.resp.headers && typeof r.resp.headers === 'object') res.set(r.resp.headers);
      const status = Number(r.resp.status) || 200;
      if (r.resp.type === 'text' || typeof r.resp.body === 'string') return res.status(status).send(r.resp.body == null ? '' : String(r.resp.body));
      return res.status(status).json(r.resp.body == null ? {} : r.resp.body);
    }
    return res.json(r.ret === undefined || r.ret === null ? { ok: true } : r.ret);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Alarm API (ISA-18.2) ──────────────────────────────────────────────────
// definitions + global config
app.get('/api/alarms', (_req, res) => {
  res.json(alarmEngine.getAll());
});

// current active alarms + unack count
app.get('/api/alarms/active', (_req, res) => {
  res.json(alarmEngine.summary());
});

// event history / journal
app.get('/api/alarms/journal', (req, res) => {
  res.json(alarmEngine.getJournal(parseInt(req.query.limit) || 200));
});

app.post('/api/alarms', (req, res) => {
  try { res.json({ success: true, alarm: alarmEngine.addAlarm(req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.put('/api/alarms/:id', (req, res) => {
  try { res.json({ success: true, alarm: alarmEngine.updateAlarm(req.params.id, req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.delete('/api/alarms/:id', (req, res) => {
  try { alarmEngine.removeAlarm(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// acknowledge
app.post('/api/alarms/ack-all', (req, res) => {
  if (alarmEngine.config.ackPolicy === 'each') {
    return res.status(400).json({ success: false, error: 'โหมด "ต้อง ack ทุกตัว" — Ack All ทำไม่ได้ (ต้องทีละตัว)' });
  }
  res.json({ success: true, acked: alarmEngine.acknowledgeAll(req.body?.by || 'operator') });
});
app.post('/api/alarms/:id/ack', (req, res) => {
  if (alarmEngine.config.ackComment && !(req.body?.comment || '').trim()) {
    return res.status(400).json({ success: false, error: 'ต้องใส่ comment ก่อน ack' });
  }
  res.json({ success: alarmEngine.acknowledge(req.params.id, req.body?.by || 'operator', req.body?.comment || '') });
});

// export alarm history → CSV (full fields) · ?from=YYYY-MM-DD&to=YYYY-MM-DD (รวมทั้งวัน to)
app.get('/api/alarms/export', async (req, res) => {
  try {
    const parseDay = (s, endOfDay) => {
      if (!s) return NaN;
      const t = Date.parse(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
      return Number.isFinite(t) ? t : NaN;
    };
    const from = parseDay(req.query.from, false);
    const to = parseDay(req.query.to, true);
    const rows = await alarmEngine.exportEntries(
      Number.isFinite(from) ? from : 0,
      Number.isFinite(to) ? to : Date.now(),
    );
    const cols = alarmEngine.constructor.EXPORT_COLUMNS;
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    const fname = `alarm-history${req.query.from ? `_${req.query.from}` : ''}${req.query.to ? `_${req.query.to}` : ''}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send('﻿' + lines.join('\r\n'));   // BOM → Excel เปิด UTF-8 ไทยถูก
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/alarms/:id/shelve', (req, res) => {
  res.json({ success: alarmEngine.shelve(req.params.id, parseInt(req.body?.minutes) || 60) });
});
app.post('/api/alarms/:id/unshelve', (req, res) => {
  res.json({ success: alarmEngine.unshelve(req.params.id) });
});

// global alarm config (DB logging connection, journal limit, ackRequireComment)
app.put('/api/alarms-config', (req, res) => {
  try {
    const config = alarmEngine.setConfig(req.body);
    broadcast({ type: 'alarm_summary', ...alarmEngine.summary() }); // ให้ทุก client เห็น ackRequireComment ใหม่ทันที
    logActivity(req, { category: 'system', action: 'config_change', target: 'alarm-config' });
    res.json({ success: true, config });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Popup API (trigger popup จากภายนอก / ทดสอบ) ─────────────────────────────
// POST /api/popup  body = { ...popupOpts }  หรือ  { action:'close', id }
app.post('/api/popup', (req, res) => {
  const b = req.body || {};
  if (b.action === 'close') {
    broadcast({ type: 'popup', action: 'close', id: b.id || null });
  } else {
    const p = {
      id: b.id || `pop_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      kind: b.kind || (b.page ? 'page' : 'message'),
      title: b.title || '', message: b.message != null ? String(b.message) : '',
      severity: b.severity || 'info', buttons: Array.isArray(b.buttons) ? b.buttons : null,
      page: b.page || null, width: b.width || null, height: b.height || null,
      durationMs: b.durationMs || null, closable: b.closable !== false,
    };
    broadcast({ type: 'popup', action: 'show', popup: p });
    return res.json({ success: true, id: p.id });
  }
  res.json({ success: true });
});

// POST /api/navigate { page } — สั่งทุก client เปลี่ยนหน้า dashboard (id/name/เลข 1-based)
app.post('/api/navigate', (req, res) => {
  const page = req.body?.page;
  broadcast({ type: 'navigate', page: page != null ? String(page) : '' });
  res.json({ success: true, page: page != null ? String(page) : '' });
});

// ── Device connection log ─────────────────────────────────────────────────
// GET /api/device-log?limit=&deviceId=
app.get('/api/device-log', (req, res) => {
  res.json({
    config: deviceLogger.getConfig(),
    entries: deviceLogger.getJournal(parseInt(req.query.limit) || 200, req.query.deviceId || null),
  });
});
// PUT /api/device-log-config  { dbConnection, dbTable, journalLimit }
app.put('/api/device-log-config', (req, res) => {
  try { res.json({ success: true, config: deviceLogger.setConfig(req.body) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Activity log (audit) ───────────────────────────────────────────────────
// GET /api/activity?limit=&category=  → { config, entries }
app.get('/api/activity', (req, res) => {
  res.json({
    config: activityLog.getConfig(),
    entries: activityLog.getJournal(parseInt(req.query.limit) || 300, req.query.category || null),
  });
});
// PUT /api/activity-config  { dbConnection, dbTable, journalLimit, categories }
app.put('/api/activity-config', (req, res) => {
  try {
    const before = activityLog.getConfig();
    const config = activityLog.setConfig(req.body || {});
    logActivity(req, { category: 'system', action: 'config_change', target: 'activity-config',
      detail: `journal=${config.journalLimit} db=${config.dbConnection || 'CSV'}` });
    res.json({ success: true, config, before: before.dbConnection });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
// GET /api/activity/export?from=&to=  → CSV (ฟิลด์ครบ)
app.get('/api/activity/export', async (req, res) => {
  try {
    const parseDay = (s, end) => { if (!s) return NaN; const t = Date.parse(`${s}T${end ? '23:59:59.999' : '00:00:00'}`); return Number.isFinite(t) ? t : NaN; };
    const from = parseDay(req.query.from, false);
    const to = parseDay(req.query.to, true);
    const rows = await activityLog.exportEntries(Number.isFinite(from) ? from : 0, Number.isFinite(to) ? to : Date.now());
    const cols = activityLog.constructor.COLUMNS;
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activity-log${req.query.from ? `_${req.query.from}` : ''}${req.query.to ? `_${req.query.to}` : ''}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Storage (ที่เก็บ CSV log เมื่อไม่ใช้ DB — เลือก path ได้) ───────────────────────
// GET  /api/storage → { dataDir(effective), default, isDefault, folders }
app.get('/api/storage', (req, res) => {
  res.json({
    dataDir: csvUtil.getBase(),
    default: csvUtil.defaultDataDir(),
    isDefault: csvUtil.isDefault(),
    folders: ['alarm-logs', 'device-logs', 'chart-logs'],
  });
});
// PUT  /api/storage { dataDir }  (ว่าง = กลับไปใช้ค่าเริ่มต้น root)
app.put('/api/storage', (req, res) => {
  const r = csvUtil.setBase((req.body || {}).dataDir);
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  // โหลด log เก่าจาก path ใหม่ทันที (เฉพาะ feature ที่ไม่ใช้ DB)
  try { deviceLogger._loadJournalFromCsv(); } catch (_) {}
  try { alarmEngine._loadJournalFromCsv(); } catch (_) {}
  res.json({ success: true, dataDir: r.dataDir, isDefault: csvUtil.isDefault() });
});

// ── Browse filesystem (cross-platform: win/mac/linux/pi อัตโนมัติ) ────────────────
// list ไดรฟ์บน Windows (probe A–Z)
function _winDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(root)) out.push({ name: String.fromCharCode(c) + ':', path: root }); } catch (_) {}
  }
  return out;
}
// root/จุด mount ด่วน ตามแต่ละ OS (Windows=ไดรฟ์ · mac=/Volumes · linux/pi=/media,/mnt สำหรับ USB)
function _quickRoots() {
  const plat = process.platform;
  if (plat === 'win32') return _winDrives();
  const roots = [{ name: '/', path: '/' }];
  const mounts = plat === 'darwin' ? ['/Volumes'] : ['/media', '/mnt'];
  for (const m of mounts) { try { if (fs.existsSync(m)) roots.push({ name: m, path: m }); } catch (_) {} }
  return roots;
}
// ซ่อนโฟลเดอร์ซ่อน/ระบบ (POSIX=dotfiles · Windows=$ + ระบบที่รู้จัก)
function _isHiddenDir(name, plat) {
  if (name.startsWith('.')) return true;
  if (plat === 'win32') {
    if (name.startsWith('$')) return true;
    return ['System Volume Information', 'Recovery', 'Config.Msi', 'PerfLogs'].includes(name);
  }
  return false;
}

// ── Ports config (env > ports.json > default) — เปลี่ยนผ่าน UI ได้ ───────────────────
// GET /api/ports → { ok, ports:{frontend,backend,manager,backendHost}, file }
app.get('/api/ports', (req, res) => {
  res.json({ ok: true, ports: portsCfg.ports(), file: portsCfg.FILE });
});
// PUT /api/ports { frontend?, backend?, manager? } → เขียน ports.json (ต้อง restart ถึงมีผล)
app.put('/api/ports', (req, res) => {
  try {
    const saved = portsCfg.save(req.body || {});
    logActivity(req, { category: 'system', action: 'config_change', target: 'ports',
      detail: Object.keys(req.body || {}).join(',') });
    res.json({ ok: true, ports: portsCfg.ports(), saved, restartRequired: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Dashboard layout — แยก 2 ฉบับ: working (ร่าง designer) vs deployed (เผยแพร่จริง) ──────
//   working  = <base>/layout/dashboard.json          ← designer auto-save / Save
//   deployed = <base>/layout/dashboard.deployed.json ← เขียนเฉพาะตอนกด Deploy (publish)
//   หน้า deploy (:9012) อ่าน "deployed" → edit/save ไม่กระทบ operator จนกว่าจะ Deploy
// GET /api/layout → { ok, layout: <obj|null> }  (ฉบับ working — designer ใช้)
app.get('/api/layout', (req, res) => {
  try {
    const fp = csvUtil.layoutFile('dashboard.json');
    if (!fs.existsSync(fp)) return res.json({ ok: true, layout: null });
    res.json({ ok: true, layout: JSON.parse(fs.readFileSync(fp, 'utf8')) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// GET /api/layout/deployed → { ok, layout, deployed }  (ฉบับ deployed — หน้า deploy ใช้)
//   ยังไม่เคย publish → fallback เป็น working (deployed:false) เพื่อให้ deploy ครั้งแรกไม่ว่างเปล่า
app.get('/api/layout/deployed', (req, res) => {
  try {
    const dep = csvUtil.layoutFile('dashboard.deployed.json');
    if (fs.existsSync(dep)) {
      return res.json({ ok: true, deployed: true, layout: JSON.parse(fs.readFileSync(dep, 'utf8')) });
    }
    const work = csvUtil.layoutFile('dashboard.json');   // fallback: ยังไม่เคย Deploy
    if (fs.existsSync(work)) {
      return res.json({ ok: true, deployed: false, layout: JSON.parse(fs.readFileSync(work, 'utf8')) });
    }
    res.json({ ok: true, deployed: false, layout: null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// PUT /api/layout  (body = layout JSON) → เขียน working (atomic) — ฉบับร่าง ไม่กระทบ deploy
//   กันเขียนทับ: ถ้ามีคนถือ edit lock อยู่ ต้องส่ง header x-edit-lock ตรงกับ holder เท่านั้น
app.put('/api/layout', (req, res) => {
  try {
    if (editLock && req.headers['x-edit-lock'] !== editLock.id) {
      return res.status(409).json({ ok: false, error: 'มีผู้แก้ไขคนอื่นถือสิทธิ์อยู่', holder: editLock });
    }
    const layout = req.body;
    if (!layout || typeof layout !== 'object') return res.status(400).json({ ok: false, error: 'invalid layout' });
    csvUtil.writeJsonAtomic(csvUtil.layoutFile('dashboard.json'), layout);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// POST /api/layout/publish → snapshot working → deployed (atomic) — "เผยแพร่" ตอนกด Deploy
//   body ว่าง = ใช้ working ที่เซฟไว้ล่าสุด · ส่ง body layout มาด้วยได้ (publish ค่าที่ส่งมาตรง ๆ)
app.post('/api/layout/publish', (req, res) => {
  try {
    let layout = req.body;
    if (!layout || typeof layout !== 'object' || !Object.keys(layout).length) {
      const work = csvUtil.layoutFile('dashboard.json');
      if (!fs.existsSync(work)) return res.status(400).json({ ok: false, error: 'ยังไม่มี layout ให้ deploy' });
      layout = JSON.parse(fs.readFileSync(work, 'utf8'));
    }
    csvUtil.writeJsonAtomic(csvUtil.layoutFile('dashboard.deployed.json'), layout);
    const npages = Array.isArray(layout.pages) ? layout.pages.length : 0;
    logActivity(req, { category: 'deploy', action: 'deploy', target: 'dashboard',
      detail: `publish layout (${npages} page)`, result: 'ok' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Editor lock REST (Node-RED style) ─────────────────────────────────────────
app.get('/api/editlock', (_req, res) => res.json({ holder: editLock }));
// ขอสิทธิ์แก้ — ว่าง/เป็นของเราอยู่แล้ว → ได้ · มีคนอื่นถือ → ไม่ได้ (คืน holder ให้โชว์)
app.post('/api/editlock/acquire', (req, res) => {
  const { id, name } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  if (editLock && editLock.id !== id) return res.json({ ok: false, holder: editLock });
  setEditLock({ id, name: name || 'ไม่ระบุ', since: (editLock && editLock.since) || Date.now() });
  res.json({ ok: true, holder: editLock });
});
// เตะคนเดิมออกแล้วเข้าแก้แทน (takeover)
app.post('/api/editlock/takeover', (req, res) => {
  const { id, name } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  setEditLock({ id, name: name || 'ไม่ระบุ', since: Date.now() });
  res.json({ ok: true, holder: editLock });
});
// heartbeat — ต่ออายุ lock · ok:false = เสีย lock แล้ว (โดนเตะ/timeout) ให้ frontend ออกจาก edit
app.post('/api/editlock/heartbeat', (req, res) => {
  const { id } = req.body || {};
  if (editLock && editLock.id === id) { editLockSeen = Date.now(); return res.json({ ok: true, holder: editLock }); }
  res.json({ ok: false, holder: editLock });
});
// ปล่อย lock (ออกจาก edit / ปิดแท็บ)
app.post('/api/editlock/release', (req, res) => {
  const { id } = req.body || {};
  if (editLock && editLock.id === id) setEditLock(null);
  res.json({ ok: true });
});

// ── Branding (ชื่อแอป + โลโก้) — frontend + deploy ใช้ร่วมกัน · <base>/config/branding.json ──
//   logo = data URL (base64) หรือ '' (ไม่มี) · ตั้งในหน้า Setup (frontend) · deploy อ่านผ่าน proxy เดียวกัน
const BRANDING_FIT = ['contain', 'cover', 'fill', 'scaleDown'];   // วิธี fit โลโก้ในกรอบ
const BRANDING_DEFAULT = { appName: 'KPE SCADA', logo: '', logoFit: 'contain' };
function readBranding() {
  try {
    const fp = csvUtil.configFile('branding.json');
    if (fs.existsSync(fp)) return { ...BRANDING_DEFAULT, ...JSON.parse(fs.readFileSync(fp, 'utf8')) };
  } catch (_) {}
  return { ...BRANDING_DEFAULT };
}
app.get('/api/branding', (_req, res) => res.json(readBranding()));
app.put('/api/branding', (req, res) => {
  try {
    const cur = readBranding();
    const b = req.body || {};
    const next = {
      appName: (typeof b.appName === 'string' && b.appName.trim()) ? b.appName.trim().slice(0, 60) : cur.appName,
      logo: (typeof b.logo === 'string') ? b.logo : cur.logo,   // '' = ลบโลโก้
      logoFit: BRANDING_FIT.includes(b.logoFit) ? b.logoFit : cur.logoFit,
    };
    csvUtil.writeJsonAtomic(csvUtil.configFile('branding.json'), next);   // atomic (B3)
    res.json({ ok: true, ...next });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Access gate (login เข้า designer ด้วย "user id") — store แยกจาก §21 · cloud-ready · default ปิด ──
//   <base>/config/access-gate.json {frontendLogin, secret, users:[{id,name,salt,hash}]} · token = HMAC(secret, userId|exp)
//   (migrate จากของเก่า {hash,salt} → user 'admin' อัตโนมัติ)
function readGate() {
  const def = { frontendLogin: false, secret: '', users: [] };
  let g = def;
  try {
    const fp = csvUtil.configFile('access-gate.json');
    if (fs.existsSync(fp)) g = { ...def, ...JSON.parse(fs.readFileSync(fp, 'utf8')) };
  } catch (_) {}
  if (!Array.isArray(g.users)) g.users = [];
  if (g.users.length === 0 && g.hash && g.salt) {            // migrate รหัสเดี่ยวเดิม → user 'admin'
    g.users = [{ id: 'admin', name: 'Admin', salt: g.salt, hash: g.hash }];
    delete g.hash; delete g.salt;
  }
  return g;
}
function writeGate(g) {
  csvUtil.writeJsonAtomic(csvUtil.configFile('access-gate.json'), g, { mode: 0o600 });   // atomic (B3) · คง perm 0600 (มี hash รหัส)
}
function gateHash(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function gateUser(g, id) { return (g.users || []).find(u => u.id === id); }
function gateVerifyUser(g, id, pw) {
  const u = gateUser(g, id);
  if (!u || !u.hash || !u.salt) return false;
  try { return crypto.timingSafeEqual(Buffer.from(gateHash(pw, u.salt)), Buffer.from(u.hash)); } catch (_) { return false; }
}
function gateSign(secret, userId) {
  const exp = Date.now() + 12 * 3600 * 1000;                                  // อายุ 12 ชม.
  const payload = `${userId}|${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64');
}
function gateDecode(secret, token) {
  try {
    const [uid, exp, sig] = Buffer.from(token, 'base64').toString().split('|');
    if (!uid || !exp || !sig || Date.now() > Number(exp)) return null;
    const good = crypto.createHmac('sha256', secret).update(`${uid}|${exp}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? { userId: uid } : null;
  } catch (_) { return null; }
}
function gateIsLoopback(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
// งาน sensitive (จัดการ user / ปิดล็อก) — localhost หรือ token ของ user ที่ล็อกอินอยู่ (กู้รหัส §33.4)
function gateAuthed(req, g) {
  const tok = (req.body && req.body.token) || (req.query && req.query.token) || '';
  return gateIsLoopback(req) || !!gateDecode(g.secret, tok);
}

app.get('/api/access-gate', (_req, res) => {
  const g = readGate();
  res.json({ frontendLogin: g.frontendLogin === true, users: (g.users || []).map(u => ({ id: u.id, name: u.name || u.id })) });
});
// เปิด/ปิดล็อก
app.put('/api/access-gate', (req, res) => {
  try {
    const g = readGate(); const b = req.body || {};
    if (typeof b.frontendLogin === 'boolean') {
      if (b.frontendLogin) {
        if (!(g.users && g.users.length)) return res.status(400).json({ ok: false, error: 'ต้องมีผู้ใช้อย่างน้อย 1 คนก่อนเปิดล็อก' });
      } else if (!gateAuthed(req, g)) {                       // ปิดล็อก = sensitive
        return res.status(403).json({ ok: false, error: 'ต้องล็อกอินอยู่ หรือทำจากเครื่อง server (localhost)' });
      }
      g.frontendLogin = b.frontendLogin; writeGate(g);
    }
    res.json({ ok: true, frontendLogin: g.frontendLogin === true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// เพิ่ม/แก้ user · คนแรก (ยังไม่มี user) = open (bootstrap) · มี user แล้ว = ต้อง authed
//   มี password → ตั้ง/เปลี่ยนรหัส · ไม่มี password (เฉพาะ user ที่มีอยู่) → แก้ชื่ออย่างเดียว (คงรหัสเดิม)
app.post('/api/access-gate/users', (req, res) => {
  try {
    const g = readGate(); const b = req.body || {};
    const id = String(b.id || '').trim();
    if (!id || /[|]/.test(id)) return res.status(400).json({ ok: false, error: 'user id ไม่ถูกต้อง (ห้ามมี | และห้ามว่าง)' });
    const existing = gateUser(g, id);
    if (!b.password && !existing) return res.status(400).json({ ok: false, error: 'ผู้ใช้ใหม่ต้องใส่รหัสผ่าน' });
    if (g.users.length > 0 && !gateAuthed(req, g)) return res.status(403).json({ ok: false, error: 'ต้องล็อกอินอยู่ หรือทำจากเครื่อง server (localhost)' });
    if (!g.secret) g.secret = crypto.randomBytes(32).toString('hex');
    let salt, hash;
    if (b.password) { salt = crypto.randomBytes(16).toString('hex'); hash = gateHash(b.password, salt); }
    else { salt = existing.salt; hash = existing.hash; }     // แก้ชื่อเท่านั้น → คงรหัสเดิม
    const rec = { id, name: String(b.name || id).trim(), salt, hash };
    const i = g.users.findIndex(u => u.id === id);
    if (i >= 0) g.users[i] = rec; else g.users.push(rec);
    writeGate(g);
    res.json({ ok: true, users: g.users.map(u => ({ id: u.id, name: u.name })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/access-gate/users/:id', (req, res) => {
  try {
    const g = readGate();
    if (!gateAuthed(req, g)) return res.status(403).json({ ok: false, error: 'ต้องล็อกอินอยู่ หรือทำจากเครื่อง server (localhost)' });
    g.users = (g.users || []).filter(u => u.id !== req.params.id);
    if (!g.users.length) g.frontendLogin = false;            // ไม่มี user แล้ว → ปิดล็อกกัน lockout
    writeGate(g);
    res.json({ ok: true, frontendLogin: g.frontendLogin === true, users: g.users.map(u => ({ id: u.id, name: u.name })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/access-gate/verify', (req, res) => {
  const g = readGate(); const id = String(req.body?.id || '').trim();
  if (gateVerifyUser(g, id, req.body?.password)) {
    const u = gateUser(g, id);
    logActivity(req, { category: 'auth', action: 'login', user: u.name || u.id, detail: 'designer (gate)', result: 'ok' });
    return res.json({ ok: true, token: gateSign(g.secret, id), id: u.id, name: u.name || u.id });
  }
  logActivity(req, { category: 'auth', action: 'login', user: id || '-', detail: 'designer (gate)', result: 'fail' });
  res.status(401).json({ ok: false, error: 'user id หรือรหัสผ่านไม่ถูกต้อง' });
});
app.get('/api/access-gate/check', (req, res) => {
  const g = readGate();
  if (!g.frontendLogin) return res.json({ required: false, ok: true });
  const d = gateDecode(g.secret, req.query.token || '');
  const u = d && gateUser(g, d.userId);                       // user ต้องยังมีอยู่
  res.json({ required: true, ok: !!u, user: u ? { id: u.id, name: u.name || u.id } : null });
});

// GET /api/fs/list?path=<dir> — list โฟลเดอร์ย่อยบนเครื่อง server (สำหรับปุ่ม Browse)
//   คืน { ok, path(resolved), parent(null=ราก), home, sep, platform, roots:[{name,path}], dirs:[{name,path}] }
app.get('/api/fs/list', (req, res) => {
  const plat = process.platform;
  const base = { home: os.homedir(), sep: path.sep, platform: plat, roots: _quickRoots() };
  let p = (req.query.path || '').toString().trim();
  if (!p) p = csvUtil.getBase() || os.homedir();
  try {
    p = path.resolve(p);
    const dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => { try { return e.isDirectory(); } catch (_) { return false; } })
      .filter((e) => !_isHiddenDir(e.name, plat))
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(p);
    res.json({ ok: true, path: p, parent: parent === p ? null : parent, ...base, dirs });
  } catch (e) {
    // คืน roots/home มาด้วยแม้ error → dialog ยังสลับไดรฟ์/กลับ home ได้
    res.status(400).json({ ok: false, error: e.message, path: p, ...base });
  }
});

// ── Save / Load project (export/import ทั้ง base dir เป็น zip) ─────────────────────
const crypto = require('crypto');
const KPE_MAGIC = Buffer.from('KPEENC1\0');   // header ไฟล์เข้ารหัส (.kpe)
// มาส์ก field ลับใน JSON (recursive) — คีย์ที่เข้าข่าย pass/secret/salt/token
function _deepMaskSecrets(obj) {
  if (Array.isArray(obj)) return obj.map(_deepMaskSecrets);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = /pass|secret|salt|token/i.test(k) && (typeof v === 'string' || v == null) ? '' : _deepMaskSecrets(v);
    }
    return out;
  }
  return obj;
}
// เข้ารหัสทั้ง buffer ด้วย passphrase (scrypt → AES-256-GCM) → container: magic|salt|iv|tag|cipher
function _encryptProject(buf, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([KPE_MAGIC, salt, iv, cipher.getAuthTag(), enc]);
}
function _isEncrypted(buf) {
  return buf.length > KPE_MAGIC.length && buf.subarray(0, KPE_MAGIC.length).equals(KPE_MAGIC);
}
function _decryptProject(buf, pass) {
  let o = KPE_MAGIC.length;
  const salt = buf.subarray(o, o += 16);
  const iv = buf.subarray(o, o += 12);
  const tag = buf.subarray(o, o += 16);
  const enc = buf.subarray(o);
  const key = crypto.scryptSync(pass, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// GET /api/project/export?logs=1&secrets=include|mask|encrypt  (encrypt: header X-KPE-Pass)
// ── Project sections (export/import เลือกเฉพาะส่วน) — logic อยู่ใน projectSections.js (ใช้ร่วมกับ test) ──
const { parseSections: _projParseSections, includeRel: _projInclude } = require('./projectSections');
function _walkRel(dir, prefix) {    // เดินไฟล์ recursive → [{abs, name(relative)}] (รวม subdir เช่น lines/)
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    const abs = path.join(dir, n);
    let st; try { st = fs.statSync(abs); } catch (_) { continue; }
    const rel = prefix ? `${prefix}/${n}` : n;
    if (st.isDirectory()) out.push(..._walkRel(abs, rel));
    else if (st.isFile()) out.push({ abs, name: rel });
  }
  return out;
}

app.get('/api/project/export', (req, res) => {
  try {
    const base = csvUtil.getBase();
    const withLogs = req.query.logs === '1' || req.query.logs === 'true';
    const secrets = (req.query.secrets || 'include').toString();
    const sel = _projParseSections(req.query.sections);
    const zip = new AdmZip();
    // config/ — recursive (รวม subdir เช่น lines/) · กรองตาม section · มาส์กถ้า secrets=mask
    const cfgDir = path.join(base, 'config');
    if (fs.existsSync(cfgDir)) {
      for (const f of _walkRel(cfgDir, '')) {
        const rel = `config/${f.name}`;
        if (!_projInclude(rel, sel)) continue;
        let content = fs.readFileSync(f.abs);
        if (secrets === 'mask' && f.name.endsWith('.json')) {
          try { content = Buffer.from(JSON.stringify(_deepMaskSecrets(JSON.parse(content.toString('utf8'))), null, 2)); }
          catch (_) {}
        }
        zip.addFile(rel, content);
      }
    }
    // layout/ — dashboard design (อยู่ใน section core)
    if (_projInclude('layout/', sel)) {
      const layDir = path.join(base, 'layout');
      if (fs.existsSync(layDir)) zip.addLocalFolder(layDir, 'layout');
    }
    // ports.json (root) — host config (พอร์ต/TLS) อยู่ใน core · ใส่ที่ระดับ root ของ zip
    //   (import จะกู้คืนเฉพาะเมื่อผู้ใช้เลือก ?ports=1 — host-specific, ต้อง restart)
    if (_projInclude('ports.json', sel)) {
      try {
        if (portsCfg.FILE && fs.existsSync(portsCfg.FILE)) {
          let pc = fs.readFileSync(portsCfg.FILE);
          if (secrets === 'mask') {
            try { pc = Buffer.from(JSON.stringify(_deepMaskSecrets(JSON.parse(pc.toString('utf8'))), null, 2)); } catch (_) {}
          }
          zip.addFile('ports.json', pc);
        }
      } catch (_) {}
    }
    // datalog/ — ไม่มี secret, ใส่ทั้งโฟลเดอร์ถ้าขอ logs (อยู่ใน core)
    if (withLogs && _projInclude('datalog/', sel)) {
      const logDir = path.join(base, 'datalog');
      if (fs.existsSync(logDir)) zip.addLocalFolder(logDir, 'datalog');
    }
    let buf = zip.toBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    let ext = 'zip';
    if (secrets === 'encrypt') {
      const pass = req.get('X-KPE-Pass') || '';
      if (!pass) return res.status(400).json({ ok: false, error: 'โหมดเข้ารหัส — ต้องใส่รหัสผ่าน' });
      buf = _encryptProject(buf, pass);
      ext = 'kpe';
    }
    res.setHeader('Content-Type', secrets === 'encrypt' ? 'application/octet-stream' : 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="kpe-project-${stamp}.${ext}"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/project/import (body = zip ดิบ หรือ .kpe เข้ารหัส) → extract ทับ base + live-reload
//   เข้ารหัส: ส่ง passphrase ผ่าน header X-KPE-Pass
app.post('/api/project/import', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
  try {
    let buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'ไม่มีข้อมูลไฟล์' });
    // ถอดรหัสถ้าเป็นไฟล์ .kpe เข้ารหัส
    if (_isEncrypted(buf)) {
      const pass = req.get('X-KPE-Pass') || '';
      if (!pass) return res.status(400).json({ ok: false, error: 'ไฟล์เข้ารหัส — ต้องใส่รหัสผ่าน' });
      try { buf = _decryptProject(buf, pass); }
      catch (_) { return res.status(400).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง หรือไฟล์เสียหาย' }); }
    }
    let zip;
    try { zip = new AdmZip(buf); } catch (_) { return res.status(400).json({ ok: false, error: 'ไฟล์ zip ไม่ถูกต้อง' }); }
    const entries = zip.getEntries();
    if (!entries.some((e) => e.entryName.startsWith('config/'))) {
      return res.status(400).json({ ok: false, error: 'ไม่ใช่ไฟล์โปรเจกต์ KPE (ไม่พบโฟลเดอร์ config/)' });
    }
    const base = csvUtil.getBase();
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    const restorePorts = req.query.ports === '1' || req.query.ports === 'true';

    // ports.json อยู่ที่ระดับ root ของ zip (host config นอก base) — ดึงออกก่อน extract
    //   ไม่ให้ extractAllTo เขียนทับ ports จริงโดยอัตโนมัติ (กู้คืนเฉพาะเมื่อ restorePorts)
    const portsEntry = entries.find((e) => e.entryName === 'ports.json');
    const portsBuf = portsEntry ? portsEntry.getData() : null;
    if (portsEntry) { try { zip.deleteFile('ports.json'); } catch (_) {} }

    // เลือกกู้คืนเฉพาะ section ที่ขอ (ว่าง = ทั้งหมด · devices.json=shared เข้าเสมอ) — ลบ entry ที่ไม่เลือกออกจาก zip ก่อน extract
    const selImp = _projParseSections(req.query.sections);
    if (selImp.length) {
      for (const e of entries) {
        if (e.entryName === 'ports.json') continue;               // จัดการแยกแล้ว
        if (!_projInclude(e.entryName, selImp)) { try { zip.deleteFile(e.entryName); } catch (_) {} }
      }
    }

    // snapshot ของเดิม (config+layout+ports) ก่อนเขียนทับ → กู้คืนได้ถ้า import ผิด
    try {
      const snap = new AdmZip();
      for (const d of ['config', 'layout']) {
        const dir = path.join(base, d);
        if (fs.existsSync(dir)) snap.addLocalFolder(dir, d);
      }
      if (portsCfg.FILE && fs.existsSync(portsCfg.FILE)) snap.addLocalFile(portsCfg.FILE, '');
      const snapDir = path.join(base, 'datalog', '_pre-import');
      fs.mkdirSync(snapDir, { recursive: true });
      snap.writeZip(path.join(snapDir, `before-import-${Date.now()}.zip`));
      // เก็บแค่ 10 ชุดล่าสุด (กันบวม)
      const olds = fs.readdirSync(snapDir).filter((f) => f.endsWith('.zip')).sort();
      for (const f of olds.slice(0, -10)) { try { fs.unlinkSync(path.join(snapDir, f)); } catch (_) {} }
    } catch (_) {}

    zip.extractAllTo(base, true);   // overwrite (ports.json ถูกดึงออกแล้ว — ไม่ปนลง base)

    // live-reload ทุก engine จาก config ที่เพิ่ง import (ไม่ต้อง restart)
    const failed = [];
    if (restorePorts && portsBuf) {
      // host-specific — เขียนทับ ports จริงตามที่ผู้ใช้เลือก (มีผลหลัง restart เท่านั้น)
      try { fs.writeFileSync(portsCfg.FILE, portsBuf); } catch (_) { failed.push('ports'); }
    }
    try { dbManager._load(); } catch (_) { failed.push('databases'); }
    try { authManager._loadConfig(); } catch (_) { failed.push('auth'); }
    try { alarmEngine.reload(); } catch (_) { failed.push('alarms'); }
    try { deviceLogger._load(); deviceLogger._loadJournalFromCsv(); } catch (_) { failed.push('device-log'); }
    try { scriptEngine.reload(); } catch (_) { failed.push('scripts'); }
    try { activityLog._load(); activityLog._loadJournalFromCsv(); } catch (_) { failed.push('activity-log'); }
    try { dbBackup.stop(); dbBackup._load(); dbBackup.start(); } catch (_) { failed.push('db-backup'); }
    try { kpeNet.reload(); } catch (_) { failed.push('kpenetwork'); }
    try { datalogManager.reload(); } catch (_) { failed.push('datalogs'); }
    try { queryBufferManager.reload(); } catch (_) { failed.push('querybuffers'); }
    try { powerManager.reload(); } catch (_) { failed.push('powermeters'); }
    try { timeSyncManager.reload(); } catch (_) { failed.push('timesync'); }
    try { stockManager.reload(); } catch (_) { failed.push('stock'); }
    try { await engine.reload(); } catch (_) { failed.push('devices'); }
    // ports ต้อง restart ถึงมีผล → ถ้ากู้คืน ports แนะนำ restart เสมอ
    const portsRestored = restorePorts && portsBuf && !failed.includes('ports');
    res.json({ ok: true, files: zip.getEntries().length, reloaded: failed.length === 0,
      restartRecommended: failed.length > 0 || portsRestored, portsRestored, failed });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Chart history (widget Chart) — conn ว่าง = โหมด CSV (ไฟล์รายวันที่ root) ──────────
// POST /api/chart/log     { conn, table, samples:[{device,tag,value,ts?}] }
app.post('/api/chart/log', async (req, res) => {
  try {
    const { conn, table, samples } = req.body || {};
    if (conn) res.json(await chartStore.log(conn, table, samples));
    else res.json(chartStore.logCsv(table, samples));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// POST /api/chart/history { conn, table, series:[{device,tag}], windowSec, limit }
app.post('/api/chart/history', async (req, res) => {
  try {
    const { conn, table, series, windowSec, limit } = req.body || {};
    const rows = conn
      ? await chartStore.history(conn, table, series, windowSec, limit)
      : chartStore.historyCsv(table, series, windowSec, limit);
    res.json({ ok: true, rows });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// GET /api/chart/export?table=<csvId>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   รวมไฟล์ CSV รายวันของกราฟ (datalog/chart-logs/chart-<table>-*.csv) ในช่วงวันที่ → ดาวน์โหลด
app.get('/api/chart/export', (req, res) => {
  try {
    const table = (req.query.table || '').toString().trim();
    if (!table) return res.status(400).json({ ok: false, error: 'no table' });
    const from = (req.query.from || '').toString();   // YYYY-MM-DD (ว่าง=ไม่จำกัด)
    const to   = (req.query.to   || '').toString();
    const safe = table.replace(/[^a-zA-Z0-9_]/g, '') || 'chart_history';
    const dir = csvUtil.csvDir('chart-logs');
    const files = csvUtil.listDailyFiles(dir, `chart-${safe}`).filter((f) => {
      const m = f.match(/(\d{4}-\d{2}-\d{2})\.csv$/);
      if (!m) return false;
      if (from && m[1] < from) return false;
      if (to && m[1] > to) return false;
      return true;
    });
    let out = 'timestamp,device,tag,value\n';
    for (const f of files) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      const lines = txt.split(/\r?\n/).filter(Boolean);
      for (let i = 1; i < lines.length; i++) out += lines[i] + '\n';   // ข้าม header แต่ละไฟล์
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chart-${safe}-${from || 'all'}_${to || 'all'}.csv"`);
    res.send(out);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Named datalog registry (สร้างชื่อ log ก่อน แล้วอ้างชื่อไปแสดง) ─────────────────────
// GET    /api/datalogs            → { ok, logs:[...] }
// POST   /api/datalogs            { name, series, storage, dbConn, sampleMs, retentionDays, enabled }
// PUT    /api/datalogs/:id        (patch)
// DELETE /api/datalogs/:id
// GET    /api/datalogs/:id/history?windowSec=&limit=  → { ok, log, rows }
app.get('/api/datalogs', (req, res) => {
  res.json({ ok: true, logs: datalogManager.list() });
});
app.post('/api/datalogs', (req, res) => {
  try {
    const log = datalogManager.create(req.body || {});
    logActivity(req, { category: 'config', action: 'datalog_create', target: log.name, detail: log.id });
    res.json({ ok: true, log });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/datalogs/:id', (req, res) => {
  try {
    const log = datalogManager.update(req.params.id, req.body || {});
    logActivity(req, { category: 'config', action: 'datalog_update', target: log.name, detail: log.id });
    res.json({ ok: true, log });
  } catch (e) {
    const code = e.message === 'not found' ? 404 : 400;
    res.status(code).json({ ok: false, error: e.message });
  }
});
app.delete('/api/datalogs/:id', (req, res) => {
  const existing = datalogManager.get(req.params.id);
  const ok = datalogManager.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  logActivity(req, { category: 'config', action: 'datalog_delete', target: existing ? existing.name : req.params.id, detail: req.params.id });
  res.json({ ok: true });
});
app.get('/api/datalogs/:id/history', async (req, res) => {
  try {
    const out = await datalogManager.history(req.params.id, {
      windowSec: req.query.windowSec != null ? Number(req.query.windowSec) : undefined,
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      fromMs: req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
      toMs: req.query.toMs != null ? Number(req.query.toMs) : undefined,
    });
    if (!out.ok) return res.status(404).json(out);
    res.json(out);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// เพิ่มหมายเหตุ (annotation · comment พิมพ์เอง) — body { comment, ts? }
app.post('/api/datalogs/:id/annotation', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await datalogManager.addAnnotation(req.params.id, b.comment, b.ts);
    if (!out.ok) return res.status(out.error === 'not found' ? 404 : 400).json(out);
    res.json(out);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Power meters — คำนวณ kW/kWh/ค่าไฟ จาก tag (1ph/3ph · vi/kw/kwh) → virtual tag + หน้า Power ──
app.get('/api/powermeters', (_req, res) => res.json({ ok: true, meters: powerManager.list() }));
app.get('/api/powermeters/live', (_req, res) => res.json({ ok: true, meters: powerManager.live() }));

// ── Time sync (peer clock) — master expose เวลา · follower poll มาแก้ (ดู docs/TIME-SYNC-PLAN.md) ──
app.get('/api/time', (_req, res) => {   // master endpoint (exempt token+license · ทุก node เปิดได้)
  const now = Date.now();
  res.json({ ok: true, epoch: now, iso: new Date(now).toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', mono: Number(process.hrtime.bigint() / 1000000n) });
});
app.get('/api/timesync', (_req, res) => res.json({ ok: true, config: timeSyncManager.getConfig() }));
app.get('/api/timesync/status', (_req, res) => res.json({ ok: true, status: timeSyncManager.getStatus() }));
app.put('/api/timesync', (req, res) => {
  try { const c = timeSyncManager.setConfig(req.body || {}); logActivity(req, { category: 'config', action: 'timesync_config', detail: `role=${c.role} setClock=${c.setClock} enabled=${c.enabled}` }); res.json({ ok: true, config: c }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/powermeters', (req, res) => {
  try {
    const m = powerManager.create(req.body || {});
    logActivity(req, { category: 'config', action: 'powermeter_create', target: m.name, detail: m.id });
    res.json({ ok: true, meter: m });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/powermeters/:id', (req, res) => {
  try {
    const m = powerManager.update(req.params.id, req.body || {});
    logActivity(req, { category: 'config', action: 'powermeter_update', target: m.name, detail: m.id });
    res.json({ ok: true, meter: m });
  } catch (e) { res.status(e.message === 'not found' ? 404 : 400).json({ ok: false, error: e.message }); }
});
app.delete('/api/powermeters/:id', (req, res) => {
  const existing = powerManager.get(req.params.id);
  if (!powerManager.remove(req.params.id)) return res.status(404).json({ ok: false, error: 'not found' });
  logActivity(req, { category: 'config', action: 'powermeter_delete', target: existing ? existing.name : req.params.id, detail: req.params.id });
  res.json({ ok: true });
});
app.post('/api/powermeters/:id/reset', (req, res) => {
  if (!powerManager.reset(req.params.id)) return res.status(404).json({ ok: false, error: 'not found' });
  logActivity(req, { category: 'config', action: 'powermeter_reset', target: req.params.id });
  res.json({ ok: true });
});

// ── Stock for Chemical Factory — Master(Group/Item)/Lot/Balance · movement(receive/issue/adjust/transfer/return) · reorder/expiry ──
const _se = (res, e) => res.status(e.message === 'not found' ? 404 : 400).json({ ok: false, error: e.message });
const _byUser = (req) => (req.headers['x-kpe-user'] ? decodeURIComponent(String(req.headers['x-kpe-user'])) : '');
const _reqIp = (req) => ((req && (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress))) || '').toString().split(',')[0].trim();
// §C8/§A: resolve actor + IP เสมอ (server-side · กันปลอม — ห้ามรับจาก body)
//   login (x-kpe-user ≠ '-') → actor=ชื่อ · actorType='user' · +ip
//   ไม่ login                → actor='guest' · actorType='guest' · +ip
//   ip เก็บทุกกรณี → audit ได้แม้ไม่รู้ตัวคน (เช่น หน้า TV/ไม่ล็อก)
function resolveActor(req) {
  const u = _byUser(req).trim();
  const ip = _reqIp(req);
  if (u && u !== '-') return { actor: u, actorType: 'user', ip };
  return { actor: 'guest', actorType: 'guest', ip };
}

// Groups (taxonomy + defaults สืบทอด)
app.get('/api/stock/groups', (_req, res) => res.json({ ok: true, groups: stockManager.listGroups() }));
app.post('/api/stock/groups', (req, res) => { try { const g = stockManager.createGroup(req.body || {}); logActivity(req, { category: 'config', action: 'stock_group_create', target: g.name, detail: g.groupCode }); res.json({ ok: true, group: g }); } catch (e) { _se(res, e); } });
app.put('/api/stock/groups/:code', (req, res) => { try { const g = stockManager.updateGroup(req.params.code, req.body || {}); logActivity(req, { category: 'config', action: 'stock_group_update', target: g.name || req.params.code, detail: req.params.code }); res.json({ ok: true, group: g }); } catch (e) { _se(res, e); } });
app.delete('/api/stock/groups/:code', (req, res) => { try { if (!stockManager.removeGroup(req.params.code)) return res.status(404).json({ ok: false, error: 'not found' }); logActivity(req, { category: 'config', action: 'stock_group_delete', target: req.params.code }); res.json({ ok: true }); } catch (e) { _se(res, e); } });

// Items (master · key = MATCODE)
app.get('/api/stock/items', (_req, res) => { const ar = stockManager.autorackMats(); res.json({ ok: true, items: stockManager.listItems().map((it) => ({ ...it, inAutorack: ar.has(String(it.MATCODE)) })) }); });
app.get('/api/stock/overview', (_req, res) => res.json({ ok: true, items: stockManager.overview() }));
app.get('/api/stock/items/:matcp', (req, res) => { const it = stockManager.getItem(req.params.matcp); if (!it) return res.status(404).json({ ok: false, error: 'not found' }); res.json({ ok: true, item: it, effective: stockManager.effectiveItem(req.params.matcp) }); });
app.post('/api/stock/items', (req, res) => { try { const it = stockManager.createItem(req.body || {}); logActivity(req, { category: 'config', action: 'stock_item_create', target: it.name, detail: it.MATCODE }); res.json({ ok: true, item: it }); } catch (e) { _se(res, e); } });
app.put('/api/stock/items/:matcp', (req, res) => { try { const it = stockManager.updateItem(req.params.matcp, req.body || {}); logActivity(req, { category: 'config', action: 'stock_item_update', target: it.name, detail: it.MATCODE }); res.json({ ok: true, item: it }); } catch (e) { _se(res, e); } });
app.delete('/api/stock/items/:matcp', (req, res) => { try { if (!stockManager.removeItem(req.params.matcp)) return res.status(404).json({ ok: false, error: 'not found' }); logActivity(req, { category: 'config', action: 'stock_item_delete', target: req.params.matcp }); res.json({ ok: true }); } catch (e) { _se(res, e); } });

// Stocks (คลัง)
app.get('/api/stock/stocks', (req, res) => res.json({ ok: true, stocks: stockManager.listStocks(req.query.kind || null), levels: stockManager.storeLevels() }));
app.post('/api/stock/stocks', (req, res) => { try { const s = stockManager.createStock(req.body || {}); logActivity(req, { category: 'config', action: 'stock_node_create', target: s.name, detail: s.stockId }); res.json({ ok: true, stock: s }); } catch (e) { _se(res, e); } });
app.get('/api/stock/stocks/:id/detail', (req, res) => { try { res.json({ ok: true, ...stockManager.storeDetail(req.params.id) }); } catch (e) { _se(res, e); } });
app.put('/api/stock/stocks/:id', (req, res) => { try { const s = stockManager.updateStock(req.params.id, req.body || {}); logActivity(req, { category: 'config', action: 'stock_node_update', target: s.name || req.params.id, detail: s.stockId || req.params.id }); res.json({ ok: true, stock: s }); } catch (e) { _se(res, e); } });
app.delete('/api/stock/stocks/:id', (req, res) => { try { if (!stockManager.removeStock(req.params.id)) return res.status(404).json({ ok: false, error: 'not found' }); logActivity(req, { category: 'config', action: 'stock_node_delete', target: req.params.id }); res.json({ ok: true }); } catch (e) { _se(res, e); } });

// Lots + QC/COA gate
app.get('/api/stock/lots', (req, res) => res.json({ ok: true, lots: stockManager.listLots({ matcp: req.query.item || null, stockId: req.query.stockId || null, status: req.query.status || null }) }));
app.get('/api/stock/lots/:id/detail', (req, res) => { try { res.json({ ok: true, ...stockManager.lotDetail(req.params.id) }); } catch (e) { _se(res, e); } });
app.put('/api/stock/lots/:id/remarks', (req, res) => { try { const lot = stockManager.setLotRemarks(req.params.id, (req.body || {}).remarks); logActivity(req, { category: 'data', action: 'lot_remarks', target: lot.lotNo, detail: (lot.locationRemarks || []).join(' · ') }); res.json({ ok: true, lot }); } catch (e) { _se(res, e); } });
app.post('/api/stock/lots/:id/release', (req, res) => { try { const l = stockManager.releaseLot(req.params.id, { byUser: _byUser(req), ...(req.body || {}) }); logActivity(req, { category: 'data', action: 'stock_lot_release', target: l.lotNo, detail: l.lotId }); res.json({ ok: true, lot: l }); } catch (e) { _se(res, e); } });
app.post('/api/stock/lots/:id/qc', (req, res) => { try { const qc = stockManager.recordQc({ lotId: req.params.id, inspector: _byUser(req), ...(req.body || {}) }); logActivity(req, { category: 'data', action: 'lot_qc', target: req.params.id, detail: `${(req.body || {}).qcStatus || ''}` }); res.json({ ok: true, qc }); } catch (e) { _se(res, e); } });
app.post('/api/stock/lots/:id/coa', (req, res) => { try { const coa = stockManager.attachCoa({ lotId: req.params.id, issuedBy: _byUser(req), ...(req.body || {}) }); logActivity(req, { category: 'data', action: 'lot_coa', target: req.params.id, detail: `${(req.body || {}).coaRef || ''}` }); res.json({ ok: true, coa }); } catch (e) { _se(res, e); } });
app.get('/api/stock/coas', (req, res) => res.json({ ok: true, coas: stockManager.listCoas({ lotId: req.query.lot || null }) }));

// Production (consume rawmat FEFO → receive finished ใต้ MATCODE · rolled cost) + Sale (COGS + ship gate)
app.post('/api/stock/produce', (req, res) => { try { const a = resolveActor(req); const r = stockManager.produce({ ...(req.body || {}), byUser: a.actor, actorType: a.actorType, ip: a.ip }); logActivity(req, { category: 'data', action: 'stock_produce', target: req.body && req.body.outputItem, detail: `qty ${req.body && req.body.qty}` }); stockManager.evaluate(); res.json({ ok: true, result: r }); } catch (e) { _se(res, e); } });
app.post('/api/stock/sale', (req, res) => { try { const a = resolveActor(req); const r = stockManager.sale({ ...(req.body || {}), byUser: a.actor, actorType: a.actorType, ip: a.ip }); logActivity(req, { category: 'data', action: 'stock_sale', target: req.body && req.body.item, detail: `qty ${req.body && req.body.qty} → ${req.body && req.body.customerRef}` }); stockManager.evaluate(); res.json({ ok: true, result: r }); } catch (e) { _se(res, e); } });
// Picking List (ขาย/ส่งมอบ · concept เดียวกับ ARM) — import จาก PDF ก่อน · อนาคต API · ยิง batch → ตัด/ส่งมอบ
app.post('/api/stock/picking/import', (req, res) => { try { const b = req.body || {}; const r = pickingManager.import({ lines: b.lines || [], source: b.source || 'pdf' }); logActivity(req, { category: 'stock', action: 'picking_import', detail: `${r.count} บรรทัด · ${r.deliveries} delivery` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
// อัปโหลด PDF (base64) → backend แตกด้วย Python tool (ถอด barcode+text) → import · ต้องมี python3 + libs บนเครื่อง
app.post('/api/stock/picking/import-pdf', (req, res) => {
  try {
    const b64 = String((req.body || {}).pdfBase64 || '').replace(/^data:.*?;base64,/, '');
    if (!b64) return res.status(400).json({ ok: false, error: 'ไม่มีไฟล์ PDF (pdfBase64)' });
    const tmp = path.join(os.tmpdir(), `picking_${Date.now()}.pdf`);
    fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
    const script = path.join(__dirname, '..', '..', 'tools', 'import-picking-pdf.py');
    execFile('python3', [script, tmp, '--stdout'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err) return res.status(500).json({ ok: false, error: 'แตก PDF ไม่สำเร็จ (ตรวจ python3 + pypdf/zxing-cpp/pillow): ' + String(stderr || err.message).slice(0, 300) });
      let payload; try { payload = JSON.parse(stdout); } catch (e) { return res.status(500).json({ ok: false, error: 'อ่านผล parse ไม่ได้: ' + e.message }); }
      const r = pickingManager.import({ lines: payload.lines || [], source: 'pdf-upload' });
      logActivity(req, { category: 'stock', action: 'picking_import_pdf', detail: `${r.count} บรรทัด · ${r.deliveries} delivery` });
      res.json({ ok: true, ...r });
    });
  } catch (e) { _se(res, e); }
});
// version API — ดึง picking-out จาก SAP gateway (BAPI ZFMTM_CHEMICAL_PICKING_OUT) → import เข้า pickingManager (แทน PDF)
app.post('/api/stock/picking/pull', async (req, res) => {
  try {
    const b = req.body || {};
    const lines = await pickingSource.fetchPickingOut({ fromDate: b.from, toDate: b.to, invoiceNo: b.invoice || '', noCache: b.fresh === true || b.fresh === '1' });
    const MAX = 2000;   // gateway บางครั้งคืนทั้ง dataset (ไม่กรองตามวันให้แคบ) → กัน import/แสดงเยอะจน UI ค้าง
    if (lines.length > MAX) return res.status(413).json({ ok: false, error: `ดึงได้ ${lines.length} แถว (เกิน ${MAX}) — ช่วงกว้างเกินไป · ระบุเลข invoice หรือแคบช่วงวันที่` });
    const r = pickingManager.import({ lines, source: 'api' });
    logActivity(req, { category: 'stock', action: 'picking_pull', detail: `${r.count} บรรทัด · ${r.deliveries} delivery (${b.from}–${b.to}${b.invoice ? ' · inv ' + b.invoice : ''})` });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ ok: false, error: 'Picking API: ' + e.message }); }
});
app.get('/api/stock/picking/list', (req, res) => { try { res.json({ ok: true, lines: pickingManager.list({ delivery: req.query.delivery || null, pendingOnly: req.query.pending === '1' }) }); } catch (e) { _se(res, e); } });
app.get('/api/stock/picking/deliveries', (_req, res) => { try { res.json({ ok: true, deliveries: pickingManager.deliveries() }); } catch (e) { _se(res, e); } });
app.get('/api/stock/picking/by-tag', (req, res) => { try { const r = pickingManager.findByTag(req.query.scan || ''); res.json({ ok: true, scan: req.query.scan || '', parsed: { matCode: r.matCode, lot: r.lot }, lines: r.lines }); } catch (e) { _se(res, e); } });
// version API live — ดึงสดจาก gateway + enrich (master/shipped) โดยไม่ import (เหมือน ARM monitor) · widget/monitor poll ตัวนี้
app.get('/api/stock/picking/live', async (req, res) => {
  try {
    const sup = req.query.super === '1';
    const raw = await pickingSource.fetchPickingOut(sup
      ? { fromDate: _dmyAgo(_pkDays()), toDate: _dmyToday(), invoiceNo: '', noCache: req.query.fresh === '1' }
      : { fromDate: req.query.from, toDate: req.query.to, invoiceNo: req.query.invoice || '', noCache: req.query.fresh === '1' });
    const MAX = 2000;
    if (raw.length > MAX) return res.status(413).json({ ok: false, error: `ดึงได้ ${raw.length} แถว (เกิน ${MAX}) — แคบช่วงวันที่/ลด pickingFeedDays หรือระบุ invoice` });
    const lines = pickingManager.liveFilter(pickingManager.enrich(raw), sup ? {} : { scan: req.query.scan || '', pendingOnly: req.query.pending === '1' });   // super=1 → ไม่กรอง · widget filter invoice เอง
    res.json({ ok: true, lines, syncedAt: pickingSource.lastSyncAt() });
  } catch (e) { res.status(502).json({ ok: false, error: 'Picking API: ' + e.message }); }
});
app.post('/api/stock/picking/ship', (req, res) => {
  try {
    const b = req.body || {};
    let line = pickingManager.getLine(b.lineId);
    if (!line && b.line) line = pickingManager.enrich([b.line])[0];   // live mode: ใช้บรรทัดที่ widget ส่งมา (ยังไม่ import) · lineId เสถียร → dedup ทำงาน
    if (!line) return res.status(404).json({ ok: false, error: 'ไม่พบบรรทัด picking (lineId)' });
    if (!line.masterExists) return res.status(400).json({ ok: false, error: `ไม่มี master (MATCODE ${line.matCode}) — สร้างก่อน` });
    if (!(line.qty > 0)) return res.status(400).json({ ok: false, error: 'จำนวนเบิกขาย = 0 (ตรวจหน่วย/แพ็ก)' });
    if (stockManager.pickingIsShipped(line.lineId)) return res.status(409).json({ ok: false, error: 'บรรทัดนี้ส่งมอบไปแล้ว (ตัดซ้ำไม่ได้)', shipped: stockManager.pickingGetShipped(line.lineId) });
    // คลังที่ถือ batch นี้ (StoreFG) · ไม่งั้น fg แรก · override จาก body.stockId
    let stockId = b.stockId || stockManager.lotStockId(line.matCode, line.batch);
    if (!stockId || !stockManager.getStock(stockId)) { const fg = stockManager.stocks.filter((s) => s.kind !== 'container' && s.role === 'fg'); stockId = (fg[0] && fg[0].stockId); }
    if (!stockId) return res.status(400).json({ ok: false, error: 'ไม่มีคลัง StoreFG ให้ส่งมอบ' });
    const { actor: byUser, actorType, ip } = resolveActor(req);   // §C8/§A
    const r = stockManager.sale({ item: line.matCode, stockId, qty: line.qty, uom: line.uom, lotNo: line.batch || null,
      customerRef: line.shipToCode || line.shipTo, soRef: line.delivery, byUser, actorType, ip, saleMode: 'sell', override: b.override === true, srcMap: 'pickingShipped', srcKey: line.lineId });
    stockManager.pickingMarkShipped(line.lineId, { delivery: line.delivery, matCode: line.matCode, batch: line.batch, qty: line.qty, uom: line.uom, stockId, byUser });
    logActivity(req, { category: 'data', action: 'picking_ship', target: line.matCode, detail: `DLV ${line.delivery} ${line.batch} ${line.qty}${line.uom} → ${line.shipTo}` });
    stockManager.evaluate();
    res.json({ ok: true, lineId: line.lineId, matCode: line.matCode, batch: line.batch, qty: line.qty, uom: line.uom, stockId, customerRef: line.shipToCode || line.shipTo, delivery: line.delivery, movements: r.movements.length, remarks: (r.picked || []).flatMap((p) => p.remarks || []) });
  } catch (e) { _se(res, e); }
});
// Toll (§C3) — ของลูกค้าฝากค้าง (outstanding) + KPI ยอดส่งมอบ (own + toll)
app.get('/api/stock/toll/outstanding', (req, res) => { try { res.json({ ok: true, customers: stockManager.tollOutstanding({ customerRef: req.query.customer || null }) }); } catch (e) { _se(res, e); } });
app.get('/api/stock/sales-kpi', (req, res) => { try { res.json({ ok: true, kpi: stockManager.salesKpi({ from: req.query.from || null, to: req.query.to || null, item: req.query.item || null }) }); } catch (e) { _se(res, e); } });

// Container master (แยกจาก items) + bulk stock ตามสถานะ
app.get('/api/stock/containers', (_req, res) => res.json({ ok: true, containers: stockManager.listContainers() }));
app.post('/api/stock/containers', (req, res) => { try { const c = stockManager.createContainer(req.body || {}); logActivity(req, { category: 'config', action: 'stock_container_create', target: c.name, detail: c.containerId }); res.json({ ok: true, container: c }); } catch (e) { _se(res, e); } });
app.put('/api/stock/containers/:id', (req, res) => { try { const c = stockManager.updateContainer(req.params.id, req.body || {}); logActivity(req, { category: 'config', action: 'stock_container_update', target: c.name || req.params.id, detail: c.containerId || req.params.id }); res.json({ ok: true, container: c }); } catch (e) { _se(res, e); } });
app.delete('/api/stock/containers/:id', (req, res) => { try { if (!stockManager.removeContainer(req.params.id)) return res.status(404).json({ ok: false, error: 'not found' }); logActivity(req, { category: 'config', action: 'stock_container_delete', target: req.params.id }); res.json({ ok: true }); } catch (e) { _se(res, e); } });
app.get('/api/stock/container-stock', (_req, res) => res.json({ ok: true, summary: stockManager.containerSummary(), balances: stockManager.listContainerBalances() }));
app.post('/api/stock/container-move', (req, res) => {
  try {
    const a = resolveActor(req);
    const b = { ...(req.body || {}), byUser: a.actor, actorType: a.actorType, ip: a.ip };   // §C8/§A: actor + ip server-side (กันปลอม)
    let result;
    switch (b.op) {
      case 'receive': result = stockManager.containerReceive(b); break;
      case 'adjust':  result = stockManager.containerAdjust(b); break;
      case 'move':    result = stockManager.containerMove(b); break;
      default: throw new Error('container op ไม่ถูกต้อง (receive/adjust/move)');
    }
    logActivity(req, { category: 'data', action: 'stock_container_' + b.op, target: b.containerId });
    res.json({ ok: true, result });
  } catch (e) { _se(res, e); }
});

// Customers
app.get('/api/stock/customers', (_req, res) => res.json({ ok: true, customers: stockManager.listCustomers() }));
app.post('/api/stock/customers', (req, res) => { try { const c = stockManager.createCustomer(req.body || {}); logActivity(req, { category: 'config', action: 'stock_customer_create', target: c.name || c.id, detail: c.id || '' }); res.json({ ok: true, customer: c }); } catch (e) { _se(res, e); } });
app.put('/api/stock/customers/:id', (req, res) => { try { const c = stockManager.updateCustomer(req.params.id, req.body || {}); logActivity(req, { category: 'config', action: 'stock_customer_update', target: c.name || req.params.id, detail: req.params.id }); res.json({ ok: true, customer: c }); } catch (e) { _se(res, e); } });
app.delete('/api/stock/customers/:id', (req, res) => { try { if (!stockManager.removeCustomer(req.params.id)) return res.status(404).json({ ok: false, error: 'not found' }); logActivity(req, { category: 'config', action: 'stock_customer_delete', target: req.params.id }); res.json({ ok: true }); } catch (e) { _se(res, e); } });

// Movements — unified dispatch ตาม type (item = MATCODE)
app.get('/api/stock/movements', (req, res) => res.json({ ok: true, movements: stockManager.getMovements({ limit: Number(req.query.limit) || 200, item: req.query.item || null, stockId: req.query.stockId || null, prefixes: req.query.prefixes ? String(req.query.prefixes).split(',').map((s) => s.trim()).filter(Boolean) : null }) }));
// §H location tags (ตำแหน่งเก็บในโซน) — super user CRUD · เลือกตอนรับเข้า
app.get('/api/stock/location-tags', (_req, res) => res.json({ ok: true, tags: stockManager.listLocationTags() }));
app.post('/api/stock/location-tags', (req, res) => { try { const t = stockManager.addLocationTag(req.body || {}); logActivity(req, { category: 'config', action: 'loc_tag_add', detail: `${t.storeId}/${t.label}` }); res.json({ ok: true, tag: t }); } catch (e) { _se(res, e); } });
app.put('/api/stock/location-tags/:id', (req, res) => { try { const t = stockManager.updateLocationTag(req.params.id, req.body || {}); logActivity(req, { category: 'config', action: 'loc_tag_update', detail: `${(t && t.storeId) || ''}/${(t && t.label) || req.params.id}` }); res.json({ ok: true, tag: t }); } catch (e) { _se(res, e); } });
app.delete('/api/stock/location-tags/:id', (req, res) => { try { stockManager.removeLocationTag(req.params.id); logActivity(req, { category: 'config', action: 'loc_tag_delete', target: req.params.id }); res.json({ ok: true }); } catch (e) { _se(res, e); } });
app.get('/api/stock/history', (req, res) => res.json({ ok: true, movements: stockManager.readHistory({ from: req.query.from, to: req.query.to, item: req.query.item || null, stockId: req.query.stockId || null, type: req.query.type || null, ref: req.query.ref || null, limit: Number(req.query.limit) || 3000 }) }));
// ถอยรายการ (revoke) — เฉพาะผู้ใช้ใน allowlist (config.revokeUsers · csv) · ว่าง = ไม่มีใครถอยได้
app.post('/api/stock/movement/revoke', (req, res) => {
  try {
    const user = _byUser(req).trim();
    // ล็อกเฉพาะเมื่อมาจาก widget (operator-facing) · เมนู Chem Stock = admin (หัวหน้าสูงสุด) ไม่ล็อก
    if ((req.body || {}).context === 'widget') {
      const raw = String(stockManager.config.revokeUsers || '').trim();
      if (raw !== '*') {   // '*' = ทุกคนถอยได้ · ว่าง = ไม่มีใคร · อื่น = เฉพาะ allowlist
        const allow = raw.split(',').map((s) => s.trim()).filter(Boolean);
        if (!allow.length) return res.status(403).json({ ok: false, error: 'widget นี้ยังไม่ได้ตั้งผู้มีสิทธิ์ถอยรายการ (Setup → ผู้มีสิทธิ์ถอยรายการ)' });
        if (!user || !allow.includes(user)) return res.status(403).json({ ok: false, error: `ผู้ใช้ "${user || '-'}" ไม่มีสิทธิ์ถอยรายการบน widget` });
      }
    }
    const _a = resolveActor(req);
    const r = stockManager.revokeMovement((req.body || {}).mvId, { byUser: user || _a.actor, actorType: _a.actorType, ip: _a.ip, reason: (req.body || {}).reason });
    logActivity(req, { category: 'data', action: 'stock_revoke', detail: `revoke ${r.revoked} mv (batch ${r.batch})${r.external ? ' · cleared dedup' : ''} · ${(req.body || {}).reason || ''}` });
    res.json({ ok: true, ...r });
  } catch (e) { _se(res, e); }
});
app.get('/api/stock/card', (req, res) => { try { res.json({ ok: true, ...stockManager.getCard({ item: req.query.item, stockId: req.query.stockId || null, from: req.query.from, to: req.query.to }) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });

// ── master kill-switch: หยุดทุกแหล่งเชื่อมต่อภายนอก (ARM/SAP/PP) ───────────────
//   default ปิด (clone/install ใหม่ = ปิดเสมอ) · เปิดได้เฉพาะหน้า Setup
const EXT_PATHS = ['/api/stock/arm/', '/api/stock/sap/', '/api/stock/fg/', '/api/stock/cm/', '/api/stock/autorack/'];
app.use((req, res, next) => {
  if (!EXT_PATHS.some((p) => req.path.startsWith(p))) return next();
  if (stockManager.config.extEnabled === true) return next();
  return res.status(503).json({ ok: false, error: 'แหล่งเชื่อมต่อภายนอกถูกปิดอยู่ (เปิดที่หน้า Setup)', extDisabled: true });
});

// ── ARM (read-only) — เบิกวัตถุดิบจาก StoreRM ตาม production order ──────────────
// §C6 interim: เติม flag inAutorack ต่อ ARM line → widget โชว์ปุ่ม "wait autorack" (autorack auto เบิกเอง · ARM ตัดไม่ได้)
const _armAnnotate = (lines) => { const ar = stockManager.autorackMats(); return (lines || []).map((l) => ({ ...l, inAutorack: ar.has(String(l.matCode || '')) })); };
// §C6 interim: เติม flag lotInAutorack ต่อ receive line → widget block "รับโดย autorack แล้ว" (กันรับซ้ำ lot ที่ autorack มี)
const _annLotAutorack = (lines) => (lines || []).map((l) => ({ ...l, lotInAutorack: stockManager.lotInAutorack(l.matCode, l.lotNo) }));
app.get('/api/stock/arm/consumption', async (req, res) => { try { const sup = req.query.super === '1';
  res.json({ ok: true, lines: _armAnnotate(await armConnector.listConsumption(sup
    ? { limit: _armRows(), location: null, noCache: req.query.fresh === '1' }
    : { sinceId: req.query.sinceId, limit: req.query.limit, asc: req.query.asc === '1' || req.query.asc === 'true', location: req.query.location || null, noCache: req.query.fresh === '1' })), syncedAt: armConnector.lastSyncAt() }); } catch (e) { res.status(502).json({ ok: false, error: 'ARM: ' + e.message }); } });   // super=1 → ทั้งหมด ไม่กรอง location · widget filter เอง
app.get('/api/stock/arm/by-lot/:lot', async (req, res) => { try { const parsed = parseTag(req.params.lot); res.json({ ok: true, lot: req.params.lot, parsed, lines: _armAnnotate(await armConnector.findByLot(req.params.lot, req.query.location || null, { noCache: req.query.fresh === '1' })) }); } catch (e) { res.status(502).json({ ok: false, error: 'ARM: ' + e.message }); } });
app.get('/api/stock/arm/locations', async (_req, res) => { try { res.json({ ok: true, locations: await armConnector.listLocations() }); } catch (e) { res.status(502).json({ ok: false, error: 'ARM: ' + e.message }); } });
// ── autorack mirror (read-only · §C6) — ดึงสดจาก Oracle → snapshot เข้า 3 mirror store ────────
app.get('/api/stock/autorack/preview', async (req, res) => { try { const lines = await autorackConnector.listStock({ noCache: req.query.fresh === '1' }); res.json({ ok: true, count: lines.length, sample: lines.slice(0, 20) }); } catch (e) { res.status(502).json({ ok: false, error: 'autorack: ' + e.message }); } });
app.post('/api/stock/autorack/sync', async (req, res) => {   // [v2] = refresh AR flag (icon) + auto-receive ตาม gate · ไม่ snapshot
  try {
    const lines = await autorackConnector.listStock({ noCache: true });
    const r = stockManager.refreshAutorackFlags(lines);
    await autorackAutoReceive(lines);   // P2b (gated · off/log/on)
    stockManager.refreshAutorackFlags(lines);   // ติด flag lot ที่เพิ่ง auto-receive
    logActivity(req, { category: 'stock', action: 'autorack_flags', detail: `${r.flagged} lots in autorack (${r.autorackItems} items)` });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ ok: false, error: 'autorack: ' + e.message }); }
});
app.get('/api/stock/autorack/movements', async (req, res) => { try { const sup = req.query.super === '1';
  res.json({ ok: true, movements: await autorackConnector.listMovements(sup
    ? { days: _arDays(), limit: 5000, noCache: req.query.fresh === '1' }
    : { limit: req.query.limit, mat: req.query.mat || '', zone: req.query.zone || '', prefixes: req.query.prefixes || '', noCache: req.query.fresh === '1' }), syncedAt: autorackConnector.lastSyncAt() }); } catch (e) { res.status(502).json({ ok: false, error: 'autorack: ' + e.message }); } });   // super=1 → ทั้งหมด ไม่กรอง zone/mat · widget filter เอง
app.get('/api/stock/autorack/status', (_req, res) => { res.json({ ok: true, extEnabled: stockManager.config.extEnabled === true, enabled: stockManager.config.autorackEnabled === true, syncing: autorackConnector.busy(), conn: stockManager.config.autorackConn, syncSec: stockManager.config.autorackSyncSec || 0, lastSync: stockManager.config.autorackLastSync || 0, lastError: autorackConnector.lastError(), stores: stockManager.autorackStoreIds() }); });
// ── SAP incoming (read-only) — รับเข้าจาก SAP (QMI002 · QC accepted) ───────────
// SAP incoming แยก 2 zone ตาม prefix MATCODE: rm (rawmat/semi→StoreRM · เช่น 13) · fg (finished/merchandise→StoreFG · เช่น 91,11)
function _sapZone(matCode) { const it = stockManager.getItem(matCode); const cls = stockManager.classifyMatcode(matCode) || (it && it.itemType) || 'rawmat'; return stockManager._roleForItemType(cls) === 'rw' ? 'rm' : 'fg'; }
function _sapByCategory(lines, category) { const out = (lines || []).map((l) => ({ ...l, zone: _sapZone(l.matCode) })); return (category === 'rm' || category === 'fg') ? out.filter((l) => l.zone === category) : out; }
// ── B (chemstock ใหญ่สุด): superset feed — ดึงก้อนใหญ่สุด/ไม่กรอง cache key เดียวต่อ source → widget filter ในกรอบ buffer เอง ──
//   ?super=1 → backend ใช้ขนาดกลาง (config) · ทุก display-widget ของ source เดียวกันชนกุญแจเดียว = ดึง external ครั้งเดียวเลี้ยงทุกตัว
const _armRows = () => Math.max(1, Math.min(5000, Number(stockManager.config.armFeedRows) || 200));      // ARM = TOP N แถว
const _sapDays = () => Math.max(1, Math.min(366, Number(stockManager.config.sapFeedDays) || 7));         // SAP รับเข้า = window วัน
const _ppDays = () => Math.max(1, Math.min(366, Number(stockManager.config.ppFeedDays) || 7));           // PP = window วัน
const _pkDays = () => Math.max(1, Math.min(90, Number(stockManager.config.pickingFeedDays) || 7));       // picking = window วัน (กัน cap 2000)
const _arDays = () => Math.max(1, Math.min(366, Number(stockManager.config.autorackFeedDays) || 10));    // autorack = window วัน (movements)
function _dmyAgo(n) { const d = new Date(Date.now() - n * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; }
function _dmyToday() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; }
app.get('/api/stock/sap/incoming', async (req, res) => { try { const sup = req.query.super === '1';
  const lines = await sapReceive.listIncoming(sup
    ? { fromDate: _dmyAgo(_sapDays()), toDate: _dmyToday(), acceptedOnly: true, noCache: req.query.fresh === '1' }
    : { fromDate: req.query.from, toDate: req.query.to, material: req.query.material || '', batch: req.query.batch || '', lotNo: req.query.lotNo || '', acceptedOnly: req.query.all !== '1', noCache: req.query.fresh === '1' });
  res.json({ ok: true, lines: _annLotAutorack(_sapByCategory(lines, sup ? null : req.query.category)), syncedAt: sapReceive.lastSyncAt() }); } catch (e) { res.status(502).json({ ok: false, error: 'SAP: ' + e.message }); } });   // super=1 → attach zone ไม่กรอง · widget filter category เอง
// ยิง barcode receiving tag → หา INSP_LOT ที่ตรง (MATCODE+Lot) — scan รับเข้า (เหมือน ARM)
app.get('/api/stock/sap/by-tag', async (req, res) => { try { const r = await sapReceive.findByTag(req.query.scan || '', { fromDate: req.query.from || null, toDate: req.query.to || null }); res.json({ ok: true, scan: req.query.scan || '', parsed: { matCode: r.matCode, lot: r.lot }, lines: _annLotAutorack(_sapByCategory(r.lines, req.query.category)) }); } catch (e) { res.status(502).json({ ok: false, error: 'SAP: ' + e.message }); } });
// รับเข้าจริงตาม SAP INSP_LOT (re-query verify → สร้าง lot ใน StoreRM/FG ตาม itemType §C5) · รับครั้งเดียว (dedup)
app.post('/api/stock/sap/receive', async (req, res) => {
  try {
    const b = req.body || {};
    const line = await sapReceive.getIncoming(b.inspLot, { fromDate: b.from, toDate: b.to, material: b.material || '', batch: b.batch || '' });
    if (!line) return res.status(404).json({ ok: false, error: 'ไม่พบ INSP_LOT (ลองช่วงวันที่ให้ครอบ)' });
    if (!line.masterExists) return res.status(400).json({ ok: false, error: `ไม่มี master (MATCODE ${line.matCode}) — สร้าง master ก่อน` });
    if (!line.accepted) return res.status(400).json({ ok: false, error: 'ยังไม่ผ่าน QC (usage decision)' });
    if (!(line.qty > 0)) return res.status(400).json({ ok: false, error: 'ไม่มีจำนวนรับ' });
    if (stockManager.sapIsReceived(line.inspLot)) { const prev = stockManager.sapGetReceived(line.inspLot); return res.status(409).json({ ok: false, error: `INSP#${line.inspLot} รับเข้าไปแล้ว (รับซ้ำไม่ได้)`, received: prev }); }
    // [v2] เลิกบล็อก "รับโดย autorack แล้ว" — autorack ไม่เป็นใหญ่ · SAP receive ทำได้เสมอ · lot ได้ icon AR (info) แทน
    // คลังปลายทาง = StoreRM (rawmat) / StoreFG · จัดประเภทจาก MATCODE prefix (setup) ก่อน · fallback itemType ของ master
    const item = stockManager.getItem(line.matCode);
    const cls = stockManager.classifyMatcode(line.matCode) || (item && item.itemType) || 'rawmat';
    const role = stockManager._roleForItemType(cls);   // §C5: rawmat/semi→rw · อื่น→fg
    const stocks = stockManager.stocks.filter((s) => s.kind !== 'container' && s.role === role);
    const stockId = b.stockId || (stocks[0] && stocks[0].stockId);
    if (!stockId) return res.status(400).json({ ok: false, error: `ไม่มีคลัง role=${role} ให้รับเข้า` });
    const { actor: byUser, actorType, ip } = resolveActor(req);   // §C8/§A
    const r = stockManager.receive({ item: line.matCode, stockId, qty: line.qty, uom: line.uom, lotNo: line.lotNo,
      supplier: line.supplier, poRef: line.poRef, coaRef: `SAP-${line.inspLot}`, expiry: line.expiry || null, byUser, actorType, ip, note: `SAP INSP#${line.inspLot} ${line.matDoc}`, srcMap: 'sapReceived', srcKey: line.inspLot, locationRemarks: b.locationRemarks });
    stockManager.sapMarkReceived(line.inspLot, { matCode: line.matCode, lotNo: line.lotNo, qty: line.qty, uom: line.uom, stockId, poRef: line.poRef, byUser });
    sapReceive.invalidate();   // buffer → flag received สดทันที
    logActivity(req, { category: 'stock', action: 'sap_receive', target: line.matCode, detail: `SAP INSP#${line.inspLot} ${line.lotNo} ${line.qty}${line.uom} → ${stockId}` });
    res.json({ ok: true, inspLot: line.inspLot, matCode: line.matCode, lotNo: line.lotNo, qty: line.qty, uom: line.uom, stockId, lotId: r.lotId, lotStatus: (stockManager.getLot(r.lotId) || {}).status });
  } catch (e) { _se(res, e); }
});
app.get('/api/stock/arm/line/:id', async (req, res) => { try { const line = await armConnector.getById(req.params.id); res.json({ ok: true, line }); } catch (e) { res.status(502).json({ ok: false, error: 'ARM: ' + e.message }); } });
// ยืนยันตัดวัตถุดิบจาก StoreRM ตาม ARM order line (เลือกผ่าน scan/UI) · ตัดตาม lot ที่ ARM ระบุ · ref=OrderNo
app.post('/api/stock/arm/issue', async (req, res) => {
  try {
    const b = req.body || {};
    const line = await armConnector.getById(b.armId);
    if (!line) return res.status(404).json({ ok: false, error: 'ไม่พบ ARM line (ID นี้)' });
    if (!line.masterExists) return res.status(400).json({ ok: false, error: `ไม่มี master (MATCODE ${line.matCode}) — ต้องสร้าง master ก่อน` });
    if (!line.committed) return res.status(400).json({ ok: false, error: `ARM line ยังไม่ committed (${line.status})` });
    if (!line.lots.length) return res.status(400).json({ ok: false, error: 'ARM line ไม่มี lot/จำนวนให้ตัด' });
    // §C6 interim: item ที่อยู่ใน autorack → autorack auto เบิกเอง · ARM ตัดไม่ได้ (กันเบิกเกิน · รอเคาะ flow จริงกับ user)
    if (stockManager.inAutorack(line.matCode)) return res.status(409).json({ ok: false, error: `⏳ wait autorack — MATCODE ${line.matCode} อยู่ใน autorack (auto เบิกเอง) · ARM ตัดไม่ได้ (กันเบิกเกิน)`, waitAutorack: true });
    // ตัดแล้วต้องจำ · ตัดได้ครั้งเดียว (dedup by ARM ID)
    if (stockManager.armIsIssued(line.armId)) { const prev = stockManager.armGetIssued(line.armId); return res.status(409).json({ ok: false, error: `ARM#${line.armId} ตัดไปแล้ว (ตัดซ้ำไม่ได้)`, issued: prev }); }
    // คลังต้นทาง = StoreRM (kind product · role rw) · รับ override จาก body.stockId · ห้ามคลังภาชนะ
    const rwStocks = stockManager.stocks.filter((s) => s.kind !== 'container' && s.role === 'rw');
    const stockId = b.stockId || (rwStocks[0] && rwStocks[0].stockId);
    if (!stockId) return res.status(400).json({ ok: false, error: 'ไม่มีคลัง StoreRM (role rw) ให้ตัด' });
    const { actor: byUser, actorType, ip } = resolveActor(req);   // §C8/§A
    const issued = []; const negatives = [];
    const _armBatch = stockManager.newBatchId();   // ทุก lot ของ ARM นี้ = ชุดเดียว → ถอยทั้ง ARM พร้อมกัน
    for (const lot of line.lots) {
      const r = stockManager.issue({ item: line.matCode, stockId, qty: lot.qty, uom: line.uom,
        ref: line.orderNo, lotNo: lot.lotNo, byUser, actorType, ip, note: `ARM#${line.armId} ${line.matName}`, _batch: _armBatch, srcMap: 'armIssued', srcKey: line.armId });
      issued.push({ lotNo: lot.lotNo, qty: lot.qty, movements: r.movements.length, remarks: (r.picked || []).flatMap((p) => p.remarks || []) });
      if (r.wentNegative) negatives.push(...r.negatives);
    }
    stockManager.armMarkIssued(line.armId, { orderNo: line.orderNo, matCode: line.matCode, totalQty: line.totalQty, uom: line.uom, stockId, byUser });   // จำว่าตัดแล้ว
    armConnector.invalidate();   // buffer → flag issued สดทันที
    logActivity(req, { category: 'stock', action: 'arm_issue', target: line.orderNo, detail: `ARM#${line.armId} ${line.matCode} ${line.totalQty}${line.uom}` });
    res.json({ ok: true, armId: line.armId, orderNo: line.orderNo, matCode: line.matCode, stockId, issued, wentNegative: negatives.length > 0, negatives });
  } catch (e) { _se(res, e); }
});

app.post('/api/stock/movements', (req, res) => {
  try {
    const a = resolveActor(req);
    const b = { ...(req.body || {}), byUser: a.actor, actorType: a.actorType, ip: a.ip };   // §C8/§A: actor + ip server-side (override body · กันปลอม)
    let result;
    switch (b.type) {
      case 'receive':
        // [v2] เลิกบล็อก autorack — manual receive ได้เสมอ · lot ได้ icon AR (info)
        result = stockManager.receive(b); break;
      case 'issue':
        // §C6 interim: item ใน autorack → autorack auto เบิกเอง · เบิก/ตัด manual ไม่ได้ (กันเบิกเกิน · รอเคาะ flow จริง)
        if (stockManager.inAutorack(b.item)) throw new Error(`⏳ wait autorack — MATCODE ${b.item} อยู่ใน autorack (auto เบิกเอง) · เบิก/ตัดในระบบนี้ไม่ได้ (กันเบิกเกิน)`);
        result = stockManager.issue(b); break;
      case 'adjust':   result = stockManager.adjust(b); break;
      case 'transfer': result = stockManager.transfer(b); break;
      case 'return':   result = stockManager.returnStock(b); break;
      default: throw new Error('movement type ไม่ถูกต้อง');
    }
    logActivity(req, { category: 'data', action: 'stock_' + b.type, target: (stockManager.getItem(b.item) || {}).name || b.item, detail: `qty ${b.qty}${b.uom ? ' ' + b.uom : ''}` });
    stockManager.evaluate();
    res.json({ ok: true, result });
  } catch (e) { _se(res, e); }
});

// Reserve (IStockProvider · ใช้โดย PM/connector)
app.post('/api/stock/reserve', (req, res) => { try { res.json({ ok: true, reserved: stockProvider.reserve((req.body || {}).woId, (req.body || {}).items || []) }); } catch (e) { _se(res, e); } });
app.post('/api/stock/release', (req, res) => { try { res.json({ ok: true, released: stockProvider.release((req.body || {}).woId) }); } catch (e) { _se(res, e); } });

// Balance / alerts / summary / config / qr
app.get('/api/stock/balance/:matcp', (req, res) => { try { res.json({ ok: true, balance: stockManager.balance(req.params.matcp) }); } catch (e) { _se(res, e); } });
// Fuzzy — ค้นใกล้เคียง %q% ภายใน (master MATCODE/ชื่อ + lot)
app.get('/api/stock/search', (req, res) => { try { res.json({ ok: true, ...stockManager.searchMaster(req.query.q || '', { limit: Number(req.query.limit) || 50 }) }); } catch (e) { _se(res, e); } });
// Fuzzy ARM — SQL LIKE บน MATCODE/ชื่อ/lot
app.get('/api/stock/arm/search', async (req, res) => { try { res.json({ ok: true, lines: _armAnnotate(await armConnector.searchFuzzy(req.query.q || '', req.query.location || null)) }); } catch (e) { res.status(502).json({ ok: false, error: 'ARM: ' + e.message }); } });
app.get('/api/stock/alerts', (_req, res) => res.json({ ok: true, reorder: stockManager.reorderAlerts(), expiry: stockManager.expiryAlerts() }));
app.get('/api/stock/summary', (_req, res) => res.json({ ok: true, summary: stockManager.summary() }));
// import master + คลัง จาก SAP (bulk upsert · SAP-owned ทับ · local preserve) — seed/demo
app.post('/api/stock/import', (req, res) => { try { const b = req.body || {}; const r = stockManager.importMaster(b); logActivity(req, { category: 'stock', action: 'import_master', detail: `item +${r.itemNew}/~${r.itemUpd} · stock +${r.stockNew}/~${r.stockUpd}` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
// ── รับ FG (PP · read-only · FG only) ─────────────────────────────────────────
app.get('/api/stock/fg/incoming', async (req, res) => { try { const sup = req.query.super === '1';
  res.json({ ok: true, lines: _annLotAutorack(await ppReceive.listIncoming(sup
    ? { fromDate: _dmyAgo(_ppDays()), toDate: _dmyToday(), doneOnly: true, noCache: req.query.fresh === '1' }
    : { fromDate: req.query.from, toDate: req.query.to, doneOnly: req.query.all !== '1', noCache: req.query.fresh === '1' })), syncedAt: ppReceive.lastSyncAt() }); } catch (e) { res.status(502).json({ ok: false, error: 'PP: ' + e.message }); } });   // super=1 → window กลาง · widget filter เอง
app.get('/api/stock/fg/by-tag', async (req, res) => { try { const r = await ppReceive.findByTag(req.query.scan || '', { fromDate: req.query.from || null, toDate: req.query.to || null }); res.json({ ok: true, scan: req.query.scan || '', parsed: { matCode: r.matCode, lot: r.lot }, lines: _annLotAutorack(r.lines) }); } catch (e) { res.status(502).json({ ok: false, error: 'PP: ' + e.message }); } });
app.post('/api/stock/fg/receive', async (req, res) => {
  try {
    const b = req.body || {};
    const line = await ppReceive.getOrder(b.procOrder, { fromDate: b.from, toDate: b.to });
    if (!line) return res.status(404).json({ ok: false, error: 'ไม่พบ process order (ลองช่วงวันที่ให้ครอบ)' });
    if (line.itemType !== 'finished') return res.status(400).json({ ok: false, error: 'รับได้เฉพาะ FG (semi=parked)' });
    if (!line.masterExists) return res.status(400).json({ ok: false, error: `ไม่มี master (MATCODE ${line.matCode}) — สร้างก่อน` });
    if (!(line.qty > 0)) return res.status(400).json({ ok: false, error: 'ไม่มีจำนวนผลิต' });
    if (stockManager.ppIsReceived(line.procOrder)) { return res.status(409).json({ ok: false, error: `PO ${line.procOrder} รับ FG ไปแล้ว (รับซ้ำไม่ได้)`, received: stockManager.ppGetReceived(line.procOrder) }); }
    // [v2] เลิกบล็อก autorack — receive ได้เสมอ · lot ได้ icon AR (info)
    // คลังปลายทาง = STGE_LOC (FG) ถ้ามี · ไม่งั้น StoreFG ตัวแรก · รับ override จาก body.stockId
    let stockId = b.stockId || line.stgeLoc;
    if (!stockId || !stockManager.getStock(stockId)) { const fg = stockManager.stocks.filter((s) => s.kind !== 'container' && s.role === 'fg'); stockId = (fg[0] && fg[0].stockId); }
    if (!stockId) return res.status(400).json({ ok: false, error: 'ไม่มีคลัง StoreFG ให้รับ' });
    const { actor: byUser, actorType, ip } = resolveActor(req);   // §C8/§A
    const r = stockManager.receive({ item: line.matCode, stockId, qty: line.qty, uom: line.uom, lotNo: line.lotNo,
      poRef: line.procOrder, expiry: line.expiry || null, byUser, actorType, ip, note: `PP FG ${line.procOrder}`, srcMap: 'ppReceived', srcKey: line.procOrder, locationRemarks: b.locationRemarks });
    stockManager.ppMarkReceived(line.procOrder, { matCode: line.matCode, lotNo: line.lotNo, qty: line.qty, uom: line.uom, stockId, byUser });
    ppReceive.invalidate();
    logActivity(req, { category: 'stock', action: 'fg_receive', target: line.matCode, detail: `PP ${line.procOrder} ${line.lotNo} ${line.qty}${line.uom} → ${stockId}` });
    res.json({ ok: true, procOrder: line.procOrder, matCode: line.matCode, lotNo: line.lotNo, qty: line.qty, uom: line.uom, stockId, lotId: r.lotId });
  } catch (e) { _se(res, e); }
});
// ── รับ C (PP semi · prefix 12 → StoreCM) — concept เดียวกับ PPtoFG แค่ 11→12 · share PP buffer (key เดียว) · นาน ๆ ครั้ง ──
app.get('/api/stock/cm/incoming', async (req, res) => { try { const sup = req.query.super === '1';
  res.json({ ok: true, lines: _annLotAutorack(await ppReceive.listIncoming(sup
    ? { fromDate: _dmyAgo(_ppDays()), toDate: _dmyToday(), kind: 'cm', doneOnly: true, noCache: req.query.fresh === '1' }
    : { fromDate: req.query.from, toDate: req.query.to, kind: 'cm', doneOnly: req.query.all !== '1', noCache: req.query.fresh === '1' })), syncedAt: ppReceive.lastSyncAt() }); } catch (e) { res.status(502).json({ ok: false, error: 'PP-C: ' + e.message }); } });
app.get('/api/stock/cm/by-tag', async (req, res) => { try { const r = await ppReceive.findByTag(req.query.scan || '', { fromDate: req.query.from || null, toDate: req.query.to || null, kind: 'cm' }); res.json({ ok: true, scan: req.query.scan || '', parsed: { matCode: r.matCode, lot: r.lot }, lines: _annLotAutorack(r.lines) }); } catch (e) { res.status(502).json({ ok: false, error: 'PP-C: ' + e.message }); } });
app.post('/api/stock/cm/receive', async (req, res) => {
  try {
    const b = req.body || {};
    const line = await ppReceive.getOrder(b.procOrder, { fromDate: b.from, toDate: b.to });
    if (!line) return res.status(404).json({ ok: false, error: 'ไม่พบ process order (ลองช่วงวันที่ให้ครอบ)' });
    if (line.itemType !== 'semi') return res.status(400).json({ ok: false, error: 'รับ C ได้เฉพาะ semi (prefix 12)' });
    if (!line.masterExists) return res.status(400).json({ ok: false, error: `ไม่มี master (MATCODE ${line.matCode}) — สร้างก่อน` });
    if (!(line.qty > 0)) return res.status(400).json({ ok: false, error: 'ไม่มีจำนวนผลิต' });
    if (stockManager.ppIsReceived(line.procOrder)) { return res.status(409).json({ ok: false, error: `PO ${line.procOrder} รับไปแล้ว (รับซ้ำไม่ได้)`, received: stockManager.ppGetReceived(line.procOrder) }); }
    // [v2] เลิกบล็อก autorack — receive ได้เสมอ · lot ได้ icon AR (info)
    // คลังปลายทาง = STGE_LOC ถ้ามี · ไม่งั้น StoreCM (role=cm) ตัวแรก · override จาก body.stockId
    let stockId = b.stockId || line.stgeLoc;
    if (!stockId || !stockManager.getStock(stockId)) { const cm = stockManager.stocks.filter((s) => s.kind !== 'container' && s.role === 'cm'); stockId = (cm[0] && cm[0].stockId); }
    if (!stockId) return res.status(400).json({ ok: false, error: 'ไม่มีคลัง StoreCM (role=cm) ให้รับ' });
    const { actor: byUser, actorType, ip } = resolveActor(req);   // §C8/§A
    const r = stockManager.receive({ item: line.matCode, stockId, qty: line.qty, uom: line.uom, lotNo: line.lotNo,
      poRef: line.procOrder, expiry: line.expiry || null, byUser, actorType, ip, note: `PP C ${line.procOrder}`, srcMap: 'ppReceived', srcKey: line.procOrder, locationRemarks: b.locationRemarks });
    stockManager.ppMarkReceived(line.procOrder, { matCode: line.matCode, lotNo: line.lotNo, qty: line.qty, uom: line.uom, stockId, byUser });
    ppReceive.invalidate();
    logActivity(req, { category: 'stock', action: 'cm_receive', target: line.matCode, detail: `PP C ${line.procOrder} ${line.lotNo} ${line.qty}${line.uom} → ${stockId}` });
    res.json({ ok: true, procOrder: line.procOrder, matCode: line.matCode, lotNo: line.lotNo, qty: line.qty, uom: line.uom, stockId, lotId: r.lotId });
  } catch (e) { _se(res, e); }
});
// ── Master import/update (Excel ตอนนี้ · API อนาคต) — field-map layer · upsert by MATCODE · dryRun preview ──
const masterImport = require('./masterImport');
app.post('/api/stock/master/import', (req, res) => {
  try {
    const b = req.body || {};
    let rows = Array.isArray(b.rows) ? b.rows : null;
    if (!rows) { if (!b.fileBase64) return res.status(400).json({ ok: false, error: 'ต้องส่ง fileBase64 (Excel) หรือ rows' }); rows = masterImport.rowsFromBase64(b.fileBase64, { sheet: b.sheet }); }
    const m = masterImport.mapRows(rows, b.mapping ? { aliases: b.mapping } : {});
    const existing = new Set(stockManager.items.map((i) => String(i.MATCODE)));
    const willCreate = m.items.filter((i) => !existing.has(i.MATCODE)).length;
    const summary = { rows: (rows || []).length, items: m.items.length, willCreate, willUpdate: m.items.length - willCreate,
      skipped: m.skipped, merged: m.merged, warningCount: m.warnings.length, warnings: m.warnings.slice(0, 50), unknownCols: m.unknownCols, mappedFields: m.fieldsSeen, sample: m.items.slice(0, 8) };
    if (b.dryRun) return res.json({ ok: true, dryRun: true, ...summary });
    const r = stockManager.importMaster({ items: m.items });
    logActivity(req, { category: 'data', action: 'master_import', detail: `Excel → สร้าง ${r.itemNew}/อัปเดต ${r.itemUpd} (rows ${(rows || []).length})` });
    res.json({ ok: true, ...summary, result: r });
  } catch (e) { _se(res, e); }
});
// รวม MATCODE ซ้ำเชิง logical ในของที่มีอยู่ (เช่น stub เลข 0 นำหน้าจาก import เก่า) · apply=false = dry-run preview
app.post('/api/stock/master/dedupe', (req, res) => {
  try {
    const apply = (req.body || {}).apply === true;
    const r = stockManager.dedupeMaster({ apply });
    if (apply) logActivity(req, { category: 'data', action: 'master_dedupe', detail: `รวมซ้ำ ${r.dupGroups} กลุ่ม · ลบ ${r.removed} · ย้าย lot ${r.lotsMoved}` });
    res.json({ ok: true, apply, ...r });
  } catch (e) { _se(res, e); }
});
// ── DB storage ops (§F · TPKstock) — snapshot / refresh-test / restore / status ──
app.get('/api/stock/db/status', async (_req, res) => { try { res.json({ ok: true, ...(await stockManager.dbStatus()) }); } catch (e) { _se(res, e); } });
app.post('/api/stock/db/provision', async (req, res) => { try { const r = await stockManager.dbProvision(req.body || {}); logActivity(req, { category: 'data', action: 'db_provision', detail: r.databases.map((d) => `${d.database}:${d.created ? 'created' : 'exists'}`).join(', ') }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
app.post('/api/stock/db/switch', async (req, res) => { try { const r = await stockManager.dbSwitch(req.body || {}); logActivity(req, { category: 'data', action: 'db_switch', detail: `→ ${r.storage}${r.mode ? ' (' + r.mode + ')' : ''}` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
app.post('/api/stock/db/activate', async (req, res) => { try { const r = await stockManager.dbActivate(); logActivity(req, { category: 'data', action: 'db_activate', detail: `${r.env} ${r.mode} (${r.items} items)` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
app.post('/api/stock/db/snapshot', async (req, res) => { try { const r = await stockManager.dbSnapshot((req.body || {}).env, (req.body || {}).reason); logActivity(req, { category: 'data', action: 'db_snapshot', detail: `${r.env} ${r.bytes}B` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
app.post('/api/stock/db/refresh-test', async (req, res) => { try { const r = await stockManager.dbRefreshTest((req.body || {}).reason); logActivity(req, { category: 'data', action: 'db_refresh_test', detail: `copy ${r.copiedBytes}B + snapshot prod` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
app.get('/api/stock/db/snapshots', async (req, res) => { try { res.json({ ok: true, snapshots: await stockManager.dbListSnapshots(req.query.env, req.query.limit) }); } catch (e) { _se(res, e); } });
app.post('/api/stock/db/restore', async (req, res) => { try { const r = await stockManager.dbRestore((req.body || {}).env, (req.body || {}).id); logActivity(req, { category: 'data', action: 'db_restore', detail: `${r.env} ← #${r.restoredFrom}` }); res.json({ ok: true, ...r }); } catch (e) { _se(res, e); } });
app.get('/api/stock/config', (_req, res) => res.json({ ok: true, config: stockManager.getConfig() }));
app.put('/api/stock/config', (req, res) => { try { logActivity(req, { category: 'config', action: 'stock_config' }); res.json({ ok: true, config: stockManager.setConfig(req.body || {}) }); } catch (e) { _se(res, e); } });
app.get('/api/stock/qr/:stockId', (req, res) => {
  const s = stockManager.getStock(req.params.stockId);
  if (!s) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, qr: { stockId: s.stockId, name: s.name, type: s.type, payload: `kpe-stock:${s.stockId}` } });
});

// ── Query Buffer registry — รัน SQL ตามเวลา → เก็บผลล่าสุด → widget อ้างชื่อไปใช้ ────────
app.get('/api/querybuffers', (_req, res) => res.json({ ok: true, buffers: queryBufferManager.list() }));
app.post('/api/querybuffers', (req, res) => {
  try {
    const b = queryBufferManager.create(req.body || {});
    logActivity(req, { category: 'config', action: 'querybuffer_create', target: b.name, detail: b.id });
    res.json({ ok: true, buffer: b });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/querybuffers/:id', (req, res) => {
  try {
    const b = queryBufferManager.update(req.params.id, req.body || {});
    logActivity(req, { category: 'config', action: 'querybuffer_update', target: b.name, detail: b.id });
    res.json({ ok: true, buffer: b });
  } catch (e) {
    const code = e.message === 'not found' ? 404 : 400;
    res.status(code).json({ ok: false, error: e.message });
  }
});
app.delete('/api/querybuffers/:id', (req, res) => {
  const existing = queryBufferManager.get(req.params.id);
  const ok = queryBufferManager.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  logActivity(req, { category: 'config', action: 'querybuffer_delete', target: existing ? existing.name : req.params.id, detail: req.params.id });
  res.json({ ok: true });
});
// ผลล่าสุดที่เก็บไว้ (widget เรียก — ไม่ rerun) → { ok, columns, rows, lastRun, rowCount }
app.get('/api/querybuffers/:id/data', (req, res) => res.json(queryBufferManager.data(req.params.id, req.query.raw === '1')));
// บังคับรัน query เดี๋ยวนี้ (ปุ่ม refresh / manual buffer)
app.post('/api/querybuffers/:id/refresh', async (req, res) => {
  const out = await queryBufferManager.refresh(req.params.id);
  res.status(out.ok ? 200 : 400).json(out);
});
// ทดสอบยิง (ไม่บันทึก) — ฟอร์มสร้าง buffer ลองดูผล/error ก่อน save
app.post('/api/querybuffers/test', async (req, res) => {
  const out = await queryBufferManager.test(req.body || {});
  res.status(out.ok ? 200 : 400).json(out);
});

// ── Auth (run-mode authentication / authorization) ────────────────────────────
// POST /api/auth/login { username, password } → { success, token, identity }
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const r = await authManager.login(username, password);
    if (!r.ok) {
      logActivity(req, { category: 'auth', action: 'login', user: username || '-', result: 'fail', detail: r.error || '' });
      return res.status(401).json({ success: false, error: r.error });
    }
    logActivity(req, { category: 'auth', action: 'login', user: (r.identity?.name || r.identity?.id || username || '-'), result: 'ok' });
    res.json({ success: true, token: r.token, identity: r.identity });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
// POST /api/auth/logout { user } → log (logout เป็น client-side, endpoint นี้ไว้บันทึก)
app.post('/api/auth/logout', (req, res) => {
  logActivity(req, { category: 'auth', action: 'logout', user: req.body?.user || '-' });
  res.json({ success: true });
});
// GET /api/auth/me?token= → { identity } (guest ถ้า token ไม่ถูก/หมดอายุ)
app.get('/api/auth/me', (req, res) => {
  res.json({ identity: authManager.identityFromToken(req.query.token) });
});
// GET /api/auth/config → { levels, departments, settings }
app.get('/api/auth/config', (_req, res) => res.json(authManager.getConfig()));
// PUT /api/auth/config { levels?, departments?, settings? }
app.put('/api/auth/config', (req, res) => {
  try {
    const config = authManager.setConfig(req.body || {});
    logActivity(req, { category: 'system', action: 'config_change', target: 'auth-config' });
    res.json({ success: true, config });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
// User CRUD (admin) — list ไม่คืน hash/salt
app.get('/api/auth/users', async (_req, res) => {
  try { res.json(await authManager.listUsers()); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.post('/api/auth/users', async (req, res) => {
  try { res.json({ success: true, user: await authManager.addUser(req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.put('/api/auth/users/:id', async (req, res) => {
  try { res.json({ success: true, user: await authManager.updateUser(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.delete('/api/auth/users/:id', async (req, res) => {
  try { res.json(await authManager.removeUser(req.params.id)); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
// POST /api/auth/change-password { token, oldPassword, newPassword } — เปลี่ยนรหัสตัวเอง
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { token, oldPassword, newPassword } = req.body || {};
    const r = await authManager.changePassword(token, oldPassword, newPassword);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── System info (OS, platform) ────────────────────────────────────────────
app.get('/api/system', (_req, res) => {
  const platform = process.platform; // 'darwin' | 'win32' | 'linux'
  res.json({
    platform,
    os:        platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
    isWindows: platform === 'win32',
    isMac:     platform === 'darwin',
    serialHint: platform === 'win32' ? 'COM1, COM2, …' : '/dev/tty.usbserial-0001',
    serialPattern: platform === 'win32' ? 'COM' : '/dev/tty',
  });
});

// ── List available serial ports ───────────────────────────────────────────
app.get('/api/serial-ports', async (_req, res) => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    res.json(ports.map(p => ({
      path:         p.path,
      manufacturer: p.manufacturer || '',
      serialNumber: p.serialNumber || '',
      pnpId:        p.pnpId        || '',
      friendlyName: p.friendlyName || p.path,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tag Management CRUD ───────────────────────────────────────────────────

// GET all tags (flat list)
app.get('/api/tags', (_req, res) => {
  res.json(engine.getAllTags());
});

// POST add new device
app.post('/api/devices', (req, res) => {
  try {
    const device = engine.addDevice(req.body);
    kpeNet.rebuild();
    broadcast({ type: 'devices_updated', devices: engine.getDevices() });
    broadcastSnapshot();
    res.json({ success: true, device });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Export device/tag config (migration) — mode: device (shell) | tags (tag-only) | full · ตัด managed
app.get('/api/devices/export', (req, res) => {
  try {
    const mode = (req.query.mode || 'full').toString();
    const out = engine.getDevices().filter((d) => !d.managed).map((d) => {
      if (mode === 'tags') return { id: d.id, name: d.name, tags: d.tags || [] };
      const base = { id: d.id, name: d.name, type: d.type, enabled: d.enabled, connection: d.connection, pollInterval: d.pollInterval };
      if (d.autoProbe !== undefined) base.autoProbe = d.autoProbe;
      if (d.shareStatus !== undefined) base.shareStatus = d.shareStatus;
      if (mode === 'full') base.tags = d.tags || [];
      return base;   // mode 'device' = ไม่มี tags
    });
    res.json({ devices: out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Import device/tag config (bulk · migration) — body { devices:[...], mode:'device'|'tags'|'full' }
app.post('/api/devices/import', (req, res) => {
  try {
    const b = req.body || {};
    const r = engine.importBundle(b.devices || [], b.mode || 'full', b.overwrite !== false);
    kpeNet.rebuild();
    broadcast({ type: 'devices_updated', devices: engine.getDevices() });
    broadcastSnapshot();
    res.json({ success: true, ...r });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// DELETE device
app.delete('/api/devices/:deviceId', (req, res) => {
  try {
    engine.removeDevice(req.params.deviceId);
    kpeNet.rebuild();
    broadcast({ type: 'devices_updated', devices: engine.getDevices() });
    broadcastSnapshot();
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// PUT update device connection / enabled
// Body: { connection: {...}, enabled: bool, name: string }
app.put('/api/devices/:deviceId', (req, res) => {
  try {
    const result = engine.updateDevice(req.params.deviceId, req.body);
    kpeNet.rebuild();
    broadcast({ type: 'devices_updated', devices: engine.getDevices() });
    broadcastSnapshot();   // ให้หน้า Tags อัปเดตทันที (เช่น toggle shareStatus → ไอคอนเปลี่ยนเลย)
    res.json({ success: true, device: result });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Helper: broadcast updated snapshot to all WebSocket clients
function broadcastSnapshot() {
  broadcast({ type: 'snapshot', data: engine.getAllValues() });
}

// POST add tag to device
app.post('/api/devices/:deviceId/tags', (req, res) => {
  try {
    const tag = engine.addTag(req.params.deviceId, req.body);
    kpeNet.rebuild();
    broadcastSnapshot();
    res.json({ success: true, tag });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// PUT update tag
app.put('/api/devices/:deviceId/tags/:tagId', (req, res) => {
  try {
    const tag = engine.updateTag(req.params.deviceId, req.params.tagId, req.body);
    kpeNet.rebuild();
    broadcastSnapshot();
    res.json({ success: true, tag });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// DELETE tag
app.delete('/api/devices/:deviceId/tags/:tagId', (req, res) => {
  try {
    engine.removeTag(req.params.deviceId, req.params.tagId);
    kpeNet.rebuild();
    broadcastSnapshot();
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// PUT rename/delete tag group (atomic) — { from, to }  · to='' = ลบกลุ่ม (tag ลอย)
app.put('/api/devices/:deviceId/tag-group', (req, res) => {
  try {
    const { from, to } = req.body || {};
    const n = engine.renameTagGroup(req.params.deviceId, from, to);
    broadcastSnapshot();
    res.json({ success: true, changed: n });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Build API ─────────────────────────────────────────────────────────────
// POST /api/build  { layout: {...}, wsUrl: "ws://host:port" }
// → runs flutter build web, then streams a zip of build/web/
let _buildRunning = false;

// ── Deploy bundle helpers (start scripts + readme) ─────────────────────────────
function _deployStartSh() {
  return `#!/bin/bash
# KPE SCADA — start ทั้งระบบ (backend + frontend)
cd "$(dirname "$0")"
echo "KPE SCADA — starting..."

cd backend
if [ ! -d node_modules ]; then echo "[first run] installing backend dependencies..."; npm install; fi
node src/server.js &
BACK=$!
cd ..

cd frontend
node serve.js &
FRONT=$!
cd ..

echo "Backend PID $BACK | Frontend PID $FRONT"
echo "Dashboard: http://localhost:3012   |   API: http://localhost:4012/api"
trap "kill $BACK $FRONT 2>/dev/null; exit 0" SIGINT SIGTERM
wait
`;
}

function _deployStartBat() {
  return `@echo off
title KPE SCADA
cd /d "%~dp0"
echo KPE SCADA - starting...

cd backend
if not exist node_modules ( echo [first run] installing backend dependencies... && call npm install )
start "KPE SCADA Backend" cmd /k "node src/server.js"
cd ..

cd frontend
start "KPE SCADA Frontend" cmd /k "node serve.js"
cd ..

timeout /t 3 /nobreak >nul
start http://localhost:3012
echo Dashboard: http://localhost:3012   API: http://localhost:4012/api
pause
`;
}

function _deployReadme(wsUrl) {
  return `KPE SCADA — Deployment Bundle
==============================

โครงสร้าง:
  frontend/   Flutter Web (build แล้ว) + serve.js (static server, port 3012)
  backend/    Node.js backend (source + config + package.json), port 4012
  start.sh    เปิดทั้งระบบ (macOS/Linux)
  start.bat   เปิดทั้งระบบ (Windows)

วิธีรัน:
  1) ต้องมี Node.js (>=18) ติดตั้งบนเครื่องปลายทาง
  2) macOS/Linux:  ./start.sh      |   Windows: ดับเบิลคลิก start.bat
     (ครั้งแรกจะ npm install ให้ backend อัตโนมัติ)
  3) เปิด http://localhost:3012

หมายเหตุ:
  - Dashboard build นี้ฝัง WS_URL = ${wsUrl} ไว้ (UI จะต่อ backend ที่ address นี้)
    ถ้า deploy คนละเครื่อง ให้ Build ใหม่โดยตั้ง WS URL = ws://<ip-เครื่อง-backend>:4012
  - config อยู่ที่ backend/src/config/ (devices.json / scripts.json / databases.json)
    *** databases.json อาจมีรหัสผ่าน DB — ระวังการแชร์ไฟล์ ***
  - ไม่ได้รวม node_modules มาด้วย (ติดตั้งเองตอนรันครั้งแรก)
`;
}

app.post('/api/build', async (req, res) => {
  if (_buildRunning) {
    return res.status(409).json({ error: 'Build already in progress' });
  }

  const { layout, wsUrl = 'ws://localhost:4012', backend: includeBackend = true } = req.body;
  if (!layout) return res.status(400).json({ error: 'layout required' });

  _buildRunning = true;
  console.log('[Build] Starting Flutter web build...');

  try {
    // 1. Write deploy assets
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ASSETS_DIR, 'dashboard_deploy.json'),
      JSON.stringify(layout, null, 2)
    );
    fs.writeFileSync(
      path.join(ASSETS_DIR, 'config_deploy.json'),
      JSON.stringify({ wsUrl }, null, 2)
    );

    // 2. flutter build web → output to web_deploy/ (ไม่ทับ build/web ปกติ)
    fs.mkdirSync(DEPLOY_DIR, { recursive: true });
    const cmd = [
      'flutter build web --release',
      '--no-web-resources-cdn',   // bundle CanvasKit local → ใช้ได้ offline (client ไม่มีเน็ต)
      '--dart-define=DEPLOY_MODE=true',
      `--dart-define=WS_URL=${wsUrl}`,
    ].join(' ');

    exec(cmd, { cwd: FRONTEND_DIR, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) {
        _buildRunning = false;
        console.error('[Build] Failed:', stderr.slice(-500));
        return res.status(500).json({ error: 'Build failed', detail: stderr.slice(-1000) });
      }

      // 3. Copy build/web → build/web_deploy  (flutter always outputs to build/web)
      fs.cpSync(BUILD_DIR, DEPLOY_DIR, { recursive: true });

      // 4. Immediately restore normal build (edit mode) in build/web
      console.log('[Build] Deploy ready. Restoring normal build...');
      exec('flutter build web --release --no-web-resources-cdn', { cwd: FRONTEND_DIR, timeout: 300_000 }, (err2) => {
        _buildRunning = false;
        if (err2) console.warn('[Build] Restore warning:', err2.message);
        else console.log('[Build] Normal build restored.');
      });

      // 5. Stream deploy zip back immediately (don't wait for restore)
      console.log(`[Build] Packaging zip (backend=${includeBackend})...`);
      const ts = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="kpe_scada_${ts}.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (e) => { console.error('[Build] Zip error:', e); res.destroy(); });
      archive.pipe(res);

      const ROOT = 'kpe_scada';
      // ── Frontend (UI ที่ build แล้ว + static server) — โครงสร้างเดียวกับ dev เพื่อให้ serve.js ทำงานได้ทันที
      archive.directory(DEPLOY_DIR, `${ROOT}/frontend/build/web`);
      if (fs.existsSync(path.join(FRONTEND_DIR, 'serve.js'))) {
        archive.file(path.join(FRONTEND_DIR, 'serve.js'), { name: `${ROOT}/frontend/serve.js` });
      }

      if (includeBackend) {
        // ── Backend (source + config + package.json) — ไม่รวม node_modules (deploy ค่อย npm install)
        archive.directory(BACKEND_SRC, `${ROOT}/backend/src`);   // src/ มี config/*.json + drivers ครบ
        archive.file(path.join(BACKEND_DIR, 'package.json'), { name: `${ROOT}/backend/package.json` });
        if (fs.existsSync(path.join(BACKEND_DIR, 'package-lock.json'))) {
          archive.file(path.join(BACKEND_DIR, 'package-lock.json'), { name: `${ROOT}/backend/package-lock.json` });
        }
        // ── Start scripts + README (รันทั้งระบบ: npm install ครั้งแรก → backend + frontend)
        archive.append(_deployStartSh(),  { name: `${ROOT}/start.sh`, mode: 0o755 });
        archive.append(_deployStartBat(), { name: `${ROOT}/start.bat` });
        archive.append(_deployReadme(wsUrl), { name: `${ROOT}/README.txt` });
      }

      archive.finalize();
    });
  } catch (e) {
    _buildRunning = false;
    res.status(500).json({ error: e.message });
  }
});

// Build status (poll while waiting)
app.get('/api/build/status', (_req, res) => {
  res.json({ running: _buildRunning });
});

// port + bind host จาก resolver กลาง (env > ports.json > default)
// bind 127.0.0.1 (เข้าผ่าน proxy พอร์ตเดียวของ frontend) — KPE_BACKEND_HOST=0.0.0.0 ถ้าต้องเปิดตรง
const _P = portsCfg.ports();
const PORT = _P.backend;
const HOST = _P.backendHost;

// engine + services lifecycle — แยกเป็นฟังก์ชันเพื่อให้ USB poller (mode B) start/stop ได้ระหว่างรัน
let _enginePolling = false, _servicesStarted = false;
async function startEngine() { if (_enginePolling) return; try { await engine.start(); _enginePolling = true; } catch (e) { console.error('[engine] start:', e && e.message); } }
function stopEngine() { if (!_enginePolling) return; try { engine.stop(); } catch (_) {} _enginePolling = false; }   // หยุด poll device = หยุดคุมงาน (instant block)
function startServicesOnce() {
  if (_servicesStarted) return; _servicesStarted = true;
  scriptEngine.start();
  alarmEngine.start();
  try { datalogManager.start(); } catch (e) { console.error('[datalog] start:', e && e.message); }
  try { queryBufferManager.start(); } catch (e) { console.error('[querybuffer] start:', e && e.message); }
  try { powerManager.start(); } catch (e) { console.error('[power] start:', e && e.message); }
  try { timeSyncManager.start(); } catch (e) { console.error('[timesync] start:', e && e.message); }
  try { if (allowFeature('chem-store')) stockManager.start(); } catch (e) { console.error('[stock] start:', e && e.message); }   // DLC gate: ไม่มี license = ไม่สตาร์ท eval timer (publishChemStockStatus คุม live toggle)
  try { lineRecorder.start(); } catch (e) { console.error('[lineRecorder] start:', e && e.message); }
  try { dbBackup.start(); } catch (_) {}
  try { kpeNet.start(); } catch (e) { console.error('[KPENETWORK] start:', e && e.message); }
}

// License gated → ไม่สตาร์ท engine/services · แค่ listen ให้ /api/license + /health + 403 ตอบได้ (recover ผ่าน Manager/USB)
(async () => {
  // instance-lock: ยึด port ต่อ "ใบ" → รันหลาย instance ใบเดียวกันบนเครื่องเดียวไม่ได้ (USB mode ไม่ใช้ disk-lock)
  if (!USB_MODE) { try { const lk = await license.acquireInstanceLock(); if (!lk.held) console.error(`[LICENSE] ใบนี้ถูกใช้โดย instance อื่นบนเครื่องนี้แล้ว (lock port ${lk.port}) → backend gated (license-in-use)`); LIC = licenseState(); } catch (_) {} }
  const gated = blockedNow();
  if (!gated) { await startEngine(); startServicesOnce(); }
  server.listen(PORT, HOST, () => {
    console.log(`KPE SCADA Backend running on ${HOST}:${PORT}`);
    console.log(`WebSocket: ws://${HOST}:${PORT}`);
    console.log(`REST API:  http://${HOST}:${PORT}/api`);
    if (gated) { console.error(`[LICENSE] backend gated (${gateInfo().reason}) — engine off · /api 403 ยกเว้น /health,/license${USB_MODE ? ' · เสียบ USB master key เพื่อเริ่ม' : ' · recover ผ่าน Manager'}`); return; }
    console.log(`Scripts:   ${scriptEngine.scripts.length} loaded`);
    console.log(`Alarms:    ${alarmEngine.defs.length} loaded`);
    try { activityLog.log({ category: 'system', action: 'service_start', target: 'backend', detail: `port ${PORT}` }); } catch (_) {}
    import('prettier').catch(() => {});   // warm-up prettier (ESM lazy · กัน format ครั้งแรกช้า)
  });
  // USB poller (mode B) — ดึง master key = instant block (engine หยุด) · เสียบคืน = เริ่มต่อ
  if (USB_MODE) {
    const iv = setInterval(() => {
      if (!_usbCheck()) return;   // สถานะไม่เปลี่ยน
      if (usbOk) { console.log('[LICENSE-USB] master key inserted → start engine'); startEngine().then(startServicesOnce); }
      else { console.error('[LICENSE-USB] master key REMOVED → instant block (engine stop · /api 403)'); stopEngine(); }
    }, 2000);
    if (iv && typeof iv.unref === 'function') iv.unref();
  }
})();

// graceful shutdown — รับทั้ง SIGINT (Ctrl+C/dev) และ SIGTERM (systemd/launchd/Windows Service สั่งหยุด) (B2)
let _shuttingDown = false;
function gracefulShutdown(sig) {
  if (_shuttingDown) return; _shuttingDown = true;
  console.log(`[backend] ${sig} → graceful shutdown`);
  try { scriptEngine.stop(); } catch (_) {}
  try { alarmEngine.stop(); } catch (_) {}
  try { datalogManager.stop(); } catch (_) {}
  try { powerManager.stop(); } catch (_) {}
  try { stockManager.stop(); } catch (_) {}
  try { queryBufferManager.stop(); } catch (_) {}
  try { engine.stop(); } catch (_) {}
  try { kpeNet && kpeNet.stop && kpeNet.stop(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
