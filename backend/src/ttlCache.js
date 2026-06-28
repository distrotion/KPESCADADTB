// ttlCache.js — buffer กลางสั้น ๆ (TTL) + request coalescing
//   ใช้กับ read ไป external ที่หลาย client (widget + admin) ยิงซ้ำ ๆ (ARM MSSQL · SAP gateway)
//   → ภายใน TTL คืนค่าที่ buffer ไว้ · request พร้อมกัน (in-flight) รวมเป็นครั้งเดียว → ไม่เปลือง transaction

// ว่าง = null/undefined หรือ array ว่าง (object คืน false — ไม่ถือว่าว่าง เพื่อกัน single-record lookup ติด sticky)
function isEmptyVal(v) { return v == null || (Array.isArray(v) && v.length === 0); }

class TtlCache {
  constructor(defaultTtlMs = 5000) {
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();        // key -> { ts, val }
    this.inflight = new Map();   // key -> Promise (กำลังดึงอยู่ · รวม request พร้อมกัน)
  }
  // คืนค่าจาก buffer ถ้าสด (< ttl) · ไม่งั้นดึงใหม่ (in-flight เดียวกันใช้ร่วม)
  //   opts.stickyNonEmpty=true → ผลที่ดึงมา "ว่าง" แต่ last-good "ไม่ว่าง" จะ "ไม่ทับ" คืน last-good เดิม
  //     (กัน gateway/SQL ตอบ [] ชั่วคราว/ผิดรูปแล้วเคลียร์จอ) · ถือ last-good ตลอดจนกว่าจะได้ของจริง หรือ clear()/invalidate()
  //   opts.isEmpty(v) → กำหนดเองว่า "ว่าง" คืออะไร (default = null/array ว่าง)
  //   opts.force=true → ข้ามค่าใน buffer ที่ยังสด ดึงใหม่ "แล้วเขียนทับ buffer" (hard refresh — client อื่นได้ของสดตาม) · ไม่ใช่ bypass
  async getOrFetch(key, fetchFn, ttlMs, opts = {}) {
    const ttl = Number.isFinite(ttlMs) ? ttlMs : this.defaultTtlMs;
    const sticky = !!opts.stickyNonEmpty;
    const force = !!opts.force;
    const isEmpty = typeof opts.isEmpty === 'function' ? opts.isEmpty : isEmptyVal;
    const hit = this.map.get(key);
    if (!force && hit && ttl > 0 && (Date.now() - hit.ts) < ttl) return hit.val;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = Promise.resolve().then(fetchFn)
      .then((v) => {
        // sticky: ผลว่าง + มี last-good ไม่ว่าง → ไม่ทับ คืนของเดิม (ไม่อัปเดต ts → ยังคงดึงสดเพื่อรอของจริงรอบถัดไป)
        const prev = this.map.get(key);
        if (sticky && isEmpty(v) && prev && !isEmpty(prev.val)) return prev.val;
        this.map.set(key, { ts: Date.now(), val: v }); return v;
      })
      // โหลดภายนอกล้มเหลว → คืน buffer เดิม (last-good) ถ้ามี เพื่อไม่ให้จอ/widget ขาดตอน · ไม่มี buffer = โยน error ตามเดิม
      .catch((e) => { const stale = this.map.get(key); if (stale) return stale.val; throw e; })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
  clear() { this.map.clear(); }   // invalidate ทั้งหมด (เรียกหลังเขียน/ตัด/รับ → flag สดทันที · sticky ก็ถูกล้าง = ยอมรับว่างจริงรอบถัดไป)
}
TtlCache.isEmptyVal = isEmptyVal;
module.exports = TtlCache;
