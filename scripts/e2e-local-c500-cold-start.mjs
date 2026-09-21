import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderWorkflowSummary } from '../tools/local-c500-tester/workflow-summary.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = path.join(rootDir, '.local-c500-tests', `cold-start-${stamp}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reservePort = async () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

await mkdir(runRoot, { recursive: true });
const port = await reservePort();
const base = `http://127.0.0.1:${port}`;
const runtimeLogPath = path.join(runRoot, 'runtime.log');
const reportPath = path.join(runRoot, 'workflow-summary.md');
const runtimeLog = await open(runtimeLogPath, 'a');
const child = (await import('node:child_process')).spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: rootDir,
  windowsHide: true,
  stdio: ['ignore', runtimeLog.fd, runtimeLog.fd],
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_RUNTIME_MODE: 'codex-cli',
    OPERATOR_AUTO_TICK: '1',
    OPERATOR_TEST_BACKEND: 'local-c500',
    OPERATOR_LOCAL_C500_MOCK: '1',
    OPERATOR_LOCAL_C500_MOCK_SCENARIO: 'mla-three-round',
    OPERATOR_DATA_DIR: path.join(runRoot, 'data'),
    OPERATOR_RUNTIME_DIR: path.join(runRoot, 'runtime'),
    OPERATOR_LOCAL_C500_DIR: path.join(runRoot, 'local-c500-tasks'),
  },
});

const request = async (pathname, options = {}) => {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${payload.code || response.status}: ${payload.error || response.statusText}`);
    error.code = payload.code;
    error.details = payload.details;
    throw error;
  }
  return payload;
};

let state = {};
let tasks = [];
let initialization = { codeFiles: null, sourceEntries: null };
let failure = null;
let missionRoot = null;
let missionId = null;

const isWithin = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const auditAgentIsolation = async ({ runRoot: activeRunRoot, workspaceRoot }) => {
  const runsDir = path.join(activeRunRoot, 'runtime', 'agent-bridge', 'codex-runs');
  const entries = (await readdir(runsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const records = await Promise.all(entries.map(async (entry) => JSON.parse(await readFile(path.join(runsDir, entry.name), 'utf8'))));
  const researchRuns = records.filter((record) => record.runId.startsWith('codex_research_'));
  const materializerRuns = records.filter((record) => record.runId.startsWith('codex_materializer_'));
  const iterationRuns = records.filter((record) => record.runId.startsWith('codex_')
    && !record.runId.startsWith('codex_research_')
    && !record.runId.startsWith('codex_materializer_'));

  assert.ok(researchRuns.length >= 2, 'Research acquire/synthesize runs are missing');
  assert.equal(materializerRuns.length, 1);
  assert.equal(iterationRuns.length, 3);
  for (const record of records) {
    assert.equal(record.sandbox, 'workspace-write', `${record.runId} must use workspace-write`);
    assert.equal(isWithin(workspaceRoot, record.workspace), true, `${record.runId} workspace escaped Mission root`);
    assert.ok((record.additionalDirectories || []).every((directory) => isWithin(workspaceRoot, directory)), `${record.runId} add-dir escaped Mission root`);
    assert.ok(record.boundary, `${record.runId} has no enforced stage boundary`);
    // 标签必须与 codex-client.mjs 实际写出的值一致。8e6d711 把 'local-shell-disabled' 改名成
    // 'workspace-sandbox-and-workflow-diff'（诚实版：shell 并未被关掉，只是被沙箱限制写），这条断言
    // 当时没跟着改，从那以后每次运行都在这里失败。shell 真正关掉是可选行为
    // （OPERATOR_CODEX_DISABLE_SHELL_TOOL，默认不开），所以这里断言的本来也不是「没有 shell」。
    assert.equal(record.boundary.enforcement, 'workspace-sandbox-and-workflow-diff', `${record.runId} boundary enforcement label drifted from codex-client`);
    assert.equal(record.boundary.roots.workspace, record.workspace, `${record.runId} boundary cwd mismatch`);
    const events = await readFile(record.eventPath, 'utf8');
    // 这里刻意不断言「事件流里没有本地命令」。shell 是产品自行保留的，不是被关掉的：
    // codex-client.mjs 写明删掉 edit/apply 工具会 strand 真实运行，禁用是 opt-in
    // （OPERATOR_CODEX_DISABLE_SHELL_TOOL，默认关闭）；8e6d711 也把边界标签改成了诚实的
    // workspace-sandbox-and-workflow-diff。保留这段注释是因为「agent 居然执行了命令」
    // 看起来仍然像个缺口，很容易被下一个人当成回归再加回来。
    //
    // 真正的边界是沙箱，不是「没有 shell」：真实运行里 materializer 会执行 python 校验它
    // 自己生成的文件，research-acquire 会列举它被授予的只读 sources 根——都在各自根内。
    //
    // 诚实缺口：本块断言的是「边界被正确声明」（沙箱模式、可写/只读根、add-dir、边界 cwd、
    // 角色专属根），不是「边界被实际执行」。执行由 Codex 沙箱负责，事件流里看不出来。
    // 要补它得用一个已知越界的探针去实测沙箱是否拦得住，那是独立的一件事——不要以为
    // 这里已经行为性地验证过隔离。
    const referencedRuns = [...events.matchAll(/cold-start-\d{4}-\d{2}-\d{2}T[\d-]+Z/g)].map((match) => match[0]);
    assert.ok(referencedRuns.every((name) => name === path.basename(activeRunRoot)), `${record.runId} accessed another cold-start run`);
  }
  for (const record of researchRuns.filter((entry) => entry.boundary.role === 'research-acquire')) {
    assert.equal(path.resolve(record.workspace), path.join(workspaceRoot, 'research'));
    // Source Registry 只作为只读引用根下发：它不得出现在可写 add-dir 里，否则研究员能改注册表，
    // 而 baseline 的来源权威正是从注册表建立的。
    assert.deepEqual(record.additionalDirectories, [], 'research-acquire must not receive a writable add-dir');
    assert.deepEqual((record.readOnlyDirectories || []).map((directory) => path.resolve(directory)), [path.join(workspaceRoot, 'sources')]);
    assert.deepEqual(Object.keys(record.boundary.roots).sort(), ['sourceRoot', 'workspace']);
    assert.equal(path.resolve(record.boundary.roots.sourceRoot), path.join(workspaceRoot, 'sources'));
  }
  for (const record of researchRuns.filter((entry) => entry.boundary.role === 'research-synthesize')) {
    assert.equal(path.resolve(record.workspace), path.join(workspaceRoot, 'research'));
    assert.deepEqual(record.additionalDirectories, []);
    assert.deepEqual(Object.keys(record.boundary.roots), ['workspace']);
  }
  for (const record of materializerRuns) {
    assert.equal(path.resolve(record.workspace), path.join(workspaceRoot, 'baseline'));
    assert.deepEqual(record.additionalDirectories, []);
    assert.deepEqual(Object.keys(record.boundary.roots), ['workspace']);
  }
  for (const record of iterationRuns) {
    assert.equal(path.resolve(record.workspace), path.join(workspaceRoot, 'repository'));
    assert.deepEqual(record.additionalDirectories, [], `${record.runId} Iteration Agent must not receive add-dir`);
    assert.deepEqual(Object.keys(record.boundary.roots), ['workspace']);
  }
  return { researchRuns: researchRuns.length, materializerRuns: materializerRuns.length, iterationRuns: iterationRuns.length };
};

try {
  let health = null;
  for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
    try { health = await request('/api/health'); } catch { await sleep(100); }
  }
  assert.ok(health, 'runtime did not start');
  assert.equal(health.runtime.mode, 'codex-cli');
  assert.equal(health.runtime.connected, true, health.runtime.hint || 'Codex runtime is not connected');
  assert.equal(health.testBackend.mock, true);
  assert.equal(health.testBackend.scenario, 'mla-three-round');

  const projectRoot = path.join(runRoot, 'project');
  const createdProject = await request('/api/projects', { method: 'POST', body: { name: 'flashinfer-mla-cold-start', root: projectRoot, initializeGit: true } });
  const project = createdProject.project;
  const missionText = [
    '# Operator Optimization Mission',
    '',
    'Title: FlashInfer MLA Paged Attention',
    'Hardware: MetaX C550',
    'Metric: latency p50',
    '',
    '从零研究并优化 FlashInfer MLA paged attention，相对 baseline 至少提升 20%。',
    '项目初始化时不得包含 run.py、算子实现、baseline 或测试代码。',
    '每轮 Iteration Agent 必须生成真实且独立的单文件 run.py Diff。',
    '',
  ].join('\n');
  await writeFile(path.join(project.repository, 'MISSION.md'), missionText, 'utf8');
  await execFileAsync('git', ['add', 'MISSION.md'], { cwd: project.repository });
  await execFileAsync('git', ['commit', '-m', 'Initialize cold-start mission'], { cwd: project.repository });

  const repositoryEntries = (await readdir(project.repository)).filter((name) => name !== '.git');
  const sourceEntries = await readdir(project.sourceRoot);
  const codeFiles = repositoryEntries.filter((name) => /\.(?:py|cu|cuh|cpp|cc|c|h|hpp|rs)$/i.test(name));
  initialization = { codeFiles: codeFiles.length, sourceEntries: sourceEntries.length };
  assert.deepEqual(repositoryEntries, ['MISSION.md']);
  assert.equal(codeFiles.length, 0);
  assert.equal(sourceEntries.length, 0);

  const goal = '从零研究并优化 FlashInfer MLA paged attention 在沐曦 C550 上的 latency p50，相对 baseline 至少提升 20%；每轮必须生成真实且独立的 run.py 工作区 Diff。';
  const missionResponse = await request('/api/missions', {
    method: 'POST',
    body: {
      title: 'FlashInfer MLA Paged Attention',
      goal,
      projectId: project.id,
      hardware: ['C550'],
      metric: 'latency p50',
      // 自动联网研究默认关闭；本用例要验证 acquire/synthesize 两个研究 run 真的跑起来（见下方
      // researchRuns 断言），故显式开启。开启只影响是否启动研究，不放宽任何来源门禁。
      sourcePolicy: { mode: 'agent-flexible', strictZeroSource: true, localFirst: true, allowDiscoveredSources: true, allowSemanticFallback: true, webResearchEnabled: true },
      testScenario: { id: 'mla-three-round', hardwareMockOnly: true },
      objective: { mode: 'threshold', metric: 'latency p50', direction: 'minimize', targetRelativeImprovement: 0.2 },
      testMatrix: { environments: ['C550'], stages: ['Correctness', 'Full Benchmark'], warmup: 50, repeats: 200, correctnessCases: 24 },
      missionBudgetMs: 45 * 60 * 1000,
    },
  });
  missionId = missionResponse.state.activeMissionId;
  const mission = missionResponse.state.missions.find((item) => item.id === missionId);
  missionRoot = path.dirname(mission.sourceRoot);
  assert.equal(isWithin(projectRoot, missionRoot), true);
  assert.equal(path.resolve(mission.sourceRoot), path.join(missionRoot, 'sources'));
  assert.equal((await readdir(mission.sourceRoot)).length, 0, 'Mission Source must start empty');
  assert.deepEqual((await readdir(path.join(missionRoot, 'repository'))).filter((name) => name !== '.git'), ['MISSION.md']);
  await request(`/api/missions/${encodeURIComponent(missionId)}/runs`, { method: 'POST', body: { goal } });

  const timeoutMs = Number(process.env.E2E_CODEX_TIMEOUT_MS || 30 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    state = (await request('/api/state')).state;
    tasks = (await request('/api/operator-tests')).tasks || [];
    const completed = state.stage === 'published' && state.currentBest?.candidateId;
    const blocked = state.iterationStats?.loopStatus === 'needs_human'
      || (state.researchAgent?.status === 'failed' && state.researchAgent?.runPhase === 'synthesize')
      || state.baseline?.materializer?.status === 'failed';
    if (completed || blocked) break;
    await sleep(1000);
  }

  if (!(state.stage === 'published' && state.currentBest?.candidateId)) {
    const researchError = String(state.researchAgent?.error?.message || '');
    const reason = /UnknownIssuer/i.test(researchError)
      ? 'Research Agent 无法连接 OpenAI API：证书链 UnknownIssuer'
      : state.iterationStats?.loopStatusReason || state.researchAgent?.phase || state.baseline?.materializer?.phase || state.agent?.phase || 'timeout';
    throw new Error(`Cold-start workflow did not complete: ${reason}`);
  }

  const baselineTasks = tasks.filter((task) => task.payload?.purpose === 'baseline');
  const candidateTasks = tasks.filter((task) => task.payload?.purpose === 'candidate');
  assert.equal(baselineTasks.length, 1);
  assert.equal(candidateTasks.length, 3);
  assert.deepEqual([...baselineTasks, ...candidateTasks].map((task) => task.result?.benchmark?.[0]?.value), [100, 92, 84, 75]);
  assert.equal(new Set(candidateTasks.map((task) => task.payload.candidate.digest)).size, 3);
  assert.equal(new Set(candidateTasks.map((task) => task.result?.scenario?.runPyDigest)).size, 3);
  assert.equal((state.runtimeEvents || []).filter((event) => event.type === 'workflow.round_rolled_back').length, 2);
  const adoptedEvent = [...(state.runtimeEvents || [])].reverse().find((event) => event.type === 'decision.auto_adopted' && event.payload?.candidate === 'candidate-03');
  assert.equal(adoptedEvent?.payload?.gate?.passed, true);
  assert.equal(adoptedEvent?.payload?.gate?.publishable, false);
  assert.equal(state.currentBest.value, '75 us');
  assert.ok((state.publishedAssets || []).every((asset) => asset.status === 'simulation'));
  assert.ok(tasks.every((task) => task.result.environment.source === 'simulation' && task.result.environment.liveHardware === false));
  const isolation = await auditAgentIsolation({ runRoot, workspaceRoot: missionRoot });
  assert.deepEqual(isolation, { researchRuns: 2, materializerRuns: 1, iterationRuns: 3 });

  const stableTaskCount = tasks.length;
  for (let index = 0; index < 5; index += 1) {
    await sleep(500);
    state = (await request('/api/state')).state;
  }
  tasks = (await request('/api/operator-tests')).tasks || [];
  assert.equal(tasks.length, stableTaskCount);
  assert.equal(tasks.filter((task) => task.payload?.purpose === 'candidate').length, 3);
} catch (error) {
  failure = error;
  try { state = (await request('/api/state')).state; } catch { /* runtime may be unavailable */ }
  try { tasks = (await request('/api/operator-tests')).tasks || []; } catch { /* runtime may be unavailable */ }
} finally {
  await writeFile(reportPath, renderWorkflowSummary({ state, tasks, initialization, error: failure }), 'utf8');
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
  await runtimeLog.close();
}

const report = await readFile(reportPath, 'utf8');
process.stdout.write(`${JSON.stringify({ status: failure ? 'blocked' : 'passed', reportPath, runRoot, stage: state.stage, tasks: tasks.length, error: failure?.message || null }, null, 2)}\n`);
process.stdout.write(`${report}\n`);
if (failure) process.exitCode = 2;
