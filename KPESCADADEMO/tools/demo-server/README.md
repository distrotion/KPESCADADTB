# demo server — ให้ user ลองเล่น KPE SCADA หลายชุดบนเครื่องเดียว

1 tenant = 1 ชุด process แยกสนิท (backend + frontend + **PLC simulator ของตัวเอง**)
ใช้โค้ดชุดเดียวกันทุก tenant ไม่ต้อง build ใหม่ ไม่ต้องแก้ repo

แยกกันด้วย:
- `KPE_DATA_DIR` — config/layout/datalog/data คนละโฟลเดอร์ (`~/kpe-demo/<tenant>/`)
- พอร์ตคนละชุดต่อ slot — `ports.js` อ่าน env override อยู่แล้ว (ไม่ต้องแก้ `ports.json`)

| service | พอร์ต (slot N) | ตัวอย่าง slot 1 |
|---|---|---|
| frontend (พอร์ตสาธารณะ) | 3100+N | 3101 |
| backend | 4100+N | 4101 |
| manager | 5100+N | 5101 |
| deploy | 9100+N | 9101 |
| PLC simulator | 6100+N | 6101 |

## ใช้งาน

```bash
./demo.sh create acme      # สร้าง + start (จองพอร์ต, seed config, ยิง simulator)
./demo.sh list             # ดูทั้งหมด + สถานะ + URL
./demo.sh stop acme
./demo.sh start acme
./demo.sh reset acme       # ล้างกลับเป็น seed (ใช้ตอน demo รอบใหม่)
./demo.sh remove acme      # ลบถาวร
./demo.sh start-all | stop-all
./demo.sh proxy            # พิมพ์ config nginx ของทุก tenant
```

data อยู่ที่ `~/kpe-demo/` (เปลี่ยนได้ด้วย env `DEMO_BASE`) · log/pid ที่ `~/kpe-demo/_run/`

## 🔴 2 ข้อที่ต้องรู้ก่อนขึ้น server จริง

**1. ต้อง clone จาก source repo (KPESCADASW) ไม่ใช่ KPESCADADTB**
`sync-dtb.sh` ตัด `/tools` ออกจาก package ลูกค้า **โดยตั้งใจ** — ลูกค้าจริงไม่ควรได้ PLC simulator
ทั้ง `demo.sh` และ `plc-virtual.js` อยู่ใต้ `tools/` จึงมาด้วยกันเมื่อ clone source
(script เช็คให้แล้ว ถ้าไม่เจอ simulator จะ error บอกทันที)
**ห้ามแก้ `sync-dtb.sh` ให้ส่ง simulator ไปลูกค้า**

**2. license instance-lock — ต้องใช้ build ที่ "ยังไม่ arm"**
`licenseManager.js` มี `acquireInstanceLock()`: **1 ใบ license = 1 backend instance ต่อเครื่อง**
ถ้าเอา armed build (ฝัง pubkey) มารันหลาย tenant บนเครื่องเดียว → instance ที่ 2 จะโดนบล็อก
`license-in-use` ทันที

demo server จึงต้องเป็น build ที่ยังไม่ arm (`_publicKeyB64` ว่าง) แล้ว `KPE_DEV=1` (script ตั้งให้แล้ว)
จะปิด enforce ได้ — armed build **ไม่ฟัง** `KPE_DEV` (ตั้งใจกันลูกค้า bypass)

ทางเลือกอื่นถ้าไม่อยากใช้ unarmed build: ออก license ต่อ tenant หรือแยก container/เครื่องต่อ tenant

## ขึ้น server (Linux)

```bash
git clone <KPESCADASW> /opt/kpe-scada && cd /opt/kpe-scada
cd backend && npm ci --omit=dev && cd ../frontend && npm ci --omit=dev && cd ..
./tools/demo-server/demo.sh create demo1
./tools/demo-server/demo.sh proxy > /etc/nginx/conf.d/kpe-demo.conf   # แก้โดเมนก่อน
nginx -s reload
```

frontend build (`frontend/build/web/`) ต้องมีอยู่แล้วใน repo — ถ้าไม่มีให้
`cd frontend && flutter build web --no-web-resources-cdn`

TLS ทำที่ชั้น nginx (proxy ต้องส่ง `Upgrade`/`Connection` ผ่านให้ WebSocket ของ realtime tag ทำงาน —
config ที่ `./demo.sh proxy` พิมพ์ออกมาใส่ให้แล้ว)

## seed ที่ tenant ใหม่ได้

`seed/devices.json` — device `DEMO01` (mc_protocol) ชี้ไป PLC simulator ของ tenant นั้น
พร้อม tag ตัวอย่าง 6 ตัว (temp/pressure/level/speed/counter/recipe)
`seed/alarms.json` — alarm ตัวอย่าง 1 ตัว · `seed/databases.json` — ว่าง

แก้ seed ได้ตามต้องการ — มีผลกับ tenant ที่ `create`/`reset` หลังจากนั้น
