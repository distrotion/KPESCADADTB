#!/usr/bin/env node
// lr-feeder.js — ป้อนข้อมูล Line Recorder ให้ demo tenant (ข้อมูลมั่วแต่หน้าตาเหมือนจริง)
//   1) backfill: ยิงงานย้อนหลัง ~20 ใบ (CHEM1+CHEM2) ผ่าน POST /api/line-recorder/ingest
//      ให้ Job/history/report มีข้อมูลทันทีที่เปิด demo — ข้าม (idempotent) ถ้ามีงานอยู่แล้ว
//   2) live: เดินไลน์สดต่อเนื่อง — carrier เข้าไลน์ทุก 2-4 นาที ไต่ LOAD→DEGREASE→PLATE→UNLOAD
//      ให้หน้า monitor มีของขยับตลอด
//   ใช้: node lr-feeder.js --backend 4101 [--jobs 20]
//   หมายเหตุ: event ตาม decode ของ CHEM*.json — raw = [eventType, station, carrier, dateKey, enterTs, exitTs]
//             ENTER=1 · STEP=2 · EXIT=9 · station 101-104 (104 = finish)
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('--backend', 4101));
const TOTAL = Number(arg('--jobs', 20));
const BASE = `http://127.0.0.1:${PORT}`;

const LINES = ['CHEM1', 'CHEM2'];
const STATIONS = [101, 102, 103, 104];
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.round(rnd(a, b));

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

// เดินงาน 1 ใบผ่านทุก station — ts เดินหน้าเรื่อย ๆ (ย้อนหลังได้เพื่อ backfill)
async function runJob(line, carrier, dateKey, startTs, dwellMs) {
  let t = startTs;
  for (let i = 0; i < STATIONS.length; i++) {
    const st = STATIONS[i];
    const type = i === 0 ? 1 : (i === STATIONS.length - 1 ? 9 : 2);
    const stageEnd = t + dwellMs();
    await api('POST', '/api/line-recorder/ingest', {
      line, ts: stageEnd, raw: [type, st, carrier, dateKey, t, stageEnd],
    });
    t = stageEnd;
  }
  return t;
}

// เติมค่าที่วัด (thickness/pH) ให้ใบ report มีเนื้อ — actor มั่วจากรายชื่อกลาง
const ACTORS = ['Somchai', 'Wanida', 'Anan'];
async function addMeasures(line, jobKey) {
  await api('POST', `/api/line-recorder/lines/${line}/measure`, {
    jobKey, key: 'thickness', value: +rnd(12, 18).toFixed(1), actor: ACTORS[ri(0, 2)],
  });
  await api('POST', `/api/line-recorder/lines/${line}/measure`, {
    jobKey, key: 'ph', value: +rnd(4.2, 4.8).toFixed(2), actor: ACTORS[ri(0, 2)],
  });
}

async function backfill() {
  const existing = await api('GET', `/api/line-recorder/jobs?limit=200`);
  const n = Array.isArray(existing.jobs) ? existing.jobs.length : 0;
  if (n >= TOTAL * 0.75) { console.log(`[lr-feeder] มีงานอยู่แล้ว ${n} ใบ — ข้าม backfill`); return; }
  console.log(`[lr-feeder] backfill ${TOTAL} ใบย้อนหลัง...`);
  const now = Date.now();
  for (let j = 0; j < TOTAL; j++) {
    const line = LINES[j % LINES.length];
    const carrier = `C${(j % 6) + 1}`;
    // dateKey ไม่ซ้ำต่อใบ (ตัวเลขล้วนแบบ PLC): วินาทีย่อ + ลำดับ
    const dateKey = String(260000 + j * 7 + ri(0, 5));
    const startTs = now - ri(2, 40) * 3600 * 1000;             // กระจายย้อนหลัง 2-40 ชม.
    await runJob(line, carrier, dateKey, startTs, () => ri(6, 14) * 60 * 1000);
  }
  // เติมค่าวัดให้ทุกใบที่เพิ่งสร้าง
  for (const line of LINES) {
    const r = await api('GET', `/api/line-recorder/jobs?line=${line}&limit=100`);
    for (const job of (r.jobs || [])) await addMeasures(line, job.jobKey);
  }
  console.log('[lr-feeder] backfill เสร็จ');
}

// ไลน์เดินสด — ยิงผ่าน POST /snapshot (ไม่ใช่ ingest) เพราะผังบ่อหน้า monitor อ่านจาก
//   CarrierTracker ซึ่งรับข้อมูลทาง snapshot เท่านั้น (stateFor → tracker.snapshotState)
//   ทางนี้ได้ครบทั้งคู่: ผังโชว์ carrier ขยับจริง + tracker สังเคราะห์ ENTER/STEP/EXIT ลง history เอง
//   ผัง 6 ช่อง (ตรงกับ source.positions ใน seed): 1=LOAD 2-3=DEGREASE 4-5=PLATE 6=UNLOAD
const N_POS = 6;
const PLATE_POS = [4, 5];                       // ช่องที่แนบค่า temp (field scope=step ของ station 103)
function makeLineSim(line) {
  return { line, slots: Array(N_POS).fill(0), since: Array(N_POS).fill(0), dwell: Array(N_POS).fill(0) };
}
let identSeq = 100;

async function tickLine(sim) {
  const now = Date.now();
  // ท้าย→หัว: ช่องสุดท้ายครบเวลา = ออกจากไลน์ · ช่องอื่นเลื่อนไปข้างหน้าถ้าว่าง
  for (let i = N_POS - 1; i >= 0; i--) {
    if (!sim.slots[i] || now - sim.since[i] < sim.dwell[i]) continue;
    if (i === N_POS - 1) { sim.slots[i] = 0; continue; }
    if (!sim.slots[i + 1]) {
      // ช่องสุดท้าย (UNLOAD) = ท่ารับออก ไม่ใช่บ่อแช่ — วางแป๊บเดียวแล้วถูกยกออกจากไลน์
      const dwell = (i + 1 === N_POS - 1 ? ri(5, 8) : ri(14, 22)) * 1000;
      sim.slots[i + 1] = sim.slots[i]; sim.since[i + 1] = now; sim.dwell[i + 1] = dwell;
      sim.slots[i] = 0;
    }
  }
  // ช่องแรกว่าง → สุ่มปล่อย carrier ใหม่เข้าไลน์ (~ทุก 10-20 วิ — demo ต้องมีของขยับให้เห็นตลอด)
  if (!sim.slots[0] && Math.random() < 0.45) {
    sim.slots[0] = identSeq++; sim.since[0] = now; sim.dwell[0] = ri(10, 16) * 1000;
  }
  // station ต่อช่อง ต้องแนบมากับ snapshot เอง (tracker ใช้ p.station ตรง ๆ ไม่ resolve จาก config)
  const STATION_BY_POS = ['101', '102', '102', '103', '103', '104'];
  const snapshot = sim.slots.map((identity, i) => ({
    pos: i + 1, station: STATION_BY_POS[i], identity,
    params: identity && PLATE_POS.includes(i + 1) ? { temp: +rnd(55, 65).toFixed(1) } : {},
  }));
  await api('POST', '/api/line-recorder/snapshot', { line: sim.line, snapshot, ts: now });
  // กระจกตำแหน่งจริงของ CHEM1 ลง tag (lr_pos1-6) — หน้า "ไลน์ผลิต" ใช้ widget ผูก tag พวกนี้
  //   แหล่งข้อมูลเดียวกับที่ขับ Line Recorder (sim.slots ก้อนเดียวกัน) จึงตรงกับผัง monitor เสมอ
  if (sim.line === 'CHEM1') {
    for (let i = 0; i < N_POS; i++) {
      api('POST', '/api/write', { deviceId: 'DEMO01', tagId: 'lr_pos' + (i + 1), value: sim.slots[i] % 60000 }).catch(() => {});
    }
  }
}

async function liveLoop() {
  const sims = LINES.map(makeLineSim);
  let lastMeasured = '';
  for (;;) {
    for (const sim of sims) {
      try { await tickLine(sim); } catch (e) { console.error('[lr-feeder] live:', e.message); }
    }
    // งานที่เพิ่งจบ (ใบล่าสุดเปลี่ยน) → เติมค่าวัดให้ใบนั้น
    try {
      const r = await api('GET', '/api/line-recorder/jobs?limit=1');
      const jk = r.jobs && r.jobs[0] && r.jobs[0].jobKey;
      if (jk && jk !== lastMeasured && r.jobs[0].status === 'done') {
        await addMeasures(r.jobs[0].line, jk);
        lastMeasured = jk;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 5000));   // poll ถี่หน่อยให้ demo ขยับต่อเนื่อง
  }
}

(async () => {
  // รอ backend พร้อม (เพิ่ง start พร้อมกัน)
  for (let i = 0; i < 30; i++) {
    try { await api('GET', '/api/health'); break; } catch (_) { await new Promise((r) => setTimeout(r, 1000)); }
  }
  try { await backfill(); } catch (e) { console.error('[lr-feeder] backfill:', e.message); }
  await liveLoop();
})();
