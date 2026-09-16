# KPE SCADA - build the OFFLINE BUNDLE for Windows (node_modules + Node included) -> .zip
#   Same concept as build-bundle.sh (Pi). WARNING: must run on Windows x64 (serialport is a win32 native dep) -
#   cannot build on Mac/Linux. Use any Windows machine with internet, build once.
#
#   Output: kpe-scada-win-x64-<date>.zip  ->  take to an offline Windows box:
#           extract zip -> cd kpe\installer\windows -> install_windows.ps1 -Offline
#
#   Usage (Windows x64 with internet):
#     # in frontend: flutter build web --no-web-resources-cdn  (build\web must exist)
#     powershell -ExecutionPolicy Bypass -File build-bundle-windows.ps1
#     ... -NoNode                 # skip bundling Node (target already has node >=18)
#     ... -NodeVersion v22.18.0
#   NOTE: Node default = v22.18.0 -> has node:sqlite built in (flag-free since 22.13), so SQLite
#         works without a native dep (Node <22.5 lacks node:sqlite -> SQLite hidden in UI unless
#         better-sqlite3 is installed manually).
#   NOTE: keep this file pure ASCII (see install_windows.ps1 header for why).
param([switch]$NoNode, [string]$NodeVersion = 'v22.18.0', [string]$OutDir)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = $ScriptDir }

# project root
$Root = $ScriptDir
while ($true) {
  if ((Test-Path "$Root\ports.js") -and (Test-Path "$Root\backend") -and (Test-Path "$Root\manager")) { break }
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { Write-Error "project root not found"; exit 1 }
  $Root = $parent
}

# arch guard (bundle is tied to win-x64 - serialport native)
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  Write-Warning "not x64 ($env:PROCESSOR_ARCHITECTURE) - the bundle should be built on Windows x64 (same as targets)"
}
if (-not (Test-Path "$Root\frontend\build\web")) { Write-Error "frontend\build\web not found - run 'flutter build web --no-web-resources-cdn' first"; exit 1 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "Node.js required (for npm install)"; exit 1 }
$ver = & node -p "require('$($Root -replace '\\','/')/backend/package.json').version"
Write-Host "Project: $Root - version $ver"

# 1) npm install (backend + manager - win32 native)
#    npm.cmd by full path, not bare "npm" (PATH may resolve to a broken npm.ps1 shim)
Write-Host "[1/4] npm install (backend + manager - win32) ..."
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { Write-Error "npm.cmd not found (comes with Node.js)"; exit 1 }
foreach ($m in @('backend','manager')) {
  Push-Location (Join-Path $Root $m); & $npmCmd install --omit=dev; $c=$LASTEXITCODE; Pop-Location
  if ($c -ne 0) { Write-Error "npm install $m failed"; exit 1 }
}

# 2) staging (include node_modules - exclude data/secret/.git/.dart_tool/zip)
Write-Host "[2/4] staging ..."
$stage = Join-Path $env:TEMP ("kpe-bundle-" + ([guid]::NewGuid().ToString('N')))
$app = Join-Path $stage 'kpe'
New-Item -ItemType Directory -Force -Path $app | Out-Null
$xd = @("$Root\.git","$Root\config","$Root\layout","$Root\datalog","$Root\service","$Root\frontend\.dart_tool","$Root\frontend\lib","$Root\frontend\test")
$xf = @('ports.json','api-token.json','access-gate.json','branding.json','*.tar.gz','*.zip','*.log')
$rc = @($Root, $app, '/E','/NFL','/NDL','/NJH','/NJS','/NP','/R:1','/W:1','/XD') + $xd + @('/XF') + $xf
& robocopy @rc | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy staging failed"; exit 1 }

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
  Write-Host "    bundled Node -> vendor\node\node.exe"
} else { Write-Warning "Node not bundled (-NoNode) - target must have node >=18 itself" }

# 4) zip
Write-Host "[4/4] creating .zip ..."
$stamp = Get-Date -Format 'yyyyMMdd'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$out = Join-Path $OutDir "kpe-scada-win-x64-$stamp.zip"
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path $app -DestinationPath $out
Remove-Item $stage -Recurse -Force
Write-Host ""
Write-Host "Done -> $out ($([math]::Round((Get-Item $out).Length/1MB,1)) MB)" -ForegroundColor Green
Write-Host "Take to an offline Windows box: extract zip -> cd kpe\installer\windows -> install_windows.ps1 -Offline"
