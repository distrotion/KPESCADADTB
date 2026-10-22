/**
 * Serial framing — module แชร์ระหว่าง serial_port + serial_bridge
 * ────────────────────────────────────────────────────────────────
 * makeParser(cfg) → stream parser ที่ตัดข้อความเข้าเป็น "frame":
 *   frameMode = 'delimiter' (default) : ตัด ณ อักษรจบ เช่น \n           (ReadlineParser)
 *             = 'timeout' | 'silence' : สะสม bytes → ตัดเมื่อเงียบ N ms  (InterByteTimeoutParser)
 *             = 'start'                : เริ่ม frame เมื่อเจอ startChar   (StartFrameParser — Node-RED style)
 *                                        จบเมื่อ (ก) endChar (ข) ครบ frameLen ไบต์ (ค) เจอ start ตัวถัดไป
 * รองรับ escape ในค่า config: \xHH \r \n \t
 */
const { Transform } = require('stream');
const { ReadlineParser }         = require('@serialport/parser-readline');
const { InterByteTimeoutParser } = require('@serialport/parser-inter-byte-timeout');

// แปลง escape ในสตริง config → ไบต์จริง ('\x02' → STX, '\r' '\n' '\t')
function unescape(s) {
  return String(s == null ? '' : s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * StartFrameParser — frame เริ่มที่ startChar (Node-RED "message starts with")
 *   priority การจบ: endChar > frameLen > start ตัวถัดไป
 *   includeDelims = ใส่ start/end ลงใน frame ที่ emit ด้วย (default false = payload ล้วน)
 */
class StartFrameParser extends Transform {
  constructor({ start, end, length, frameLen, includeDelims } = {}) {
    super();
    this.start = Buffer.from(unescape(start) || '\x02', 'binary');
    this.end   = end ? Buffer.from(unescape(end), 'binary') : null;
    const len = length != null ? length : frameLen;          // รับได้ทั้ง length + frameLen (คีย์ config)
    this.length = Number(len) > 0 ? Number(len) : 0;         // จำนวน "payload" ไบต์ (ไม่รวม delim)
    this.includeDelims = !!includeDelims;
    this.buf = Buffer.alloc(0);
    this.inFrame = false;
    this.frame = Buffer.alloc(0);
  }

  _payloadLen() { return this.frame.length - (this.includeDelims ? this.start.length : 0); }

  _emit() {
    this.push(this.frame);
    this.inFrame = false;
    this.frame = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let progress = true;
    while (progress) {
      progress = false;

      if (!this.inFrame) {
        const si = this.buf.indexOf(this.start);
        if (si < 0) {
          // ยังไม่เจอ start — เก็บแค่หางที่อาจเป็นครึ่ง start (กัน start คร่อม chunk)
          if (this.buf.length >= this.start.length) this.buf = this.buf.subarray(this.buf.length - this.start.length + 1);
          break;
        }
        this.inFrame = true;
        this.frame = this.includeDelims ? Buffer.from(this.start) : Buffer.alloc(0);
        this.buf = this.buf.subarray(si + this.start.length);
        progress = true;
      }

      if (this.inFrame) {
        if (this.end) {
          const ei = this.buf.indexOf(this.end);
          if (ei >= 0) {
            this.frame = Buffer.concat([this.frame, this.buf.subarray(0, ei), this.includeDelims ? this.end : Buffer.alloc(0)]);
            this.buf = this.buf.subarray(ei + this.end.length);
            this._emit(); progress = true;
          } else { this.frame = Buffer.concat([this.frame, this.buf]); this.buf = Buffer.alloc(0); }
        } else if (this.length > 0) {
          const need = this.length - this._payloadLen();
          if (this.buf.length >= need) {
            this.frame = Buffer.concat([this.frame, this.buf.subarray(0, need)]);
            this.buf = this.buf.subarray(need);
            this._emit(); progress = true;
          } else { this.frame = Buffer.concat([this.frame, this.buf]); this.buf = Buffer.alloc(0); }
        } else {
          // จบที่ start ตัวถัดไป
          const si = this.buf.indexOf(this.start);
          if (si >= 0) {
            this.frame = Buffer.concat([this.frame, this.buf.subarray(0, si)]);
            this.buf = this.buf.subarray(si);   // คง start ตัวใหม่ไว้ตั้ง frame ถัดไป
            this._emit(); progress = true;
          } else { this.frame = Buffer.concat([this.frame, this.buf]); this.buf = Buffer.alloc(0); }
        }
      }
    }
    cb();
  }
}

function _safeRe(s) { try { return s ? new RegExp(s) : null; } catch (_) { return null; } }

/**
 * RecordFrameParser — รวม "หลายบรรทัด" เป็น 1 record (สำหรับอุปกรณ์ที่ส่ง 1 ค่าต่อบรรทัด เช่นเครื่อง pH)
 *   แยกบรรทัดด้วย delimiter → จัดกลุ่มเป็น record ตามขอบเขต:
 *     recordEnd (regex)   : บรรทัดที่ match = จบ record (รวมบรรทัดนี้) → emit
 *     recordStart (regex) : บรรทัดที่ match = เริ่ม record ใหม่ → emit record ก่อนหน้า (ถ้ามี)
 *     recordMaxLines      : ครบ N บรรทัด → emit
 *     recordSilenceMs     : เงียบเกิน N ms → emit record ที่ค้าง
 *   emit = บรรทัดใน record ต่อด้วย '\n' (ข้ามบรรทัดว่าง)
 */
class RecordFrameParser extends Transform {
  constructor({ delimiter, recordStart, recordEnd, recordMaxLines, recordSilenceMs } = {}) {
    super();
    this.delim = Buffer.from(unescape(delimiter || '\n') || '\n', 'binary');
    this.reStart = _safeRe(recordStart);
    this.reEnd = _safeRe(recordEnd);
    this.maxLines = Number(recordMaxLines) > 0 ? Number(recordMaxLines) : 0;
    this.silenceMs = Number(recordSilenceMs) > 0 ? Number(recordSilenceMs) : 0;
    this.buf = Buffer.alloc(0);
    this.lines = [];
    this._timer = null;
  }
  _emit() { if (this.lines.length) { this.push(Buffer.from(this.lines.join('\n'))); this.lines = []; } }
  _arm() { if (!this.silenceMs) return; if (this._timer) clearTimeout(this._timer); this._timer = setTimeout(() => { this._timer = null; this._emit(); }, this.silenceMs); if (this._timer.unref) this._timer.unref(); }
  _line(line) {
    if (!line.trim()) return;                                        // ข้ามบรรทัดว่าง/whitespace
    if (this.reEnd && this.reEnd.test(line)) { this.lines.push(line); this._emit(); return; }
    if (this.reStart && this.reStart.test(line) && this.lines.length) this._emit();   // เริ่มใหม่ → flush เดิม
    this.lines.push(line);
    if (this.maxLines && this.lines.length >= this.maxLines) this._emit();
  }
  _transform(chunk, _enc, cb) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let i;
    while ((i = this.buf.indexOf(this.delim)) >= 0) {
      const line = this.buf.subarray(0, i).toString().replace(/\r$/, '');   // เก็บ \r ท้ายทิ้ง (เผื่อ delim=\n แต่มี \r\n)
      this.buf = this.buf.subarray(i + this.delim.length);
      this._line(line);
    }
    this._arm();
    cb();
  }
}

// สร้าง parser ตาม config (คืน stream ที่ .pipe() ได้ + emit 'data' ต่อ frame)
function makeParser(cfg) {
  cfg = cfg || {};
  const mode = String(cfg.frameMode || 'delimiter').toLowerCase();
  if (mode === 'timeout' || mode === 'silence') {
    return new InterByteTimeoutParser({ interval: Number(cfg.silenceMs) || 50, maxBufferSize: 65536 });
  }
  if (mode === 'start') {
    return new StartFrameParser({
      start: cfg.startChar || '\\x02',
      end: cfg.endChar || null,
      length: cfg.frameLen || 0,
      includeDelims: cfg.includeDelims,
    });
  }
  if (mode === 'record') {
    return new RecordFrameParser({
      delimiter: cfg.delimiter, recordStart: cfg.recordStart, recordEnd: cfg.recordEnd,
      recordMaxLines: cfg.recordMaxLines, recordSilenceMs: cfg.recordSilenceMs,
    });
  }
  return new ReadlineParser({ delimiter: unescape(cfg.delimiter || '\n') });
}

module.exports = { makeParser, StartFrameParser, RecordFrameParser, unescape };
