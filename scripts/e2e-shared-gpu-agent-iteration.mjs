import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Acceptance driver only: setup commands, then read-only observation of the
// production autopilot. No candidate injection, fake provider, Gate override,
// second scheduler or direct Runtime state mutation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.env.E2E_AGENT_RUNTIME || 'codex-cli';
// Keep live operator-generation acceptance on the cost-conscious GPT-5.6 Sol
// tier by default; callers can override with GPT-5.5 or another approved model.
const codexModel = process.env.OPERATOR_CODEX_MODEL || 'gpt-5.6-sol';
const limit = Number(process.env.E2E_GPU_TIMEOUT_MS || 12 * 60_000);
const families = (process.env.E2E_GPU_FAMILIES || 'affine,reduction,normalization').split(',');
const desiredTasks = Number(process.env.E2E_GPU_CANDIDATE_TASKS || 2);
assert.ok(Number.isFinite(limit) && limit >= 30_000 && limit <= 30 * 60_000);
assert.ok(Number.isInteger(desiredTasks) && desiredTasks >= 1 && desiredTasks <= 3);
const parent = path.join(root, '.tmp-real-agent');
await mkdir(parent, { recursive: true });
const runRoot = await mkdtemp(path.join(parent, 'shared-gpu-'));
console.log('[gpu-agent-e2e] retained artifacts: ' + runRoot);
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const port = await reservePort();
const base = `http://127.0.0.1:${port}`;
let exit = null;
const logs = [];
const writes = [];
const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(port), SERVE_WEB: 'false', OPERATOR_RUNTIME_MODE: mode,
    OPERATOR_CODEX_MODEL: codexModel,
    OPERATOR_AUTO_TICK: '1', OPERATOR_AUTO_TICK_INTERVAL_MS: '5000',
    OPERATOR_CODEX_LOGICAL_CLEANUP_MS: process.env.OPERATOR_CODEX_LOGICAL_CLEANUP_MS || '60000',
    OPERATOR_MAIN_AGENT_BUDGET_MS: '180000', OPERATOR_TEST_BACKEND: 'local-shared-gpu',
    OPERATOR_GPU_PYTHON: process.env.OPERATOR_GPU_PYTHON || path.join(root, '.gpu-venv', 'Scripts', 'python.exe'),
    OPERATOR_LOCAL_CPU: '0', OPERATOR_LOCAL_C500_MOCK: '0', OPERATOR_LOCAL_C500_SIMULATION: '0',
    OPERATOR_LOCAL_C500_COMMAND: '', OPERATOR_LOCAL_C500_TIMEOUT_SECONDS: '120',
    OPERATOR_DATA_DIR: path.join(runRoot, 'data'), OPERATOR_RUNTIME_DIR: path.join(runRoot, 'runtime'),
    OPERATOR_LOCAL_C500_DIR: path.join(runRoot, 'tasks'), OPERATOR_EXECUTION_PACKAGE_DIR: path.join(runRoot, 'packages'),
    OPERATOR_BRIDGE_DIR: path.join(runRoot, 'bridge'),
  },
});
child.stdout.on('data', (value) => logs.push(String(value)));
child.stderr.on('data', (value) => logs.push(String(value)));
child.on('error', (error) => { exit = { error: error.message }; });
child.on('exit', (code, signal) => { exit = { code, signal }; });
const request = async (pathname, body) => {
  const method = body === undefined ? 'GET' : 'POST';
  if (method === 'POST') writes.push({ pathname, at: new Date().toISOString() });
  const response = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${pathname}: ${response.status} ${JSON.stringify(value)}`), { code: value.code });
  return value;
};
const matrix = {
  environments: ['local-shared-gpu'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 4, warmup: 3, repeats: 10,
  testSpec: { schemaVersion: 'operator-studio.test-spec/v1',
    correctness: { requestedCases: 4, requiredCategories: ['minimal', 'representative', 'boundary', 'ragged'], atol: 1e-5, rtol: 1e-5, requireNamedCases: true },
    benchmark: { requiredProfiles: ['primary', 'small'], primaryProfile: 'primary', warmup: 3, repeats: 10 } },
};
const expressions = {
  affine: "torch.relu(inputs['x'] * 1.25 + inputs['y'] * 0.75 - 0.125)",
  reduction: "(inputs['x'] * inputs['y']).sum(dim=-1)",
  normalization: "inputs['x'] * torch.rsqrt((inputs['x'] * inputs['x']).mean(dim=-1, keepdim=True) + 1e-5)",
};
const sourceFor = (family) => `import torch\n\ndef inputs_for(rows, cols):\n    x = torch.linspace(-2, 2, rows * cols, device='cuda', dtype=torch.float32).reshape(rows, cols)\n    return {'x': x, 'y': x.flip(-1)}\n\ndef get_inputs():\n    return inputs_for(32, 256)\n\ndef get_test_cases():\n    return [\n        {'name': 'minimal', 'category': 'minimal', 'inputs': inputs_for(1, 1)},\n        {'name': 'representative', 'category': 'representative', 'inputs': get_inputs()},\n        {'name': 'boundary', 'category': 'boundary', 'inputs': inputs_for(2, 32)},\n        {'name': 'ragged', 'category': 'ragged', 'inputs': inputs_for(3, 17)},\n    ]\n\ndef get_benchmark_inputs():\n    return [{'name': 'primary', 'inputs': get_inputs()}, {'name': 'small', 'inputs': inputs_for(2, 32)}]\n\ndef reference(inputs):\n    return ${expressions[family]}\n\ndef run(inputs):\n    # Initial implementation deliberately does one redundant device copy.\n    value = ${expressions[family]}\n    return value.clone()\n`;
const summaries = [];
let missionId;
let failure;
try {
  let health;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { health = await request('/api/health'); break; } catch { if (exit) break; await sleep(250); }
  }
  assert.ok(health, 'Runtime did not start: ' + logs.join(''));
  assert.equal(health.runtime.mode, mode);
  assert.equal(health.runtime.connected, true, JSON.stringify(health.runtime));
  assert.equal(health.testBackend.kind, 'local-shared-gpu');
  for (const family of families) {
    assert.ok(Object.hasOwn(expressions, family), 'Unknown family: ' + family);
    const source = sourceFor(family).replace(
      "x = torch.linspace(-2, 2, rows * cols, device='cuda', dtype=torch.float32).reshape(rows, cols)",
      "x = (torch.linspace(-2, 2, rows * cols, device='cuda', dtype=torch.float32) + 3).reshape(rows, cols)",
    );
    const project = (await request('/api/projects', { name: `gpu-${family}`, root: path.join(runRoot, 'projects', family), initializeGit: true })).project;
    await writeFile(path.join(project.repository, 'run.py'), source, 'utf8');
    await exec('git', ['add', 'run.py'], { cwd: project.repository, windowsHide: true });
    await exec('git', ['-c', 'user.name=Operator Studio E2E', '-c', 'user.email=e2e@operator.studio', 'commit', '-m', 'Add independent GPU baseline'], { cwd: project.repository, windowsHide: true });
    const goal = `优化 ${family} GPU 算子 run.py 的 run(inputs)，FP32，shape=32x256，latency p50 相对 baseline 提升至少 99.9999%，通过 4/4 Correctness 和 Full Benchmark。只修改 run.py 中的实现，不改 reference/get_test_cases/get_benchmark_inputs，不改测试矩阵；禁止本地跑测试、安装依赖、使用网络、修改工作区外文件。候选必须是有界真实 Diff，立即完成一个小优化（例如消除冗余 copy），由系统统一 GPU 队列验证。后续轮次根据真实反馈尝试另一个不同 Diff，不能只给分析。`;
    const created = await request('/api/missions', { projectId: project.id, title: `${family} generic GPU iteration`, operator: `generic_${family}`, goal,
      hardware: ['local-shared-gpu'], implementation: 'pytorch-python', metric: 'latency p50', testMatrix: matrix, missionBudgetMs: limit,
      objective: { mode: 'threshold', metric: 'latency p50', direction: 'minimize', targetRelativeImprovement: 0.999999 } });
    missionId = created.state.activeMissionId;
    await request('/api/actions/start-benchmark', { purpose: 'baseline', baselineKind: 'naive_v0', runPy: source, operator: `generic_${family}`, matrix, timeoutSeconds: 120,
      baselineSource: { authority: 'generated', kind: 'naive_v0', type: 'naive_v0', repository: 'mission-workspace', commit: `gpu-${family}-v0`, path: 'run.py', operator: `generic_${family}`, expandedSingleFile: true, basedOn: 'v0' } });
    let state;
    const baselineDeadline = Date.now() + 150_000;
    while (Date.now() < baselineDeadline) {
      state = (await request('/api/state')).state;
      if (state.baseline?.status === 'complete' && state.benchmark?.status === 'idle') break;
      if (state.benchmark?.status === 'failed') throw new Error('Baseline failed: ' + JSON.stringify(state.benchmark));
      await sleep(500);
    }
    assert.equal(state.baseline?.status, 'complete', 'Baseline stalled: ' + JSON.stringify(state.benchmark));
    console.log(`[gpu-agent-e2e] ${family}: GPU baseline complete`);
    const started = await request(`/api/missions/${missionId}/runs`, { goal });
    const firstRun = started.state.agent.runId;
    const writesAtStart = writes.length;
    const deadline = Date.now() + limit;
    let commandRecoveryStartedAt = null;
    let completed = [];
    let tasks = [];
    let progress = '';
    while (Date.now() < deadline) {
      state = (await request('/api/state')).state;
      tasks = (await request('/api/operator-tests')).tasks.filter((task) => task.payload?.missionId === missionId);
      completed = tasks.filter((task) => task.payload?.purpose === 'candidate' && task.status === 'completed');
      const next = JSON.stringify({ family, stage: state.stage, agent: state.agent?.status, runId: state.agent?.runId, test: state.benchmark?.status, round: state.iterationStats?.round, completed: completed.length, experience: state.iterationStats?.experienceCollection, failure: state.workflowFailure?.code });
      if (next !== progress) { console.log('[gpu-agent-e2e] ' + next); progress = next; }
      await writeFile(path.join(runRoot, family + '-state.json'), JSON.stringify({ state, tasks }, null, 2));
      if (completed.length >= desiredTasks && state.iterationStats?.experienceCollection?.recorded > 0) break;
      if (['needs_human', 'failed', 'budget_exhausted'].includes(state.iterationStats?.loopStatus)) {
        // A command effect may have committed its state just after this
        // read-only projection. Give the production auto-tick a bounded
        // recovery window before treating the blocker as terminal.
        if (state.workflowFailure?.code === 'COMMAND_PENDING_RECOVERY') {
          commandRecoveryStartedAt ??= Date.now();
        }
        if (state.workflowFailure?.code === 'COMMAND_PENDING_RECOVERY' && Date.now() < commandRecoveryStartedAt + 30_000) {
          await sleep(1000);
          continue;
        }
        throw new Error('Iteration stopped: ' + JSON.stringify(state.iterationStats));
      }
      commandRecoveryStartedAt = null;
      if (exit) throw new Error('Runtime exited: ' + JSON.stringify(exit));
      await sleep(1000);
    }
    assert.ok(completed.length >= desiredTasks, 'Insufficient completed real Candidate tasks');
    assert.equal(writes.length, writesAtStart, 'Harness must not drive automatic iterations');
    for (const task of completed) {
      assert.equal(task.resourceRelease.confirmed, true);
      assert.equal(task.result.environment.source, 'local-shared-gpu');
      assert.equal(task.result.environment.publishable, false);
      assert.equal(task.payload.candidate.digest, task.result.environment.candidateDigest);
      assert.ok(task.result.benchmark.every((row) => row.correctness.passed));
      assert.deepEqual(task.result.benchmark.map((row) => row.profile), ['primary', 'small']);
      assert.ok(task.payload.packageDigest && task.payload.admissionId);
    }
    assert.equal(new Set(completed.map((task) => task.payload.candidate.digest)).size, completed.length);
    const experiences = (await request(`/api/projects/${project.id}/experiences`)).experiences;
    assert.ok(experiences?.some((item) => item.source === 'execution' && item.verification.publishable === false), 'No trusted experience observation');
    summaries.push({ family, missionId, firstRun, completed: completed.map((task) => ({ taskId: task.taskId, candidateDigest: task.payload.candidate.digest, packageDigest: task.payload.packageDigest })), workflowWritesAfterStart: writes.length - writesAtStart, experienceCount: experiences.length });
    await request('/api/actions/stop-mission', {});
    missionId = null;
  }
} catch (error) { failure = { message: error.message, stack: error.stack }; }
finally {
  // Preserve the entire disposable acceptance project and receipts for audit.
  if (!exit) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
  await writeFile(path.join(runRoot, 'runtime.log'), logs.join(''));
  await writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', runtime: mode, summaries, failure, writes }, null, 2));
}
if (failure) throw new Error(failure.message + '\nArtifacts: ' + runRoot);
console.log(JSON.stringify({ status: 'passed', runRoot, summaries }, null, 2));
