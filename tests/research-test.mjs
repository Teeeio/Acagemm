import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { parseResearchResult } from '../client-runtime/agent-result.mjs';

// ---- parseResearchResult 契约 ----
const structured = parseResearchResult([{
  type: 'item.completed',
  item: { type: 'agent_message', text: JSON.stringify({
    schemaVersion: 'operator-studio.research-notes/v1',
    summary: 'async dispatch 可降低 host 固定开销',
    findings: ['async dispatch 减少同步等待'],
    suggestedDirections: ['尝试 async plan descriptor cache'],
    sources: [{ title: 'Kernel Dispatch 论文', url: 'https://example.invalid/paper', type: 'paper' }],
  }) },
}]);
assert.equal(structured.format, 'structured-json');
assert.equal(structured.findings[0], 'async dispatch 减少同步等待');
assert.equal(structured.sources[0].url, 'https://example.invalid/paper');
assert.equal(structured.suggestedDirections[0], '尝试 async plan descriptor cache');
const fallback = parseResearchResult([{ type: 'item.completed', item: { type: 'agent_message', text: 'plain research notes' } }]);
assert.equal(fallback.format, 'text-fallback');
assert.equal(fallback.findings.length, 0);

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-research-'));
const researchDir = path.join(root, 'workspaces', 'MIS_RES', 'research');
const bridgeDir = path.join(root, 'bridge');
const sourceRoot = path.join(root, 'sources');

const spawnCalls = [];
let child;
const execFileImpl = (command, args, options, callback) => {
  if (args[0] === '--version') return callback(null, 'codex-cli 0.1.0\n', '');
  if (args[0] === 'login' && args[1] === 'status') return callback(null, 'Logged in\n', '');
  return callback(new Error(`unexpected probe: ${args.join(' ')}`), '', '');
};
const spawnImpl = (command, args, options) => {
  const call = { command, args, cwd: options.cwd, stdin: '' };
  spawnCalls.push(call);
  child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (chunk) => { call.stdin += chunk.toString(); });
  child.pid = 4321;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
  child.stdin.on('finish', async () => {
    child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-research' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'research done' } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    child.stdout.end();
    setTimeout(() => child.emit('close', 0, null), 80);
  });
  return child;
};

try {
  const client = createCodexClient({ command: 'codex-test', bridgeDir, execFileImpl, spawnImpl });
  const runtime = createAgentRuntime({ mode: 'codex-cli', codexClient: client, codexWorkspace: root });

  // ---- startResearch：沙箱参数、方向注入、runId、目录、串行 guard ----
  const idleState = { activeMissionId: 'MIS_RES', runtimeEvents: [], stage: 'diagnosis', patchApplied: false, candidateEvaluations: [{ id: 'stale' }], agent: { status: 'idle' }, researchAgent: null, researchNotes: [] };
  const mission = { id: 'MIS_RES', title: 'Research mission', repository: root, sourceRoot, hardware: ['C500'], metric: 'latency_p50', currentBest: { value: '47.0 μs' } };
  const started = await runtime.startResearch({ state: idleState, mission, direction: '调研 paged_attention 最新 kernel 优化', workspace: researchDir });
  assert.equal(started.state.researchAgent.status, 'running');
  assert.match(started.state.researchAgent.runId, /^codex_research_[A-Z0-9]+_[A-Z0-9]+$/);
  assert.equal(started.state.researchAgent.direction, '调研 paged_attention 最新 kernel 优化');
  assert.equal(started.state.researchAgent.researchDir, researchDir);
  assert.equal(started.state.researchAgent.budgetMs, 20 * 60 * 1000);
  assert.equal(started.state.researchAgent.synchronous, false, 'manual research defaults to asynchronous (parallel)');
  // 沙箱开放 + 只读边界
  assert.match(spawnCalls[0].args.join(' '), /--sandbox danger-full-access/);
  assert.match(spawnCalls[0].args.join(' '), /--cd .*research/);
  assert.match(spawnCalls[0].args.join(' '), /--add-dir .*sources/);
  assert.match(spawnCalls[0].stdin, /Research Agent/);
  assert.match(spawnCalls[0].stdin, /read-only research turn/);
  assert.match(spawnCalls[0].stdin, /research-notes\/v1/);
  assert.match(spawnCalls[0].stdin, /调研 paged_attention 最新 kernel 优化/);
  assert.match(spawnCalls[0].stdin, /do not produce a "candidates" field/i);
  // 研究 run 不碰主线程
  assert.equal(started.state.agent.status, 'idle');
  assert.equal(started.state.stage, 'diagnosis');
  assert.equal(started.state.candidateEvaluations.length, 1);
  assert.ok(started.state.runtimeEvents.some((event) => event.type === 'research.run_started'));

  // ---- 同步/异步调度：主线程运行中 → 同步研究 409，异步研究放行 ----
  const busyState = { activeMissionId: 'MIS_BUSY', runtimeEvents: [], agent: { status: 'running', runId: 'codex_MAIN' }, researchAgent: null, researchNotes: [] };
  await assert.rejects(
    runtime.startResearch({ state: structuredClone(busyState), mission, direction: 'x', workspace: researchDir, synchronous: true }),
    (error) => error.code === 'RESEARCH_SERIAL_BUSY',
  );
  // 异步研究（操作员触发）在主线程运行时允许并行启动
  const asyncStarted = await runtime.startResearch({ state: structuredClone(busyState), mission, direction: '并行调研', workspace: researchDir });
  assert.equal(asyncStarted.state.researchAgent.status, 'running');
  assert.equal(asyncStarted.state.researchAgent.synchronous, false);
  // 主线程 startRun 在异步研究员运行时允许并行（放行串行守卫）
  const researchRunningState = { activeMissionId: 'MIS_ASYNC', runtimeEvents: [], agent: { status: 'idle' }, researchAgent: { status: 'running', runId: 'codex_research_ASYNC', synchronous: false } };
  await runtime.startRun({ state: researchRunningState, mission, goal: 'inspect', workspace: researchDir });
  assert.equal(researchRunningState.agent.status, 'running', 'async research must not block main thread start');
  // 同步研究员运行时主线程 startRun 被拦
  const syncResearchState = { activeMissionId: 'MIS_SYNC', runtimeEvents: [], agent: { status: 'idle' }, researchAgent: { status: 'running', runId: 'codex_research_SYNC', synchronous: true } };
  await assert.rejects(
    runtime.startRun({ state: syncResearchState, mission, goal: 'inspect', workspace: researchDir }),
    (error) => error.code === 'RESEARCH_SERIAL_BUSY',
  );
  // 非 codex-cli 模式 → 503
  const fixtureRuntime = createAgentRuntime({ mode: 'reference-fixture' });
  await assert.rejects(
    fixtureRuntime.startResearch({ state: idleState, mission, direction: 'x', workspace: researchDir }),
    (error) => error.code === 'RESEARCH_RUNTIME_UNSUPPORTED',
  );

  // ---- projectState 研究分支：终态落笔记，不改主线程 ----
  let cancelCalled = false;
  const completedClient = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
    readRun: async () => ({ runId: 'codex_research_DONE', status: 'completed', completedAt: new Date().toISOString(), threadId: 'thread-research', error: null }),
    readEvents: async () => [
      { type: 'thread.started', thread_id: 'thread-research' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ schemaVersion: 'operator-studio.research-notes/v1', summary: 'found async dispatch', findings: ['async dispatch reduces host overhead'], suggestedDirections: ['try async dispatch cache'], sources: [{ title: 'Paper X', url: 'https://example.invalid/paper' }] }) } },
      { type: 'turn.completed' },
    ],
    eventText: (event) => event.item?.text || '',
    cancel: async () => { cancelCalled = true; return { status: 'cancel_requested' }; },
  };
  const completedRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: completedClient, codexWorkspace: root });
  const doneState = {
    activeMissionId: 'MIS_DONE', runtimeEvents: [], stage: 'candidate', patchApplied: true, candidateEvaluations: [{ id: 'stale' }],
    agent: { status: 'idle' },
    researchAgent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_research_DONE', direction: '调研 async dispatch', researchDir, startedAt: new Date().toISOString(), budgetMs: 20 * 60 * 1000, messages: [], artifacts: [], notes: [] },
    researchNotes: [],
  };
  const projected = await completedRuntime.projectState(doneState);
  assert.equal(projected.state.researchAgent.status, 'completed');
  assert.equal(projected.state.researchAgent.phase, '研究员调研完成');
  assert.equal(projected.state.researchNotes.length, 1);
  assert.equal(projected.state.researchNotes[0].findings[0], 'async dispatch reduces host overhead');
  assert.equal(projected.state.researchAgent.notes.length, 1);
  // 主线程 stage / candidateEvaluations / patchApplied 不变
  assert.equal(projected.state.stage, 'candidate');
  assert.equal(projected.state.patchApplied, true);
  assert.equal(projected.state.candidateEvaluations.length, 1);
  assert.equal(projected.state.agent.status, 'idle');
  assert.ok(projected.state.runtimeEvents.some((event) => event.type === 'research.completed'));

  // ---- 预算超时：running 超预算 → timed_out + cancel ----
  const timeoutClient = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
    readRun: async () => ({ runId: 'codex_research_T', status: 'running' }),
    readEvents: async () => [],
    eventText: () => '',
    cancel: async () => { cancelCalled = true; return { status: 'cancel_requested' }; },
  };
  const timeoutRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: timeoutClient, codexWorkspace: root });
  cancelCalled = false;
  const timeoutState = {
    activeMissionId: 'MIS_T', runtimeEvents: [], stage: 'diagnosis', agent: { status: 'idle' },
    researchAgent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_research_T', direction: 'x', researchDir, startedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(), budgetMs: 20 * 60 * 1000, messages: [], artifacts: [], notes: [] },
    researchNotes: [],
  };
  const timedOut = await timeoutRuntime.projectState(timeoutState);
  assert.equal(timedOut.state.researchAgent.status, 'timed_out');
  assert.equal(cancelCalled, true);
  assert.ok(timedOut.state.runtimeEvents.some((event) => event.type === 'research.timed_out'));

  // ---- cancelRun 按 runId 路由 ----
  const cancelState = { activeMissionId: 'MIS_C', runtimeEvents: [], agent: { status: 'idle' }, researchAgent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_research_C' } };
  const cancelled = await completedRuntime.cancelRun({ state: cancelState, runId: 'codex_research_C' });
  assert.equal(cancelled.state.researchAgent.status, 'cancel_requested');
  assert.ok(cancelled.state.runtimeEvents.some((event) => event.type === 'research.cancel_requested'));
  await assert.rejects(
    completedRuntime.cancelRun({ state: cancelState, runId: 'codex_OTHER' }),
    (error) => error.code === 'AGENT_RUN_MISMATCH',
  );

  console.log('[research] researcher sub-agent run lifecycle passed');
} finally {
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
