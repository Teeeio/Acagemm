[CmdletBinding()]
param(
  [string]$OutputPath = '',
  [switch]$SkipArchive
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
if (-not $OutputPath) { $OutputPath = Join-Path $releaseRoot 'OperatorStudio-Exhibition' }
$resolvedReleaseRoot = [IO.Path]::GetFullPath($releaseRoot)
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
if (-not $resolvedOutput.StartsWith($resolvedReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputPath must stay inside the project release directory.' }

Set-Location $projectRoot
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; the exhibition package was not created.' }

if (Test-Path $resolvedOutput) { Remove-Item -LiteralPath $resolvedOutput -Recurse -Force }
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$items = @('dist', 'server', 'demo-assets', 'public', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'DELIVERY.md', 'EXHIBITION.md')
foreach ($item in $items) { Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $resolvedOutput -Recurse -Force }
Get-ChildItem -LiteralPath $projectRoot -Filter '*.cmd' | Copy-Item -Destination $resolvedOutput -Force
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedOutput 'runtime') | Out-Null
$runtimeBin = Join-Path $resolvedOutput 'runtime-bin'
New-Item -ItemType Directory -Force -Path $runtimeBin | Out-Null
$nodeSource = (Get-Command node -ErrorAction Stop).Source
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $runtimeBin 'node.exe') -Force

if (-not $SkipArchive) {
  $archivePath = "$resolvedOutput.zip"
  if (Test-Path $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  Compress-Archive -Path "$resolvedOutput\*" -DestinationPath $archivePath -CompressionLevel Optimal
  Write-Host "Offline exhibition archive created: $archivePath"
} else {
  Write-Host "Offline exhibition folder created: $resolvedOutput"
}
