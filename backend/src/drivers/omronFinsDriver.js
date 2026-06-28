const dgram = require('dgram');
const net = require('net');

// Omron FINS — FINS/UDP หรือ FINS/TCP (TCP ต้องทำ node-address handshake ก่อน)
class OmronFinsDriver {
  constructor(device) {
    this.device = device;
    this.connected = false;
    this.socket = null;
    this.sid = 0;
    this.conn = device.connection;
    this._connecting = null;
    this.transport = ((device.connection && device.connection.transport) || 'udp').toLowerCase();
    this._tcpClientNode = null; // SA1 ที่ PLC จัดให้ตอน handshake (FINS/TCP)
    this._tcpServerNode = null; // DA1 ของ PLC จาก handshake
  }

  async connect() {
    if (this.connected) return true;
    if (this._connecting) return this._connecting;
    return this.transport === 'tcp' ? this._connectTcp() : this._connectUdp();
  }

  // FINS/UDP — connectionless: bind แล้วถือว่าพร้อมส่ง (เหมือนเดิม)
  _connectUdp() {
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    this._connecting = new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      this.socket = sock;
      sock.on('error', (err) => {
        console.error(`[Omron FINS/UDP] Error (${this.device.name}):`, err.message);
        this.connected = false; this._connecting = null;
        try { sock.close(); } catch (_) {}
        if (this.socket === sock) this.socket = null;
        resolve(false);
      });
      sock.bind(() => {
        this.connected = true; this._connecting = null;
        console.log(`[Omron FINS/UDP] Ready: ${this.device.name}`);
        resolve(true);
      });
    });
    return this._connecting;
  }

  // FINS/TCP — ต่อ TCP แล้วทำ node-address handshake ก่อนคุย FINS
  _connectTcp() {
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} this.socket = null; }
    this._connecting = new Promise((resolve) => {
      const { host, port } = this.conn;
      const sock = new net.Socket();
      this.socket = sock;
      sock.setTimeout(5000);
      sock.setKeepAlive(true, 3000);
      sock.connect(port, host, async () => {
        try { sock.setTimeout(0); } catch (_) {}
        const hs = await this._tcpHandshake(sock);
        if (!hs) {
          this.connected = false; this._connecting = null;
          try { sock.destroy(); } catch (_) {}
          if (this.socket === sock) this.socket = null;
          return resolve(false);
        }
        this._tcpClientNode = hs.clientNode;
        this._tcpServerNode = hs.serverNode;
        this.connected = true; this._connecting = null;
        console.log(`[Omron FINS/TCP] Connected: ${this.device.name} (node=${hs.clientNode}, server=${hs.serverNode})`);
        resolve(true);
      });
      sock.on('error', (err) => {
        console.error(`[Omron FINS/TCP] Error (${this.device.name}):`, err.message);
        this.connected = false; this._connecting = null;
        resolve(false);
      });
      sock.on('timeout', () => {
        this.connected = false; this._connecting = null;
        try { sock.destroy(); } catch (_) {}
        resolve(false);
      });
      sock.on('close', () => { this.connected = false; });
    });
    return this._connecting;
  }

  // FINS/TCP node-address handshake — ขอ client/server node จาก PLC
  _tcpHandshake(sock) {
    return new Promise((resolve) => {
      const req = Buffer.alloc(20);
      req.write('FINS', 0, 'ascii');
      req.writeUInt32BE(12, 4);     // length = command(4)+error(4)+clientNode(4)
      req.writeUInt32BE(0x00, 8);   // command = node address data send
      req.writeUInt32BE(0x00, 12);  // error code
      req.writeUInt32BE(0x00, 16);  // client node (0 = ให้ PLC จัดให้)
      let buf = Buffer.alloc(0);
      const onData = (data) => {
        buf = Buffer.concat([buf, data]);
        if (buf.length >= 8) {
          const total = 8 + buf.readUInt32BE(4);
          if (buf.length >= total) {
            clearTimeout(t);
            sock.removeListener('data', onData);
            // response (24 byte): ...(16) clientNode(4) serverNode(4)
            const clientNode = total >= 24 ? (buf.readUInt32BE(16) & 0xFF) : (this.conn.localNode || 0);
            const serverNode = total >= 24 ? (buf.readUInt32BE(20) & 0xFF) : (this.conn.destinationNode || 0);
            resolve({ clientNode, serverNode });
          }
        }
      };
      sock.on('data', onData);
      const t = setTimeout(() => { sock.removeListener('data', onData); resolve(null); }, 3000);
      sock.write(req, (err) => { if (err) { clearTimeout(t); sock.removeListener('data', onData); resolve(null); } });
    });
  }

  _wordCount(dataType) {
    const dt = (dataType || 'INT16').toUpperCase();
    if (['INT32','UINT32','FLOAT32','REAL'].includes(dt)) return 2;
    if (['INT64','UINT64','FLOAT64','DOUBLE','LREAL'].includes(dt)) return 4;
    return 1;
  }

  // แยก address เป็น { word, bit } — รองรับ "W0.0", "0.15", "D100"
  _parseAddr(address) {
    const s = String(address).replace(/[A-Za-z]/g, '');
    if (s.includes('.')) {
      const [w, b] = s.split('.');
      return { word: parseInt(w, 10) || 0, bit: parseInt(b, 10) || 0 };
    }
    return { word: parseInt(s, 10) || 0, bit: null };
  }

  async _readWords(areaCode, wordAddr, count) {
    const response = await this._sendFins(0x01, 0x01, [
      areaCode,
      (wordAddr >> 8) & 0xFF, wordAddr & 0xFF,
      0x00,
      (count >> 8) & 0xFF, count & 0xFF,
    ]);
    if (!response || response.length < count * 2) return null;
    // FINS ส่ง byte big-endian ในแต่ละ word → คืน array ของ 16-bit word
    const words = [];
    for (let i = 0; i < count; i++) {
      words.push((response[i * 2] << 8) | response[i * 2 + 1]);
    }
    return words;
  }

  async readTag(tag) {
    if (!this.connected) return null;
    try {
      const areaCode = this._getAreaCode(tag.area || 'DM');
      const dt = (tag.dataType || 'INT16').toUpperCase();
      const { word, bit } = this._parseAddr(tag.address);

      // ── MULTI_BIT: bit ต่อเนื่อง N ตัวจาก address ฐาน (เช่น W0.4 bits=20 — ข้าม word ได้)
      //    คืน decimal จากฐาน 2 (bit แรก = LSB) · อ่านเป็นชุด word ครั้งเดียว
      if (dt === 'MULTI_BIT') {
        const n = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
        const b0 = bit !== null ? bit : (parseInt(tag.bit) || 0);
        const wordCount = ((b0 + n - 1) >> 4) + 1;
        const ws = await this._readWords(areaCode, word, wordCount);
        if (!ws) return null;
        let v = 0;
        for (let i = 0; i < n; i++) {
          const g = b0 + i;
          if ((ws[g >> 4] >> (g & 15)) & 1) v += 2 ** i;
        }
        return v;
      }

      // ── BIT-level (W0.0) หรือ dataType BOOL/BIT ───────────────────────────
      if (dt === 'BOOL' || dt === 'BIT' || bit !== null) {
        const words = await this._readWords(areaCode, word, 1);
        if (!words) return null;
        const b = bit !== null ? bit : (tag.bit || 0);
        return (words[0] >> b) & 1;
      }

      // ── STRING / ASCII — อ่าน N word แล้วถอดเป็นข้อความ (Omron: high byte = ตัวอักษรแรก) ──
      if (dt === 'STRING' || dt === 'ASCII') {
        const n = Math.max(1, Math.min(parseInt(tag.words) || 4, 120));
        const ws = await this._readWords(areaCode, word, n);
        if (!ws) return null;
        const buf = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) buf.writeUInt16BE(ws[i] & 0xFFFF, i * 2); // high,low = char0,char1
        return buf.toString('latin1').replace(/\0+$/, '').replace(/\s+$/, '');
      }

      // ── word / multi-word ──────────────────────────────────────────────────
      const count = this._wordCount(dt);
      const words = await this._readWords(areaCode, word, count);
      if (!words) return null;

      const buf = this._wordsToBuffer(words, tag.wordOrder);
      let val;
      switch (dt) {
        case 'INT16':   val = buf.readInt16BE(0); break;
        case 'UINT16':  val = buf.readUInt16BE(0); break;
        case 'INT32':   val = buf.readInt32BE(0); break;
        case 'UINT32':  val = buf.readUInt32BE(0); break;
        case 'FLOAT32':
        case 'REAL':    val = buf.readFloatBE(0); break;
        case 'INT64':   val = Number(buf.readBigInt64BE(0)); break;
        case 'UINT64':  val = Number(buf.readBigUInt64BE(0)); break;
        case 'FLOAT64':
        case 'DOUBLE':
        case 'LREAL':   val = buf.readDoubleBE(0); break;
        default:        val = buf.readUInt16BE(0);
      }
      if (tag.scale) val = val * tag.scale;
      if (typeof val === 'number' && !Number.isInteger(val)) val = Math.round(val * 1e6) / 1e6;
      return val;
    } catch (err) {
      return null;
    }
  }

  // รวม words → buffer big-endian ตาม wordOrder (default Omron = CDAB: low word ก่อน)
  _wordsToBuffer(words, wordOrder) {
    const order = (wordOrder || (words.length > 1 ? 'CDAB' : 'ABCD')).toUpperCase();
    const n = words.length;
    let arr = words.slice();
    if (order === 'CDAB' || order === 'DCBA') arr = arr.reverse(); // swap word order
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      let w = arr[i] & 0xFFFF;
      if (order === 'BADC' || order === 'DCBA') w = ((w & 0xFF) << 8) | (w >> 8); // swap bytes
      buf.writeUInt16BE(w, i * 2);
    }
    return buf;
  }

  async writeTag(tag, value) {
    if (!this.connected) throw new Error('Not connected');
    const areaCode = this._getAreaCode(tag.area || 'DM');
    const dt = (tag.dataType || 'INT16').toUpperCase();
    const { word, bit } = this._parseAddr(tag.address);

    // ── MULTI_BIT write: decimal → กระจาย bit ต่อเนื่อง N ตัว (read-modify-write ทั้งชุด word
    //    คงค่า bit อื่นในขอบ word · เช่นเดียวกับ BIT write เดิม = ไม่ atomic ระดับ PLC) ──
    if (dt === 'MULTI_BIT') {
      const n = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
      const b0 = bit !== null ? bit : (parseInt(tag.bit) || 0);
      const wordCount = ((b0 + n - 1) >> 4) + 1;
      const ws = (await this._readWords(areaCode, word, wordCount)) || new Array(wordCount).fill(0);
      const num = Math.max(0, Math.floor(Number(value) || 0));
      for (let i = 0; i < n; i++) {
        const g = b0 + i, wi = g >> 4, bi = g & 15;
        if (Math.floor(num / 2 ** i) % 2) ws[wi] |= (1 << bi);
        else ws[wi] &= ~(1 << bi);
      }
      const data = [areaCode, (word >> 8) & 0xFF, word & 0xFF, 0x00, (wordCount >> 8) & 0xFF, wordCount & 0xFF];
      for (const w of ws) data.push((w >> 8) & 0xFF, w & 0xFF);
      await this._sendFins(0x01, 0x02, data);
      return;
    }

    // ── BIT write — read-modify-write ──────────────────────────────────────
    if (dt === 'BOOL' || dt === 'BIT' || bit !== null) {
      const words = await this._readWords(areaCode, word, 1);
      const cur = words ? words[0] : 0;
      const b = bit !== null ? bit : (tag.bit || 0);
      const nv = value ? (cur | (1 << b)) : (cur & ~(1 << b));
      await this._sendFins(0x01, 0x02, [
        areaCode, (word >> 8) & 0xFF, word & 0xFF, 0x00, 0x00, 0x01,
        (nv >> 8) & 0xFF, nv & 0xFF,
      ]);
      return;
    }

    // ── STRING / ASCII write — เข้ารหัสข้อความเป็น N word (high byte = ตัวอักษรแรก) ──
    if (dt === 'STRING' || dt === 'ASCII') {
      const n = Math.max(1, Math.min(parseInt(tag.words) || 4, 120));
      const s = Buffer.from(String(value ?? ''), 'latin1');
      const data = [areaCode, (word >> 8) & 0xFF, word & 0xFF, 0x00, (n >> 8) & 0xFF, n & 0xFF];
      for (let i = 0; i < n; i++) { data.push(s[i * 2] || 0, s[i * 2 + 1] || 0); }  // hi,lo = char0,char1
      await this._sendFins(0x01, 0x02, data);
      return;
    }

    // ── 16-bit word ─────────────────────────────────────────────────────────
    const count = this._wordCount(dt);
    if (count === 1) {
      const rawVal = tag.scale ? Math.round(value / tag.scale) : Math.round(value);
      await this._sendFins(0x01, 0x02, [
        areaCode, (word >> 8) & 0xFF, word & 0xFF, 0x00, 0x00, 0x01,
        (rawVal >> 8) & 0xFF, rawVal & 0xFF,
      ]);
      return;
    }

    // ── 32/64-bit ───────────────────────────────────────────────────────────
    const raw = tag.scale ? value / tag.scale : value;
    const valBuf = Buffer.alloc(count * 2);
    switch (dt) {
      case 'INT32':   valBuf.writeInt32BE(Math.round(raw), 0); break;
      case 'UINT32':  valBuf.writeUInt32BE(Math.round(raw) >>> 0, 0); break;
      case 'FLOAT32':
      case 'REAL':    valBuf.writeFloatBE(raw, 0); break;
      case 'INT64':   valBuf.writeBigInt64BE(BigInt(Math.round(raw)), 0); break;
      case 'FLOAT64':
      case 'DOUBLE':  valBuf.writeDoubleBE(raw, 0); break;
    }
    // big-endian buffer → words (Omron low-word ก่อน = reverse)
    const order = (tag.wordOrder || 'CDAB').toUpperCase();
    let words = [];
    for (let i = 0; i < count; i++) words.push(valBuf.readUInt16BE(i * 2));
    if (order === 'CDAB' || order === 'DCBA') words = words.reverse();
    const data = [areaCode, (word >> 8) & 0xFF, word & 0xFF, 0x00, (count >> 8) & 0xFF, count & 0xFF];
    for (const w of words) { data.push((w >> 8) & 0xFF, w & 0xFF); }
    await this._sendFins(0x01, 0x02, data);
  }

  _getAreaCode(area) {
    const map = { DM: 0x82, WR: 0xB1, HR: 0xB2, AR: 0xB3, CIO: 0xB0, TIM: 0x89, CNT: 0x89 };
    return map[area.toUpperCase()] || 0x82;
  }

  _buildFinsCommand(mainCode, subCode, data) {
    const sid = (this.sid++ & 0xFF);
    const c = this.conn;
    // FINS/TCP: ใช้ node ที่ได้จาก handshake (SA1/DA1) แทนค่าที่ตั้งเอง
    const da1 = (this.transport === 'tcp' && this._tcpServerNode != null) ? this._tcpServerNode : (c.destinationNode || 0);
    const sa1 = (this.transport === 'tcp' && this._tcpClientNode != null) ? this._tcpClientNode : (c.localNode || 0);
    return Buffer.from([
      0x80,                        // ICF
      0x00,                        // RSV
      0x02,                        // GCT
      c.destinationNetwork || 0,   // DNA
      da1,                         // DA1
      c.destinationUnit || 0,      // DA2
      0x00,                        // SNA
      sa1,                         // SA1
      0x00,                        // SA2
      sid,                         // SID
      mainCode, subCode,
      ...data,
    ]);
  }

  _sendFins(mainCode, subCode, data) {
    const frame = this._buildFinsCommand(mainCode, subCode, data);
    return this.transport === 'tcp' ? this._sendFinsTcp(frame) : this._sendFinsUdp(frame);
  }

  // FINS/UDP — ส่ง datagram, รอ message ตอบกลับ
  _sendFinsUdp(frame) {
    return new Promise((resolve) => {
      const sock = this.socket;
      if (!sock) return resolve(null);
      const { host, port } = this.conn;
      const onMessage = (response) => {
        clearTimeout(t);
        sock.removeListener('message', onMessage);
        resolve(response.slice(14)); // ตัด 14-byte FINS response header + end code
      };
      sock.on('message', onMessage);
      const t = setTimeout(() => { sock.removeListener('message', onMessage); resolve(null); }, 3000);
      sock.send(frame, 0, frame.length, port, host, (err) => {
        if (err) { clearTimeout(t); sock.removeListener('message', onMessage); resolve(null); }
      });
    });
  }

  // FINS/TCP — ครอบ frame ด้วย FINS/TCP header (16 byte, command=2) แล้วอ่าน response เต็มเฟรม
  _sendFinsTcp(frame) {
    return new Promise((resolve) => {
      const sock = this.socket;
      if (!sock) return resolve(null);
      const header = Buffer.alloc(16);
      header.write('FINS', 0, 'ascii');
      header.writeUInt32BE(8 + frame.length, 4); // length = command(4)+error(4)+data
      header.writeUInt32BE(0x02, 8);             // command = FINS frame send
      header.writeUInt32BE(0x00, 12);            // error code
      const packet = Buffer.concat([header, frame]);

      let buf = Buffer.alloc(0);
      const onData = (data) => {
        buf = Buffer.concat([buf, data]);
        if (buf.length >= 8) {
          const total = 8 + buf.readUInt32BE(4);
          if (buf.length >= total) {
            clearTimeout(t);
            sock.removeListener('data', onData);
            const inner = buf.slice(16, total); // ตัด FINS/TCP header → FINS response frame
            resolve(inner.slice(14));           // ตัด 14-byte FINS response header + end code
          }
        }
      };
      sock.on('data', onData);
      const t = setTimeout(() => { sock.removeListener('data', onData); resolve(null); }, 3000);
      sock.write(packet, (err) => { if (err) { clearTimeout(t); sock.removeListener('data', onData); resolve(null); } });
    });
  }

  disconnect() {
    if (this.socket) {
      try { this.transport === 'tcp' ? this.socket.destroy() : this.socket.close(); } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
    this._tcpClientNode = null;
    this._tcpServerNode = null;
  }
}

module.exports = OmronFinsDriver;
