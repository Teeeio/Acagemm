import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledRunner = path.join(rootDir, 'tools', 'local-c500-runner.py');
const sharedGpuRunner = path.join(rootDir, 'tools', 'local-shared-gpu-runner.py');
const runtimeDir = process.env.OPERATOR_RUNTIME_DIR ? path.resolve(process.env.OPERATOR_RUNTIME_DIR) : path.join(rootDir, 'runtime');
const taskRoot = process.env.OPERATOR_LOCAL_C500_DIR ? path.resolve(process.env.OPERATOR_LOCAL_C500_DIR) : path.join(runtimeDir, 'local-c500');
const sharedGpuEnabled = process.env.OPERATOR_TEST_BACKEND === 'local-shared-gpu';
const sharedGpuPython = process.env.OPERATOR_GPU_PYTHON || path.join(rootDir, '.gpu-venv', 'Scripts', 'python.exe');
const commandTemplate = process.env.OPERATOR_LOCAL_C500_COMMAND
  || (sharedGpuEnabled ? `"${sharedGpuPython}" "${sharedGpuRunner}"` : 'python "' + bundledRunner + '"');
const explicitRunnerCommand = Boolean(process.env.OPERATOR_LOCAL_C500_COMMAND) || sharedGpuEnabled;
const mockEnabled = process.env.OPERATOR_LOCAL_C500_MOCK === '1';
const cpuE2eEnabled = process.env.OPERATOR_LOCAL_CPU === '1';
const hardwareDisabled = process.env.OPERATOR_HARDWARE_DISABLED === '1';
const simulationEnabled = process.env.OPERATOR_LOCAL_C500_SIMULATION === '1';
const mockScenario = process.env.OPERATOR_LOCAL_C500_MOCK_SCENARIO || '';
const iterativeMlaScenario = mockScenario === 'mla-three-round';
const isScriptedSequenceTask = (task) => iterativeMlaScenario
  || Boolean(task?.payload?.baselineSource?.profileId)
  || Boolean(task?.payload?.baselineMaterialization?.source?.profileId)
  || Boolean(task?.payload?.baselineSource?.repository && String(task.payload.baselineSource.repository).startsWith('operator-profile:'));
const mockLedgerPath = path.join(taskRoot, 'mock-sequence-ledger.json');
const referenceCacheRoot = path.join(taskRoot, 'reference-cache');
const ownerId = randomUUID();
const activeExecutions = new Map();
const taskWriteChains = new Map();
const terminalTaskStatuses = new Set(['completed', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const release = (confirmed, status, reason, deadline = null, nextAction = null) => ({ confirmed, status, reason, deadline, nextAction });
const taskDirFor = (taskId) => {
  if (!/^local_c500_[a-zA-Z0-9]+$/.test(taskId)) throw Object.assign(new Error('Invalid local task ID.'), { code: 'LOCAL_C500_TASK_NOT_FOUND', status: 404 });
  return path.join(taskRoot, taskId);
};
const artifactPath = (taskId, name) => path.join(taskDirFor(taskId), name);
const taskPath = (taskId) => artifactPath(taskId, 'task.json');
const runPyPath = (taskId) => artifactPath(taskId, 'run.py');
const oracleRunPyPath = (taskId) => artifactPath(taskId, 'oracle.py');
const resultPath = (taskId) => artifactPath(taskId, 'result.json');
const correctnessPath = (taskId) => artifactPath(taskId, 'correctness.json');
const runnerStatusPath = (taskId) => artifactPath(taskId, 'runner-status.json');
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const isTerminal = (task) => terminalTaskStatuses.has(task.status) && task.resourceRelease?.confirmed === true;
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const readJson = async (filename) => {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const atomicJson = async (filename, value) => {
  const temporary = filename + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    // A restarted supervisor can still have the target opened while the
    // current owner persists a reconciled snapshot. Windows reports that
    // short overlap as EPERM/EBUSY; bounded replacement retries preserve the
    // atomic-write contract without turning a transient handle into a stuck
    // task.
    let replaced = false;
    for (let attempt = 0; attempt < 12 && !replaced; attempt += 1) {
      try {
        await rename(temporary, filename);
        replaced = true;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 11) throw error;
        await pause(25 * (attempt + 1));
      }
    }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
};
const withTaskLock = async (taskId, operation) => {
  const filename = artifactPath(taskId, 'metadata.lock');
  await mkdir(taskDirFor(taskId), { recursive: true });
  const deadline = Date.now() + 2_000;
  while (true) {
    try { await writeFile(filename, process.pid + ' ' + ownerId, { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = await readFile(filename, 'utf8'); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      const ownerPid = Number(owner.split(' ')[0]);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid)) { await rm(filename, { force: true }); continue; }
      if (Date.now() >= deadline) throw fail('Local task metadata is busy.', 'LOCAL_C500_TASK_BUSY', 409);
      await pause(10);
    }
  }
  try { return await operation(); } finally { await rm(filename, { force: true }); }
};

export const reconcileLocalTaskSnapshot = (stored, incoming) => {
  if (!stored) return incoming;
  if (isTerminal(stored)) return stored;
  if (isTerminal(incoming)) return { ...incoming, cancelRequested: stored.cancelRequested || incoming.cancelRequested };
  return {
    ...incoming, cancelRequested: stored.cancelRequested || incoming.cancelRequested,
    cancelReason: stored.cancelReason || incoming.cancelReason,
    status: stored.cancelRequested && incoming.status !== 'quarantined' ? 'cancel_requested' : incoming.status,
    progress: Math.max(Number(stored.progress || 0), Number(incoming.progress || 0)),
    logs: (stored.logs || []).length > (incoming.logs || []).length ? stored.logs : incoming.logs,
  };
};
const loadTask = async (taskId) => {
  const task = await readJson(taskPath(taskId));
  if (!task) throw fail('Local C550 task not found: ' + taskId, 'LOCAL_C500_TASK_NOT_FOUND', 404);
  return task;
};
const saveTask = async (task) => {
  const snapshot = structuredClone(task);
  const previous = taskWriteChains.get(task.taskId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => withTaskLock(task.taskId, async () => {
    const persisted = reconcileLocalTaskSnapshot(await readJson(taskPath(task.taskId)), snapshot);
    await atomicJson(taskPath(task.taskId), persisted);
    return persisted;
  }));
  taskWriteChains.set(task.taskId, current);
  current.finally(() => { if (taskWriteChains.get(task.taskId) === current) taskWriteChains.delete(task.taskId); }).catch(() => {});
  return current;
};
const taskView = (task) => structuredClone({
  taskId: task.taskId, status: task.status, progress: task.progress || 0,
  submittedAt: task.submittedAt, startedAt: task.startedAt || null, completedAt: task.completedAt || null,
  durationMs: task.durationMs || 0, logs: task.logs || [], result: task.result || null, error: task.error || null,
  requestId: task.payload?.requestId, deadlineAt: task.deadlineAt,
  cancelRequested: task.cancelRequested === true, cancelReason: task.cancelReason || null,
  executionClaim: task.executionClaim || null,
  resourceRelease: task.resourceRelease || release(false, 'quarantined', 'Legacy task has no release confirmation.', task.deadlineAt, 'Inspect the execution owner and artifacts.'),
});
const taskIdFor = (requestId, missionId) => 'local_c500_' + createHash('sha256').update(JSON.stringify([missionId || null, requestId])).digest('hex').slice(0, 32).toUpperCase();
const assertRequest = (task, payload) => {
  const submitted = structuredClone(task.submissionPayload || task.payload);
  // The test tool adds this trusted transport field after the queue freezes its
  // request. It must not make read-only lost-response reconciliation conflict.
  if (submitted?.packageDigest && payload && !Object.hasOwn(payload, 'preparedArtifactDigest')) delete submitted.preparedArtifactDigest;
  if (payload && !isDeepStrictEqual(submitted, JSON.parse(JSON.stringify(payload)))) {
    throw fail('Local task request ID is already bound to different content.', 'OPERATOR_TEST_REQUEST_CONFLICT', 409);
  }
};


const renderCommand = (template, task) => template
  .replaceAll('{taskId}', task.taskId).replaceAll('{taskDir}', taskDirFor(task.taskId))
  .replaceAll('{runPy}', runPyPath(task.taskId)).replaceAll('{resultJson}', resultPath(task.taskId))
  .replaceAll('{purpose}', task.purpose || 'candidate');

const refreshTask = async (taskId) => {
  let task = await loadTask(taskId);
  if (isTerminal(task)) return task;
  const claim = await readJson(artifactPath(taskId, 'execution-claim.json'));
  if (claim) task.executionClaim = claim;
  const receipt = await readJson(artifactPath(taskId, 'execution-exit.json'));
  if (receipt) {
    if (receipt.ownerId !== claim?.ownerId) {
      task.status = 'quarantined';
      task.error = { code: 'LOCAL_C500_EXIT_RECEIPT_INVALID', category: 'internal', phase: 'recovery', retryable: false, message: 'Execution receipt does not match the durable owner claim.' };
      task.resourceRelease = release(false, 'quarantined', task.error.message, task.deadlineAt, 'Inspect claim and receipt; do not relaunch.');
      return saveTask(task);
    }
    task.resourceRelease = receipt.resourceRelease;
    if (!receipt.resourceRelease?.confirmed) {
      task.status = 'quarantined';
      task.error = { code: 'LOCAL_C500_RESOURCE_RELEASE_UNCONFIRMED', category: 'timeout', phase: 'cancel', retryable: false, message: receipt.resourceRelease?.reason || 'Process release is unconfirmed.' };
      return saveTask(task);
    }
    let parsed, resultError;
    try { parsed = await readJson(resultPath(taskId)); } catch (error) { resultError = error; }
    if (receipt.cancelled) {
      task.status = receipt.cancelReason === 'task_deadline' ? 'failed' : 'cancelled';
      task.error = task.status === 'failed'
        ? { code: 'LOCAL_C500_TASK_DEADLINE', category: 'timeout', phase: 'execution', role: 'backend', retryable: false, message: 'Task exceeded its total deadline; process tree exit is confirmed.' }
        : null;
    } else if (parsed?.status === 'failed' || receipt.exitCode !== 0) {
      let correctness = parsed?.correctness || null;
      if (!correctness) { try { correctness = await readJson(correctnessPath(taskId)); } catch { /* preserve the primary failure */ } }
      task.status = 'failed';
      task.result = parsed || null;
      task.error = {
        ...(parsed?.error || correctness?.failure || {}),
        code: parsed?.error?.code || correctness?.failure?.code || 'LOCAL_C500_RUNNER_FAILED',
        message: parsed?.error?.message || correctness?.failure?.message || receipt.stderr || receipt.stdout || 'Local runner exited unsuccessfully.',
        ...(correctness ? { correctness } : {}),
      };
    } else if (resultError || !parsed || !Array.isArray(parsed.benchmark) || !parsed.environment) {
      task.status = 'failed';
      task.error = { code: 'LOCAL_C500_RESULT_INVALID', category: 'validation', phase: 'result', role: 'backend', retryable: false, message: 'Runner must write valid result.json with benchmark[] and environment.' };
    } else {
      task.status = 'completed';
      task.result = parsed;
      task.error = null;
    }
    task.progress = 100;
    task.completedAt = receipt.completedAt || now();
    task.durationMs = Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt || task.submittedAt));
    task.logs = [...(task.logs || []), { sequence: (task.logs || []).length + 1, at: now(), progress: 100,
      message: task.error?.message || (task.status === 'cancelled' ? 'Cancellation confirmed by the process supervisor.' : 'Runner completed with confirmed resource release.') }];
    return saveTask(task);
  }
  if (claim && !activeExecutions.has(taskId)) {
    task.status = 'quarantined';
    task.error = { code: 'LOCAL_C500_EXECUTION_OWNER_UNKNOWN', category: 'internal', phase: 'recovery', role: 'backend', retryable: false,
      message: 'Execution was claimed by another owner; no durable exit receipt is available.' };
    task.resourceRelease = release(false, 'quarantined', task.error.message, task.deadlineAt, 'Reconcile the existing supervisor or request cancellation; never spawn this task again.');
  }
  try {
    const status = await readJson(runnerStatusPath(taskId));
    if (status && Number(status.progress) > Number(task.progress || 0)) {
      task.progress = Number(status.progress);
      task.logs = [...(task.logs || []), { sequence: (task.logs || []).length + 1, at: now(), progress: task.progress, message: status.message || status.stage || 'Runner progress.' }];
    }
  } catch { /* partial progress must not mask the process receipt */ }
  return saveTask(task);
};

const prepareArtifacts = async (task) => {
  await writeFile(runPyPath(task.taskId), task.payload.runPy, 'utf8');
  if (task.payload.oracleRunPy) await writeFile(oracleRunPyPath(task.taskId), task.payload.oracleRunPy, 'utf8');
  for (const [filename, content] of Object.entries(task.payload.implementationFiles || {})) {
    await mkdir(path.dirname(artifactPath(task.taskId, filename)), { recursive: true });
    await writeFile(artifactPath(task.taskId, filename), content, 'utf8');
  }
  return { ...task, artifactsReady: true, status: 'waiting' };
};

const startTask = async (task, cancelStepMs) => {
  if (activeExecutions.has(task.taskId)) return activeExecutions.get(task.taskId).started;
  const execution = { child: null, started: null, promise: null };
  activeExecutions.set(task.taskId, execution);
  execution.started = (async () => {
    const taskId = task.taskId;
    const claim = { schemaVersion: 1, ownerId, ownerPid: process.pid, pid: null, supervisorPid: null, claimedAt: now() };
    try {
      const current = await withTaskLock(taskId, async () => {
        const stored = await loadTask(taskId);
        if (isTerminal(stored) || stored.cancelRequested) return stored;
        await writeFile(artifactPath(taskId, 'execution-claim.json'), JSON.stringify(claim) + '\n', { flag: 'wx' });
        return null;
      });
      if (current) { activeExecutions.delete(taskId); return current; }
    }
    catch (error) {
      activeExecutions.delete(taskId);
      if (error.code === 'EEXIST') return refreshTask(taskId);
      throw error;
    }
    task = await loadTask(taskId);
    task = await saveTask({
      ...task, status: task.cancelRequested ? 'cancel_requested' : 'running', startedAt: task.startedAt || now(),
      progress: Math.max(10, task.progress || 0), executionClaim: claim,
      resourceRelease: release(false, 'active', 'Durable execution claim is owned by the local supervisor.', task.deadlineAt, 'Await a matching exit receipt.'),
      logs: [...(task.logs || []), { sequence: (task.logs || []).length + 1, at: now(), progress: 10, message: 'Local backend execution claimed exactly once.' }],
    });
    if (mockEnabled) {
      execution.promise = (async () => {
        try {
          const result = await mockResult(task);
          await atomicJson(resultPath(taskId), result);
          await atomicJson(artifactPath(taskId, 'execution-exit.json'), { ownerId, exitCode: 0, completedAt: now(), resourceRelease: release(true, 'confirmed', 'Mock execution has completed; no hardware process exists.') });
        } catch (error) {
          await atomicJson(resultPath(taskId), { status: 'failed', benchmark: [], environment: { source: 'simulation', liveHardware: false }, error: { code: error.code || 'LOCAL_C500_MOCK_FAILED', message: error.message } });
          await atomicJson(artifactPath(taskId, 'execution-exit.json'), { ownerId, exitCode: 1, completedAt: now(), resourceRelease: release(true, 'confirmed', 'Mock execution failed without owning a hardware process.') });
        }
        return refreshTask(taskId);
      })().finally(() => activeExecutions.delete(taskId));
      return task;
    }
    if (hardwareDisabled && !explicitRunnerCommand) {
      await atomicJson(resultPath(taskId), { status: 'failed', benchmark: [], environment: { liveHardware: false }, error: { code: 'LOCAL_C500_HARDWARE_DISABLED', message: 'Hardware execution is disabled for this verification run.' } });
      await atomicJson(artifactPath(taskId, 'execution-exit.json'), { ownerId, exitCode: 1, completedAt: now(), resourceRelease: release(true, 'confirmed', 'No process was created.') });
      activeExecutions.delete(taskId);
      return refreshTask(taskId);
    }
    await writeFile(artifactPath(taskId, 'runner-supervisor.mjs'), supervisorSource, 'utf8');
    await atomicJson(artifactPath(taskId, 'execution-config.json'), { command: renderCommand(commandTemplate, task), deadlineAt: task.deadlineAt, cancelStepMs });
    if (task.cancelRequested) await atomicJson(artifactPath(taskId, 'cancel-request.json'), { nonce: randomUUID(), reason: task.cancelReason || 'user', requestedAt: now() });
    const child = spawn(process.execPath, [artifactPath(taskId, 'runner-supervisor.mjs'), taskDirFor(taskId)], {
      cwd: taskDirFor(taskId), windowsHide: true, detached: true, stdio: 'ignore',
      env: {
        ...process.env, OPERATOR_LOCAL_C500_TASK_ID: taskId, OPERATOR_LOCAL_C500_TASK_DIR: taskDirFor(taskId),
        OPERATOR_LOCAL_C500_RUN_PY: runPyPath(taskId), OPERATOR_LOCAL_C500_RESULT_JSON: resultPath(taskId),
        OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR: referenceCacheRoot,
        OPERATOR_LOCAL_C500_EXPECTED_DEVICE: String(task.hardware?.[0] || 'C550'),
        ...(task.payload.oracleRunPy ? { OPERATOR_LOCAL_C500_ORACLE_RUN_PY: oracleRunPyPath(taskId) } : {}),
      },
    });
    execution.child = child;
    child.unref();
    execution.promise = new Promise((resolve) => {
      child.once('error', async (error) => {
        await atomicJson(artifactPath(taskId, 'execution-exit.json'), { ownerId, exitCode: 1, stderr: error.message, completedAt: now(),
          resourceRelease: release(true, 'confirmed', 'Supervisor failed before process creation.') }).catch(() => {});
      });
      child.once('close', async () => {
        activeExecutions.delete(taskId);
        try { resolve(await refreshTask(taskId)); } catch { resolve(null); }
      });
    });
    return task;
  })().catch(async (error) => {
    activeExecutions.delete(task.taskId);
    const latest = await loadTask(task.taskId);
    await saveTask({ ...latest, status: 'quarantined', error: { code: error.code || 'LOCAL_C500_START_UNKNOWN', message: error.message },
      resourceRelease: release(false, 'quarantined', 'Execution claim exists but launch outcome is unknown.', latest.deadlineAt, 'Inspect the supervisor claim; never relaunch.') });
    throw error;
  });
  return execution.started;
};

export const createLocalC500ServiceClient = ({ root = taskRoot, cancelStepMs = 500, cancelTimeoutMs = 3_000, packageResolver = null } = {}) => {
  if (root !== taskRoot) throw new Error('Local C550 client root override is not supported after runtime startup.');
  const stepLimit = Math.max(10, Number(cancelStepMs) || 500);
  const cancelLimit = Math.max(10, Number(cancelTimeoutMs) || 3_000);
  const submit = async (payload) => {
    if (!payload?.operator || !payload?.candidate?.digest) throw fail('Local C550 task requires operator and candidate.digest.', 'OPERATOR_TEST_TASK_INVALID');
    if (!Array.isArray(payload.matrix?.environments) || !payload.matrix.environments.length) throw fail('Local C550 task requires matrix.environments.', 'OPERATOR_TEST_TASK_INVALID');
    const submissionPayload = JSON.parse(JSON.stringify(payload));
    let sourcePayload = submissionPayload;
    if (sharedGpuEnabled && packageResolver) {
      if (!payload.packageDigest || !payload.admissionId) throw fail('Shared-GPU execution requires a validated execution package admission.', 'PACKAGE_NOT_ADMITTED', 409);
      sourcePayload = await packageResolver(structuredClone(submissionPayload));
      if (!sourcePayload?.runPy || !sourcePayload?.oracleRunPy) throw fail('Prepared execution package is missing candidate or acceptance entrypoints.', 'PACKAGE_ENTRYPOINT_INVALID', 422);
      sourcePayload = { ...submissionPayload, ...sourcePayload };
    }
    if (!sourcePayload.runPy) throw fail('The production Mission workspace did not provide generated run.py content.', 'LOCAL_C500_ARTIFACT_MISSING', 409);
    const frozen = JSON.parse(JSON.stringify(sourcePayload));
    frozen.requestId ||= 'local_request_' + randomUUID();
    const taskId = taskIdFor(frozen.requestId, frozen.missionId);
    const scripted = isScriptedSequenceTask({ payload: frozen });
    if (scripted && !frozen.missionId) throw fail('Scripted MLA tasks require missionId.', 'OPERATOR_TEST_TASK_INVALID');
    if (scripted && frozen.purpose !== 'baseline' && !/^sha256:[a-f0-9]{64}$/.test(frozen.candidate.digest)) throw fail('Scripted MLA candidates require a real workspace diff digest.', 'LOCAL_C500_SCENARIO_DIFF_DIGEST_REQUIRED', 409);
    const reserved = new Set(['run.py', 'oracle.py', 'task.json', 'result.json', 'correctness.json', 'runner-status.json', 'metadata.lock']);
    for (const [filename, content] of (sharedGpuEnabled && packageResolver ? [] : Object.entries(frozen.implementationFiles || {}))) {
      if (!filename || path.isAbsolute(filename) || filename.includes('..') || /[\\/\0<>:"|?*]/.test(filename)
          || filename !== filename.trim() || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
          || reserved.has(filename.toLowerCase()) || /^(execution-|cancel-request|runner-supervisor|runner\.)/i.test(filename)) {
        throw fail('Implementation artifact cannot replace reserved backend files or escape the task root.', 'LOCAL_C500_ARTIFACT_PATH_INVALID', 409);
      }
      if (typeof content !== 'string') throw fail('Implementation artifact content must be text.', 'LOCAL_C500_ARTIFACT_INVALID', 409);
    }
    const task = await withTaskLock(taskId, async () => {
      const existing = await readJson(taskPath(taskId));
      if (existing) { assertRequest(existing, submissionPayload); return existing; }
      const requestedMs = Number(frozen.limits?.timeoutSeconds) * 1000;
      const timeoutMs = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : 120_000;
      let created = {
        schemaVersion: 2, taskId, status: 'preparing', progress: 0, submittedAt: now(),
        deadlineAt: new Date(Date.now() + timeoutMs).toISOString(), payload: frozen,
        ...(sharedGpuEnabled && packageResolver ? { submissionPayload } : {}),
        operator: frozen.operator, purpose: frozen.purpose, candidate: frozen.candidate, matrix: frozen.matrix,
        metric: frozen.metric, hardware: frozen.hardware, runPySource: frozen.runPySource || 'production-mission-workspace/run.py',
        runPyDigest: runPyDigestFor(frozen.runPy), mockScenario: iterativeMlaScenario ? mockScenario : null,
        logs: [], result: null, error: null, resourceRelease: release(true, 'not_started', 'No execution has been claimed.'),
      };
      await atomicJson(taskPath(taskId), created);
      created = await prepareArtifacts(created);
      await atomicJson(taskPath(taskId), created);
      return created;
    });
    return { ...taskView(task), status: task.status === 'waiting' ? 'queued' : task.status };
  };
  const get = async (taskId) => taskView(await loadTask(taskId));
  const advance = async (taskId) => {
    let task = await loadTask(taskId);
    if (isTerminal(task)) return taskView(task);
    const claim = await readJson(artifactPath(taskId, 'execution-claim.json'));
    if (claim) return taskView(await refreshTask(taskId));
    if (task.cancelRequested) return cancel(taskId);
    if (!task.artifactsReady) task = await saveTask(await prepareArtifacts(task));
    await startTask(task, stepLimit);
    if (mockEnabled) await activeExecutions.get(taskId)?.promise;
    return taskView(await loadTask(taskId));
  };
  const cancel = async (taskId, { reason = 'user' } = {}) => {
    let task = await withTaskLock(taskId, async () => {
      const stored = await loadTask(taskId);
      if (isTerminal(stored)) return stored;
      const claim = await readJson(artifactPath(taskId, 'execution-claim.json'));
      const cancelled = {
        ...stored, cancelRequested: true, cancelReason: stored.cancelReason || reason,
        status: claim ? 'cancel_requested' : 'cancelled', completedAt: claim ? null : now(),
        resourceRelease: claim
          ? release(false, 'pending', 'Cancellation awaits owned process-tree exit.', new Date(Date.now() + cancelLimit).toISOString(), 'Wait for the supervisor receipt.')
          : release(true, 'confirmed', 'Cancelled before an execution claim was created.'),
      };
      await atomicJson(taskPath(taskId), cancelled);
      return cancelled;
    });
    if (isTerminal(task)) return taskView(task);
    await atomicJson(artifactPath(taskId, 'cancel-request.json'), { nonce: randomUUID(), reason: task.cancelReason, requestedAt: now() });
    const deadline = Date.now() + cancelLimit;
    while (Date.now() < deadline) {
      task = await refreshTask(taskId);
      if (isTerminal(task)) return taskView(task);
      await pause(40);
    }
    task = await saveTask({ ...task, status: 'quarantined',
      resourceRelease: release(false, 'quarantined', 'Cancellation deadline elapsed without confirmed process-tree exit.', new Date(deadline).toISOString(), 'Inspect or retry cancellation; the slot must remain occupied.'),
      error: { code: 'LOCAL_C500_CANCEL_UNCONFIRMED', category: 'timeout', phase: 'cancel', role: 'backend', retryable: false, message: 'Process-tree release is unconfirmed.' } });
    return taskView(task);
  };
  return {
    capabilities: async () => ({
      backendId: localC500Config.kind,
      queryIsReadOnly: true,
      idempotentSubmission: true,
      targets: [{ platform: sharedGpuEnabled ? 'nvidia-cuda' : 'local-c500', device: sharedGpuEnabled ? 'gpu' : 'c550' }],
      adapters: sharedGpuEnabled ? [{ id: 'python-shared-gpu', version: '1', languages: ['python'] }] : [],
    }),
    submit, get, advance, cancel,
    findByRequestId: async (requestId, missionId, expectedPayload = null) => {
      const task = await readJson(taskPath(taskIdFor(requestId, missionId)));
      if (!task) return null;
      assertRequest(task, expectedPayload);
      return taskView(task);
    },
    events: async (taskId) => {
      const task = await loadTask(taskId);
      return { taskId, events: task.logs || [], nextSequence: (task.logs || []).length };
    },
  };
};

export const localC500Config = {
  kind: 'local-c500',
  device: sharedGpuEnabled ? 'NVIDIA GPU' : cpuE2eEnabled ? 'CPU' : process.env.OPERATOR_MUXI_DEVICE || 'C550',
  enabled: process.env.OPERATOR_TEST_BACKEND === 'local-c500' || sharedGpuEnabled,
  simulation: simulationEnabled, mock: mockEnabled,
  liveHardware: sharedGpuEnabled || (!mockEnabled && !cpuE2eEnabled),
  executionMode: sharedGpuEnabled ? 'shared-host-gpu' : cpuE2eEnabled ? 'cpu-e2e' : simulationEnabled ? 'full-simulation' : mockEnabled ? 'hardware-mock' : 'real-c550',
  publishable: sharedGpuEnabled ? false : true,
  taskRoot, commandConfigured: Boolean(commandTemplate), hardwareDisabled, scenario: iterativeMlaScenario ? mockScenario : null,
  bundledRunner: sharedGpuEnabled ? sharedGpuRunner : bundledRunner,
};
if (sharedGpuEnabled) localC500Config.kind = 'local-shared-gpu';

const runPyDigestFor = (runPy) => `sha256:${createHash('sha256').update(String(runPy || '')).digest('hex')}`;

const validateIterativeMlaRunPy = (task) => {
  const text = String(task.payload?.runPy || '');
  const missing = ['get_inputs', 'run', 'reference'].filter((name) => !new RegExp(`(^|\\n)def\\s+${name}\\s*\\(`).test(text));
  const identity = [task.payload?.operator, task.payload?.baselineSource?.operator, task.payload?.baselineMaterialization?.source?.operator, text].filter(Boolean).join('\n');
  const fixedProfile = Boolean(task?.payload?.baselineSource?.profileId)
    || Boolean(task?.payload?.baselineMaterialization?.source?.profileId);
  const identifiesOperator = fixedProfile
    || (/attention|decode|mla|mqa|logits/i.test(identity)
      && /paged|page|kv|block/i.test(identity)
      && /page_size|page_ids|kv_indices|block_tables?/i.test(text));
  if (missing.length || !identifiesOperator) {
    throw fail(
      `Scripted C550 scenario rejected run.py: missing=${missing.join(',') || '-'} operatorIdentity=${identifiesOperator ? 'ok' : 'missing'}.`,
      'LOCAL_C500_SCENARIO_ARTIFACT_INVALID',
      422,
    );
  }
};

const loadMockLedger = async () => {
  try {
    return JSON.parse(await readFile(mockLedgerPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 1, assignments: {} };
  }
};

const assignIterativeMlaMeasurement = async (task) => {
  validateIterativeMlaRunPy(task);
  const ledger = await loadMockLedger();
  const missionId = task.payload?.missionId;
  const assignmentKey = `${missionId}:${task.purpose}:${task.candidate.digest}`;
  const runPyDigest = runPyDigestFor(task.payload.runPy);
  const existing = ledger.assignments[assignmentKey];
  if (existing) {
    if (existing.runPyDigest !== runPyDigest) {
      throw fail('The same candidate digest was submitted with different run.py content.', 'LOCAL_C500_SCENARIO_DIGEST_MISMATCH', 409);
    }
    return existing;
  }

  const missionAssignments = Object.values(ledger.assignments).filter((item) => item.missionId === missionId);
  if (task.purpose === 'baseline') {
    if (missionAssignments.some((item) => item.purpose === 'baseline')) {
      throw fail('A different baseline digest was submitted after the scripted baseline was fixed.', 'LOCAL_C500_SCENARIO_BASELINE_CHANGED', 409);
    }
    const assignment = { missionId, purpose: 'baseline', ordinal: 0, value: 100, runPyDigest, candidateDigest: task.candidate.digest };
    ledger.assignments[assignmentKey] = assignment;
    await mkdir(taskRoot, { recursive: true });
    await writeFile(mockLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    return assignment;
  }

  const candidates = missionAssignments.filter((item) => item.purpose === 'candidate');
  if (candidates.some((item) => item.runPyDigest === runPyDigest)) {
    throw fail('A new candidate digest reused an already tested run.py artifact.', 'LOCAL_C500_SCENARIO_RUN_PY_REPEATED', 409);
  }
  if (candidates.length >= 3) {
    throw fail('The scripted MLA scenario is complete; a fourth unique candidate is forbidden.', 'LOCAL_C500_SCENARIO_SEQUENCE_EXHAUSTED', 409);
  }
  const values = [92, 84, 75];
  const assignment = { missionId, purpose: 'candidate', ordinal: candidates.length + 1, value: values[candidates.length], runPyDigest, candidateDigest: task.candidate.digest };
  ledger.assignments[assignmentKey] = assignment;
  await mkdir(taskRoot, { recursive: true });
  await writeFile(mockLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return assignment;
};

const mockResult = async (task) => {
  const environment = task.matrix?.environments?.[0] || 'C550';
  const assignment = isScriptedSequenceTask(task)
    ? await assignIterativeMlaMeasurement(task)
    : { ordinal: task.purpose === 'baseline' ? 0 : 1, value: 0, runPyDigest: runPyDigestFor(task.payload?.runPy), candidateDigest: task.candidate.digest };
  const roundSummary = assignment.ordinal === 0
    ? 'baseline reference established'
    : assignment.ordinal === 1
      ? 'launch and page-table overhead remains'
      : assignment.ordinal === 2
        ? 'memory scheduling improved; target still missed'
        : 'paged MLA scheduling reaches the target';
  return {
    benchmark: [{
      environment,
      metric: task.metric || 'latency_p50',
      value: assignment.value,
      unit: 'us',
      samples: Number(task.matrix?.repeats || 200),
      warmup: Number(task.matrix?.warmup || 50),
      correctness: { passed: true, total: Number(task.matrix?.correctnessCases || 24) },
    }],
    tracer: { format: 'operator-trace/v1', status: 'completed', events: [{ name: 'scripted-c500-measurement', summary: roundSummary }], simulated: true },
    profiler: { format: 'operator-profile/v1', status: 'completed', metrics: { scripted_round: assignment.ordinal, summary: roundSummary }, simulated: true },
    environment: {
      requested: task.hardware || task.matrix?.environments || [],
      runtime: 'local-c500-mock',
      service: 'local-c500-adapter',
      liveHardware: false,
      source: 'simulation',
    },
    scenario: iterativeMlaScenario ? { id: mockScenario, ...assignment } : null,
  };
};


const supervisorSource = String.raw`
// Task-owned CPU/C550 process supervisor. No Mission/workflow policy.
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
const taskDir = process.argv[2];
const target = (name) => path.join(taskDir, name);
const read = async (name) => { try { return JSON.parse(await readFile(target(name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const write = async (name, value) => {
  const temporary = target(name + '.' + process.pid + '.tmp');
  await writeFile(temporary, JSON.stringify(value) + '\n', 'utf8');
  await rename(temporary, target(name));
};
const config = await read('execution-config.json');
let claim = await read('execution-claim.json');
let child = null, closed = false, exitCode = null, exitSignal = null;
let stdout = '', stderr = '', stopping = false, cancellation = null, lastNonce = null, treeSignalled = false, signalError = null;
let resolveClose;
const closedPromise = new Promise((resolve) => { resolveClose = resolve; });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closeWithin = (ms) => Promise.race([closedPromise.then(() => true), wait(ms).then(() => false)]);
const groupGone = () => {
  if (!child?.pid) return true;
  if (process.platform === 'win32') return closed && (!cancellation || treeSignalled || exitCode === 0 && exitSignal === null);
  try { process.kill(-child.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
};
const finish = async (confirmed, reason) => {
  await write('runner.stdout.log', stdout);
  await write('runner.stderr.log', stderr);
  await write('execution-exit.json', {
    ownerId: claim.ownerId, supervisorPid: process.pid, pid: child?.pid || null,
    exitCode, signal: exitSignal, cancelled: Boolean(cancellation)
      && (cancellation.reason === 'task_deadline' || !(exitCode === 0 && exitSignal === null)),
    cancelReason: cancellation?.reason || null, closed,
    completedAt: confirmed ? new Date().toISOString() : null,
    resourceRelease: { confirmed, status: confirmed ? 'confirmed' : 'quarantined', reason,
      deadline: config.deadlineAt, nextAction: confirmed ? null : 'Inspect or retry cancellation; this execution slot remains occupied.' },
    stdout: stdout.slice(-8192), stderr: stderr.slice(-8192), signalError,
  });
};
const forceStopTreeWithPowerShell = (pid) => new Promise((resolve) => {
  // The PID is produced by Node and validated as an integer before it is
  // interpolated. Keep this fallback narrow: it is only used when the normal
  // taskkill adapter is unavailable (for example, a managed runner denies
  // taskkill.exe). The recursive lookup is performed before stopping the root
  // so descendants cannot outlive the task owner.
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return resolve(false);
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$source = \'using System; using System.Runtime.InteropServices; public static class OperatorParentProcess { [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0; public IntPtr Reserved2_1; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; } [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle); [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PBI info, int length, out int returned); public static int GetParent(int pid) { IntPtr handle=OpenProcess(0x1000,false,pid); if(handle==IntPtr.Zero)return -1; try { PBI info=new PBI(); int returned; int status=NtQueryInformationProcess(handle,0,ref info,Marshal.SizeOf(info),out returned); return status==0 ? info.InheritedFromUniqueProcessId.ToInt32() : -2; } finally { CloseHandle(handle); } } }\'',
    'Add-Type -TypeDefinition $source',
    '$owned = [Collections.Generic.HashSet[int]]::new()',
    'function Collect-Tree([int]$root) {',
    '  if (-not $owned.Add($root)) { return }',
    '  $children = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { [OperatorParentProcess]::GetParent($_.Id) -eq $root })',
    '  foreach ($item in $children) { Collect-Tree $item.Id }',
    '}',
    'Collect-Tree ' + String(numericPid),
    'foreach ($ownedPid in $owned) { Stop-Process -Id $ownedPid -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Milliseconds 60',
    '$stillAlive = @($owned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })',
    'if ($stillAlive.Count -gt 0) { exit 17 }',
  ].join('; ');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024 }, (error) => resolve(!error));
});
const signalTree = (force) => new Promise((resolve) => {
  if (!child?.pid || closed && groupGone()) return resolve(true);
  if (closed) return resolve(false); // Never signal a PID after its owned child has exited.
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])],
      { windowsHide: true, timeout: 1_000, maxBuffer: 64 * 1024 }, async (error) => {
        if (!error) return resolve(true);
        signalError = { code: error.code || 'PROCESS_TREE_SIGNAL_FAILED', message: error.message, timedOut: error.killed === true };
        // A hard fallback is preferable to leaving a claimed execution slot
        // occupied forever. Its receipt retains signalError so callers can
        // distinguish this development-environment path from taskkill.
        const fallback = await forceStopTreeWithPowerShell(child.pid);
        resolve(fallback);
      });
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); resolve(true); }
    catch (error) { resolve(error.code === 'ESRCH'); }
  }
});
const stop = async (request) => {
  if (stopping) return;
  stopping = true;
  cancellation = request;
  lastNonce = request.nonce;
  try {
    treeSignalled = await signalTree(false) || treeSignalled;
    await closeWithin(config.cancelStepMs);
    if (!closed || !groupGone()) {
      treeSignalled = await signalTree(true) || treeSignalled;
      await closeWithin(config.cancelStepMs);
    }
    await finish(closed && groupGone(), closed && groupGone() ? 'Owned process tree exited after cancellation.' : 'Process tree did not confirm exit before the cancellation deadline.');
  } finally { stopping = false; }
};
const initialCancel = await read('cancel-request.json')
  || (Date.now() >= Date.parse(config.deadlineAt) ? { reason: 'task_deadline', nonce: 'deadline' } : null);
if (initialCancel) {
  cancellation = initialCancel; closed = true;
  await finish(true, 'Cancellation was observed before a runner process was created.');
} else {
  child = spawn(config.command, {
    cwd: taskDir, shell: true, detached: process.platform !== 'win32', windowsHide: true,
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024); });
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8 * 1024 * 1024); });
  child.once('error', (error) => { stderr += error.code + ': ' + error.message; });
  child.once('close', (code, signal) => {
    closed = true; exitCode = code; exitSignal = signal; resolveClose();
  });
  claim = { ...claim, supervisorPid: process.pid, pid: child.pid || null, spawnedAt: new Date().toISOString() };
  await write('execution-claim.json', claim);
  while (!closed || stopping) {
    const request = await read('cancel-request.json');
    const expired = Date.now() >= Date.parse(config.deadlineAt);
    if (!stopping && request && request.nonce !== lastNonce) await stop(request);
    else if (!stopping && expired && !cancellation) await stop({ reason: 'task_deadline', nonce: 'deadline' });
    if (!closed) await wait(40);
  }
  if (!cancellation && !groupGone()) await stop({ reason: 'descendant_cleanup', nonce: 'cleanup' });
  await finish(groupGone(), groupGone() ? 'Runner process and owned process tree have exited.' : 'Runner exited but descendant release is unconfirmed.');
}

`;
