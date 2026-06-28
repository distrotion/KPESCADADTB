const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ServerTCP } = require('modbus-serial');
const codec = require('./drivers/modbusCodec');
const kdir = require('./kpenetworkDir');   // §55 P7: directory ↔ Modbus register
const csv = require('./csvUtil');

/**
 * KPENETWORK Server (P1: publish read-only + directory) — §55
 *   เปิด Modbus TCP server (ServerTCP) เผยแพร่ "tag ที่ติ๊กแชร์" (tag.shared===true) ของ node นี้
 *   ให้ peer (device type kpenetwork) มาอ่านผ่าน Modbus + ขอ directory ผ่าน REST
 *
 *   - data plane: ค่าจริงอยู่ใน holding register (numeric) / coil (BOOL) · encode ผ่าน modbusCodec กลาง
 *   - control plane: getDirectory() = สารบัญ (ชื่อ tag→register/dataType/scale/writable/origin/path/hops)
 *   - register auto-allocate (persist ใน config.alloc → address คงที่ข้าม restart)
 *
 *   ⏳ ยังไม่ทำใน P1: two-way write (set*) = P4 · directoryMode modbus = P7 · relay = P6
 *   config: <base>/config/kpenetwork.json
 */

const DEFAULT = {
  enabled: false,
  nodeId: '',
  modbusPort: 5020,
  host: '0.0.0.0',
  directoryMode: 'rest',   // rest | modbus | both  (P7 = modbus)
  writeMode: 'atomic',     // atomic | compat       (P4 = write)
  requireApiKey: false,
  apiKey: '',
  allowIps: [],
  allowRelay: false,
  maxHops: 4,
  wsThrottleMs: 150,       // §76: push WS แบบ batch ทุก N ms (กัน flood ตอน tag เปลี่ยนรัว)
  alloc: {},               // key "deviceId/tagId" -> { area, address, words }
};

class KpeNetworkServer {
  constructor(tagEngine) {
    this.engine = tagEngine || null;
    this.server = null;
    this.holdingMap = new Map(); // addr -> { deviceId, tagId, tag, wordIndex }
    this.coilMap = new Map();    // addr -> { deviceId, tagId, tag }
    this.entries = [];           // directory entries
    this.skipped = [];           // tag ที่แชร์แต่ dataType เผยแพร่ไม่ได้ (STRING ฯลฯ)
    this.onPeerWrite = null;     // (deviceId, tagId, value) → log §37 (set จาก server.js)
    this._writeBuf = new Map();  // P4 two-way: buffer register จาก peer write (reassemble หลาย word)
    this._flushTimer = null;
    this._dirRegs = null;        // P7: directory ที่ encode เป็น register (เมื่อ directoryMode modbus/both)
    this._clients = new Map();   // subscriber ที่เกาะอยู่ (key ip:port → {ip,port,since})
    // ── WS transport (§76): peer ที่ subscribe ผ่าน WebSocket (push string/ทุกชนิด) ──
    this._wsPeers = new Map();    // ws -> { nodeId, ip, since, subs:[], pending:Map }
    this._sharedKeys = new Set(); // "device/tag" ที่แชร์ (กรอง push)
    this._wsFlushTimer = null;
    this.path = csv.resolveConfig('kpenetwork.json', path.join(__dirname, 'config', 'kpenetwork.json'));
    this.config = { ...DEFAULT };
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.config = { ...DEFAULT, ...raw, alloc: raw.alloc || {} };
    } catch (_) { this.config = { ...DEFAULT, alloc: {} }; }
  }
  _save() { try { csv.writeJsonAtomic(this.path, this.config); } catch (_) {} }

  port() { return parseInt(process.env.KPE_KPENETWORK_PORT, 10) || this.config.modbusPort || 5020; }

  // ── สแกน tag ที่แชร์ + จัดสรร register (persist alloc ให้ address คงที่) ──────────
  _build() {
    this.holdingMap.clear(); this.coilMap.clear(); this.entries = []; this.skipped = [];
    const alloc = this.config.alloc || {};
    const usedH = new Set(), usedC = new Set();
    for (const k of Object.keys(alloc)) {
      const a = alloc[k];
      if (a.area === 'coil') usedC.add(a.address);
      else for (let i = 0; i < (a.words || 1); i++) usedH.add(a.address + i);
    }
    const nextFree = (used, span) => {
      let a = 0;
      for (;;) { let okk = true; for (let i = 0; i < span; i++) if (used.has(a + i)) { okk = false; break; } if (okk) return a; a++; }
    };

    const seen = new Set();
    for (const dev of (this.engine && this.engine.devices) || []) {
      // §47 special status tags → แชร์เมื่อ dev.shareStatus (read-only · BOOL/coil 0/1)
      const statusTags = dev.shareStatus ? [
        { id: '__online',  name: `${dev.name || dev.id} Online`,  dataType: 'BOOL', shared: true, readOnly: true },
        { id: '__enabled', name: `${dev.name || dev.id} Enabled`, dataType: 'BOOL', shared: true, readOnly: true },
      ] : [];
      for (const tag of [...(dev.tags || []), ...statusTags]) {
        if (!tag.shared) continue;
        const dt = (tag.dataType || 'INT16').toUpperCase();
        // relay (§3.5): network tag (จาก device kpenetwork) ที่ถูก re-share → ตรวจสิทธิ์ + กัน loop
        const isNet = !!tag.network;
        if (isNet) {
          if (!this.config.allowRelay) continue;                                   // node ไม่ยอมเป็นทางผ่าน
          if (!tag.relayAllowed) continue;                                         // origin ไม่อนุญาต relay
          if ((tag._path || []).includes(this.config.nodeId)) continue;            // loop guard (ตัวเองอยู่ใน path แล้ว)
          if ((tag._hops || 0) + 1 > (this.config.maxHops || 4)) continue;         // เกิน maxHops
        }
        const key = `${dev.id}/${tag.id}`;
        seen.add(key);

        // ── REST transport: dataType ที่ใส่ Modbus register ไม่ได้ (STRING ฯลฯ) → แชร์ผ่าน REST แทน (auto) ──
        //   ไม่จัดสรร register · subscriber poll ค่าผ่าน GET /api/kpenetwork/values · v1 = read-only
        if (!codec.WORD_COUNT[dt]) {
          this.entries.push({
            tag: tag.id, name: tag.name || tag.id, device: dev.id,
            area: 'rest', address: 0, words: 0, dataType: dt,
            scale: 1, wordOrder: 'ABCD',
            writable: false,                       // v1: rest read-only (string write-back = ภายหลัง)
            relayAllowed: !!tag.relayAllowed,
            origin: isNet ? (tag._origin || '') : (this.config.nodeId || ''),
            path: isNet ? [...(tag._path || []), this.config.nodeId] : [],
            hops: isNet ? (tag._hops || 0) + 1 : 0,
          });
          continue;
        }

        const isBool = dt === 'BOOL';
        const words = isBool ? 1 : codec.wordCount(dt);
        let a = alloc[key];
        // จัดสรรใหม่ถ้ายังไม่มี หรือ area เปลี่ยน (เช่น dataType เปลี่ยนเป็น/จาก BOOL) หรือจำนวน word เปลี่ยน
        if (!a || (a.area === 'coil') !== isBool || (!isBool && a.words !== words)) {
          if (isBool) { const addr = nextFree(usedC, 1); usedC.add(addr); a = { area: 'coil', address: addr, words: 1 }; }
          else { const addr = nextFree(usedH, words); for (let i = 0; i < words; i++) usedH.add(addr + i); a = { area: 'holding', address: addr, words }; }
          alloc[key] = a;
        }
        this.entries.push({
          tag: tag.id, name: tag.name || tag.id, device: dev.id,
          area: a.area, address: a.address, words: a.words, dataType: dt,
          scale: tag.scale || 1, wordOrder: tag.wordOrder || 'ABCD',
          writable: isNet ? !tag.readOnly : !!tag.shareWritable,
          relayAllowed: !!tag.relayAllowed,
          // local tag → origin=ตัวเอง · network tag (relay) → คงต้นทางจริง + ต่อ path/hops
          origin: isNet ? (tag._origin || '') : (this.config.nodeId || ''),
          path: isNet ? [...(tag._path || []), this.config.nodeId] : [],
          hops: isNet ? (tag._hops || 0) + 1 : 0,
        });
        if (a.area === 'coil') this.coilMap.set(a.address, { deviceId: dev.id, tagId: tag.id, tag });
        else for (let i = 0; i < words; i++) this.holdingMap.set(a.address + i, { deviceId: dev.id, tagId: tag.id, tag, wordIndex: i });
      }
    }
    // prune alloc ของ tag ที่ไม่แชร์แล้ว
    for (const k of Object.keys(alloc)) if (!seen.has(k)) delete alloc[k];
    this.config.alloc = alloc;
    // P7: ฝัง directory ใน register block (เฉพาะ directoryMode modbus/both · tag ตรงเท่านั้น)
    const mode = this.config.directoryMode || 'rest';
    this._dirRegs = (mode === 'modbus' || mode === 'both') ? kdir.encode(this.entries) : null;
    // WS (§76): set ของ key ที่แชร์ (กรอง push) + ส่ง directory ใหม่ให้ peer ที่ต่ออยู่ (sharing เปลี่ยนสด)
    this._sharedKeys = new Set(this.entries.map((e) => `${e.device}/${e.tag}`));
    if (this._wsPeers && this._wsPeers.size) {
      for (const [ws] of this._wsPeers) this._wsSend(ws, { type: 'directory', nodeId: this.config.nodeId || '', entries: this.entries });
    }
    this._save();
  }

  _readWords(item) {
    const tag = item.tag;
    const dt = (tag.dataType || 'INT16').toUpperCase();
    let v = this.engine ? this.engine.getTagValue(item.deviceId, item.tagId) : null;
    v = v ? v.value : null;
    if (v === null || v === undefined || v === '') v = 0;
    let raw = tag.scale ? Number(v) / tag.scale : Number(v);
    if (!Number.isFinite(raw)) raw = 0;
    return codec.encodeValue(raw, dt, tag.wordOrder || 'ABCD');
  }

  _vector() {
    const self = this;
    const hr = (addr, _unitID, cb) => {
      // P7: directory block (เมื่อ directoryMode modbus/both)
      if (self._dirRegs && addr >= kdir.DIR_BASE) {
        const idx = addr - kdir.DIR_BASE;
        return cb(null, idx < self._dirRegs.length ? (self._dirRegs[idx] & 0xFFFF) : 0);
      }
      const item = self.holdingMap.get(addr);
      if (!item) return cb(null, 0);
      try { cb(null, self._readWords(item)[item.wordIndex] & 0xFFFF); } catch (_) { cb(null, 0); }
    };
    return {
      getHoldingRegister: hr,
      getInputRegister: hr,
      getCoil: (addr, _unitID, cb) => {
        const item = self.coilMap.get(addr);
        if (!item) return cb(null, false);
        const v = self.engine ? self.engine.getTagValue(item.deviceId, item.tagId) : null;
        cb(null, !!(v && v.value));
      },
      // P4 two-way: peer เขียนกลับ → writeTag เข้า tagEngine (เฉพาะ tag ที่ writable)
      setRegister: (addr, value, _unitID, cb) => { try { self._onSetRegister(addr, value); } catch (_) {} cb(null); },
      setCoil:     (addr, value, _unitID, cb) => { try { self._onSetCoil(addr, value); } catch (_) {} cb(null); },
    };
  }

  _entryFor(deviceId, tagId) {
    return this.entries.find((e) => e.device === deviceId && e.tag === tagId);
  }

  _onSetCoil(addr, value) {
    const item = this.coilMap.get(addr);
    if (!item) return;
    const entry = this._entryFor(item.deviceId, item.tagId);
    if (!entry || !entry.writable) return;   // ไม่อนุญาตเขียน → ทิ้ง
    this._applyWrite(item.deviceId, item.tagId, value ? 1 : 0);
  }

  _onSetRegister(addr, value) {
    const item = this.holdingMap.get(addr);
    if (!item) return;
    const entry = this._entryFor(item.deviceId, item.tagId);
    if (!entry || !entry.writable) return;   // ไม่อนุญาตเขียน → ทิ้ง
    this._writeBuf.set(addr, value & 0xFFFF);
    // FC16 ส่ง register ทีละตัว (sync) → รวบ flush ทีเดียวหลังครบ block (atomic)
    if (!this._flushTimer) this._flushTimer = setImmediate(() => this._flushWrites());
  }

  _flushWrites() {
    this._flushTimer = null;
    const buf = this._writeBuf; this._writeBuf = new Map();
    const groups = new Map();   // "deviceId/tagId" -> item (กันเขียนซ้ำ tag เดียวหลาย word)
    for (const addr of buf.keys()) {
      const item = this.holdingMap.get(addr);
      if (item) groups.set(`${item.deviceId}/${item.tagId}`, item);
    }
    for (const item of groups.values()) {
      const entry = this._entryFor(item.deviceId, item.tagId);
      if (!entry || !entry.writable) continue;
      // ประกอบค่า: ใช้ word จาก buffer ที่ peer เพิ่งเขียน · word ที่เหลือใช้ค่าปัจจุบัน (compat/partial)
      const current = this._readWords(item);
      const words = [];
      for (let i = 0; i < entry.words; i++) {
        const a = entry.address + i;
        words.push(buf.has(a) ? buf.get(a) : (current[i] || 0));
      }
      let val = codec.decodeWords(words, entry.dataType, entry.wordOrder || 'ABCD');
      if (entry.scale && entry.scale !== 1) val = val * entry.scale;
      if (typeof val === 'number' && !Number.isInteger(val)) val = Math.round(val * 1e6) / 1e6;
      this._applyWrite(item.deviceId, item.tagId, val);
    }
  }

  _applyWrite(deviceId, tagId, value) {
    try { const r = this.engine && this.engine.writeTag(deviceId, tagId, value); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    try { if (this.onPeerWrite) this.onPeerWrite(deviceId, tagId, value); } catch (_) {}
  }

  start() {
    this.stop();
    this._load();
    this._build();
    if (!this.config.enabled) return;
    const port = this.port();
    try {
      this.server = new ServerTCP(this._vector(), { host: this.config.host || '0.0.0.0', port, unitID: 1, debug: false });
      this.server.on('socketError', () => {});
      this.server.on('serverError', (e) => { console.error('[KPENETWORK] serverError:', e && e.message); });
      // P5 security: allowlist IP + track subscriber ที่เกาะอยู่ — hook ที่ socket ของ net.Server ภายใน
      const allow = (this.config.allowIps || []).map((s) => String(s).trim()).filter(Boolean);
      this._clients = new Map();
      if (this.server._server && typeof this.server._server.on === 'function') {
        this.server._server.on('connection', (socket) => {
          const ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
          if (allow.length && !this._ipAllowed(ip, allow)) { try { socket.destroy(); } catch (_) {} return; }
          const key = `${ip}:${socket.remotePort}`;
          this._clients.set(key, { ip, port: socket.remotePort, since: Date.now() });
          socket.on('close', () => { this._clients.delete(key); });
          socket.on('error', () => {});
        });
      }
      this.startWsFlush();   // §76 W1: เริ่ม timer push ค่าให้ WS peer (throttle)
      console.log(`[KPENETWORK] server on :${port} — ${this.entries.length} shared tag(s) [node ${this.config.nodeId || '-'}]${allow.length ? ` · allowlist ${allow.length} IP` : ''}`);
    } catch (e) {
      this.server = null;
      console.error('[KPENETWORK] start failed:', e && e.message);
    }
  }
  stop() {
    if (this._flushTimer) { try { clearImmediate(this._flushTimer); } catch (_) {} this._flushTimer = null; }
    this.stopWsFlush();
    for (const [ws] of this._wsPeers) this._wsClose(ws, 1001, 'shutdown');
    this._wsPeers.clear();
    if (this.server) { try { this.server.close(() => {}); } catch (_) {} this.server = null; }
    this._clients.clear();
  }
  reload() { this.start(); }

  // อัปเดต register map สด เมื่อ tag/device เปลี่ยน (เพิ่ม/แก้/ลบ/ติ๊กแชร์) — ไม่ rebind port
  //   vector ของ ServerTCP อ่าน this.holdingMap/coilMap ตัวเดิม → _build() (sync) เปลี่ยนเนื้อในให้เลย
  rebuild() { if (this.config.enabled && this.server) this._build(); }

  // ── control plane / REST ─────────────────────────────────────────────────────
  getDirectory() { return { nodeId: this.config.nodeId || '', entries: this.entries }; }

  // ค่าปัจจุบันของ tag ที่แชร์แบบ REST transport (area:'rest' เช่น STRING) — subscriber poll ผ่าน REST
  //   คืน { "<device>/<tag>": value } · อ่านสดจาก engine (อ่านได้ทั้ง sim/virtual/จริง)
  getRestValues() {
    const out = {};
    for (const e of this.entries) {
      if (e.area !== 'rest') continue;
      const v = this.engine ? this.engine.getTagValue(e.device, e.tag) : null;
      out[`${e.device}/${e.tag}`] = v ? v.value : null;
    }
    return out;
  }

  // subscriber ที่เกาะอยู่ — รวมตาม IP (1 IP อาจหลาย connection)
  getClients() {
    const byIp = new Map();
    for (const c of this._clients.values()) {
      const e = byIp.get(c.ip) || { ip: c.ip, conns: 0, since: c.since };
      e.conns += 1;
      if (c.since < e.since) e.since = c.since;
      byIp.set(c.ip, e);
    }
    return Array.from(byIp.values()).sort((a, b) => a.since - b.since);
  }

  // ── WS transport (§76 · W1) — peer subscribe ผ่าน WebSocket: push string/ทุกชนิด real-time ──
  _wsSend(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} }
  _wsClose(ws, code, reason) { try { ws.close(code, reason); } catch (_) {} }
  _reqIp(req) {
    return (((req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || '') + '')
      .split(',')[0].trim().replace(/^::ffff:/, '');
  }
  _wsAuth(req) {
    if (!this.config.requireApiKey) return true;
    let key = (req && req.headers && req.headers['x-api-key']) || '';
    if (!key) { try { key = new URL(req.url, 'http://x').searchParams.get('key') || ''; } catch (_) {} }
    return this.checkApiKey(key);
  }
  // snapshot ค่าปัจจุบันของ entries (กรองตาม subs ถ้ามี) → [{device,tag,value}]
  _wsSnapshot(subs) {
    const items = [];
    for (const e of this.entries) {
      if (subs.length && !subs.includes(`${e.device}.${e.tag}`)) continue;
      const v = this.engine ? this.engine.getTagValue(e.device, e.tag) : null;
      items.push({ device: e.device, tag: e.tag, value: v ? v.value : null });
    }
    return items;
  }
  // รับ peer ที่ upgrade มาที่ /api/kpenetwork/ws (เรียกจาก server.js) — auth + ส่ง directory/snapshot + ลงทะเบียน
  handleWsPeer(ws, req) {
    if (!this.config.enabled) return this._wsClose(ws, 4003, 'kpenetwork disabled');
    if (!this._wsAuth(req)) return this._wsClose(ws, 4001, 'invalid api key');
    const ip = this._reqIp(req);
    const allow = (this.config.allowIps || []).map((s) => String(s).trim()).filter(Boolean);
    if (allow.length && !this._ipAllowed(ip, allow)) return this._wsClose(ws, 4002, 'ip not allowed');
    let subs = [], peerNode = '';
    try {
      const u = new URL(req.url, 'http://x');
      const t = u.searchParams.get('tags') || '';
      subs = t ? t.split(',').map((s) => s.trim()).filter(Boolean) : [];
      peerNode = (req.headers && req.headers['x-kpe-node']) || u.searchParams.get('node') || '';
    } catch (_) {}
    const peer = { nodeId: String(peerNode || ''), ip, since: Date.now(), subs, pending: new Map() };
    this._wsPeers.set(ws, peer);
    ws.isAlive = true;   // heartbeat: pong จาก peer → ยังมีชีวิต (จับ peer ตาย/หลุดแบบไม่ส่ง close)
    if (typeof ws.on === 'function') ws.on('pong', () => { ws.isAlive = true; });
    this._wsSend(ws, { type: 'directory', nodeId: this.config.nodeId || '', entries: this.entries });
    this._wsSend(ws, { type: 'snapshot', items: this._wsSnapshot(subs) });
    ws.on('close', () => { if (this._wsPeers.delete(ws)) this._notifyPeers(); });
    ws.on('error', () => { if (this._wsPeers.delete(ws)) this._notifyPeers(); });
    this._notifyPeers();   // §76 C: push รายชื่อ peer ให้ Setup ทันที (ไม่รอ poll 2s)
    // v1 = read+push (two-way write = เฟสถัดไป) — ข้อความจาก peer ตอนนี้ยังไม่ใช้
    return ws;
  }
  // §76 C: แจ้ง server.js ว่ารายชื่อ peer/clients เปลี่ยน → broadcast ผ่าน dashboard WS (status realtime)
  _notifyPeers() { try { if (typeof this.onPeersChange === 'function') this.onPeersChange(); } catch (_) {} }
  // tag เปลี่ยนค่า (เรียกจาก engine onTagUpdate) → คิวไว้ push ให้ peer ที่ subscribe (throttle ผ่าน flush timer)
  onTagChange(deviceId, tagId, value) {
    if (!this._wsPeers.size) return;
    if (!this._sharedKeys.has(`${deviceId}/${tagId}`)) return;   // ไม่ใช่ tag ที่แชร์ → ข้าม
    const dotKey = `${deviceId}.${tagId}`;
    for (const peer of this._wsPeers.values()) {
      if (peer.subs.length && !peer.subs.includes(dotKey)) continue;
      peer.pending.set(`${deviceId}/${tagId}`, { device: deviceId, tag: tagId, value });
    }
  }
  // flush คิวที่ค้าง → ส่ง batch เดียวต่อ peer (throttle: เรียกเป็นช่วงจาก timer)
  _flushWsPeers() {
    for (const [ws, peer] of this._wsPeers) {
      if (!peer.pending.size) continue;
      const items = Array.from(peer.pending.values());
      peer.pending.clear();
      this._wsSend(ws, { type: 'update', items });
    }
  }
  // heartbeat: ตรวจ peer ที่ไม่ pong (ตาย/หลุดแบบไม่ส่ง close · TCP half-open) → terminate + ลบออก (status realtime)
  _wsHeartbeat() {
    let changed = false;
    for (const [ws] of this._wsPeers) {
      if (ws.isAlive === false) {
        try { (ws.terminate || ws.close).call(ws); } catch (_) {}
        if (this._wsPeers.delete(ws)) changed = true;
        continue;
      }
      ws.isAlive = false;
      try { if (typeof ws.ping === 'function') ws.ping(); } catch (_) {}
    }
    if (changed) this._notifyPeers();   // §76 C: peer ตายถูกลบ → push ให้ Setup ทันที
  }
  startWsFlush() {
    this.stopWsFlush();
    const ms = parseInt(this.config.wsThrottleMs, 10) || 150;
    this._wsFlushTimer = setInterval(() => { try { this._flushWsPeers(); } catch (_) {} }, ms);
    if (this._wsFlushTimer.unref) this._wsFlushTimer.unref();
    // §76 A: heartbeat 2s (เดิม 4s) → ตรวจ peer ตาย ungraceful เร็วขึ้น · config wsHbMs ได้
    const hb = parseInt(this.config.wsHbMs, 10) || 2000;
    this._wsHbTimer = setInterval(() => { try { this._wsHeartbeat(); } catch (_) {} }, hb);
    if (this._wsHbTimer.unref) this._wsHbTimer.unref();
  }
  stopWsFlush() {
    if (this._wsFlushTimer) { clearInterval(this._wsFlushTimer); this._wsFlushTimer = null; }
    if (this._wsHbTimer) { clearInterval(this._wsHbTimer); this._wsHbTimer = null; }
  }
  // peer ที่ต่อ WS อยู่ (สำหรับ status) — nodeId + ip + ต่อมานานเท่าไร + subscribe กี่ tag
  getWsPeers() {
    return Array.from(this._wsPeers.values()).map((p) => ({
      nodeId: p.nodeId || '', ip: p.ip, since: p.since,
      tags: p.subs.length || this.entries.length, transport: 'ws',
    })).sort((a, b) => a.since - b.since);
  }

  getConfig() {
    const { alloc, ...pub } = this.config;
    return { ...pub, running: !!this.server, port: this.port(),
      shared: this.entries.length, skipped: this.skipped.length, skippedTags: this.skipped,
      clients: this.getClients(), wsPeers: this.getWsPeers() };
  }

  setConfig(updates) {
    const u = updates || {};
    const next = { ...this.config };
    for (const k of ['enabled', 'nodeId', 'host', 'directoryMode', 'writeMode', 'requireApiKey', 'apiKey', 'allowRelay']) {
      if (u[k] !== undefined) next[k] = u[k];
    }
    if (u.modbusPort !== undefined) next.modbusPort = parseInt(u.modbusPort, 10) || 5020;
    if (u.maxHops !== undefined) next.maxHops = parseInt(u.maxHops, 10) || 4;
    if (Array.isArray(u.allowIps)) next.allowIps = u.allowIps.map((s) => String(s).trim()).filter(Boolean);
    this.config = next;
    this._save();
    this.reload();
    return this.getConfig();
  }

  // IP ผ่าน allowlist ไหม (loopback match 'localhost'/127.0.0.1/::1)
  _ipAllowed(ip, allow) {
    if (allow.includes(ip)) return true;
    if ((ip === '127.0.0.1' || ip === '::1') &&
        (allow.includes('localhost') || allow.includes('127.0.0.1') || allow.includes('::1'))) return true;
    return false;
  }

  // ใช้ที่ route /api/kpenetwork/directory — ตรวจ key ตาม requireApiKey (§9.1)
  checkApiKey(headerKey) {
    if (!this.config.requireApiKey) return true;
    const want = this.config.apiKey || '';
    if (!want) return true; // เปิด requireApiKey แต่ยังไม่ตั้ง key → ไม่บล็อก (กัน lockout)
    try {
      const a = Buffer.from(String(headerKey || '')); const b = Buffer.from(want);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
  }
}

module.exports = KpeNetworkServer;
