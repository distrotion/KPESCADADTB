# KPE SCADA

ระบบ SCADA — Node.js backend + Flutter Web frontend + Manager (ตัวคุม service)
รองรับ device: Modbus TCP/RTU · Serial · MQTT · OPC-UA · MC Protocol · Omron FINS · KPENETWORK · **GPIO (Raspberry Pi)**

| Service | Port (default) | หน้าที่ |
|---|---|---|
| Frontend (Dashboard) | **3012** | UI พอร์ตเดียว + proxy `/api`,`/ws` → backend |
| Backend | 4012 | engine อ่าน/เขียน device, alarm, script, DB (ภายใน) |
| Manager | 5012 | start/stop/คุม service + ตั้งค่าพอร์ต/token |
| Deploy (run-mode) | 9012 | เสิร์ฟ dashboard แบบ run-only |

> ต้องการ **Node ≥18** · พอร์ตเปลี่ยนได้ผ่าน env / Manager · ไม่ใช่ git repo (copy ต่อเนื่อง)

---

## เริ่มใช้งาน

### ทดสอบเร็ว (dev — ทุก OS)
- **Mac:** ดับเบิลคลิก `KPE SCADA Manager.command`
- **Windows:** ดับเบิลคลิก `KPE SCADA Manager.bat`
- **Pi/Linux:** `./KPE SCADA Manager.sh`  (หรือ `./start.sh` / `start_windows.bat` รันตรงไม่ผ่าน Manager)

เปิด `http://localhost:3012` (Dashboard) · `http://localhost:5012` (Manager)

### ติดตั้งจริง (production — รันใต้ service ของ OS, เปิดเองตอนบูต + ฟื้นเมื่อ crash)
ดูโฟลเดอร์ **[`installer/`](installer/)** (แยกตาม OS):

| OS | สถานะ | วิธี |
|---|---|---|
| **Raspberry Pi / Linux** | ✅ พร้อม (เหลือทดสอบ Pi 5 จริง) | [`installer/pi/`](installer/pi/) → `cd installer/pi && chmod +x *.sh && sudo bash install_pi.sh` |
| **macOS** | ⬜ ยังไม่ทำ | [`installer/mac/`](installer/mac/) (แผน: [docs/INSTALL-MAC.md](docs/INSTALL-MAC.md)) |
| **Windows** | ✅ script พร้อม (เหลือทดสอบ Windows จริง) | [`installer/windows/`](installer/windows/) → คลิกขวา `install_windows.bat` > Run as administrator (หรือ Inno Setup → setup.exe) |

ภาพรวม installer + การตัดสินใจ + cross-OS gotcha: **[docs/INSTALLER.md](docs/INSTALLER.md)**

---

## เอกสาร
- **[docs/SESSION-HANDOFF.md](docs/SESSION-HANDOFF.md)** — สรุปงานทั้งหมด (อ่านก่อนทำต่อ)
- [docs/INSTALLER.md](docs/INSTALLER.md) — ภาพรวม installer 3 OS
- [docs/GPIO-DEVICE-TYPE.md](docs/GPIO-DEVICE-TYPE.md) — device GPIO (Pi)
- [docs/AUDIT-2026-06-06.md](docs/AUDIT-2026-06-06.md) — ⚠️ อ่านก่อนเปิดใช้นอก localhost (6 CRITICAL auth/RCE)
- คู่มือผู้ใช้: `docs/คู่มือ-*.md`

## ⚠️ ข้อควรรู้
- **ห้ามก๊อป `node_modules` ข้ามเครื่อง** (serialport เป็น native) — `npm install` บนเครื่องปลายทางเสมอ
- frontend ต้อง `flutter build web --no-web-resources-cdn` ก่อน deploy (ปลายทางไม่ต้องมี Flutter SDK · **flag = client ไม่มีเน็ตก็เปิดได้** bundle CanvasKit+ฟอนต์ local)
- runtime data (config/layout/datalog) อยู่ใต้ base เดียว — ตั้ง `KPE_DATA_DIR` เพื่อย้าย/แยก
