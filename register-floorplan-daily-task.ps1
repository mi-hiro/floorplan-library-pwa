param(
  [string]$At = "03:30"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = "Floorplan Library Accepted Daily Growth"
$ScriptPath = Join-Path $ProjectRoot "run-floorplan-daily.ps1"

if (!(Test-Path -LiteralPath $ScriptPath)) {
  throw "Daily script was not found: $ScriptPath"
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -Daily -At $At
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Collect and promote accepted floorplans daily." -Force | Out-Null
Write-Host "Registered task: $TaskName at $At"
