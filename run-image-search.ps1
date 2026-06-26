param(
  [ValidateSet("auto", "brave", "google", "bing")]
  [string]$Provider = "auto",
  [int]$TargetCount = 1000,
  [int]$PerQuery = 0,
  [switch]$NoPublish,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "C:\Users\fujis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Config = Join-Path $ProjectRoot "image-search.config.json"
$ExampleConfig = Join-Path $ProjectRoot "image-search.config.example.json"
$Output = Join-Path $ProjectRoot "crawler-output\latest-crawl.json"

if (!(Test-Path $Config)) {
  Copy-Item -LiteralPath $ExampleConfig -Destination $Config
  Write-Host "Created image-search.config.json. You can edit search queries in this file."
}

if (!$env:BRAVE_SEARCH_API_KEY -and !$env:GOOGLE_CUSTOM_SEARCH_API_KEY -and !$env:BING_IMAGE_SEARCH_KEY) {
  Write-Host "Image search API key is not set."
  Write-Host "Recommended: set BRAVE_SEARCH_API_KEY."
  Write-Host "Google: set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_CX."
  Write-Host "Bing: set BING_IMAGE_SEARCH_KEY."
  Write-Host "Setup helper: .\set-image-search-keys.ps1"
  exit 1
}

Set-Location $ProjectRoot
$CrawlerArgs = @(
  "--config", $Config,
  "--out", $Output,
  "--merge-existing",
  "--provider", $Provider,
  "--target-count", [string]$TargetCount
)
if ($PerQuery -gt 0) {
  $CrawlerArgs += @("--per-query", [string]$PerQuery)
}
if ($ExtraArgs) {
  $CrawlerArgs += $ExtraArgs
}

& $Node ".\scripts\image-search-crawler.mjs" @CrawlerArgs
$ImageSearchExitCode = $LASTEXITCODE
if ($ImageSearchExitCode -ne 0) {
  exit $ImageSearchExitCode
}

if (!$NoPublish) {
  $PublishScript = Join-Path $ProjectRoot "publish-crawl-output.ps1"
  if (Test-Path -LiteralPath $PublishScript) {
    try {
      & $PublishScript -InputPath $Output
    } catch {
      Write-Warning ("Image search finished, but publishing failed: {0}" -f $_.Exception.Message)
    }
  }
}
