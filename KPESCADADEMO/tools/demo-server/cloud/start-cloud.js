#!/usr/bin/env node
// start-cloud.js — entry เดียวสำหรับ demo บนคลาวด์ (Render/Railway/VPS) — 1 tenant ต่อ 1 service
//   คลาวด์ฟรีให้ 1 process/service + พอร์ตเดียวจาก $PORT → รวมทุกอย่างไว้ใน process นี้:
//     1) seed data dir (ถ้ายังว่าง) · 5) ตั้งเวลาออกตอนเที่ยงคืนไทย → คลาวด์ start ใหม่ = รีเซ็ตรายวัน
//     2) virtual PLC (child) — ฟัง 127.0.0.1 ภายใน ไม่เปิดออกเน็ต
//     3) backend (child) — bind $PORT ที่คลาวด์ให้มา = ตัวที่โลกภายนอกเรียกถึง
//     4) lr-feeder (child) — ป้อนงาน Line Recorder ให้ demo มีข้อมูล
//   frontend ไม่อยู่ที่นี่ — static build ขึ้น Cloudflare Pages แล้วชี้กลับมาด้วย --dart-define=API_BASE
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;                                  // tools/demo-server/cloud
const DEMO = path.join(HERE, '..');                      // tools/demo-server
const ROOT = path.join(DEMO, '..', '..');                // repo root
const SEED = path.join(DEMO, 'seed');

const PORT = process.env.PORT || '4000';                 // คลาวด์กำหนดมา (Render ใส่ $PORT ให้)
const VPLC_PORT = process.env.DEMO_VPLC_PORT || '6400';
const DATA = process.env.KPE_DATA_DIR || '/tmp/kpe-demo-data';

// ── 1) seed (idempotent: มี devices.json แล้ว = เคย seed ไปแล้ว ข้าม) ──
function seed() {
  const cfg = path.join(DATA, 'config');
  if (fs.existsSync(path.join(cfg, 'devices.json'))) { console.log('[cloud] มี config อยู่แล้ว — ข้าม seed'); return; }
  fs.mkdirSync(path.join(cfg, 'lines'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'layout'), { recursive: true });
  for (const f of ['databases.json', 'alarms.json', 'scripts.json', 'branding.json']) {
    fs.copyFileSync(path.join(SEED, f), path.join(cfg, f));
  }
  for (const f of fs.readdirSync(path.join(SEED, 'lines'))) {
    fs.copyFileSync(path.join(SEED, 'lines', f), path.join(cfg, 'lines', f));
  }
  fs.copyFileSync(path.join(SEED, 'layout-dashboard.json'), path.join(DATA, 'layout', 'dashboard.json'));
  // devices.json: ชี้ virtual PLC ไปพอร์ตภายในของ service นี้
  const dev = JSON.parse(fs.readFileSync(path.join(SEED, 'devices.json'), 'utf8'));
  dev.devices[0].connection.port = Number(VPLC_PORT);
  fs.writeFileSync(path.join(cfg, 'devices.json'), JSON.stringify(dev, null, 2));
  console.log(`[cloud] seed → ${DATA} (vPLC :${VPLC_PORT})`);
}

// ── 2-4) spawn ลูก ๆ · ลูกตายตัวไหน = ดับทั้ง service ให้คลาวด์ restart ใหม่ทั้งชุด (สถานะสอดคล้องกันเสมอ) ──
const kids = [];
function run(name, file, args, opts = {}) {
  const p = spawn(process.execPath, [file, ...args], { stdio: 'inherit', ...opts });
  p.on('exit', (code) => {
    console.error(`[cloud] ${name} จบ (code ${code}) → ปิด service ให้คลาวด์ restart`);
    for (const k of kids) { if (k !== p) { try { k.kill(); } catch (_) {} } }
    process.exit(code == null ? 1 : code);
  });
  kids.push(p);
  return p;
}

seed();

run('vplc', path.join(ROOT, 'tools', 'plc-virtual.js'),
    ['--port', VPLC_PORT, '--d', '5000', '--zr', '3000', '--seed', 'sparse', '--quiet']);

setTimeout(() => {
  run('backend', path.join(ROOT, 'backend', 'src', 'server.js'), [], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env,
      KPE_DEV: '1',                    // demo = build ที่ยังไม่ arm license
      KPE_DATA_DIR: DATA,
      KPE_BACKEND_PORT: PORT,
      KPE_BACKEND_HOST: '0.0.0.0',     // คลาวด์ต้อง bind ทุก interface ไม่งั้น health check ไม่ผ่าน
    },
  });
  // feeder รอ backend พร้อมก่อน (ตัวมันเองมี retry รอ /api/health อยู่แล้ว)
  setTimeout(() => {
    run('feeder', path.join(DEMO, 'lr-feeder.js'), ['--backend', PORT, '--jobs', '20'], { cwd: DEMO });
  }, 3000);
}, 1500);

// ── รีเซ็ตเที่ยงคืน (Asia/Bangkok) ────────────────────────────────────────────
//   ออกจาก process ตอนเที่ยงคืน → คลาวด์ start ใหม่ให้เอง → /tmp ว่าง → seed ใหม่ = golden state
//   ใช้กลไก restart ของคลาวด์แทนการล้าง/สร้างใหม่เองใน process (ไม่ต้องยุ่งกับ state ที่ลูกถืออยู่)
//   ⚠️ ไม่พึ่ง ephemeral disk อย่างเดียว: ถ้ามีคนเข้าตลอด service จะไม่หลับ → ข้อมูลสะสมไปเรื่อย ๆ
function msToBangkokMidnight() {
  const now = new Date();
  // เวลาไทยตอนนี้ (คำนวณจาก UTC + 7 ชม. — ไทยไม่มี DST จึงคงที่)
  const th = new Date(now.getTime() + 7 * 3600 * 1000);
  const next = new Date(Date.UTC(th.getUTCFullYear(), th.getUTCMonth(), th.getUTCDate() + 1, 0, 0, 0));
  return next.getTime() - th.getTime();
}
const untilMidnight = msToBangkokMidnight();
console.log(`[cloud] รีเซ็ตรอบถัดไปในอีก ${Math.round(untilMidnight / 3600000 * 10) / 10} ชม. (เที่ยงคืนไทย)`);
setTimeout(() => {
  console.log('[cloud] เที่ยงคืน — ออกเพื่อให้คลาวด์ start ใหม่ (กลับ golden state)');
  for (const k of kids) { try { k.kill(); } catch (_) {} }
  process.exit(0);
}, untilMidnight);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { for (const k of kids) { try { k.kill(sig); } catch (_) {} } process.exit(0); });
}
