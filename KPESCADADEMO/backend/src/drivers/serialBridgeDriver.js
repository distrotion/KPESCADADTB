/**
 * Serial Bridge Driver — RS232 MITM passthrough (USB-to-serial 2 อัน)
 * ═══════════════════════════════════════════════════════════════════════════
 * คั่นกลางสาย A↔B:  [A] ─portA─ (bridge) ─portB─ [B]
 *   - relay ไบต์โปร่งใส 2 ทิศ (byte-level ทันที · ไม่รอ framing → ไม่หน่วง A↔B)
 *   - dัก frame แต่ละทิศ (framing ต่อทิศ) → ring buffer(sniffer) + onFrame(script trigger) + parse→tag
 * ทิศ: data เข้า portA = เดินทาง A→B ('a2b') · data เข้า portB = B→A ('b2a')
 *
 * config (device.connection):
 *   portA/portB : { port, baudRate, dataBits, stopBits, parity }
 *   a2b / b2a   : { frameMode, delimiter, silenceMs, startChar, endChar, frameLen,
 *                   parseMode, transform, csvSeparator, kvPairSep, kvSep }
 *   snifferBuffer (500) · reconnectMs (3000)
 * tags: [{ id, dir:'a2b'|'b2a', ...parse fields }]  — dir ไม่ระบุ = 'a2b'
 *
 * opts.makePort(portCfg) → คืน object พอร์ต (real SerialPort default · inject mock ได้ตอนเทส)
 */
const framing = require('./serialFraming');
const { compileTransform, parseFrame } = require('./serialParse');

class SerialBridgeDriver {
  constructor(device, onTagUpdate, onFrame, opts = {}) {
    this.device      = device;
    this.onTagUpdate = onTagUpdate || (() => {});
    this.onFrame     = onFrame || null;   // (deviceId, raw, meta{dir,hex,ts,port})
    this._makePort   = opts.makePort || null;   // inject (เทส) · null = ใช้ SerialPort จริง
    const c = device.connection || {};
    this._reconnectMs = Number(c.reconnectMs) || 3000;
    this._ringMax     = Number(c.snifferBuffer) || 500;
    this._ring        = [];                // scrollback sniffer: [{ts,dir,raw,hex}]
    this.connected    = false;             // true = เปิดครบทั้ง 2 พอร์ต
    this._want        = false;
    this._sides       = {};                // 'A'|'B' → { port, timer }
    this._script      = {                  // compiled transform ต่อทิศ (function mode)
      a2b: compileTransform((c.a2b || {}).transform, device.id + ':a2b'),
      b2a: compileTransform((c.b2a || {}).transform, device.id + ':b2a'),
    };
  }

  _dirCfg(dir) { return (this.device.connection && this.device.connection[dir]) || {}; }
  _portCfg(side) { const c = this.device.connection || {}; return (side === 'A' ? c.portA : c.portB) || {}; }
  _other(side) { const o = this._sides[side === 'A' ? 'B' : 'A']; return o && o.port; }

  _newPort(pc) {
    if (this._makePort) return this._makePort(pc);
    const { SerialPort } = require('serialport');
    return new SerialPort({
      path: pc.port, baudRate: pc.baudRate || 9600, dataBits: pc.dataBits || 8,
      stopBits: pc.stopBits || 1, parity: pc.parity || 'none', autoOpen: false,
    });
  }

  async connect() {
    this._want = true;
    await Promise.all([this._openSide('A'), this._openSide('B')]);
    return this.connected;
  }

  async _openSide(side) {
    const pc = this._portCfg(side);
    const dir = side === 'A' ? 'a2b' : 'b2a';   // data ที่เข้ามาทางนี้ = เดินทางทิศนี้
    // ล้างของเก่า
    const old = this._sides[side];
    if (old && old.port) { try { old.port.removeAllListeners(); if (old.port.isOpen) old.port.close(); } catch (_) {} }

    let port;
    try { port = this._newPort(pc); }
    catch (e) { console.error(`[SerialBridge] make port ${side} (${this.device.name}):`, e.message); this._scheduleReconnect(side); return false; }
    this._sides[side] = { port, timer: (old && old.timer) || null };

    // relay: ไบต์ที่เข้ามา → เขียนออกพอร์ตตรงข้ามทันที (transparent)
    port.on('data', (chunk) => {
      const other = this._other(side);
      if (other && other.isOpen !== false) { try { other.write(chunk); } catch (_) {} }
    });
    // capture: pipe สำเนา → framing parser ต่อทิศ → frame
    const parser = framing.makeParser(this._dirCfg(dir));
    port.pipe(parser);
    parser.on('data', (frame) => this._onFrame(dir, frame));

    port.on('open',  () => { this._clearReconnect(side); this._updateConnected(); console.log(`[SerialBridge] ${side} open: ${this.device.name} @ ${pc.port}`); });
    port.on('error', (e) => { this._updateConnected(); console.error(`[SerialBridge] ${side} error (${this.device.name}):`, e.message); this._scheduleReconnect(side); });
    port.on('close', () => { this._updateConnected(); console.log(`[SerialBridge] ${side} close: ${this.device.name}`); this._scheduleReconnect(side); });

    try {
      if (typeof port.open === 'function') {
        await new Promise((resolve, reject) => port.open((err) => err ? reject(err) : resolve()));
      }
      this._updateConnected();
      return true;
    } catch (err) {
      console.error(`[SerialBridge] ${side} connect failed (${this.device.name}):`, err.message);
      this._scheduleReconnect(side);
      return false;
    }
  }

  _updateConnected() {
    const a = this._sides.A && this._sides.A.port, b = this._sides.B && this._sides.B.port;
    const ok = !!(a && a.isOpen && b && b.isOpen);
    if (ok !== this.connected) { this.connected = ok; if (this.onStatusChange) { try { this.onStatusChange(); } catch (_) {} } }
  }

  _scheduleReconnect(side) {
    if (!this._want) return;
    const s = this._sides[side] || (this._sides[side] = {});
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      const port = s.port;
      if (this._want && !(port && port.isOpen)) {
        console.log(`[SerialBridge] reconnect ${side}: ${this.device.name} ...`);
        this._openSide(side).catch(() => {});
      }
    }, this._reconnectMs);
  }
  _clearReconnect(side) { const s = this._sides[side]; if (s && s.timer) { clearTimeout(s.timer); s.timer = null; } }

  _onFrame(dir, frame) {
    const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(String(frame));
    const raw = buf.toString();
    const trimmed = raw.trim();
    if (!trimmed) return;
    const hex = buf.toString('hex');
    const ts  = Date.now();
    const meta = { dir, hex, ts, port: dir === 'a2b' ? 'A' : 'B' };

    // ring buffer (sniffer scrollback)
    this._ring.push({ ts, dir, raw, hex });
    if (this._ring.length > this._ringMax) this._ring.shift();

    // ยิง script trigger 'serial' + broadcast (server จัดการ) พร้อม meta ทิศ
    if (this.onFrame) { try { this.onFrame(this.device.id, trimmed, meta); } catch (_) {} }

    // parse → tag ต่อทิศ (tag ที่ dir ตรง · dir ว่าง = a2b)
    const tags = (this.device.tags || []).filter((t) => (t.dir || 'a2b') === dir);
    if (tags.length) {
      parseFrame({
        line: trimmed, cfg: this._dirCfg(dir), tags, script: this._script[dir],
        onTag: this.onTagUpdate, deviceId: this.device.id, logId: `${this.device.name || this.device.id}:${dir}`,
      });
    }
  }

  // scrollback สำหรับ sniffer console ตอนเปิด (GET recent)
  recent(limit) { const r = this._ring; return limit ? r.slice(-limit) : r.slice(); }

  // เขียน inject เข้าพอร์ตด้านใดด้านหนึ่งเอง (optional · manual test/probe)
  write(side, data) {
    const s = this._sides[side];
    if (!s || !s.port || s.port.isOpen === false) return false;
    try { s.port.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); return true; } catch (_) { return false; }
  }

  disconnect() {
    this._want = false;
    for (const side of ['A', 'B']) {
      this._clearReconnect(side);
      const s = this._sides[side];
      if (s && s.port) { try { s.port.removeAllListeners(); if (s.port.isOpen) s.port.close(); } catch (_) {} }
    }
    this.connected = false;
  }
}

module.exports = SerialBridgeDriver;
