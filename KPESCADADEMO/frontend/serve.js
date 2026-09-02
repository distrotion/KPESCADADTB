// KPE SCADA — frontend server (single public port)
//   • เสิร์ฟ Flutter Web (static build/web)
//   • reverse-proxy: /api/* และ WebSocket (/ws) → backend (ภายใน)  ·  /mgr/* → manager
//   → เปิด "พอร์ตเดียว" ออกสู่โลกภายนอก, backend/manager อยู่ภายใน (127.0.0.1)
//   ไม่มี dependency เพิ่ม (ใช้ http + net ของ Node ล้วน)
const http = require('http');
const https = require('https');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

// crash guard (B5) — log แล้วไม่ exit ให้ proxy/static เสิร์ฟต่อ (กัน error เดี่ยวล้มทั้ง process)
// stdout/stderr พัง (parent ตาย pipe ขาด) → กลืนเงียบ กัน EPIPE กลายเป็น uncaughtException วนไม่จบ
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (err) => console.error('[serve][uncaughtException]', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (r) => console.error('[serve][unhandledRejection]', r && r.message ? r.message : r));

// HTTPS — ถ้า tls.enabled + มี cert/key (ports().tls หรือ env KPE_TLS_*) → เสิร์ฟ https (WS→wss อัตโนมัติ)
//   ไม่งั้น = http ปกติ · backend/manager คง http ภายใน (TLS เฉพาะขอบ serve/deploy)
let IS_TLS = false;
function makeServer(handler) {
  const t = require('../ports.js').ports().tls || {};
  if (t.enabled && t.cert && t.key) {
    try {
      const s = https.createServer({ cert: fs.readFileSync(t.cert), key: fs.readFileSync(t.key) }, handler);
      IS_TLS = true;
      return s;
    } catch (e) { console.error('[TLS] โหลด cert/key ไม่ได้ → ใช้ http แทน:', e.message); }
  }
  return http.createServer(handler);
}

const _P = require('../ports.js').ports();   // env > ports.json > default
const PUBLIC_PORT  = _P.frontend;
const BACKEND_PORT = _P.backend;
const MANAGER_PORT = _P.manager;
const BACKEND_HOST = _P.backendHost;
// API token (จาก Manager ผ่าน env) — ฉีดให้ backend ตอน proxy · browser ไม่ต้องถือ token
const API_TOKEN    = process.env.KPE_API_TOKEN || '';

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.wasm': 'application/wasm',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const ROOT = path.join(__dirname, 'build', 'web');

// version.json (repo root) — stamp อัตโนมัติทุก commit (ดู tools/stamp-version.js) · อ่านสดต่อ request (ไฟล์เล็ก · สะท้อน redeploy โดยไม่ต้อง restart)
const VERSION_FILE = path.join(__dirname, '..', 'version.json');
function readVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch (_) { return null; }
}

// service worker แบบ self-destruct — ปิด PWA cache ของ Flutter (กันหน้าเก่า/cache ค้าง)
// SW ที่ลงไว้แล้วจะอัปเดตมาเป็นตัวนี้ → unregister ตัวเอง + ล้าง cache + reload หน้า
const KILL_SW = "self.addEventListener('install',()=>self.skipWaiting());"
  + "self.addEventListener('activate',e=>{e.waitUntil((async()=>{"
  + "try{await self.registration.unregister();}catch(_){}"
  + "try{const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));}catch(_){}"
  + "try{const cs=await self.clients.matchAll();cs.forEach(c=>c.navigate(c.url));}catch(_){}"
  + "})());});";

// route → backend/manager target (null = static)
function routeTarget(url) {
  if (url === '/api' || url.startsWith('/api/')) return { port: BACKEND_PORT, path: url };
  if (url === '/mgr' || url.startsWith('/mgr/')) return { port: MANAGER_PORT, path: url.replace(/^\/mgr/, '') || '/' };
  return null;
}

// HTTP reverse proxy → 127.0.0.1:<port>
// IP จริงของ client ที่ต่อเข้า serve (edge) — ใช้ตั้ง X-Forwarded-For ให้ backend (_reqIp/allowIps/peer status)
function clientIp(req) { return ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }

// ── Remote access consent (R2) — serverB ยอมให้ gateway (serverA) เข้าถึงไหม ──
//   ใช้ TCP source จริง (req.socket.remoteAddress · ไม่ใช่ XFF ที่ spoof ได้) ตัดสิน
let remoteAccess = null;
try { remoteAccess = new (require('../backend/src/remoteAccess'))({ file: require('../backend/src/csvUtil').configFile('remote-access.json') }); } catch (_) {}
function remoteBlocked(req) {
  if (!remoteAccess) return false;
  const ip = clientIp(req);
  const d = remoteAccess.decide(ip);
  if (d.reason !== 'direct') remoteAccess.logAccess(ip, d);   // R4: audit การเข้าผ่าน gateway (throttled)
  return !d.allow;
}

// ── License front-lock (tier=backend → ไม่เสิร์ฟ HMI · /api,/ws,/mgr ยัง proxy ปกติ — backend tier = เปิด API แต่ปิดหน้าจอ) ──
//   อ่าน license ไฟล์เดียวกับ backend · isEnforced armed-default → tier=backend = frontLocked() · re-verify ทุก 10s (hot-swap)
let _license = null;
try {
  const LicenseManager = require('../backend/src/licenseManager');
  _license = new LicenseManager();
  try { _license.setLicenseFile(require('../backend/src/csvUtil').configFile('license.key')); } catch (_) {}
  const _lt = setInterval(() => { try { _license.refresh(); } catch (_) {} }, 10000);
  if (_lt && _lt.unref) _lt.unref();
} catch (_) {}
function frontLocked() { try { return !!(_license && _license.frontLocked()); } catch (_) { return false; } }
function frontLockPage() {
  let mid = ''; try { mid = _license ? _license.machineIdShort() : ''; } catch (_) {}
  return '<!doctype html><html lang="th"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>KPE SCADA</title></head>'
    + '<body style="font:15px system-ui;color:#cbd5e1;background:#0f1a2e;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh">'
    + '<div style="max-width:520px;text-align:center;padding:32px">'
    + '<div style="font-size:44px">🔒</div>'
    + '<h2 style="color:#e2e8f0;margin:12px 0">HMI disabled — backend-only license</h2>'
    + '<p>license ของเครื่องนี้เป็นแบบ <b>backend</b> — เปิด API/tag ได้ แต่หน้าจอ HMI ถูกล็อก</p>'
    + '<p>ต้องใช้ license แบบ <b>base</b> (full SCADA) เพื่อเปิดหน้าจอ</p>'
    + '<p style="color:#64748b;font-size:13px">machine-id: ' + mid + '</p>'
    + '</div></body></html>';
}

function proxyHttp(req, res, target) {
  const headers = { ...req.headers };
  delete headers['x-forwarded-for'];               // ตัดที่ client ส่งมาเอง (กัน spoof allowlist) — edge ตั้งเอง
  const ip = clientIp(req);
  if (ip) headers['x-forwarded-for'] = ip;
  if (API_TOKEN && target.port === BACKEND_PORT) headers['authorization'] = `Bearer ${API_TOKEN}`;
  const up = http.request(
    { host: BACKEND_HOST, port: target.port, method: req.method, path: target.path, headers },
    (br) => { res.writeHead(br.statusCode || 502, br.headers); br.pipe(res); },
  );
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream unavailable'); });
  req.pipe(up);
}

// ── Embed proxy — ฝังเว็บที่ตั้ง X-Frame-Options/COEP ได้ โดย strip header (allowlist เท่านั้น) ──
//   /embed-proxy?url=<http(s)>  → ดึง HTML · ตัด X-Frame-Options/CSP frame-ancestors ·
//   inject <base> ให้ asset โหลดจาก origin จริง · เสิร์ฟ same-origin (เลี่ยง COEP+X-Frame พร้อมกัน)
//   ปลอดภัย: เฉพาะ host ใน config/embed-proxy.json (array หรือ {allow:[]}) — กัน SSRF/open-relay
const EMBED_ALLOW_FILE = (() => { try { return require('../backend/src/csvUtil').configFile('embed-proxy.json'); } catch (_) { return null; } })();
function embedAllowList() {
  if (!EMBED_ALLOW_FILE) return [];
  try {
    const j = JSON.parse(fs.readFileSync(EMBED_ALLOW_FILE, 'utf8'));
    const a = Array.isArray(j) ? j : (j.allow || []);
    return a.map((s) => String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  } catch (_) { return []; }
}
function embedHostAllowed(host, allow) {
  host = String(host || '').toLowerCase();
  return allow.some((d) => host === d || host.endsWith('.' + d));
}
function handleEmbedProxy(req, res) {
  let parsed;
  try { parsed = new URL(new URL(req.url, 'http://x').searchParams.get('url') || ''); }
  catch (_) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('bad url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { res.writeHead(400); return res.end('http/https only'); }
  if (!embedHostAllowed(parsed.hostname, embedAllowList())) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<body style="font:14px system-ui;color:#cbd5e1;background:#0f1a2e;padding:24px">⛔ โดเมน <b>${parsed.hostname}</b> ไม่อยู่ใน allowlist<br><br>เพิ่มที่ Manager → Embed Proxy</body>`);
  }
  if (typeof fetch !== 'function') { res.writeHead(501); return res.end('fetch unavailable (need Node >=18)'); }
  fetch(parsed.href, { redirect: 'follow', headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0', 'Accept': 'text/html,*/*' } })
    .then(async (r) => {
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const hdr = { 'Content-Type': ct, 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' };
      if (ct.includes('text/html')) {
        let body = await r.text();
        // inject <base> เฉพาะเว็บที่ไม่มีเอง (เว็บที่มี base อยู่แล้วมักเป็น absolute → asset โหลดถูกแล้ว)
        if (!/<base[\s>]/i.test(body)) {
          const baseTag = `<base href="${parsed.origin}/">`;
          body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + baseTag) : baseTag + body;
        }
        res.writeHead(r.status, hdr); res.end(body);
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, hdr); res.end(buf);
      }
    })
    .catch((e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('fetch failed: ' + (e && e.message)); });
}

const server = makeServer((req, res) => {
  // R2: gateway IP ที่ serverB ถอนความยินยอม → 403 (local/direct ไม่กระทบ)
  if (remoteBlocked(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('remote access disabled by this server'); }
  // designer/run mode ปกติ (ไม่ใช่ deploy)
  if (req.url === '/app-config.json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.end(JSON.stringify({ deploy: false, instance: process.env.KPE_INSTANCE || '', version: readVersion() }));
  }
  // ปิด service worker (กัน cache ค้าง) — เสิร์ฟ SW self-destruct
  if (req.url.split('?')[0].endsWith('flutter_service_worker.js')) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.end(KILL_SW);
  }
  // embed proxy (ฝังเว็บที่บล็อก iframe · allowlist) — ต้องมาก่อน static
  if (req.url.split('?')[0] === '/embed-proxy') return handleEmbedProxy(req, res);

  const target = routeTarget(req.url);
  if (target) return proxyHttp(req, res, target);

  // backend-only license → front lock: ไม่เสิร์ฟ HMI build (API/tag ผ่าน proxy ด้านบนยังใช้ได้ตามปกติ)
  if (frontLocked()) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(frontLockPage());
  }

  // static (SPA fallback → index.html)
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  let st = null;
  try { st = fs.statSync(filePath); if (!st.isFile()) throw 0; }
  catch (_) { filePath = path.join(ROOT, 'index.html'); try { st = fs.statSync(filePath); } catch (_) { st = null; } }
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // no-cache (ไม่ใช่ no-store) + ETag → เบราว์เซอร์ revalidate ทุกครั้ง: ไฟล์ไม่เปลี่ยน = 304 ใช้ cache เดิม
  // (ได้ของใหม่เสมอหลัง deploy เหมือนเดิม แต่ไม่ต้องโหลด main.dart.js/canvaskit ใหม่หลาย MB ทุก refresh)
  res.setHeader('Cache-Control', 'no-cache');
  if (st) {
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  }
  fs.createReadStream(filePath).pipe(res);
});

// WebSocket upgrade → backend (backend WS รับทุก path; client เชื่อม /ws)
server.on('upgrade', (req, socket, head) => {
  if (remoteBlocked(req)) return socket.destroy();   // R2: gateway ที่ถอนความยินยอม → ปิด WS
  const up = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const ip = clientIp(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') continue;   // ตัดที่ client ส่งเอง (กัน spoof) — edge ตั้งเอง
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    if (ip) raw += `X-Forwarded-For: ${ip}\r\n`;   // IP จริงของ client → peer status เห็น IP ต้นทาง (ไม่ใช่ 127.0.0.1)
    if (API_TOKEN) raw += `Authorization: Bearer ${API_TOKEN}\r\n`;   // ฉีด token ให้ backend WS
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PUBLIC_PORT, () => {
  console.log(`KPE SCADA on ${IS_TLS ? 'https' : 'http'}://localhost:${PUBLIC_PORT}`);
  console.log(`  proxy: /api,/ws -> ${BACKEND_HOST}:${BACKEND_PORT}  ·  /mgr -> ${BACKEND_HOST}:${MANAGER_PORT}`);
});
