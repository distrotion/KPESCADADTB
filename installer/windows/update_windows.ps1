# KPE SCADA - Update บน Windows (แทนโปรแกรมใหม่ · เก็บ data/พอร์ต/secret · restart)
#   concept เดียวกับ update_pi.sh · รองรับ deploy tarball (.tar.gz online) และ offline bundle (.zip มี vendor/)
#
#   ใช้งาน (Run as administrator):
#     powershell -ExecutionPolicy Bypass -File update_windows.ps1 <new.tar.gz|.zip>
#     powershell -ExecutionPolicy Bypass -File update_windows.ps1            # auto: ใช้ kpe-*.tar.gz/.zip ตัวล่าสุดในโฟลเดอร์นี้
#
#   ทำ: stop service -> แตก tarball -> robocopy แทน program (เก็บ data/พอร์ต/secret) -> install_windows.ps1 -> start
#   ⚠️ ห้ามก๊อป node_modules ข้ามเครื่อง — online จะ npm install บน Windows · offline ใช้ของใน bundle
param([string]$Tarball, [string]$DataDir = "$env:ProgramData\KPE")
$ErrorActionPreference = 'Stop'

# ── self-elevate ──────────────────────────────────────────────────────────────
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  $al = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Tarball) { $al += " `"$Tarball`"" }
  $al += " -DataDir `"$DataDir`""
  Start-Process powershell.exe $al -Verb RunAs
  exit
}

# ── re-exec จาก TEMP — กัน robocopy ทับสคริปต์ตัวเองระหว่างรัน ─────────────────
if (-not $env:_KPE_UPD_TMP) {
  $instDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $tmp = Join-Path $env:TEMP ("kpe-update-" + ([guid]::NewGuid().ToString('N')) + ".ps1")
  Copy-Item $PSCommandPath $tmp -Force
  $env:_KPE_UPD_TMP = '1'
  $env:_KPE_INSTALLER_DIR = $instDir
  $al = "-NoProfile -ExecutionPolicy Bypass -File `"$tmp`""
  if ($Tarball) { $al += " `"$Tarball`"" }
  $al += " -DataDir `"$DataDir`""
  Start-Process powershell.exe $al -Wait
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  exit
}
$InstallerDir = $env:_KPE_INSTALLER_DIR

# ── project root จริง (เดินขึ้นจาก installer dir) ──────────────────────────────
$Root = $InstallerDir
while ($true) {
  if ((Test-Path "$Root\ports.js") -and (Test-Path "$Root\backend") -and (Test-Path "$Root\manager")) { break }
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { Write-Error "หา project root (ที่ติดตั้งอยู่) ไม่เจอ"; exit 1 }
  $Root = $parent
}

# ── หา tarball ────────────────────────────────────────────────────────────────
if (-not $Tarball) {
  $cand = Get-ChildItem -Path $InstallerDir -Filter 'kpe-*' -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '\.(tar\.gz|zip)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($cand) { $Tarball = $cand.FullName; Write-Warning "ไม่ได้ระบุ tarball -> ใช้ตัวล่าสุด: $($cand.Name)" }
}
if (-not $Tarball -or -not (Test-Path $Tarball)) { Write-Error "ไม่พบ tarball — ระบุ: update_windows.ps1 <file.tar.gz|.zip>"; exit 1 }
Write-Host "Project root: $Root"
Write-Host "Tarball ใหม่: $Tarball"

$Svc = 'kpe-scada'
$SvcExe = Join-Path $Root "service\$Svc.exe"

# ── 1) stop ──────────────────────────────────────────────────────────────────
Write-Host "[1/4] หยุด service ..."
if (Test-Path $SvcExe) { & $SvcExe stop 2>$null; Start-Sleep -Seconds 2 }

# ── 2) extract ───────────────────────────────────────────────────────────────
Write-Host "[2/4] แตก tarball ..."
$tmpx = Join-Path $env:TEMP ("kpe-ext-" + ([guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Force -Path $tmpx | Out-Null
if ($Tarball -match '\.zip$') { Expand-Archive -Path $Tarball -DestinationPath $tmpx -Force }
else { & tar -xzf $Tarball -C $tmpx }   # Windows 10+ มี tar ในตัว
$Src = Join-Path $tmpx 'kpe'
if (-not (Test-Path $Src)) { Write-Error "tarball ไม่มีโฟลเดอร์ kpe\ (ใช้ไฟล์จาก stage-deploy.sh / build-bundle-windows.ps1)"; Remove-Item $tmpx -Recurse -Force; exit 1 }

# offline? = bundle มี node_modules/vendor
$offline = (Test-Path "$Src\vendor\node") -or (Test-Path "$Src\backend\node_modules")
Write-Host ("    -> " + ($(if($offline){'offline bundle (มี node_modules/vendor)'}else{'deploy tarball (online)'})))

# ── 3) แทนโปรแกรม (robocopy /E overwrite · เก็บ data/พอร์ต/secret · ไม่แตะ service\) ──
Write-Host "[3/4] แทนโปรแกรม ..."
# /XD: data dirs + service (กำลังรัน/ล็อก) · online เพิ่ม node_modules (คง node_modules เดิม)
$xd = @("$Src\config","$Src\layout","$Src\datalog","$Root\config","$Root\layout","$Root\datalog","$Root\service")
if (-not $offline) { $xd += @("$Root\backend\node_modules","$Root\manager\node_modules") }
$xf = @('ports.json','api-token.json','access-gate.json','branding.json')
$rcArgs = @($Src, $Root, '/E', '/NFL','/NDL','/NJH','/NJS','/NP','/R:1','/W:1','/XD') + $xd + @('/XF') + $xf
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy ล้มเหลว (code $LASTEXITCODE)"; Remove-Item $tmpx -Recurse -Force; exit 1 }
Remove-Item $tmpx -Recurse -Force
Write-Host "    แทนโปรแกรมแล้ว (data/พอร์ต/secret เดิมถูกเก็บ)"

# ── 4) ติดตั้ง deps + restart (ผ่าน install_windows.ps1 ที่อัปเดตแล้ว) ─────────
Write-Host "[4/4] ติดตั้ง deps + restart ..."
$inst = Join-Path $Root 'installer\windows\install_windows.ps1'
if (-not (Test-Path $inst)) { Write-Error "ไม่พบ install_windows.ps1 ใน tarball"; exit 1 }
$ia = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$inst,'-DataDir',$DataDir)
if ($offline) { $ia += '-Offline' }
& powershell.exe @ia

Write-Host ""
Write-Host "อัปเดตเสร็จ — data/พอร์ต/secret เดิมถูกเก็บไว้ครบ" -ForegroundColor Green
Write-Host "   เช็ค: sc query $Svc"
