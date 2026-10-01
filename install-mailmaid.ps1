# MailMaid one-click installer (Windows - no manual unzip)
#
# Usage: Right-click this file -> "Run with PowerShell".
# It downloads the newest MailMaid release, unzips it for you into
# %LOCALAPPDATA%\MailMaid, and tells you which folder to load.
#
# If you already downloaded the release zip by hand, just put this script
# next to the zip and it will use that instead of downloading.

$ErrorActionPreference = "Stop"
$Repo = "FrossDev/MailMaid"
$Target = Join-Path $env:LOCALAPPDATA "MailMaid"

Write-Host "MailMaid installer" -ForegroundColor Cyan

# 1. Find a zip: local copy first, else download latest release.
$localZip = Get-ChildItem -Path $PSScriptRoot -Filter "MailMaid-*.zip" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($localZip) {
  $zipPath = $localZip.FullName
  Write-Host "Using local $($localZip.Name)"
} else {
  $api = "https://api.github.com/repos/$Repo/releases/latest"
  Write-Host "Checking $api ..."
  $rel = Invoke-RestMethod -Uri $api
  $asset = $rel.assets | Where-Object { $_.name -like "MailMaid-*.zip" } |
    Select-Object -First 1
  if (-not $asset) { throw "No MailMaid-*.zip found in the latest release." }
  $zipPath = Join-Path $env:TEMP $asset.name
  Write-Host "Downloading $($asset.name) ..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
}

# 2. Unzip automatically (this IS the "unpack" - the script does it).
if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $env:LOCALAPPDATA -Force
# Workflow zips a top-level MailMaid/ folder, so $Target should now exist.
if (-not (Test-Path (Join-Path $Target "manifest.json"))) {
  # Fallback: zip contained a nested folder - hunt for manifest.json.
  $found = Get-ChildItem $env:LOCALAPPDATA -Recurse -Filter manifest.json |
    Select-Object -First 1
  if ($found) { $Target = $found.DirectoryName } else { throw "Unzip OK but manifest.json not found." }
}

Write-Host ""
Write-Host "Done! Extension files are at:" -ForegroundColor Green
Write-Host "  $Target"
Write-Host ""
Write-Host "Opening chrome://extensions ..." -ForegroundColor Cyan
Write-Host "Then: turn ON Developer mode (top right) -> Load unpacked ->"
Write-Host "select the folder above, then Sign in with Google."
Write-Host ""
Set-Clipboard $Target
Write-Host "(Folder path copied to clipboard - just paste it in the file picker.)" -ForegroundColor DarkGray
Start-Process "chrome.exe" "chrome://extensions"
