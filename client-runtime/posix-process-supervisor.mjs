import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { inspectLinuxIdentity, sameLinuxProcess, readLinuxProcessIdentity } from './posix-process-identity.mjs';
export const POSIX_AGENT_PROCESS_SCHEMA = 'operator-studio.posix-agent-process/v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const pathsFor = (runsDir, runId) => {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new TypeError('Invalid process run identity.');
  const jobDir = path.resolve(runsDir, runId + '.posix');
  return Object.fromEntries([['jobDir', jobDir], ...['request', 'stdin', 'stdout', 'stderr', 'ready', 'receipt', 'cancel', 'resume', 'workerReady', 'providerExit']
    .map(name => [name + 'Path', path.join(jobDir, name + (['stdin', 'stdout', 'stderr'].includes(name) ? '.log' : '.json'))])]);
};
const smallJson = async file => {
  try { if ((await stat(file)).size > 65536) throw new Error('Oversized supervisor receipt.'); return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
export const createPosixProcessIdentity = async ({ runsDir, runId, missionId, readIdentity = readLinuxProcessIdentity }) => ({
  schemaVersion: POSIX_AGENT_PROCESS_SCHEMA, kind: 'linux-process-group', runId, missionId, token: randomUUID(),
  requestedAt: new Date().toISOString(), owner: await readIdentity(process.pid), supervisor: null, worker: null, ...pathsFor(runsDir, runId),
});
const unknown = (code, detail, extra = {}) => ({ state: 'unknown', confirmed: false, code, detail, ...extra });
export const inspectPosixProcess = async ({ record, runsDir, inspectIdentity = inspectLinuxIdentity }) => {
  const identity = record?.process;
  if (identity?.schemaVersion !== POSIX_AGENT_PROCESS_SCHEMA || identity.kind !== 'linux-process-group'
    || identity.runId !== record.runId || identity.missionId !== record.missionId || typeof identity.token !== 'string') return unknown('POSIX_AGENT_IDENTITY_CONFLICT', 'Execution identity does not match this run.');
  let expected;
  try { expected = pathsFor(runsDir, record.runId); } catch { return unknown('POSIX_AGENT_IDENTITY_CONFLICT', 'Invalid run path.'); }
  if (Object.entries(expected).some(([key, value]) => path.resolve(identity[key] || '') !== value)) return unknown('POSIX_AGENT_IDENTITY_CONFLICT', 'Supervisor paths are outside the bound run directory.');
  let ready, receipt;
  try { [ready, receipt] = await Promise.all([smallJson(expected.readyPath), smallJson(expected.receiptPath)]); }
  catch { return unknown('POSIX_AGENT_SIDECAR_INVALID', 'Supervisor artifacts cannot be verified.'); }
  const match = value => value?.schemaVersion === identity.schemaVersion && value.token === identity.token && value.runId === record.runId && value.missionId === record.missionId
    && sameLinuxProcess(identity.owner, value.owner);
  if (!match(ready) || !ready.worker || !ready.supervisor || ready.worker.groupId !== ready.worker.pid || ready.worker.sessionId !== ready.worker.pid
    || ready.worker.bootId !== ready.owner.bootId || ready.supervisor.bootId !== ready.owner.bootId || !validTime(ready.startedAt)
    || (identity.worker && !sameLinuxProcess(identity.worker, ready.worker)) || (identity.supervisor && !sameLinuxProcess(identity.supervisor, ready.supervisor))) return unknown('POSIX_AGENT_IDENTITY_CONFLICT', 'Missing or conflicting startup identity.');
  const bound = { ...identity, worker: ready.worker, supervisor: ready.supervisor, startedAt: ready.startedAt, pid: ready.worker.pid };
  if (receipt) {
    if (!match(receipt) || !sameLinuxProcess(receipt.supervisor, ready.supervisor) || !sameLinuxProcess(receipt.worker, ready.worker)
      || receipt.worker.groupId !== ready.worker.groupId || receipt.worker.sessionId !== ready.worker.sessionId
      || !validTime(receipt.completedAt) || !validTime(receipt.releaseProof?.checkedAt)
      || !(Number.isInteger(receipt.exitCode) || ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(receipt.signal))) return unknown('POSIX_AGENT_RECEIPT_CONFLICT', 'Terminal receipt does not match the original group.', { identity: bound });
    if (receipt.release !== 'confirmed' || receipt.releaseProof?.confirmed !== true || receipt.releaseProof.activeProcessCount !== 0
      || !['absent', 'zombies_only'].includes(receipt.releaseProof.state)) return unknown('POSIX_AGENT_RELEASE_UNCONFIRMED', 'Original supervisor could not prove group release.', { identity: bound });
    return { state: 'exited', confirmed: true, identity: bound, receipt, receiptDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(receipt)).digest('hex') };
  }
  const observation = await inspectIdentity(ready.supervisor);
  if (observation.state === 'active') return { state: 'active', confirmed: false, identity: bound, observation };
  return unknown('POSIX_AGENT_EXIT_RECEIPT_MISSING', 'Supervisor disappearance is not release evidence.', { identity: bound, observation });
};
export const requestPosixCancellation = async ({ record, runsDir, timeoutMs = 5000, inspectIdentity }) => {
  const inspection = await inspectPosixProcess({ record, runsDir, ...(inspectIdentity ? { inspectIdentity } : {}) });
  if (inspection.confirmed) return inspection;
  if (inspection.state !== 'active') return inspection;
  // Token request only. PID/group signalling is exclusively the original broker.
  await writeFile(inspection.identity.cancelPath, JSON.stringify({ token: inspection.identity.token, requestedAt: new Date().toISOString() }), { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspectPosixProcess({ record, runsDir, ...(inspectIdentity ? { inspectIdentity } : {}) });
    if (result.state !== 'active') return result;
    await pause(25);
  }
  return unknown('POSIX_AGENT_CANCEL_UNCONFIRMED', 'Cancellation timed out without a matched receipt.', { identity: inspection.identity });
};
export const startPosixSupervisedProcess = ({ identity, command, args, cwd, environment, stdinText, onIdentity, startTimeoutMs = 10000, cancelStepMs = 500, cancelTimeoutMs = 3000 }) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = null;
  child.pid = null; child.killed = false; child.jobReceipt = null; child.jobError = null;
  let resolveSettlement, rejectSettlement, helper, ended = false;
  child.settled = new Promise((resolve, reject) => { resolveSettlement = resolve; rejectSettlement = reject; }); child.settled.catch(() => {});
  const offsets = { stdout: 0, stderr: 0 };
  const pump = async () => {
    for (const name of ['stdout', 'stderr']) {
      const bytes = await readFile(identity[name + 'Path']).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
      if (bytes.length > offsets[name]) { child[name].write(bytes.subarray(offsets[name])); offsets[name] = bytes.length; }
    }
  };
  const finish = async error => {
    if (ended) return; ended = true;
    try {
      await pump();
      const inspection = await inspectPosixProcess({ record: { runId: identity.runId, missionId: identity.missionId, process: identity }, runsDir: path.dirname(identity.jobDir) });
      if (!inspection.confirmed) throw Object.assign(error || new Error(inspection.detail), { code: inspection.code });
      child.jobReceipt = inspection.receipt;
      child.stdout.end(); child.stderr.end(); child.emit('close', inspection.receipt.exitCode, inspection.receipt.signal);
      resolveSettlement(inspection.receipt);
    } catch (cause) {
      child.jobError = cause; child.stdout.end(); child.stderr.end(); child.emit('error', cause); child.emit('close', null, null); rejectSettlement(cause);
    }
  };
  child.ready = (async () => {
    if (process.platform !== 'linux') throw Object.assign(new Error('Linux /proc supervision unavailable.'), { code: 'POSIX_AGENT_PLATFORM_UNSUPPORTED' });
    await mkdir(identity.jobDir, { recursive: true, mode: 0o700 });
    await writeFile(identity.stdinPath, stdinText, { flag: 'wx', mode: 0o600 });
    await writeFile(identity.requestPath, JSON.stringify({ ...identity, command, args, cwd, startTimeoutMs, cancelStepMs, cancelTimeoutMs }), { flag: 'wx', mode: 0o600 });
    helper = spawn(process.execPath, [fileURLToPath(new URL('./posix-agent-supervisor.mjs', import.meta.url)), identity.requestPath], {
      cwd, env: environment, detached: true, stdio: 'ignore',
    });
    helper.on('error', error => void finish(error));
    helper.on('close', () => void finish());
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline && !ended) {
      const ready = await smallJson(identity.readyPath);
      if (ready) {
        const inspection = await inspectPosixProcess({ record: { runId: identity.runId, missionId: identity.missionId, process: identity }, runsDir: path.dirname(identity.jobDir) });
        if (inspection.state !== 'active') throw Object.assign(new Error(inspection.detail), { code: inspection.code });
        child.pid = ready.worker.pid;
        await onIdentity?.(inspection.identity);
        await writeFile(identity.resumePath, JSON.stringify({ token: identity.token }), { flag: 'wx', mode: 0o600 });
        (async () => { while (!ended) { await pump(); await pause(25); } })().catch(error => void finish(error));
        return ready;
      }
      await pause(25);
    }
    throw Object.assign(new Error('Supervisor startup deadline expired.'), { code: 'POSIX_AGENT_START_TIMEOUT' });
  })();
  child.ready.catch(async error => {
    // Stop the created group via its owner, even when persistence/resume failed.
    if (helper) await writeFile(identity.cancelPath, JSON.stringify({ token: identity.token }), { mode: 0o600 }).catch(() => {});
    else void finish(error);
  });
  child.terminate = async () => {
    await child.ready;
    await writeFile(identity.cancelPath, JSON.stringify({ token: identity.token, requestedAt: new Date().toISOString() }), { mode: 0o600 });
    child.killed = true;
    let timer;
    try { return await Promise.race([child.settled, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Cancellation receipt deadline expired.'), { code: 'POSIX_AGENT_CANCEL_UNCONFIRMED' })), cancelStepMs + cancelTimeoutMs + 1000); })]); }
    finally { clearTimeout(timer); }
  };
  return child;
};
export const recoverPosixProcessRecord = (record, inspection, events = []) => {
  if (!inspection.confirmed || inspection.state !== 'exited') return record;
  const receipt = inspection.receipt;
  const result = [...events].reverse().find(event => event?.type === 'result');
  const permissionFailure = record.error?.code === 'CLAUDE_TOOL_PERMISSION_DENIED';
  const success = result && result.is_error !== true && (!result.subtype || result.subtype === 'success');
  const status = permissionFailure ? 'failed' : success || record.status === 'completed' ? 'completed'
    : receipt.releaseProof.ownerLost || receipt.releaseProof.cancelled || record.diagnostics?.cancellation ? 'cancelled' : 'failed';
  if (record.processRecovery?.receiptDigest === inspection.receiptDigest && record.resourceRelease?.confirmed && record.status === status) return record;
  return { ...record, process: inspection.identity, status, completedAt: receipt.completedAt,
    diagnostics: { ...record.diagnostics, close: { at: receipt.completedAt, exitCode: receipt.exitCode, signal: receipt.signal } },
    resourceRelease: { confirmed: true, status: 'confirmed', source: 'linux-process-group', proof: { ...receipt.releaseProof, worker: receipt.worker, supervisor: receipt.supervisor, receiptDigest: inspection.receiptDigest } },
    processRecovery: { kind: 'verified_posix_receipt', receiptPath: inspection.identity.receiptPath, receiptDigest: inspection.receiptDigest, exitedAt: receipt.completedAt },
    error: permissionFailure ? record.error : status === 'failed' ? record.error || { code: 'CLAUDE_RESULT_MISSING', message: 'Verified group exit has no successful result.' } : null };
};
