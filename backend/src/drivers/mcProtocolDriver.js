const net = require('net');
const dgram = require('dgram');
const { decodeMultiBit } = require('./bitDecode');

// Mitsubishi MC Protocol 3E Frame implementation (TCP or UDP — เฟรมเหมือนกัน ต่างแค่ transport)
class MCProtocolDriver {
  constructor(device) {
    this.device = device;
    this.connected = false;
    this.socket = null;
    this.serialNo = 0;
    this._connecting = null;
    this.transport = ((device.connection && device.connection.transport) || 'tcp').toLowerCase();
  }

  async connect() {
    if (this.connected) return true;
    // กัน race: ถ้ากำลังต่ออยู่แล้ว ใช้ promise เดิม (ไม่สร้าง socket ซ้อน)
    if (this._connecting) return this._connecting;
    return this.transport === 'udp' ? this._connectUdp() : this._connectTcp();
  }

  _connectTcp() {
    // เคลียร์ socket เก่า (ถ้ามี) ก่อนต่อใหม่ — ปลด slot ที่อาจค้าง
    // (สำคัญกับ PLC ที่รับได้ทีละ 1 connection — socket ซ้อนจะทิ้ง orphan ค้าง slot)
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} this.socket = null; }

    this._connecting = new Promise((resolve) => {
      const { host, port } = this.device.connection;
      const socket = new net.Socket();
      this.socket = socket;
      socket.setTimeout(5000);
      socket.setKeepAlive(true, 3000);

      socket.connect(port, host, () => {
        this.connected = true;
        this._connecting = null;
        console.log(`[MC Protocol/TCP] Connected: ${this.device.name}`);
        resolve(true);
      });

      socket.on('error', (err) => {
        this.connected = false;
        this._connecting = null;
        console.error(`[MC Protocol/TCP] Error (${this.device.name}):`, err.message);
        resolve(false);
      });

      socket.on('timeout', () => {
        this.connected = false;
        this._connecting = null;
        socket.destroy();
        resolve(false);
      });

      socket.on('close', () => {
        this.connected = false;
      });
    });
    return this._connecting;
  }

  // UDP เป็น connectionless → bind socket แล้วถือว่าพร้อมส่ง (online ตัดสินจากการอ่านสำเร็จ/_lastGoodRead)
  _connectUdp() {
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    this._connecting = new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      this.socket = sock;
      sock.on('error', (err) => {
        this.connected = false;
        this._connecting = null;
        console.error(`[MC Protocol/UDP] Error (${this.device.name}):`, err.message);
        try { sock.close(); } catch (_) {}
        if (this.socket === sock) this.socket = null;
        resolve(false);
      });
      sock.bind(() => {
        this.connected = true;
        this._connecting = null;
        console.log(`[MC Protocol/UDP] Ready: ${this.device.name}`);
        resolve(true);
      });
    });
    return this._connecting;
  }

  // ส่ง request → คืน response buffer เต็ม หรือ null — รองรับทั้ง TCP/UDP
  // ⚠️ serialize ทุกคำสั่งบน socket เดียว: MC 3E ไม่มี transaction ID จับคู่ req↔resp
  //    ถ้า read (poll) กับ write (set) ซ้อนกัน → response 2 คำสั่งปนกัน = ค่าหลาย tag มั่ว/สลับ
  _transact(request) {
    const run = () => this._transactRaw(request);
    this._txChain = (this._txChain || Promise.resolve()).then(run, run);
    return this._txChain;
  }

  _transactRaw(request) {
    return new Promise((resolve) => {
      const sock = this.socket;
      if (!sock) return resolve(null);
      if (this.transport === 'udp') {
        const { host, port } = this.device.connection;
        const onMsg = (msg) => { clearTimeout(t); sock.removeListener('message', onMsg); resolve(msg); };
        sock.on('message', onMsg);
        const t = setTimeout(() => { sock.removeListener('message', onMsg); resolve(null); }, 3000);
        sock.send(request, port, host, (err) => {
          if (err) { clearTimeout(t); sock.removeListener('message', onMsg); resolve(null); }
        });
      } else {
        let buf = Buffer.alloc(0);
        const done = (val) => { clearTimeout(t); sock.removeListener('data', onData); resolve(val); };
        const onData = (data) => {
          buf = Buffer.concat([buf, data]);
          // 3E response: byte 7-8 (LE) = ความยาว data นับจาก end code → เฟรมเต็ม = 9 + dataLen
          // อ่านจนครบเฟรม (ไม่ resolve ตั้งแต่ 11 byte) เพื่อกัน data ที่มาช้าตกค้างไปปนคำสั่งถัดไป
          if (buf.length >= 9) {
            const need = 9 + buf.readUInt16LE(7);
            if (buf.length >= need) done(buf.slice(0, need));
          }
        };
        sock.on('data', onData);
        const t = setTimeout(() => { sock.removeListener('data', onData); resolve(buf.length >= 11 ? buf : null); }, 3000);
        sock.write(request, (err) => {
          if (err) done(null);
        });
      }
    });
  }

  // Read a single device (D, M, X, Y, etc.)
  _wordCount(dataType) {
    const dt = (dataType || 'INT16').toUpperCase();
    if (['INT32','UINT32','FLOAT32','REAL'].includes(dt)) return 2;
    if (['INT64','UINT64','FLOAT64','DOUBLE','LREAL'].includes(dt)) return 4;
    return 1;
  }

  async readTag(tag) {
    if (!this.connected) return null;
    try {
      const addr = tag.address;
      const deviceCode = addr.replace(/[0-9]/g, '');
      const deviceNum = parseInt(addr.replace(/[A-Za-z]/g, ''), 10);
      const isBit = ['M', 'X', 'Y', 'B', 'F', 'L', 'S', 'V'].includes(deviceCode.toUpperCase());

      // ── MULTI_BIT: อ่าน bit ต่อเนื่อง N ตัวจาก address ฐาน (เช่น M8 bits=20 → M8–M27)
      //    decode ตาม bitMode (decimal เดิม / sequence ลำดับ) · อ่านครั้งเดียวทั้งชุด
      if (String(tag.dataType || '').toUpperCase() === 'MULTI_BIT' && isBit) {
        const n = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
        const resp = await this._sendCommand(deviceCode, deviceNum, n, true);
        if (!resp || resp.length < Math.ceil(n / 2)) return null;
        // 3E binary bit-read: nibble-packed — bit คู่อยู่ครึ่งสูง bit คี่อยู่ครึ่งต่ำของ byte
        const bits = [];
        for (let i = 0; i < n; i++) bits.push((i % 2 === 0) ? (resp[i >> 1] >> 4) & 1 : resp[i >> 1] & 1);
        return decodeMultiBit(bits, tag.bitMode);
      }

      if (isBit) {
        const response = await this._sendCommand(deviceCode, deviceNum, 1, true);
        if (!response) return null;
        // 3E binary bit-read: bit แรกอยู่ครึ่งสูงของ byte (nibble-packed)
        return (response[0] >> 4) & 0x01;
      }

      const dt    = (tag.dataType || 'INT16').toUpperCase();

      // ── STRING / ASCII — อ่าน N word แล้วถอดเป็นข้อความ (Mitsubishi: low byte = ตัวอักษรแรก) ──
      if (dt === 'STRING' || dt === 'ASCII') {
        const n = Math.max(1, Math.min(parseInt(tag.words) || 4, 120));
        const resp = await this._sendCommand(deviceCode, deviceNum, n, false);
        if (!resp || resp.length < n * 2) return null;
        // MC ส่ง byte little-endian (low byte ก่อน) = ลำดับตัวอักษรพอดี (D0 low=char0, high=char1)
        return Buffer.from(resp.slice(0, n * 2)).toString('latin1').replace(/\0+$/, '').replace(/\s+$/, '');
      }

      const count = this._wordCount(dt);
      const response = await this._sendCommand(deviceCode, deviceNum, count, false);
      if (!response || response.length < count * 2) return null;

      // MC ส่ง byte แบบ little-endian (low byte ก่อน) และ word เรียง low-word ก่อน
      // → response เป็น little-endian buffer พอดี สำหรับค่า multi-word ของ Mitsubishi
      let buf = Buffer.from(response.slice(0, count * 2));
      // wordSwap = สลับลำดับ word (เผื่อ PLC ที่เก็บ high-word ก่อน)
      if (tag.wordSwap && count > 1) {
        const sw = Buffer.alloc(count * 2);
        for (let i = 0; i < count; i++) buf.copy(sw, (count-1-i)*2, i*2, i*2+2);
        buf = sw;
      }

      let val;
      switch (dt) {
        case 'INT16':   val = buf.readInt16LE(0); break;
        case 'UINT16':  val = buf.readUInt16LE(0); break;
        case 'INT32':   val = buf.readInt32LE(0); break;
        case 'UINT32':  val = buf.readUInt32LE(0); break;
        case 'FLOAT32':
        case 'REAL':    val = buf.readFloatLE(0); break;
        case 'INT64':   val = Number(buf.readBigInt64LE(0)); break;
        case 'UINT64':  val = Number(buf.readBigUInt64LE(0)); break;
        case 'FLOAT64':
        case 'DOUBLE':
        case 'LREAL':   val = buf.readDoubleLE(0); break;
        default:        val = buf.readUInt16LE(0);
      }
      if (tag.scale) val = val * tag.scale;
      if (typeof val === 'number' && !Number.isInteger(val)) val = Math.round(val * 1e6) / 1e6;
      return val;
    } catch (err) {
      this.connected = false;
      return null;
    }
  }

  async writeTag(tag, value) {
    if (!this.connected) throw new Error('Not connected');
    const addr = tag.address;
    const deviceCode = addr.replace(/[0-9]/g, '');
    const deviceNum = parseInt(addr.replace(/[A-Za-z]/g, ''), 10);
    const isBit = ['M', 'X', 'Y', 'B', 'F', 'L', 'S', 'V'].includes(deviceCode.toUpperCase());

    // ── MULTI_BIT write: decimal → กระจายเป็น bit ต่อเนื่อง N ตัว เขียนครั้งเดียว ──
    if (String(tag.dataType || '').toUpperCase() === 'MULTI_BIT' && isBit) {
      const n = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
      const num = Math.max(0, Math.floor(Number(value) || 0));
      const buf = Buffer.alloc(Math.ceil(n / 2));   // nibble-packed (เหมือนฝั่ง read)
      for (let i = 0; i < n; i++) {
        if (Math.floor(num / 2 ** i) % 2) buf[i >> 1] |= (i % 2 === 0) ? 0x10 : 0x01;
      }
      await this._sendWriteCommand(deviceCode, deviceNum, buf, true, n);   // count = n บิต (เดิม fix=1 → MULTI_BIT เขียนผิด)
      return;
    }

    if (isBit) {
      // 3E binary bit-write: bit แรกอยู่ครึ่งสูงของ byte → ON = 0x10, OFF = 0x00
      await this._sendWriteCommand(deviceCode, deviceNum, Buffer.from([value ? 0x10 : 0x00]), true, 1);
      return;
    }

    // Word write — รองรับ 16/32/64-bit (MC เก็บ little-endian, low-word ก่อน)
    const dt    = (tag.dataType || 'INT16').toUpperCase();

    // ── STRING / ASCII write — เข้ารหัสข้อความเป็น N word (low byte = ตัวอักษรแรก) ──
    if (dt === 'STRING' || dt === 'ASCII') {
      const n = Math.max(1, Math.min(parseInt(tag.words) || 4, 120));
      const buf = Buffer.alloc(n * 2);  // zero-padded
      Buffer.from(String(value ?? ''), 'latin1').copy(buf, 0, 0, n * 2);
      await this._sendWriteCommand(deviceCode, deviceNum, buf, false);
      return;
    }

    const count = this._wordCount(dt);
    const raw   = tag.scale ? value / tag.scale : value;
    let buf = Buffer.alloc(count * 2);
    switch (dt) {
      case 'INT16':   buf.writeInt16LE(Math.round(raw) & 0xFFFF, 0); break;
      case 'UINT16':  buf.writeUInt16LE(Math.round(raw) & 0xFFFF, 0); break;
      case 'INT32':   buf.writeInt32LE(Math.round(raw), 0); break;
      case 'UINT32':  buf.writeUInt32LE(Math.round(raw) >>> 0, 0); break;
      case 'FLOAT32':
      case 'REAL':    buf.writeFloatLE(raw, 0); break;
      case 'INT64':   buf.writeBigInt64LE(BigInt(Math.round(raw)), 0); break;
      case 'UINT64':  buf.writeBigUInt64LE(BigInt(Math.round(raw)), 0); break;
      case 'FLOAT64':
      case 'DOUBLE':
      case 'LREAL':   buf.writeDoubleLE(raw, 0); break;
      default:        buf.writeInt16LE(Math.round(raw) & 0xFFFF, 0);
    }
    // wordSwap = สลับลำดับ word (ให้ตรงกับ readTag ที่มี option เดียวกัน)
    if (tag.wordSwap && count > 1) {
      const sw = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.copy(sw, (count - 1 - i) * 2, i * 2, i * 2 + 2);
      buf = sw;
    }
    await this._sendWriteCommand(deviceCode, deviceNum, buf, false);
  }

  _getDeviceCodeByte(code) {
    // MELSEC 3E binary device codes (1 byte)
    const map = {
      D: 0xA8, R: 0xAF, ZR: 0xB0, W: 0xB4, SD: 0xA9, SW: 0xB5, Z: 0xCC,            // word
      M: 0x90, SM: 0x91, L: 0x92, F: 0x93, V: 0x94, S: 0x98, B: 0xA0, SB: 0xA1,    // bit
      X: 0x9C, Y: 0x9D, DX: 0xA2, DY: 0xA3,
      TN: 0xC2, TS: 0xC1, TC: 0xC0, CN: 0xC5, CS: 0xC4, CC: 0xC3,                  // timer/counter
    };
    const c = String(code || '').toUpperCase();
    if (map[c] == null) { console.warn(`[mc] device code "${code}" ไม่รู้จัก → fallback D (อาจอ่านผิด area!)`); return 0xA8; }
    return map[c];
  }

  _buildRequest(commandHex, subCommandHex, payload) {
    const serialNo = (this.serialNo++ & 0xFFFF);
    const header = Buffer.from([
      0x50, 0x00,             // Subheader 3E
      0x00,                   // Network No
      0xFF,                   // PC No
      0xFF, 0x03,             // Request destination module I/O No
      0x00,                   // Request destination module station No
    ]);
    // Monitoring timer (2 bytes LE) — MELSEC 3E ต้องมี! (0x0010 = ค่ามาตรฐาน)
    const monitorTimer = Buffer.from([0x10, 0x00]);
    const cmd = Buffer.from([
      commandHex & 0xFF, (commandHex >> 8) & 0xFF,
      subCommandHex & 0xFF, (subCommandHex >> 8) & 0xFF,
    ]);
    // data length นับ monitoring timer + command + payload
    const body = Buffer.concat([monitorTimer, cmd, payload]);
    const dataLen = Buffer.alloc(2);
    dataLen.writeUInt16LE(body.length, 0);
    return Buffer.concat([header, dataLen, body]);
  }

  async _sendCommand(deviceCode, startAddr, count, isBit) {
    const addrBuf = Buffer.alloc(4);
    addrBuf.writeUInt32LE(startAddr, 0);
    const cntBuf = Buffer.alloc(2);
    cntBuf.writeUInt16LE(count, 0);
    const devCode = Buffer.from([this._getDeviceCodeByte(deviceCode)]); // 1 byte (มาตรฐาน 3E binary)

    const payload = Buffer.concat([addrBuf.slice(0, 3), devCode, cntBuf]);
    const subCmd = isBit ? 0x0001 : 0x0000;
    const request = this._buildRequest(0x0401, subCmd, payload);

    const resp = await this._transact(request);
    return resp ? resp.slice(11) : null; // ตัด 11-byte 3E response header
  }

  // valBuf = buffer ค่าที่จะเขียน (bit = nibble-packed, word = count*2 bytes little-endian)
  //   pointCount = จำนวน device points (bit: single=1, MULTI_BIT=n · word: จำนวน word) · ไม่ส่ง = เดาจาก valBuf
  async _sendWriteCommand(deviceCode, startAddr, valBuf, isBit, pointCount) {
    const addrBuf = Buffer.alloc(4);
    addrBuf.writeUInt32LE(startAddr, 0);
    const count = pointCount != null ? pointCount : (isBit ? 1 : valBuf.length / 2);
    const cntBuf = Buffer.alloc(2);
    cntBuf.writeUInt16LE(count, 0);
    const devCode = Buffer.from([this._getDeviceCodeByte(deviceCode)]); // 1 byte (มาตรฐาน 3E binary)

    const payload = Buffer.concat([addrBuf.slice(0, 3), devCode, cntBuf, valBuf]);
    const subCmd = isBit ? 0x0001 : 0x0000;
    const request = this._buildRequest(0x1401, subCmd, payload);

    // ตรวจ end code ของ PLC (เดิมทิ้ง response → write ที่ PLC ปฏิเสธกลายเป็น "สำเร็จเงียบ ๆ" → ค่าไม่เปลี่ยนแต่ไม่มี error)
    const resp = await this._transact(request);
    if (!resp || resp.length < 11) throw new Error(`MC write: ไม่มี/สั้นเกิน response (timeout?) @${deviceCode}${startAddr}`);
    const end = resp.readUInt16LE(9);   // 3E binary: end code อยู่ byte 9-10 (LE) · 0 = สำเร็จ
    if (end !== 0) throw new Error(`MC write ถูก PLC ปฏิเสธ: end code 0x${end.toString(16).padStart(4, '0')} @${deviceCode}${startAddr} (เช่น write-protect / write-during-RUN ปิด / device range / X เป็น input)`);
  }

  disconnect() {
    if (this.socket) {
      try { this.transport === 'udp' ? this.socket.close() : this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
  }
}

module.exports = MCProtocolDriver;
