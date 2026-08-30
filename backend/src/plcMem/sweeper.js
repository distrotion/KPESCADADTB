// plcMem/sweeper.js — กวาด PLC 1 ตัว → buffer01 (pg) จนกว่า stop() — 2 โหมด:
//   ไม่ตั้ง sweepTriggerTag (default) = วนกวาดต่อเนื่องตาม sweepDelayMs (พฤติกรรมเดิม)
//   ตั้ง sweepTriggerTag = "deviceId/tagId" = เลิกวนเอง กวาดเฉพาะตอน tag เด้ง false→true (edge) — กันชนกับปุ่ม/API "กวาดเดี๋ยวนี้"
//   dedicated: สร้าง MCProtocolDriver ของตัวเอง + reconnect เอง (driver ไม่ reconnect อัตโนมัติ — survey mcProtocolDriver.js)
//   shared:    ใช้ driver ของ engine ตัวเดียวกับ tag poll ปกติ (เข้าคิว _txChain ร่วม) — สำหรับ PLC รับได้ 1 connection
const MCProtocolDriver = require('../drivers/mcProtocolDriver');

const RECONNECT_THROTTLE_MS = 2000;   // กันยิง connect() รัวทุก chunk เมื่อ PLC ดับ (เหมือน autoProbe throttle 8s ใน tagEngine)

class PlcMemSweeper {
  constructor({ plc, device, engine, store, onStatus, driverFactory } = {}) {
    this.plc = plc;                 // config entry ที่ validate แล้ว (deviceId/ranges/chunk/sweepDelayMs/socket/bufferConn/...)
    this.device = device || null;   // engine.allDevices entry — ใช้ connection info ตอน dedicated
    this.engine = engine || null;
    this.store = store;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this._driverFactory = driverFactory || ((dev) => new MCProtocolDriver({
      id: `${dev.id}-plcmem`, name: `${dev.id}-plcmem`, connection: { ...(dev.connection || {}) },
    }));
    this._driver = null;
    this._lastConnectAttempt = 0;
    this._stopped = true;
    this._cancelCurrent = false;
    this._loopRunning = false;
    this._lastTriggerVal = false;   // edge-detect baseline สำหรับ sweepTriggerTag (reset ทุก start())
    this._lastRangeTrigger = new Map();   // name → ค่าล่าสุดของ range.triggerTag (edge-detect ต่อช่วง)
    this.state = {
      sweeping: false, cycle: 0, pos: null, okChunks: 0, errChunks: 0,
      lastCycleMs: null, lastCycleAt: null, connected: false,
    };
  }

  // อ่านค่า sweepTriggerTag ("deviceId/tagId") จาก engine — null = ไม่ได้ตั้งค่า/อ่านไม่ได้ (เฉย ๆ ไม่ throw)
  _readTriggerTag(tagPath) {
    const s = String(tagPath != null ? tagPath : (this.plc.sweepTriggerTag || ''));
    const idx = s.indexOf('/');
    if (idx < 0) return null;
    const deviceId = s.slice(0, idx);
    const tagId = s.slice(idx + 1);
    if (!this.engine || typeof this.engine.getTagValue !== 'function') return null;
    const tv = this.engine.getTagValue(deviceId, tagId);
    return !!(tv && tv.value);
  }

  _emit() { try { this.onStatus(this.plc.deviceId, { ...this.state }); } catch (_) {} }

  // driver ตาม socket mode — shared ใช้ของ engine ตรง ๆ (ไม่ต้อง connect/disconnect เอง — engine คุมอยู่แล้ว)
  async _ensureDriver() {
    if (this.plc.socket === 'shared') {
      return (this.engine && this.engine.drivers && this.engine.drivers.get(this.plc.deviceId)) || null;
    }
    if (!this._driver) this._driver = this._driverFactory(this.device || { id: this.plc.deviceId, connection: {} });
    if (!this._driver.connected) {
      const now = Date.now();
      if (now - this._lastConnectAttempt >= RECONNECT_THROTTLE_MS) {
        this._lastConnectAttempt = now;
        await this._driver.connect().catch(() => {});
      }
    }
    return this._driver;
  }

  // public: ให้ writer.js (T5) ยืมใช้ driver "ตัวเดียวกับ sweeper" เสมอ — ห้ามสร้าง connection แยก
  //   เพราะ MC 3E ไม่มี transaction id ต้อง serialize คำสั่งบน socket เดียว (driver._txChain คุมให้
  //   เองก็ต่อเมื่อเป็น instance เดียวกัน — สอง instance ไม่ serialize ข้ามกัน)
  async getDriver() { return this._ensureDriver(); }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._lastTriggerVal = false;   // baseline ใหม่ทุกครั้งที่ start — กัน edge ค้างจากรอบก่อน
    this._lastRangeTrigger.clear();
    this._loop();
  }

  // stop() ต้องหยุด "cycle ที่กำลังวิ่งอยู่ตอนนี้" ด้วย ไม่ใช่แค่กันไม่ให้เริ่มรอบใหม่
  //   ⚠️ ใช้ flag แยกจาก _stopped: sweepNow() (manual trigger) ต้องกวาดได้แม้ _stopped=true (ค่าเริ่มต้นก่อน start())
  //   ถ้า _runCycle เช็ค this._stopped ตรง ๆ → sweepNow() เรียกตอนยังไม่ start() แล้วจะไม่กวาดอะไรเลย (0 chunk เงียบ ๆ)
  stop() {
    this._stopped = true;
    this._cancelCurrent = true;
    if (this.plc.socket !== 'shared' && this._driver) {
      try { this._driver.disconnect(); } catch (_) {}
      this._driver = null;
    }
  }

  // trigger กวาดทันที (นอกรอบ loop ปกติ) — 409 (BUSY) ถ้ากำลังกวาดอยู่แล้ว (re-entrancy)
  async sweepNow(overrideRanges) {
    if (this.state.sweeping) throw Object.assign(new Error('sweep in progress'), { code: 'BUSY' });
    return this._runCycle(overrideRanges);
  }

  async _loop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    const perRange = (this.plc.ranges || []).filter((r) => r.triggerTag);
    if (this.plc.sweepTriggerTag || perRange.length) {
      // edge-triggered: กวาดเฉพาะตอน tag เด้ง false→true — ไม่วนกวาดต่อเนื่องเอง (เลิกชนกับ sweepNow() manual/API)
      //   sweepTriggerTag (ระดับ plc) = กวาดครบทุกช่วง · range.triggerTag = กวาดเฉพาะช่วงนั้นช่วงเดียว
      while (!this._stopped) {
        if (this.plc.sweepTriggerTag) {
          const val = this._readTriggerTag();
          if (val === true && this._lastTriggerVal !== true) {
            try { await this._runCycle(); }
            catch (e) { console.error(`[plcmem/${this.plc.deviceId}] cycle error:`, e.message); }
          }
          if (val !== null) this._lastTriggerVal = val;
        }
        for (const r of perRange) {
          if (this._stopped) break;
          const val = this._readTriggerTag(r.triggerTag);
          if (val === true && this._lastRangeTrigger.get(r.name) !== true) {
            try { await this._runCycle([r]); }   // กวาดช่วงเดียว
            catch (e) { console.error(`[plcmem/${this.plc.deviceId}/${r.name}] cycle error:`, e.message); }
          }
          if (val !== null) this._lastRangeTrigger.set(r.name, val);
        }
        await this._delay(300);   // poll tag เบา ๆ ทุก 300ms — ไม่ใช่การกวาด PLC จริง
      }
    } else {
      // ค่าเดิม: วนกวาดต่อเนื่องตาม sweepDelayMs (ไม่ตั้ง sweepTriggerTag)
      while (!this._stopped) {
        try { await this._runCycle(); }
        catch (e) { console.error(`[plcmem/${this.plc.deviceId}] cycle error:`, e.message); }
      }
    }
    this._loopRunning = false;
  }

  _delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async _runCycle(overrideRanges) {
    const ranges = overrideRanges || this.plc.ranges;
    this._cancelCurrent = false;   // reset ทุกครั้งที่เริ่ม cycle ใหม่ (ทั้งจาก loop และ manual sweepNow())
    this.state.sweeping = true;
    this.state.pos = null;
    let okChunks = 0, errChunks = 0;
    const t0 = Date.now();
    this._emit();

    const driver = await this._ensureDriver();
    this.state.connected = !!(driver && driver.connected);
    this._emit();

    for (const range of ranges) {
      let pos = range.start;
      while (pos < range.end) {
        if (this._cancelCurrent) break;
        const count = Math.min(this.plc.chunk, range.end - pos);   // chunk สุดท้ายไม่เกิน end
        this.state.pos = { area: range.area, addr: pos };
        this._emit();

        let words = null;
        if (driver && driver.connected) {
          try { words = await driver.readBlock(range.area, pos, count); }
          catch (_) { words = null; }
        }
        if (words == null) {
          errChunks++;   // อ่านไม่ได้ → ข้าม+นับ error (ไม่ทำลูปตาย)
        } else {
          const rows = words.map((v, i) => ({ area: range.area, addr: pos + i, value: v }));
          try { await this.store.upsertBatch(this.plc.bufferConn, this.plc.deviceId, 1, rows); okChunks++; }
          catch (e) { errChunks++; console.error(`[plcmem/${this.plc.deviceId}] upsert error:`, e.message); }
        }

        pos += count;
        if (this.plc.sweepDelayMs) await this._delay(this.plc.sweepDelayMs);
      }
      if (this._cancelCurrent) break;
    }

    this.state.sweeping = false;
    this.state.cycle += 1;
    this.state.okChunks = okChunks;
    this.state.errChunks = errChunks;
    this.state.lastCycleMs = Date.now() - t0;
    this.state.lastCycleAt = Date.now();
    this.state.pos = null;
    this._emit();
    return { ok: true, okChunks, errChunks, ms: this.state.lastCycleMs };
  }
}

module.exports = PlcMemSweeper;
