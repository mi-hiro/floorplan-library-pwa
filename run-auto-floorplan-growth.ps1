param(
  [int]$BatchSize = 3,
  [int]$QueriesPerPrefecture = 6,
  [int]$MaxSearchQueries = 36,
  [int]$MaxDomains = 18,
  [int]$MaxUrlsPerDomain = 8,
  [int]$DelaySeconds = 8,
  [int]$CommonTargetCount = 1000,
  [int]$CommonPerQuery = 60,
  [int]$CommonMaxQueries = 32,
  [int]$CommonMaxArchivedPages = 80,
  [int]$OllamaMaxImages = 160,
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

New-Item -ItemType Directory -Force -Path ".tmp", "crawler-output" | Out-Null

$BatchPath = ".tmp\prefecture-auto-batch.json"
$QueryTextPath = ".tmp\prefecture-auto-queries.txt"
$TempSourceConfig = ".tmp\prefecture-source-discovery.config.json"
$DiscoveryOutput = "crawler-output\discovered-sources.json"
$DiscoveredCrawlerConfig = "crawler-output\discovered-crawler.config.json"
$LiveCrawlOutput = ".tmp\auto-live-crawl.json"
$LatestOutput = "crawler-output\latest-crawl.json"

Write-Host "Preparing prefecture batch..."
& $NodeCommand scripts/prefecture-rotation-discovery.mjs `
  --config prefecture-discovery.config.json `
  --state crawler-output/prefecture-discovery-state.json `
  --out $BatchPath `
  --text-out $QueryTextPath `
  --batch-size ([string]$BatchSize) `
  --queries-per-prefecture ([string]$QueriesPerPrefecture)

Write-Host "Preparing source discovery queries..."
& $NodeCommand scripts/build-prefecture-source-config.mjs `
  --batch $BatchPath `
  --base-config source-discovery.config.json `
  --out $TempSourceConfig `
  --max-queries ([string]$MaxSearchQueries)

Write-Host "Discovering builder and housing-company source pages..."
& $NodeCommand scripts/duckduckgo-source-discovery.mjs `
  --config $TempSourceConfig `
  --common-crawl-config common-crawl.config.json `
  --out $DiscoveryOutput `
  --update-common-crawl
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Source discovery failed. Continuing with accumulated sources."
}

Write-Host "Adding more domains from Common Crawl..."
& $NodeCommand scripts/common-crawl-domain-discovery.mjs `
  --config common-crawl.config.json `
  --discovery-file $DiscoveryOutput `
  --out crawler-output\common-crawl-domains.json `
  --max-queries ([string]$CommonMaxQueries) `
  --per-query ([string]$CommonPerQuery) `
  --target-domains 300
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Common Crawl domain discovery failed. Continuing."
}

Write-Host "Checking sitemaps for deeper pages..."
& $NodeCommand scripts/sitemap-seed-expander.mjs `
  --common-crawl-config common-crawl.config.json `
  --crawler-config crawler.config.json `
  --discovery-file $DiscoveryOutput `
  --out $DiscoveryOutput `
  --write-config `
  --max-domains ([string]$MaxDomains) `
  --max-urls-per-domain 60
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Sitemap expansion failed. Continuing."
}

Write-Host "Building low-frequency crawler config..."
& $NodeCommand scripts/build-discovered-crawler-config.mjs `
  --discovery-file $DiscoveryOutput `
  --base-config crawler.config.json `
  --existing-crawl $LatestOutput `
  --out $DiscoveredCrawlerConfig `
  --max-domains ([string]$MaxDomains) `
  --max-urls-per-domain ([string]$MaxUrlsPerDomain) `
  --delay-seconds ([string]$DelaySeconds)

Write-Host "Crawling discovered source pages..."
& $NodeCommand scripts/crawler.mjs `
  --config $DiscoveredCrawlerConfig `
  --out $LiveCrawlOutput `
  --loose-image-candidates true
if ($LASTEXITCODE -eq 0) {
  & $NodeCommand scripts/merge-crawl-output.mjs `
    --base $LatestOutput `
    --incoming $LiveCrawlOutput `
    --out $LatestOutput
} else {
  Write-Warning "Live crawl failed. Continuing with Common Crawl."
}

Write-Host "Collecting archived candidates from Common Crawl..."
& $NodeCommand scripts/common-crawl-candidates.mjs `
  --config common-crawl.config.json `
  --out $LatestOutput `
  --merge-existing `
  --target-count ([string]$CommonTargetCount) `
  --per-query ([string]$CommonPerQuery) `
  --max-queries ([string]$CommonMaxQueries) `
  --max-archived-pages ([string]$CommonMaxArchivedPages) `
  --loose-image-candidates true
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Common Crawl candidate collection failed. Continuing."
}

Write-Host "Reviewing candidates with Ollama..."
& $NodeCommand scripts/ollama-floorplan-filter.mjs `
  --config ollama-filter.config.json `
  --input $LatestOutput `
  --out $LatestOutput `
  --max-images ([string]$OllamaMaxImages)
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Ollama review failed. Keeping crawler output."
}

Write-Host "Cleaning room and exterior image candidates..."
& $NodeCommand scripts/clean-crawl-output.mjs `
  --input $LatestOutput `
  --out $LatestOutput
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Crawl output cleanup failed. Keeping crawler output."
}

Write-Host "Advancing prefecture rotation..."
& $NodeCommand scripts/prefecture-rotation-discovery.mjs `
  --config prefecture-discovery.config.json `
  --state crawler-output/prefecture-discovery-state.json `
  --out $BatchPath `
  --text-out $QueryTextPath `
  --batch-size ([string]$BatchSize) `
  --queries-per-prefecture ([string]$QueriesPerPrefecture) `
  --advance

if (!$NoPublish) {
  Write-Host "Publishing latest crawl output..."
  & ".\publish-crawl-output.ps1" -InputPath $LatestOutput
}

Write-Host "Auto floorplan growth finished."
