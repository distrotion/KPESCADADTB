/**
 * Script Preset Library — ฟังก์ชันสำเร็จรูปสำหรับใช้ใน Script Engine
 * ════════════════════════════════════════════════════════════════════════════
 * ฟังก์ชันในที่นี้ถูก "แนบ" เข้า context ของ script (ทั้ง worker sandbox และ engine
 * fallback) ผ่าน createPresets(state) — ใช้ source เดียว ไม่ก๊อปสองที่.
 *
 * ทุกฟังก์ชันที่ต้อง "จำค่าข้ามการยิง" (stateful) จะเก็บ state ไว้ใน state.__presets
 * (object เดียวกับที่ main persist ให้ script ข้ามการรัน — JSON-serializable เท่านั้น
 * จึงห้ามเก็บ Infinity/NaN/ฟังก์ชัน; ใช้ null แทนค่าที่ยังไม่มี)
 *
 * คู่มือฉบับเต็ม: docs/SCRIPT-PRESETS.md
 * ════════════════════════════════════════════════════════════════════════════
 */
'use strict';

// slot state ต่อ key ใน state.__presets (สร้างถ้ายังไม่มี)
function slot(state, ns, key) {
  if (!state.__presets || typeof state.__presets !== 'object') state.__presets = {};
  const bag = state.__presets;
  const k = `${ns}:${key}`;
  if (!bag[k] || typeof bag[k] !== 'object') bag[k] = {};
  return bag[k];
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * weighCycle(key, value, opts) — จับ 1 รอบชั่ง (peak-hold)
 *   value ขึ้นเหนือ startOffset → เริ่มชั่ง (จับ peak/valley) → ตกลงถึง/ต่ำกว่า
 *   endOffset → จบรอบ (คายผล) แล้ววนรอรอบใหม่.
 *
 *   opts: { startOffset=0, endOffset=0, minPeak=null, gate=true }
 *     startOffset  ค่าที่ต้อง "ขึ้นเกิน" ถึงเริ่มนับ (0 หรือต่ำกว่าได้ · ติดลบได้)
 *     endOffset    ค่าที่ต้อง "ตกถึง/ต่ำกว่า" ถึงจบรอบ (แยกจาก start เพื่อ hysteresis)
 *     minPeak      ถ้ากำหนด: รอบที่ peak ไม่ถึงค่านี้ = ทิ้ง (ไม่นับ done · กันรอบปลอม)
 *     gate         boolean "กำลังใส่จริง" (default true = พฤติกรรมเดิม) — คุมเฉพาะ peak/valley
 *                  ไม่คุมการเริ่ม/จบรอบ (รอบยังเริ่ม-จบตามน้ำหนักปกติเสมอ):
 *                  · sample ที่ gate=true → นับเข้า peak/valley  · gate=false → ข้าม
 *                  · ถ้าทั้งรอบ "มี" gate=true บ้าง → peak = max เฉพาะช่วง true (กัน spike ตอนหยิบ)
 *                  · ถ้าทั้งรอบ "ไม่มี" gate=true เลย → peak ยึดแบบเดิม (max ทุก sample · ไม่ทำรอบหาย)
 *
 *   คืน: {
 *     weighing: bool,          กำลังชั่งอยู่มั้ย
 *     peak: number,            peak ที่จับได้ตอนนี้ (0 ตอน idle)
 *     valley: number,          ค่าต่ำสุดระหว่างชั่ง (0 ตอน idle)
 *     done: null | {           ≠ null เฉพาะ "poll ที่จบรอบพอดี" (ขอบขาลง)
 *       peak, valley,
 *       startTs, peakTs, endTs,   (ms epoch)
 *       durationMs,               ยาวทั้งรอบ
 *       riseMs,                   เวลาจากเริ่ม → ถึง peak
 *       fallMs,                   เวลาจาก peak → จบรอบ
 *       count,                    เลขรอบสะสม (เริ่ม 1)
 *     }
 *   }
 */
function weighCycle(state, now, key, value, opts = {}) {
  const st = slot(state, 'weigh', key == null ? '_' : String(key));
  if (typeof st.phase !== 'string') { st.phase = 'armed'; st.count = st.count || 0; }

  const startOffset = num(opts.startOffset) ?? 0;
  const endOffset   = num(opts.endOffset) ?? 0;
  const minPeak     = opts.minPeak == null ? null : num(opts.minPeak);
  const gate        = opts.gate == null ? true : !!opts.gate;

  const v = num(value);
  const idle = () => ({ weighing: false, peak: 0, valley: 0, done: null });
  // peak/valley ที่ "ใช้จริง" = ตัว gate ถ้ามี · ไม่มีเลย fallback เป็นตัว all (แบบเดิม)
  const usePeak    = () => (st.peak    != null ? st.peak    : (st.peakAll   ?? 0));
  const useValley  = () => (st.valley  != null ? st.valley  : (st.valleyAll ?? 0));
  const usePeakTs  = () => (st.peak    != null ? st.peakTs  : st.peakAllTs);
  // NaN/ค่าเพี้ยน → ไม่ขยับ state (guard เงียบ ตาม safe defaults)
  if (v === null) {
    return st.phase === 'weighing'
      ? { weighing: true, peak: usePeak(), valley: useValley(), done: null }
      : idle();
  }

  let done = null;

  if (st.phase === 'weighing') {
    if (v <= endOffset) {                     // ขอบขาลง — จบรอบ (ไม่พับ sample ปิดเข้า peak/valley)
      const startTs = st.startTs ?? now;
      const peakTs = usePeakTs() ?? startTs;
      const peak = usePeak();
      if (minPeak == null || peak >= minPeak) {
        st.count = (st.count || 0) + 1;
        done = {
          peak, valley: useValley(),
          startTs, peakTs, endTs: now,
          durationMs: now - startTs,
          riseMs: peakTs - startTs,
          fallMs: now - peakTs,
          count: st.count,
        };
      }
      st.phase = 'armed';                     // reset → รอรอบใหม่
      st.peak = null; st.valley = null; st.peakTs = null;
      st.peakAll = null; st.valleyAll = null; st.peakAllTs = null; st.startTs = null;
      return { weighing: false, peak: 0, valley: 0, done };
    }
    // all-track (แบบเดิม · ไว้ fallback ถ้าทั้งรอบไม่มี gate=true)
    if (st.peakAll == null || v > st.peakAll) { st.peakAll = v; st.peakAllTs = now; }
    if (st.valleyAll == null || v < st.valleyAll) st.valleyAll = v;
    if (gate) {                               // เก็บ peak/valley "ตัวจริง" เฉพาะช่วง gate=true
      if (st.peak == null || v > st.peak) { st.peak = v; st.peakTs = now; }
      if (st.valley == null || v < st.valley) st.valley = v;
    }
    return { weighing: true, peak: usePeak(), valley: useValley(), done: null };
  }

  // armed — รอค่าขึ้นเหนือ startOffset (เริ่มตามน้ำหนักปกติ · gate ไม่บล็อกการเริ่มรอบ)
  if (v > startOffset) {
    st.phase = 'weighing';
    st.startTs = now;
    st.peakAll = v; st.valleyAll = v; st.peakAllTs = now;     // all เริ่มจับทันที
    if (gate) { st.peak = v; st.valley = v; st.peakTs = now; }  // gated จับเฉพาะถ้า true
    else { st.peak = null; st.valley = null; st.peakTs = null; }
    return { weighing: true, peak: usePeak(), valley: useValley(), done: null };
  }
  return idle();
}

/**
 * recordQueue(key, opts) — คิวบันทึกแบบ retry-until-success (จำข้ามการยิงผ่าน state)
 *   ใช้คู่ IO/buzzer: `busy` = ยังมีของค้าง (เปิดเสียง "กำลังบันทึก") · เขียน DB สำเร็จค่อย
 *   ack() → พอคิวว่าง = ปิดเสียง. DB ล่ม = ไม่ ack → ของค้าง → เสียงดังต่อ + retry รอบหน้าเอง.
 *
 *   opts: { max=1000 }
 *     max   เพดานคิว (กันโตไม่จำกัดตอน DB ล่มนาน) — เกิน = ทิ้งตัวเก่าสุด (drop-oldest)
 *
 *   คืน object (method ปิดทับ state slot — ไม่เก็บ function ลง state · JSON-safe):
 *     push(row)  เพิ่มเข้าคิว → คืนจำนวน "ที่ถูกทิ้งเพราะล้น" (0 = ปกติ)
 *     head       แถวแรกที่รอเขียน (null ถ้าว่าง) — เอาไป INSERT
 *     busy       มีของค้างมั้ย (bool) — ใช้ตรง ๆ กับ REC_BUSY
 *     size       จำนวนที่ค้าง
 *     ack()      เขียนสำเร็จ → เอา head ออก → คืน row ที่เอาออก (null ถ้าว่าง)
 *     clear()    ล้างคิว → คืนจำนวนที่ลบ
 */
function recordQueue(state, key, opts = {}) {
  const st = slot(state, 'rec', key == null ? '_' : String(key));
  if (!Array.isArray(st.items)) st.items = [];
  const items = st.items;
  const max = Math.max(1, num(opts.max) ?? 1000);
  return {
    push(row) {
      items.push(row == null ? {} : row);
      let dropped = 0;
      while (items.length > max) { items.shift(); dropped++; }
      return dropped;
    },
    get head() { return items.length ? items[0] : null; },
    get busy() { return items.length > 0; },
    get size() { return items.length; },
    ack() { return items.length ? items.shift() : null; },
    clear() { const n = items.length; items.length = 0; return n; },
  };
}

// แยก target 'dev/tag' หรือ 'dev.tag' → [dev, tag] (null ถ้าไม่มีตัวคั่นกลาง)
function splitTarget(target) {
  const s = String(target == null ? '' : target);
  const i = s.search(/[/.]/);
  if (i <= 0 || i >= s.length - 1) return null;
  return [s.slice(0, i), s.slice(i + 1)];
}

/**
 * mirrorStatus(deviceId, target, opts) — ส่งสถานะ online ของ device เข้า PLC ให้อัตโนมัติ
 *   อ่าน tag พิเศษ `__online` (หรือ opts.source) ของ deviceId → เขียนเข้า `target` (PLC tag)
 *   เขียน **เฉพาะตอนค่าเปลี่ยน** (กัน PLC โดนยิงทุก poll) · จำค่าที่เขียนล่าสุดผ่าน state
 *   รอบแรกเขียนเสมอ (ตั้งค่าเริ่มต้นให้ PLC) จากนั้นเงียบจนกว่าจะพลิก online↔offline.
 *
 *   target : 'plcDev/plcTag' หรือ 'plcDev.plcTag'
 *   opts   : { source='__online', onVal=1, offVal=0, invert=false, force=false }
 *     source  tag ที่อ่าน (default __online · ใช้ __enabled หรือ tag ปกติก็ได้)
 *     onVal   ค่าที่เขียนเมื่อ online  (default 1)
 *     offVal  ค่าที่เขียนเมื่อ offline (default 0)
 *     invert  สลับ online↔offline ก่อน map
 *     force   เขียนทุกครั้งแม้ค่าไม่เปลี่ยน (default = เขียนเฉพาะตอนเปลี่ยน)
 *   คืน: { online:bool, value, wrote:bool }   (wrote=true เฉพาะรอบที่เขียนจริง)
 */
function mirrorStatus(state, readTag, setTag, deviceId, target, opts = {}) {
  const st = slot(state, 'mirror', `${deviceId}>${target}`);
  const tgt = splitTarget(target);

  const raw = readTag ? readTag(deviceId, opts.source || '__online') : null;
  let online = raw === true || raw === '1' || raw === 'true'
    || (typeof raw === 'number' && raw !== 0);
  if (opts.invert) online = !online;

  const onVal  = opts.onVal  != null ? opts.onVal  : 1;
  const offVal = opts.offVal != null ? opts.offVal : 0;
  const value  = online ? onVal : offVal;

  let wrote = false;
  if (tgt && setTag && (opts.force || st.last !== value)) {
    setTag(tgt[0], tgt[1], value);
    st.last = value;
    wrote = true;
  }
  return { online, value, wrote };
}

/**
 * สร้างชุด preset ผูกกับ state ของ script หนึ่ง ๆ
 *   now = ฟังก์ชันคืน ms epoch (แยกออกมาเพื่อ test แทนเวลาได้ · default = Date.now)
 *   io  = { tag(dev,id)→value, setTag(dev,id,value) } — ให้ preset อ่าน/เขียน tag เองได้
 *         (main ส่งเข้ามาจาก context · ไม่มี = preset ที่ต้อง IO จะไม่เขียน)
 */
function createPresets(state, now, io) {
  const clk = typeof now === 'function' ? now : () => Date.now();
  const st = (state && typeof state === 'object') ? state : {};
  const _io = (io && typeof io === 'object') ? io : {};
  const readTag = typeof _io.tag === 'function' ? _io.tag : null;
  const setTag  = typeof _io.setTag === 'function' ? _io.setTag : null;
  return {
    weighCycle:   (key, value, opts) => weighCycle(st, clk(), key, value, opts),
    recordQueue:  (key, opts) => recordQueue(st, key, opts),
    mirrorStatus: (deviceId, target, opts) => mirrorStatus(st, readTag, setTag, deviceId, target, opts),
  };
}

module.exports = { createPresets, weighCycle, recordQueue, mirrorStatus };
