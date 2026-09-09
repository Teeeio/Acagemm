#!/usr/bin/env node
// 03 Candidate Generation development entrance.
// It drives the production HTTP API and only observes persisted queue/evidence;
// it never implements candidate admission, Gate, or adoption locally.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildCandidateGenerationEvaluation } from '../tools/candidate-generation-eval/report.mjs';
import { quoteCommandArgument, resolvePythonExecutable } from '../client-runtime/platform-runtime.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const configPath = arg('--config');
if (!configPath || process.argv.includes('--help')) {
  console.log('Usage: node scripts/eval-candidate-generation.mjs --config path/to/eval.json [--output dir]');
  console.log('The config is a 03 semantic input plus a baseline run.py; see tools/candidate-generation-eval/README.md.');
  process.exit(configPath ? 0 : 2);
}
const config = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
assert.ok(config.experienceGuidance == null || (Array.isArray(config.experienceGuidance) && config.experienceGuidance.length <= 20), 'experienceGuidance must be an array with at most 20 human-guidance records');
const timeoutMs = Math.max(30_000, Number(config.timeoutMs || 10 * 60_000));
const evaluationDeadline = Date.now() + timeoutMs;
const model = config.model || process.env.OPERATOR_CODEX_MODEL || 'gpt-5.6-sol';
const runtimeMode = config.runtimeMode || process.env.E2E_AGENT_RUNTIME || 'codex-cli';
const backend = config.backend || 'local-cpu';
const backendEnvironment = backend === 'local-cpu'
  ? { testBackend: 'local-c500', localCpu: '1' }
  : { testBackend: backend, localCpu: '0' };
const runRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-03-eval-'));
const outputDir = path.resolve(arg('--output') || path.join(root, '.tmp-candidate-generation-eval', Date.now().toString(36)));
await mkdir(outputDir, { recursive: true });
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const runtimeDir = path.join(runRoot, 'runtime');
const dataDir = path.join(runRoot, 'data');
const projectRoot = path.join(runRoot, 'project');
const cpuRunner = path.join(root, 'tools', 'local-cpu-runner.py');
const pythonExecutable = config.pythonExecutable || process.env.OPERATOR_GPU_PYTHON || resolvePythonExecutable({ rootDir: root });
const source = String(config.baselineRunPy || await readFile(path.resolve(config.baselinePath), 'utf8'));
const matrix = config.testMatrix || { environments: ['CPU'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 4, warmup: 2, repeats: 10,
  testSpec: { schemaVersion: 'operator-studio.test-spec/v1', correctness: { requestedCases: 4, requiredCategories: ['minimal', 'representative', 'boundary'], atol: 1e-5, rtol: 1e-5, requireNamedCases: true }, benchmark: { requiredProfiles: ['primary'], primaryProfile: 'primary', warmup: 2, repeats: 10 } } };
const hardware = config.hardware || matrix.environments || ['CPU'];
const operator = config.operator || config.semanticDraft?.operator || 'generic_operator';
const logs = [];
let child;
let missionId = null;
let runId = null;
const request = async (pathname, options = {}) => {
  const remaining = Math.max(1_000, Math.min(120_000, evaluationDeadline - Date.now()));
  const response = await fetch(baseUrl + pathname, { ...options, signal: AbortSignal.timeout(remaining), headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`${pathname}: ${response.status} ${payload.error || response.statusText}`), { code: payload.code, payload });
  return payload;
};
const waitFor = async (predicate, label, limit = timeoutMs) => {
  const deadline = Date.now() + limit;
  let last;
  while (Date.now() < deadline) {
    last = (await request('/api/state')).state;
    if (await predicate(last)) return last;
    await request('/api/runtime/advance', { method: 'POST', body: {} }).catch(() => null);
    await sleep(Number(config.pollMs || 250));
  }
  throw new Error(`${label} timed out after ${limit}ms: ${JSON.stringify(last?.workflowFailure || last?.agent || last?.benchmark)}`);
};
const waitForServer = async (limit = 30_000) => {
  const deadline = Date.now() + Math.min(limit, Math.max(1_000, evaluationDeadline - Date.now()));
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await request('/api/health');
      if (health?.service === 'operator-studio-client-runtime') return health;
    } catch (error) {
      lastError = error;
      if (!/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR_CONNECT_TIMEOUT/i.test(error.message || '')) throw error;
    }
    await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
  }
  throw new Error(`Runtime startup timed out after ${limit}ms: ${lastError?.message || 'health endpoint unavailable'}`);
};
try {
  const env = {
    ...process.env, API_PORT: String(port), SERVE_WEB: 'false', OPERATOR_RUNTIME_MODE: runtimeMode,
    OPERATOR_CODEX_MODEL: model, OPERATOR_AUTO_TICK: '0', OPERATOR_TEST_BACKEND: backendEnvironment.testBackend,
    OPERATOR_LOCAL_CPU: backendEnvironment.localCpu, OPERATOR_LOCAL_C500_MOCK: '0', OPERATOR_LOCAL_C500_SIMULATION: '0',
    OPERATOR_LOCAL_C500_COMMAND: backend === 'local-cpu' ? `${quoteCommandArgument(pythonExecutable)} ${quoteCommandArgument(cpuRunner)}` : '',
    OPERATOR_LOCAL_C500_TIMEOUT_SECONDS: String(config.taskTimeoutSeconds || 60), OPERATOR_DATA_DIR: dataDir,
    OPERATOR_RUNTIME_DIR: runtimeDir, OPERATOR_LOCAL_C500_DIR: path.join(runRoot, 'tasks'),
  };
  child = spawn(process.execPath, ['client-runtime/local-server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.on('data', (chunk) => logs.push(String(chunk))); child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  await waitForServer(30_000).catch(async (error) => { throw new Error(`${error.message}\n${logs.join('')}`); });
  const project = (await request('/api/projects', { method: 'POST', body: { name: config.projectName || `03-${operator}`, root: projectRoot, initializeGit: true } })).project;
  await writeFile(path.join(project.repository, config.entrypoint || 'run.py'), source, 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: project.repository });
  await execFileAsync('git', ['-c', 'user.name=03-eval', '-c', 'user.email=03-eval@operator.studio', 'commit', '-m', '03 evaluation baseline'], { cwd: project.repository });
  for (const guidance of (config.experienceGuidance || [])) {
    await request(`/api/projects/${encodeURIComponent(project.id)}/experiences`, {
      method: 'POST',
      body: {
        title: guidance.title,
        content: guidance.content,
        author: guidance.author || '03-evaluation',
        confidence: guidance.confidence || 'medium',
        scope: guidance.scope || { operator, hardware: hardware.map((item) => String(item).toLowerCase()) },
        ...(guidance.visibility ? { visibility: guidance.visibility } : {}),
      },
    });
  }
  const goal = config.goal || `优化 ${operator} 的 ${config.entrypoint || 'run.py'} 实现；保持语义、输入工厂、reference 和测试矩阵不变，只提交一个可量化的真实 Diff。`;
  const mission = await request('/api/missions', { method: 'POST', body: { projectId: project.id, title: config.title || `03 ${operator} evaluation`, operator, goal, hardware, metric: config.metric || 'latency p50', implementation: config.implementation || 'pytorch-python', testMatrix: matrix, objective: config.objective || { mode: 'threshold', metric: config.metric || 'latency p50', direction: 'minimize', targetRelativeImprovement: 0 }, missionBudgetMs: timeoutMs, semanticDraft: config.semanticDraft || {} } });
  missionId = mission.state.activeMissionId;
  await request(`/api/missions/${encodeURIComponent(missionId)}/semantic/freeze`, { method: 'POST', body: { semanticDraft: config.semanticDraft || {} } });
  const baselineStartedAt = Date.now();
  await request('/api/actions/start-benchmark', { method: 'POST', body: { purpose: 'baseline', baselineKind: config.baselineKind || 'naive_v0', runPy: source, operator, matrix, timeoutSeconds: config.taskTimeoutSeconds || 60, baselineSource: { authority: 'generated', kind: config.baselineKind || 'naive_v0', type: config.baselineKind || 'naive_v0', repository: 'mission-workspace', commit: '03-eval-baseline', path: config.entrypoint || 'run.py', operator, expandedSingleFile: true, basedOn: 'v0' } } });
  let state = await waitFor((current) => current.baseline?.status === 'complete' && current.benchmark?.status === 'idle', 'baseline', Math.min(timeoutMs, 120_000));
  const baselineTask = (await request('/api/operator-tests')).tasks?.find((task) => task.taskId === state.baseline?.evidence?.testTaskId || task.id === state.baseline?.evidence?.testTaskId) || (await request(`/api/operator-tests/${encodeURIComponent(state.baseline.evidence.testTaskId)}`)).task;
  await request(`/api/missions/${encodeURIComponent(missionId)}/runs`, { method: 'POST', body: { goal } });
  state = (await request('/api/state')).state; runId = state.agent?.runId;
  if (!runId) throw Object.assign(new Error('Candidate generation did not create a run identity.'), { code: 'CANDIDATE_RUN_NOT_STARTED' });
  const candidateState = await waitFor((current) => current.agent?.runId === runId && ['awaiting_action', 'failed', 'completed'].includes(current.agent?.status), 'candidate generation', timeoutMs);
  state = candidateState;
  const candidateValidation = candidateState.agent?.candidateValidation || null;
  const candidate = [...(candidateState.candidateEvaluations || [])].reverse().find((item) => !candidateValidation?.digest || item.patchDigest === candidateValidation.digest) || null;
  let candidateTask = null;
  if (candidateValidation?.passed && candidate?.id) {
    await request('/api/actions/apply-patch', { method: 'POST', body: { candidate: candidate.id } });
    const candidateSubmission = await request('/api/actions/start-benchmark', { method: 'POST', body: { purpose: 'candidate', candidate: candidate.id, candidateDigest: candidate.patchDigest, operator, matrix, timeoutSeconds: config.taskTimeoutSeconds || 60 } });
    // Keep the Mission active while explicitly advancing the committed
    // benchmark. runtime-advance-service intentionally treats missionPaused as
    // a no-op for ordinary work, so pausing here would leave the queue task in
    // `queued` forever. The evaluator has already disabled the background tick
    // (OPERATOR_AUTO_TICK=0), therefore explicit advancement is deterministic;
    // pause only after both queue and benchmark reach a terminal outcome.
    const candidateDeadline = Date.now() + Math.min(timeoutMs, 120_000);
    let finalCandidateState = null;
    while (Date.now() < candidateDeadline) {
      candidateTask = candidateSubmission.taskId
        ? (await request(`/api/operator-tests/${encodeURIComponent(candidateSubmission.taskId)}`)).task
        : null;
      state = (await request('/api/state')).state;
      await request('/api/runtime/advance', { method: 'POST', body: {} });
      state = (await request('/api/state')).state;
      if (candidateSubmission.taskId) candidateTask = (await request(`/api/operator-tests/${encodeURIComponent(candidateSubmission.taskId)}`)).task;
      const taskTerminal = candidateTask && ['completed', 'failed', 'cancelled', 'quarantined'].includes(candidateTask.status);
      const benchmarkTerminal = state.benchmark?.purpose === 'candidate' && ['complete', 'failed', 'cancelled'].includes(state.benchmark?.status);
      if (taskTerminal && benchmarkTerminal) { finalCandidateState = state; break; }
      await sleep(Number(config.pollMs || 250));
    }
    if (!finalCandidateState) throw Object.assign(new Error('Candidate benchmark did not reach a terminal queue and Mission state outcome before its deadline.'), { code: 'CANDIDATE_EVALUATION_TIMEOUT', details: { taskId: candidateSubmission.taskId, taskStatus: candidateTask?.status, benchmarkStatus: state?.benchmark?.status } });
    if (!candidateTask && state.benchmark?.testTaskId) candidateTask = (await request(`/api/operator-tests/${encodeURIComponent(state.benchmark.testTaskId)}`)).task;
    await request('/api/state', { method: 'PATCH', body: { missionPaused: true } }).catch(() => null);
  }
  const events = (await request(`/api/missions/${encodeURIComponent(missionId)}/events`)).events || [];
  const started = events.find((event) => event.payload?.runId === runId && /run_started$/.test(event.type));
  const completed = events.find((event) => event.payload?.runId === runId && /run_(completed|failed|cancelled)$/.test(event.type));
  const usage = state.tokenUsage?.runs?.[runId] || null;
  const report = buildCandidateGenerationEvaluation({ generationTiming: { startedAt: started?.timestamp || state.agent?.startedAt, completedAt: completed?.timestamp || state.agent?.completedAt }, generationUsage: usage, candidateValidation, baselineTask, candidateTask, config: { operator, metric: config.metric || 'latency p50', backend, model, missionId, runId, baselineStartedAt } });
  await writeFile(path.join(outputDir, 'evaluation.json'), `${JSON.stringify(report.summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'evaluation.md'), `${report.markdown}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'observations.json'), `${JSON.stringify({ missionId, runId, state, baselineTask, candidateTask, events, logs }, null, 2)}\n`, 'utf8');
  if (report.summary.outcome !== 'evaluated') {
    throw Object.assign(new Error(`Candidate evaluation did not complete: ${report.summary.outcome}`), { code: 'CANDIDATE_EVALUATION_INCOMPLETE' });
  }
  console.log(JSON.stringify({ status: 'passed', outputDir, outcome: report.summary.outcome, missionId, runId }, null, 2));
} catch (error) {
  await writeFile(path.join(outputDir, 'failure.json'), `${JSON.stringify({ status: 'failed', error: error.message, stack: error.stack, logs }, null, 2)}\n`, 'utf8').catch(() => {});
  console.error(error.stack || error.message); process.exitCode = 1;
} finally {
  if (missionId && child && !child.killed) await request('/api/actions/stop-mission', { method: 'POST', body: {} }).catch(() => null);
  if (child && !child.killed) child.kill();
  await rm(runRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
