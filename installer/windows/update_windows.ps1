# KPE SCADA - Windows update (replace program - keep data/ports/secrets - restart)
#   Same concept as update_pi.sh - accepts a deploy tarball (.tar.gz online) or offline bundle (.zip with vendor/)
#
#   Usage (Run as administrator):
#     powershell -ExecutionPolicy Bypass -File update_windows.ps1 <new.tar.gz|.zip>
#     powershell -ExecutionPolicy Bypass -File update_windows.ps1            # auto: newest kpe-*.tar.gz/.zip in this folder
#
#   Steps: stop service -> extract tarball -> robocopy over program (keep data/ports/secrets) -> install_windows.ps1 -> start
#   WARNING: never copy node_modules between machines - online mode runs npm install on Windows, offline uses the bundle.
#   NOTE: keep this file pure ASCII (see install_windows.ps1 header for why).
param([string]$Tarball, [string]$DataDir = "$env:ProgramData\KPE")
$ErrorActionPreference = 'Stop'

# -- self-elevate ---------------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  $al = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Tarball) { $al += " `"$Tarball`"" }
  $al += " -DataDir `"$DataDir`""
  Start-Process powershell.exe $al -Verb RunAs
  exit
}

# -- re-exec from TEMP - so robocopy cannot overwrite this script while it runs --
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

# -- real project root (walk up from the installer dir) -------------------------
$Root = $InstallerDir
while ($true) {
  if ((Test-Path "$Root\ports.js") -and (Test-Path "$Root\backend") -and (Test-Path "$Root\manager")) { break }
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { Write-Error "installed project root not found"; exit 1 }
  $Root = $parent
}

# -- locate tarball --------------------------------------------------------------
if (-not $Tarball) {
  $cand = Get-ChildItem -Path $InstallerDir -Filter 'kpe-*' -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '\.(tar\.gz|zip)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($cand) { $Tarball = $cand.FullName; Write-Warning "no tarball given -> using newest: $($cand.Name)" }
}
if (-not $Tarball -or -not (Test-Path $Tarball)) { Write-Error "tarball not found - usage: update_windows.ps1 <file.tar.gz|.zip>"; exit 1 }
Write-Host "Project root: $Root"
Write-Host "New tarball : $Tarball"

$Svc = 'kpe-scada'
$SvcExe = Join-Path $Root "service\$Svc.exe"

# -- 1) stop ---------------------------------------------------------------------
Write-Host "[1/4] stopping service ..."
if (Test-Path $SvcExe) { & $SvcExe stop 2>$null; Start-Sleep -Seconds 2 }

# -- 2) extract ------------------------------------------------------------------
Write-Host "[2/4] extracting tarball ..."
$tmpx = Join-Path $env:TEMP ("kpe-ext-" + ([guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Force -Path $tmpx | Out-Null
if ($Tarball -match '\.zip$') { Expand-Archive -Path $Tarball -DestinationPath $tmpx -Force }
else { & tar -xzf $Tarball -C $tmpx }   # Windows 10+ ships tar
$Src = Join-Path $tmpx 'kpe'
if (-not (Test-Path $Src)) { Write-Error "tarball has no kpe\ folder (use output of stage-deploy.sh / build-bundle-windows.ps1)"; Remove-Item $tmpx -Recurse -Force; exit 1 }

# offline? = bundle ships node_modules/vendor
$offline = (Test-Path "$Src\vendor\node") -or (Test-Path "$Src\backend\node_modules")
Write-Host ("    -> " + ($(if($offline){'offline bundle (has node_modules/vendor)'}else{'deploy tarball (online)'})))

# -- 3) replace program (robocopy /E overwrite - keep data/ports/secrets - skip service\) --
Write-Host "[3/4] replacing program ..."
# /XD: data dirs + service (running/locked) - online also keeps existing node_modules
$xd = @("$Src\config","$Src\layout","$Src\datalog","$Root\config","$Root\layout","$Root\datalog","$Root\service")
if (-not $offline) { $xd += @("$Root\backend\node_modules","$Root\manager\node_modules") }
$xf = @('ports.json','api-token.json','access-gate.json','branding.json')
$rcArgs = @($Src, $Root, '/E', '/NFL','/NDL','/NJH','/NJS','/NP','/R:1','/W:1','/XD') + $xd + @('/XF') + $xf
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy failed (code $LASTEXITCODE)"; Remove-Item $tmpx -Recurse -Force; exit 1 }
Remove-Item $tmpx -Recurse -Force
Write-Host "    program replaced (existing data/ports/secrets kept)"

# -- 4) install deps + restart (via the freshly-updated install_windows.ps1) ------
Write-Host "[4/4] installing deps + restart ..."
$inst = Join-Path $Root 'installer\windows\install_windows.ps1'
if (-not (Test-Path $inst)) { Write-Error "install_windows.ps1 not found in tarball"; exit 1 }
$ia = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$inst,'-DataDir',$DataDir)
if ($offline) { $ia += '-Offline' }
& powershell.exe @ia

Write-Host ""
Write-Host "Update done - existing data/ports/secrets all kept" -ForegroundColor Green
Write-Host "   Check: sc query $Svc"
