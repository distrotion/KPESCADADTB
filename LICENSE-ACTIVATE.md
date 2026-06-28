# KPE SCADA — เปิดใช้งาน License (สำหรับลูกค้า)

> เครื่องที่ติดตั้งแบบ "บังคับ license" (Windows service / Raspberry Pi) ต้อง **เปิดใช้งาน license ก่อนถึงจะรันได้**
> ผู้ขาย (vendor) จะส่งไฟล์ license มาให้ทาง **USB** — ทำตามขั้นตอนข้างล่าง

> 🪟 **Windows — ง่ายสุด: ดับเบิลคลิก `KPE-Setup-Windows.bat`** → เมนูกดเลือก (ติดตั้ง / machine-id / activate / status / ถอด · ครบในเมนูเดียว · ไม่ต้องจำคำสั่ง)
> (ข้างล่างคือคำสั่งแบบ manual เผื่ออยากพิมพ์เอง)

---

## มี 2 แบบ (ผู้ขายจะบอกว่าเครื่องคุณเป็นแบบไหน)

| แบบ | ไฟล์บน USB | ใช้ยังไง |
|---|---|---|
| **A — ติดตั้งแล้วถอด USB** (ปกติ) | `license.key` | เปิดใช้งานครั้งเดียว → **ถอด USB เก็บได้** → รันออฟไลน์ |
| **B — USB เสียบตลอด** (dongle) | `kpe-master.key` | **เสียบ USB ค้างไว้ตลอด** · ดึงออก = ระบบหยุดทันที |

---

## 🔑 ขั้นตอน (ต้องทำครั้งแรกตอนติดตั้ง)

### ก่อนอื่น — เอา "machine-id" ของเครื่องส่งให้ผู้ขาย
ผู้ขายต้องใช้ machine-id เพื่อออก license ให้ตรงเครื่อง:

**Windows** (เปิด PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File installer\windows\license_windows.ps1 -ShowId
```
**Raspberry Pi**:
```bash
sudo ./installer/pi/install_pi.sh --show-id
```
→ ก๊อปข้อความ **machine-id / fingerprint** ส่งให้ผู้ขาย → รอรับ USB ที่มีไฟล์ license กลับมา

---

### แบบ A — ติดตั้งแล้วถอด USB
1. เสียบ USB ที่มี `license.key`
2. **Windows** (Run as Administrator):
   ```powershell
   powershell -ExecutionPolicy Bypass -File installer\windows\license_windows.ps1 -Activate
   ```
   **Pi**:
   ```bash
   sudo ./installer/pi/install_pi.sh --activate
   ```
   (ระบบจะหา `license.key` ใน USB เอง → ตรวจสอบ → ติดตั้ง → restart)
3. ตรวจผล:
   ```powershell
   powershell -File installer\windows\license_windows.ps1 -Status
   ```
   เห็น `ok: true` → **ถอด USB ออกได้** ✅ ระบบรันต่อได้เลย

> หรือเปิดใช้งานผ่านหน้าเว็บ **Manager** → หน้า License → อัปโหลดไฟล์ `license.key`

---

### แบบ B — USB เสียบตลอด (dongle)
1. **เสียบ USB ที่มี `kpe-master.key` ค้างไว้** (ห้ามถอด)
2. ระบบจะตรวจ USB เอง → รันเมื่อเสียบอยู่
3. ⚠️ **ดึง USB ออก = ระบบหยุดทันที** (ภายในไม่กี่วินาที) · เสียบคืน = รันต่อ

---

## 🟢 หลังเปิดใช้งานสำเร็จ
- ระบบรันปกติ · ฟีเจอร์ที่ซื้อ (เช่น **Chem Stock**) ปลดล็อก
- ถ้าฟีเจอร์ไหน **ยังไม่ได้ซื้อ** จะขึ้นป้าย **"ต้องมี DLC: ..."** บนหน้าจอ — ติดต่อผู้ขายเพื่อซื้อเพิ่ม (เพิ่มได้โดยไม่ต้องลงใหม่)

## 🔼 ซื้อฟีเจอร์เพิ่มทีหลัง (DLC)
ผู้ขายส่งไฟล์ DLC มาให้ → วางไฟล์ไว้ใน `<DataDir>\config\licenses\` (Windows: `%ProgramData%\KPE\config\licenses\`) → **ปลดล็อกเองภายใน 30 วินาที** ไม่ต้อง restart

---

## ❓ ปัญหาที่พบบ่อย
| อาการ | สาเหตุ/แก้ |
|---|---|
| `-Status` ขึ้น `wrong-machine` | license ออกให้คนละเครื่อง → ส่ง machine-id ที่ถูกให้ผู้ขายออกใหม่ |
| `-Status` ขึ้น `no-license` | ยังไม่ได้ activate / ไฟล์ไม่อยู่ → ทำขั้นตอน Activate |
| `-Activate` หาไฟล์ไม่เจอ | เสียบ USB ที่มี `license.key` หรือระบุ path เอง: `-Activate -License "D:\license.key"` |
| ระบบหยุด (แบบ B) | USB หลุด → เสียบ `kpe-master.key` คืน |

> เปลี่ยน mainboard / สร้าง VM ใหม่ → machine-id เปลี่ยน → ต้องขอ license ใหม่
