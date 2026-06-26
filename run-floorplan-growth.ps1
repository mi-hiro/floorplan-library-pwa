param(
  [int]$TargetCount = 1000,
  [int]$PerQuery = 60,
  [int]$MaxQueries = 24,
  [int]$MaxArchivedPages = 80,
  [int]$MaxSitemapDomains = 24,
  [int]$MaxSitemapUrlsPerDomain = 40,
  [int]$LiveSitemapDomains = 3,
  [int]$LiveSitemapUrlsPerDomain = 8,
  [int]$LiveSitemapDelaySeconds = 8,
  [int]$OllamaMaxImages = 80,
  [switch]$NoDuckDuckGo,
  [switch]$NoSitemap,
  [switch]$NoOllama,
  [switch]$NoPublish,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "C:\Users\fujis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$SourceConfig = Join-Path $ProjectRoot "source-discovery.config.json"
$SourceExample = Join-Path $ProjectRoot "source-discovery.config.example.json"
$CommonConfig = Join-Path $ProjectRoot "common-crawl.config.json"
$CommonExample = Join-Path $ProjectRoot "common-crawl.config.example.json"
$CrawlerConfig = Join-Path $ProjectRoot "crawler.config.json"
$OllamaConfig = Join-Path $ProjectRoot "ollama-filter.config.json"
$OllamaExample = Join-Path $ProjectRoot "ollama-filter.config.example.json"
$DiscoveryOutput = Join-Path $ProjectRoot "crawler-output\discovered-sources.json"
$DiscoveredCrawlerConfig = Join-Path $ProjectRoot "crawler-output\discovered-crawler.config.json"
$DiscoveredCrawlerOutput = Join-Path $ProjectRoot ".tmp\discovered-live-crawl.json"
$Output = Join-Path $ProjectRoot "crawler-output\latest-crawl.json"

if (!(Test-Path -LiteralPath $SourceConfig) -and (Test-Path -LiteralPath $SourceExample)) {
  Copy-Item -LiteralPath $SourceExample -Destination $SourceConfig
}
if (!(Test-Path -LiteralPath $CommonConfig) -and (Test-Path -LiteralPath $CommonExample)) {
  Copy-Item -LiteralPath $CommonExample -Destination $CommonConfig
}
if (!(Test-Path -LiteralPath $OllamaConfig) -and (Test-Path -LiteralPath $OllamaExample)) {
  Copy-Item -LiteralPath $OllamaExample -Destination $OllamaConfig
}

Set-Location $ProjectRoot

if (!$NoDuckDuckGo) {
  & $Node ".\scripts\duckduckgo-source-discovery.mjs" `
    "--config" $SourceConfig `
    "--common-crawl-config" $CommonConfig `
    "--out" $DiscoveryOutput `
    "--update-common-crawl"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "DuckDuckGo discovery failed. Continuing with existing sources."
  }
}

if (!$NoSitemap) {
  & $Node ".\scripts\sitemap-seed-expander.mjs" `
    "--common-crawl-config" $CommonConfig `
    "--crawler-config" $CrawlerConfig `
    "--discovery-file" $DiscoveryOutput `
    "--out" $DiscoveryOutput `
    "--write-config" `
    "--max-domains" ([string]$MaxSitemapDomains) `
    "--max-urls-per-domain" ([string]$MaxSitemapUrlsPerDomain)
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Sitemap seed expansion failed. Continuing with existing sources."
  }

  & $Node ".\scripts\build-discovered-crawler-config.mjs" `
    "--discovery-file" $DiscoveryOutput `
    "--base-config" $CrawlerConfig `
    "--existing-crawl" $Output `
    "--out" $DiscoveredCrawlerConfig `
    "--max-domains" ([string]$LiveSitemapDomains) `
    "--max-urls-per-domain" ([string]$LiveSitemapUrlsPerDomain) `
    "--delay-seconds" ([string]$LiveSitemapDelaySeconds)
  if ($LASTEXITCODE -eq 0) {
    & $Node ".\scripts\crawler.mjs" "--config" $DiscoveredCrawlerConfig "--out" $DiscoveredCrawlerOutput
    if ($LASTEXITCODE -eq 0) {
      & $Node ".\scripts\merge-crawl-output.mjs" "--base" $Output "--incoming" $DiscoveredCrawlerOutput "--out" $Output
    } else {
      Write-Warning "Live sitemap crawl failed. Continuing with Common Crawl."
    }
  } else {
    Write-Warning "Could not build discovered crawler config. Continuing with Common Crawl."
  }
}

$CommonArgs = @(
  "--config", $CommonConfig,
  "--out", $Output,
  "--merge-existing",
  "--target-count", [string]$TargetCount,
  "--per-query", [string]$PerQuery,
  "--max-queries", [string]$MaxQueries,
  "--max-archived-pages", [string]$MaxArchivedPages
)
if ($ExtraArgs) {
  $CommonArgs += $ExtraArgs
}

& $Node ".\scripts\common-crawl-candidates.mjs" @CommonArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (!$NoOllama) {
  & $Node ".\scripts\ollama-floorplan-filter.mjs" `
    "--config" $OllamaConfig `
    "--input" $Output `
    "--out" $Output `
    "--max-images" ([string]$OllamaMaxImages)
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Ollama filter failed. Keeping unfiltered crawler output."
  }
}

if (!$NoPublish) {
  $PublishScript = Join-Path $ProjectRoot "publish-crawl-output.ps1"
  if (Test-Path -LiteralPath $PublishScript) {
    try {
      & $PublishScript -InputPath $Output
    } catch {
      Write-Warning ("Growth run finished, but publishing failed: {0}" -f $_.Exception.Message)
    }
  }
}
