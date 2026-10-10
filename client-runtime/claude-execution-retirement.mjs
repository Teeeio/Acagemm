import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const RETIREMENT_SCHEMA = 'operator-studio.execution-retirement/v1';
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
export const readLocalClaudeTransportCensus = async ({ command, runId, threadId, workspace, pinnedPids = [], identityTokens = [], pinnedCreatedNoLaterThan }) => {
  if (process.platform !== 'win32' || path.basename(command).toLowerCase() !== 'claude.exe') throw fail('LEGACY_RETIREMENT_UNSUPPORTED', 'Only the local native Windows Claude transport can use this census.');
  if (!Array.isArray(pinnedPids) || pinnedPids.some(pid => !Number.isInteger(pid) || pid <= 0)
    || !Array.isArray(identityTokens) || identityTokens.some(token => typeof token !== 'string' || !token.trim())
    || (pinnedCreatedNoLaterThan !== undefined && !Number.isFinite(Date.parse(pinnedCreatedNoLaterThan)))) {
    throw fail('RETIREMENT_CENSUS_SCOPE_INVALID', 'Optional census identities must be exact nonempty tokens and positive PIDs.');
  }
  const input = Buffer.from(JSON.stringify({ command, runId, threadId, workspace, pinnedPids, identityTokens, pinnedCreatedNoLaterThan }), 'utf8').toString('base64');
  // An original supervisor/owner must predate the verified target creation.
  // Later PID reuse is retained as audit evidence; tokens/native transports
  // always match independently, and unknown creation times stay blocked.
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$scope=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json;$bound=$null;if($scope.pinnedCreatedNoLaterThan){$bound=[DateTime]::Parse($scope.pinnedCreatedNoLaterThan).ToUniversalTime()};$rows=@(Get-CimInstance Win32_Process -ErrorAction Stop);$project={ [ordered]@{pid=$_.ProcessId;name=$_.Name;createdAt=$_.CreationDate.ToUniversalTime().ToString('o')} };$reused=@($rows|Where-Object {$scope.pinnedPids -contains $_.ProcessId -and $bound -and $_.CreationDate -and $_.CreationDate.ToUniversalTime() -gt $bound}|ForEach-Object $project);$matched=@($rows|Where-Object {$cmd=[string]$_.CommandLine;$extra=@($scope.identityTokens|Where-Object {$cmd.Contains([string]$_)});$pin=($scope.pinnedPids -contains $_.ProcessId) -and (!$bound -or !$_.CreationDate -or $_.CreationDate.ToUniversalTime() -le $bound);$_.Name -ieq 'claude.exe' -or $_.ExecutablePath -ieq $scope.command -or $pin -or $cmd.Contains($scope.runId) -or ($scope.threadId -and $cmd.Contains($scope.threadId)) -or $cmd.Contains($scope.workspace) -or $extra.Count -gt 0}|ForEach-Object $project);[ordered]@{complete=$true;observedAt=[DateTime]::UtcNow.ToString('o');processCount=$rows.Count;matchingProcesses=$matched;reusedPinnedProcesses=$reused}|ConvertTo-Json -Depth 5 -Compress`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(fail('LEGACY_PROCESS_CENSUS_UNAVAILABLE', 'Complete local process census is unavailable; retirement remains blocked.'));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(fail('LEGACY_PROCESS_CENSUS_UNAVAILABLE', 'Invalid local process census.')); }
    }));
};
export const createClaudeExecutionRetirement = ({ runsDir, command, readCensus = readLocalClaudeTransportCensus, readCommandStat = stat }) => {
  const checked = async runId => {
    if (!/^[A-Za-z0-9_-]+$/.test(runId || '')) throw fail('CLAUDE_RUN_ID_INVALID', 'Invalid original run identity.');
    const bytes = await readFile(path.join(runsDir, runId + '.json')); const record = JSON.parse(bytes);
    if (record.runId !== runId || record.provider !== 'claude-code' || !record.missionId || record.process
      || !Number.isFinite(Date.parse(record.startedAt)) || !path.isAbsolute(record.workspace || '')
      || record.boundary?.role !== 'iteration' || record.status !== 'running' || record.completedAt != null
      || record.diagnostics?.close != null || record.enforcedSurface?.toolSurface?.allowedTools !== 'Read,Write,Edit'
      || !String(record.enforcedSurface?.toolSurface?.disallowedTools).split(',').includes('Bash')
      || (record.additionalDirectories || []).length) throw fail('LEGACY_RETIREMENT_INELIGIBLE', 'Only an unclosed local legacy iteration with execution tools withheld is eligible.');
    return { record, recordDigest: digest(bytes), filename: path.join(runsDir, runId + '.retirement.json') };
  };
  const validate = (receipt, value) => {
    const { receiptDigest, ...body } = receipt || {};
    if (body.schemaVersion !== RETIREMENT_SCHEMA || body.runId !== value.record.runId || body.missionId !== value.record.missionId
      || body.recordDigest !== value.recordDigest || receiptDigest !== digest(JSON.stringify(body))
      || body.localTransportAbsent !== true || body.originalTreeExitConfirmed !== false || body.originalProcessExitCode !== null || body.originalProcessExitAt !== null
      || body.remoteModelOutcome !== 'unknown' || body.remoteModelCost !== 'unknown' || body.fence?.permanent !== true
      || body.fence.runId !== body.runId || body.fence.missionId !== body.missionId || body.fence.threadId !== value.record.threadId
      || body.fence.workspace !== value.record.workspace || !Array.isArray(body.census) || body.census.length !== 2
      || body.census.some(x => x.complete !== true || !Number.isFinite(Date.parse(x.observedAt)) || !Number.isInteger(x.processCount)
        || x.processCount <= 0 || !Array.isArray(x.matchingProcesses) || x.matchingProcesses.length)) throw fail('EXECUTION_RETIREMENT_CONFLICT', 'Retirement receipt no longer matches the original execution or absence/fencing evidence.');
    return receipt;
  };
  const read = async runId => {
    const value = await checked(runId);
    try { return validate(JSON.parse(await readFile(value.filename, 'utf8')), value); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const retire = async runId => {
    const value = await checked(runId); const existing = await read(runId); if (existing) return existing;
    const binary = await readCommandStat(command);
    if (path.basename(command).toLowerCase() !== 'claude.exe' || binary.mtimeMs > Date.parse(value.record.startedAt)) throw fail('LEGACY_INVOCATION_IDENTITY_UNAVAILABLE', 'The resolved native Claude binary changed since the original launch.');
    const scope = { command, runId, threadId: value.record.threadId, workspace: value.record.workspace };
    const first = await readCensus(scope); await new Promise(resolve => setTimeout(resolve, 250)); const second = await readCensus(scope);
    if ([first, second].some(x => x.complete !== true || !Number.isInteger(x.processCount) || x.processCount <= 0
      || !Array.isArray(x.matchingProcesses) || x.matchingProcesses.length)) throw fail('LOCAL_CLAUDE_TRANSPORT_ACTIVE_OR_UNKNOWN', 'A native Claude transport or matching original execution is present/unobservable; retirement is blocked.');
    const body = { schemaVersion: RETIREMENT_SCHEMA, runId, missionId: value.record.missionId, recordDigest: value.recordDigest,
      recordedAt: second.observedAt, localTransportAbsent: true, originalTreeExitConfirmed: false, originalProcessExitCode: null, originalProcessExitAt: null,
      remoteModelOutcome: 'unknown', remoteModelCost: 'unknown', command, binaryLastWriteAt: new Date(binary.mtimeMs).toISOString(), census: [first, second],
      fence: { permanent: true, runId, missionId: value.record.missionId, threadId: value.record.threadId, workspace: value.record.workspace,
        noResume: true, excludeFromCandidateAdmission: true, continuation: 'new-mission-only' } };
    const receipt = { ...body, receiptDigest: digest(JSON.stringify(body)) }; validate(receipt, value);
    try { await writeFile(value.filename, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; return read(runId); }
    return receipt;
  };
  const assertStartAllowed = async ({ missionId, runId, resumeThreadId }) => {
    const files = await readdir(runsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const filename of files.filter(x => x.endsWith('.retirement.json'))) {
      const receipt = await read(filename.slice(0, -'.retirement.json'.length));
      if (receipt && (receipt.missionId === missionId || receipt.runId === runId || (resumeThreadId && receipt.fence.threadId === resumeThreadId)))
        throw fail('AGENT_EXECUTION_RETIRED', 'The original Mission/run/session is permanently retired; start a separately identified Mission.');
    }
  };
  return Object.freeze({ read, retire, assertStartAllowed });
};
