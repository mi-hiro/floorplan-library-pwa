param(
  [int]$TargetCount = 1000,
  [int]$PerQuery = 0,
  [int]$MaxQueries = 0,
  [int]$MaxArchivedPages = 0,
  [switch]$NoArchivedPages,
  [switch]$NoPublish,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "C:\Users\fujis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Config = Join-Path $ProjectRoot "common-crawl.config.json"
$ExampleConfig = Join-Path $ProjectRoot "common-crawl.config.example.json"
$Output = Join-Path $ProjectRoot "crawler-output\latest-crawl.json"

if (!(Test-Path $Config)) {
  Copy-Item -LiteralPath $ExampleConfig -Destination $Config
  Write-Host "Created common-crawl.config.json. You can edit candidate queries in this file."
}

Set-Location $ProjectRoot
$CrawlerArgs = @(
  "--config", $Config,
  "--out", $Output,
  "--merge-existing",
  "--target-count", [string]$TargetCount
)
if ($PerQuery -gt 0) {
  $CrawlerArgs += @("--per-query", [string]$PerQuery)
}
if ($MaxQueries -gt 0) {
  $CrawlerArgs += @("--max-queries", [string]$MaxQueries)
}
if ($MaxArchivedPages -gt 0) {
  $CrawlerArgs += @("--max-archived-pages", [string]$MaxArchivedPages)
}
if ($NoArchivedPages) {
  $CrawlerArgs += @("--fetch-archived-pages", "false")
}
if ($ExtraArgs) {
  $CrawlerArgs += $ExtraArgs
}

& $Node ".\scripts\common-crawl-candidates.mjs" @CrawlerArgs
$CommonCrawlExitCode = $LASTEXITCODE
if ($CommonCrawlExitCode -ne 0) {
  exit $CommonCrawlExitCode
}

if (!$NoPublish) {
  $PublishScript = Join-Path $ProjectRoot "publish-crawl-output.ps1"
  if (Test-Path -LiteralPath $PublishScript) {
    try {
      & $PublishScript -InputPath $Output
    } catch {
      Write-Warning ("Common Crawl finished, but publishing failed: {0}" -f $_.Exception.Message)
    }
  }
}
