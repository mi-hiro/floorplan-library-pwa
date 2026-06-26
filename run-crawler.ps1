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
$CrawlerExitCode = $LASTEXITCODE
if ($CrawlerExitCode -ne 0) {
  exit $CrawlerExitCode
}

if ($CrawlerExitCode -eq 0) {
  $HasBraveImageSearch = $env:BRAVE_SEARCH_API_KEY
  $HasGoogleImageSearch = $env:GOOGLE_CUSTOM_SEARCH_API_KEY -and $env:GOOGLE_CUSTOM_SEARCH_CX
  $HasBingImageSearch = $env:BING_IMAGE_SEARCH_KEY
  if ($HasBraveImageSearch -or $HasGoogleImageSearch -or $HasBingImageSearch) {
    $ImageSearchConfig = Join-Path $ProjectRoot "image-search.config.json"
    $ImageSearchExample = Join-Path $ProjectRoot "image-search.config.example.json"
    if (!(Test-Path -LiteralPath $ImageSearchConfig) -and (Test-Path -LiteralPath $ImageSearchExample)) {
      Copy-Item -LiteralPath $ImageSearchExample -Destination $ImageSearchConfig
    }
    if (Test-Path -LiteralPath $ImageSearchConfig) {
      & $Node ".\scripts\image-search-crawler.mjs" "--config" $ImageSearchConfig "--out" $Output "--merge-existing"
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "公式画像検索APIの追加収集に失敗しました。通常巡回の結果だけを公開します。"
      }
    }
  }

  $PublishScript = Join-Path $ProjectRoot "publish-crawl-output.ps1"
  if (Test-Path -LiteralPath $PublishScript) {
    try {
      & $PublishScript -InputPath $Output
    } catch {
      Write-Warning "巡回は完了しましたが、Webへの巡回結果反映に失敗しました: $($_.Exception.Message)"
    }
  }
}
