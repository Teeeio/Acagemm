[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

& npm run demo:reset
if ($LASTEXITCODE -ne 0) { throw 'Demo data reset failed.' }
Write-Host 'Demo data has been restored to the official exhibition state.'
