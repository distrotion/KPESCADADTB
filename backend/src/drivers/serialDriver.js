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
const vm = require('vm');
const { SerialPort }    = require('serialport');
const { ReadlineParser }          = require('@serialport/parser-readline');
const { InterByteTimeoutParser }  = require('@serialport/parser-inter-byte-timeout');

const _isNumStr = (s) => /^[\s+\-]?[\d.,eE+\-]+$/.test(String(s).trim());

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
    const code = this.device.connection.transform;
    if (!code) return;
    try {
      // wrap เป็น function body แล้ว compile ครั้งเดียว
      this._script = new vm.Script(
        `(function(msg, parseNum){ ${code}\n})`,
        { filename: `transform_${this.device.id}.js` }
      );
    } catch (err) {
      console.error(`[Serial] Transform compile error (${this.device.name}):`, err.message);
      this._script = null;
    }
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

      // ── Frame mode: แบ่งข้อความเข้าอย่างไร ───────────────────────────────
      //   delimiter (default) = ตัด ณ ตัวอักษรคั่น เช่น \n
      //   timeout / silence   = สะสม bytes แล้วตัดเมื่อเงียบ X ms (ไม่มี \n)
      const frameMode = (c.frameMode || 'delimiter').toLowerCase();
      let parser;
      if (frameMode === 'timeout' || frameMode === 'silence') {
        const interval = c.silenceMs || 50; // ms ที่ถือว่า "เงียบ" แล้วตัดข้อความ
        parser = new InterByteTimeoutParser({ interval, maxBufferSize: 65536 });
        console.log(`[Serial] Frame mode: silence/timeout (${interval}ms) — ${this.device.name}`);
      } else {
        let delimiter = c.delimiter || '\n';
        delimiter = delimiter.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        parser = new ReadlineParser({ delimiter });
      }
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
    const mode = (this.device.connection.parseMode || 'function').toLowerCase();

    try {
      // ── FUNCTION mode (Node-RED style) ──────────────────────────────────
      if (mode === 'function') {
        if (!this._script) return;
        // รัน transform ใน sandbox แยก context (กัน global รั่ว)
        const sandbox = {
          msg:      line,
          parseNum: (s) => { const n = parseFloat(s); return isNaN(n) ? null : n; },
          parseInt, parseFloat, Math, JSON, Number, String, isNaN,
          console: { log: (...a) => console.log(`[Serial:${this.device.id}]`, ...a) },
        };
        const fn = this._script.runInNewContext(sandbox, { timeout: 200 });
        const result = fn(line, sandbox.parseNum);
        if (result && typeof result === 'object') {
          for (const tag of this.device.tags) {
            const key = tag.jsonKey || tag.id;
            if (result[key] !== undefined) {
              let v = result[key];
              if (tag.scale && typeof v === 'number') v = v * tag.scale;
              this.onTagUpdate(this.device.id, tag.id, v);
            }
          }
        }
        return;
      }

      // ── REGEX mode ──────────────────────────────────────────────────────
      if (mode === 'regex') {
        for (const tag of this.device.tags) {
          if (!tag.regex) continue;
          let re; try { re = new RegExp(tag.regex); } catch (_) { continue; }
          const m = line.match(re); if (!m) continue;
          const g = (tag.regexGroup != null) ? tag.regexGroup : (m.length > 1 ? 1 : 0);
          let raw = m[g]; if (raw === undefined) continue;
          let v = raw;
          if (_isNumStr(raw)) { v = parseFloat(raw); if (tag.scale) v *= tag.scale; }
          this.onTagUpdate(this.device.id, tag.id, v);
        }
        return;
      }

      // ── CSV mode ────────────────────────────────────────────────────────
      if (mode === 'csv') {
        const sep = this.device.connection.csvSeparator || ',';
        const parts = line.split(sep);
        for (const tag of this.device.tags) {
          const idx = tag.csvIndex ?? -1;
          if (idx >= 0 && idx < parts.length) {
            let v = parseFloat(parts[idx]);
            if (!isNaN(v)) { if (tag.scale) v *= tag.scale; this.onTagUpdate(this.device.id, tag.id, v); }
          }
        }
        return;
      }

      // ── JSON / keyvalue ─────────────────────────────────────────────────
      let parsed = {};
      if (mode === 'json') {
        parsed = JSON.parse(line);
      } else if (mode === 'keyvalue') {
        const sep = this.device.connection.kvPairSep || ';';
        const kv  = this.device.connection.kvSep     || '=';
        for (const pair of line.split(sep)) {
          const i = pair.indexOf(kv);
          if (i > 0) parsed[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        }
      } else {
        // raw → ทั้งบรรทัดไป tag แรก
        if (this.device.tags.length > 0)
          this.onTagUpdate(this.device.id, this.device.tags[0].id, line);
        return;
      }
      for (const tag of this.device.tags) {
        const key = tag.jsonKey || tag.id;
        if (parsed[key] !== undefined) {
          let v = parsed[key];
          if (typeof v === 'string' && _isNumStr(v)) v = parseFloat(v);
          if (tag.scale && typeof v === 'number') v *= tag.scale;
          this.onTagUpdate(this.device.id, tag.id, v);
        }
      }
    } catch (err) {
      // ignore noise / transform runtime error (log สั้น ๆ)
      if (mode === 'function') {
        // throttle error log
        if (!this._lastErr || Date.now() - this._lastErr > 5000) {
          console.error(`[Serial] Transform error (${this.device.name}):`, err.message);
          this._lastErr = Date.now();
        }
      }
    }
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
