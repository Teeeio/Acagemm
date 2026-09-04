import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledRunner = path.join(rootDir, 'tools', 'local-c500-runner.py');
const runtimeDir = process.env.OPERATOR_RUNTIME_DIR
  ? path.resolve(process.env.OPERATOR_RUNTIME_DIR)
  : path.join(rootDir, 'runtime');
const taskRoot = process.env.OPERATOR_LOCAL_C500_DIR
  ? path.resolve(process.env.OPERATOR_LOCAL_C500_DIR)
  : path.join(runtimeDir, 'local-c500');
const commandTemplate = process.env.OPERATOR_LOCAL_C500_COMMAND || `python "${bundledRunner}"`;
const explicitRunnerCommand = Boolean(process.env.OPERATOR_LOCAL_C500_COMMAND);
const mockEnabled = process.env.OPERATOR_LOCAL_C500_MOCK === '1';
const cpuE2eEnabled = process.env.OPERATOR_LOCAL_CPU === '1';
const hardwareDisabled = process.env.OPERATOR_HARDWARE_DISABLED === '1';
const mockScenario = process.env.OPERATOR_LOCAL_C500_MOCK_SCENARIO || '';
const iterativeMlaScenario = mockScenario === 'mla-three-round';

// A task is scripted (deterministic three-round improvement sequence) when it is
// the MLA three-round scenario OR a fixed four-operator profile mission. All such
// missions share the same closed-loop contract: baseline=100, candidates 92/84/75.
const isScriptedSequenceTask = (task) => iterativeMlaScenario
  || Boolean(task?.payload?.baselineSource?.profileId)
  || Boolean(task?.payload?.baselineMaterialization?.source?.profileId)
  || Boolean(task?.payload?.baselineSource?.repository && String(task.payload.baselineSource.repository).startsWith('operator-profile:'));
const mockLedgerPath = path.join(taskRoot, 'mock-sequence-ledger.json');

const now = () => new Date().toISOString();
const taskPath = (taskId) => path.join(taskRoot, taskId, 'task.json');
const runPyPath = (taskId) => path.join(taskRoot, taskId, 'run.py');
const oracleRunPyPath = (taskId) => path.join(taskRoot, taskId, 'oracle.py');
const resultPath = (taskId) => path.join(taskRoot, taskId, 'result.json');
const correctnessPath = (taskId) => path.join(taskRoot, taskId, 'correctness.json');
const runnerStatusPath = (taskId) => path.join(taskRoot, taskId, 'runner-status.json');
const referenceCacheRoot = path.join(taskRoot, 'reference-cache');
const activeExecutions = new Map();
const taskWriteChains = new Map();
const simulationEnabled = process.env.OPERATOR_LOCAL_C500_SIMULATION === '1';
const terminalTaskStatuses = new Set(['completed', 'failed', 'cancelled']);

export const reconcileLocalTaskSnapshot = (stored, incoming) => {
  if (!stored) return incoming;
  if (terminalTaskStatuses.has(stored.status)) return stored;
  if (terminalTaskStatuses.has(incoming.status)) return incoming;
  return {
    ...incoming,
    progress: Math.max(Number(stored.progress || 0), Number(incoming.progress || 0)),
    logs: (stored.logs || []).length > (incoming.logs || []).length ? stored.logs : incoming.logs,
  };
};

const fail = (message, code, status = 400) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const terminateProcessTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
};

const loadTask = async (taskId) => {
  try {
    await taskWriteChains.get(taskId);
    return JSON.parse(await readFile(taskPath(taskId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(`Local C500 task not found: ${taskId}`, 'LOCAL_C500_TASK_NOT_FOUND', 404);
    throw error;
  }
};

const saveTask = async (task) => {
  const snapshot = structuredClone(task);
  const taskId = snapshot.taskId;
  const previous = taskWriteChains.get(taskId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const target = taskPath(taskId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      let persisted = snapshot;
      try {
        const stored = JSON.parse(await readFile(target, 'utf8'));
        persisted = reconcileLocalTaskSnapshot(stored, snapshot);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
      return persisted;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  });
  taskWriteChains.set(taskId, current);
  current.finally(() => {
    if (taskWriteChains.get(taskId) === current) taskWriteChains.delete(taskId);
  }).catch(() => {});
  return current;
};

const taskView = (task) => ({
  taskId: task.taskId,
  status: task.status,
  progress: task.progress || 0,
  submittedAt: task.submittedAt,
  startedAt: task.startedAt || null,
  completedAt: task.completedAt || null,
  durationMs: task.durationMs || 0,
  logs: task.logs || [],
  result: task.result || null,
  error: task.error || null,
  cancelRequested: task.cancelRequested === true,
});

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
      `Scripted C500 scenario rejected run.py: missing=${missing.join(',') || '-'} operatorIdentity=${identifiesOperator ? 'ok' : 'missing'}.`,
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
  const environment = task.matrix?.environments?.[0] || 'C500';
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

const renderCommand = (template, task) => template
  .replaceAll('{taskId}', task.taskId)
  .replaceAll('{taskDir}', path.dirname(taskPath(task.taskId)))
  .replaceAll('{runPy}', runPyPath(task.taskId))
  .replaceAll('{resultJson}', resultPath(task.taskId))
  .replaceAll('{purpose}', task.purpose || 'candidate');

const readRunnerResult = async (task) => {
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(resultPath(task.taskId), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail(`Local C500 runner returned invalid result.json: ${error.message}`, 'LOCAL_C500_RESULT_INVALID');
  }
  if (!parsed || !Array.isArray(parsed.benchmark) || !parsed.environment) {
    throw fail('Local C500 runner must write result.json with benchmark[] and environment.', 'LOCAL_C500_RESULT_INVALID');
  }
  return parsed;
};

const runCommand = (command, task, timeoutMs) => new Promise((resolve, reject) => {
  const taskId = task.taskId;
  const child = spawn(command, {
    cwd: path.dirname(taskPath(taskId)),
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
    timeout: timeoutMs,
    env: {
      ...process.env,
      OPERATOR_LOCAL_C500_TASK_ID: taskId,
      OPERATOR_LOCAL_C500_TASK_DIR: path.dirname(taskPath(taskId)),
      OPERATOR_LOCAL_C500_RUN_PY: runPyPath(taskId),
      ...(task.payload?.oracleRunPy ? { OPERATOR_LOCAL_C500_ORACLE_RUN_PY: oracleRunPyPath(taskId) } : {}),
      OPERATOR_LOCAL_C500_RESULT_JSON: resultPath(taskId),
      OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR: referenceCacheRoot,
      OPERATOR_LOCAL_C500_EXPECTED_DEVICE: String(task.hardware?.[0] || 'C550'),
    },
  });
  const execution = activeExecutions.get(taskId);
  if (execution) execution.child = child;
  let stdout = '';
  let stderr = '';
  const treeTimeout = setTimeout(() => terminateProcessTree(child), Math.max(1, Number(timeoutMs) || 1));
  const append = (current, chunk) => `${current}${chunk}`.slice(-8 * 1024 * 1024);
  child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
  child.once('error', (error) => {
    clearTimeout(treeTimeout);
    if (error.code === 'ETIMEDOUT') terminateProcessTree(child);
    reject(error);
  });
  child.once('close', (status, signal) => {
    clearTimeout(treeTimeout);
    resolve({ status, signal, stdout, stderr });
  });
});

const executeTask = async (task) => {
  const started = Date.parse(task.startedAt || '') || Date.now();

  try {
    const result = mockEnabled
      ? await mockResult(task)
      : await (async () => {
        if (hardwareDisabled && !explicitRunnerCommand) {
          throw fail('Hardware execution is disabled for this verification run.', 'LOCAL_C500_HARDWARE_DISABLED', 503);
        }
        const command = renderCommand(commandTemplate, task);
        const processResult = await runCommand(command, task, Math.max(1, Number(task.payload?.limits?.timeoutSeconds || 120)) * 1000);
        if (processResult.status !== 0) {
          throw fail(processResult.stderr || processResult.stdout || 'Local C500 runner failed.', 'LOCAL_C500_RUNNER_FAILED', 500);
        }
        return readRunnerResult(task);
      })();
    task = await loadTask(task.taskId);
    if (task.cancelRequested) return task;
    task.status = 'completed';
    task.progress = 100;
    task.result = result;
    task.logs = [...task.logs, {
      sequence: 2,
      progress: 100,
      message: mockEnabled
        ? 'Simulation result completed; it is not publishable as hardware evidence.'
        : cpuE2eEnabled
          ? 'Local CPU E2E runner completed the generated Mission artifact; the result is not hardware evidence.'
          : 'Local C500 runner completed the generated Mission artifact.',
    }];
  } catch (error) {
    task = await loadTask(task.taskId);
    if (task.cancelRequested) return task;
    task.status = 'failed';
    task.progress = 100;
    let correctness = null;
    try { correctness = JSON.parse(await readFile(correctnessPath(task.taskId), 'utf8')); } catch { /* runner may fail before correctness starts */ }
    task.error = { code: error.code || 'LOCAL_C500_RUNNER_FAILED', message: error.message, ...(correctness ? { correctness } : {}) };
    task.logs = [...task.logs, { sequence: 2, progress: 100, message: task.error.message }];
  }
  task.completedAt = now();
  task.durationMs = Date.now() - started;
  return saveTask(task);
};

const startTaskExecution = async (task) => {
  const active = activeExecutions.get(task.taskId);
  if (active) return active.started;
  const execution = { child: null, promise: null, started: null };
  activeExecutions.set(task.taskId, execution);
  execution.started = (async () => {
    task.status = 'running';
    task.startedAt ||= now();
    task.progress = Math.max(10, Number(task.progress || 0));
    task.logs = task.logs?.length ? task.logs : [{ sequence: 1, progress: 10, message: 'Local C500 backend started on the production Mission artifact.' }];
    const persisted = await saveTask(task);
    execution.promise = executeTask(persisted)
      .catch(async (error) => {
        const latest = await loadTask(task.taskId);
        latest.status = 'failed';
        latest.progress = 100;
        latest.error = { code: error.code || 'LOCAL_C500_RUNNER_FAILED', message: error.message };
        latest.completedAt = now();
        await saveTask(latest);
      })
      .finally(() => activeExecutions.delete(task.taskId));
  })().catch((error) => {
    activeExecutions.delete(task.taskId);
    throw error;
  });
  return execution.started;
};

const refreshRunnerProgress = async (task) => {
  try {
    const status = JSON.parse(await readFile(runnerStatusPath(task.taskId), 'utf8'));
    if (Number(status.progress || 0) <= Number(task.progress || 0)) return task;
    task.progress = Number(status.progress);
    task.logs = [...(task.logs || []), { sequence: (task.logs || []).length + 1, progress: task.progress, message: status.message || status.stage || 'Runner progress updated.' }];
    return saveTask(task);
  } catch { return task; }
};

export const createLocalC500ServiceClient = ({ root = taskRoot } = {}) => {
  if (root !== taskRoot) {
    throw new Error('Local C500 client root override is not supported after runtime startup.');
  }
  return {
    submit: async (payload) => {
      if (!payload?.operator || !payload?.candidate?.digest) throw fail('Local C500 task requires operator and candidate.digest.', 'OPERATOR_TEST_TASK_INVALID');
      if (!Array.isArray(payload.matrix?.environments) || !payload.matrix.environments.length) throw fail('Local C500 task requires matrix.environments.', 'OPERATOR_TEST_TASK_INVALID');
      if (!payload.runPy) throw fail('The production Mission workspace did not provide generated run.py content.', 'LOCAL_C500_ARTIFACT_MISSING', 409);
      const scriptedTask = iterativeMlaScenario
        || Boolean(payload?.baselineSource?.profileId)
        || Boolean(payload?.baselineMaterialization?.source?.profileId)
        || Boolean(payload?.baselineSource?.repository && String(payload.baselineSource.repository).startsWith('operator-profile:'));
      if (scriptedTask && !payload.missionId) throw fail('Scripted MLA tasks require missionId.', 'OPERATOR_TEST_TASK_INVALID');
      if (scriptedTask && payload.purpose !== 'baseline' && !/^sha256:[a-f0-9]{64}$/.test(payload.candidate.digest)) {
        throw fail('Scripted MLA candidates require a real workspace diff digest.', 'LOCAL_C500_SCENARIO_DIFF_DIGEST_REQUIRED', 409);
      }
      const taskId = `local_c500_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
      const implementationFiles = Object.entries(payload.implementationFiles || {});
      for (const [relativePath, content] of implementationFiles) {
        if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..') || relativePath.includes('/') || relativePath.includes('\\')) {
          throw fail('Implementation artifact path must be a task-root filename.', 'LOCAL_C500_ARTIFACT_PATH_INVALID', 409);
        }
        if (typeof content !== 'string') throw fail('Implementation artifact content must be text.', 'LOCAL_C500_ARTIFACT_INVALID', 409);
      }
      await mkdir(path.join(taskRoot, taskId), { recursive: true });
      await writeFile(runPyPath(taskId), payload.runPy, 'utf8');
      if (payload.oracleRunPy) await writeFile(oracleRunPyPath(taskId), payload.oracleRunPy, 'utf8');
      for (const [relativePath, content] of implementationFiles) {
        await writeFile(path.join(taskRoot, taskId, relativePath), content, 'utf8');
      }
      const task = {
        schemaVersion: 1,
        taskId,
        status: 'waiting',
        progress: 0,
        submittedAt: now(),
        payload: structuredClone(payload),
        operator: payload.operator,
        purpose: payload.purpose,
        candidate: structuredClone(payload.candidate),
        matrix: structuredClone(payload.matrix),
        metric: payload.metric,
        hardware: payload.hardware,
        runPySource: payload.runPySource || 'production-mission-workspace/run.py',
        runPyDigest: runPyDigestFor(payload.runPy),
        mockScenario: iterativeMlaScenario ? mockScenario : null,
        logs: [],
        result: null,
        error: null,
      };
      await saveTask(task);
      return { taskId, status: 'queued', submittedAt: task.submittedAt };
    },
    get: async (taskId) => {
      const task = await loadTask(taskId);
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        await startTaskExecution(task);
        if (mockEnabled) await activeExecutions.get(taskId)?.promise;
        await refreshRunnerProgress(await loadTask(taskId));
      }
      return taskView(await loadTask(taskId));
    },
    events: async (taskId) => {
      const task = await loadTask(taskId);
      return { taskId, events: task.logs || [], nextSequence: (task.logs || []).length };
    },
    cancel: async (taskId) => {
      const task = await loadTask(taskId);
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        terminateProcessTree(activeExecutions.get(taskId)?.child);
        task.status = 'cancelled';
        task.cancelRequested = true;
        task.completedAt = now();
        task.progress = task.progress || 0;
        await saveTask(task);
      }
      return taskView(task);
    },
  };
};

export const localC500Config = {
  kind: 'local-c500',
  device: cpuE2eEnabled ? 'CPU' : process.env.OPERATOR_MUXI_DEVICE || (simulationEnabled ? 'C500' : 'C550'),
  enabled: process.env.OPERATOR_TEST_BACKEND === 'local-c500',
  simulation: simulationEnabled,
  mock: mockEnabled,
  liveHardware: !mockEnabled && !cpuE2eEnabled,
  executionMode: cpuE2eEnabled ? 'cpu-e2e' : simulationEnabled ? 'full-simulation' : mockEnabled ? 'hardware-mock' : 'real-c550',
  taskRoot,
  commandConfigured: Boolean(commandTemplate),
  hardwareDisabled,
  scenario: iterativeMlaScenario ? mockScenario : null,
  bundledRunner,
};
