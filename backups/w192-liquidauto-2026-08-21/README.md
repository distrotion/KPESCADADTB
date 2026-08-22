# W192 (LIQUID_AUTO) — setup + scripts snapshot · 2026-08-21

สำเนาอ่านง่ายของ setup ทั้งเครื่อง ณ วันปิดงานรอบ fix ใหญ่ (sapfmt · barcode history · TRIGER=7 · trigger mirror)
คู่กับ zip import ได้จริง: `../liquidautomaster-172.23.10.32-15192-2026-08-21.zip`

## ในโฟลเดอร์นี้

| ไฟล์ | คืออะไร |
|---|---|
| `scripts/*.js` | สคริปต์ทั้ง 12 ตัว แยกไฟล์ พร้อม header (id · enabled · trigger) |
| `SCRIPTS-INDEX.md` | สารบัญสคริปต์ |
| `devices-tags-full.json` | device + tag ทุกตัว (export mode=full · ตัด managed) |
| `sqlite-setup.sql` | DDL ตาราง sqlite + index + **trigger `trg_realtime_mirror`** — dump จากเครื่องจริง |

## Restore เครื่องใหม่ (ลำดับ)

1. import zip (`liquidautomaster-...-2026-08-21.zip`) ผ่านหน้า Manager → ได้ device/tag/script/layout ครบ
2. activate license ใหม่ (zip ถอด license ออกแล้ว)
3. เช็ค eth0: `192.168.1.15/24` ไม่มี gateway (`ipv4.never-default yes`) — ขา LAN ไป PLC `192.168.1.10:2003`
4. เช็ค `/dev/ttyUSB0` (ระบบชั่งมือเดิม ถ้ายังใช้)
5. **รัน `sqlite-setup.sql` ทั้งไฟล์** บน conn `DATA` — ตาราง + index + trigger ไม่ติดมากับ zip
6. ตาราง .39 (`SOI8LOG.dbo`) มีอยู่แล้ว ใช้ร่วมกัน ไม่ต้องสร้าง

## กติกาสำคัญ (สรุปสั้น — ฉบับเต็ม `docs/W192-LIQUID-AUTO-PROMPT.md`)

- **type unique** — ไม่ใช่ template ร่วมกับ manual2tmaster · station เดิม `2T02` จะกลับมาบนเครื่องใหม่ ห้าม rename ปลายทาง
- `BARCODE_SAP`: date ให้ SAP ต้อง **จุด** (`sapfmt`) · date แสดงผล MFG/EXP เป็น **ทับ** (`dfmt`) — ห้ามรวมสองฟังก์ชันนี้ (เคยพังมาแล้ว 21/08)
- lookup ล้มเหลว → บันทึก `BarcodeData` `status='failed'` + เขียน `BARCODE_TRIGER=7` (สำเร็จ=0)
- `PGMNO` fix=1 ชั่วคราว รอระบบผู้รับเหมา
- mirror `kubotalog_backup` ทำโดย **trigger ระดับ DB** — ห้ามเพิ่ม INSERT ในสคริปต์ (แถวคู่) · หน้า WEIGHT RECORD `.34:7000` อ่านตารางนี้
- CONFIRM pulse ต้อง ≥400ms (poll 200 + REC 200) — ยอดขาดให้สงสัยข้อนี้ก่อน
- `WEIGHT_RT_MIRROR` เขียนทุก 2 วิ ไม่เช็คค่าเปลี่ยน (PLC เคยเคลียร์ค่าเอง)
- ⚠️ `RT_KEY` (hook order-rt) hardcode อยู่ในสคริปต์ — โฟลเดอร์นี้อยู่ใน `backups/` (gitignored) ห้ามย้ายเข้า git
