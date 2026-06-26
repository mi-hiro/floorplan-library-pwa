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
  Write-Host "Set: $Name"
}

function Clear-ImageSearchEnvironmentValue {
  param([string]$Name)
  [Environment]::SetEnvironmentVariable($Name, $null, "User")
  [Environment]::SetEnvironmentVariable($Name, $null, "Process")
  Write-Host "Cleared: $Name"
}

if ($Clear) {
  foreach ($Name in $EnvNames) {
    Clear-ImageSearchEnvironmentValue $Name
  }
  Write-Host "Image search API keys were cleared."
  exit 0
}

$HasDirectValue =
  $PSBoundParameters.ContainsKey("BraveSearchApiKey") -or
  $PSBoundParameters.ContainsKey("GoogleCustomSearchApiKey") -or
  $PSBoundParameters.ContainsKey("GoogleCustomSearchCx") -or
  $PSBoundParameters.ContainsKey("BingImageSearchKey")

if (!$HasDirectValue) {
  Write-Host "Image search API keys are needed for bulk floorplan collection."
  Write-Host "Recommended now: Brave Search API key in BRAVE_SEARCH_API_KEY."
  Write-Host "Press Enter to skip fields you do not use."
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
  Write-Host "Keys were saved. Next: .\run-image-search.ps1 -TargetCount 1000"
} else {
  Write-Host "No keys were saved. Get an API key and run this script again."
}
