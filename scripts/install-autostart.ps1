# Make ABUZ8 an always-on operator: register a Task Scheduler task that launches
# it at logon. Default = windowed; -Headless = daemon (API + scheduler, no window).
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1            # windowed at logon
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Headless  # headless daemon
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall # remove
param([switch]$Headless, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskName = 'ABUZ8 Operator'

if ($Uninstall) {
  try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Write-Host "Removed '$taskName' from startup." }
  catch { Write-Host "No '$taskName' task found." }
  return
}

$candidates = @(
  "$env:LOCALAPPDATA\Programs\ABUZ8 OS\ABUZ8 OS.exe",
  "$env:LOCALAPPDATA\ABUZ8 OS\ABUZ8 OS\ABUZ8 OS.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "ABUZ8 OS.exe not found. Install ABUZ8 first." }

$arg = ''
$mode = 'windowed'
if ($Headless) { $arg = '--server'; $mode = 'headless daemon' }

$action   = New-ScheduledTaskAction -Execute $exe -Argument $arg
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "ABUZ8 will now start at logon ($mode): $exe $arg"
Write-Host "Kill switch anytime: curl -X POST http://127.0.0.1:8900/api/halt"
