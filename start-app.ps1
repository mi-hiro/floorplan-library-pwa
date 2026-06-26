$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "C:\Users\fujis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Vite = Join-Path $ProjectRoot "node_modules\vite\bin\vite.js"

Set-Location $ProjectRoot

Write-Host "Starting Floorplan Library..."
Write-Host "URL: http://127.0.0.1:5173/"
& $Node $Vite --host 127.0.0.1 --port 5173
