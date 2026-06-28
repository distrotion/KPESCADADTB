/**
 * Raw Serial Port Driver
 * รองรับ parse mode: json | csv | key=value
 * ใช้สำหรับ Arduino, ESP32, custom controllers ที่ส่งข้อมูลทาง serial
 *
 * Example outputs:
 *   JSON:      {"temp":25.5,"pressure":1.2,"motor":1}
 *   CSV:       25.5,1.2,1
 *   key=value: temp=25.5;pressure=1.2;motor=1
 */
const { SerialPort }    = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

class SerialDriver {
  constructor(device, onTagUpdate) {
    this.device      = device;
    this.onTagUpdate = onTagUpdate; // (deviceId, tagId, value) => void
    this.port        = null;
    this.connected   = false;
  }

  async connect() {
    const c = this.device.connection;
    try {
      this.port = new SerialPort({
        path:     c.port,
        baudRate: c.baudRate  || 9600,
        dataBits: c.dataBits  || 8,
        stopBits: c.stopBits  || 1,
        parity:   c.parity    || 'none',
        autoOpen: false,
      });

      const delimiter = c.delimiter || '\n';
      const parser    = new ReadlineParser({ delimiter });
      this.port.pipe(parser);

      this.port.on('open',  () => {
        this.connected = true;
        console.log(`[Serial] Connected: ${this.device.name} @ ${c.port}`);
      });
      this.port.on('error', (err) => {
        this.connected = false;
        console.error(`[Serial] Error (${this.device.name}):`, err.message);
      });
      this.port.on('close', () => {
        this.connected = false;
        console.log(`[Serial] Disconnected: ${this.device.name}`);
      });

      parser.on('data', (line) => {
        this._parse(line.trim());
      });

      await new Promise((resolve, reject) => {
        this.port.open((err) => err ? reject(err) : resolve());
      });

      return true;
    } catch (err) {
      this.connected = false;
      console.error(`[Serial] Connect failed (${this.device.name}):`, err.message);
      return false;
    }
  }

  _parse(line) {
    if (!line) return;
    const mode = (this.device.connection.parseMode || 'json').toLowerCase();

    try {
      let parsed = {};

      if (mode === 'json') {
        // {"temp":25.5,"pressure":1.2}
        parsed = JSON.parse(line);

      } else if (mode === 'csv') {
        // 25.5,1.2,1   (columns map to tags by csvIndex)
        const sep   = this.device.connection.csvSeparator || ',';
        const parts = line.split(sep);
        for (const tag of this.device.tags) {
          const idx = tag.csvIndex ?? -1;
          if (idx >= 0 && idx < parts.length) {
            const v = parseFloat(parts[idx]);
            if (!isNaN(v)) {
              this.onTagUpdate(this.device.id, tag.id, v);
            }
          }
        }
        return; // handled above

      } else if (mode === 'keyvalue') {
        // temp=25.5;pressure=1.2  (separator=';', kvSep='=')
        const sep   = this.device.connection.kvPairSep || ';';
        const kvSep = this.device.connection.kvSep     || '=';
        for (const pair of line.split(sep)) {
          const [k, v] = pair.split(kvSep);
          if (k && v !== undefined) parsed[k.trim()] = v.trim();
        }

      } else {
        // raw — ส่งทั้ง line ไปยัง tag แรก
        if (this.device.tags.length > 0) {
          this.onTagUpdate(this.device.id, this.device.tags[0].id, line);
        }
        return;
      }

      // Map parsed keys → tags
      for (const tag of this.device.tags) {
        const key = tag.jsonKey || tag.id;
        if (parsed[key] !== undefined) {
          let val = parsed[key];
          if (typeof val === 'string') val = isNaN(parseFloat(val)) ? val : parseFloat(val);
          if (tag.scale && typeof val === 'number') val = val * tag.scale;
          this.onTagUpdate(this.device.id, tag.id, val);
        }
      }
    } catch (err) {
      // silently ignore parse errors
    }
  }

  // Write raw string to serial port
  write(data) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.port) return reject(new Error('Not connected'));
      this.port.write(data + '\n', (err) => err ? reject(err) : resolve());
    });
  }

  // writeTag: write value as command string
  async writeTag(tag, value) {
    const cmd = tag.writeCmd
      ? tag.writeCmd.replace('{value}', value)
      : `${tag.id}=${value}`;
    await this.write(cmd);
  }

  disconnect() {
    if (this.port && this.port.isOpen) {
      try { this.port.close(); } catch (_) {}
    }
    this.connected = false;
  }
}

module.exports = SerialDriver;
