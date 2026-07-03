param(
  [string]$At = "07:30"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = "Floorplan Library Auto Growth"
$ScriptPath = Join-Path $ProjectRoot "run-auto-floorplan-growth.ps1"

if (!(Test-Path -LiteralPath $ScriptPath)) {
  throw "Auto growth script was not found: $ScriptPath"
}

$Pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (!$Pwsh) {
  $Pwsh = "powershell.exe"
}

$Action = New-ScheduledTaskAction -Execute $Pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -Daily -At $At
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Discover and classify floorplan candidates daily." -Force | Out-Null
Write-Host "Registered task: $TaskName at $At"
