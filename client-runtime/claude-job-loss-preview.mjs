// Read-only adapter preparation. No retirement, lease, Runtime or queue writes.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectClaudeProcess, CLAUDE_PROCESS_SCHEMA } from './claude-process-supervisor.mjs';
import { readLocalClaudeTransportCensus } from './claude-execution-retirement.mjs';

export const JOB_LOSS_PREVIEW_SCHEMA = 'operator-studio.job-loss-retirement-preview/v1';
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const terminal = value => ['completed', 'failed', 'cancelled'].includes(value);
const identityFor = (record, recordDigest) => ({ runId: record.runId, missionId: record.missionId,
  threadId: record.threadId, sessionId: record.sessionId, workspace: record.workspace, recordDigest,
  jobName: record.process?.jobName, pid: record.process?.pid, processCreatedAt: record.process?.processCreatedAt,
  supervisorPid: record.process?.supervisorPid, ownerPid: record.process?.ownerPid });
const sameIdentity = (left, right) => Object.keys(left).every(key => left[key] === right?.[key])
  && Object.keys(right || {}).length === Object.keys(left).length;

export function createClaudeJobLossPreview({ runsDir, command, platform = process.platform,
  readCensus = readLocalClaudeTransportCensus, inspectProcess = inspectClaudeProcess,
  readCommandStat = stat, readQueueTasks, readOtherResources, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const load = async runId => {
    if (!/^[A-Za-z0-9_-]+$/.test(runId || '')) throw fail('CLAUDE_RUN_ID_INVALID', 'Invalid original run identity.');
    const bytes = await readFile(path.join(runsDir, runId + '.json')); const record = JSON.parse(bytes);
    return { bytes, record, identity: identityFor(record, digest(bytes)) };
  };
  const readIdentity = async runId => (await load(runId)).identity;
  const preview = async ({ runId, expectedIdentity }) => {
    const value = await load(runId), record = value.record;
    if (!sameIdentity(value.identity, expectedIdentity)) throw fail('JOB_LOSS_PREVIEW_IDENTITY_CONFLICT', 'The exact reviewed run/Job/source identity changed.');
    if (platform !== 'win32' || path.basename(command).toLowerCase() !== 'claude.exe'
      || record.provider !== 'claude-code' || record.runId !== runId || !record.missionId
      || !record.threadId || record.sessionId !== record.threadId || !time(record.startedAt)
      || record.status !== 'running' || record.completedAt != null || record.diagnostics?.close != null
      || !path.isAbsolute(record.workspace || '') || record.boundary?.role !== 'iteration'
      || record.enforcedSurface?.toolSurface?.allowedTools !== 'Read,Write,Edit'
      || !String(record.enforcedSurface?.toolSurface?.disallowedTools).split(',').includes('Bash')
      || (record.additionalDirectories || []).length || record.process?.schemaVersion !== CLAUDE_PROCESS_SCHEMA
      || ![record.process.pid, record.process.supervisorPid, record.process.ownerPid].every(pid => Number.isInteger(pid) && pid > 0)) {
      throw fail('JOB_LOSS_PREVIEW_INELIGIBLE', 'Only the exact unclosed native read/write-only durable-Job iteration may be previewed.');
    }
    if (typeof readQueueTasks !== 'function' || typeof readOtherResources !== 'function') throw fail('JOB_LOSS_PREVIEW_PORT_UNAVAILABLE', 'Trusted queue and other-resource reads are required.');
    const binary = await readCommandStat(command);
    if (!Number.isFinite(binary.mtimeMs) || binary.mtimeMs > Date.parse(record.startedAt)) throw fail('JOB_LOSS_PREVIEW_BINARY_CHANGED', 'The native transport binary changed since the original start.');
    const scope = { command, runId, threadId: record.threadId, workspace: record.workspace,
      pinnedPids: [record.process.pid, record.process.supervisorPid, record.process.ownerPid],
      identityTokens: [record.process.jobName, record.process.jobDir] };
    const observations = [];
    for (let index = 0; index < 2; index++) {
      if (index) await pause(250);
      const inspection = await inspectProcess({ record, runsDir });
      const bound = inspection.identity;
      if (inspection.state !== 'unknown' || inspection.confirmed !== false
        || inspection.code !== 'CLAUDE_PROCESS_EXIT_RECEIPT_MISSING'
        || bound?.runId !== runId || bound?.missionId !== record.missionId
        || bound.jobName !== record.process.jobName || bound.pid !== record.process.pid
        || bound.processCreatedAt !== record.process.processCreatedAt
        || inspection.observation?.jobName !== record.process.jobName
        || inspection.observation.jobExists !== false || inspection.observation.pidState !== 'absent'
        || !time(inspection.observation.checkedAt)
        || Date.parse(inspection.observation.checkedAt) < Date.parse(record.startedAt)) {
        throw fail('JOB_LOSS_PREVIEW_KERNEL_UNSAFE', 'Original Job/PID/startup identity is active, reused, conflicting or unobservable.');
      }
      const census = await readCensus(scope);
      if (census?.complete !== true || !Number.isInteger(census.processCount) || census.processCount <= 0
        || !time(census.observedAt) || Date.parse(census.observedAt) < Date.parse(record.startedAt)
        || !Array.isArray(census.matchingProcesses) || census.matchingProcesses.length) {
        throw fail('JOB_LOSS_PREVIEW_TRANSPORT_UNSAFE', 'A complete original-identity transport/helper census is absent or still matches a process.');
      }
      observations.push({ inspection, census });
    }
    if (Date.parse(observations[1].census.observedAt) <= Date.parse(observations[0].census.observedAt))
      throw fail('JOB_LOSS_PREVIEW_OBSERVATION_STALE', 'Two distinct ordered live observations are required.');
    const tasks = await readQueueTasks(); const otherResources = await readOtherResources();
    if (!Array.isArray(tasks) || tasks.some(task => !terminal(task.status) || task.resourceRelease?.confirmed !== true)
      || !Array.isArray(otherResources) || otherResources.some(resource => !terminal(resource.status) || resource.resourceRelease?.confirmed !== true)) {
      throw fail('JOB_LOSS_PREVIEW_OTHER_RESOURCE_PENDING', 'A GPU/queue/foreign resource still lacks release evidence.');
    }
    if (!sameIdentity((await load(runId)).identity, expectedIdentity)) throw fail('JOB_LOSS_PREVIEW_IDENTITY_CONFLICT', 'The original record changed during observation.');
    return { schemaVersion: JOB_LOSS_PREVIEW_SCHEMA, mode: 'dry-run', executed: false,
      identity: value.identity, observations, queueTasks: tasks.length, otherResources: otherResources.length,
      originalTreeExitConfirmed: false, releaseConfirmed: false, logicalLeaseRetired: false,
      originalProcessExitCode: null, originalProcessExitAt: null, remoteModelOutcome: 'unknown', remoteModelCost: 'unknown',
      commitImplemented: false, approvalRequired: true, observationIsNotFutureAuthorization: true,
      proposedFence: { permanent: true, missionId: record.missionId, runId, threadId: record.threadId,
        workspace: record.workspace, noResume: true, excludeFromCandidateAdmission: true,
        lateResults: 'quarantined-audit-only', continuation: 'new-mission-only' } };
  };
  return Object.freeze({ readIdentity, preview });
}
