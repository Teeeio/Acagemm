import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
import { createAgentRuntime, isMainAgentActive, isResearchAgentActive } from '../client-runtime/agent-runtime.mjs';
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
    baselineSources: [{ authority: 'upstream', repository: 'https://github.com/flashinfer-ai/flashinfer.git', commit: 'ee3fda10', path: 'flashinfer/decode.py', operator: 'paged_attention', confidence: 'high', reason: '官方实现' }],
  }) },
}]);
assert.equal(structured.format, 'structured-json');
assert.equal(structured.findings[0], 'async dispatch 减少同步等待');
assert.equal(structured.sources[0].url, 'https://example.invalid/paper');
assert.equal(structured.baselineSources[0].repository, 'https://github.com/flashinfer-ai/flashinfer.git');
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
  assert.equal(started.state.researchAgent.budgetMs, 30 * 60 * 1000, 'acquire phase uses generous budget');
  assert.equal(started.state.researchAgent.runPhase, 'acquire');
  assert.equal(started.state.researchAgent.synchronous, false, 'manual research defaults to asynchronous (parallel)');
  // 采集阶段暴露隔离 research 目录和本地 Source Registry；固定工作流仍负责远程 clone 和快照记录。
  assert.match(spawnCalls[0].args.join(' '), /--sandbox workspace-write/);
  assert.doesNotMatch(spawnCalls[0].args.join(' '), /--skip-git-repo-check/);
  assert.match(spawnCalls[0].args.join(' '), /--cd .*research/);
  assert.ok(spawnCalls[0].args.join(' ').includes(`--add-dir ${sourceRoot}`));
  assert.match(spawnCalls[0].stdin, /Research Agent/);
  // mission 配置了 sourceRoot → 先检查本地，再选择可访问远程来源或语义 fallback。
  assert.match(spawnCalls[0].stdin, /ACQUISITION phase/);
  assert.match(spawnCalls[0].stdin, /Source Registry/);
  assert.match(spawnCalls[0].stdin, /First inspect the local Source Registry/i);
  assert.match(spawnCalls[0].stdin, /Gitee, GitHub, GitLab/i);
  assert.match(spawnCalls[0].stdin, /semanticFallback/);
  assert.doesNotMatch(spawnCalls[0].stdin, /research-notes\/v1/, 'acquire phase must not ask for the note JSON');
  assert.doesNotMatch(spawnCalls[0].stdin, /do not produce a "candidates" field/i, 'acquire phase must not require the note schema');
  // 无 sourceRoot 的 mission → 单阶段（检索 + 产笔记），不含 ACQUISITION 指令
  const noSourceMission = { id: 'MIS_NOSRC', title: 'No source', repository: root, sourceRoot: null, hardware: ['C500'], metric: 'latency_p50' };
  const noSourceState = { activeMissionId: 'MIS_NOSRC', runtimeEvents: [], stage: 'diagnosis', agent: { status: 'idle' }, researchAgent: null, researchNotes: [] };
  await runtime.startResearch({ state: noSourceState, mission: noSourceMission, direction: '纯检索', workspace: researchDir });
  assert.match(spawnCalls.at(-1).stdin, /read-only research turn/, 'no-sourceRoot mission stays single-phase research');
  assert.doesNotMatch(spawnCalls.at(-1).stdin, /ACQUISITION phase/);
  assert.match(spawnCalls.at(-1).stdin, /research-notes\/v1/, 'single-phase research asks for the note JSON');
  assert.match(spawnCalls[0].stdin, /调研 paged_attention 最新 kernel 优化/);
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
  assert.equal(isMainAgentActive({ status: 'completed', runId: 'codex_DONE' }), false);
  const completedMainState = { activeMissionId: 'MIS_DONE_MAIN', runtimeEvents: [], agent: { status: 'completed', runId: 'codex_DONE' }, researchAgent: null, researchNotes: [] };
  const syncAfterCompleted = await runtime.startResearch({ state: completedMainState, mission, direction: '停滞后调研', workspace: researchDir, synchronous: true });
  assert.equal(syncAfterCompleted.state.researchAgent.status, 'running');
  assert.equal(syncAfterCompleted.state.researchAgent.synchronous, true);
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
  assert.equal(isResearchAgentActive({ status: 'timed_out', runId: 'codex_research_DONE', synchronous: true }), false);
  const timedOutResearchState = { activeMissionId: 'MIS_RESEARCH_DONE', runtimeEvents: [], agent: { status: 'idle' }, researchAgent: { status: 'timed_out', runId: 'codex_research_DONE', synchronous: true } };
  await runtime.startRun({ state: timedOutResearchState, mission, goal: 'inspect after research', workspace: researchDir });
  assert.equal(timedOutResearchState.agent.status, 'running', 'terminal synchronous research must not block main thread start');
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
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ schemaVersion: 'operator-studio.research-notes/v1', summary: 'found async dispatch', findings: ['async dispatch reduces host overhead'], suggestedDirections: ['try async dispatch cache'], sources: [{ title: 'Paper X', url: 'https://example.invalid/paper' }], baselineSources: [{ authority: 'upstream', repository: 'https://github.com/flashinfer-ai/flashinfer.git', commit: 'ee3fda10', path: 'flashinfer/decode.py', operator: 'paged_attention', confidence: 'high' }] }) } },
      { type: 'turn.completed' },
    ],
    eventText: (event) => event.item?.text || '',
    cancel: async () => { cancelCalled = true; return { status: 'cancel_requested' }; },
  };
  const completedRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: completedClient, codexWorkspace: root });
  const doneState = {
    activeMissionId: 'MIS_DONE', runtimeEvents: [], stage: 'candidate', patchApplied: true, candidateEvaluations: [{ id: 'stale' }],
    agent: { status: 'idle' },
    researchAgent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_research_DONE', runPhase: 'synthesize', direction: '调研 async dispatch', researchDir, startedAt: new Date().toISOString(), budgetMs: 20 * 60 * 1000, messages: [], artifacts: [], notes: [] },
    researchNotes: [],
  };
  const projected = await completedRuntime.projectState(doneState);
  assert.equal(projected.state.researchAgent.status, 'completed');
  assert.equal(projected.state.researchAgent.phase, '研究员笔记完成');
  assert.equal(projected.state.researchNotes.length, 1);
  assert.equal(projected.state.researchNotes[0].findings[0], 'async dispatch reduces host overhead');
  assert.equal(projected.state.researchNotes[0].baselineSources[0].repository, 'https://github.com/flashinfer-ai/flashinfer.git');
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
    researchAgent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_research_T', runPhase: 'synthesize', direction: 'x', researchDir, startedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(), budgetMs: 20 * 60 * 1000, messages: [], artifacts: [], notes: [] },
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

  // ---- projectState 主分支：cancel_requested 不被 running 覆盖（B2） ----
  // 取消后 codex 进程未必立即死透（run.status 仍为 running），投影必须保留 cancel_requested，
  // 直到进程真正终结为 cancelled，否则 UI"正在取消"状态被覆盖丢失。
  const cancelMainClient = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
    readRun: async () => ({ runId: 'codex_MAIN', status: 'running', threadId: 'thread-main', error: null }),
    readEvents: async () => [{ type: 'turn.completed' }],
    eventText: () => '',
    cancel: async () => ({ status: 'cancel_requested' }),
  };
  const cancelMainRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: cancelMainClient, codexWorkspace: root });
  const cancelMainState = {
    activeMissionId: 'MIS_CM', runtimeEvents: [], stage: 'diagnosis', patchApplied: false, candidateEvaluations: [],
    agent: { status: 'cancel_requested', runtimeKind: 'codex-cli', runId: 'codex_MAIN', phase: '正在取消 Codex', messages: [], artifacts: [], toolCalls: [] },
    researchAgent: { status: 'idle' },
  };
  const cancelMainProjected = await cancelMainRuntime.projectState(cancelMainState);
  assert.equal(cancelMainProjected.state.agent.status, 'cancel_requested', 'cancel_requested 必须在进程未死透时保持，不被覆盖回 running');
  assert.equal(cancelMainProjected.state.agent.phase, '正在取消 Codex');
  // 进程真正终结（run.status='cancelled'）后收敛为 cancelled
  const cancelDeadClient = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
    readRun: async () => ({ runId: 'codex_MAIN', status: 'cancelled', threadId: 'thread-main', error: null }),
    readEvents: async () => [{ type: 'turn.completed' }],
    eventText: () => '',
    cancel: async () => ({ status: 'cancel_requested' }),
  };
  const cancelDeadRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: cancelDeadClient, codexWorkspace: root });
  const cancelDeadProjected = await cancelDeadRuntime.projectState(structuredClone(cancelMainState));
  assert.equal(cancelDeadProjected.state.agent.status, 'cancelled', '进程终结后收敛为 cancelled');

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
