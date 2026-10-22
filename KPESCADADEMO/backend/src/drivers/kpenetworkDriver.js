const ModbusRTU = require('modbus-serial');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');             // §76: transport ws (push string/real-time)
const codec = require('./modbusCodec');
const kdir = require('../kpenetworkDir');   // §55 P7: directory ผ่าน Modbus register

/**
 * KPENETWORK Driver (P2: subscribe) — §55
 *   device type 'kpenetwork' · push-based (จัดการ poll/reconnect เอง — engine ไม่ poll)
 *   1 device = 1 peer · ต่อ peer แล้ว:
 *     - control plane: GET <scheme>://host:apiPort/api/kpenetwork/directory  → สารบัญ shared tag
 *       (auto-create network tag ลง device.tags · header x-api-key ถ้า peer เปิด requireApiKey)
 *     - data plane: Modbus client poll register/coil ของ peer → decode (codec) → onTagUpdate
 *
 *   connection: { host, modbusPort, scheme(http|https), apiPort, tlsInsecure, apiKey, pollMs }
 *   ⏳ P2 = read-only (subscribe) · two-way write = P4 · relay = P6
 */
class KpenetworkDriver {
  constructor(device, onTagUpdate, onDiscover) {
    this.device = device;
    this.onTagUpdate = onTagUpdate;   // (deviceId, tagId, value) → engine._setTagValue
    this.onDiscover = onDiscover || null;  // เรียกหลัง discover (ให้ KPENETWORK server rebuild — relay §3.5)
    this.onStatusChange = null;        // §76 B: engine wire ให้ → เรียกเมื่อ connected เปลี่ยน (push __online ทันที)
    this.connected = false;
    this.client = null;
    this._ws = null;                  // §76: WebSocket client (transport ws)
    this._wsHb = null;                // §76: heartbeat timer (ping source · จับ server ตาย realtime)
    this._entries = [];               // directory entries (มี area/address/words/dataType/scale)
    this._timer = null;
    this._stopped = false;
    this._busy = false;
    this._lastTry = 0;
  }

  _conn() { return this.device.connection || {}; }

  // §76 B: ตั้งสถานะ connected · ถ้าเปลี่ยนจริง → เรียก onStatusChange (engine sweep+broadcast __online ทันที)
  _setConnected(v) {
    v = !!v;
    if (this.connected === v) return;
    this.connected = v;
    try { if (this.onStatusChange) this.onStatusChange(); } catch (_) {}
  }

  // ── control plane (REST): ดึง directory ผ่าน http/https (รองรับ self-signed ด้วย tlsInsecure) ──
  _fetchDirectoryRest() {
    const c = this._conn();
    const scheme = (c.scheme || 'http').toLowerCase();
    const lib = scheme === 'https' ? https : http;
    const opts = {
      host: c.host,
      port: parseInt(c.apiPort, 10) || (scheme === 'https' ? 443 : 3012),
      path: '/api/kpenetwork/directory',
      method: 'GET',
      headers: c.apiKey ? { 'x-api-key': c.apiKey } : {},
      timeout: 4000,
    };
    if (scheme === 'https' && c.tlsInsecure) opts.rejectUnauthorized = false;
    return new Promise((resolve, reject) => {
      const req = lib.request(opts, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`directory HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('directory timeout')));
      req.end();
    });
  }

  // ── data plane (REST): ดึงค่า tag ที่แชร์แบบ rest transport (STRING ฯลฯ) → { "<device>/<tag>": value } ──
  _fetchValuesRest() {
    const c = this._conn();
    const scheme = (c.scheme || 'http').toLowerCase();
    const lib = scheme === 'https' ? https : http;
    const opts = {
      host: c.host,
      port: parseInt(c.apiPort, 10) || (scheme === 'https' ? 443 : 3012),
      path: '/api/kpenetwork/values',
      method: 'GET',
      headers: c.apiKey ? { 'x-api-key': c.apiKey } : {},
      timeout: 4000,
    };
    if (scheme === 'https' && c.tlsInsecure) opts.rejectUnauthorized = false;
    return new Promise((resolve, reject) => {
      const req = lib.request(opts, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`values HTTP ${res.statusCode}`));
          try { const j = JSON.parse(body); resolve(j && j.values ? j.values : {}); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('values timeout')));
      req.end();
    });
  }

  // ── control plane (Modbus): อ่าน directory จาก register block (P7 · single-port · ไม่มี relay) ──
  async _fetchDirectoryModbus() {
    const head = await this.client.readHoldingRegisters(kdir.DIR_BASE, kdir.HEADER_WORDS);
    const regs = head.data.slice();
    if ((regs[0] & 0xFFFF) !== kdir.MAGIC) throw new Error('no modbus directory (magic mismatch)');
    const count = regs[2] & 0xFFFF;
    const total = kdir.dirWordCount(count);
    let read = kdir.HEADER_WORDS;
    while (read < total) {
      const n = Math.min(120, total - read);
      const r = await this.client.readHoldingRegisters(kdir.DIR_BASE + read, n);
      for (const w of r.data) regs.push(w);
      read += n;
    }
    const entries = kdir.decode(regs);
    if (!entries) throw new Error('directory decode failed');
    return { nodeId: '', entries };
  }

  // ดึง directory ของ peer แบบ one-shot (สำหรับ UI picker — ไม่ต้อง start poll loop)
  async probeDirectory() {
    const c = this._conn();
    const mode = (c.directoryMode || 'auto').toLowerCase();
    let dir = null;
    if (mode === 'rest' || mode === 'auto') {
      try { dir = await this._fetchDirectoryRest(); }
      catch (e) { if (mode === 'rest') throw e; }
    }
    if (!dir && (mode === 'modbus' || mode === 'auto')) {
      try { if (this.client) this.client.close(() => {}); } catch (_) {}
      this.client = new ModbusRTU();
      try {
        await Promise.race([
          this.client.connectTCP(c.host, { port: parseInt(c.modbusPort, 10) || 5020 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 4000)),
        ]);
        this.client.setID(1); this.client.setTimeout(2000);
        dir = await this._fetchDirectoryModbus();
      } finally { try { this.client.close(() => {}); } catch (_) {} this.client = null; }
    }
    return dir || { nodeId: '', entries: [] };
  }

  // id ของ network tag = "<device ต้นทาง>.<tag>" (กันชนเมื่อ source หลาย device มี tag ชื่อซ้ำ)
  _netKey(e) { return (e && e.device) ? `${e.device}.${e.tag}` : `${e && e.tag}`; }

  // map directory → device.tags (network tag) + เก็บ entries สำหรับ poll + relay metadata (§3.5)
  _applyDirectory(dir) {
    let entries = (dir && Array.isArray(dir.entries)) ? dir.entries : [];
    // เลือกเฉพาะ tag ที่ผู้ใช้เลือกไว้ (subscribeTags = key "<device>.<tag>") — ว่าง = เอาทั้งหมด
    const sub = Array.isArray(this._conn().subscribeTags) ? this._conn().subscribeTags : [];
    if (sub.length) entries = entries.filter((e) => sub.includes(this._netKey(e)));
    this._entries = entries;
    const origin = (dir && dir.nodeId) || '';
    const relayTags = Array.isArray(this._conn().relayTags) ? this._conn().relayTags : [];  // tagId ที่ node นี้ re-share
    this.device.tags = entries.map((e) => ({
      id: this._netKey(e),           // "<srcDevice>.<tag>" — unique + บอกที่มา
      name: e.name || e.tag,         // ชื่อสั้น (เดิม) สำหรับแสดง
      dataType: e.dataType,
      wordOrder: e.wordOrder || 'ABCD',
      scale: e.scale || 1,
      network: true,                 // มาจากเครือข่าย (UI โชว์ badge)
      readOnly: !e.writable,         // writable ตามที่ origin อนุญาต
      origin: e.origin || origin,    // nodeId ต้นทาง (เช่น KPE-2)
      srcDevice: e.device || '',     // device ต้นทางของ tag นี้ (เช่น weightsoi8)
      relayAllowed: !!e.relayAllowed,
      // re-share (relay): node นี้เลือก re-share tag นี้ + origin ต้องอนุญาต relay
      shared: relayTags.includes(e.tag) && !!e.relayAllowed,
      shareWritable: !!e.writable,
      _area: e.area, _address: e.address, _words: e.words || 1,
      _origin: e.origin || origin, _path: Array.isArray(e.path) ? e.path : [], _hops: e.hops || 0,
    }));
    if (this.onDiscover) { try { this.onDiscover(); } catch (_) {} }
  }

  // transport: 'ws' = WebSocket (push) · อื่น ๆ (auto/modbus/rest) = Modbus+REST เดิม (default · ไม่เปลี่ยนพฤติกรรม)
  _transport() { return (this._conn().transport || 'auto').toLowerCase(); }

  async connect() {
    this._stopped = false;
    if (this._transport() === 'ws') {
      this._connectWs();
      // §76 A: heartbeat ping source ทุก 2s (เดิม 4s) · ไม่ pong กลับ → server ตาย/หลุด → terminate → reconnect (realtime) · config wsHbMs ได้
      if (this._wsHb) clearInterval(this._wsHb);
      const hbMs = parseInt(this._conn().wsHbMs, 10) || 2000;
      this._wsHb = setInterval(() => {
        const w = this._ws;
        if (!w || w.readyState !== 1) return;
        if (w.isAlive === false) { try { w.terminate(); } catch (_) {} return; }
        w.isAlive = false;
        try { w.ping(); } catch (_) {}
      }, hbMs);
    } else await this._tryConnect();
    const pollMs = parseInt(this._conn().pollMs, 10) || 500;
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), pollMs);
  }

  async _tick() {
    if (this._stopped || this._busy) return;
    this._busy = true;
    try {
      if (this._transport() === 'ws') {
        // ws = push-based: แค่เช็คว่ายังต่ออยู่ไหม · หลุด → reconnect (throttle 3s)
        if (!this._ws || this._ws.readyState > 1) {
          const now = Date.now();
          if (!this._lastTry || now - this._lastTry >= 3000) { this._lastTry = now; this._connectWs(); }
        }
      } else {
        if (!this.connected) await this._tryConnect();
        else await this._poll();
      }
    } catch (_) { /* กันหลุด */ } finally { this._busy = false; }
  }

  // ── transport ws (§76): เปิด WebSocket ไป source → รับ directory + push update (string/ทุกชนิด) ──
  _connectWs() {
    const c = this._conn();
    try { if (this._ws) { this._ws.removeAllListeners(); this._ws.terminate(); } } catch (_) {}
    this._ws = null;
    const scheme = (c.scheme || 'http').toLowerCase() === 'https' ? 'wss' : 'ws';
    const port = parseInt(c.apiPort, 10) || (scheme === 'wss' ? 443 : 3012);
    const subs = Array.isArray(c.subscribeTags) ? c.subscribeTags : [];
    const q = subs.length ? `?tags=${encodeURIComponent(subs.join(','))}` : '';
    const url = `${scheme}://${c.host}:${port}/api/kpenetwork/ws${q}`;
    const headers = { 'x-kpe-node': this.device.name || this.device.id };
    if (c.apiKey) headers['x-api-key'] = c.apiKey;
    const opts = { headers, handshakeTimeout: 4000 };
    if (scheme === 'wss' && c.tlsInsecure) opts.rejectUnauthorized = false;
    let ws;
    try { ws = new WebSocket(url, opts); } catch (e) { this._setConnected(false); return; }
    this._ws = ws;
    ws.isAlive = true;
    ws.on('open', () => { this._setConnected(true); });   // §76 B: push __online ทันที (ไม่รอ sweep 1s)
    ws.on('pong', () => { ws.isAlive = true; });   // heartbeat: source ตอบ → ยังมีชีวิต
    ws.on('message', (raw) => this._onWsMessage(raw));
    ws.on('close', () => { if (this._ws === ws) { this._ws = null; this._setConnected(false); } });   // §76 B: __online ทันที
    ws.on('error', (e) => { this._setConnected(false); console.error(`[KPENETWORK] ws (${this.device.name}):`, e && e.message); });
  }

  _onWsMessage(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.type === 'directory') {
      this._applyDirectory(m);   // สร้าง network tag (filter subscribeTags ในนั้น)
    } else if (m.type === 'snapshot' || m.type === 'update') {
      if (!this.onTagUpdate) return;
      for (const it of (m.items || [])) {
        this.onTagUpdate(this.device.id, `${it.device}.${it.tag}`, it.value);   // netKey = device.tag
      }
    }
  }

  async _tryConnect() {
    const now = Date.now();
    if (this._lastTry && now - this._lastTry < 3000) return;  // throttle reconnect
    this._lastTry = now;
    const c = this._conn();
    const mode = (c.directoryMode || 'auto').toLowerCase();   // auto | rest | modbus

    // 1) data plane — modbus client (ต่อก่อน เผื่อ directory ผ่าน Modbus)
    try { if (this.client) this.client.close(() => {}); } catch (_) {}
    this.client = new ModbusRTU();
    try {
      await Promise.race([
        this.client.connectTCP(c.host, { port: parseInt(c.modbusPort, 10) || 5020 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 4000)),
      ]);
      this.client.setID(1);
      this.client.setTimeout(2000);
    } catch (e) {
      this._setConnected(false);
      try { this.client.close(() => {}); } catch (_) {}
      console.error(`[KPENETWORK] modbus (${this.device.name}):`, e.message);
      return;
    }

    // 2) control plane — directory (rest / modbus / auto=ลอง rest ก่อน → fallback modbus)
    let dir = null;
    if (mode === 'rest' || mode === 'auto') {
      try { dir = await this._fetchDirectoryRest(); }
      catch (e) { if (mode === 'rest') console.error(`[KPENETWORK] discover REST (${this.device.name}):`, e.message); }
    }
    if (!dir && (mode === 'modbus' || mode === 'auto')) {
      try { dir = await this._fetchDirectoryModbus(); }
      catch (e) { console.error(`[KPENETWORK] discover Modbus (${this.device.name}):`, e.message); }
    }
    if (!dir) {
      this._setConnected(false);
      try { this.client.close(() => {}); } catch (_) {}
      return;
    }
    this._applyDirectory(dir);
    this._setConnected(true);

    // ตรวจหลุดทันทีผ่าน socket events (ไม่ต้องรอ read timeout 2s) — เหมือน modbusDriver
    const sock = this.client._port && this.client._port._client;
    if (sock && typeof sock.on === 'function') {
      sock.on('close', () => { this._setConnected(false); });
      sock.on('error', () => { this._setConnected(false); });
    }
    console.log(`[KPENETWORK] connected ${this.device.name} → ${c.host}:${c.modbusPort} (${this._entries.length} tag · dir=${mode})`);
  }

  async _poll() {
    // data plane (Modbus): numeric/bool — register/coil
    for (const e of this._entries) {   // _entries = raw directory entries (.area/.address/.words)
      if (this._stopped || !this.connected) return;
      if (e.area === 'rest') continue; // rest transport → ดึงผ่าน REST ด้านล่าง
      try {
        let value;
        if (e.area === 'coil') {
          const r = await this.client.readCoils(e.address, 1);
          value = r.data[0] ? 1 : 0;
        } else {
          const fn = e.area === 'input' ? 'readInputRegisters' : 'readHoldingRegisters';
          const r = await this.client[fn](e.address, e.words || 1);
          value = codec.decodeWords(r.data, e.dataType, e.wordOrder || 'ABCD');
          if (e.scale && e.scale !== 1) value = value * e.scale;
          if (typeof value === 'number' && !Number.isInteger(value)) value = Math.round(value * 1e6) / 1e6;
        }
        if (this.onTagUpdate) this.onTagUpdate(this.device.id, this._netKey(e), value);
      } catch (_) {
        this._setConnected(false);  // หลุด → tick หน้าจะ reconnect
        return;
      }
    }
    // data plane (REST): STRING ฯลฯ — ดึงทีเดียวทั้งชุด · fail ไม่ตัด connection (เป็นคนละช่องกับ Modbus)
    const restEntries = this._entries.filter((e) => e.area === 'rest');
    if (restEntries.length && this.connected && !this._stopped) {
      try {
        const vals = await this._fetchValuesRest();
        for (const e of restEntries) {
          const v = vals[`${e.device}/${e.tag}`];
          if (v !== undefined && this.onTagUpdate) this.onTagUpdate(this.device.id, this._netKey(e), v);
        }
      } catch (_) { /* rest poll พลาด → ข้ามรอบนี้ (ไม่กระทบ modbus) */ }
    }
  }

  // push-based: engine ไม่เรียก readTag (กันเรียกผิด → คืน null)
  async readTag() { return null; }

  // P4 two-way: เขียน network tag กลับไป peer (เฉพาะ tag ที่ peer อนุญาต writable)
  async writeTag(tag, value) {
    if (tag.readOnly) throw new Error('network tag เป็น read-only (peer ไม่อนุญาตเขียนกลับ)');
    if (!this.connected || !this.client) throw new Error('Not connected');
    const raw = tag.scale ? value / tag.scale : value;
    if (tag._area === 'coil') {
      await this.client.writeCoil(tag._address, value ? true : false);
    } else {
      const words = codec.encodeValue(raw, tag.dataType || 'INT16', tag.wordOrder || 'ABCD');
      await this.client.writeRegisters(tag._address, words);   // FC16 atomic ทั้งค่า
    }
  }

  disconnect() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._wsHb) { clearInterval(this._wsHb); this._wsHb = null; }
    if (this._ws) { try { this._ws.removeAllListeners(); this._ws.close(); } catch (_) {} this._ws = null; }
    if (this.client) { try { this.client.close(() => {}); } catch (_) {} this.client = null; }
    this.connected = false;
  }
}

module.exports = KpenetworkDriver;
