import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandJournal, executeCommand, reconcileCommandJournal } from '../client-runtime/command-journal.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-journal-'));
const journalFile = path.join(root, 'journal', 'command-journal.jsonl');
const journal = createCommandJournal({ filePath: journalFile });

let applyCalls = 0;
const registry = {
  'test-cmd': {
    keyFor: (state, body) => `test:${state.activeMissionId}:${body?.id || 'x'}`,
    isApplied: (state, payload) => state.applied === payload?.id,
    apply: (state, payload) => { applyCalls += 1; state.applied = payload.id; state.counter = (state.counter || 0) + 1; },
  },
};
const fakeSave = async (state) => { state.stateVersion = (Number(state.stateVersion) || 0) + 1; return state; };
const makeState = () => ({ activeMissionId: 'MIS_T', stateVersion: 0, commandJournalSeq: 0, applied: null, counter: 0, runtimeEvents: [], auditEvents: [] });

try {
  // ---- 1. journal 基础：append / findByKey / nextSeq / patch ----
  await journal.append({ seq: 1, commandId: 'cmd_1', idempotencyKey: 'k1', type: 'x', missionId: 'MIS_T', payload: {}, stateVersionBefore: 0, status: 'applied' });
  await journal.append({ seq: 2, commandId: 'cmd_2', idempotencyKey: 'k2', type: 'y', missionId: 'MIS_T', payload: {}, stateVersionBefore: 0, status: 'applied' });
  assert.equal((await journal.findByKey('k1')).seq, 1);
  assert.equal(await journal.nextSeq(), 3);
  await journal.patch(1, { result: 'done' });
  assert.equal((await journal.findByKey('k1')).result, 'done');
  assert.equal((await journal.entriesAfter(1)).length, 1);

  // ---- 2. executeCommand applied：apply 被调、stateVersion+1、commandJournalSeq 推进 ----
  applyCalls = 0;
  let s = makeState();
  let r = await executeCommand({ journal, saveState: fakeSave, registry, state: s, type: 'test-cmd', body: { id: 'a' } });
  assert.equal(r.status, 'applied');
  assert.match(r.entry.effectId, /^effect_[a-f0-9]{24}$/);
  assert.equal(applyCalls, 1);
  assert.equal(s.stateVersion, 1);
  assert.equal(s.commandJournalSeq, 3); // journal 已有 seq 1、2（case 1），本条为 seq 3
  assert.equal(s.applied, 'a');

  // ---- 3. skipped_idempotent：同 key 二次 → apply 不调、返回记录结果 ----
  applyCalls = 0;
  r = await executeCommand({ journal, saveState: fakeSave, registry, state: s, type: 'test-cmd', body: { id: 'a' } });
  assert.equal(r.status, 'skipped_idempotent');
  assert.equal(applyCalls, 0);
  assert.equal(s.applied, 'a');

  // ---- 4. conflict：expectedVersion 不匹配 → retryable，apply 不调 ----
  applyCalls = 0;
  s = makeState();
  s.stateVersion = 5;
  r = await executeCommand({ journal, saveState: fakeSave, registry, state: s, type: 'test-cmd', body: { id: 'b' }, expectedVersion: 3 });
  assert.equal(r.status, 'conflict');
  assert.equal(r.retryable, true);
  assert.equal(r.code, 'STATE_VERSION_CONFLICT');
  assert.equal(applyCalls, 0);

  // ---- 5. apply 抛错 → journal 记 failed、游标不推进 ----
  applyCalls = 0;
  const failingRegistry = { boom: { keyFor: () => 'boom', apply: () => { throw new Error('boom'); } } };
  s = makeState();
  await assert.rejects(executeCommand({ journal, saveState: fakeSave, registry: failingRegistry, state: s, type: 'boom', body: {} }), /boom/);
  assert.equal(s.commandJournalSeq, 0);
  assert.equal((await journal.findByKey('boom')).status, 'failed');

  // ---- 6. 崩溃恢复：journal 领先快照 → reconcile 重放追平；再跑幂等 ----
  applyCalls = 0;
  const replayRegistry = { 'replay-cmd': { apply: (state, payload) => { applyCalls += 1; state.applied = payload.id; } } };
  await journal.append({ seq: 10, commandId: 'cmd_10', idempotencyKey: 'replay:1', type: 'replay-cmd', missionId: 'MIS_T', payload: { id: 'replayed' }, stateVersionBefore: 9, status: 'applied' });
  const stale = makeState(); // commandJournalSeq 0，journal 已有 seq 10
  const recovered = await reconcileCommandJournal(stale, { journal, registry: replayRegistry });
  assert.equal(applyCalls, 1);
  assert.equal(recovered.state.applied, 'replayed');
  assert.equal(recovered.state.commandJournalSeq, 10);
  applyCalls = 0;
  await reconcileCommandJournal(recovered.state, { journal, registry: replayRegistry });
  assert.equal(applyCalls, 0, 'reconcile is idempotent');

  // ---- 7. 恢复守卫：seq <= commandJournalSeq 的条目不重放 ----
  applyCalls = 0;
  const caughtUp = { ...makeState(), commandJournalSeq: 10, applied: 'x' };
  await reconcileCommandJournal(caughtUp, { journal, registry: replayRegistry });
  assert.equal(applyCalls, 0);

  // ---- 集成：真实服务 + 队列单提交 / 幂等 / stateVersion / reset 清 journal ----
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = 4201;
  const testServicePort = 4202;
  const smokeRoot = path.join(root, 'integration');
  const baseUrl = `http://127.0.0.1:${port}`;
  const testService = spawn('node', ['test-service/mock-server.mjs'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_SERVICE_PORT: String(testServicePort) } });
  const child = spawn('node', ['client-runtime/local-server.mjs'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, API_PORT: String(port), SERVE_WEB: 'false',
    OPERATOR_DATA_DIR: path.join(smokeRoot, 'data'), OPERATOR_RUNTIME_DIR: path.join(smokeRoot, 'runtime'),
    OPERATOR_RUNTIME_MODE: 'reference-fixture', OPERATOR_TEST_SERVICE_URL: `http://127.0.0.1:${testServicePort}`,
    OPERATOR_AUTO_TICK: '0',
  } });
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${payload.code ? `${payload.code}: ` : ''}${payload.error || `HTTP ${response.status}`}`);
    return payload;
  };
  const requestFailure = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json();
    assert.equal(response.ok, false, `${pathname} should have failed`);
    return { status: response.status, payload };
  };
  const waitForState = async (predicate, label, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = (await request('/api/state')).state;
      if (predicate(latest)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify({
      stage: latest?.stage,
      agent: latest?.agent?.status,
      benchmark: latest?.benchmark?.status,
      baseline: latest?.baseline?.status,
      taskId: latest?.benchmark?.testTaskId,
    })}`);
  };
  const waitForServer = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { await request('/api/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    throw new Error('Journal test server did not start.');
  };

  try {
    await waitForServer();
    await request('/api/reset', { method: 'POST' });
    const mission = await request('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'Journal Mission', goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C500'] }) });
    const missionId = mission.state.activeMissionId;
    await request(`/api/missions/${missionId}/runs`, { method: 'POST', body: '{}' });
    let state;
    state = await waitForState((snapshot) => snapshot.agent.status === 'awaiting_action', 'initial agent readiness');

    // ---- 8. baseline start-benchmark：必须先跑 PyTorch reference 权威来源单文件 baseline，且允许在 patch 前运行 ----
    const baselineRunPy = [
      'def get_inputs():',
      '    import torch',
      '    return {"x": torch.arange(1024, dtype=torch.float32), "y": torch.ones(1024, dtype=torch.float32)}',
      '',
      'def run(inputs):',
      '    return inputs["x"] + inputs["y"]',
      '',
      'def reference(inputs):',
      '    return inputs["x"] + inputs["y"]',
      '',
    ].join('\n');
    const baselineSource = {
      authority: 'upstream',
      repository: 'https://github.com/flashinfer-ai/flashinfer.git',
      commit: 'ee3fda10',
      path: 'flashinfer/decode.py',
      operator: 'paged_decode',
      expandedSingleFile: true,
    };
    const missingSource = await requestFailure('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ purpose: 'baseline', runPy: baselineRunPy, matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'] } }) });
    assert.equal(missingSource.status, 400);
    assert.equal(missingSource.payload.code, 'BASELINE_SOURCE_REQUIRED');
    const naiveBaseline = await request('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ purpose: 'baseline', baselineKind: 'naive_v0', timeoutSeconds: 1, matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'] } }) });
    state = await waitForState((snapshot) => snapshot.benchmark.status === 'idle' && snapshot.baseline?.status === 'complete' && snapshot.baseline?.evidence?.runId === naiveBaseline.runId, 'naive baseline completion');
    assert.equal(state.baseline.kind, 'naive_v0');
    assert.equal(state.baseline.evidence.kind, 'naive_v0');
    assert.equal(state.baseline.evidence.source.authority, 'generated');
    assert.equal(state.baseline.evidence.source.basedOn, 'v0');
    assert.equal(state.baseline.resolution.strategy, 'fallback_naive_v0');
    const baseline = await request('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ purpose: 'baseline', runPy: baselineRunPy, baselineSource, timeoutSeconds: 1, matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'] } }) });
    state = await waitForState((snapshot) => snapshot.benchmark.status === 'idle' && snapshot.baseline?.status === 'complete' && snapshot.baseline?.evidence?.runId === baseline.runId, 'authoritative baseline completion');
    assert.equal(state.benchmark.status, 'idle');
    assert.equal(state.baseline.status, 'complete');
    assert.equal(state.baseline.evidence.kind, 'pytorch_reference');
    assert.equal(state.baseline.evidence.shapeKey, JSON.stringify({ correctnessCases: 24 }));
    assert.equal(state.baseline.evidence.source.repository, baselineSource.repository);
    assert.equal(state.stage, 'candidate');
    assert.equal(state.agent.currentAction.type, 'candidate.plan');

    await request('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });

    // ---- 9. candidate start-benchmark：命令日志记录 + guard 阻止重复提交 → 队列只有 1 个候选任务 ----
    const body = JSON.stringify({ timeoutSeconds: 1, matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'] } });
    const first = await request('/api/actions/start-benchmark', { method: 'POST', body });
    const secondFailure = await requestFailure('/api/actions/start-benchmark', { method: 'POST', body });
    assert.equal(secondFailure.status, 409);
    assert.equal(secondFailure.payload.code, 'INVALID_WORKFLOW_TRANSITION');
    const queueRaw = await readFile(path.join(smokeRoot, 'runtime', 'operator-test-queue.jsonl'), 'utf8');
    const tasks = queueRaw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(tasks.filter((task) => task.payload?.requestId === baseline.runId).length, 1, 'baseline benchmark should submit exactly once');
    assert.equal(tasks.filter((task) => task.payload?.requestId === first.runId).length, 1, 'same benchmark should submit exactly once');
    // 命令日志已记录 start-benchmark 且 stateVersionAfter 已补全
    const journalRaw = await readFile(path.join(smokeRoot, 'runtime', 'command-journal.jsonl'), 'utf8');
    const journalEntries = journalRaw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const benchmarkEntry = journalEntries.find((entry) => entry.type === 'start-benchmark' && entry.payload?.runId === first.runId);
    assert.ok(benchmarkEntry, 'journal should record start-benchmark');
    assert.equal(benchmarkEntry.stateVersionAfter, first.state.stateVersion);
    assert.equal(benchmarkEntry.status, 'applied');

    // ---- 11. SSE revision = stateVersion（state 暴露单调整数版本）----
    assert.ok(Number.isInteger(first.state.stateVersion) && first.state.stateVersion > 0);

    // ---- 9. 自动采用链路在命令日志存在时仍正常（reference-fixture 自动采用，decision.adopted 仅 1 条）----
    state = await waitForState((snapshot) => snapshot.benchmark.status === 'complete' && snapshot.stage === 'evidence', 'candidate benchmark completion');
    assert.equal(state.stage, 'evidence');
    state = await waitForState((snapshot) => snapshot.stage === 'published' && snapshot.knowledgeMaintenance.status === 'completed', 'published state');
    assert.equal(state.stage, 'published');
    assert.equal(state.decisionReview.resolution.source, 'policy');
    const adoptedEvents = (await request(`/api/missions/${missionId}/events`)).events.filter((event) => event.type === 'decision.auto_adopted' || event.type === 'decision.adopted');
    assert.equal(adoptedEvents.length, 1);

    // ---- 12. reset 清 journal，不误回放 ----
    const serverJournal = path.join(smokeRoot, 'runtime', 'command-journal.jsonl');
    assert.ok(await stat(serverJournal), 'journal file should exist before reset');
    await request('/api/reset', { method: 'POST' });
    let journalGone = false;
    try { await stat(serverJournal); } catch { journalGone = true; }
    assert.equal(journalGone, true, 'reset should clear command journal');

    console.log('[journal] durable command journal passed');
  } finally {
    child.kill('SIGTERM');
    testService.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); break; } catch (error) {
      if (!['ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
