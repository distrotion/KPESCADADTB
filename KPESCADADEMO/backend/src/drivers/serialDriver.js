/**
 * Raw Serial Port Driver — Node-RED style "function" transform
 * ════════════════════════════════════════════════════════════════════════════
 * รับข้อมูล string ดิบจาก serial แล้วให้ผู้ใช้เขียน JavaScript แปลงเป็นตัวแปรเอง
 *
 * parseMode รองรับ:  function | json | csv | keyvalue | regex | raw
 *
 * ── FUNCTION mode (เหมือน Node-RED function node) ───────────────────────────
 *   ใน devices.json → connection.transform = โค้ด JS (string)
 *   ตัวแปรที่ใช้ได้:
 *     msg      = ข้อมูล 1 บรรทัด (string)  เช่น "T=25.5,H=60,RUN=1"
 *     parseNum = helper แปลง string → number
 *   ต้อง return object {tagId: value}  เช่น { temp:25.5, humid:60, run:1 }
 *
 *   ตัวอย่าง transform:
 *     "const p = msg.split(',');
 *      return {
 *        temp:  parseFloat(p[0].split('=')[1]),
 *        humid: parseFloat(p[1].split('=')[1]),
 *        run:   p[2].split('=')[1] === '1' ? 1 : 0
 *      };"
 *
 *   อีกตัวอย่าง (printer/ตาชั่ง): msg = "WEIGHT: 25.5 kg STABLE"
 *     "const m = msg.match(/([\\d.]+)\\s*kg/);
 *      return { weight: m ? parseFloat(m[1]) : null,
 *               stable: msg.includes('STABLE') ? 1 : 0 };"
 *
 *   ค่าที่ return จะถูก map เข้า tag ที่ id ตรงกัน (หรือ tag.jsonKey)
 * ════════════════════════════════════════════════════════════════════════════
 */
const { SerialPort } = require('serialport');
const framing = require('./serialFraming');                          // framing แชร์ (delimiter/timeout/start)
const { compileTransform, parseFrame } = require('./serialParse');   // parse 6 โหมด แชร์

class SerialDriver {
  constructor(device, onTagUpdate, onRaw) {
    this.device      = device;
    this.onTagUpdate = onTagUpdate;
    this.onRaw       = onRaw || null;   // (deviceId, rawLine) → สำหรับ script trigger 'serial'
    this.port        = null;
    this.connected   = false;
    this._wantConnected = false;          // ตั้งใจให้เชื่อมต่อ → ใช้ตัดสินใจ auto-reconnect (USB หลุด→กลับมา)
    this._reconnectTimer = null;
    this._reconnectMs = (device.connection && device.connection.reconnectMs) || 3000;
    this._lastLine   = '';
    this._script     = null;   // compiled vm.Script สำหรับ function mode
    this._compileTransform();
  }

  _compileTransform() {
    this._script = compileTransform(this.device.connection.transform, this.device.id);
  }

  async connect() {
    const c = this.device.connection;
    this._wantConnected = true;
    // ล้าง port เก่า (กัน listener/handle รั่วตอน reconnect ซ้ำ)
    if (this.port) { try { this.port.removeAllListeners(); if (this.port.isOpen) this.port.close(); } catch (_) {} this.port = null; }
    try {
      this.port = new SerialPort({
        path:     c.port,
        baudRate: c.baudRate || 9600,
        dataBits: c.dataBits || 8,
        stopBits: c.stopBits || 1,
        parity:   c.parity   || 'none',
        autoOpen: false,
      });

      // ── Frame mode: แบ่งข้อความเข้าอย่างไร (delimiter/timeout/start) — ผ่าน module แชร์ ──
      const parser = framing.makeParser(c);
      this.port.pipe(parser);

      this.port.on('open',  () => { this.connected = true;  this._clearReconnect(); console.log(`[Serial] Connected: ${this.device.name} @ ${c.port}`); });
      this.port.on('error', (e) => { this.connected = false; console.error(`[Serial] Error (${this.device.name}):`, e.message); this._scheduleReconnect(); });
      this.port.on('close', () => { this.connected = false; console.log(`[Serial] Disconnected: ${this.device.name}`); this._scheduleReconnect(); });

      parser.on('data', (line) => this._parse(line.toString().trim()));

      await new Promise((resolve, reject) =>
        this.port.open((err) => err ? reject(err) : resolve()));
      return true;
    } catch (err) {
      this.connected = false;
      console.error(`[Serial] Connect failed (${this.device.name}):`, err.message);
      this._scheduleReconnect();   // เปิดไม่ติด (เช่น USB ยังไม่เสียบ) → ลองใหม่เรื่อย ๆ
      return false;
    }
  }

  // auto-reconnect: USB-serial หลุดแล้วกลับมา → reopen เอง (push-based ไม่มี poll loop ช่วย)
  _scheduleReconnect() {
    if (!this._wantConnected || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wantConnected && !this.connected) {
        console.log(`[Serial] Reconnecting: ${this.device.name} @ ${this.device.connection.port} ...`);
        this.connect().catch(() => {});
      }
    }, this._reconnectMs);
  }
  _clearReconnect() { if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; } }

  _parse(line) {
    if (!line) return;
    this._lastLine = line;
    // ส่ง raw line ให้ script trigger 'serial' (ก่อน parse — รับดิบ ๆ)
    if (this.onRaw) { try { this.onRaw(this.device.id, line); } catch (_) {} }
    parseFrame({
      line, cfg: this.device.connection, tags: this.device.tags, script: this._script,
      onTag: this.onTagUpdate, deviceId: this.device.id, logId: this.device.name || this.device.id,
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.port) return reject(new Error('Not connected'));
      this.port.write(data + '\n', (err) => err ? reject(err) : resolve());
    });
  }

  async writeTag(tag, value) {
    const cmd = tag.writeCmd ? tag.writeCmd.replace('{value}', value) : `${tag.id}=${value}`;
    await this.write(cmd);
  }

  disconnect() {
    this._wantConnected = false;       // ตั้งใจหยุด → close handler จะไม่ schedule reconnect
    this._clearReconnect();
    if (this.port) { try { this.port.removeAllListeners(); if (this.port.isOpen) this.port.close(); } catch (_) {} }
    this.connected = false;
  }
}

module.exports = SerialDriver;
