param(
  [string]$InputPath = ".tmp\chrome-search-links.txt",
  [string]$ConfigPath = "chrome-discovery.config.json",
  [string]$DiscoveryPath = "crawler-output\discovered-sources.json",
  [string]$OutPath = "crawler-output\chrome-discovered-sources.json",
  [int]$MaxDomains = 12,
  [int]$MaxUrlsPerDomain = 8,
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
  Write-Host "Input file was not found: $InputPath"
  Write-Host "Paste Chrome search result links into this file, then run again."
  exit 1
}

Write-Host "Importing Chrome search source URLs..."
& $NodeCommand scripts/chrome-search-source-discovery.mjs --config $ConfigPath --input $InputPath --discovery-file $DiscoveryPath --out $OutPath --update-common-crawl

Write-Host "Building crawler config from discovered sources..."
& $NodeCommand scripts/build-discovered-crawler-config.mjs --discovery-file $DiscoveryPath --base-config crawler.config.json --existing-crawl crawler-output/latest-crawl.json --out crawler-output/discovered-crawler.config.json --max-domains $MaxDomains --max-urls-per-domain $MaxUrlsPerDomain --delay-seconds $DelaySeconds

Write-Host "Chrome discovery finished."
Write-Host "Next: run .\run-floorplan-growth.ps1 -NoPublish first, then publish after checking results."
