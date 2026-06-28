# KPE SCADA - Installer สำหรับ Windows (Windows Service ผ่าน WinSW · เปิดเองตอนบูต + ฟื้นเมื่อ crash)
#   ดูแผน: docs/INSTALL-WINDOWS.md · concept เดียวกับ Pi (install/update/offline/watchdog/uninstall)
#
#   ใช้งาน (คลิกขวา install_windows.bat > Run as administrator  หรือ):
#     powershell -ExecutionPolicy Bypass -File install_windows.ps1               # ติดตั้ง/อัปเดต (online · idempotent)
#     ... -Offline                                                               # ใช้ของที่ bundle มา (ไม่ต่อเน็ต — คู่กับ build-bundle-windows.ps1)
#     ... -Watchdog                                                              # + จับ "ค้าง" (scheduled task ยิง /api/status -> restart)
#     ... -DataDir "D:\KPE"                                                      # แยกที่เก็บ data
#     ... -Action uninstall                                                      # ถอน service (ไม่ลบไฟล์/ข้อมูล)
#
#   ⚠️ online: ห้ามก๊อป node_modules ข้ามเครื่อง — สคริปต์ npm install บนเครื่องนี้ (ต้องมีเน็ต) · offline: ใช้ vendor\ ใน bundle
param(
  [ValidateSet('install','uninstall')] [string]$Action = 'install',
  [switch]$Offline,
  [switch]$Watchdog,
  [string]$Instance = '',      # multi-instance: ชื่อ node (ว่าง = instance เดียว ใช้ default ports)
  [int]$PortBase = 0,          # base port ของ instance (จำเป็นเมื่อใช้ -Instance · เช่น 13000)
  [string]$DataDir = "$env:ProgramData\KPE",
  [switch]$UsbLicense          # โหมด B: ต้องเสียบ USB master key ตลอด (ดึง=หยุดทันที) · ตั้ง env KPE_LICENSE_USB=1
)
$ErrorActionPreference = 'Stop'

# multi-instance: data dir แยกต่อ instance (ถ้าไม่ได้ระบุ -DataDir เอง)
if ($Instance -and ($DataDir -eq "$env:ProgramData\KPE")) { $DataDir = "$env:ProgramData\KPE\$Instance" }

# ── self-elevate (ติดตั้ง service ต้องใช้ Administrator) ───────────────────────
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "ต้องสิทธิ์ Administrator -> เปิดใหม่แบบ elevated ..."
  $argline = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action $Action -DataDir `"$DataDir`""
  if ($Offline)  { $argline += " -Offline" }
  if ($Watchdog) { $argline += " -Watchdog" }
  if ($UsbLicense) { $argline += " -UsbLicense" }
  if ($Instance) { $argline += " -Instance `"$Instance`" -PortBase $PortBase" }
  Start-Process powershell.exe $argline -Verb RunAs
  exit
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── หา project root (มี ports.js + backend + manager) ─────────────────────────
$Root = $ScriptDir
while ($true) {
  if ((Test-Path "$Root\ports.js") -and (Test-Path "$Root\backend") -and (Test-Path "$Root\manager")) { break }
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { Write-Error "หา project root ไม่เจอ (ต้องมี ports.js + backend + manager)"; exit 1 }
  $Root = $parent
}
Write-Host "Project root: $Root"

# multi-instance: ชื่อ service/ports/env-block ต่อ instance (default = instance เดียว ใช้ค่าเดิม)
if ($Instance) {
  if ($PortBase -le 0) { Write-Error "ใช้ -Instance ต้องระบุ -PortBase ด้วย (เช่น -PortBase 13000)"; exit 1 }
  $Svc = "kpe-scada-$Instance"
  $pWeb = $PortBase; $pBackend = $PortBase + 1; $pManager = $PortBase + 2; $pDeploy = $PortBase + 3; $pKpenet = $PortBase + 5
  # env-block ใส่ใน WinSW xml — port + ชื่อ instance (kpenetwork port ลูก inherit ผ่าน process.env)
  $InstEnv = @"
  <env name="KPE_INSTANCE" value="$Instance" />
  <env name="KPE_PORT" value="$pWeb" />
  <env name="KPE_BACKEND_PORT" value="$pBackend" />
  <env name="KPE_MANAGER_PORT" value="$pManager" />
  <env name="KPE_DEPLOY_PORT" value="$pDeploy" />
  <env name="KPE_DEPLOY_BACKEND_PORT" value="$pBackend" />
  <env name="KPE_KPENETWORK_PORT" value="$pKpenet" />
"@
} else {
  $Svc = 'kpe-scada'
  $InstEnv = ''
  $pWeb = 0; $pManager = 0
}
$WdTask   = "$Svc-watchdog"
$SvcDir   = Join-Path $Root 'service'
$SvcExe   = Join-Path $SvcDir "$Svc.exe"
$SvcXml   = Join-Path $SvcDir "$Svc.xml"
$VendorNode = Join-Path $Root 'vendor\node\node.exe'

# ── uninstall ────────────────────────────────────────────────────────────────
if ($Action -eq 'uninstall') {
  if (Test-Path $SvcExe) { & $SvcExe stop 2>$null; & $SvcExe uninstall 2>$null }
  Unregister-ScheduledTask -TaskName $WdTask -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "ถอน service '$Svc' + watchdog แล้ว (ไฟล์โปรแกรม + data ไม่ถูกลบ)"
  exit 0
}

# ── 1) Node — prefer vendor\node (bundle) เสมอ → system node → ต้อง >=18 ไม่งั้น ERROR (กัน "install สำเร็จแต่ backend crash") ──
if (Test-Path $VendorNode) {
  $node = $VendorNode
  Write-Host "ใช้ Node ที่ bundle มา (vendor\node): $node"
} else {
  if ($Offline) { Write-Warning "Offline แต่ไม่พบ vendor\node -> ใช้ Node ของระบบแทน" }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Error "ไม่พบ Node.js (vendor\node หรือ system) - ติดตั้ง Node LTS (>=18) จาก https://nodejs.org หรือใช้ offline bundle (มี Node มาด้วย)"; exit 1 }
}
$nodeMajor = & $node -p "process.versions.node.split('.')[0]"
if ([int]$nodeMajor -lt 18) {
  Write-Error "Node $(& $node -v) เก่าเกินไป - ต้อง >=18 (mssql/mongodb/opcua + optional-chaining) @ $node`n   แก้: ติดตั้ง Node LTS (>=18) จาก https://nodejs.org แล้วเปิด PowerShell ใหม่ · หรือใช้ offline bundle ที่มี Node มาด้วย"
  exit 1
}
Write-Host "Node $(& $node -v) @ $node"

# ── 2) dependencies (backend + manager — มี node_modules แยกกัน) ──────────────
if ($Offline) {
  foreach ($m in @('backend','manager')) {
    if (-not (Test-Path (Join-Path $Root "$m\node_modules"))) { Write-Error "offline: ไม่พบ $m\node_modules (ต้อง bundle มาด้วย build-bundle-windows.ps1)"; exit 1 }
  }
  Write-Host "ใช้ node_modules ที่ bundle มา (backend+manager · ข้าม npm install)"
} else {
  $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
  if (-not $npm) { Write-Error "ไม่พบ npm (มากับ Node.js)"; exit 1 }
  foreach ($m in @('backend','manager')) {
    Write-Host "npm install ($m) ..."
    Push-Location (Join-Path $Root $m)
    & npm install --omit=dev
    $code = $LASTEXITCODE; Pop-Location
    if ($code -ne 0) { Write-Error "npm install $m ล้มเหลว (เช็คเน็ต/พื้นที่)"; exit 1 }
  }
}

# ── 3) data dir ──────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$DataDir\config","$DataDir\layout","$DataDir\datalog" | Out-Null
Write-Host "Data dir: $DataDir"

# ── 4) Windows Service (WinSW) ────────────────────────────────────────────────
$WinSW = Join-Path $ScriptDir 'WinSW.exe'
if (-not (Test-Path $WinSW)) { Write-Error "ไม่พบ WinSW.exe ใน $ScriptDir (ต้องมากับ installer)"; exit 1 }
New-Item -ItemType Directory -Force -Path $SvcDir | Out-Null
if (Get-Service $Svc -ErrorAction SilentlyContinue) {
  Write-Host "Existing service found -> stop + uninstall (update) ..."
  if (Test-Path $SvcExe) {
    & $SvcExe stop 2>$null; & $SvcExe uninstall 2>$null
  } else {
    # service is registered but its exe is missing (e.g. fresh clone: service/ is empty).
    # WinSW cannot uninstall without the exe -> clean the orphaned service via sc.exe.
    Write-Host "  service exe missing -> cleaning orphaned service via sc.exe ..."
    & sc.exe stop $Svc 2>$null | Out-Null
    & sc.exe delete $Svc 2>$null | Out-Null
  }
  Start-Sleep -Seconds 2
}
Copy-Item $WinSW $SvcExe -Force

$nodeDir = Split-Path -Parent $node
$xml = @"
<service>
  <id>$Svc</id>
  <name>KPE SCADA Manager</name>
  <description>KPE SCADA - supervises backend + frontend</description>
  <executable>$node</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$Root\manager</workingdirectory>
  <env name="NODE_ENV" value="production" />
  <env name="KPE_DATA_DIR" value="$DataDir" />
  <env name="KPE_ENFORCE" value="1" />
$(if ($UsbLicense) { "  <env name=`"KPE_LICENSE_USB`" value=`"1`" />`n" })  <env name="PATH" value="$nodeDir;%PATH%" />
$InstEnv  <onfailure action="restart" delay="3 sec" />
  <resetfailure>1 hour</resetfailure>
  <startmode>Automatic</startmode>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
Set-Content -Path $SvcXml -Value $xml -Encoding UTF8
& $SvcExe install
& $SvcExe start

# จำกัดสิทธิ์ไฟล์ลับ (api-token/access-gate) เฉพาะ SYSTEM+Admins (แทน perm 0600 ที่ไม่มีผลบน NTFS)
try { icacls "$DataDir\config" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" 2>$null | Out-Null } catch {}

# ── 5) ports (instance = จาก PortBase · default = จาก ports.js) ───────────────
if ($Instance) {
  $a = @("$pWeb", "$pManager")
} else {
  $pj = ($Root -replace '\\','/') + '/ports.js'
  $pp = & $node -e "const p=require(process.argv[1]).ports();process.stdout.write(p.frontend+' '+p.manager)" "$pj"
  $a = $pp -split ' '
}

# ── 5b) watchdog (opt-in · scheduled task ยิง /api/status ทุก 1 นาที -> restart ถ้าค้าง) ──
if ($Watchdog) {
  try {
    $mp = $a[1]
    $chk = "try { Invoke-RestMethod -Uri http://127.0.0.1:$mp/api/status -TimeoutSec 5 | Out-Null } catch { Restart-Service $Svc -ErrorAction SilentlyContinue }"
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$chk`""
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $WdTask -Action $act -Trigger $trg -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Write-Host "watchdog ติดตั้งแล้ว (ตรวจทุก 1 นาที)"
  } catch { Write-Warning "ติดตั้ง watchdog ไม่สำเร็จ: $_" }
}

# ── 6) done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "KPE SCADA รันแล้ว (Windows Service: $Svc · Automatic + restart)" -ForegroundColor Green
if ($Instance) { Write-Host "   Instance  : $Instance  (data: $DataDir · kpenetwork modbus: $pKpenet)" }
Write-Host "   Dashboard : http://localhost:$($a[0])"
Write-Host "   Manager   : http://localhost:$($a[1])"
Write-Host "   สถานะ     : sc query $Svc   |   log: $SvcDir\$Svc.out.log"
if ($Instance) { Write-Host "   ถอน       : install_windows.ps1 -Action uninstall -Instance $Instance" }
else { Write-Host "   ถอน       : install_windows.ps1 -Action uninstall" }
