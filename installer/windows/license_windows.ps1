# KPE SCADA - License (Windows) - machine-id / activate / remove / status
#   Equivalent to install_pi.sh --show-id / --activate (see docs/LICENSING-WINDOWS.md)
#
#   Usage (PowerShell; -Activate/-Remove need Administrator):
#     powershell -ExecutionPolicy Bypass -File license_windows.ps1 -ShowId        # show machine-id + fingerprint (give to vendor)
#     ... -Status                                                                  # current license status
#     ... -Activate                                                                # scan USB for license.key -> install -> restart service
#     ... -Activate -License "D:\license.key"                                      # specify a file path
#     ... -Activate -License "<base64 license content>"                            # paste the license content directly
#     ... -Remove                                                                  # remove license (kept as backup)
#     ... -DataDir "D:\KPE"  -Svc "kpe-scada"                                       # override data dir / service name
param(
  [switch]$ShowId,
  [switch]$Status,
  [switch]$Activate,
  [switch]$Remove,
  [string]$License = '',
  [string]$DataDir = "$env:ProgramData\KPE",
  [string]$Svc = 'kpe-scada'
)
$ErrorActionPreference = 'Stop'

# -- find project root (installer\windows\ -> up 2 levels) + node --
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$RootFwd = $Root -replace '\\', '/'
$node = Join-Path $Root 'vendor\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Error "Node not found (vendor\node\node.exe or node in PATH)"; exit 1 }

$ConfigDir = Join-Path $DataDir 'config'
$LicFile   = Join-Path $ConfigDir 'license.key'
$LicFileFwd = $LicFile -replace '\\', '/'

# helper: call licenseManager via node (enforce=1 so verify runs) - returns stdout
function Invoke-Lic([string]$body) {
  $script = "const L=require('$RootFwd/backend/src/licenseManager');const l=new L();l.setLicenseFile('$LicFileFwd');$body"
  $env:KPE_ENFORCE = '1'
  & $node -e $script
}

# -- -ShowId : machine-id + fingerprint (no admin needed) --
if ($ShowId) {
  Invoke-Lic "console.log('platform   :', l.platform());console.log('machine-id :', l.machineIdShort());console.log('fingerprint:', l.fingerprint());"
  exit 0
}

# -- -Status : current license status --
if ($Status) {
  Invoke-Lic "const s=l.status();console.log(JSON.stringify({ok:s.ok,reason:s.reason,tier:s.tier,features:s.features,enforced:s.enforced,platform:s.platform,machineId:s.machineId,customer:s.customer},null,2));"
  exit 0
}

# -- -Remove : remove license (backup) + restart --
if ($Remove) {
  Invoke-Lic "console.log(JSON.stringify(l.remove()));"
  & (Join-Path $Root "service\$Svc.exe") restart 2>$null
  Write-Host "License removed (kept as backup) - service restarted"
  exit 0
}

# -- -Activate : install license from a file path, pasted base64 content, or USB scan -> restart --
if ($Activate) {
  $b64 = ''
  $src = $License.Trim()
  if ($src) {
    if (Test-Path -LiteralPath $src) {
      $b64 = (Get-Content -Raw -LiteralPath $src).Trim() -replace '\s', ''
      Write-Host "Found license file: $src"
    } else {
      # not a path -> user may have pasted the license content (base64) directly
      $cand = $src -replace '\s', ''
      if ($cand.Length -gt 80 -and $cand -match '^[A-Za-z0-9+/=]+$') {
        try {
          $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($cand))
          if ($json -match '"sig"') { $b64 = $cand; Write-Host "Using pasted license content" }
        } catch {}
      }
      if (-not $b64) { Write-Error "Not a file path, and not valid license content: $src"; exit 1 }
    }
  } else {
    # scan removable drives (DriveType=2) for license.key
    foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2")) {
      $p = Join-Path $d.DeviceID 'license.key'
      if (Test-Path $p) { $b64 = (Get-Content -Raw -Path $p).Trim() -replace '\s', ''; Write-Host "Found license: $p"; break }
    }
    if (-not $b64) { Write-Error "license.key not found (plug a USB with the file, paste the license content, or use -License <path>)"; exit 1 }
  }
  if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }
  $b64Fwd = $b64 -replace "'", "\'"
  $out = Invoke-Lic "const r=l.install('$b64Fwd');console.log(JSON.stringify({ok:r.ok,reason:r.reason,tier:r.tier,customer:r.customer}));"
  Write-Host $out
  if ($out -match '"ok":true') {
    & (Join-Path $Root "service\$Svc.exe") restart 2>$null
    Write-Host "OK - license installed + service restarted"
    exit 0
  } else {
    Write-Error "License install failed (see reason above) - existing file untouched"
    exit 1
  }
}

Write-Host "Specify an action: -ShowId | -Status | -Activate [-License <path>] | -Remove   (see header)"
