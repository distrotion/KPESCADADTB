// KPE SCADA — Deploy server (เว็บ run-mode ที่ deploy แล้ว)
//   • เสิร์ฟ Flutter Web (build/web เดียวกับ designer) แต่บอกให้แอปรัน "run-mode only" (/app-config.json)
//   • proxy /api,/ws → backend ที่จับคู่ไว้ (deployBackendHost:deployBackendPort — ตั้งใน Setup)
//   • ฟัง deploy port (default 9012)  ·  layout = live จาก backend ที่จับคู่
//   ไม่มี dependency เพิ่ม (http + net ของ Node)
const http = require('http');
const https = require('https');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

// crash guard (B5) — log แล้วไม่ exit ให้ deploy เสิร์ฟต่อ
// stdout/stderr พัง (parent ตาย pipe ขาด) → กลืนเงียบ กัน EPIPE กลายเป็น uncaughtException วนไม่จบ
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (err) => console.error('[deploy][uncaughtException]', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (r) => console.error('[deploy][unhandledRejection]', r && r.message ? r.message : r));

// HTTPS — tls.enabled + cert/key (ports().tls หรือ env) → เสิร์ฟ https (WS→wss) · ไม่งั้น http
let IS_TLS = false;
function makeServer(handler) {
  const t = _P.tls || {};
  if (t.enabled && t.cert && t.key) {
    try {
      const s = https.createServer({ cert: fs.readFileSync(t.cert), key: fs.readFileSync(t.key) }, handler);
      IS_TLS = true;
      return s;
    } catch (e) { console.error('[TLS] โหลด cert/key ไม่ได้ → ใช้ http แทน:', e.message); }
  }
  return http.createServer(handler);
}

const _P = require('../ports.js').ports();
const PORT         = _P.deploy;
const BACKEND_PORT = _P.deployBackendPort;
const BACKEND_HOST = _P.deployBackendHost;
const API_TOKEN    = process.env.KPE_API_TOKEN || '';   // ฉีดให้ backend ตอน proxy (จาก Manager)

// boot id เฉพาะ process นี้ — ให้หน้า designer แยก "deploy ตัวใหม่" ออกจาก "ตัวเก่าที่ค้าง" ได้ชัด
// (poll หลัง restart จนกว่า boot จะเปลี่ยน → เร็ว + ไม่ false success ตอนตัวเก่ายังตอบ)
const BOOT = `${Date.now()}-${process.pid}`;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.wasm': 'application/wasm',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const ROOT = path.join(__dirname, 'build', 'web');

// version.json (repo root) — stamp อัตโนมัติทุก commit (ดู tools/stamp-version.js)
const VERSION_FILE = path.join(__dirname, '..', 'version.json');
function readVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch (_) { return null; }
}

// service worker self-destruct — ปิด PWA cache ของ Flutter (กันหน้า deploy เก่า/cache ค้าง)
const KILL_SW = "self.addEventListener('install',()=>self.skipWaiting());"
  + "self.addEventListener('activate',e=>{e.waitUntil((async()=>{"
  + "try{await self.registration.unregister();}catch(_){}"
  + "try{const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));}catch(_){}"
  + "try{const cs=await self.clients.matchAll();cs.forEach(c=>c.navigate(c.url));}catch(_){}"
  + "})());});";

// IP จริงของ client ที่ต่อเข้า deploy (edge) — ตั้ง X-Forwarded-For ให้ backend (_reqIp/allowIps/peer status)
function clientIp(req) { return ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }

function proxyHttp(req, res) {
  const headers = { ...req.headers };
  delete headers['x-forwarded-for'];               // ตัดที่ client ส่งมาเอง (กัน spoof allowlist) — edge ตั้งเอง
  const ip = clientIp(req);
  if (ip) headers['x-forwarded-for'] = ip;
  if (API_TOKEN) headers['authorization'] = `Bearer ${API_TOKEN}`;
  const up = http.request(
    { host: BACKEND_HOST, port: BACKEND_PORT, method: req.method, path: req.url, headers },
    (br) => { res.writeHead(br.statusCode || 502, br.headers); br.pipe(res); },
  );
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('backend unavailable'); });
  req.pipe(up);
}

const server = makeServer((req, res) => {
  // บอกแอปว่านี่คือโหมด deploy (run-only) — แอป fetch ตอนเปิด
  // CORS *: ให้หน้า designer (พอร์ตอื่น) เช็คความพร้อมของ deploy server ตัวนี้ได้โดยตรง
  if (req.url === '/app-config.json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.end(JSON.stringify({ deploy: true, boot: BOOT, backend: `${BACKEND_HOST}:${BACKEND_PORT}`, instance: process.env.KPE_INSTANCE || '', version: readVersion() }));
  }
  if (req.url === '/api' || req.url.startsWith('/api/')) return proxyHttp(req, res);
  if (req.url.split('?')[0].endsWith('flutter_service_worker.js')) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.end(KILL_SW);
  }

  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  let st = null;
  try { st = fs.statSync(filePath); if (!st.isFile()) throw 0; }
  catch (_) { filePath = path.join(ROOT, 'index.html'); try { st = fs.statSync(filePath); } catch (_) { st = null; } }
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // no-cache + ETag → revalidate ทุกครั้ง · ไม่เปลี่ยน = 304 (ดูคำอธิบายใน serve.js)
  res.setHeader('Cache-Control', 'no-cache');
  if (st) {
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  }
  fs.createReadStream(filePath).pipe(res);
});

// WebSocket /ws → backend ที่จับคู่
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const ip = clientIp(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') continue;   // ตัดที่ client ส่งเอง (กัน spoof) — edge ตั้งเอง
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    if (ip) raw += `X-Forwarded-For: ${ip}\r\n`;   // IP จริงของ client → peer status เห็น IP ต้นทาง
    if (API_TOKEN) raw += `Authorization: Bearer ${API_TOKEN}\r\n`;
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// bind พอร์ตไม่ได้ (EADDRINUSE จากตัวเก่า/orphan) → exit ทันที ไม่ค้างเป็น zombie
// (manager เห็น exit แล้วจัดการต่อ · designer poll จะ timeout แทนที่จะ false success)
server.on('error', (e) => {
  console.error(`KPE SCADA DEPLOY listen error on :${PORT} — ${e.code || e.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`KPE SCADA DEPLOY (run-mode) on ${IS_TLS ? 'https' : 'http'}://localhost:${PORT}  (boot ${BOOT})`);
  console.log(`  paired backend: ${BACKEND_HOST}:${BACKEND_PORT}  (proxy /api,/ws)`);
});
