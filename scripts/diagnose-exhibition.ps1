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
  $currentService = $health.status -eq 'ok' -and $health.service -eq 'operator-studio-client-runtime' -and $null -ne $health.runtime
  Add-Check 'Local service' $currentService "service=$($health.service); runtime=$($health.runtime.label); status=$($health.runtime.status)"
} catch {
  Add-Check 'Local service' $false "service is not listening on 127.0.0.1:$Port"
}

if ($currentService) {
  try {
    $runtime = (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runtime" -TimeoutSec 3).runtime
    if ($runtime.mode -eq 'codex-cli') {
      $truthfulRuntime = $runtime.connected -and $runtime.authority -eq 'codex-cli' -and $runtime.transport -eq 'Codex stdio JSONL' -and $runtime.liveHardware -eq $false
      Add-Check 'Runtime authority' $truthfulRuntime "mode=codex-cli; connected=$($runtime.connected); version=$($runtime.version); liveHardware=$($runtime.liveHardware)"
    } elseif ($runtime.mode -eq 'cli-file') {
      $probesReady = $runtime.probes.agentStatus -and $runtime.probes.testQueue -and $runtime.probes.canonicalRecords
      $truthfulRuntime = $runtime.connected -and $probesReady -and $runtime.authority -eq 'flashinfer-cli' -and $runtime.actionBridge -eq 'mission-request-only' -and $runtime.liveHardware -eq $false
      Add-Check 'Runtime authority' $truthfulRuntime "mode=cli-file; connected=$($runtime.connected); projection=$($runtime.projection); liveHardware=$($runtime.liveHardware)"
    } elseif ($runtime.mode -eq 'reference-fixture') {
      Add-Check 'Runtime authority' $false 'reference-fixture is test-only and cannot be used as an exhibition runtime'
    } elseif ($runtime.mode -eq 'opencode-server') {
      Add-Check 'Runtime authority' $false 'OpenCode integration is experimental; Patch and Decision action bridges are not complete'
    } elseif ($runtime.mode -eq 'unavailable') {
      Add-Check 'Runtime authority' $false 'the Coding Agent runtime is explicitly disabled'
    } else {
      Add-Check 'Runtime authority' $false "unsupported runtime mode: $($runtime.mode)"
    }
  } catch {
    Add-Check 'Runtime authority' $false 'runtime descriptor could not be read'
  }

  try {
    $state = (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 3).state
    $validStages = @('diagnosis', 'candidate', 'validation', 'evidence', 'curation', 'published')
    $stateReady = $state.schemaVersion -ge 3 -and ($validStages -contains $state.stage) -and $null -ne $state.knowledgeMaintenance.policy
    Add-Check 'State contract' $stateReady "schema=$($state.schemaVersion); mission=$($state.activeMissionId); stage=$($state.stage); knowledge=$($state.knowledgeMaintenance.status)"

    $previousSequence = 0
    $sequenceReady = $true
    foreach ($event in @($state.runtimeEvents)) {
      if ([int]$event.sequence -le $previousSequence) { $sequenceReady = $false; break }
      $previousSequence = [int]$event.sequence
    }
    Add-Check 'Event sequence' $sequenceReady "$(@($state.runtimeEvents).Count) events; lastSequence=$previousSequence"
  } catch {
    Add-Check 'State contract' $false 'state could not be read'
    Add-Check 'Event sequence' $false 'events could not be read'
  }

  $legacyPublishStatus = 0
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/api/knowledge/publish" -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    $legacyPublishStatus = 200
  } catch {
    if ($_.Exception.Response) { $legacyPublishStatus = [int]$_.Exception.Response.StatusCode }
  }
  Add-Check 'Knowledge policy' ($legacyPublishStatus -eq 410) "legacyPublishHttp=$legacyPublishStatus; expected=410"
}

$checks | Format-Table -AutoSize
if ($checks.Status -contains 'FAIL') { exit 1 }
