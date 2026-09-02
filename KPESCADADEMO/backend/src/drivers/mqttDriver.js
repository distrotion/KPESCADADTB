const mqtt = require('mqtt');

// แกะ jsonPath "a.b.0.c" จาก object (nested + array index) · คืน undefined ถ้าไม่เจอ
function _dig(obj, pathStr) {
  if (obj == null) return undefined;
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

class MqttDriver {
  constructor(device, onTagUpdate) {
    this.device = device;
    this.onTagUpdate = onTagUpdate;
    this.client = null;
    this.connected = false;
    this.values = {};
    // build topic → [tags] map — 1 topic แชร์หลาย tag ได้ (แต่ละตัวแกะด้วย jsonPath ของตัวเอง)
    //   เคส vision: person_id/name/conf topic เดียวกัน (tpk/vision/face/gate1) ต่างกันที่ jsonPath
    this.topicMap = {};
    for (const tag of (device.tags || [])) {
      const t = tag.topic;
      if (!t) continue;                                  // ไม่มี topic = ข้าม (กัน topicMap[undefined])
      (this.topicMap[t] = this.topicMap[t] || []).push(tag);
    }
  }

  async connect() {
    return new Promise((resolve) => {
      const { broker, clientId, username, password } = this.device.connection;
      const opts = { clientId: clientId || 'kpe-scada-' + Date.now() };
      if (username) { opts.username = username; opts.password = password; }

      this.client = mqtt.connect(broker, opts);

      this.client.on('connect', () => {
        this.connected = true;
        console.log(`[MQTT] Connected: ${this.device.name}`);
        for (const topic of Object.keys(this.topicMap)) {
          const qos = Math.max(0, ...this.topicMap[topic].map((t) => Number(t.qos) || 0));   // qos สูงสุดของ tag ใน topic นั้น
          this.client.subscribe(topic, { qos });
        }
        resolve(true);
      });

      this.client.on('error', (err) => {
        console.error(`[MQTT] Error (${this.device.name}):`, err.message);
        this.connected = false;
        resolve(false);
      });

      this.client.on('message', (topic, message) => this._handleMessage(topic, message));

      setTimeout(() => { if (!this.connected) resolve(false); }, 5000);
    });
  }

  // 1 message → กระจายให้ทุก tag ใน topic นั้น (แต่ละตัวแกะ jsonPath ของตัวเอง) · parse JSON ครั้งเดียว
  _handleMessage(topic, message) {
    const tags = this.topicMap[topic];
    if (!tags || !tags.length) return;
    const str = message.toString();
    let obj = null, parsed = false;
    for (const tag of tags) {
      try {
        let val;
        if (tag.jsonPath) {
          if (!parsed) { try { obj = JSON.parse(str); } catch (_) { obj = null; } parsed = true; }
          if (obj == null) continue;
          val = _dig(obj, tag.jsonPath);            // nested "a.b.c" + array "a.0"
        } else if (tag.text === true) {
          val = str;                                // text tag = string ดิบ (ชื่อ/ข้อความ)
        } else {
          val = parseFloat(str);
          if (Number.isNaN(val)) continue;
        }
        if (val === undefined) continue;
        this.values[tag.id] = val;
        if (this.onTagUpdate) this.onTagUpdate(this.device.id, tag.id, val);
      } catch (_) {}
    }
  }

  async publish(topic, payload) {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(payload), {}, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  // เขียนค่ากลับไป MQTT — publish ไป topic (writeTopic ถ้ามี ไม่งั้นใช้ topic เดิม)
  // ถ้า tag มี jsonPath → ห่อเป็น { [jsonPath]: value }, ไม่งั้นส่งค่าตรง ๆ เป็น string
  async writeTag(tag, value) {
    if (!this.connected) throw new Error('Not connected');
    const topic = tag.writeTopic || tag.topic;
    if (!topic) throw new Error(`MQTT tag "${tag.id}" has no topic to write to`);
    const raw = tag.jsonPath
      ? JSON.stringify({ [tag.jsonPath]: value })
      : String(value);
    return new Promise((resolve, reject) => {
      this.client.publish(topic, raw, { qos: tag.qos || 0, retain: !!tag.retain }, (err) => {
        if (err) reject(err);
        else { this.values[tag.id] = value; resolve(); }
      });
    });
  }

  getValue(tagId) {
    return this.values[tagId] ?? null;
  }

  disconnect() {
    if (this.client) { try { this.client.end(); } catch (_) {} }
    this.connected = false;
  }
}

module.exports = MqttDriver;
