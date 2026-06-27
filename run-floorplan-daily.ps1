param(
  [switch]$NoPublish
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$NodeCommand = (Get-Command node -ErrorAction SilentlyContinue).Source
if (!$NodeCommand) {
  $BundledNode = "C:\Users\fujis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $BundledNode) {
    $NodeCommand = $BundledNode
  } else {
    throw "Node.js was not found."
  }
}

New-Item -ItemType Directory -Force -Path "data", "public\data", "crawler-output" | Out-Null

Write-Host "Running daily accepted-floorplan pipeline..."
& $NodeCommand scripts/run-daily-floorplan-growth.mjs

if (!$NoPublish -and (Test-Path -LiteralPath ".\publish-crawl-output.ps1")) {
  Write-Host "Publishing accepted-only public data is handled by the app build/publish flow."
}

Write-Host "Daily floorplan growth finished."
