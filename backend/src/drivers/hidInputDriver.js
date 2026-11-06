/**
 * HID input driver — instruments that "type" their reading like a USB keyboard (Linux evdev)
 * ════════════════════════════════════════════════════════════════════════════
 * e.g. Mitutoyo USB-ITN: each press of DATA sends  <NumLock> 0.839 <Enter> <NumLock>
 * The driver reads /dev/input/eventN directly (no browser focus needed), turns key presses
 * into text and ends a frame on Enter — then the frame goes through the same parse modes as
 * serial_port (function | json | csv | keyvalue | regex | raw) and the 'serial' script trigger.
 *
 * connection:
 *   match     = text that appears in the input device name (cat /proc/bus/input/devices),
 *               e.g. "Mitutoyo USB-ITN" — found again after unplug/replug on any USB port
 *   path      = fixed /dev/input/eventN instead of match (optional)
 *   nth       = which one when several devices share the name (0 = first · default 0)
 *   pollMs    = how often the non-blocking fd is read (default 30)
 *   + the serial_port parse keys (parseMode, transform, regex, ...)
 *
 * The fd is opened non-blocking and read on a timer: a blocking read stream would hold one
 * libuv worker thread per instrument forever and starve sqlite/fs work.
 * Keys still also reach a focused window on the Pi (no exclusive grab — needs a native ioctl).
 */
const fs = require('fs');
const os = require('os');
const { compileTransform, parseFrame } = require('./serialParse');

const EV_KEY = 1;
const KEY_DOWN = 1;
const EVENT_SIZE = os.arch() === 'arm' || os.arch() === 'ia32' ? 16 : 24;   // struct input_event (32/64-bit timeval)
const ENTER = new Set([28, 96]);                                              // KEY_ENTER, KEY_KPENTER
const SHIFT = new Set([42, 54]);
const KEYS = {
  2: ['1', '!'], 3: ['2', '@'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'], 7: ['6', '^'], 8: ['7', '&'], 9: ['8', '*'],
  10: ['9', '('], 11: ['0', ')'], 12: ['-', '_'], 13: ['=', '+'], 51: [',', '<'], 52: ['.', '>'], 53: ['/', '?'],
  39: [';', ':'], 40: ["'", '"'], 57: [' ', ' '], 15: ['\t', '\t'],
  71: ['7'], 72: ['8'], 73: ['9'], 74: ['-'], 75: ['4'], 76: ['5'], 77: ['6'], 78: ['+'], 79: ['1'], 80: ['2'], 81: ['3'],
  82: ['0'], 83: ['.'], 55: ['*'], 98: ['/'],
};
'qwertyuiop'.split('').forEach((c, i) => { KEYS[16 + i] = [c, c.toUpperCase()]; });
'asdfghjkl'.split('').forEach((c, i) => { KEYS[30 + i] = [c, c.toUpperCase()]; });
'zxcvbnm'.split('').forEach((c, i) => { KEYS[44 + i] = [c, c.toUpperCase()]; });

// event node of the input device whose name contains `match` (nth match) — null when not plugged in
function findEventNode(match, nth = 0, devicesText = null) {
  let text = devicesText;
  if (text == null) { try { text = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch (_) { return null; } }
  const want = String(match || '').toLowerCase();
  const hits = [];
  for (const block of text.split(/\n\s*\n/)) {
    const name = (block.match(/^N: Name="(.*)"$/m) || [])[1] || '';
    const ev = (block.match(/^H: Handlers=.*\b(event\d+)\b/m) || [])[1];
    if (ev && want && name.toLowerCase().includes(want)) hits.push('/dev/input/' + ev);
  }
  return hits[nth] || null;
}

// keyboard-type input devices (for the device form) — [{ name, event, path }]
function listKeyboards(devicesText = null) {
  let text = devicesText;
  if (text == null) { try { text = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch (_) { return []; } }
  const out = [];
  for (const block of text.split(/\n\s*\n/)) {
    const name = (block.match(/^N: Name="(.*)"$/m) || [])[1] || '';
    const handlers = (block.match(/^H: Handlers=(.*)$/m) || [])[1] || '';
    const ev = (handlers.match(/\b(event\d+)\b/) || [])[1];
    if (ev && /\bkbd\b/.test(handlers)) out.push({ name, event: ev, path: '/dev/input/' + ev });
  }
  return out;
}

// key events → text: frames end on Enter · returns [completed frames] and keeps the partial line in state
function decodeEvents(buf, state) {
  const frames = [];
  for (let i = 0; i + EVENT_SIZE <= buf.length; i += EVENT_SIZE) {
    const type = buf.readUInt16LE(i + EVENT_SIZE - 8);
    const code = buf.readUInt16LE(i + EVENT_SIZE - 6);
    const value = buf.readInt32LE(i + EVENT_SIZE - 4);
    if (type !== EV_KEY) continue;
    if (SHIFT.has(code)) { state.shift = value !== 0; continue; }
    if (value !== KEY_DOWN) continue;
    if (ENTER.has(code)) { frames.push(state.line); state.line = ''; continue; }
    const k = KEYS[code];
    if (k) state.line += (state.shift && k[1] !== undefined) ? k[1] : k[0];
  }
  return frames;
}

class HidInputDriver {
  constructor(device, onTagUpdate, onRaw) {
    this.device = device;
    this.onTagUpdate = onTagUpdate;
    this.onRaw = onRaw || null;            // (deviceId, line) → script trigger 'serial'
    this.connected = false;
    this.fd = null;
    this.path = null;
    this._timer = null;
    this._retry = null;
    this._want = false;
    this._state = { line: '', shift: false };
    this._buf = Buffer.alloc(EVENT_SIZE * 64);
    this._script = compileTransform((device.connection || {}).transform, device.id);
  }

  _resolvePath() {
    const c = this.device.connection || {};
    if (c.path) return fs.existsSync(c.path) ? c.path : null;
    return findEventNode(c.match, Number(c.nth) || 0);
  }

  async connect() {
    this._want = true;
    this._close();
    const p = this._resolvePath();
    if (!p) { this._scheduleRetry(); return false; }
    try {
      this.fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (e) {
      console.error(`[HID] open ${p} (${this.device.name}):`, e.message);
      this._scheduleRetry();
      return false;
    }
    this.path = p;
    this.connected = true;
    this._state = { line: '', shift: false };
    const ms = Math.max(10, Number((this.device.connection || {}).pollMs) || 30);
    this._timer = setInterval(() => this._drain(), ms);
    console.log(`[HID] Connected: ${this.device.name} @ ${p}`);
    return true;
  }

  _drain() {
    if (this.fd === null) return;
    for (;;) {
      let n;
      try { n = fs.readSync(this.fd, this._buf, 0, this._buf.length, null); }
      catch (e) {
        if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') return;   // nothing typed
        console.error(`[HID] ${this.device.name} lost (${e.code || e.message}) — waiting for it to come back`);
        this._close(); this._scheduleRetry(); return;                  // unplugged (ENODEV) etc.
      }
      if (!n) return;
      for (const line of decodeEvents(this._buf.subarray(0, n), this._state)) this._frame(line.trim());
    }
  }

  _frame(line) {
    if (!line) return;
    if (this.onRaw) { try { this.onRaw(this.device.id, line); } catch (_) {} }
    parseFrame({
      line, cfg: this.device.connection || {}, tags: this.device.tags, script: this._script,
      onTag: this.onTagUpdate, deviceId: this.device.id, logId: this.device.name || this.device.id,
    });
  }

  _scheduleRetry() {
    if (!this._want || this._retry) return;
    this._retry = setTimeout(() => { this._retry = null; if (this._want && !this.connected) this.connect().catch(() => {}); },
      Number((this.device.connection || {}).reconnectMs) || 3000);
  }

  _close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (_) {} this.fd = null; }
    this.connected = false;
  }

  async writeTag() { throw new Error('HID input is read-only'); }

  disconnect() {
    this._want = false;
    if (this._retry) { clearTimeout(this._retry); this._retry = null; }
    this._close();
  }
}

module.exports = HidInputDriver;
module.exports.findEventNode = findEventNode;
module.exports.listKeyboards = listKeyboards;
module.exports.decodeEvents = decodeEvents;
module.exports.EVENT_SIZE = EVENT_SIZE;
