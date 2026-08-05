[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = if (Test-Path (Join-Path $projectRoot 'runtime-bin\node.exe')) { Join-Path $env:LOCALAPPDATA 'OperatorStudioExhibition\runtime\operator-studio.pid' } else { Join-Path $projectRoot 'runtime\operator-studio.pid' }

if (-not (Test-Path $pidFile)) {
  Write-Host 'No exhibition server PID file was found.'
  exit 0
}

$processId = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($process.ProcessName -notmatch '^node' -or $processInfo.CommandLine -notmatch 'server[\\/]mock-server\.mjs') {
    throw "PID $processId is not the Operator Studio server. Refusing to stop it."
  }
  Stop-Process -Id $processId
  Write-Host "Stopped Operator Studio process $processId."
}
Remove-Item -LiteralPath $pidFile -Force
