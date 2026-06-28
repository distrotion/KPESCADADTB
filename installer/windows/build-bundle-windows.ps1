# KPE SCADA - สร้าง OFFLINE BUNDLE สำหรับ Windows (รวม node_modules + Node) → .zip
#   concept เดียวกับ build-bundle.sh (Pi) · ⚠️ ต้องรันบน Windows x64 (serialport เป็น native win32)
#      build บน Mac/Linux ไม่ได้ · ใช้ Windows อีกเครื่องที่มีเน็ต สร้างครั้งเดียว
#
#   ได้: kpe-scada-win-x64-<date>.zip  →  เอาไป Windows ที่ไม่มีเน็ต:
#        แตก zip → cd kpe\installer\windows → install_windows.ps1 -Offline
#
#   ใช้งาน (Windows x64 มีเน็ต):
#     # ที่ frontend: flutter build web --no-web-resources-cdn  (ต้องมี build\web)
#     powershell -ExecutionPolicy Bypass -File build-bundle-windows.ps1
#     ... -NoNode                 # ไม่รวม Node (ปลายทางมี node >=18 อยู่แล้ว)
#     ... -NodeVersion v22.18.0
#   ⚠️ Node default = v22.18.0 → มี node:sqlite built-in (flag-free 22.13+) = SQLite ใช้ได้โดยไม่ต้อง native dep
#      (Node <22.5 ไม่มี node:sqlite → SQLite ถูกซ่อนใน UI เว้นแต่ติดตั้ง better-sqlite3 เอง)
param([switch]$NoNode, [string]$NodeVersion = 'v22.18.0', [string]$OutDir)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = $ScriptDir }

# project root
$Root = $ScriptDir
while ($true) {
  if ((Test-Path "$Root\ports.js") -and (Test-Path "$Root\backend") -and (Test-Path "$Root\manager")) { break }
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { Write-Error "หา project root ไม่เจอ"; exit 1 }
  $Root = $parent
}

# arch guard (bundle ผูกกับ win-x64 — serialport native)
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  Write-Warning "ไม่ใช่ x64 ($env:PROCESSOR_ARCHITECTURE) — bundle ควรสร้างบน Windows x64 (ตรงกับเป้าหมาย)"
}
if (-not (Test-Path "$Root\frontend\build\web")) { Write-Error "ไม่พบ frontend\build\web — รัน 'flutter build web --no-web-resources-cdn' ก่อน"; exit 1 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "ต้องมี Node.js (npm install)"; exit 1 }
$ver = & node -p "require('$($Root -replace '\\','/')/backend/package.json').version"
Write-Host "Project: $Root · version $ver"

# 1) npm install (backend + manager · win32 native)
Write-Host "[1/4] npm install (backend + manager · win32) ..."
foreach ($m in @('backend','manager')) {
  Push-Location (Join-Path $Root $m); & npm install --omit=dev; $c=$LASTEXITCODE; Pop-Location
  if ($c -ne 0) { Write-Error "npm install $m ล้มเหลว"; exit 1 }
}

# 2) staging (รวม node_modules · ตัด data/secret/.git/.dart_tool/zip)
Write-Host "[2/4] staging ..."
$stage = Join-Path $env:TEMP ("kpe-bundle-" + ([guid]::NewGuid().ToString('N')))
$app = Join-Path $stage 'kpe'
New-Item -ItemType Directory -Force -Path $app | Out-Null
$xd = @("$Root\.git","$Root\config","$Root\layout","$Root\datalog","$Root\service","$Root\frontend\.dart_tool","$Root\frontend\lib","$Root\frontend\test")
$xf = @('ports.json','api-token.json','access-gate.json','branding.json','*.tar.gz','*.zip','*.log')
$rc = @($Root, $app, '/E','/NFL','/NDL','/NJH','/NJS','/NP','/R:1','/W:1','/XD') + $xd + @('/XF') + $xf
& robocopy @rc | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy staging ล้มเหลว"; exit 1 }

# 3) bundle Node (win-x64)
if (-not $NoNode) {
  Write-Host "[3/4] download Node $NodeVersion (win-x64) ..."
  $pkg = "node-$NodeVersion-win-x64"
  $url = "https://nodejs.org/dist/$NodeVersion/$pkg.zip"
  $zip = Join-Path $stage "$pkg.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  New-Item -ItemType Directory -Force -Path "$app\vendor" | Out-Null
  Move-Item (Join-Path $stage $pkg) "$app\vendor\node"
  Remove-Item $zip -Force
  Write-Host "    bundle Node -> vendor\node\node.exe"
} else { Write-Warning "ไม่รวม Node (-NoNode) — ปลายทางต้องมี node >=18 เอง" }

# 4) zip
Write-Host "[4/4] สร้าง .zip ..."
$stamp = Get-Date -Format 'yyyyMMdd'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$out = Join-Path $OutDir "kpe-scada-win-x64-$stamp.zip"
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path $app -DestinationPath $out
Remove-Item $stage -Recurse -Force
Write-Host ""
Write-Host "เสร็จ -> $out ($([math]::Round((Get-Item $out).Length/1MB,1)) MB)" -ForegroundColor Green
Write-Host "เอาไป Windows ที่ไม่มีเน็ต: แตก zip -> cd kpe\installer\windows -> install_windows.ps1 -Offline"
