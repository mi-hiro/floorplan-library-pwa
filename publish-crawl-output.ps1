param(
  [string]$InputPath = "",
  [string]$Repository = "mi-hiro/floorplan-library-pwa",
  [string]$Branch = "gh-pages"
)

$ErrorActionPreference = "Stop"

function Publish-GitHubFile {
  param(
    [string]$Repository,
    [string]$Branch,
    [string]$InputFile,
    [string]$TargetPath,
    [string]$Message
  )

  if (!(Test-Path -LiteralPath $InputFile)) {
    throw "Input file was not found: $InputFile"
  }

  $ResolvedInputPath = (Resolve-Path -LiteralPath $InputFile).Path
  $Content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($ResolvedInputPath))
  $ExistingSha = (& gh api "repos/$Repository/contents/$TargetPath" --method GET -f ref="$Branch" --jq ".sha" 2>$null)
  if ($LASTEXITCODE -ne 0) {
    $ExistingSha = ""
  }

  $Payload = [ordered]@{
    message = $Message
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
      throw "GitHub update failed for $TargetPath. Check GitHub CLI login status."
    }
    Write-Host "Published: $TargetPath"
  } finally {
    if (Test-Path -LiteralPath $TempPayload) {
      Remove-Item -LiteralPath $TempPayload -Force
    }
  }
}

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

Publish-GitHubFile -Repository $Repository -Branch $Branch -InputFile $InputPath -TargetPath "crawler-output/latest-crawl.json" -Message "Update crawler output"

$PublicFloorplans = Join-Path $ProjectRoot "public\data\floorplans.json"
$PublicStats = Join-Path $ProjectRoot "public\data\floorplan-stats.json"
if (Test-Path -LiteralPath $PublicFloorplans) {
  Publish-GitHubFile -Repository $Repository -Branch $Branch -InputFile $PublicFloorplans -TargetPath "data/floorplans.json" -Message "Update accepted floorplan data"
}
if (Test-Path -LiteralPath $PublicStats) {
  Publish-GitHubFile -Repository $Repository -Branch $Branch -InputFile $PublicStats -TargetPath "data/floorplan-stats.json" -Message "Update accepted floorplan stats"
}

Write-Host "Published floorplan data: https://$($Repository.Split('/')[0]).github.io/$($Repository.Split('/')[1])/"
