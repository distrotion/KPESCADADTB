// script id: script_1784522937138 | name: weig01 | enabled: True
// trigger: {"type": "serial", "deviceId": "USB_LOADCELL"}

setTag('DATA', 'HB_TS', String(Date.now()))   // heartbeat: มีเฟรม serial เข้า
// ── weighCycle + gate ─────────────────────────────────────────────────────
// gate=true → นับ sample นั้นเข้า peak · gate=false → ข้าม
// ทั้งรอบมี true → peak = max เฉพาะ true · ไม่มี true เลย → ยึดแบบเดิม (max ทุก sample)
function weighCycleGate(key, value, opts) {
  opts = opts || {};
  const N = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
  if (!state.__wc) state.__wc = {};
  const k = 'wc:' + (key == null ? '_' : key);
  const st = state.__wc[k] || (state.__wc[k] = {});
  if (typeof st.phase !== 'string') { st.phase = 'armed'; st.count = st.count || 0; }

  const startOffset = N(opts.startOffset) != null ? N(opts.startOffset) : 0;
  const endOffset   = N(opts.endOffset)   != null ? N(opts.endOffset)   : 0;
  const minPeak     = opts.minPeak == null ? null : N(opts.minPeak);
  const gate        = opts.gate == null ? true : !!opts.gate;

  const v = N(value);
  const usePeak   = () => (st.peak   != null ? st.peak   : (st.peakAll   != null ? st.peakAll   : 0));
  const useValley = () => (st.valley != null ? st.valley : (st.valleyAll != null ? st.valleyAll : 0));
  const usePeakTs = () => (st.peak   != null ? st.peakTs : st.peakAllTs);
  const idle = () => ({ weighing: false, peak: 0, valley: 0, done: null });

  if (v === null) {
    return st.phase === 'weighing'
      ? { weighing: true, peak: usePeak(), valley: useValley(), done: null } : idle();
  }

  if (st.phase === 'weighing') {
    if (v <= endOffset) {                       // ขาลง → จบรอบ
      const t = now();
      const startTs = st.startTs != null ? st.startTs : t;
      const peakTs  = usePeakTs() != null ? usePeakTs() : startTs;
      const peak = usePeak();
      let done = null;
      if (minPeak == null || peak >= minPeak) {
        st.count = (st.count || 0) + 1;
        done = { peak, valley: useValley(), startTs, peakTs, endTs: t,
          durationMs: t - startTs, riseMs: peakTs - startTs, fallMs: t - peakTs, count: st.count };
      }
      st.phase = 'armed';
      st.peak = null; st.valley = null; st.peakTs = null;
      st.peakAll = null; st.valleyAll = null; st.peakAllTs = null; st.startTs = null;
      return { weighing: false, peak: 0, valley: 0, done };
    }
    const t = now();
    if (st.peakAll == null || v > st.peakAll) { st.peakAll = v; st.peakAllTs = t; }   // all (fallback)
    if (st.valleyAll == null || v < st.valleyAll) st.valleyAll = v;
    if (gate) {                                 // เก็บตัวจริงเฉพาะ gate=true
      if (st.peak == null || v > st.peak) { st.peak = v; st.peakTs = t; }
      if (st.valley == null || v < st.valley) st.valley = v;
    }
    return { weighing: true, peak: usePeak(), valley: useValley(), done: null };
  }

  if (v > startOffset) {                         // armed → เริ่มรอบ (ตามน้ำหนัก · gate ไม่บล็อก)
    const t = now();
    st.phase = 'weighing'; st.startTs = t;
    st.peakAll = v; st.valleyAll = v; st.peakAllTs = t;
    if (gate) { st.peak = v; st.valley = v; st.peakTs = t; }
    else { st.peak = null; st.valley = null; st.peakTs = null; }
    return { weighing: true, peak: usePeak(), valley: useValley(), done: null };
  }
  return idle();
}

// ── weighCycle + gate ─────────────────────────────────────────────────────

// ── แกะน้ำหนักจากเฟรม serial ────────────────────────────────────────────
// รองรับ 2 แบบที่ใช้จริง:
//   JADEVER : "ST,GS    0.00kg"                      (มี ST/US บอกนิ่ง)
//   ตัวใหม่  : "2026-08-06 12:25:20\r\n      0.0 kg"   (2 บรรทัด · ไม่มีตัวบอกนิ่ง)
// ห้ามใช้ match ตัวเลขตัวแรกของทั้งเฟรม — ของตัวใหม่จะได้ปี "2026" และเครื่องหมาย '-'
// ในวันที่จะถูกอ่านเป็นค่าติดลบ
const raw = String(trigger.raw == null ? '' : trigger.raw);
const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
let wline = '';
for (let i = lines.length - 1; i >= 0; i--) { if (/kg/i.test(lines[i])) { wline = lines[i]; break; } }
if (!wline) {                                   // ไม่มีหน่วย kg → ใช้บรรทัดท้ายที่ไม่ใช่วันที่
  const last = lines.length ? lines[lines.length - 1] : '';
  if (!/\d{4}-\d{2}-\d{2}/.test(last)) wline = last;
}
const mw = wline.match(/(-?\d+(?:\.\d+)?)\s*kg/i) || wline.match(/(-?\d+(?:\.\d+)?)/);
if (!mw) return;                                // เฟรมนี้ไม่มีน้ำหนัก (เช่นบรรทัดวันที่) — ข้ามเงียบ ๆ
const input = parseFloat(mw[1]);
if (!Number.isFinite(input)) return;

if (state.lastLogged !== input) { log('น้ำหนัก', input, '|', JSON.stringify(raw)); state.lastLogged = input; }
setTag('DATA', 'READ_RETURN', input);

// gate = นับ sample นั้นเข้า peak ไหม
//   หัวชั่งที่มี ST/US → ใช้ ST (นิ่งจริง)
//   หัวชั่งที่ไม่มี → ใช้ "ค่าซ้ำกับเฟรมก่อนหน้า" แทน (ตอนนิ่งค่าจะซ้ำ ๆ · ตอนกระแทกจะไม่ซ้ำ)
//   ถ้าทั้งรอบไม่มี gate=true เลย weighCycleGate จะถอยไปใช้ max ของทุก sample เอง — ไม่มีทางพลาดรอบ
const hasStMark = /\b(ST|US)\b/.test(raw);
const gate = hasStMark ? /\bST\b/.test(raw) : (state.prevVal === input);
state.prevVal = input;

const w = weighCycleGate('scale1', input, { minPeak: 0, startOffset: 5, endOffset: 2, gate: gate });

// ── sqlite-first: จบรอบ = ลงเครื่องทันที (sent=0) · hb_check เป็นคน drain เข้า MSSQL ──
if (w.done) {
  const codeLot = tag('liquid2', 'Liquid.D31050');
  try {
    await db.query('DATA', 'PRAGMA busy_timeout=3000');
    await db.query('DATA', 'INSERT INTO kubotalog_backup (ts,station,weig,code,sent,record_id) VALUES (?,?,?,?,0,?)',
      [new Date(w.done.endTs).toISOString(), 'LIQUID_AUTO', String(w.done.peak), String(codeLot == null ? '' : codeLot), 'LIQUID_AUTO-' + new Date(w.done.endTs).getTime()]);
    setTag('DATA', 'CONFIRM_RETURN', w.done.peak);
    await writeTag('GPIO', 'SOUND', 1);            // ดังจน hb_check ส่ง MSSQL สำเร็จ
  } catch (e) {                                     // sqlite พังชั่วคราว → พักใน RAM ก่อน
    log('เขียน sqlite ไม่ได้ พักใน RAM:', e.message);
    recordQueue('scale1').push({ ts: w.done.endTs, peak: w.done.peak, code: String(codeLot == null ? '' : codeLot) });
  }
}
// กู้ของที่พักใน RAM (ถ้ามี) กลับลง sqlite
const q = recordQueue('scale1');
if (q.busy) {
  try {
    const r = q.head;
    await db.query('DATA', 'INSERT INTO kubotalog_backup (ts,station,weig,code,sent,record_id) VALUES (?,?,?,?,0,?)',
      [new Date(r.ts).toISOString(), 'LIQUID_AUTO', String(r.peak), String(r.code == null ? '' : r.code), 'LIQUID_AUTO-' + new Date(r.ts).getTime()]);
    q.ack();
  } catch (e) { log('กู้จาก RAM ยังไม่ได้:', e.message); }
}
