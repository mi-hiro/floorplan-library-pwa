param(
  [string]$BraveSearchApiKey = "",
  [string]$GoogleCustomSearchApiKey = "",
  [string]$GoogleCustomSearchCx = "",
  [string]$BingImageSearchKey = "",
  [switch]$Clear
)

$ErrorActionPreference = "Stop"

$EnvNames = @(
  "BRAVE_SEARCH_API_KEY",
  "GOOGLE_CUSTOM_SEARCH_API_KEY",
  "GOOGLE_CUSTOM_SEARCH_CX",
  "BING_IMAGE_SEARCH_KEY"
)

function Convert-SecureStringToPlainText {
  param([Security.SecureString]$SecureValue)
  if (!$SecureValue) {
    return ""
  }
  $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
  }
}

function Read-OptionalSecret {
  param([string]$Prompt)
  $SecureValue = Read-Host $Prompt -AsSecureString
  return Convert-SecureStringToPlainText $SecureValue
}

function Set-ImageSearchEnvironmentValue {
  param(
    [string]$Name,
    [string]$Value
  )
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return
  }
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  Write-Host "設定しました: $Name"
}

function Clear-ImageSearchEnvironmentValue {
  param([string]$Name)
  [Environment]::SetEnvironmentVariable($Name, $null, "User")
  [Environment]::SetEnvironmentVariable($Name, $null, "Process")
  Write-Host "削除しました: $Name"
}

if ($Clear) {
  foreach ($Name in $EnvNames) {
    Clear-ImageSearchEnvironmentValue $Name
  }
  Write-Host "画像検索APIキーを削除しました。"
  exit 0
}

$HasDirectValue =
  $PSBoundParameters.ContainsKey("BraveSearchApiKey") -or
  $PSBoundParameters.ContainsKey("GoogleCustomSearchApiKey") -or
  $PSBoundParameters.ContainsKey("GoogleCustomSearchCx") -or
  $PSBoundParameters.ContainsKey("BingImageSearchKey")

if (!$HasDirectValue) {
  Write-Host "間取り図の大量収集には、画像検索APIキーが必要です。"
  Write-Host "今から使うなら Brave Search API の BRAVE_SEARCH_API_KEY が一番進めやすいです。"
  Write-Host "使わない項目はEnterで空のまま進めてください。"
  $BraveSearchApiKey = Read-OptionalSecret "BRAVE_SEARCH_API_KEY"
  $GoogleCustomSearchApiKey = Read-OptionalSecret "GOOGLE_CUSTOM_SEARCH_API_KEY"
  $GoogleCustomSearchCx = Read-Host "GOOGLE_CUSTOM_SEARCH_CX"
  $BingImageSearchKey = Read-OptionalSecret "BING_IMAGE_SEARCH_KEY"
}

Set-ImageSearchEnvironmentValue "BRAVE_SEARCH_API_KEY" $BraveSearchApiKey
Set-ImageSearchEnvironmentValue "GOOGLE_CUSTOM_SEARCH_API_KEY" $GoogleCustomSearchApiKey
Set-ImageSearchEnvironmentValue "GOOGLE_CUSTOM_SEARCH_CX" $GoogleCustomSearchCx
Set-ImageSearchEnvironmentValue "BING_IMAGE_SEARCH_KEY" $BingImageSearchKey

$HasAnyKey =
  $env:BRAVE_SEARCH_API_KEY -or
  ($env:GOOGLE_CUSTOM_SEARCH_API_KEY -and $env:GOOGLE_CUSTOM_SEARCH_CX) -or
  $env:BING_IMAGE_SEARCH_KEY

if ($HasAnyKey) {
  Write-Host "キー登録が完了しました。続けて .\run-image-search.ps1 -TargetCount 1000 を実行できます。"
} else {
  Write-Host "キーは登録されませんでした。APIキーを取得してから再実行してください。"
}
