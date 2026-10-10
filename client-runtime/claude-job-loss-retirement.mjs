import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createClaudeJobLossPreview } from './claude-job-loss-preview.mjs';
import { readLocalClaudeTransportCensus, RETIREMENT_SCHEMA } from './claude-execution-retirement.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRegistry = path.join(repository, '.operator-studio-local/execution-retirement-fences');
const FENCE_SCHEMA = 'operator-studio.job-loss-fence/v1';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
const json = value => JSON.stringify(value, null, 2) + '\n';
const signed = body => ({ ...body, receiptDigest: digest(JSON.stringify(body)) });
const readOptional = async file => {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const immutable = async (file, bytes) => {
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try { handle = await open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(file)).equals(Buffer.from(bytes))) throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Immutable retirement artifact changed.');
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
};
const validateSigned = value => {
  const { receiptDigest, ...body } = value || {};
  if (receiptDigest !== digest(JSON.stringify(body))) throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Retirement artifact digest is invalid.');
  return body;
};
const validateFence = async value => {
  const body = validateSigned(value);
  if (body.schemaVersion !== FENCE_SCHEMA || !safeId(body.runId) || !body.missionId || !body.sessionId
    || body.identity?.runId !== body.runId || body.identity.missionId !== body.missionId || body.identity.sessionId !== body.sessionId
    || body.identity.threadId !== body.sessionId || body.originalTreeExitConfirmed !== false || body.releaseConfirmed !== false
    || body.remoteModelOutcome !== 'unknown' || body.remoteModelCost !== 'unknown'
    || body.fence?.permanent !== true || body.fence.noResume !== true || body.fence.excludeFromCandidateAdmission !== true
    || body.fence.runId !== body.runId || body.fence.missionId !== body.missionId || body.fence.threadId !== body.sessionId
    || body.fence.workspace !== body.identity.workspace || body.authorization?.approved !== true
    || body.authorization.runId !== body.runId || body.authorization.missionId !== body.missionId || body.authorization.sessionId !== body.sessionId
    || body.authorization.recordDigest !== body.identity.recordDigest || body.authorization.leaseDigest !== body.lease?.digest) {
    throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Permanent fence identity or unknown historical facts changed.');
  }
  const bytes = await readFile(body.originalArchive);
  if (digest(bytes) !== body.identity.recordDigest) throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Original immutable run archive changed.');
  const original = JSON.parse(bytes);
  if (original.runId !== body.runId || original.missionId !== body.missionId || original.sessionId !== body.sessionId
    || original.workspace !== body.identity.workspace || original.process?.jobName !== body.identity.jobName
    || original.process.pid !== body.identity.pid || original.process.processCreatedAt !== body.identity.processCreatedAt) {
    throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Original archive process identity changed.');
  }
  return { body, original };
};
const readRegistry = async directory => {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const value = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    const checked = await validateFence(value);
    if (name !== checked.body.runId + '.json') throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Registry filename identity changed.');
    result.push(value);
  }
  return result;
};
export async function assertHarnessIdentityNotRetired({ directory, identity }) {
  for (const fence of await readRegistry(path.join(directory, 'execution-retirement-fences'))) {
    if (fence.lease.identity.experimentId === identity?.experimentId) {
      throw fail('AGENT_EXECUTION_RETIRED', 'This experiment is permanently retired, including --recover; use a new experiment/Mission/session.');
    }
  }
}

export function createClaudeJobLossRetirement({ runsDir, command, fenceRegistryDir = defaultRegistry,
  readCensus = readLocalClaudeTransportCensus, inspectProcess, readCommandStat, pause, now = Date.now } = {}) {
  const files = runId => {
    if (!safeId(runId)) throw fail('CLAUDE_RUN_ID_INVALID', 'Invalid retirement run identity.');
    return { original: path.join(runsDir, runId + '.json'), archive: path.join(runsDir, runId + '.job-loss-original.json'),
      fence: path.join(runsDir, runId + '.job-loss-fence.json'), final: path.join(runsDir, runId + '.job-loss-retirement.json'),
      index: path.join(fenceRegistryDir, runId + '.json') };
  };
  const readFence = async runId => {
    const bytes = await readOptional(files(runId).fence); if (!bytes) return null;
    const value = JSON.parse(bytes); await validateFence(value); return value;
  };
  const read = async runId => {
    const f = files(runId), bytes = await readOptional(f.final); if (!bytes) return null;
    const receipt = JSON.parse(bytes), body = validateSigned(receipt), fence = await readFence(runId);
    if (!fence || body.schemaVersion !== RETIREMENT_SCHEMA || body.retirementKind !== 'durable-job-loss'
      || body.runId !== runId || body.missionId !== fence.missionId || body.recordDigest !== fence.identity.recordDigest
      || body.fenceDigest !== fence.receiptDigest || body.logicalLeaseRetired !== true || body.releaseConfirmed !== false
      || body.originalTreeExitConfirmed !== false || body.originalProcessExitAt !== null || body.originalProcessExitCode !== null
      || body.remoteModelOutcome !== 'unknown' || body.remoteModelCost !== 'unknown' || body.localTransportAbsent !== true
      || !isDeepStrictEqual(body.fence, fence.fence) || !Array.isArray(body.census) || body.census.length !== 2
      || body.census.some(c => c.complete !== true || !Number.isInteger(c.processCount) || c.processCount <= 0 || c.matchingProcesses?.length !== 0)
      || !isDeepStrictEqual(body.leaseRetirement.identity, fence.lease.identity)
      || body.leaseRetirement.originalDigest !== fence.lease.digest
      || digest(await readFile(body.leaseRetirement.archive)) !== fence.lease.digest
      || !(await readFile(f.index)).equals(Buffer.from(json(fence)))) {
      throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Final retirement or archived lease no longer matches its permanent fence.');
    }
    return receipt;
  };
  const readFencedRun = async runId => {
    const fence = await readFence(runId); if (!fence) return null;
    const { original } = await validateFence(fence), receipt = await read(runId);
    const current = await readOptional(files(runId).original);
    return { ...original, executionRetirement: receipt, executionDisposition: receipt ? 'retired_unknown' : 'retirement_pending',
      resourceRelease: { ...original.resourceRelease, confirmed: false, originalExitUnknown: true,
        operationalDisposition: receipt ? 'retired' : 'retirement_pending', retirementDigest: receipt?.receiptDigest || null },
      quarantinedAudit: { policy: 'quarantined-audit-only', originalRecordDigest: fence.identity.recordDigest,
        currentRecordDigest: current ? digest(current) : null, lateRawRecordChanged: current ? digest(current) !== fence.identity.recordDigest : null } };
  };
  const assertStartAllowed = async ({ missionId, runId, resumeThreadId, workspace }) => {
    for (const fence of await readRegistry(fenceRegistryDir)) {
      if (fence.missionId === missionId || fence.runId === runId || (resumeThreadId && fence.sessionId === resumeThreadId)
        || (workspace && path.resolve(workspace) === path.resolve(fence.identity.workspace))) {
        throw fail('AGENT_EXECUTION_RETIRED', 'The original Mission/run/session/workspace is permanently retired.');
      }
    }
  };
  const retire = async ({ runId, expectedIdentity, authorization, leaseFile, expectedLeaseDigest, leaseIdentity, readQueueTasks, readOtherResources }) => {
    const f = files(runId);
    if (authorization?.approved !== true || authorization.authority !== 'operator-explicit-confirmation'
      || authorization.runId !== runId || authorization.missionId !== expectedIdentity?.missionId
      || authorization.sessionId !== expectedIdentity?.sessionId || authorization.recordDigest !== expectedIdentity.recordDigest
      || authorization.leaseDigest !== expectedLeaseDigest || !authorization.messageId
      || !Number.isFinite(Date.parse(authorization.at)) || !path.isAbsolute(leaseFile || '')
      || path.basename(leaseFile) !== 'harness-execution-lease.json' || !/^sha256:[a-f0-9]{64}$/.test(expectedLeaseDigest || '')) {
      throw fail('JOB_LOSS_AUTHORIZATION_REQUIRED', 'Exact explicit operator authorization and reviewed input identities are required.');
    }
    const claimFile = path.join(path.dirname(leaseFile), 'harness-execution-claim.json');
    const claim = Buffer.from(json({ pid: process.pid, operation: 'exact-job-loss-retirement', runId, identity: leaseIdentity }));
    let claimHandle;
    try { claimHandle = await open(claimFile, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw fail('HARNESS_EXECUTOR_BUSY', 'Another or interrupted exclusive lease claim exists.'); throw error; }
    try {
      await claimHandle.writeFile(claim); await claimHandle.sync(); await claimHandle.close(); claimHandle = null;
      const existing = await read(runId);
      if (existing) {
        const prior = await readFence(runId);
        if (!isDeepStrictEqual(prior.identity, expectedIdentity) || !isDeepStrictEqual(prior.authorization, authorization)
          || prior.lease.digest !== expectedLeaseDigest || !isDeepStrictEqual(prior.lease.identity, leaseIdentity))
          throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Completed retirement differs from this requested exact identity.');
        return existing;
      }
      const pending = await readFence(runId);
      let leaseBytes = await readOptional(leaseFile);
      const archiveFile = path.join(path.dirname(leaseFile), `harness-lease-job-loss-${runId}.json`);
      if (!leaseBytes && pending) leaseBytes = await readOptional(archiveFile);
      if (!leaseBytes || digest(leaseBytes) !== expectedLeaseDigest || !isDeepStrictEqual(JSON.parse(leaseBytes).identity, leaseIdentity)) {
        throw fail('JOB_LOSS_LEASE_CONFLICT', 'The exact original lease changed or is unavailable.');
      }
      const lease = JSON.parse(leaseBytes), started = now();
      const preview = createClaudeJobLossPreview({ runsDir, command,
        readCensus: scope => readCensus({ ...scope, pinnedPids: [...new Set([...scope.pinnedPids, lease.pid])],
          pinnedCreatedNoLaterThan: expectedIdentity.processCreatedAt }),
        ...(inspectProcess ? { inspectProcess } : {}), ...(readCommandStat ? { readCommandStat } : {}), ...(pause ? { pause } : {}),
        readQueueTasks, readOtherResources });
      const prepared = await preview.preview({ runId, expectedIdentity });
      if (prepared.observations.some(o => [o.census.observedAt, o.inspection.observation.checkedAt].some(t =>
        Date.parse(t) < started - 1000 || Date.parse(t) > now() + 1000 || now() - Date.parse(t) > 30000))) {
        throw fail('JOB_LOSS_OBSERVATION_STALE', 'Fresh observations for this exact commit are required.');
      }
      const current = await readFile(f.original);
      if (digest(current) !== expectedIdentity.recordDigest) throw fail('JOB_LOSS_PREVIEW_IDENTITY_CONFLICT', 'Original run changed before fencing.');
      await immutable(f.archive, current);
      const fence = pending || signed({ schemaVersion: FENCE_SCHEMA, runId, missionId: expectedIdentity.missionId,
        sessionId: expectedIdentity.sessionId, identity: expectedIdentity, originalArchive: f.archive, recordedAt: new Date(now()).toISOString(),
        authorization, lease: { file: leaseFile, identity: leaseIdentity, digest: expectedLeaseDigest },
        originalTreeExitConfirmed: false, releaseConfirmed: false, remoteModelOutcome: 'unknown', remoteModelCost: 'unknown',
        fence: prepared.proposedFence });
      await validateFence(fence);
      if (!isDeepStrictEqual(fence.identity, expectedIdentity) || fence.lease.digest !== expectedLeaseDigest
        || !isDeepStrictEqual(fence.authorization, authorization)) throw fail('JOB_LOSS_RECEIPT_CONFLICT', 'Interrupted fence identity differs.');
      // Permanent guards precede logical lease removal. Interrupted preparation
      // keeps both the no-resume fence and the lease barrier; retry reconciles it.
      await immutable(f.fence, json(fence)); await immutable(f.index, json(fence));
      await immutable(archiveFile, leaseBytes);
      const currentLease = await readOptional(leaseFile);
      if (currentLease) {
        if (digest(currentLease) !== expectedLeaseDigest) throw fail('JOB_LOSS_LEASE_CONFLICT', 'Lease ownership changed under the exclusive claim.');
        await unlink(leaseFile);
      }
      const receipt = signed({ schemaVersion: RETIREMENT_SCHEMA, retirementKind: 'durable-job-loss', runId,
        missionId: expectedIdentity.missionId, recordDigest: expectedIdentity.recordDigest, recordedAt: new Date(now()).toISOString(),
        fenceDigest: fence.receiptDigest, localTransportAbsent: true, originalTreeExitConfirmed: false, releaseConfirmed: false,
        originalProcessExitCode: null, originalProcessExitAt: null, remoteModelOutcome: 'unknown', remoteModelCost: 'unknown',
        logicalLeaseRetired: true, observations: prepared.observations, census: prepared.observations.map(o => o.census),
        queueTasks: prepared.queueTasks, otherResources: prepared.otherResources, fence: fence.fence,
        leaseRetirement: { identity: leaseIdentity, originalDigest: expectedLeaseDigest, archive: archiveFile, physicalReleaseConfirmed: false } });
      await immutable(f.final, json(receipt)); return read(runId);
    } finally {
      await claimHandle?.close();
      if ((await readFile(claimFile)).equals(claim)) await unlink(claimFile);
      else throw fail('HARNESS_EXECUTOR_BUSY', 'Exclusive retirement claim identity changed; it was retained.');
    }
  };
  return Object.freeze({ read, readFence, readFencedRun, retire, assertStartAllowed });
}
