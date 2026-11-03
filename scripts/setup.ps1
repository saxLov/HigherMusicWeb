$ErrorActionPreference = 'Stop'
Write-Host "--- Starting installation ---" -ForegroundColor Cyan
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
    throw 'Node.js 20 or newer is required.'
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimeRoot = Join-Path $projectRoot '.runtime'
$sourceRoot = Join-Path $runtimeRoot 'source'
$revision = '5d6c9f7b180279c9dd08bc6f7159de52a856d587'

# 确保目录存在
New-Item -ItemType Directory -Force $sourceRoot | Out-Null

$providerRoot = Join-Path $sourceRoot 'KuGouMusicApi-main'
if (-not (Test-Path (Join-Path $providerRoot 'main.js'))) {
    Write-Host "Downloading KuGou API..." -ForegroundColor Yellow
    $archivePath = Join-Path $runtimeRoot 'provider.zip'
    Invoke-WebRequest -Uri "https://codeload.github.com/MakcRe/KuGouMusicApi/zip/$revision" -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $sourceRoot -Force
    Rename-Item -LiteralPath (Join-Path $sourceRoot "KuGouMusicApi-$revision") -NewName 'KuGouMusicApi-main' -Force
}

Write-Host "Installing dependencies..." -ForegroundColor Yellow
Push-Location $providerRoot
try {
    # npm.cmd avoids PowerShell blocking npm.ps1; an npm failure must not be reported as success.
    & npm.cmd install --omit=dev --ignore-scripts --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Resolve the npm error and run setup again.' }
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'provider-revision') -Value $revision -Encoding ASCII
} finally {
    Pop-Location
}

Write-Host "--- Installation Complete! Run: node server.mjs ---" -ForegroundColor Green
