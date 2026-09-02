#!/usr/bin/env node
/**
 * KPE SCADA — Virtual PLC (MELSEC MC Protocol 3E binary, TCP + UDP)
 *
 *   PLC จำลองที่มี memory จริงระดับล้าน register — สำหรับทดสอบ PLCMEM (sweep D/ZR, diff write, backup)
 *   โดยไม่ต้องมี PLC จริงและไม่ต้องเสี่ยงกับไลน์ผลิต
 *
 *   รองรับ: 0x0401 read (word/bit) · 0x1401 write (word/bit) · D, ZR, W, R, M, B
 *   จำลองพฤติกรรมจริงของ PLC ที่สำคัญต่อการทดสอบ:
 *     - จำกัดจำนวน point ต่อคำสั่ง (default 960 ตาม spec 3E) → เกิน = end code 0xC056 เหมือน PLC จริง
 *     - address เกินขอบเขต area → end code 0xC051 (device range error)
 *     - write-protect ต่อ area (จำลอง PLC ที่ปิด write ตอน RUN)
 *     - latency ต่อคำสั่ง + jitter
 *     - รับได้หลาย connection พร้อมกัน หรือจำกัด 1 (PLC บางรุ่นรับทีละ connection เดียว)
 *
 *   ใช้:
 *     node tools/plc-virtual.js                          # :6000 · D 1.5M + ZR 0.5M = 2M word
 *     node tools/plc-virtual.js --port 6001 --d 2000000 --zr 500000
 *     node tools/plc-virtual.js --latency 2 --max-points 960 --max-conn 1
 *     node tools/plc-virtual.js --seed dense             # เติมค่าให้เยอะ (ทดสอบ backup ขนาดใหญ่)
 *     node tools/plc-virtual.js --udp                    # เปิด UDP ด้วย (พอร์ตเดียวกัน)
 *
 *   ตัวเลือก seed: sparse (default · เหมือนของจริง ส่วนใหญ่เป็น 0) · dense · zero
 */
'use strict';
const net = require('net');
const dgram = require('dgram');

// ── device code (3E binary) → ชื่อ area · ต้องตรงกับ mcProtocolDriver._getDeviceCodeByte ──
const CODE_TO_AREA = {
  0xA8: 'D', 0xB0: 'ZR', 0xB4: 'W', 0xAF: 'R', 0xA9: 'SD', 0xB5: 'SW',
  0x90: 'M', 0xA0: 'B', 0x9C: 'X', 0x9D: 'Y',
};
const BIT_AREAS = new Set(['M', 'B', 'X', 'Y']);

// end code ที่ PLC จริงตอบ (ใช้ค่าเดียวกับ MELSEC)
const EC_OK          = 0x0000;
const EC_DEVICE_RANGE = 0xC051;  // address/count เกินขอบเขต device
const EC_POINT_OVER   = 0xC056;  // จำนวน point ต่อคำสั่งเกินที่รองรับ
const EC_WRITE_PROTECT= 0xC050;  // เขียนไม่ได้ (write protect / RUN)
const EC_BAD_DEVICE   = 0xC059;  // device code ไม่รองรับ

function parseArgs(argv) {
  const o = {
    port: 6000, host: '0.0.0.0', udp: false,
    d: 1500000, zr: 500000, w: 8192, r: 32768, m: 8192, b: 8192,
    latency: 0, jitter: 0, maxPoints: 960, maxConn: 0, seed: 'sparse',
    writeProtect: '', quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port':        o.port = parseInt(next(), 10); break;
      case '--host':        o.host = next(); break;
      case '--udp':         o.udp = true; break;
      case '--d':           o.d = parseInt(next(), 10); break;
      case '--zr':          o.zr = parseInt(next(), 10); break;
      case '--w':           o.w = parseInt(next(), 10); break;
      case '--r':           o.r = parseInt(next(), 10); break;
      case '--latency':     o.latency = parseFloat(next()); break;
      case '--jitter':      o.jitter = parseFloat(next()); break;
      case '--max-points':  o.maxPoints = parseInt(next(), 10); break;
      case '--max-conn':    o.maxConn = parseInt(next(), 10); break;
      case '--seed':        o.seed = next(); break;
      case '--write-protect': o.writeProtect = next(); break;   // เช่น "ZR" หรือ "D,ZR"
      case '--quiet':       o.quiet = true; break;
      case '-h': case '--help':
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
        process.exit(0);
      default:
        if (a.startsWith('--')) { console.error(`ไม่รู้จัก option: ${a}`); process.exit(1); }
    }
  }
  return o;
}

class VirtualPlc {
  constructor(opts) {
    this.opts = opts;
    // memory จริง — Uint16Array กิน 2 byte/word (D 1.5M + ZR 0.5M = 4MB เท่านั้น)
    this.mem = {
      D:  new Uint16Array(opts.d),
      ZR: new Uint16Array(opts.zr),
      W:  new Uint16Array(opts.w),
      R:  new Uint16Array(opts.r),
      M:  new Uint8Array(opts.m),     // bit area — 1 byte/bit (เปลืองแต่ง่ายและยังเล็ก)
      B:  new Uint8Array(opts.b),
    };
    this.protectedAreas = new Set(
      String(opts.writeProtect || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
    this.stats = { reads: 0, writes: 0, errors: 0, wordsRead: 0, wordsWritten: 0, conns: 0 };
    this._seed(opts.seed);
  }

  // เติมค่าตั้งต้นให้เหมือนของจริง: pattern data กระจุกเป็นบล็อก ส่วนใหญ่เป็น 0
  _seed(mode) {
    if (mode === 'zero') return;
    const dense = mode === 'dense';
    const fillBlocks = (arr, blockEvery, blockLen, base) => {
      for (let start = 0; start + blockLen < arr.length; start += blockEvery) {
        for (let i = 0; i < blockLen; i++) arr[start + i] = (base + start + i * 7) & 0xFFFF;
      }
    };
    // D: บล็อกสูตรทุก ๆ 1000 word (dense = ทุก 100)
    fillBlocks(this.mem.D, dense ? 100 : 1000, dense ? 40 : 20, 0x1000);
    // ZR: บล็อกทุก ๆ 500 word
    fillBlocks(this.mem.ZR, dense ? 50 : 500, dense ? 30 : 16, 0x2000);
    // ค่าที่รู้ตำแหน่งแน่นอน — ให้เทสยืนยันได้ง่าย
    if (this.mem.D.length > 100) { this.mem.D[0] = 1234; this.mem.D[1] = 5678; this.mem.D[100] = 4321; }
    if (this.mem.ZR.length > 100) { this.mem.ZR[0] = 1111; this.mem.ZR[100] = 2222; }
  }

  nonZeroCount(area) {
    const a = this.mem[area]; if (!a) return 0;
    let n = 0; for (let i = 0; i < a.length; i++) if (a[i]) n++;
    return n;
  }

  // ── ประมวลผล 1 request → { endCode, data } ──
  handle(req) {
    if (req.length < 21) return { endCode: EC_DEVICE_RANGE, data: Buffer.alloc(0) };
    const cmd    = req.readUInt16LE(11);
    const subCmd = req.readUInt16LE(13);
    const addr   = req.readUIntLE(15, 3);      // 3 byte LE — ตรงกับที่ driver ส่ง
    const code   = req[18];
    const count  = req.readUInt16LE(19);
    const isBit  = subCmd === 0x0001;

    const area = CODE_TO_AREA[code];
    if (!area || !this.mem[area]) { this.stats.errors++; return { endCode: EC_BAD_DEVICE, data: Buffer.alloc(0) }; }
    if (isBit !== BIT_AREAS.has(area)) {
      // อ่าน bit area ด้วย word subcommand (หรือกลับกัน) — PLC จริงตอบ error
      this.stats.errors++; return { endCode: EC_BAD_DEVICE, data: Buffer.alloc(0) };
    }
    if (count < 1 || count > this.opts.maxPoints) { this.stats.errors++; return { endCode: EC_POINT_OVER, data: Buffer.alloc(0) }; }

    const arr = this.mem[area];
    if (addr < 0 || addr + count > arr.length) { this.stats.errors++; return { endCode: EC_DEVICE_RANGE, data: Buffer.alloc(0) }; }

    if (cmd === 0x0401) return this._read(area, arr, addr, count, isBit);
    if (cmd === 0x1401) return this._write(area, arr, addr, count, isBit, req.slice(21));
    this.stats.errors++;
    return { endCode: EC_BAD_DEVICE, data: Buffer.alloc(0) };
  }

  _read(area, arr, addr, count, isBit) {
    this.stats.reads++;
    if (isBit) {
      // 3E binary bit-read: nibble-packed — bit คู่อยู่ครึ่งสูง, คี่อยู่ครึ่งต่ำ (ตรงกับ driver readTag)
      const data = Buffer.alloc(Math.ceil(count / 2));
      for (let i = 0; i < count; i++) {
        const v = arr[addr + i] ? 1 : 0;
        if (i % 2 === 0) data[i >> 1] |= v << 4; else data[i >> 1] |= v;
      }
      this.stats.wordsRead += count;
      return { endCode: EC_OK, data };
    }
    const data = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) data.writeUInt16LE(arr[addr + i], i * 2);
    this.stats.wordsRead += count;
    return { endCode: EC_OK, data };
  }

  _write(area, arr, addr, count, isBit, payload) {
    if (this.protectedAreas.has(area)) { this.stats.errors++; return { endCode: EC_WRITE_PROTECT, data: Buffer.alloc(0) }; }
    if (isBit) {
      const need = Math.ceil(count / 2);
      if (payload.length < need) { this.stats.errors++; return { endCode: EC_DEVICE_RANGE, data: Buffer.alloc(0) }; }
      for (let i = 0; i < count; i++) {
        arr[addr + i] = (i % 2 === 0) ? ((payload[i >> 1] >> 4) & 1) : (payload[i >> 1] & 1);
      }
    } else {
      if (payload.length < count * 2) { this.stats.errors++; return { endCode: EC_DEVICE_RANGE, data: Buffer.alloc(0) }; }
      for (let i = 0; i < count; i++) arr[addr + i] = payload.readUInt16LE(i * 2);
      this.stats.wordsWritten += count;
    }
    this.stats.writes++;
    return { endCode: EC_OK, data: Buffer.alloc(0) };
  }
}

// ── frame helpers ──
// response 3E: subheader D0 00 + 5 byte route + dataLen(LE) + endCode(LE) + data
function buildResponse(endCode, data) {
  const head = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00]);
  const len = Buffer.alloc(2); len.writeUInt16LE(2 + data.length, 0);
  const ec = Buffer.alloc(2); ec.writeUInt16LE(endCode, 0);
  return Buffer.concat([head, len, ec, data]);
}

// แยกเฟรม request ออกจาก stream (รองรับ fragment/หลายเฟรมติดกัน)
function* frames(bufRef) {
  while (bufRef.buf.length >= 9) {
    const need = 9 + bufRef.buf.readUInt16LE(7);
    if (bufRef.buf.length < need) break;
    const f = bufRef.buf.slice(0, need);
    bufRef.buf = bufRef.buf.slice(need);
    yield f;
  }
}

function startServer(plc, opts) {
  const log = (...a) => { if (!opts.quiet) console.log(...a); };
  const delay = () => {
    const base = opts.latency || 0;
    const j = opts.jitter ? Math.random() * opts.jitter : 0;
    return base + j;
  };

  const tcp = net.createServer((sock) => {
    if (opts.maxConn > 0 && plc.stats.conns >= opts.maxConn) {
      log(`[virtual-plc] ปฏิเสธ connection (เกิน --max-conn ${opts.maxConn})`);
      sock.destroy();
      return;
    }
    plc.stats.conns++;
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    log(`[virtual-plc] + ต่อเข้ามา ${peer} (รวม ${plc.stats.conns})`);
    const ref = { buf: Buffer.alloc(0) };
    sock.on('data', (d) => {
      ref.buf = Buffer.concat([ref.buf, d]);
      for (const f of frames(ref)) {
        const { endCode, data } = plc.handle(f);
        const resp = buildResponse(endCode, data);
        const ms = delay();
        if (ms > 0) setTimeout(() => { if (!sock.destroyed) sock.write(resp); }, ms);
        else if (!sock.destroyed) sock.write(resp);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { plc.stats.conns--; log(`[virtual-plc] - ปิด ${peer} (เหลือ ${plc.stats.conns})`); });
  });

  tcp.listen(opts.port, opts.host, () => {
    const m = plc.mem;
    log(`\n[virtual-plc] MELSEC 3E จำลอง — ฟังที่ ${opts.host}:${opts.port} (TCP${opts.udp ? ' + UDP' : ''})`);
    log(`  memory: D=${m.D.length.toLocaleString()}  ZR=${m.ZR.length.toLocaleString()}  W=${m.W.length.toLocaleString()}  R=${m.R.length.toLocaleString()}` +
        `  → รวม ${(m.D.length + m.ZR.length + m.W.length + m.R.length).toLocaleString()} word`);
    log(`  seed=${opts.seed} · non-zero: D=${plc.nonZeroCount('D').toLocaleString()} ZR=${plc.nonZeroCount('ZR').toLocaleString()}`);
    log(`  max-points/คำสั่ง=${opts.maxPoints} · latency=${opts.latency}ms(+jitter ${opts.jitter}) · max-conn=${opts.maxConn || 'ไม่จำกัด'}` +
        (plc.protectedAreas.size ? ` · write-protect: ${[...plc.protectedAreas].join(',')}` : ''));
    log(`  Ctrl+C เพื่อหยุด\n`);
  });

  let udp = null;
  if (opts.udp) {
    udp = dgram.createSocket('udp4');
    udp.on('message', (msg, rinfo) => {
      const ref = { buf: msg };
      for (const f of frames(ref)) {
        const { endCode, data } = plc.handle(f);
        const resp = buildResponse(endCode, data);
        const ms = delay();
        const send = () => udp.send(resp, rinfo.port, rinfo.address, () => {});
        if (ms > 0) setTimeout(send, ms); else send();
      }
    });
    udp.bind(opts.port, opts.host);
  }

  const statTimer = setInterval(() => {
    if (opts.quiet) return;
    const s = plc.stats;
    if (s.reads || s.writes) {
      log(`[virtual-plc] read=${s.reads} (${s.wordsRead.toLocaleString()} word) · write=${s.writes} (${s.wordsWritten.toLocaleString()} word) · error=${s.errors} · conn=${s.conns}`);
    }
  }, 10000);
  statTimer.unref?.();

  return { tcp, udp, close: () => { try { tcp.close(); } catch (_) {} try { udp && udp.close(); } catch (_) {} clearInterval(statTimer); } };
}

module.exports = { VirtualPlc, startServer, buildResponse, frames, CODE_TO_AREA,
  EC_OK, EC_DEVICE_RANGE, EC_POINT_OVER, EC_WRITE_PROTECT, EC_BAD_DEVICE };

if (require.main === module) {
  const opts = parseArgs(process.argv);
  const plc = new VirtualPlc(opts);
  const srv = startServer(plc, opts);
  const bye = () => { console.log('\n[virtual-plc] ปิด'); srv.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
