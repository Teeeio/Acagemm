import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createJobName, spawnJobObjectProcess, inspectJobObjectProcess, windowsCommandLine } from './windows-job-object.mjs';

export const CLAUDE_PROCESS_SCHEMA = 'operator-studio.claude-process/v1';
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const safeRun = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const pathsFor = (runsDir, runId) => {
  if (!safeRun(runId)) throw new TypeError('Invalid process run identity.');
  const jobDir = path.join(runsDir, runId + '.job');
  return { jobDir, stdinPath: path.join(jobDir, 'stdin.txt'), stdoutPath: path.join(jobDir, 'stdout.log'),
    stderrPath: path.join(jobDir, 'stderr.log'), readyPath: path.join(jobDir, 'ready.json'), receiptPath: path.join(jobDir, 'receipt.json') };
};
export const createClaudeProcessIdentity = ({ runsDir, runId, missionId }) => ({
  schemaVersion: CLAUDE_PROCESS_SCHEMA, kind: 'windows-job-object', runId, missionId,
  jobName: createJobName(runId + '-' + randomUUID()), ownerPid: process.pid, requestedAt: new Date().toISOString(),
  pid: null, processCreatedAt: null, ...pathsFor(runsDir, runId),
});

// The named Job owns the whole target tree. The proxy keeps provider stream
// parsing in claude-client; helper stdout is control protocol, never model output.
export const startClaudeSupervisedProcess = ({ identity, command, args, cwd, environment, stdinText, onIdentity,
  spawnJobObjectImpl = spawnJobObjectProcess }) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = null;
  child.pid = null; child.killed = false; child.jobReceipt = null; child.jobError = null;
  let settle, fail;
  child.settled = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  child.settled.catch(() => {});
  child.ready = (async () => {
    await mkdir(identity.jobDir, { recursive: true });
    await writeFile(identity.stdinPath, stdinText, { flag: 'wx' });
    const supervisor = await spawnJobObjectImpl({ filePath: command, arguments: windowsCommandLine(args), argv: [command, ...args], cwd,
      stdinPath: identity.stdinPath, stdoutPath: identity.stdoutPath, stderrPath: identity.stderrPath,
      readyPath: identity.readyPath, receiptPath: identity.receiptPath, jobName: identity.jobName,
      tempRoot: identity.jobDir, env: environment, ownerPid: identity.ownerPid,
      onStdout: text => child.stdout.write(text), onStderr: text => child.stderr.write(text) });
    child.supervisor = supervisor;
    supervisor.result.then(receipt => {
      child.jobReceipt = receipt; child.pid = receipt.pid;
      child.stdout.end(); child.stderr.end(); child.emit('close', receipt.exitCode, null); settle(receipt);
    }, error => {
      child.jobError = error; child.stdout.end(); child.stderr.end();
      child.emit('error', error); child.emit('close', null, null); fail(error);
    });
    const ready = await supervisor.started;
    if (ready.jobName !== identity.jobName || !Number.isInteger(ready.pid) || !validTime(ready.processCreatedAt)) {
      throw Object.assign(new Error('Supervisor start identity is incomplete.'), { code: 'CLAUDE_PROCESS_IDENTITY_INVALID' });
    }
    child.pid = ready.pid;
    await onIdentity?.({ ...identity, pid: ready.pid, processCreatedAt: ready.processCreatedAt,
      startedAt: ready.startedAt, supervisorPid: ready.helperPid || supervisor.helperPid,
      ...(ready.supervision ? { supervision: ready.supervision } : {}),
      ...(ready.executionBoundary ? { executionBoundary: ready.executionBoundary } : {}) });
    return ready;
  })();
  child.ready.catch(error => {
    if (!child.supervisor) { child.jobError = error; child.emit('error', error); child.emit('close', null, null); fail(error); }
  });
  child.terminate = async () => {
    await child.ready;
    if (!child.jobReceipt && !child.jobError) await child.supervisor.terminate();
    child.killed = true;
    return child.settled;
  };
  return child;
};

const smallJson = async filename => {
  try {
    if ((await stat(filename)).size > 16384) throw new Error('Oversized supervisor sidecar.');
    return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const unknown = (code, detail, extra = {}) => ({ state: 'unknown', confirmed: false, code, detail, ...extra });

// No PID-only exit inference. A matched terminal receipt with zero Job members
// is the only release authority; an absent Job or a reused PID remains unknown.
export const inspectClaudeProcess = async ({ record, runsDir, inspectJobImpl = inspectJobObjectProcess }) => {
  const identity = record.process;
  if (!identity || identity.schemaVersion !== CLAUDE_PROCESS_SCHEMA) return unknown('CLAUDE_PROCESS_IDENTITY_UNAVAILABLE', 'Legacy run has no durable execution identity.');
  if (!safeRun(record.runId) || identity.runId !== record.runId || identity.missionId !== record.missionId
    || identity.kind !== 'windows-job-object' || typeof identity.jobName !== 'string'
    || !identity.jobName.startsWith('Local\\Acagemm-' + record.runId + '-')) {
    return unknown('CLAUDE_PROCESS_IDENTITY_CONFLICT', 'Execution identity does not match this run.');
  }
  const expected = pathsFor(runsDir, record.runId);
  if (Object.entries(expected).some(([key, value]) => path.resolve(identity[key] || '') !== path.resolve(value))) {
    return unknown('CLAUDE_PROCESS_IDENTITY_CONFLICT', 'Supervisor artifacts are not in the bound run directory.');
  }
  let ready, receipt;
  try { [ready, receipt] = await Promise.all([smallJson(expected.readyPath), smallJson(expected.receiptPath)]); }
  catch { return unknown('CLAUDE_PROCESS_SIDECAR_INVALID', 'Supervisor artifacts cannot be verified.'); }
  if (!ready || ready.jobName !== identity.jobName || !Number.isInteger(ready.pid) || ready.pid <= 0 || !validTime(ready.processCreatedAt)
    || (identity.pid !== null && identity.pid !== ready.pid)
    || (identity.processCreatedAt !== null && identity.processCreatedAt !== ready.processCreatedAt)) {
    return unknown('CLAUDE_PROCESS_IDENTITY_CONFLICT', 'Missing or mismatched startup receipt.');
  }
  const boundIdentity = { ...identity, pid: ready.pid, processCreatedAt: ready.processCreatedAt, startedAt: ready.startedAt };
  if (identity.executionBoundary && JSON.stringify(ready.executionBoundary) !== JSON.stringify(identity.executionBoundary)) {
    return unknown('CLAUDE_PROCESS_IDENTITY_CONFLICT', 'AppContainer startup evidence differs from the original execution identity.', { identity: boundIdentity });
  }
  if (receipt) {
    if (identity.executionBoundary && (JSON.stringify(ready.executionBoundary) !== JSON.stringify(identity.executionBoundary)
      || JSON.stringify(receipt.executionBoundary) !== JSON.stringify(identity.executionBoundary))) {
      return unknown('CLAUDE_PROCESS_RECEIPT_CONFLICT', 'AppContainer evidence differs from the original execution identity.', { identity: boundIdentity });
    }
    if (receipt.jobName !== identity.jobName || receipt.pid !== ready.pid || receipt.processCreatedAt !== ready.processCreatedAt
      || !Number.isInteger(receipt.exitCode) || !validTime(receipt.completedAt) || !validTime(receipt.releaseProof?.checkedAt)) {
      return unknown('CLAUDE_PROCESS_RECEIPT_CONFLICT', 'Terminal receipt does not match the original process.', { identity: boundIdentity });
    }
    if (receipt.release !== 'confirmed' || receipt.releaseProof?.confirmed !== true || receipt.releaseProof.activeProcessCount !== 0) {
      return unknown('CLAUDE_PROCESS_RELEASE_UNCONFIRMED', 'Supervisor could not prove the whole tree exited.', { identity: boundIdentity });
    }
    return { state: 'exited', confirmed: true, identity: boundIdentity, receipt,
      receiptDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(receipt)).digest('hex') };
  }
  let observation;
  try { observation = await inspectJobImpl({ jobName: identity.jobName, pid: ready.pid, processCreatedAt: ready.processCreatedAt }); }
  catch { return unknown('CLAUDE_PROCESS_INSPECTION_FAILED', 'Kernel inspection failed; release remains unknown.', { identity: boundIdentity }); }
  if (observation.jobName !== identity.jobName) return unknown('CLAUDE_PROCESS_IDENTITY_CONFLICT', 'Kernel observation belongs to another Job.');
  if (observation.jobExists === true && Number.isInteger(observation.activeProcessCount) && observation.activeProcessCount > 0) {
    return { state: 'active', confirmed: false, identity: boundIdentity, observation };
  }
  return unknown(observation.pidState === 'reused' ? 'CLAUDE_PROCESS_PID_REUSED' : 'CLAUDE_PROCESS_EXIT_RECEIPT_MISSING',
    'No verified terminal receipt. PID/Job disappearance alone cannot prove release.', { identity: boundIdentity, observation });
};

// Natural exit can close the named Job between a termination request and
// OpenJobObject. The missing handle is never release evidence: re-inspect only
// the identity pinned before the request and require its full terminal receipt.
export const terminateClaudeProcessWithReceipt = async ({ record, runsDir, terminate, inspectJobImpl }) => {
  const pinned = structuredClone({ runId: record?.runId, missionId: record?.missionId, process: record?.process });
  try { await terminate(); return null; }
  catch (error) {
    const inspection = await inspectClaudeProcess({ record: pinned, runsDir, inspectJobImpl });
    if (inspection.state !== 'exited' || inspection.confirmed !== true) throw error;
    return { kind: 'verified_receipt_after_termination_error', runId: pinned.runId, missionId: pinned.missionId,
      jobName: inspection.identity.jobName, pid: inspection.identity.pid, processCreatedAt: inspection.identity.processCreatedAt,
      receiptDigest: inspection.receiptDigest, checkedAt: inspection.receipt.releaseProof.checkedAt,
      terminationError: { code: error.code || null, message: error.message } };
  }
};

export const recoverClaudeProcessRecord = (record, inspection, rawEvents = []) => {
  if (!inspection.confirmed || inspection.state !== 'exited') return record;
  const receipt = inspection.receipt;
  const terminal = [...rawEvents].reverse().find(event => event?.type === 'result');
  const success = terminal && terminal.is_error !== true && (!terminal.subtype || terminal.subtype === 'success');
  const permissionFailure = record.error?.code === 'CLAUDE_TOOL_PERMISSION_DENIED';
  // A verified successful provider result predates release cleanup. Keep it
  // completed even when terminal_unreleased cleanup requested cancellation;
  // the matched receipt remains the only authority for actual process release.
  const status = permissionFailure ? 'failed' : success || record.status === 'completed' ? 'completed'
    : receipt.releaseProof.ownerLost || record.diagnostics?.cancellation || record.status === 'cancel_requested' || record.status === 'cancelled' ? 'cancelled' : 'failed';
  if (record.processRecovery?.receiptDigest === inspection.receiptDigest && record.resourceRelease?.confirmed === true && record.status === status) return record;
  return { ...record, process: inspection.identity, status, completedAt: receipt.completedAt,
    diagnostics: { ...record.diagnostics, close: { at: receipt.completedAt, exitCode: receipt.exitCode, signal: null } },
    resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Matched Job receipt proves zero active members.',
      source: 'windows-job-object', proof: { jobName: receipt.jobName, pid: receipt.pid, processCreatedAt: receipt.processCreatedAt,
        ...receipt.releaseProof, receiptDigest: inspection.receiptDigest } },
    processRecovery: { kind: 'verified_job_receipt', observedAt: new Date().toISOString(), receiptDigest: inspection.receiptDigest,
      receiptPath: inspection.identity.receiptPath, jobName: receipt.jobName, pid: receipt.pid,
      processCreatedAt: receipt.processCreatedAt, exitedAt: receipt.completedAt, exitCode: receipt.exitCode, ownerLost: receipt.releaseProof.ownerLost === true },
    error: permissionFailure ? record.error : status === 'failed' ? record.error || { code: 'CLAUDE_RESULT_MISSING', message: 'Verified process exit has no successful provider result.' } : null };
};
