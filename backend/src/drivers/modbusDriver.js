const ModbusRTU = require('modbus-serial');
const codec     = require('./modbusCodec');   // §11.7 encode/decode กลาง (ใช้ร่วม KPENETWORK)
const { decodeMultiBit } = require('./bitDecode');

/**
 * Modbus Driver — รองรับ 16 / 32 / 64-bit
 *
 * dataType ที่รองรับ:
 *   16-bit (1 register):  INT16, UINT16, BOOL
 *   32-bit (2 registers): INT32, UINT32, FLOAT32 (REAL)
 *   64-bit (4 registers): INT64, UINT64, FLOAT64 (DOUBLE / LREAL)
 *
 * wordOrder (สำหรับ 32/64-bit) — ลำดับ word/byte:
 *   'ABCD' (big-endian, default)       เช่น Schneider, ส่วนใหญ่
 *   'CDAB' (word-swapped little)       เช่น Modicon บางรุ่น, Wago
 *   'BADC' (byte-swapped big)
 *   'DCBA' (little-endian)
 *
 * encode/decode ย้ายไป modbusCodec.js (§11.7) — driver เหลือแค่ I/O + scale/round/BIT/coil
 */

class ModbusDriver {
  constructor(device) {
    this.device = device;
    this.client = new ModbusRTU();
    this.connected = false;
    this.type = device.type;
  }

  async connect() {
    try {
      // สร้าง client ใหม่ทุกครั้ง — เลี่ยง socket ค้างจากการเชื่อมต่อครั้งก่อน
      try { if (this.client) this.client.close(() => {}); } catch (_) {}
      this.client = new ModbusRTU();

      const { connection } = this.device;
      const doConnect = this.type === 'modbus_tcp'
        ? this.client.connectTCP(connection.host, { port: connection.port })
        : this.client.connectRTUBuffered(connection.port, {
            baudRate: connection.baudRate,
            dataBits: connection.dataBits,
            stopBits: connection.stopBits,
            parity: connection.parity,
          });
      // connect timeout — กันค้างนานเมื่อ host ปิดเครื่อง/unreachable (ไม่มี RST)
      await Promise.race([
        doConnect,
        new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 4000)),
      ]);
      this.client.setID(this.device.connection.unitId || 1);
      this.client.setTimeout(2000);
      this.connected = true;

      // ตรวจหลุดทันทีผ่าน socket events (เหมือน MC) — ไม่ต้องรอ read timeout
      const sock = this.client._port && this.client._port._client;
      if (sock && typeof sock.on === 'function') {
        sock.setKeepAlive(true, 3000); // ให้ OS probe หา peer ที่ตายแบบ abrupt เร็วขึ้น
        sock.on('close', () => { this.connected = false; });
        sock.on('error', () => { this.connected = false; });
      }
      console.log(`[Modbus] Connected: ${this.device.name}`);
    } catch (err) {
      this.connected = false;
      // ปิด client ที่ค้าง (เช่น connect timeout) เพื่อไม่ให้ socket รั่ว
      try { this.client.close(() => {}); } catch (_) {}
      console.error(`[Modbus] Connect error (${this.device.name}):`, err.message);
    }
  }

  _wordCount(dataType) {
    return codec.wordCount(dataType);
  }

  async readTag(tag) {
    if (!this.connected) return null;
    try {
      const dt    = (tag.dataType || 'INT16').toUpperCase();
      const count = this._wordCount(dt);
      let result;

      switch (tag.fc) {
        case 1: // Coils
          if (dt === 'MULTI_BIT') {
            // อ่าน coil ต่อเนื่อง N ตัวครั้งเดียว → decimal (coil แรก = LSB)
            const n1 = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
            result = await this.client.readCoils(tag.address, n1);
            return this._bitsToDec(result.data, n1, tag.bitMode);
          }
          result = await this.client.readCoils(tag.address, 1);
          return result.data[0] ? 1 : 0;
        case 2: // Discrete Inputs
          if (dt === 'MULTI_BIT') {
            const n2 = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
            result = await this.client.readDiscreteInputs(tag.address, n2);
            return this._bitsToDec(result.data, n2, tag.bitMode);
          }
          result = await this.client.readDiscreteInputs(tag.address, 1);
          return result.data[0] ? 1 : 0;
        case 3: // Holding Registers
          result = await this.client.readHoldingRegisters(tag.address, count);
          if (dt === 'BIT') return (result.data[0] >> (tag.bit || 0)) & 1;
          return this._parse(result.data, dt, tag);
        case 4: // Input Registers
          result = await this.client.readInputRegisters(tag.address, count);
          if (dt === 'BIT') return (result.data[0] >> (tag.bit || 0)) & 1;
          return this._parse(result.data, dt, tag);
        default:
          return null;
      }
    } catch (err) {
      this.connected = false;
      return null;
    }
  }

  // ── แปลง register words → ค่าตาม dataType + wordOrder (decode ผ่าน codec) ──
  _parse(words, dataType, tag) {
    const dt = (dataType || 'INT16').toUpperCase();
    let val = codec.decodeWords(words, dt, tag.wordOrder || 'ABCD');
    if (dt === 'BOOL') return val;                 // BOOL: ไม่ scale/round (เหมือนเดิม)

    if (typeof val === 'number') {
      if (tag.scale) val = val * tag.scale;
      // ปัด float ยาว ๆ ให้สั้นลง
      if (!Number.isInteger(val)) val = Math.round(val * 1e6) / 1e6;
    }
    return val;
  }

  // แปลงอาเรย์ bool จาก readCoils/readDiscreteInputs → ค่า ตาม bitMode (decimal/sequence)
  _bitsToDec(arr, n, mode) {
    const bits = [];
    for (let i = 0; i < n; i++) bits.push(arr[i] ? 1 : 0);
    return decodeMultiBit(bits, mode);
  }

  // ── เขียนค่า (16/32/64-bit) ────────────────────────────────────────────────
  async writeTag(tag, value) {
    if (!this.connected) throw new Error('Not connected');
    const dt = (tag.dataType || 'INT16').toUpperCase();

    // ── MULTI_BIT write (coils FC15): decimal → coil ต่อเนื่อง N ตัว เขียนครั้งเดียว ──
    if (dt === 'MULTI_BIT') {
      const n = Math.max(1, Math.min(parseInt(tag.bits) || 16, 32));
      const num = Math.max(0, Math.floor(Number(value) || 0));
      const bools = [];
      for (let i = 0; i < n; i++) bools.push(Math.floor(num / 2 ** i) % 2 === 1);
      await this.client.writeCoils(tag.address, bools);
      return;
    }

    if (tag.fc === 1 || dt === 'BOOL') {
      await this.client.writeCoil(tag.address, value ? true : false);
      return;
    }

    // BIT-in-register — read-modify-write
    if (dt === 'BIT') {
      const r = await this.client.readHoldingRegisters(tag.address, 1);
      const cur = r.data[0];
      const b = tag.bit || 0;
      const nv = value ? (cur | (1 << b)) : (cur & ~(1 << b));
      await this.client.writeRegister(tag.address, nv & 0xFFFF);
      return;
    }

    const count = this._wordCount(dt);
    const raw = tag.scale ? value / tag.scale : value;
    const words = codec.encodeValue(raw, dt, tag.wordOrder || 'ABCD');

    if (count === 1) {
      await this.client.writeRegister(tag.address, words[0]);
      return;
    }
    await this.client.writeRegisters(tag.address, words);
  }

  disconnect() {
    try { this.client.close(() => {}); } catch (_) {}
    this.connected = false;
  }
}

module.exports = ModbusDriver;
