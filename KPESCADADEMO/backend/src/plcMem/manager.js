// plcMem/manager.js — PlcMemManager: config + lifecycle + orchestrate sweep/diff/write/snapshot
//   ต่อ PLC: config แยก ranges/chunk/socket/bufferConn(pg)/snapshotConn(pg)/writeMaxWords/writeGateTag
//   ดู docs/PLCMEM-BLUEPRINT.md หัวข้อ 0 (กติกาเหล็ก) + 3 (โครงไฟล์)
//   T5 (writer) / T6 (snapshot) เติมทีหลังในไฟล์แยก — manager นี้ประกอบร่าง
const fs = require('fs');
const path = require('path');
const csv = require('../csvUtil');
const PlcMemStore = require('./store');
const PlcMemSweeper = require('./sweeper');
const { writeDiff } = require('./writer');
const { AREAS, MAX_ADDR } = require('./constants');

class PlcMemManager {
  constructor({ engine, dbManager, onStatus } = {}) {
    this.engine = engine || null;
    this.dbManager = dbManager || null;
    // onStatus(deviceId, state) — เรียกทุกครั้งที่สถานะ sweeper เปลี่ยน (server.js ใช้ broadcast({type:'plcmem_status',...}))
    this.onStatus = typeof onStatus === 'function' ? onStatus : null;
    // config เก็บที่ <base>/config/plcmem.json (idiom databaseManager.js:14 — resolveConfig + legacy fallback)
    this.configPath = csv.resolveConfig('plcmem.json', path.join(__dirname, '..', 'config', 'plcmem.json'));
    this.plcs = [];            // config ที่ validate แล้ว (แหล่งความจริงเดียว)
    this.store = new PlcMemStore(this.dbManager);
    this._state = new Map();   // deviceId -> runtime status ล่าสุด (อัปเดตจาก sweeper callback)
    this._sweepers = new Map();// deviceId -> sweeper instance ที่กำลังวิ่งอยู่
    this._started = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const list = Array.isArray(raw.plcs) ? raw.plcs : [];
        // โหลดแบบ best-effort: entry ที่ validate ไม่ผ่าน (เช่น device ถูกลบไปแล้ว) → ข้าม ไม่ทำให้ boot ตาย
        this.plcs = [];
        for (const p of list) {
          try { this.plcs.push(this._validatePlc(p)); }
          catch (e) { console.error(`[PlcMem] ข้าม config ที่ผิด (deviceId=${p && p.deviceId}):`, e.message); }
        }
      } else {
        this.plcs = [];
        this._save();
      }
    } catch (e) {
      console.error('[PlcMem] load error:', e.message);
      this.plcs = [];
    }
  }

  _save() {
    csv.writeJsonAtomic(this.configPath, { plcs: this.plcs });
  }

  // ── validation (ดู blueprint §3 config shape + §T1 เกณฑ์) ──────────────────
  _validatePlc(p) {
    if (!p || typeof p !== 'object') throw new Error('plc entry ต้องเป็น object');
    const deviceId = String(p.deviceId || '').trim();
    if (!deviceId) throw new Error('deviceId ต้องไม่ว่าง');
    // review finding #6: store._safe() sanitize deviceId เป็นชื่อตาราง แต่ถ้าไม่เหลือ [A-Za-z0-9_]
    //   เลยสักตัว จะ fallback เป็น 'plc' คงที่ — สอง deviceId ที่ต่างกันแต่ไม่ใช่ alphanumeric เลย
    //   (เช่น เป็นภาษาไทย/สัญลักษณ์ล้วน) จะชนกันไปใช้ตารางเดียวกันแบบเงียบ ๆ · บังคับ charset ตั้งแต่ตอน
    //   validate config กันไม่ให้เคสนี้เกิดได้เลย (deviceId ทั่วไปในระบบนี้เป็น alphanumeric อยู่แล้ว)
    if (!/^[A-Za-z0-9_]+$/.test(deviceId)) {
      throw new Error(`deviceId "${deviceId}" ต้องมีแค่ A-Z a-z 0-9 _ เท่านั้น (ใช้ตั้งชื่อตาราง DB ตรง ๆ)`);
    }
    if (this.engine) {
      const dev = (this.engine.allDevices || []).find((d) => d.id === deviceId);
      if (!dev) throw new Error(`deviceId "${deviceId}" ไม่มีอยู่ใน devices.json`);
      if (dev.type !== 'mc_protocol') throw new Error(`deviceId "${deviceId}" ต้องเป็น type mc_protocol (ได้ "${dev.type}")`);
    }

    const rawRanges = Array.isArray(p.ranges) ? p.ranges : [];
    if (!rawRanges.length) throw new Error(`plc "${deviceId}": ต้องมี ranges อย่างน้อย 1 ช่วง`);
    const ranges = rawRanges.map((r, i) => {
      const area = String((r && r.area) || '').toUpperCase();
      if (!AREAS.includes(area)) throw new Error(`ranges.area ต้องเป็นหนึ่งใน ${AREAS.join(',')} (ได้ "${r && r.area}")`);
      const start = Number(r.start);
      const end = Number(r.end);
      if (!Number.isInteger(start) || start < 0) throw new Error(`ranges.start ต้องเป็นจำนวนเต็ม >= 0 (area ${area})`);
      if (!Number.isInteger(end) || end <= start) throw new Error(`ranges.end ต้องเป็นจำนวนเต็มมากกว่า start (area ${area})`);
      if (end > MAX_ADDR) throw new Error(`ranges.end เกิน 0x${MAX_ADDR.toString(16)} (address 3 byte, area ${area})`);
      // name: ชื่อเรียกช่วงนี้ — ให้ API/tag สั่งกวาด "เฉพาะช่วงนี้" ได้โดยไม่ต้องพิมพ์ start/end ซ้ำ
      //   ไม่ตั้ง = ใช้ชื่อ auto "<area><start>-<end>" (เช่น D1000-3000) · ต้องไม่ซ้ำกันภายใน plc เดียว
      const name = String((r && r.name) || '').trim() || `${area}${start}-${end}`;
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`ranges.name ต้องมีแค่ A-Z a-z 0-9 _ - เท่านั้น (ได้ "${name}")`);
      }
      // triggerTag ต่อช่วง ("deviceId/tagId"): ขอบขาขึ้น = กวาดเฉพาะช่วงนี้ช่วงเดียว
      //   (ต่างจาก sweepTriggerTag ระดับ plc ที่กวาดครบทุกช่วง)
      const triggerTag = String((r && r.triggerTag) || '');
      if (triggerTag && !triggerTag.includes('/')) {
        throw new Error(`ranges[${i}].triggerTag ต้องอยู่ในรูป "deviceId/tagId" (ได้ "${triggerTag}")`);
      }
      return { area, start, end, name, triggerTag };
    });
    const seenNames = new Set();
    for (const r of ranges) {
      if (seenNames.has(r.name)) throw new Error(`ranges.name ซ้ำ: "${r.name}" (ต้องไม่ซ้ำภายใน plc เดียวกัน)`);
      seenNames.add(r.name);
    }

    const chunk = p.chunk != null ? Number(p.chunk) : 100;
    if (!Number.isInteger(chunk) || chunk < 1 || chunk > 960) throw new Error('chunk ต้องเป็นจำนวนเต็ม 1..960 (spec 3E)');

    const sweepDelayMs = p.sweepDelayMs != null ? Number(p.sweepDelayMs) : 50;
    if (!Number.isFinite(sweepDelayMs) || sweepDelayMs < 0) throw new Error('sweepDelayMs ต้อง >= 0');

    const socket = p.socket === 'shared' ? 'shared' : 'dedicated';

    const bufferConn = String(p.bufferConn || '').trim();
    if (!bufferConn) throw new Error('bufferConn ต้องไม่ว่าง');
    const snapshotConn = String(p.snapshotConn || bufferConn).trim();
    if (this.dbManager) {
      this._requirePg(bufferConn, 'bufferConn');
      this._requirePg(snapshotConn, 'snapshotConn');
    }

    const writeMaxWords = p.writeMaxWords != null ? Number(p.writeMaxWords) : Math.min(chunk, 100);
    if (!Number.isInteger(writeMaxWords) || writeMaxWords < 1 || writeMaxWords > 960) {
      throw new Error('writeMaxWords ต้องเป็นจำนวนเต็ม 1..960');
    }

    const writeGateTag = String(p.writeGateTag || '');
    // sweepTriggerTag (format "deviceId/tagId"): ถ้าตั้งไว้ → เลิกวนกวาดอัตโนมัติต่อเนื่อง เปลี่ยนเป็นกวาด
    //   เฉพาะตอน tag เด้ง false→true (edge) แทน — กันชนกับปุ่ม/API "กวาดเดี๋ยวนี้" ที่ auto-loop ยึด busy ตลอด
    //   ไม่ตั้ง (ค่าว่าง ค่า default) = พฤติกรรมเดิม วนกวาดต่อเนื่องตาม sweepDelayMs
    const sweepTriggerTag = String(p.sweepTriggerTag || '');

    return {
      deviceId,
      enabled: p.enabled !== false,
      ranges,
      chunk,
      sweepDelayMs,
      socket,
      bufferConn,
      snapshotConn,
      writeMaxWords,
      writeGateTag,
      sweepTriggerTag,
    };
  }

  // bufferConn/snapshotConn ต้อง resolve ได้ + เป็น pg เท่านั้น (gotcha #1 — ห้าม sqlite บล็อก event loop)
  _requirePg(connName, label) {
    let conn;
    try { conn = this.dbManager.resolve(connName); }
    catch (e) { throw new Error(`${label} "${connName}" resolve ไม่ได้: ${e.message}`); }
    const type = String((conn && conn.type) || 'pg').toLowerCase();
    if (type !== 'pg') throw new Error(`${label} "${connName}" ต้องเป็น pg เท่านั้น (ได้ "${type}") — PLCMEM buffer ห้ามใช้ sqlite/mssql/mysql`);
  }

  // ── public API ──────────────────────────────────────────────────────────
  getConfig() { return { plcs: this.plcs }; }

  getStatus() {
    const out = {};
    for (const p of this.plcs) {
      out[p.deviceId] = this._state.get(p.deviceId) || {
        sweeping: false, cycle: 0, pos: null, okChunks: 0, errChunks: 0,
        lastCycleMs: null, lastCycleAt: null, connected: false,
      };
    }
    return out;
  }

  updateConfig(body) {
    const list = Array.isArray(body && body.plcs) ? body.plcs : null;
    if (!list) throw new Error('body.plcs ต้องเป็น array');
    const validated = list.map((p) => this._validatePlc(p));
    const seen = new Set();
    for (const p of validated) {
      if (seen.has(p.deviceId)) throw new Error(`deviceId ซ้ำ: ${p.deviceId}`);
      seen.add(p.deviceId);
    }
    this.plcs = validated;
    this._save();
    this._reload();
    return this.getConfig();
  }

  // เรียกหลัง config เปลี่ยน (updateConfig) — sync sweeper ให้ตรง config ล่าสุด (no-op ถ้ายังไม่ start())
  _reload() {
    if (this._started) this._syncSweepers();
  }

  // stop sweeper ทั้งหมด แล้วสร้างใหม่ตาม this.plcs ปัจจุบัน (เฉพาะตัวที่ enabled)
  //   rebuild ทั้งชุดแทนการ diff ทีละตัว — ง่ายและถูกต้องเสมอ (config เปลี่ยนไม่บ่อย ไม่ใช่ hot path)
  _syncSweepers() {
    for (const sw of this._sweepers.values()) { try { sw.stop(); } catch (_) {} }
    this._sweepers.clear();
    for (const p of this.plcs) {
      if (!p.enabled) { this._state.delete(p.deviceId); continue; }
      const device = ((this.engine && this.engine.allDevices) || []).find((d) => d.id === p.deviceId) || null;
      const sw = new PlcMemSweeper({
        plc: p, device, engine: this.engine, store: this.store,
        onStatus: (deviceId, state) => {
          this._state.set(deviceId, state);
          if (this.onStatus) { try { this.onStatus(deviceId, state); } catch (_) {} }
        },
      });
      this._sweepers.set(p.deviceId, sw);
      sw.start();
    }
  }

  // trigger กวาดทันที 1 รอบ (T4 route) — throw code 'NOT_RUNNING' ถ้า plc ไม่ได้ enabled/ยังไม่ start
  //   sweeper เองโยน code 'BUSY' ถ้ากำลังกวาดอยู่แล้ว (re-entrancy) — route แปลงเป็น 409
  //   เลือกช่วงได้ 3 แบบ: ไม่ระบุ = ครบทุกช่วง · names = เลือกช่วงที่ตั้งไว้ตามชื่อ · ranges = ระบุ start/end เอง
  async sweepNow(deviceId, { ranges, names } = {}) {
    const sw = this._sweepers.get(deviceId);
    if (!sw) throw Object.assign(new Error(`plc "${deviceId}" ไม่ได้ enabled หรือยังไม่ start`), { code: 'NOT_RUNNING' });
    return sw.sweepNow(this.resolveRanges(deviceId, { ranges, names }));
  }

  // แปลง {names?} / {ranges?} → array ของช่วงที่จะกวาดจริง (undefined = ครบทุกช่วงตาม config)
  //   names อ้างชื่อช่วงใน config เท่านั้น (ไม่เจอ = throw บอกชื่อที่มีให้เลือก — กันพิมพ์ผิดแล้วกวาดผิดช่วงเงียบ ๆ)
  resolveRanges(deviceId, { ranges, names } = {}) {
    if (Array.isArray(ranges) && ranges.length) return ranges;
    if (!Array.isArray(names) || !names.length) return undefined;
    const plc = this.plcs.find((p) => p.deviceId === deviceId);
    if (!plc) throw Object.assign(new Error(`plc "${deviceId}" ไม่มีใน config`), { code: 'NOT_FOUND' });
    const picked = [];
    for (const n of names) {
      const key = String(n).trim();
      const hit = plc.ranges.find((r) => r.name === key);
      if (!hit) {
        throw new Error(`ไม่พบช่วงชื่อ "${key}" — ที่มีให้เลือก: ${plc.ranges.map((r) => r.name).join(', ')}`);
      }
      picked.push(hit);
    }
    return picked;
  }

  // T5: เขียน PLC จริง — ใช้ driver ตัวเดียวกับ sweeper เสมอ (getDriver()) ห้ามสร้าง connection แยก
  async write(deviceId, { confirm } = {}, actorCtx = {}) {
    const plc = this.plcs.find((p) => p.deviceId === deviceId);
    if (!plc) throw Object.assign(new Error(`plc "${deviceId}" ไม่มีใน config`), { code: 'NOT_FOUND' });
    const sw = this._sweepers.get(deviceId);
    if (!sw) throw Object.assign(new Error(`plc "${deviceId}" ไม่ได้ enabled หรือยังไม่ start`), { code: 'NOT_RUNNING' });
    const driver = await sw.getDriver();
    if (!driver || !driver.connected) throw Object.assign(new Error(`plc "${deviceId}" ไม่ได้เชื่อมต่ออยู่`), { code: 'NOT_CONNECTED' });
    return writeDiff({
      plc, driver, store: this.store, engine: this.engine, confirm,
      actor: actorCtx.actor, actorType: actorCtx.actorType, ip: actorCtx.ip,
    });
  }

  // ── T6: backup/rollback/snapshots (cold path — คนละ DB connection กับ hot ได้) ─────────
  _findPlcOrThrow(deviceId) {
    const plc = this.plcs.find((p) => p.deviceId === deviceId);
    if (!plc) throw Object.assign(new Error(`plc "${deviceId}" ไม่มีใน config`), { code: 'NOT_FOUND' });
    return plc;
  }

  async backup(deviceId, note, actorCtx = {}) {
    const plc = this._findPlcOrThrow(deviceId);
    const result = await this.store.backup(plc.bufferConn, plc.snapshotConn, plc.deviceId, plc.ranges, note, actorCtx.actor);
    try {
      await this.store.journal(plc.bufferConn, {
        plc: deviceId, action: 'backup', detail: `${result.snapTable} (${result.count} row)`,
        actor: actorCtx.actor, actorType: actorCtx.actorType, ip: actorCtx.ip,
      });
    } catch (_) {}
    return result;
  }

  async listSnapshots(deviceId) {
    const plc = this._findPlcOrThrow(deviceId);
    return this.store.listSnapshots(plc.snapshotConn, plc.deviceId);
  }

  async rollback(deviceId, snapId, actorCtx = {}) {
    const plc = this._findPlcOrThrow(deviceId);
    const result = await this.store.rollback(plc.bufferConn, plc.snapshotConn, plc.deviceId, snapId, actorCtx.actor);
    try {
      await this.store.journal(plc.bufferConn, {
        plc: deviceId, action: 'rollback', detail: `snapshot #${snapId} (${result.restored} address)`,
        actor: actorCtx.actor, actorType: actorCtx.actorType, ip: actorCtx.ip,
      });
    } catch (_) {}
    return result;
  }

  // route ไม่มี :dev (DELETE /api/plcmem/snapshots/:snapId) — ไม่รู้ล่วงหน้าว่า snapshotConn ไหน
  //   (แต่ละ plcตั้ง snapshotConn เองได้) → ไล่ลองทุก snapshotConn ที่มีใน config จนกว่าจะเจอ
  // review finding #10: backup()/rollback() journal ทั้งคู่ แต่ deleteSnapshot เดิมไม่เคย — เพิ่มให้
  //   ตรงกัน (ลบ backup ทิ้งถาวรคือของที่ควร audit ที่สุดตัวหนึ่ง) · journal เข้า bufferConn ของ plc
  //   นั้นถ้ายังอยู่ใน config ปัจจุบัน (ให้ audit trail ของ plc รวมอยู่ที่เดียว) ไม่งั้น fallback ไปที่
  //   snapshotConn ที่เพิ่งลบสำเร็จ (plc อาจถูกถอดออกจาก config ไปแล้วหลัง snapshot ถูกสร้าง)
  async deleteSnapshot(snapId, actorCtx = {}) {
    const conns = [...new Set(this.plcs.map((p) => p.snapshotConn))];
    for (const conn of conns) {
      const r = await this.store.deleteSnapshot(conn, snapId);
      if (r.ok) {
        const owner = this.plcs.find((p) => p.deviceId === r.plc);
        const journalConn = owner ? owner.bufferConn : conn;
        try {
          await this.store.journal(journalConn, {
            plc: r.plc, action: 'snapshot_delete', detail: `${r.snapTable} (snapshot #${snapId})`,
            actor: actorCtx.actor, actorType: actorCtx.actorType, ip: actorCtx.ip,
          });
        } catch (_) {}
        return r;
      }
    }
    throw Object.assign(new Error(`snapshot id ${snapId} ไม่พบ`), { code: 'NOT_FOUND' });
  }

  // lifecycle — เรียกจาก startServicesOnce()/gracefulShutdown() ใน server.js
  start() {
    if (this._started) return;
    this._started = true;
    this._syncSweepers();
  }

  stop() {
    this._started = false;
    for (const sw of this._sweepers.values()) { try { sw.stop(); } catch (_) {} }
    this._sweepers.clear();
  }
}

module.exports = PlcMemManager;
