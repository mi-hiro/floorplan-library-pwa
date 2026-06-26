param(
  [string]$TaskName = "Floorplan Library Local Crawler",
  [string]$At = "03:30",
  [ValidateSet("Daily", "Weekly")]
  [string]$Schedule = "Weekly"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunScript = Join-Path $ProjectRoot "run-crawler.ps1"
$PowerShell = "C:\Program Files\PowerShell\7\pwsh.exe"

if (!(Test-Path $PowerShell)) {
  $PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
}

$action = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`""
$trigger = if ($Schedule -eq "Daily") {
  New-ScheduledTaskTrigger -Daily -At $At
} else {
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $At
}
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Low-frequency local crawler for Floorplan Library PWA" -Force | Out-Null

Write-Host "登録しました: $TaskName"
Write-Host "スケジュール: $Schedule $At"
Write-Host "実行内容: $RunScript"
