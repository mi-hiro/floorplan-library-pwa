param(
  [string]$TaskName = "Floorplan Library Auto Growth",
  [string]$At = "07:30"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunScript = Join-Path $ProjectRoot "run-auto-floorplan-growth.ps1"
$PowerShell = "C:\Program Files\PowerShell\7\pwsh.exe"

if (!(Test-Path -LiteralPath $RunScript)) {
  throw "Run script was not found: $RunScript"
}

if (!(Test-Path -LiteralPath $PowerShell)) {
  $PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
}

$action = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Daily automatic growth run for Floorplan Library PWA" `
  -Force | Out-Null

Write-Host "Registered: $TaskName"
Write-Host "Schedule: Daily $At"
Write-Host "Script: $RunScript"
