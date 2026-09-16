# KPE SCADA - Windows installer (Windows Service via WinSW - auto-start on boot + restart on crash)
#   Plan: docs/INSTALL-WINDOWS.md - same concept as the Pi installer (install/update/offline/watchdog/uninstall)
#
#   Usage (right-click install_windows.bat > Run as administrator, or):
#     powershell -ExecutionPolicy Bypass -File install_windows.ps1               # install/update (online, idempotent)
#     ... -Offline                                                               # use bundled deps (no network - pair with build-bundle-windows.ps1)
#     ... -Watchdog                                                              # + hang detection (scheduled task polls /api/status -> restart)
#     ... -DataDir "D:\KPE"                                                      # custom data location
#     ... -Action uninstall                                                      # remove the service (keeps files/data)
#
#   WARNING online mode: never copy node_modules between machines - run npm install on THIS machine (needs network).
#   Offline mode: uses vendor\ from the bundle.
#   NOTE: keep this file pure ASCII. Thai/UTF-8 text in .ps1/.bat breaks PowerShell 5.1
#   parsing on customer machines when the BOM is lost in transit (bytes 0x91-0x94 turn
#   into cp874 smart quotes, which PowerShell treats as string delimiters).
param(
  [ValidateSet('install','uninstall')] [string]$Action = 'install',
  [switch]$Offline,
  [switch]$Watchdog,
  [string]$Instance = '',      # multi-instance: node name (empty = single instance, default ports)
  [int]$PortBase = 0,          # base port for the instance (required with -Instance, e.g. 13000)
  [string]$DataDir = "$env:ProgramData\KPE",
  [switch]$UsbLicense          # mode B: USB master key must stay plugged in (unplug = stop now) - sets env KPE_LICENSE_USB=1
)
$ErrorActionPreference = 'Stop'

# multi-instance: separate data dir per instance (unless -DataDir was given explicitly)
if ($Instance -and ($DataDir -eq "$env:ProgramData\KPE")) { $DataDir = "$env:ProgramData\KPE\$Instance" }

# -- self-elevate (installing a service requires Administrator) ----------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "Administrator rights required -> relaunching elevated ..."
  $argline = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action $Action -DataDir `"$DataDir`""
  if ($Offline)  { $argline += " -Offline" }
  if ($Watchdog) { $argline += " -Watchdog" }
  if ($UsbLicense) { $argline += " -UsbLicense" }
  if ($Instance) { $argline += " -Instance `"$Instance`" -PortBase $PortBase" }
  Start-Process powershell.exe $argline -Verb RunAs
  exit
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# -- locate project root (must contain ports.js + backend + manager) -----------
$Root = $ScriptDir
while ($true) {
  if ((Test-Path "$Root\ports.js") -and (Test-Path "$Root\backend") -and (Test-Path "$Root\manager")) { break }
  $parent = Split-Path -Parent $Root
  if (-not $parent -or $parent -eq $Root) { Write-Error "project root not found (needs ports.js + backend + manager)"; exit 1 }
  $Root = $parent
}
Write-Host "Project root: $Root"

# multi-instance: per-instance service name/ports/env-block (default = single instance, stock values)
if ($Instance) {
  if ($PortBase -le 0) { Write-Error "-Instance requires -PortBase (e.g. -PortBase 13000)"; exit 1 }
  $Svc = "kpe-scada-$Instance"
  $pWeb = $PortBase; $pBackend = $PortBase + 1; $pManager = $PortBase + 2; $pDeploy = $PortBase + 3; $pKpenet = $PortBase + 5
  # env-block injected into the WinSW xml - ports + instance name (kpenetwork port inherited by children via process.env)
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

# -- uninstall -----------------------------------------------------------------
if ($Action -eq 'uninstall') {
  if (Test-Path $SvcExe) { & $SvcExe stop 2>$null; & $SvcExe uninstall 2>$null }
  Unregister-ScheduledTask -TaskName $WdTask -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed service '$Svc' + watchdog (program files + data kept)"
  exit 0
}

# -- 1) Node - always prefer vendor\node (bundle) -> system node -> must be >=18 or ERROR
#    (prevents "install succeeded but backend crashes on optional-chaining")
if (Test-Path $VendorNode) {
  $node = $VendorNode
  Write-Host "using bundled Node (vendor\node): $node"
} else {
  if ($Offline) { Write-Warning "Offline requested but vendor\node not found -> using system Node" }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Error "Node.js not found (vendor\node or system) - install Node LTS (>=18) from https://nodejs.org or use the offline bundle (ships with Node)"; exit 1 }
}
$nodeMajor = & $node -p "process.versions.node.split('.')[0]"
if ([int]$nodeMajor -lt 18) {
  Write-Error "Node $(& $node -v) is too old - need >=18 (mssql/mongodb/opcua + optional-chaining) @ $node`n   Fix: install Node LTS (>=18) from https://nodejs.org and open a new PowerShell, or use the offline bundle that ships with Node"
  exit 1
}
Write-Host "Node $(& $node -v) @ $node"

# -- 2) dependencies (backend + manager - each has its own node_modules) --------
if ($Offline) {
  foreach ($m in @('backend','manager')) {
    if (-not (Test-Path (Join-Path $Root "$m\node_modules"))) { Write-Error "offline: $m\node_modules not found (must be bundled by build-bundle-windows.ps1)"; exit 1 }
  }
  Write-Host "using bundled node_modules (backend+manager - skipping npm install)"
} else {
  # Do NOT invoke bare "npm" here: PowerShell resolves it via PATH (usually npm.ps1)
  # and broken shims on customer machines have mangled the args (seen in the field:
  # npm received the command "pm"). Run npm-cli.js with an explicit node.exe instead;
  # fall back to the full path of npm.cmd.
  $sysNode = (Get-Command node -ErrorAction SilentlyContinue).Source
  $npmCli = $null
  if ($sysNode) {
    $cand = Join-Path (Split-Path -Parent $sysNode) 'node_modules\npm\bin\npm-cli.js'
    if (Test-Path $cand) { $npmCli = $cand }
  }
  $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npmCli -and -not $npmCmd) { Write-Error "npm not found (comes with Node.js) - install Node LTS from https://nodejs.org or use the offline bundle"; exit 1 }
  foreach ($m in @('backend','manager')) {
    Write-Host "npm install ($m) ..."
    Push-Location (Join-Path $Root $m)
    if ($npmCli) { & $node $npmCli install --omit=dev }
    else         { & $npmCmd install --omit=dev }
    $code = $LASTEXITCODE; Pop-Location
    if ($code -ne 0) { Write-Error "npm install $m failed (check network / disk space)"; exit 1 }
  }
}

# -- 3) data dir ----------------------------------------------------------------
New-Item -ItemType Directory -Force -Path "$DataDir\config","$DataDir\layout","$DataDir\datalog" | Out-Null
Write-Host "Data dir: $DataDir"

# -- 4) Windows Service (WinSW) --------------------------------------------------
$WinSW = Join-Path $ScriptDir 'WinSW.exe'
if (-not (Test-Path $WinSW)) { Write-Error "WinSW.exe not found in $ScriptDir (must ship with the installer)"; exit 1 }
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

# restrict secret files (api-token/access-gate) to SYSTEM+Admins (NTFS equivalent of perm 0600)
try { icacls "$DataDir\config" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" 2>$null | Out-Null } catch {}

# -- 5) ports (instance = from PortBase, default = from ports.js) -----------------
if ($Instance) {
  $a = @("$pWeb", "$pManager")
} else {
  $pj = ($Root -replace '\\','/') + '/ports.js'
  $pp = & $node -e "const p=require(process.argv[1]).ports();process.stdout.write(p.frontend+' '+p.manager)" "$pj"
  $a = $pp -split ' '
}

# -- 5b) watchdog (opt-in - scheduled task polls /api/status every 1 min -> restart if hung) --
if ($Watchdog) {
  try {
    $mp = $a[1]
    $chk = "try { Invoke-RestMethod -Uri http://127.0.0.1:$mp/api/status -TimeoutSec 5 | Out-Null } catch { Restart-Service $Svc -ErrorAction SilentlyContinue }"
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$chk`""
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $WdTask -Action $act -Trigger $trg -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Write-Host "watchdog installed (checks every 1 minute)"
  } catch { Write-Warning "watchdog install failed: $_" }
}

# -- 6) done ---------------------------------------------------------------------
Write-Host ""
Write-Host "KPE SCADA is running (Windows Service: $Svc - Automatic + restart)" -ForegroundColor Green
if ($Instance) { Write-Host "   Instance  : $Instance  (data: $DataDir - kpenetwork modbus: $pKpenet)" }
Write-Host "   Dashboard : http://localhost:$($a[0])"
Write-Host "   Manager   : http://localhost:$($a[1])"
Write-Host "   Status    : sc query $Svc   |   log: $SvcDir\$Svc.out.log"
if ($Instance) { Write-Host "   Uninstall : install_windows.ps1 -Action uninstall -Instance $Instance" }
else { Write-Host "   Uninstall : install_windows.ps1 -Action uninstall" }
