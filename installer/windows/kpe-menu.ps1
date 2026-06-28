# KPE SCADA - Install / License menu (Windows)
#   Double-click KPE-Setup-Windows.bat, or:
#     powershell -ExecutionPolicy Bypass -File installer\windows\kpe-menu.ps1
#   Wraps install_windows.ps1 + license_windows.ps1 in one menu (no flags to remember).

# keep window open on error (so the message is readable)
trap { Write-Host ''; Write-Host ("ERROR: " + $_) -ForegroundColor Red; Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray; Read-Host 'Press Enter to close'; exit 1 }
$ErrorActionPreference = 'Stop'

# -- self-elevate (install/activate/remove need Administrator) --
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "Administrator required -> reopening elevated ..."
  Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File',$PSCommandPath
  exit
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Install = Join-Path $ScriptDir 'install_windows.ps1'
$License = Join-Path $ScriptDir 'license_windows.ps1'
function Run-PS([string]$file, [string[]]$psArgs) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file @psArgs
}

$run = $true
while ($run) {
  Clear-Host
  Write-Host ''
  Write-Host '  ============================================='
  Write-Host '    KPE SCADA - Install / License (Windows)'
  Write-Host '  ============================================='
  Write-Host ''
  Write-Host '   -- Install --'
  Write-Host '   1) Install / Update  (Windows Service)'
  Write-Host '   2) Install with USB-always-plugged  (mode B)'
  Write-Host '   i) Install AS INSTANCE  (multi-node - asks name + port base)'
  Write-Host ''
  Write-Host '   -- License --'
  Write-Host '   3) Show machine-id   (send to vendor)'
  Write-Host '   4) Activate license from USB'
  Write-Host '   5) License status'
  Write-Host '   6) Remove license'
  Write-Host ''
  Write-Host '   -- Other --'
  Write-Host '   7) Open Manager   (:5012)'
  Write-Host '   8) Open HMI / SCADA   (:3012)'
  Write-Host '   9) Uninstall service   (keeps data)'
  Write-Host '   u) Uninstall an INSTANCE  (asks name)'
  Write-Host '   0) Exit'
  Write-Host ''
  $c = Read-Host '  Select (0-9, i, u)'
  Write-Host ''
  switch ($c) {
    '1' { Run-PS $Install @() }
    '2' { Run-PS $Install @('-UsbLicense') }
    'i' {
      $name = Read-Host '  Instance name (e.g. node2)'
      $base = if ($name) { Read-Host '  Port base (e.g. 13000 - uses base..base+5)' } else { '' }
      if ($name -and ($base -match '^\d+$')) { Run-PS $Install @('-Instance',$name,'-PortBase',$base) }
      else { Write-Host '  cancelled (need a name + numeric port base)' -ForegroundColor Yellow }
    }
    'u' {
      $name = Read-Host '  Instance name to uninstall (e.g. node2)'
      if ($name) { Run-PS $Install @('-Action','uninstall','-Instance',$name) }
      else { Write-Host '  cancelled (no name)' -ForegroundColor Yellow }
    }
    '3' { Run-PS $License @('-ShowId') }
    '4' {
      $p = Read-Host '  Path to license.key, or paste its content (Enter = auto-scan USB)'
      if ($p) { Run-PS $License @('-Activate','-License',$p) } else { Run-PS $License @('-Activate') }
    }
    '5' { Run-PS $License @('-Status') }
    '6' { Run-PS $License @('-Remove') }
    '7' { Start-Process 'http://localhost:5012' }
    '8' { Start-Process 'http://localhost:3012' }
    '9' { Run-PS $Install @('-Action','uninstall') }
    '0' { $run = $false }
    default { Write-Host '  Invalid choice' }
  }
  if ($run -and $c -ne '7' -and $c -ne '8') { Write-Host ''; Read-Host '  Press Enter to return to menu' | Out-Null }
}
