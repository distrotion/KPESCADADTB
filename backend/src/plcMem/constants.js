// plcMem/constants.js — ค่าคงที่ที่ใช้ร่วมกันระหว่าง manager.js/routes.js/writer.js (กัน duplicate/drift)
const AREAS = ['D', 'ZR', 'W', 'R'];
const MAX_ADDR = 0xFFFFFF;   // address 3 byte (mcProtocolDriver.js:366) — เกินนี้ truncate เงียบ

module.exports = { AREAS, MAX_ADDR };
