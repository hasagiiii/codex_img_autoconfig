[CmdletBinding()]
param(
  [ValidateSet('portable', 'nsis')]
  [string]$Target = 'portable',

  [ValidateSet('x64', 'arm64')]
  [string]$Arch = 'x64',

  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$builder = Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd'
$outputDirectory = Join-Path $projectRoot 'dist'

if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) {
  throw 'electron-builder was not found. Run npm install first.'
}

Push-Location $projectRoot
try {
  Write-Host "Building OpenTk Codex Config Tool ($Target, $Arch)..."
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  $builderArguments = @('--win', $Target, "--$Arch")
  if ($Publish) {
    if (-not $env:GH_TOKEN) {
      throw 'GH_TOKEN is required when -Publish is used.'
    }
    $builderArguments += @('--publish', 'always')
  }
  & $builder @builderArguments
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder failed with exit code $LASTEXITCODE."
  }

  $artifacts = Get-ChildItem -LiteralPath $outputDirectory -File -Filter '*.exe' |
    Sort-Object LastWriteTime -Descending
  if (-not $artifacts) {
    throw "Build completed, but no exe was found in $outputDirectory."
  }

  Write-Host 'Build completed:'
  $artifacts | ForEach-Object { Write-Host "  $($_.FullName)" }
}
finally {
  Pop-Location
}
