param(
  [string]$InputPath = "",
  [string]$Repository = "mi-hiro/floorplan-library-pwa",
  [string]$Branch = "gh-pages"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($InputPath)) {
  $InputPath = Join-Path $ProjectRoot "crawler-output\latest-crawl.json"
}

if (!(Test-Path -LiteralPath $InputPath)) {
  throw "Crawler output JSON was not found: $InputPath"
}

$GhCommand = Get-Command gh -ErrorAction SilentlyContinue
if (!$GhCommand) {
  Write-Warning "GitHub CLI was not found. Skipping publish."
  exit 0
}

$TargetPath = "crawler-output/latest-crawl.json"
$ResolvedInputPath = (Resolve-Path -LiteralPath $InputPath).Path
$Content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($ResolvedInputPath))
$ExistingSha = (& gh api "repos/$Repository/contents/$TargetPath" --method GET -f ref="$Branch" --jq ".sha" 2>$null)
if ($LASTEXITCODE -ne 0) {
  $ExistingSha = ""
}

$Payload = [ordered]@{
  message = "Update crawler output"
  branch = $Branch
  content = $Content
}
if (![string]::IsNullOrWhiteSpace($ExistingSha)) {
  $Payload.sha = $ExistingSha.Trim()
}

$TempPayload = Join-Path ([IO.Path]::GetTempPath()) ("floorplan-crawl-publish-{0}.json" -f ([guid]::NewGuid()))
try {
  $Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [IO.File]::WriteAllText($TempPayload, ($Payload | ConvertTo-Json -Depth 5), $Utf8NoBom)
  & gh api "repos/$Repository/contents/$TargetPath" --method PUT --input $TempPayload --silent
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub update failed. Check GitHub CLI login status."
  }
  Write-Host "Published crawler output: https://$($Repository.Split('/')[0]).github.io/$($Repository.Split('/')[1])/$TargetPath"
} finally {
  if (Test-Path -LiteralPath $TempPayload) {
    Remove-Item -LiteralPath $TempPayload -Force
  }
}
