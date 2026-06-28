# ติดตั้ง KPE SCADA บน Windows

รันใต้ **Windows Service** (ผ่าน WinSW) → เปิดเองตอนบูต + ฟื้นเมื่อ crash · Manager คุม backend+frontend
> ⚠️ ยังไม่ได้ทดสอบบน Windows จริง (เขียนจาก Mac · ต้อง validate/test บน Windows) · แผนเต็ม: [../../docs/INSTALL-WINDOWS.md](../../docs/INSTALL-WINDOWS.md)

**ไฟล์ในโฟลเดอร์นี้ (concept เดียวกับ Pi ครบชุด):**
| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `install_windows.bat` | ดับเบิลคลิก (Run as administrator) → เรียก .ps1 |
| `install_windows.ps1` | installer หลัก · `-Offline` · `-Watchdog` · `-Action uninstall` · `-DataDir` · **`-Instance <ชื่อ> -PortBase <n>`** (หลาย node/เครื่อง) |
| `update_windows.ps1` | **อัปเดตจาก tarball/zip** (clean replace · เก็บ data/พอร์ต/secret · auto online/offline) |
| `build-bundle-windows.ps1` | **สร้าง offline bundle .zip** (รวม node_modules+Node · รันบน Windows x64) |
| `WinSW.exe` | service wrapper (.NET4 · มากับ Win10/11) — ห่อ node เป็น Windows Service |
| `kpe-scada.iss` | Inno Setup → `setup.exe` (native installer · compile บน Windows) |

> เทียบ Pi: `install_pi.sh`=install_windows.ps1 · `update_pi.sh`=update_windows.ps1 · `build-bundle.sh`=build-bundle-windows.ps1 · `build-deb.sh`=kpe-scada.iss · stage = ใช้ `installer/pi/stage-deploy.sh` ร่วม (tarball OS-agnostic)

---

## วิธี A — Script (เร็ว · แนะนำสำหรับเริ่ม)
**1. เตรียม (เครื่อง dev):** `cd frontend && flutter build web --no-web-resources-cdn` แล้ว **commit `build/web` ขึ้น git** (สำคัญ — ไม่งั้นเครื่องปลายทางไม่มี UI)
**2. เอาโค้ดขึ้นเครื่อง Windows** — เลือกทางใดทางหนึ่ง:
   - **git (แนะนำ):** `git clone <repo-url> kpe` — `node_modules`/secret/`ports.json`/`config`/`datalog` ถูก `.gitignore` ไว้แล้ว (installer ลง deps เอง · clone = โปรเจกต์ว่าง)
   - **ก๊อปโฟลเดอร์:** ก๊อปทั้งโปรเจกต์ (ยกเว้น `node_modules`)
   - ต้องมี **Node LTS ≥18** ([nodejs.org](https://nodejs.org)) + **เน็ตตอนติดตั้ง** (npm install)
**3. ติดตั้ง:** คลิกขวา **`install_windows.bat` → Run as administrator** (หรือ `powershell -ExecutionPolicy Bypass -File install_windows.ps1`)

installer จะ: ตรวจ Node → `npm install` (backend+manager) → ติดตั้ง Windows Service `kpe-scada` (Automatic + restart) → start
- เปิด `http://localhost:3012` (Dashboard) · `http://<IP>:5012` (Manager)
- program = ที่ก๊อปไว้ (in-place) · data = `%ProgramData%\KPE` (แยก · `-DataDir` เปลี่ยนได้)

**อัปเดต:** ก๊อปไฟล์ใหม่ทับ (ข้าม node_modules) → รัน `install_windows.bat` ซ้ำ (idempotent: stop → npm install → re-install service → start) · data คงเดิม
**ถอน:** `powershell -ExecutionPolicy Bypass -File install_windows.ps1 -Action uninstall`

## วิธี B — setup.exe (Inno Setup · polished)
บน Windows ที่มี [Inno Setup](https://jrsoftware.org/isdl.php):
```
cd frontend && flutter build web --no-web-resources-cdn
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\kpe-scada.iss
```
ได้ `installer\windows\Output\kpe-scada-setup-1.0.0.exe` → ดับเบิลคลิกติดตั้ง (ลง `C:\Program Files\KPE SCADA` + รัน .ps1 ให้อัตโนมัติ) · ถอนผ่าน Add/Remove Programs

---

## อัปเดต (update_windows.ps1)
```powershell
# dev: สร้าง tarball ใหม่ (installer\pi\stage-deploy.sh) → ก๊อปขึ้น Windows
powershell -ExecutionPolicy Bypass -File update_windows.ps1 kpe-deploy-XXXX.tar.gz   # หรือไม่ใส่ = ตัวล่าสุด
```
stop → robocopy แทน program (เก็บ config/layout/datalog/ports.json/secret) → npm install (online)/ใช้ bundle (offline) → restart · ตรวจ online/offline จาก tarball เอง
> 💡 update แบบ **atomic/clean สุด** = ลง `setup.exe` (Inno) เวอร์ชันใหม่ทับ (= .deb ของฝั่ง Pi)

## Offline (Windows ไม่มีเน็ต)
```powershell
# บน Windows x64 ที่มีเน็ต (สร้างครั้งเดียว):
cd frontend; flutter build web --no-web-resources-cdn
cd ..\installer\windows; powershell -ExecutionPolicy Bypass -File build-bundle-windows.ps1   # → kpe-scada-win-x64-<date>.zip
# บน Windows ปลายทาง (ไม่มีเน็ต):
#   แตก zip → cd kpe\installer\windows → (Run as admin) install_windows.ps1 -Offline
```

## Watchdog (จับ "ค้าง")
`install_windows.ps1 -Watchdog` → scheduled task ยิง `/api/status` ทุก 1 นาที → ค้าง = `Restart-Service kpe-scada`

## หลาย node บนเครื่องเดียว (multi-instance) — §75
ลง KPE มากกว่า 1 node บน Windows เครื่องเดียวโดย **port + data ไม่ชน** ด้วย `-Instance <ชื่อ> -PortBase <n>`:
```powershell
# node A — default (web 3012 · manager 5012 · kpenetwork modbus 5020 · data %ProgramData%\KPE)
install_windows.ps1
# node B — instance "lineB" · base 13010 (web 13010 · backend 13011 · manager 13012 · deploy 13013 · kpenetwork 13015)
install_windows.ps1 -Instance lineB -PortBase 13010
# ถอนเฉพาะ node B
install_windows.ps1 -Action uninstall -Instance lineB
```
- แต่ละ instance = **service แยก** `kpe-scada-<ชื่อ>` + **data dir แยก** `%ProgramData%\KPE\<ชื่อ>` + ชุด port เฉพาะ (ฝังใน WinSW env)
- **port map ต่อ instance:** web=base · backend=base+1 · manager=base+2 · deploy=base+3 · **kpenetwork(modbus)=base+5**
- เว้น `PortBase` ให้ห่างกัน ≥10 ต่อ instance (เช่น 13000, 13010, 13020) กันชน
- header ของแอปจะโชว์ **ชื่อ instance** (จาก `KPE_INSTANCE`) กันสับสนเวลาเปิดหลาย node
- **KPENETWORK ข้ามเครื่อง:** subscriber ชี้มา node B ใช้ **Modbus Port = 13015** · **API Port = 13010** (= web port) · node แต่ละตัวเป็น node อิสระ (nodeId/port ของตัวเอง)
- ⚠️ ทรัพยากร: 1 instance ≈ 300–450 MB → เผื่อ RAM ตามจำนวน node · ดูเต็ม: [../../docs/MULTI-INSTANCE.md](../../docs/MULTI-INSTANCE.md)
- **restart / stop / start แต่ละ instance:** ดับเบิลคลิก **`KPE Service Manager.bat`** (ที่ project root) → เลือก service `kpe-scada-<ชื่อ>` จากรายการ → restart ได้เลย (คุม service ตรงๆ ไม่เดาพอร์ต · self-elevate เป็น admin)
  - ⚠️ `KPE Kill Manager Port.bat` / `KPE SCADA Manager.bat` เดิม **ใช้กับ single-instance (พอร์ต default 5012) เท่านั้น** — multi-instance/service ให้ใช้ `KPE Service Manager.bat`
  - คำสั่งตรง: `net stop kpe-scada-lineB && net start kpe-scada-lineB` (หรือ `sc stop/start`)

## ⚠️ ข้อควรระวัง (Windows — ดู docs/INSTALL-WINDOWS.md)
- ต้องมี **เน็ตตอนติดตั้ง** (npm install ดึง serialport prebuild win32) · **ห้ามก๊อป node_modules ข้ามเครื่อง**
- service รันเป็น **LocalSystem** · serial = COM ports (ไม่ต้องตั้ง group) · **GPIO ไม่มีบน Windows** → device gpio = sim
- **Windows ไม่มี SIGTERM จริง** → ตอน stop service ลูกถูก force-kill แต่ **B3 atomic writes คุ้มไว้** (config ไม่พังครึ่งไฟล์)
- ไฟล์ลับ (api-token/access-gate) จำกัดสิทธิ์ด้วย NTFS ACL (icacls ใน .ps1) แทน perm 0600
- (แจกจริง) เซ็น setup.exe ด้วย **Authenticode/EV cert** กัน SmartScreen — ดู docs/INSTALL-WINDOWS.md

install_windows.ps1 -Action uninstall          # ถอน
install_windows.ps1 -Offline                    # ไม่มีเน็ต (ใช้ bundle ที่ build ไว้)
install_windows.ps1 -Watchdog                   # จับค้าง → auto restart
install_windows.ps1 -Instance lineB -PortBase 13010   # ลง node ที่ 2 บนเครื่องเดียว

## Troubleshoot
| อาการ | แก้ |
|---|---|
| `running scripts is disabled` | ใช้ `install_windows.bat` หรือ `-ExecutionPolicy Bypass` |
| service ไม่ start | `sc query kpe-scada` · log ที่ `<project>\service\kpe-scada.out.log` / `.err.log` |
| restart Manager (multi-instance) ไม่ได้ / bat เดิมไป kill พอร์ต 5012 | ใช้ **`KPE Service Manager.bat`** → เลือก instance → Restart (bat เดิมเดาพอร์ตเป็น default 5012 จึงผิด instance) |
| add Remote Site แล้ว ✗ ผิดพลาด | Manager service ตัวนั้นไม่ได้รัน/พอร์ตชน → เปิด `KPE Service Manager.bat` เช็ค state + Restart instance ให้ถูกตัว |
| `Cannot find module 'express'` | ลง manager ด้วย: `cd <project>\manager && npm install --omit=dev` แล้วรัน installer ซ้ำ |
| Node < 18 | ติดตั้ง Node LTS ใหม่จาก nodejs.org แล้วรัน installer ซ้ำ |
