// KPE SCADA — Remote HMI Gateway (R1 core) · ดู docs ออกแบบใน SESSION-HANDOFF (§ Remote Gateway)
//   serverA เปิด "พอร์ตต่อ site" → forward TCP ดิบ ไป serverB:frontendPort (public)
//   raw TCP (net) = รองรับ HTTP + WS + TLS ทะลุ · ไม่ rewrite path · auth จัดการ end-to-end ที่ serverB
//   อยู่ใน Manager (ไม่แยก service) · ไม่เพิ่ม native dep (ใช้ net ของ Node)
//   DI ได้ (file/onLog) เพื่อเทสต์โดยไม่ต้องมี serverB จริง
const net = require('net');
const fs = require('fs');
const path = require('path');

// site: { id, name, host, port, listenPort, tls?, enabled }
function isPort(n) { return Number.isInteger(n) && n > 0 && n < 65536; }

class RemoteGateway {
  constructor(opts = {}) {
    this.file = opts.file || null;          // remote-sites.json path
    this.onLog = opts.onLog || (() => {});
    this.sites = [];
    this.servers = new Map();               // id -> { server, site }
    this.health = new Map();                // id -> bool (reachable)
    this._conns = new Map();                // id -> จำนวน connection ที่ active (maxConns)
    this._healthTimer = null;
    this._healthMs = opts.healthMs || 5000;
  }

  // site ควรเปิด tunnel ไหม: enabled + ยังไม่หมดเวลา (R5 · timed/on-demand)
  _isLive(s) { return s.enabled !== false && !(s.expiresAt && Date.now() > s.expiresAt); }

  // ── persist ──────────────────────────────────────────────────────────────
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.sites = Array.isArray(raw) ? raw : [];
    } catch (_) { this.sites = []; }
    return this.sites;
  }
  save() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.tmp';
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.sites, null, 2) + '\n');
      fs.renameSync(tmp, this.file);   // atomic
    } catch (e) { this.onLog(`save remote-sites failed: ${e.message}`); }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  start() { this.load(); this.reconcile(); this._startHealth(); }
  stop() {
    for (const [, v] of this.servers) { try { v.server.close(); } catch (_) {} }
    this.servers.clear();
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  // เปิด/ปิด listener ให้ตรงกับ config ปัจจุบัน (เรียกหลังแก้ config + ทุก health tick → auto-close ตอนหมดเวลา)
  reconcile() {
    const want = new Map(this.sites.filter((s) => this._isLive(s)).map((s) => [s.id, s]));
    // ปิดตัวที่ไม่ต้องการแล้ว / เปลี่ยน host:port:listenPort (เทียบกับ snapshot ตอนเปิด · ไม่ใช่ ref ที่ถูก mutate)
    for (const [id, v] of [...this.servers]) {
      const w = want.get(id);
      if (!w || w.host !== v.host || w.port !== v.port || w.listenPort !== v.listenPort) {
        try { v.server.close(); } catch (_) {}
        this.servers.delete(id);
      }
    }
    // เปิดตัวที่ยังไม่เปิด
    for (const [id, site] of want) {
      if (!this.servers.has(id)) this._open(site);
    }
  }

  _open(site) {
    if (!isPort(site.listenPort) || !isPort(site.port) || !site.host) {
      this.onLog(`site ${site.id}: config ไม่ถูกต้อง (host/port/listenPort)`); return;
    }
    const server = net.createServer((client) => this._forward(client, site));
    server.on('error', (e) => { this.onLog(`site ${site.id} listen :${site.listenPort} error: ${e.message}`); });
    server.listen(site.listenPort, site.bindHost || '0.0.0.0', () => this.onLog(`gateway ${site.bindHost || '0.0.0.0'}:${site.listenPort} → ${site.host}:${site.port} (${site.name || site.id})`));
    // เก็บ snapshot ของ host/port/listenPort ตอนเปิด → reconcile เทียบได้แม้ object site ถูก mutate (แก้พอร์ต)
    this.servers.set(site.id, { server, host: site.host, port: site.port, listenPort: site.listenPort });
  }

  // ── ท่อตาบอด: forward TCP ดิบสองทาง (+ maxConns cap · R5) ─────────────────
  _forward(client, site) {
    const cap = parseInt(site.maxConns, 10) || 0;   // 0 = ไม่จำกัด
    if (cap > 0) {
      const n = this._conns.get(site.id) || 0;
      if (n >= cap) { try { client.destroy(); } catch (_) {} return; }
      this._conns.set(site.id, n + 1);
    }
    const dec = () => { if (cap > 0) this._conns.set(site.id, Math.max(0, (this._conns.get(site.id) || 1) - 1)); };
    const upstream = net.connect(site.port, site.host);
    let dead = false;
    const kill = () => { if (dead) return; dead = true; dec(); try { client.destroy(); } catch (_) {} try { upstream.destroy(); } catch (_) {} };
    client.on('error', kill);
    upstream.on('error', kill);
    client.on('close', kill);
    upstream.on('close', kill);
    upstream.on('connect', () => { upstream.pipe(client); client.pipe(upstream); });
  }

  // ── health (serverB ต่อได้ไหม) ───────────────────────────────────────────
  _startHealth() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._sweepHealth();
    this._healthTimer = setInterval(() => { this._sweepHealth(); this.reconcile(); }, this._healthMs);   // reconcile → auto-close ตอนหมดเวลา (R5)
    if (this._healthTimer.unref) this._healthTimer.unref();
  }
  _sweepHealth() { for (const s of this.sites) this.checkSite(s, (ok) => this.health.set(s.id, ok)); }
  checkSite(site, cb) {
    if (!isPort(site.port) || !site.host) return cb(false);
    const sock = net.connect({ host: site.host, port: site.port });
    let done = false;
    const fin = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} cb(ok); };
    sock.setTimeout(3000);
    sock.on('connect', () => fin(true));
    sock.on('error', () => fin(false));
    sock.on('timeout', () => fin(false));
  }

  // ── สถานะให้ UI ──────────────────────────────────────────────────────────
  list() {
    return this.sites.map((s) => ({
      ...s, online: this.health.get(s.id) === true, listening: this.servers.has(s.id),
    }));
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────
  _slug(name) {
    const base = String(name || 'site').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'site';
    let id = base, i = 2;
    while (this.sites.some((s) => s.id === id)) id = `${base}-${i++}`;
    return id;
  }
  _validate(site, ignoreId) {
    if (!site.host || typeof site.host !== 'string') throw new Error('ต้องระบุ host (IP ของ serverB)');
    if (!isPort(site.port)) throw new Error('port ไม่ถูกต้อง (frontend port ของ serverB เช่น 3012)');
    if (!isPort(site.listenPort)) throw new Error('listenPort ไม่ถูกต้อง');
    if (this.sites.some((s) => s.id !== ignoreId && s.listenPort === site.listenPort)) {
      throw new Error(`listenPort ${site.listenPort} ซ้ำกับ site อื่น`);
    }
  }
  add(input) {
    const site = {
      id: this._slug(input.name || input.host),
      name: input.name || input.host, host: String(input.host || '').trim(),
      port: parseInt(input.port, 10) || 3012, listenPort: parseInt(input.listenPort, 10),
      tls: input.tls === true, enabled: input.enabled !== false,
    };
    if (input.bindHost) site.bindHost = String(input.bindHost).trim();          // R5: จำกัด interface
    if (input.maxConns) site.maxConns = parseInt(input.maxConns, 10) || undefined;  // R5: cap connection
    if (input.expiresAt) site.expiresAt = Number(input.expiresAt) || undefined;  // R5: on-demand/timed
    this._validate(site);
    this.sites.push(site);
    this.save(); this.reconcile();
    return site;
  }
  update(id, patch) {
    const s = this.sites.find((x) => x.id === id);
    if (!s) throw new Error('ไม่พบ site');
    const next = { ...s };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.host !== undefined) next.host = String(patch.host).trim();
    if (patch.port !== undefined) next.port = parseInt(patch.port, 10);
    if (patch.listenPort !== undefined) next.listenPort = parseInt(patch.listenPort, 10);
    if (patch.tls !== undefined) next.tls = patch.tls === true;
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
    if (patch.bindHost !== undefined) next.bindHost = patch.bindHost ? String(patch.bindHost).trim() : undefined;
    if (patch.maxConns !== undefined) next.maxConns = patch.maxConns ? parseInt(patch.maxConns, 10) : undefined;
    if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt ? Number(patch.expiresAt) : undefined;
    this._validate(next, id);
    Object.assign(s, next);
    this.save(); this.reconcile();
    return s;
  }
  remove(id) {
    const i = this.sites.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.sites.splice(i, 1);
    this.save(); this.reconcile();
    return true;
  }
}

module.exports = RemoteGateway;
