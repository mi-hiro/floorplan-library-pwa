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
  Write-Host "image-search.config.json を作成しました。検索語を調整できます。"
}

if (!$env:BRAVE_SEARCH_API_KEY -and !$env:GOOGLE_CUSTOM_SEARCH_API_KEY -and !$env:BING_IMAGE_SEARCH_KEY) {
  Write-Host "公式画像検索APIのキーが未設定です。"
  Write-Host "おすすめ: BRAVE_SEARCH_API_KEY を設定してください。"
  Write-Host "Googleの場合: GOOGLE_CUSTOM_SEARCH_API_KEY と GOOGLE_CUSTOM_SEARCH_CX を設定してください。"
  Write-Host "Bingの場合: BING_IMAGE_SEARCH_KEY を設定してください。"
  Write-Host "キー登録補助: .\set-image-search-keys.ps1"
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
      Write-Warning "画像検索は完了しましたが、Webへの反映に失敗しました: $($_.Exception.Message)"
    }
  }
}
