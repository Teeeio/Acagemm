import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-cpu-agent-e2e-'));
const cpuRunner = path.join(rootDir, 'tools', 'local-cpu-runner.py');
const runtimeMode = process.env.E2E_AGENT_RUNTIME || 'claude-code';
const timeoutMs = Number(process.env.E2E_AGENT_TIMEOUT_MS || 10 * 60 * 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const candidateIdentity = (task) => ({
  candidateId: task?.payload?.candidate?.id || task?.payload?.candidateId || null,
  candidateDigest: task?.payload?.candidate?.digest || task?.payload?.candidateDigest || task?.result?.environment?.candidateDigest || null,
});
const candidateSourceRun = (state, task) => {
  const { candidateId, candidateDigest } = candidateIdentity(task);
  const candidate = (state?.candidateEvaluations || []).find((item) => (
    (candidateDigest && (item.patchDigest === candidateDigest || item.digest === candidateDigest))
    || (candidateId && item.id === candidateId)
  ));
  return {
    candidate,
    candidateId,
    candidateDigest,
    // The durable Queue payload is authoritative after a reset/archive race;
    // fall back to the live candidate projection only for legacy tasks.
    sourceRunId: task?.payload?.candidate?.sourceRunId
      || task?.payload?.candidateSourceRunId
      || candidate?.sourceRunId
      || null,
  };
};
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const runtimeLog = [];
const writes = [];
let childExit = null;
const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: rootDir,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_RUNTIME_MODE: runtimeMode,
    // Production keeps auto-tick enabled. Deterministic troubleshooting can
    // set OPERATOR_AUTO_TICK=0 and drive POST /api/runtime/advance explicitly.
    OPERATOR_AUTO_TICK: process.env.OPERATOR_AUTO_TICK || '1',
    OPERATOR_AUTO_TICK_INTERVAL_MS: '250',
    OPERATOR_MAIN_AGENT_BUDGET_MS: process.env.OPERATOR_MAIN_AGENT_BUDGET_MS || '180000',
    OPERATOR_TEST_BACKEND: 'local-c500',
    OPERATOR_LOCAL_CPU: '1',
    OPERATOR_LOCAL_C500_MOCK: '0',
    OPERATOR_LOCAL_C500_SIMULATION: '0',
    OPERATOR_LOCAL_C500_COMMAND: `python "${cpuRunner}"`,
    OPERATOR_LOCAL_C500_TIMEOUT_SECONDS: '20',
    OPERATOR_DATA_DIR: path.join(runRoot, 'data'),
    OPERATOR_RUNTIME_DIR: path.join(runRoot, 'runtime'),
    OPERATOR_LOCAL_C500_DIR: path.join(runRoot, 'cpu-tasks'),
  },
});
child.stdout.on('data', (chunk) => runtimeLog.push(String(chunk)));
child.stderr.on('data', (chunk) => runtimeLog.push(String(chunk)));
child.on('error', (error) => runtimeLog.push(`spawn error: ${error.stack || error.message}\n`));
child.on('exit', (code, signal) => { childExit = { code, signal }; });

const request = async (pathname, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) writes.push({ method, pathname, at: new Date().toISOString() });
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${payload.code || response.status}: ${payload.error || response.statusText}`);
    error.payload = payload;
    throw error;
  }
  return payload;
};

const baselineRunPy = [
  'def get_inputs():',
  '    return {"values": [((i % 37) - 18) / 7.0 for i in range(1024)], "residual": [((i % 23) - 11) / 5.0 for i in range(1024)], "alpha": 1.25, "beta": 0.75, "bias": -0.125}',
  '',
  'def get_test_cases():',
  '    return [',
  '        {"name": "mixed", "category": "representative", "inputs": get_inputs()},',
  '        {"name": "relu-boundary", "category": "boundary", "inputs": {"values": [-1.0, 0.0, 1.0], "residual": [1.0, 0.0, -1.0], "alpha": 1.0, "beta": 1.0, "bias": 0.0}},',
  '        {"name": "positive", "category": "minimal", "inputs": {"values": [1.0, 2.0], "residual": [0.5, 0.25], "alpha": 2.0, "beta": 0.5, "bias": 0.1}},',
  '        {"name": "all-clamped", "category": "edge", "inputs": {"values": [-3.0, -2.0], "residual": [-1.0, -4.0], "alpha": 1.0, "beta": 1.0, "bias": -1.0}},',
  '    ]',
  '',
  'def get_benchmark_inputs():',
  '    primary = get_inputs()',
  '    compact = {key: (value[:256] if isinstance(value, list) else value) for key, value in primary.items()}',
  '    return [{"name": "primary", "inputs": primary}, {"name": "compact", "inputs": compact}]',
  '',
  'def reference(inputs):',
  '    alpha, beta, bias = inputs["alpha"], inputs["beta"], inputs["bias"]',
  '    return [max(0.0, alpha * value + beta * residual + bias) for value, residual in zip(inputs["values"], inputs["residual"])]',
  '',
  'def run(inputs):',
  '    alpha, beta, bias = inputs["alpha"], inputs["beta"], inputs["bias"]',
  '    return [max(0.0, alpha * value + beta * residual + bias) for value, residual in zip(inputs["values"], inputs["residual"])]',
  '',
].join('\n');

const matrix = {
  environments: ['CPU'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 4, warmup: 2, repeats: 15,
  testSpec: {
    schemaVersion: 'operator-studio.test-spec/v1',
    correctness: {
      requestedCases: 4, requiredCategories: ['representative', 'boundary', 'minimal', 'edge'],
      atol: 1e-9, rtol: 1e-9, requireNamedCases: true,
    },
    benchmark: { requiredProfiles: ['primary', 'compact'], primaryProfile: 'primary', warmup: 2, repeats: 15 },
  },
};
const goal = [
  '优化 run.py 中的 fused_affine_relu 算子，在 CPU、length=1024 下评估 latency p50。',
  '保持 get_inputs、get_test_cases、get_benchmark_inputs、reference 的输入输出语义不变，只优化 run(inputs)。',
  '相对 baseline 至少提升 99.9999%；必须通过 4/4 Correctness 和 Full Benchmark Accept Gate。',
  '这是短时端到端验证：立即检查 run.py 并提交一个有界、真实、单文件 Diff，不要自行运行 benchmark，也不要只返回分析。',
].join('');

let missionId = null;
let summary = null;
try {
  let health = null;
  for (let attempt = 0; attempt < 120 && !health; attempt += 1) {
    try { health = await request('/api/health'); } catch { await sleep(100); }
  }
  assert.ok(health, `runtime did not start: ${JSON.stringify(childExit)}\n${runtimeLog.join('')}`);
  assert.equal(health.runtime.mode, runtimeMode);
  assert.equal(health.runtime.connected, true, health.runtime.hint || `${runtimeMode} is unavailable`);
  assert.equal(health.testBackend.device, 'CPU');
  assert.equal(health.testBackend.executionMode, 'cpu-e2e');

  const createdProject = await request('/api/projects', { method: 'POST', body: { name: 'cpu-agent-fused-affine-relu', root: path.join(runRoot, 'project'), initializeGit: true } });
  const project = createdProject.project;
  await writeFile(path.join(project.repository, 'run.py'), baselineRunPy, 'utf8');
  await execFileAsync('git', ['add', 'run.py'], { cwd: project.repository });
  await execFileAsync('git', ['-c', 'user.name=Operator Studio E2E', '-c', 'user.email=e2e@operator.studio', 'commit', '-m', 'Add CPU fused affine ReLU baseline'], { cwd: project.repository });

  const missionResponse = await request('/api/missions', {
    method: 'POST',
    body: {
      title: 'CPU fused affine ReLU adaptive iteration', goal, projectId: project.id,
      hardware: ['CPU'], metric: 'latency p50', implementation: 'pytorch-python',
      objective: { mode: 'threshold', metric: 'latency p50', direction: 'minimize', targetRelativeImprovement: 0.999999 },
      testMatrix: matrix, missionBudgetMs: timeoutMs,
    },
  });
  missionId = missionResponse.state.activeMissionId;
  await request('/api/actions/start-benchmark', {
    method: 'POST',
    body: {
      purpose: 'baseline', baselineKind: 'naive_v0', operator: 'fused_affine_relu', runPy: baselineRunPy, matrix, timeoutSeconds: 20,
      baselineSource: { authority: 'generated', kind: 'naive_v0', type: 'naive_v0', repository: 'mission-workspace', commit: 'cpu-fused-affine-relu-v0', path: 'run.py', operator: 'fused_affine_relu', expandedSingleFile: true, basedOn: 'v0' },
    },
  });

  const baselineDeadline = Date.now() + 30_000;
  let state;
  while (Date.now() < baselineDeadline) {
    state = (await request('/api/state')).state;
    if (state.baseline?.status === 'complete' && state.benchmark?.status === 'idle') break;
    await sleep(100);
  }
  assert.equal(state?.baseline?.status, 'complete', `CPU baseline did not complete: ${JSON.stringify(state?.workflowFailure)}`);
  assert.equal(state.baseline.evidence.environment, 'CPU');
  assert.equal(state.baseline.oracleRunPy, baselineRunPy);
  const baselineTask = (await request(`/api/operator-tests/${encodeURIComponent(state.baseline.evidence.testTaskId)}`)).task;
  assert.equal(baselineTask.payload.oracleRunPy, baselineRunPy, 'baseline must receive an explicit independent oracle');
  assert.equal(baselineTask.result.correctness.total, matrix.correctnessCases);
  assert.deepEqual(baselineTask.result.correctness.caseNames, ['mixed', 'relu-boundary', 'positive', 'all-clamped']);
  assert.deepEqual(baselineTask.result.correctness.categories, [...matrix.testSpec.correctness.requiredCategories].sort());
  assert.deepEqual(baselineTask.result.benchmark.map((row) => row.profile), matrix.testSpec.benchmark.requiredProfiles);

  // Auto-tick may commit the first run immediately after the baseline reaches
  // idle. Treat that expected race as an observation/recovery path instead of
  // failing the end-to-end harness on a harmless 409.
  let started;
  try {
    started = await request(`/api/missions/${encodeURIComponent(missionId)}/runs`, { method: 'POST', body: { goal } });
  } catch (error) {
    if (error.payload?.code !== 'AGENT_RUN_ALREADY_ACTIVE') throw error;
    // The auto-tick owns the competing journal transaction. Do not issue a
    // read while its effect is still preparing: inspection would correctly
    // treat that in-flight command as unknown. Give it a bounded commit window
    // before observing the already-owned run.
    await sleep(2_000);
    const recovered = (await request('/api/state')).state;
    assert.equal(recovered.agent?.missionId, missionId, '409 active run belongs to another Mission');
    assert.equal(recovered.agent?.status, 'running', '409 active run is not running');
    started = { state: recovered };
  }
  const firstRunId = started.state.agent?.runId;
  assert.ok(firstRunId, 'first real Agent run did not start');
  const writesAtRunStart = writes.length;
  const deadline = Date.now() + timeoutMs;
  let tasks = [];
  let firstCandidateTask = null;
  let firstRound = null;
  let firstCandidateSource = null;
  let candidateSourceSnapshot = null;
  let lastProgress = '';
  while (Date.now() < deadline) {
    state = (await request('/api/state')).state;
    tasks = (await request('/api/operator-tests')).tasks || [];
    firstCandidateTask = tasks.find((task) => task.payload?.missionId === missionId
      && task.payload?.purpose === 'candidate'
      && ['completed', 'failed'].includes(task.status));
    const observedCandidateSource = firstCandidateTask?.status === 'completed' ? candidateSourceRun(state, firstCandidateTask) : null;
    // Capture the producing run at the first observation. A subsequent
    // recovery tick may reset candidateEvaluations while archiving the round;
    // attribution must survive that projection race.
    if (observedCandidateSource?.sourceRunId) candidateSourceSnapshot = observedCandidateSource;
    firstCandidateSource = candidateSourceSnapshot || observedCandidateSource;
    // A provider recovery may produce the candidate from a later run than the
    // initial attempt (for example, after a transient capacity failure). The
    // candidate's persisted sourceRunId is authoritative; never attribute the
    // evidence to firstRunId merely because it was the run started by this
    // harness. This is the regression guard for the 3zyDlz false-negative.
    const producingRunId = firstCandidateSource?.sourceRunId || null;
    firstRound = producingRunId
      ? (state.runHistory || []).find((round) => round.runId === producingRunId)
        || (state.iterationStats?.lastCountedRunId === producingRunId ? { runId: producingRunId, benchmark: state.benchmark, decisionReview: state.decisionReview } : null)
      : null;
    const progress = `${state.stage}|${state.agent?.status}|${state.agent?.runId || '-'}|${state.benchmark?.status}|${tasks.length}|${state.iterationStats?.round || 0}`;
    if (progress !== lastProgress) { console.log(`[cpu-agent-e2e] ${progress}`); lastProgress = progress; }
    if (firstCandidateTask?.status === 'failed') throw new Error(`first candidate CPU test failed: ${JSON.stringify(firstCandidateTask.error || firstCandidateTask.logs?.at(-1))}`);
    if (firstCandidateTask?.status === 'completed' && firstCandidateSource?.sourceRunId && firstRound && state.agent?.runId && state.agent.runId !== firstCandidateSource.sourceRunId) break;
    if (state.iterationStats?.loopStatus === 'needs_human') throw new Error(`workflow requested human intervention: ${state.iterationStats.loopStatusReason}: ${JSON.stringify({ workflowFailure: state.workflowFailure, workflowRecovery: state.workflowRecovery })}`);
    if (childExit) throw new Error(`runtime exited early: ${JSON.stringify(childExit)}\n${runtimeLog.join('')}`);
    await sleep(500);
  }

  assert.equal(firstCandidateTask?.status, 'completed', 'no completed candidate CPU task was observed');
  assert.equal(firstCandidateTask.result?.benchmark?.every((item) => item.correctness?.passed === true), true);
  assert.equal(firstCandidateTask.result?.environment?.source, 'cpu-e2e');
  assert.equal(firstCandidateTask.result?.environment?.liveHardware, false);
  assert.equal(firstCandidateTask.payload.oracleRunPy, baselineRunPy, 'candidate must use the persisted baseline oracle');
  assert.equal(firstCandidateTask.result.correctness.total, matrix.correctnessCases);
  assert.equal(firstCandidateTask.result.correctness.executedCases, matrix.correctnessCases);
  assert.deepEqual(firstCandidateTask.result.correctness.caseNames, ['mixed', 'relu-boundary', 'positive', 'all-clamped']);
  assert.deepEqual(firstCandidateTask.result.correctness.categories, [...matrix.testSpec.correctness.requiredCategories].sort());
  assert.deepEqual(firstCandidateTask.result.benchmark.map((row) => row.profile), matrix.testSpec.benchmark.requiredProfiles);
  assert.ok(firstRound, 'first iteration was not archived as a closed round');
  assert.ok(firstCandidateSource?.sourceRunId, 'completed candidate has no persisted sourceRunId');
  assert.equal(firstRound.runId, firstCandidateSource.sourceRunId, 'candidate evidence must be attributed to the run that produced the candidate, not the initial attempt');
  const outcome = firstRound.decisionReview?.resolution?.outcome;
  assert.ok(['reference', 'reject'].includes(outcome), `impossible target unexpectedly resolved as ${outcome}`);
  assert.ok(state.agent?.runId && state.agent.runId !== firstRunId, 'unmet target did not automatically start the next Agent round');
  assert.equal(writes.length, writesAtRunStart, `test harness advanced workflow after run start: ${JSON.stringify(writes.slice(writesAtRunStart))}`);

  const taskRunPy = await readFile(path.join(health.testBackend.taskRoot, firstCandidateTask.remoteTaskId, 'run.py'), 'utf8');
  const taskOraclePy = await readFile(path.join(health.testBackend.taskRoot, firstCandidateTask.remoteTaskId, 'oracle.py'), 'utf8');
  assert.notEqual(taskRunPy, baselineRunPy);
  assert.equal(taskOraclePy, baselineRunPy);
  assert.equal(firstCandidateTask.payload?.candidate?.digest, firstCandidateTask.result?.environment?.candidateDigest);
  assert.equal(firstCandidateSource.candidateDigest, firstCandidateTask.result?.environment?.candidateDigest, 'candidate source digest must match tested artifact');

  summary = {
    status: 'passed', runtime: runtimeMode, missionId, firstRunId, continuedRunId: state.agent.runId,
    completedRounds: state.iterationStats?.round || 1, firstRoundOutcome: outcome, candidateTaskId: firstCandidateTask.taskId || firstCandidateTask.id,
    correctnessCases: firstCandidateTask.result.benchmark[0].correctness.total,
    benchmarkProfiles: firstCandidateTask.result.benchmark.map((item) => ({ profile: item.profile, value: item.value, unit: item.unit })),
    candidateDigest: firstCandidateTask.payload.candidate.digest, candidateSourceRunId: firstCandidateSource.sourceRunId,
    testedArtifactDiffersFromBaseline: true,
    oracleMatchesPersistedBaseline: true, workflowWritesAfterRunStart: writes.length - writesAtRunStart, liveHardware: false,
  };
} finally {
  if (missionId && childExit === null) await request('/api/actions/stop-mission', { method: 'POST', body: {} }).catch(() => null);
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  if (process.env.E2E_KEEP_ARTIFACTS === '1') {
    console.error(`[cpu-agent-e2e] kept diagnostic artifacts at ${runRoot}`);
  } else {
    await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

console.log(JSON.stringify(summary, null, 2));
