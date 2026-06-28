const fs = require('fs');
const path = require('path');
const csv = require('./csvUtil');
const ModbusDriver    = require('./drivers/modbusDriver');
const MCProtocolDriver = require('./drivers/mcProtocolDriver');
const OmronFinsDriver = require('./drivers/omronFinsDriver');
const MqttDriver      = require('./drivers/mqttDriver');
const OpcuaDriver     = require('./drivers/opcuaDriver');
const SerialDriver    = require('./drivers/serialDriver');
const KpenetworkDriver = require('./drivers/kpenetworkDriver');
const GpioDriver      = require('./drivers/gpioDriver');

// ── tag พิเศษต่อ device (read-only, engine คำนวณให้) — ค่าเป็น bool 0/1 ──
//   __online  : offline=0 / online=1   ·   __enabled : disable=0 / enable=1
const SPECIAL_TAGS = [
  { id: '__online',  name: 'Online'  },
  { id: '__enabled', name: 'Enabled' },
];

class TagEngine {
  constructor(onTagUpdate, onDeviceStatus) {
    this.onTagUpdate = onTagUpdate;       // callback(deviceId, tagId, value, quality, ts)
    this.onDeviceStatus = onDeviceStatus; // callback(deviceId, connected) — เมื่อสถานะ online/offline เปลี่ยน
    this.onSerialRaw = null;              // callback(deviceId, rawLine) — serial input ดิบ (script trigger 'serial')
    this.deviceStatus = new Map();        // deviceId -> bool (สถานะล่าสุดที่ broadcast ไปแล้ว)
    this.allDevices = [];                 // device ทั้งหมด (รวม disabled) — แหล่งความจริงเดียว
    this.drivers = new Map();
    this.tagValues = new Map(); // tag set (buffer กลางที่ UI/script เห็น) — "deviceId:tagId" -> { value, quality, timestamp }
    this.simStore  = new Map(); // buffer data (หน่วยความจำจำลองของ device ตอน sim mode) — "deviceId:tagId" -> value
    this.intervals = new Map();
    this.alarms = [];
    this._loadConfig();
  }

  _loadConfig() {
    // รวม config ไว้ที่ <base>/data/ (migrate จาก backend/src/config ครั้งแรก)
    const cfgPath = csv.resolveConfig('devices.json', path.join(__dirname, 'config', 'devices.json'));
    this.configPath = cfgPath;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { raw = { devices: [] }; }
    const list = Array.isArray(raw.devices) ? raw.devices : [];
    this.allDevices = list;   // แหล่งความจริงเดียว (รวม disabled) — `devices` เป็น getter ที่ derive สด
  }

  // device ที่ enabled — derive สดจาก allDevices เสมอ (กัน drift เมื่อ add/update/remove ตอน runtime)
  //   เดิมเป็น array ที่ filter ครั้งเดียวตอน _loadConfig → device ที่สร้างตอน runtime ไม่เข้า → KPENETWORK แชร์ไม่ได้
  get devices() { return this.allDevices.filter(d => d.enabled !== false); }

  saveConfig() {
    // ตัด runtime fields (_probeDone/_lastProbe ฯลฯ) ออกก่อนเขียนไฟล์ · ไม่ persist managed device (สร้างใหม่ตอน boot)
    const clean = this.allDevices.filter((d) => !d.managed).map((d) => {
      const o = {};
      for (const k of Object.keys(d)) { if (!k.startsWith('_')) o[k] = d[k]; }
      // kpenetwork: tags = network tag ที่ discover จาก peer (ไม่ใช่ config ของเรา) → ไม่ persist
      //   (re-discover ใหม่ทุกครั้งที่ต่อ · กัน config เลอะ + tag ค้างตอน peer offline)
      if (o.type === 'kpenetwork') o.tags = [];
      return o;
    });
    csv.writeJsonAtomic(this.configPath, { devices: clean });   // atomic (B3) — กัน config พังตอนไฟดับ/ครึ่งไฟล์
  }

  async start() {
    for (const device of this.devices) {
      await this._initDevice(device);
    }
    // sweep สถานะ connect ของทุก device → broadcast device_status ทันทีเมื่อเปลี่ยน (ไม่ต้อง refresh เอง)
    this._sweepDeviceStatus();
    this.statusSweep = setInterval(() => this._sweepDeviceStatus(), 1000);
  }

  // หยุดทุกอย่าง (ใช้ตอน reload หลัง import) — ตัด poll/sweep + ปลด driver ทุกตัว
  async stop() {
    if (this.statusSweep) { clearInterval(this.statusSweep); this.statusSweep = null; }
    for (const iv of this.intervals.values()) { try { clearInterval(iv); } catch (_) {} }
    this.intervals.clear();
    for (const drv of this.drivers.values()) {
      try { if (typeof drv.disconnect === 'function') drv.disconnect(); } catch (_) {}
    }
    this.drivers.clear();
    this.deviceStatus.clear();
  }

  // โหลด config ใหม่จากดิสก์แล้ว re-init devices ทั้งหมด (live-reload หลัง import)
  async reload() {
    await this.stop();
    this.tagValues.clear();
    this.simStore.clear();
    this._loadConfig();
    await this.start();
  }

  // สถานะ connect ที่ UI ใช้ (sim/virtual = online เสมอ, อื่น ๆ = driver.connected)
  _deviceConnected(device) {
    if (device.type === 'virtual' || device.simulate) return true;
    const driver = this.drivers.get(device.id);
    if (driver && driver.connected) return true;
    // รองรับ PLC ที่ปิด connection เป็นพัก ๆ (transactional) — ถ้าเพิ่งอ่านค่าสำเร็จ ถือว่า online
    if (device._lastGoodRead && Date.now() - device._lastGoodRead < (device.pollInterval || 1000) * 2 + 2000) {
      return true;
    }
    return false;
  }

  // ค่าของ tag พิเศษ (bool 0/1): __online = connected · __enabled = device.enabled
  _specialTagValue(device, id) {
    if (id === '__enabled') return device.enabled === false ? 0 : 1;
    return this._deviceConnected(device) ? 1 : 0;   // __online
  }

  _sweepDeviceStatus() {
    for (const device of this.allDevices) {
      const conn = this._deviceConnected(device);
      if (this.deviceStatus.get(device.id) !== conn) {
        this.deviceStatus.set(device.id, conn);
        if (this.onDeviceStatus) this.onDeviceStatus(device.id, conn);
      }
      // tag พิเศษ → เก็บใน buffer + broadcast tag_update เมื่อเปลี่ยน (อ่านได้เหมือน tag ปกติ)
      for (const st of SPECIAL_TAGS) {
        const sv = this._specialTagValue(device, st.id);
        const key = `${device.id}:${st.id}`;
        const prev = this.tagValues.get(key);
        if (!prev || prev.value !== sv) {
          this.tagValues.set(key, { value: sv, quality: 'good', timestamp: Date.now() });
          if (this.onTagUpdate) this.onTagUpdate(device.id, st.id, sv, 'good', Date.now());
        }
      }
    }
  }

  async _initDevice(device) {
    // ── Virtual device หรือ Simulate mode — tag เป็นตัวแปรในหน่วยความจำ ──────
    // simulate = true → device จริงถูกสลับเป็นโหมดทดสอบ (ไม่ต่อ driver/poll)
    if (device.type === 'virtual' || device.simulate) {
      for (const tag of device.tags) {
        // seed buffer data (หน่วยความจำจำลอง) แล้ว sync → tag set ผ่าน read pipeline
        if (!this.simStore.has(`${device.id}:${tag.id}`)) this._simWrite(device, tag, this._simSeed(tag));
        this._syncSimToTag(device, tag);
      }
      return; // ไม่มี driver / polling
    }

    let driver;
    switch (device.type) {
      case 'modbus_tcp':
      case 'modbus_rtu':
        driver = new ModbusDriver(device);
        break;
      case 'mc_protocol':
        driver = new MCProtocolDriver(device);
        break;
      case 'omron_fins':
        driver = new OmronFinsDriver(device);
        break;
      case 'mqtt':
        driver = new MqttDriver(device, (devId, tagId, value) => {
          this._setTagValue(devId, tagId, value, 'good');
        });
        break;
      case 'opcua':
        driver = new OpcuaDriver(device);
        break;
      case 'gpio':
        // Raspberry Pi GPIO — poll-based (อ่าน input ทุก poll · เขียน output ผ่าน writeTag generic)
        driver = new GpioDriver(device);
        break;
      case 'serial_port':
        // Raw serial — push-based, no polling needed
        driver = new SerialDriver(device, (devId, tagId, value) => {
          this._setTagValue(devId, tagId, value, 'good');
        }, (devId, raw) => {
          if (this.onSerialRaw) { try { this.onSerialRaw(devId, raw); } catch (_) {} }
        });
        break;
      case 'kpenetwork':
        // subscribe peer KPE — push-based (discover directory + poll Modbus → network tag)
        driver = new KpenetworkDriver(device, (devId, tagId, value) => {
          this._setTagValue(devId, tagId, value, 'good');
        }, () => {   // หลัง discover → ให้ KPENETWORK server rebuild (relay re-share §3.5)
          if (this.onTagsChanged) { try { this.onTagsChanged(); } catch (_) {} }
        });
        break;
      default:
        console.warn(`Unknown device type: ${device.type}`);
        return;
    }

    this.drivers.set(device.id, driver);

    // §76 B: driver ที่แจ้ง onStatusChange (kpenetwork ws) → re-evaluate ทันที → broadcast __online/device_status
    //   ไม่ต้องรอ statusSweep 1s (driver อื่นไม่ตั้ง callback นี้ = ไม่กระทบ)
    driver.onStatusChange = () => { try { this._sweepDeviceStatus(); } catch (_) {} };

    // tag-level simulate บน device จริง → seed buffer data + sync → tag set
    for (const tag of device.tags) {
      if (tag.simulate) this._syncSimToTag(device, tag); // _simRead จะ seed simStore ให้ถ้ายังไม่มี
    }

    // connect แบบไม่ block startup (device ที่ unreachable จะไม่หน่วงการ start)
    // ข้ามถ้า autoProbe เปิด — ให้ pollFn จัดการ probe ก่อน (กันแย่ง slot กับ probe)
    if (!device.autoProbe) driver.connect().catch(() => {});

    // Push-based drivers (mqtt, serial_port, kpenetwork) don't need polling
    if (device.type === 'mqtt' || device.type === 'serial_port' || device.type === 'kpenetwork') return;

    // ── READ SIDE pipeline ──────────────────────────────────────────────────
    //   tag set → device → data read → device → return tag set
    // ทุกรอบ poll: engine สั่งอ่านผ่าน device แล้วเอาค่ากลับเข้า buffer (tagValues)
    let polling = false;
    const pollFn = async () => {
      if (polling) return; // กัน poll ซ้อน (เผื่อ connect/read ช้ากว่า interval)
      // ถ้า device ถูก disable/แก้ไข (driver ถูกถอด/แทนแล้ว) → หยุด ไม่ reconnect
      if (this.drivers.get(device.id) !== driver) return;
      polling = true;
      try {
        if (this.drivers.get(device.id) !== driver) return; // เช็คซ้ำหลังตั้ง flag
        if (!driver.connected) {
          // auto-probe: ลอง connection มาตรฐานต่าง ๆ (throttle 8s, หยุดเมื่อเจอ)
          if (device.autoProbe && !device._probeDone) {
            const now = Date.now();
            if (!device._lastProbe || now - device._lastProbe > 8000) {
              device._lastProbe = now;
              const found = await this._autoProbe(device);
              if (found) {
                Object.assign(device.connection, found); // driver ใช้ค่าใหม่ตอน connect รอบหน้า
                device._probeDone = true;
                this.saveConfig();
                console.log(`[AutoProbe] ${device.name} → ${JSON.stringify(found)}`);
              }
              return; // ไม่ connect ในรอบนี้ (กันแย่ง slot กับ probe) — รอบหน้าใช้ค่าใหม่
            }
          }
          await driver.connect().catch(() => {});
        }
        for (const tag of device.tags) {
          if (tag.simulate) continue; // sim tag — buffer คือ "ความจริง" อยู่แล้ว ไม่อ่านจาก device
          const { value, quality } = await this._readSource(device, tag, driver);
          this._setTagValue(device.id, tag.id, value, quality); // → return tag set (buffer)
          if (quality === 'good') device._lastGoodRead = Date.now(); // online ตาม read สำเร็จ
        }
      } finally { polling = false; }
    };

    const interval = setInterval(pollFn, device.pollInterval || 1000);
    this.intervals.set(device.id, interval);
    pollFn(); // เริ่มรอบแรกทันที (ไม่ await — ไม่ block startup)
  }

  // ── Auto-probe: ลอง connection มาตรฐานต่าง ๆ เมื่อต่อไม่ติด (เปิดด้วย device.autoProbe) ──
  _createProbeDriver(device) {
    switch (device.type) {
      case 'modbus_tcp':
      case 'modbus_rtu':  return new ModbusDriver(device);
      case 'mc_protocol': return new MCProtocolDriver(device);
      case 'omron_fins':  return new OmronFinsDriver(device);
      case 'opcua':       return new OpcuaDriver(device);
      default:            return null; // mqtt/serial = push-based ไม่ probe
    }
  }

  _defaultProbeTag(type) {
    if (type === 'modbus_tcp' || type === 'modbus_rtu')
      return { id: '_probe', address: 0, fc: 3, dataType: 'INT16' };
    return { id: '_probe', address: 'D0', dataType: 'INT16' }; // mc / fins
  }

  // รายการ connection ที่จะลอง (มาตรฐานตาม protocol) — ตัวปัจจุบันก่อนเสมอ
  _probeCandidates(device) {
    const c = device.connection || {};
    const uniq = (a) => [...new Set(a.filter((x) => x != null))];
    if (device.type === 'mc_protocol') {
      const ports = uniq([c.port, 5002, 5000, 5001, 5006, 5007, 5010, 5011, 6000, 1025, 2000, 4999, 8193]);
      return ports.map((port) => ({ ...c, port, frameType: c.frameType || '3E' }));
    }
    if (device.type === 'modbus_tcp') {
      const ports = uniq([c.port, 502, 10502]);
      const units = uniq([c.unitId, 1, 0, 255]);
      const out = [];
      for (const port of ports) { for (const unitId of units) { out.push({ ...c, port, unitId }); } }
      return out;
    }
    if (device.type === 'omron_fins') {
      return uniq([c.port, 9600]).map((port) => ({ ...c, port }));
    }
    return [{ ...c }];
  }

  _delay(ms, val) { return new Promise((r) => setTimeout(() => r(val), ms)); }

  // ลองทีละ candidate — เกณฑ์ผ่าน: connect ได้ + อ่าน test tag ได้ค่า (ไม่ null)
  async _autoProbe(device) {
    const candidates = this._probeCandidates(device);
    const testTag = (device.tags || []).find((t) => !t.simulate) || this._defaultProbeTag(device.type);
    for (const conn of candidates) {
      const probeDev = { ...device, connection: conn, tags: [] };
      const drv = this._createProbeDriver(probeDev);
      if (!drv || typeof drv.connect !== 'function') continue;
      let ok = false;
      try {
        const connected = await Promise.race([drv.connect(), this._delay(2500, false)]);
        if (connected && drv.connected && typeof drv.readTag === 'function') {
          const v = await Promise.race([drv.readTag(testTag), this._delay(2500, null)]);
          ok = v !== null && v !== undefined;
        }
      } catch (_) {}
      try { if (typeof drv.disconnect === 'function') drv.disconnect(); } catch (_) {}
      // หน่วงให้ PLC ที่รับได้ทีละ 1 connection ปลด slot ก่อนลองตัวถัดไป / ก่อนให้ driver จริงต่อ
      await this._delay(600);
      if (ok) return conn;
    }
    return null;
  }

  _setTagValue(deviceId, tagId, value, quality) {
    const key = `${deviceId}:${tagId}`;
    const ts = Date.now();
    this.tagValues.set(key, { value, quality, timestamp: ts });
    if (this.onTagUpdate) {
      this.onTagUpdate(deviceId, tagId, value, quality, ts);
    }
  }

  getTagValue(deviceRef, tagRef) {
    // รับได้ทั้ง id และ name — resolve เป็น id จริงก่อนค่อยอ่าน buffer
    const device = this._findDevice(deviceRef);
    // tag พิเศษ (__online/__enabled) — คำนวณสด (รองรับ script: tag('dev','__online'))
    if (device && SPECIAL_TAGS.some(s => s.id === tagRef)) {
      return this.tagValues.get(`${device.id}:${tagRef}`)
          || { value: this._specialTagValue(device, tagRef), quality: 'good', timestamp: Date.now() };
    }
    const tag = device ? this._findTag(device, tagRef) : null;
    // sub-bit: อ้าง "tagname.N" → bit ที่ N (0-based) ของค่าจาก tag ฐาน — ทุก tag ที่ไม่ใช่ string
    //   (MULTI_BIT: .0 = address ฐาน เช่น M8 · word ทั่วไป: .3 = bit 3 ของค่า) ใช้ได้ทั้ง script/alarm/datalog
    if (device && !tag && typeof tagRef === 'string') {
      const m = tagRef.match(/^(.+)\.(\d+)$/);
      if (m) {
        const base = this._findTag(device, m[1]);
        const dtU = base ? String(base.dataType || '').toUpperCase() : '';
        if (base && dtU !== 'STRING' && dtU !== 'ASCII') {
          const cur = this.tagValues.get(`${device.id}:${base.id}`);
          const raw = cur ? cur.value : null;   // ระวัง Number(null)=0 — ฐานไม่มีค่าต้องคืน null
          const num = Number(raw);
          const bit = parseInt(m[2], 10);
          return {
            value: (raw == null || !Number.isFinite(num)) ? null : Math.floor(num / 2 ** bit) % 2,
            quality: cur ? cur.quality : 'unknown',
            timestamp: cur ? cur.timestamp : null,
          };
        }
      }
    }
    const key = (device && tag) ? `${device.id}:${tag.id}` : `${deviceRef}:${tagRef}`;
    return this.tagValues.get(key) || { value: null, quality: 'unknown', timestamp: null };
  }

  getAllValues() {
    const result = {};
    for (const device of this.allDevices) {
      result[device.id] = { name: device.name, type: device.type, tags: {} };
      const driver = this.drivers.get(device.id);
      // simulate/virtual → ถือว่า "connected" (active) เพื่อให้ UI ใช้งาน/เขียนค่าได้
      const isSim = device.type === 'virtual' || device.simulate;
      result[device.id].connected = isSim ? true : (driver ? driver.connected : false);
      result[device.id].simulate = !!device.simulate;
      // tag พิเศษ (read-only, bool 0/1) — __online / __enabled
      for (const st of SPECIAL_TAGS) {
        result[device.id].tags[st.id] = {
          name: st.name, unit: '', simulate: false, tagSim: false, logActivity: false, special: true,
          shared: !!device.shareStatus,   // §61: แชร์ __online/__enabled เข้า KPENETWORK (toggle ในหน้า Tags)
          ...(this.tagValues.get(`${device.id}:${st.id}`)
              || { value: this._specialTagValue(device, st.id), quality: 'good', timestamp: Date.now() }),
        };
      }
      for (const tag of device.tags) {
        const v = this.tagValues.get(`${device.id}:${tag.id}`);
        result[device.id].tags[tag.id] = {
          name: tag.name,
          unit: tag.unit || '',
          dataType: tag.dataType || '',     // ให้ UI รู้ชนิด (MULTI_BIT → ขยาย picker เป็น tag.N)
          bits: Number(tag.bits) || 0,      // MULTI_BIT: จำนวน bit ที่อ่านต่อเนื่องจาก address
          address: tag.address != null ? String(tag.address) : '',  // โชว์ M8+N ใน picker
          group: tag.group || '',           // กลุ่มย่อยภายใน device (ว่าง = ลอย) — หน้า Tags
          // sim ของ tag = tag.simulate (ระดับ tag) หรือทั้ง device เป็น sim/virtual
          simulate: !!tag.simulate || isSim,
          tagSim: !!tag.simulate,
          logActivity: !!tag.logActivity,   // log write/force ลง History (toggle ในหน้า Tags)
          shared: !!tag.shared,             // แชร์เข้า KPENETWORK (§55)
          network: !!tag.network,           // network tag (ดึงมาจาก KPENETWORK peer)
          srcDevice: tag.srcDevice || '',   // device ต้นทาง (เมื่อ network)
          origin: tag.origin || '',         // nodeId ต้นทาง (เมื่อ network)
          ...(v || { value: null, quality: 'unknown', timestamp: null }),
        };
      }
    }
    return result;
  }

  // ── resolve device/tag จาก id หรือ name (id ก่อน แล้วค่อย name) ───────────────
  // ให้ script/UI อ้าง device หรือ tag ด้วยชื่อที่เห็นใน UI ได้ ไม่ต้องจำ id
  _findDevice(ref) {
    return this.allDevices.find(d => d.id === ref)
        || this.allDevices.find(d => d.name === ref)
        || null;
  }
  _findTag(device, ref) {
    if (!device) return null;
    return device.tags.find(t => t.id === ref)
        || device.tags.find(t => t.name === ref)
        || null;
  }

  // ── tag เป็น "buffer กลาง" — sim/virtual ใช้ buffer แทน device ได้เนียน ─────────
  // sim = ทั้ง device.simulate, virtual device, หรือ tag.simulate (ระดับ tag)
  _isSim(device, tag) {
    return !!(device.type === 'virtual' || device.simulate || (tag && tag.simulate));
  }

  // ── buffer data (หน่วยความจำจำลองของ device ตอน sim) — แยกจาก tag set ───────────
  // ค่าเริ่มต้นของ buffer data: simValue → defaultValue → 0
  _simSeed(tag) {
    return tag.simValue !== undefined ? tag.simValue
         : (tag.defaultValue !== undefined ? tag.defaultValue : 0);
  }
  // อ่านจาก buffer data (seed ถ้ายังไม่มี) — ใช้แทน driver.readTag ตอน sim
  _simRead(device, tag) {
    const k = `${device.id}:${tag.id}`;
    if (!this.simStore.has(k)) this.simStore.set(k, this._simSeed(tag));
    return this.simStore.get(k);
  }
  // เขียนลง buffer data — ใช้แทน driver.writeTag ตอน sim
  _simWrite(device, tag, value) {
    this.simStore.set(`${device.id}:${tag.id}`, value);
  }
  // sync buffer data → tag set (สำหรับ init/CRUD ที่ไม่ได้ผ่าน write pipeline)
  _syncSimToTag(device, tag) {
    this._setTagValue(device.id, tag.id, this._simRead(device, tag), 'good');
  }

  /**
   * อ่านค่าจาก "แหล่ง" ของ tag → คืน { value, quality }
   * - sim/virtual  : buffer คือความจริง (ค่า sim ที่ตั้งไว้ / ค่าล่าสุด) — ใช้แทน device ได้
   * - polled driver: อ่านจาก device จริง (driver.readTag)
   * - push driver  : (mqtt/serial) ไม่มี read ตรง ๆ — ใช้ค่าล่าสุดใน buffer
   * เป็นส่วน "device → data read → return tag set" ของทั้ง read side และ write side
   */
  async _readSource(device, tag, driver) {
    const key = `${device.id}:${tag.id}`;
    if (this._isSim(device, tag)) {
      // sim: อ่านจาก buffer data (หน่วยความจำจำลอง) — แทน driver.readTag ของ device จริง
      return { value: this._simRead(device, tag), quality: 'good' };
    }
    if (driver && typeof driver.readTag === 'function') {
      const v = await driver.readTag(tag);
      return { value: v, quality: (v !== null && v !== undefined) ? 'good' : 'bad' };
    }
    // push-based (mqtt/serial) — ค่าล่าสุดถูก push เข้า buffer แล้ว
    const cur = this.tagValues.get(key);
    return cur ? { value: cur.value, quality: cur.quality } : { value: null, quality: 'unknown' };
  }

  /**
   * WRITE SIDE pipeline:
   *   write data → tag set → device → data read → device → return tag set
   * 1) เขียนลง buffer ก่อน (optimistic) ให้ UI/script เห็นทันที
   * 2) ส่งค่าลง device จริง (sim = ข้าม เพราะ buffer คือความจริงอยู่แล้ว)
   * 3) อ่านกลับจาก device มายืนยัน แล้วอัปเดต buffer ด้วยค่าจริง (sim = อ่าน buffer คืนค่าเดิม)
   */
  async writeTag(deviceRef, tagRef, value) {
    const device = this._findDevice(deviceRef);
    if (!device) throw new Error(`Device not found: ${deviceRef}`);
    const tag = this._findTag(device, tagRef);
    if (!tag) throw new Error(`Tag not found: ${tagRef}`);
    const deviceId = device.id, tagId = tag.id;

    // MULTI_BIT = read-only (อ่านกลุ่ม bit → decimal) — ห้ามเขียน · gate จุดเดียวครอบทุก driver (MC/FINS/Modbus parity)
    if (String(tag.dataType || '').toUpperCase() === 'MULTI_BIT') {
      throw new Error(`MULTI_BIT เป็น read-only (อ่านอย่างเดียว) — เขียนไม่ได้: ${tagRef}`);
    }

    const sim    = this._isSim(device, tag);
    const driver = this.drivers.get(deviceId);

    // fail fast สำหรับ device จริงที่เขียนไม่ได้ (ไม่ทำให้ buffer เพี้ยน)
    if (!sim) {
      if (!driver || !driver.connected) throw new Error(`Device not connected: ${deviceId}`);
      if (typeof driver.writeTag !== 'function') {
        throw new Error(`Write not supported for device type: ${device.type}`);
      }
    }

    // 1) write data → tag set (optimistic)
    this._setTagValue(deviceId, tagId, value, 'good');

    // 2) tag set → (buffer data) [sim] / → device [real]
    if (sim) this._simWrite(device, tag, value);
    else     await driver.writeTag(tag, value);

    // 3) (buffer data | device) read → return tag set (ยืนยันด้วยค่าจริง; อ่านไม่ได้ → คงค่า optimistic)
    const { value: rb, quality } = await this._readSource(device, tag, driver);
    if (rb !== null && rb !== undefined) {
      this._setTagValue(deviceId, tagId, rb, quality);
    }
    return { value: rb, simulated: sim };
  }

  /**
   * setTagValue — ตั้งค่า tag ตรง ๆ ในหน่วยความจำ (ใช้โดย script)
   * ใช้ได้กับทุก tag (virtual = พักข้อมูล, physical = override ค่าชั่วคราว)
   */
  setTagValue(deviceRef, tagRef, value, quality = 'good') {
    const device = this._findDevice(deviceRef);
    if (!device) throw new Error(`Device not found: ${deviceRef}`);
    const tag = this._findTag(device, tagRef);
    if (!tag) throw new Error(`Tag not found: ${tagRef}`);
    // sim tag → เขียนลง buffer data ด้วย (buffer data คือความจริงของ sim)
    if (this._isSim(device, tag)) this._simWrite(device, tag, value);
    this._setTagValue(device.id, tag.id, value, quality);
  }

  getDevices() {
    return this.allDevices;
  }

  // ── Device connection update ──────────────────────────────────────────────
  updateDevice(deviceId, updates) {
    const device = this.allDevices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);
    if (device.managed) throw new Error(`"${deviceId}" เป็น device ระบบ (read-only) — แก้ไขไม่ได้`);

    if (updates.name)       device.name       = updates.name;
    if (updates.enabled !== undefined) device.enabled = updates.enabled;
    if (updates.simulate !== undefined) device.simulate = updates.simulate;
    if (updates.connection) {
      device.connection = { ...device.connection, ...updates.connection };
    }
    if (updates.pollInterval) device.pollInterval = updates.pollInterval;
    if (updates.autoProbe !== undefined) device.autoProbe = updates.autoProbe;
    if (updates.shareStatus !== undefined) device.shareStatus = updates.shareStatus;   // แชร์ __online/__enabled เข้า KPENETWORK

    this.saveConfig();

    // เปลี่ยนเฉพาะ field ที่ "ไม่กระทบ driver" (เช่น shareStatus/name) → ไม่ต้อง reconnect (กัน device หลุดแวบ/__online กระพริบ)
    const needReinit = updates.connection !== undefined || updates.enabled !== undefined
      || updates.pollInterval !== undefined || updates.autoProbe !== undefined || updates.simulate !== undefined;
    if (!needReinit) return device;

    // แก้ค่าที่กระทบ driver → reset probe state (ให้ลองใหม่ตามค่าที่เพิ่งตั้ง)
    device._probeDone = false; device._lastProbe = 0; device._lastGoodRead = 0;

    // Reconnect driver with new settings if device is active
    const driver = this.drivers.get(deviceId);
    if (driver) {
      try { driver.disconnect(); } catch (_) {}
      this.drivers.delete(deviceId);
    }
    // Clear old poll interval
    const oldInterval = this.intervals.get(deviceId);
    if (oldInterval) { clearInterval(oldInterval); this.intervals.delete(deviceId); }

    if (device.enabled !== false) {
      // Re-init (จะเข้าโหมด simulate ถ้า device.simulate = true)
      this._initDevice(device);
    }

    return device;
  }

  // ── Add / Remove device ───────────────────────────────────────────────────
  addDevice(device) {
    if (!device.id)   throw new Error('device.id is required');
    if (!device.type) throw new Error('device.type is required');
    if (this.allDevices.find(d => d.id === device.id)) {
      throw new Error(`Device ID "${device.id}" already exists`);
    }
    const newDevice = {
      id:           device.id,
      name:         device.name || device.id,
      type:         device.type,
      enabled:      device.enabled ?? false,
      connection:   device.connection || {},
      pollInterval: device.pollInterval || 1000,
      tags:         [],
    };
    this.allDevices.push(newDevice);
    this.saveConfig();
    if (newDevice.enabled) this._initDevice(newDevice);
    return newDevice;
  }

  removeDevice(deviceId) {
    const idx = this.allDevices.findIndex(d => d.id === deviceId);
    if (idx === -1) throw new Error(`Device not found: ${deviceId}`);
    if (this.allDevices[idx].managed) throw new Error(`"${deviceId}" เป็น device ระบบ (read-only) — ลบไม่ได้`);

    // Stop polling & disconnect driver
    const interval = this.intervals.get(deviceId);
    if (interval) { clearInterval(interval); this.intervals.delete(deviceId); }
    const driver = this.drivers.get(deviceId);
    if (driver) { try { driver.disconnect(); } catch (_) {} this.drivers.delete(deviceId); }

    // Remove cached tag values
    const device = this.allDevices[idx];
    for (const tag of device.tags) {
      this.tagValues.delete(`${deviceId}:${tag.id}`);
      this.simStore.delete(`${deviceId}:${tag.id}`);
    }

    this.allDevices.splice(idx, 1);
    this.saveConfig();
  }

  // ── Bulk import (migration ย้ายเครื่อง) — mode: 'device'|'tags'|'full' · overwrite=true (ทับ) | false (เพิ่มเฉพาะใหม่) ──
  importBundle(devices, mode = 'full', overwrite = true) {
    if (!Array.isArray(devices)) throw new Error('devices ต้องเป็น array');
    const changed = new Set();
    let dAdd = 0, dUpd = 0, tAdd = 0, tUpd = 0, skip = 0;
    for (const inc of devices) {
      if (!inc || !inc.id) continue;
      if (this._isManaged(inc.id)) { skip++; continue; }   // managed = ระบบสร้าง ข้าม
      let dev = this.allDevices.find((d) => d.id === inc.id);
      if (!dev) {
        if (mode === 'tags') { skip++; continue; }          // import tag ต้องมี device ก่อน
        dev = { id: inc.id, name: inc.name || inc.id, type: inc.type, enabled: inc.enabled ?? false,
          connection: inc.connection || {}, pollInterval: inc.pollInterval || 1000, tags: [] };
        if (inc.autoProbe !== undefined) dev.autoProbe = inc.autoProbe;
        if (inc.shareStatus !== undefined) dev.shareStatus = inc.shareStatus;
        this.allDevices.push(dev); dAdd++; changed.add(dev.id);
      } else if (mode !== 'tags' && overwrite) {            // มีอยู่แล้ว + ทับ → อัปเดต shell · migration(!overwrite) = ไม่แตะ
        if (inc.name != null) dev.name = inc.name;
        if (inc.type != null) dev.type = inc.type;
        if (inc.enabled !== undefined) dev.enabled = inc.enabled;
        if (inc.connection) dev.connection = { ...dev.connection, ...inc.connection };
        if (inc.pollInterval != null) dev.pollInterval = inc.pollInterval;
        if (inc.autoProbe !== undefined) dev.autoProbe = inc.autoProbe;
        if (inc.shareStatus !== undefined) dev.shareStatus = inc.shareStatus;
        dUpd++; changed.add(dev.id);
      } else if (mode !== 'tags') {
        skip++;
      }
      if (mode !== 'device' && Array.isArray(inc.tags)) {   // นำเข้า tag (by id) · overwrite=ทับ · false=เพิ่มเฉพาะใหม่
        dev.tags = dev.tags || [];
        for (const t of inc.tags) {
          if (!t || !t.id) continue;
          const ex = dev.tags.find((x) => x.id === t.id);
          if (ex) { if (overwrite) { Object.assign(ex, t); tUpd++; changed.add(dev.id); } else { skip++; } }
          else { dev.tags.push({ ...t }); tAdd++; changed.add(dev.id); }
        }
      }
    }
    this.saveConfig();
    for (const id of changed) {   // reinit device ที่เปลี่ยน+enabled (ให้ driver/poll เห็น config+tag ใหม่)
      const dev = this.allDevices.find((d) => d.id === id);
      if (!dev || dev.enabled === false) continue;
      try { const drv = this.drivers.get(id); if (drv) { drv.disconnect(); this.drivers.delete(id); } } catch (_) {}
      const iv = this.intervals.get(id); if (iv) { clearInterval(iv); this.intervals.delete(id); }
      try { this._initDevice(dev); } catch (_) {}
    }
    return { dAdd, dUpd, tAdd, tUpd, skip };
  }

  // ── Tag CRUD ──────────────────────────────────────────────────────────────

  /** เพิ่ม tag ใหม่เข้า device */
  // ── Managed (system) devices — สร้างโดยระบบ (เช่น CHEMstock status) ───────────────
  //   read-only (ห้ามแก้/ลบผ่าน UI · guard ด้านล่าง) · ไม่ persist ลง devices.json (saveConfig filter) ·
  //   idempotent (เรียกซ้ำได้ทุก tick → รอด reload ที่ล้าง allDevices)
  _isManaged(deviceId) { const d = this.allDevices.find(x => x.id === deviceId); return !!(d && d.managed); }
  registerManagedDevice(def) {
    let d = this.allDevices.find(x => x.id === def.id);
    if (!d) {
      d = { id: def.id, name: def.name || def.id, type: def.type || 'virtual', enabled: true, managed: true, connection: {}, pollInterval: 0, tags: [] };
      this.allDevices.push(d);
    } else { d.managed = true; d.enabled = true; if (def.name) d.name = def.name; }
    for (const t of (def.tags || [])) {
      let tg = d.tags.find(x => x.id === t.id);
      if (!tg) d.tags.push({ id: t.id, name: t.name || t.id, unit: t.unit || '', dataType: t.dataType || 'INT', defaultValue: t.defaultValue != null ? t.defaultValue : 0, logActivity: false, shared: false, shareWritable: false, relayAllowed: false, group: t.group || '' });
      else { tg.name = t.name || tg.name; tg.dataType = t.dataType || tg.dataType; tg.unit = t.unit || ''; tg.group = t.group || ''; }
    }
    return d;
  }
  unregisterManagedDevice(id) {
    const i = this.allDevices.findIndex(d => d.id === id && d.managed);
    if (i === -1) return;
    for (const t of (this.allDevices[i].tags || [])) { this.tagValues.delete(`${id}:${t.id}`); this.simStore.delete(`${id}:${t.id}`); }
    this.allDevices.splice(i, 1);
  }

  addTag(deviceId, tag) {
    const device = this.allDevices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);
    if (device.managed) throw new Error(`"${deviceId}" เป็น device ระบบ (read-only) — เพิ่ม/แก้/ลบ tag ไม่ได้`);
    if (device.tags.find(t => t.id === tag.id)) {
      throw new Error(`Tag ID "${tag.id}" already exists in ${deviceId}`);
    }
    device.tags.push(tag);
    // virtual / simulated tag — seed buffer data แล้ว sync → tag set
    if (device.type === 'virtual' || tag.simulate) {
      this._simWrite(device, tag, this._simSeed(tag));
      this._syncSimToTag(device, tag);
    }
    this.saveConfig();
    return tag;
  }

  /** แก้ไข tag */
  updateTag(deviceId, tagId, updates) {
    const device = this.allDevices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);
    if (device.managed) throw new Error(`"${deviceId}" เป็น device ระบบ (read-only) — แก้ไข tag ไม่ได้`);
    const idx = device.tags.findIndex(t => t.id === tagId);
    if (idx === -1) throw new Error(`Tag not found: ${tagId}`);
    // ถ้า id เปลี่ยน ต้องตรวจว่าไม่ซ้ำ
    if (updates.id && updates.id !== tagId && device.tags.find(t => t.id === updates.id)) {
      throw new Error(`Tag ID "${updates.id}" already exists`);
    }
    const merged = { ...device.tags[idx], ...updates };
    device.tags[idx] = merged;
    // ล้าง cache + buffer data ถ้า id เปลี่ยน
    if (updates.id && updates.id !== tagId) {
      this.tagValues.delete(`${deviceId}:${tagId}`);
      this.simStore.delete(`${deviceId}:${tagId}`);
    }
    if (merged.simulate) {
      // เปิด/แก้ sim → set buffer data ตาม simValue แล้ว sync → tag set
      this._simWrite(device, merged, merged.simValue !== undefined ? merged.simValue : 0);
      this._syncSimToTag(device, merged);
    } else if (device.type !== 'virtual') {
      // ปิด simulate → ทิ้ง buffer data, เคลียร์ค่าเป็น null จนกว่าจะอ่านค่าจริงได้
      this.simStore.delete(`${deviceId}:${merged.id}`);
      this._setTagValue(deviceId, merged.id, null, 'unknown');
    }
    this.saveConfig();
    return merged;
  }

  /** ลบ tag */
  removeTag(deviceId, tagId) {
    const device = this.allDevices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);
    if (device.managed) throw new Error(`"${deviceId}" เป็น device ระบบ (read-only) — ลบ tag ไม่ได้`);
    const before = device.tags.length;
    device.tags = device.tags.filter(t => t.id !== tagId);
    if (device.tags.length === before) throw new Error(`Tag not found: ${tagId}`);
    this.tagValues.delete(`${deviceId}:${tagId}`);
    this.simStore.delete(`${deviceId}:${tagId}`);
    this.saveConfig();
  }

  /** เปลี่ยนชื่อ/ลบ group ของ tag ภายใน device แบบ atomic
   *  from = ชื่อกลุ่มเดิม (ว่าง = tag ที่ลอย) · to = ชื่อใหม่ (ว่าง = ลบกลุ่ม → tag ลอย)
   *  คืนจำนวน tag ที่เปลี่ยน */
  renameTagGroup(deviceId, from, to) {
    const device = this.allDevices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);
    const f = String(from == null ? '' : from).trim();
    const t = String(to == null ? '' : to).trim();
    if (f === t) return 0;
    let n = 0;
    for (const tag of device.tags) {
      if (String(tag.group || '').trim() === f) {
        if (t) tag.group = t; else delete tag.group;   // ว่าง = ลบ field → ลอย
        n++;
      }
    }
    if (n > 0) this.saveConfig();
    return n;
  }

  /** ดึง tag ทั้งหมดแบบ flat list พร้อม device info */
  getAllTags() {
    const list = [];
    for (const device of this.allDevices) {
      const driver = this.drivers.get(device.id);
      // tag พิเศษ (read-only, bool 0/1)
      for (const st of SPECIAL_TAGS) {
        list.push({
          deviceId: device.id, deviceName: device.name, deviceType: device.type,
          connected: this._deviceConnected(device),
          id: st.id, name: st.name, dataType: 'bool', special: true,
          ...(this.tagValues.get(`${device.id}:${st.id}`)
              || { value: this._specialTagValue(device, st.id), quality: 'good', timestamp: Date.now() }),
        });
      }
      for (const tag of device.tags) {
        const v = this.tagValues.get(`${device.id}:${tag.id}`);
        list.push({
          deviceId:   device.id,
          deviceName: device.name,
          deviceType: device.type,
          connected:  driver ? driver.connected : false,
          ...tag,
          ...(v || { value: null, quality: 'unknown', timestamp: null }),
        });
      }
    }
    return list;
  }

  stop() {
    if (this.statusSweep) clearInterval(this.statusSweep);
    for (const [id, interval] of this.intervals) clearInterval(interval);
    for (const [id, driver] of this.drivers) {
      try { driver.disconnect(); } catch (_) {}
    }
  }
}

module.exports = TagEngine;
