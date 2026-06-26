param(
  [int]$BatchSize = 3,
  [int]$QueriesPerPrefecture = 4,
  [string]$InputPath = ".tmp\prefecture-search-links.json",
  [string]$ConfigPath = "prefecture-discovery.config.json",
  [string]$StatePath = "crawler-output\prefecture-discovery-state.json",
  [string]$BatchPath = ".tmp\prefecture-search-batch.json",
  [string]$QueryTextPath = ".tmp\prefecture-search-queries.txt",
  [int]$MaxDomains = 16,
  [int]$MaxUrlsPerDomain = 6,
  [int]$DelaySeconds = 8
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
    throw "Node.js was not found. Please install Node.js, then run this script again."
  }
}

if (!(Test-Path -LiteralPath $InputPath)) {
  Write-Host "Preparing next prefecture search batch..."
  & $NodeCommand scripts/prefecture-rotation-discovery.mjs `
    --config $ConfigPath `
    --state $StatePath `
    --out $BatchPath `
    --text-out $QueryTextPath `
    --batch-size ([string]$BatchSize) `
    --queries-per-prefecture ([string]$QueriesPerPrefecture)

  Write-Host ""
  Write-Host "Search queries were written to: $QueryTextPath"
  Write-Host "After collecting Chrome source links, save them to: $InputPath"
  Write-Host "Then run this script again."
  exit 0
}

Write-Host "Importing prefecture source links..."
& $NodeCommand scripts/chrome-search-source-discovery.mjs `
  --config chrome-discovery.config.json `
  --input $InputPath `
  --discovery-file crawler-output/discovered-sources.json `
  --out crawler-output/prefecture-discovered-sources.json `
  --update-common-crawl

Write-Host "Building crawler config from accumulated sources..."
& $NodeCommand scripts/build-discovered-crawler-config.mjs `
  --discovery-file crawler-output/discovered-sources.json `
  --base-config crawler.config.json `
  --existing-crawl crawler-output/latest-crawl.json `
  --out crawler-output/discovered-crawler.config.json `
  --max-domains ([string]$MaxDomains) `
  --max-urls-per-domain ([string]$MaxUrlsPerDomain) `
  --delay-seconds ([string]$DelaySeconds)

$ArchivePath = ".tmp\prefecture-search-links-imported-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss")
Move-Item -LiteralPath $InputPath -Destination $ArchivePath -Force

Write-Host "Advancing prefecture rotation after import..."
& $NodeCommand scripts/prefecture-rotation-discovery.mjs `
  --config $ConfigPath `
  --state $StatePath `
  --out $BatchPath `
  --text-out $QueryTextPath `
  --batch-size ([string]$BatchSize) `
  --queries-per-prefecture ([string]$QueriesPerPrefecture) `
  --advance

Write-Host "Preparing the next search batch..."
& $NodeCommand scripts/prefecture-rotation-discovery.mjs `
  --config $ConfigPath `
  --state $StatePath `
  --out $BatchPath `
  --text-out $QueryTextPath `
  --batch-size ([string]$BatchSize) `
  --queries-per-prefecture ([string]$QueriesPerPrefecture)

Write-Host "Prefecture discovery finished."
Write-Host "Existing discovered sources were kept and new sources were merged."
Write-Host "Imported links were archived to: $ArchivePath"
