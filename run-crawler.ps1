$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "C:\Users\fujis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Config = Join-Path $ProjectRoot "crawler.config.json"
$ExampleConfig = Join-Path $ProjectRoot "crawler.config.example.json"
$Output = Join-Path $ProjectRoot "crawler-output\latest-crawl.json"

if (!(Test-Path $Config)) {
  Copy-Item -LiteralPath $ExampleConfig -Destination $Config
  Write-Host "crawler.config.json を作成しました。巡回したいサイトを enabled: true にして、searchUrl か manualUrls を設定してください。"
  Write-Host "設定後にもう一度 .\run-crawler.ps1 を実行してください。"
  exit 0
}

Set-Location $ProjectRoot
& $Node ".\scripts\crawler.mjs" "--config" $Config "--out" $Output @args
