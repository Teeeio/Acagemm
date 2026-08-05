[CmdletBinding()]
param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$checks = @()

function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $script:checks += [pscustomobject]@{ Check = $Name; Status = if ($Passed) { 'PASS' } else { 'FAIL' }; Detail = $Detail }
}

Set-Location $projectRoot
$bundledNode = Join-Path $projectRoot 'runtime-bin\node.exe'
$node = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
Add-Check 'Node.js runtime' ($null -ne $node) $(if ($node) { & $node --version } else { 'node was not found' })
Add-Check 'Web bundle' (Test-Path 'dist\index.html') $(if (Test-Path 'dist\index.html') { 'dist/index.html is present' } else { 'run npm run build before the exhibition' })

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
  $currentService = $health.status -eq 'ok' -and $health.service -eq 'operator-studio' -and $null -ne $health.runtime
  Add-Check 'Local service' $currentService "service=$($health.service); runtime=$($health.runtime.label); status=$($health.runtime.status)"
} catch {
  Add-Check 'Local service' $false "service is not listening on 127.0.0.1:$Port"
}

$checks | Format-Table -AutoSize
if ($checks.Status -contains 'FAIL') { exit 1 }
