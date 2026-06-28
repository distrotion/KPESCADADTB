const mqtt = require('mqtt');

class MqttDriver {
  constructor(device, onTagUpdate) {
    this.device = device;
    this.onTagUpdate = onTagUpdate;
    this.client = null;
    this.connected = false;
    this.values = {};
    // build topic → tag map
    this.topicMap = {};
    for (const tag of device.tags) {
      this.topicMap[tag.topic] = tag;
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
          this.client.subscribe(topic);
        }
        resolve(true);
      });

      this.client.on('error', (err) => {
        console.error(`[MQTT] Error (${this.device.name}):`, err.message);
        this.connected = false;
        resolve(false);
      });

      this.client.on('message', (topic, message) => {
        const tag = this.topicMap[topic];
        if (!tag) return;
        try {
          let val;
          const str = message.toString();
          if (tag.jsonPath) {
            const obj = JSON.parse(str);
            val = obj[tag.jsonPath];
          } else {
            val = parseFloat(str);
          }
          this.values[tag.id] = val;
          if (this.onTagUpdate) this.onTagUpdate(this.device.id, tag.id, val);
        } catch (_) {}
      });

      setTimeout(() => { if (!this.connected) resolve(false); }, 5000);
    });
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
