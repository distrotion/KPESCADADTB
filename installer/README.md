# KPE SCADA — Installer (แยกตาม OS)

โฟลเดอร์เก็บไฟล์ติดตั้งของแต่ละ OS · แผน/รายละเอียดอยู่ใน `docs/`

| โฟลเดอร์ | OS | สถานะ | เอกสาร |
|---|---|---|---|
| `installer/pi/` | Raspberry Pi / Linux (ARM) | ✅ `install_pi.sh` พร้อม (เหลือทดสอบบน Pi 5 จริง) | [docs/INSTALL-PI.md](../docs/INSTALL-PI.md) |
| `installer/mac/` | macOS | ⬜ ยังไม่ทำ (.pkg + launchd) | [docs/INSTALL-MAC.md](../docs/INSTALL-MAC.md) |
| `installer/windows/` | Windows | ⬜ ยังไม่ทำ (Inno/MSI + WinSW service) | [docs/INSTALL-WINDOWS.md](../docs/INSTALL-WINDOWS.md) |

- **ภาพรวม + การตัดสินใจ + cross-OS gotcha:** [docs/INSTALLER.md](../docs/INSTALLER.md)
- สคริปต์ในนี้ **หา project root เอง** (โฟลเดอร์ที่มี `ports.js`+`backend/`+`manager/`) → วาง `installer/` ไว้ในโปรเจกต์แล้วรันได้เลย
- ⚠️ ห้ามก๊อป `node_modules` ข้ามเครื่อง — installer รัน `npm install` บนเครื่องปลายทางเอง (prebuild ตรง arch)
