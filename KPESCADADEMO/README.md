# KPESCADADEMO — demo server ของ KPE SCADA

repo นี้คือ **ชุด build สำเร็จสำหรับตั้ง demo server** ให้ลูกค้า/ผู้สนใจลองเล่น KPE SCADA
แบบหลายคนพร้อมกัน (multi-tenant) โดยไม่ต้องมี PLC จริง — มี PLC simulator + ตัวป้อนข้อมูล
Line Recorder มาให้ครบ เปิดมาเห็น dashboard มีชีวิตทันที (4 หน้า: LIVE / PACKAGING /
CHEM LINE / REPORT)

> ⚠️ ห้ามเอา repo นี้ไปให้ลูกค้าใช้งานจริง — เป็น build ที่ **ไม่ arm license** (KPE_DEV=1)
> และมี PLC simulator ซึ่งตัดออกจาก package ลูกค้า (KPESCADADTB) โดยตั้งใจ
> ห้ามใส่ license key / config / ข้อมูลลูกค้าจริงลง repo นี้เด็ดขาด

## ติดตั้ง (ครั้งแรก)

ต้องมี: node ≥ 20, python3

**ไม่มี .env / ไม่ต้องตั้ง config ใด ๆ** — demo ตั้งใจให้ clone แล้วรันได้เลย
ค่าที่ระบบต้องใช้ (โฟลเดอร์ข้อมูล/พอร์ต/โหมด dev) `demo.sh` ส่งเป็น env var ให้ตอน start เอง

```bash
git clone https://github.com/distrotion/KPESCADADEMO.git
cd KPESCADADEMO/backend && npm install --omit=dev
```

## ใช้งาน

```bash
cd tools/demo-server
./demo.sh create acme          # สร้าง tenant แรก → http://localhost:3101
./demo.sh create bettercorp    # tenant ถัดไป → :3102 (แยก data/พอร์ตกันสนิท)
./demo.sh list                 # ดูทั้งหมด + สถานะ
./demo.sh scheduler-start      # เปิดรีเซ็ตอัตโนมัติทุกเที่ยงคืน (กลับ golden state)
./demo.sh proxy                # พิมพ์ config nginx สำหรับตั้ง subdomain ต่อ tenant
./demo.sh backup               # เก็บ golden state ไว้ที่ ~/kpe-demo/_backup
```

1 tenant = 4 process แยกกันสนิท: virtual PLC + backend + frontend + ตัวป้อน Line Recorder
ข้อมูลอยู่ที่ `~/kpe-demo/<tenant>` (นอก repo — `git pull` อัปเวอร์ชันได้โดยไม่แตะข้อมูล demo)

## รีเซ็ตเที่ยงคืนบน Linux server (แนะนำ cron แทน scheduler)

```
0 0 * * * /path/to/KPESCADADEMO/tools/demo-server/demo.sh nightly >> ~/kpe-demo/_run/nightly.log 2>&1
```

(บน Mac เครื่อง dev ใช้ `./demo.sh scheduler-start` แทน — LaunchAgent ติด TCC อ่าน ~/Desktop ไม่ได้)

## อัปเดต demo server

```bash
git pull                                   # รับ build ใหม่
cd tools/demo-server && ./demo.sh nightly  # รีเซ็ต tenant ให้ใช้ seed/โค้ดชุดใหม่
```


## ขึ้นออนไลน์ (แบบเดียวกับ CMS: Cloudflare Pages + Render)

frontend เป็น static ขึ้น **Cloudflare Pages** · backend ขึ้น **Render** — คนละที่ คุยกันข้ามโดเมน
(CORS เปิดอยู่แล้ว · WS แปลงเป็น wss อัตโนมัติ)

**1) backend → Render**
Render → New → Blueprint → เลือก repo นี้ → รับ `tools/demo-server/cloud/render.yaml`
ได้ URL มาเช่น `https://kpe-scada-demo-api.onrender.com`
(1 service = 1 tenant · backend + virtual PLC + ตัวป้อน LR รวมใน process เดียว — ดู `cloud/start-cloud.js`)

**2) frontend → Cloudflare Pages** (ทำที่ repo source KPESCADASW)
```bash
cd frontend
flutter build web --release --no-web-resources-cdn \
  --dart-define=API_BASE=https://kpe-scada-demo-api.onrender.com
npx wrangler login                       # ครั้งแรกครั้งเดียว
npx wrangler pages deploy build/web --project-name=kpe-scada-demo --branch=main
```
ได้ `https://kpe-scada-demo.pages.dev`

**รีเซ็ต demo ทุกเที่ยงคืน (ไทย)**: `start-cloud.js` ตั้งเวลาออกจาก process ตอนเที่ยงคืน →
คลาวด์ start ใหม่ให้เอง → `/tmp` ว่าง → seed ใหม่ = golden state · ไม่ต้องตั้ง cron ที่ไหนเลย
(อย่าพึ่ง ephemeral disk อย่างเดียว — ถ้ามีคนเข้าตลอด service จะไม่หลับ ข้อมูลจะสะสมไปเรื่อย ๆ)
ลงบน VPS/เครื่องตัวเองที่ดิสก์ถาวร → ใช้ `./demo.sh scheduler-start` แทน

⚠️ Render free tier: sleep เมื่อไม่มีคนเข้า ~15 นาที · ตื่นครั้งแรกช้า ~30-60 วิ

## ที่มา

sync มาจาก source repo **KPESCADASW** ด้วย `tools/sync-demo.sh` — แก้โค้ด/seed ที่ KPESCADASW
เท่านั้นแล้ว sync มา (ห้ามแก้ตรงนี้ เดี๋ยวโดน sync ทับ)
