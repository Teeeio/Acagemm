import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-cpu-e2e-'));
const cpuRunner = path.join(rootDir, 'tools', 'local-cpu-runner.py');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
let childExit = null;
const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: rootDir,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_RUNTIME_MODE: 'reference-fixture',
    OPERATOR_AUTO_TICK: '0',
    OPERATOR_TEST_BACKEND: 'local-c500',
    OPERATOR_LOCAL_CPU: '1',
    OPERATOR_LOCAL_C500_MOCK: '0',
    OPERATOR_LOCAL_C500_SIMULATION: '0',
    OPERATOR_LOCAL_C500_COMMAND: `python "${cpuRunner}"`,
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

const pollState = async (predicate, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = (await request('/api/runtime/advance', { method: 'POST' })).state;
    if (predicate(state)) return state;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify({ stage: state?.stage, agent: state?.agent?.status, baseline: state?.baseline?.status, benchmark: state?.benchmark?.status, failure: state?.workflowFailure })}`);
};

const baselineRunPy = [
  'def get_inputs():',
  '    return {"values": list(range(64))}',
  '',
  'def get_test_cases():',
  '    return [{"name": "small-vector", "category": "minimal", "inputs": {"values": [1, 2, 3, 4]}}]',
  '',
  'def get_benchmark_inputs():',
  '    return [{"name": "primary", "inputs": get_inputs()}]',
  '',
  'def reference(inputs):',
  '    return [value * 2 for value in inputs["values"]]',
  '',
  'def run(inputs):',
  '    output = []',
  '    for value in inputs["values"]:',
  '        output.append(value * 2)',
  '    return output',
  '',
].join('\n');
const matrix = {
  environments: ['CPU'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 1, warmup: 2, repeats: 20,
  testSpec: {
    schemaVersion: 'operator-studio.test-spec/v1',
    correctness: { requestedCases: 1, requiredCategories: ['minimal'], atol: 0, rtol: 0, requireNamedCases: true },
    benchmark: { requiredProfiles: ['primary'], primaryProfile: 'primary', warmup: 2, repeats: 20 },
  },
};
const missionGoal = '优化 vector_add kernel 在 CPU 上 batch=1、length=64 的 latency p50，目标低于 1000 us；在隔离 Mission 工作区生成候选 Patch，并通过 1/1 Correctness 和 Full Benchmark Accept Gate。';

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await request('/api/health'); break; } catch { await sleep(100); }
    if (attempt === 99) throw new Error(`runtime did not start: ${JSON.stringify(childExit)}\n${runtimeLog.join('')}`);
  }
  const health = await request('/api/health');
  assert.equal(health.runtime.mode, 'reference-fixture');
  assert.equal(health.testBackend.device, 'CPU');
  assert.equal(health.testBackend.executionMode, 'cpu-e2e');
  assert.equal(health.testBackend.liveHardware, false);

  await request('/api/reset', { method: 'POST' });
  const missionResponse = await request('/api/missions', {
    method: 'POST',
    body: {
      title: 'CPU lightweight vector scale',
      goal: missionGoal,
      repository: 'mla-kernels',
      hardware: ['CPU'],
      metric: 'latency p50',
      testMatrix: matrix,
    },
  });
  const missionId = missionResponse.state.activeMissionId;

  await request('/api/actions/start-benchmark', {
    method: 'POST',
    body: {
      purpose: 'baseline',
      baselineKind: 'naive_v0',
      baselineSource: {
        authority: 'generated',
        kind: 'naive_v0',
        type: 'naive_v0',
        repository: 'mission-workspace',
        commit: 'cpu-e2e-v0',
        path: 'run.py',
        operator: 'vector_scale',
        expandedSingleFile: true,
        basedOn: 'v0',
      },
      operator: 'vector_scale',
      runPy: baselineRunPy,
      matrix,
      timeoutSeconds: 10,
    },
  });
  const baselineState = await pollState(
    (state) => state.activeMissionId === missionId && state.baseline?.status === 'complete' && state.benchmark?.status === 'idle',
    'CPU baseline',
  );
  assert.equal(baselineState.baseline.evidence.liveHardware, false);
  assert.equal(baselineState.baseline.evidence.environment, 'CPU');
  assert.equal(baselineState.baseline.oracleRunPy, baselineRunPy);
  const baselineTask = (await request(`/api/operator-tests/${encodeURIComponent(baselineState.baseline.evidence.testTaskId)}`)).task;
  assert.equal(baselineTask.payload.oracleRunPy, baselineRunPy, 'baseline must receive an explicit independent oracle');
  assert.equal(baselineTask.result.correctness.total, matrix.correctnessCases);
  assert.deepEqual(baselineTask.result.correctness.caseNames, ['small-vector']);
  assert.deepEqual(baselineTask.result.correctness.categories, matrix.testSpec.correctness.requiredCategories);
  assert.deepEqual(baselineTask.result.benchmark.map((row) => row.profile), matrix.testSpec.benchmark.requiredProfiles);

  await request(`/api/missions/${encodeURIComponent(missionId)}/runs`, { method: 'POST', body: { goal: missionGoal } });
  const candidateState = await pollState(
    (state) => state.activeMissionId === missionId && state.agent?.status === 'awaiting_action' && state.agent?.currentAction?.type === 'candidate.plan',
    'fixture candidate',
  );
  assert.match(candidateState.agent.toolCalls.find((call) => call.name === 'Experience Search')?.summary || '', /CPU|C550/);

  const applied = await request('/api/actions/apply-patch', { method: 'POST', body: { candidate: 'candidate-02' } });
  const candidate = applied.state.candidateEvaluations.find((item) => item.id === 'candidate-02');
  assert.match(candidate.patchDigest, /^sha256:[a-f0-9]{64}$/);

  await request('/api/actions/start-benchmark', { method: 'POST', body: { matrix, timeoutSeconds: 10 } });
  const completed = await pollState(
    (state) => state.activeMissionId === missionId && state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed',
    'CPU candidate and adoption',
  );
  assert.equal(completed.benchmark.result.environment.source, 'cpu-e2e');
  assert.equal(completed.benchmark.result.environment.liveHardware, false);
  assert.equal(completed.benchmark.result.environment.candidateDigest, candidate.patchDigest);
  assert.equal(completed.benchmark.result.benchmark[0].correctness.passed, true);
  const queueTask = (await request(`/api/operator-tests/${encodeURIComponent(completed.benchmark.testTaskId)}`)).task;
  assert.equal(queueTask.payload.candidate.digest, candidate.patchDigest);
  assert.equal(queueTask.payload.oracleRunPy, baselineRunPy, 'candidate must use the persisted baseline oracle');
  assert.equal(queueTask.result.correctness.total, matrix.correctnessCases);
  assert.equal(queueTask.result.correctness.executedCases, matrix.correctnessCases);
  assert.deepEqual(queueTask.result.correctness.caseNames, ['small-vector']);
  assert.deepEqual(queueTask.result.correctness.categories, matrix.testSpec.correctness.requiredCategories);
  assert.deepEqual(queueTask.result.benchmark.map((row) => row.profile), matrix.testSpec.benchmark.requiredProfiles);
  const executedRunPy = await readFile(path.join(health.testBackend.taskRoot, queueTask.remoteTaskId, 'run.py'), 'utf8');
  const executedOraclePy = await readFile(path.join(health.testBackend.taskRoot, queueTask.remoteTaskId, 'oracle.py'), 'utf8');
  const workspaceRunPy = await readFile(path.resolve(rootDir, applied.workspace.workspace, 'run.py'), 'utf8');
  assert.equal(executedRunPy, workspaceRunPy);
  assert.equal(executedOraclePy, baselineRunPy);
  assert.equal(completed.decisionReview.resolution.source, 'policy');
  assert.equal(completed.currentBest.verified, false);
  assert.equal(completed.knowledgeMaintenance.changes.every((change) => change.outcome === 'simulation_only'), true);
  assert.ok(completed.runtimeEvents.some((event) => event.type === 'operator_test.completed'));
  assert.ok(completed.runtimeEvents.some((event) => event.type === 'decision.auto_adopted'));

  console.log(JSON.stringify({
    status: 'passed',
    executionMode: 'cpu-e2e',
    missionId,
    candidateId: candidate.id,
    candidateDigest: candidate.patchDigest,
    testedArtifactMatchesWorkspace: true,
    baselineUs: baselineState.baseline.evidence.value,
    candidateUs: completed.benchmark.result.benchmark[0].value,
    correctness: completed.benchmark.result.benchmark[0].correctness,
    gate: completed.decisionReview.gate?.result || completed.decisionReview.resolution.outcome,
    knowledge: completed.knowledgeMaintenance.summary,
    liveHardware: false,
  }, null, 2));
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
