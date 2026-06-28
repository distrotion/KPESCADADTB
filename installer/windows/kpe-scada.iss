; KPE SCADA - Inno Setup script (สร้าง setup.exe สำหรับ Windows)
; ⚠️ compile บน Windows ด้วย Inno Setup (ISCC.exe) — Mac/Linux compile ไม่ได้
;   ก่อน compile: ที่ frontend รัน `flutter build web --no-web-resources-cdn` (ต้องมี build/web)
;   compile: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" kpe-scada.iss  -> Output\kpe-scada-setup.exe
;
; setup.exe ทำ: คัดไฟล์ลง C:\Program Files\KPE SCADA -> รัน install_windows.ps1 (npm install + Windows Service)
; ลง deps + service = ทำใน [Run] โดยเรียก install_windows.ps1 ตัวเดียวกับ manual (DRY)

#define AppVer "1.0.0"

[Setup]
AppName=KPE SCADA
AppVersion={#AppVer}
AppPublisher=KPE
DefaultDirName={autopf}\KPE SCADA
DefaultGroupName=KPE SCADA
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=kpe-scada-setup-{#AppVer}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; (ตอนแจกจริง: เซ็น signtool ด้วย Authenticode/EV — ดู docs/INSTALL-WINDOWS.md)

[Files]
; คัดทั้งโปรเจกต์ (จาก root = ..\..) ยกเว้น node_modules/data/secret/build cache
; รวม: backend(src) · frontend\build\web + serve\deploy · manager · ports.js · installer\windows (มี WinSW.exe + ps1)
Source: "..\..\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; \
  Excludes: "\.git\*,*\node_modules\*,node_modules,*\.dart_tool\*,*.tar.gz,*.log,\config\*,\layout\*,\datalog\*,\ports.json,\manager\api-token.json,\manager\access-gate.json,\manager\branding.json,\frontend\lib\*,\frontend\test\*,\frontend\build\windows\*,\frontend\build\linux\*"

[Run]
; ลง dependencies + ติดตั้ง Windows Service (idempotent · ใช้สคริปต์เดียวกับ manual)
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows\install_windows.ps1"""; \
  StatusMsg: "กำลังติดตั้ง dependencies + Windows Service (อาจใช้เวลาสักครู่ · ต้องมีเน็ต)..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
; ถอน service ก่อนลบไฟล์
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows\install_windows.ps1"" -Action uninstall"; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveKpeService"

[UninstallDelete]
; ลบ node_modules + service dir ที่สร้างหลังติดตั้ง (ไม่ได้อยู่ใน [Files])
Type: filesandordirs; Name: "{app}\backend\node_modules"
Type: filesandordirs; Name: "{app}\manager\node_modules"
Type: filesandordirs; Name: "{app}\service"
; หมายเหตุ: ไม่ลบ data (%ProgramData%\KPE) — เก็บไว้ · ลบเองถ้าต้องการ
