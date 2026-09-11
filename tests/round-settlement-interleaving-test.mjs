import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommandJournal, executeCommand } from '../client-runtime/command-journal.mjs';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';
import { createMissionProjectState } from '../client-runtime/mission-project-state.mjs';
import { inspectCandidateDiff } from '../client-runtime/candidate-generation/admission.mjs';
import { advanceIteration } from '../client-runtime/iteration-loop.mjs';

// 专家点名的三项交错场景里，本文件覆盖第 1 项（首次失败 / 恢复成功 / 结算投影迟到）
// 与第 2 项的 Round 级「不得重启已结束的 Round」。全部确定性、无 CLI、无网络、无硬件。
const root = await mkdtemp(path.join(os.tmpdir(), 'operator-round-settlement-'));
const projectState = createMissionProjectState({
  rootDir: '', workspaceDir: '', workspaceDirForMission: () => '', missionSourceDirFor: () => '',
});
const provider = { slug: 'codex', name: 'Codex' };
const digest = 'sha256:' + 'a'.repeat(64);
const RELEASE_CONFIRMED = { confirmed: true, status: 'confirmed' };

const mission = (overrides = {}) => ({
  id: 'MIS_SETTLEMENT',
  title: '结算归属',
  goal: 'reduce latency',
  status: 'running',
  hardware: ['C500'],
  metric: 'latency_p50',
  implementation: null,
  operatorProfile: null,
  ...overrides,
});

const archivedState = (overrides = {}) => ({
  activeMissionId: 'MIS_SETTLEMENT',
  missions: [mission()],
  stage: 'diagnosis',
  runtimeEvents: [],
  runHistory: [],
  candidateEvaluations: [],
  tokenUsage: { runs: {} },
  iterationStats: { round: 1, loopStatus: 'running' },
  agent: {
    status: 'cancelled',
    runId: 'codex_first_run',
    runtimeKind: 'codex-cli',
    goal: 'reduce latency',
    resourceRelease: RELEASE_CONFIRMED,
    messages: [],
    artifacts: [],
  },
  benchmark: { status: 'idle', runId: null, candidate: null, completedAt: null, logs: [] },
  ...overrides,
});

try {
  // ---- A. 同一个 runId 只能有一条归档记录，且 `runHistory[0]` 必须是最新投影 -------------
  // 迟到投影会以同一个 state.agent.runId 再归档一次；无条件前插会让 runHistory[0] 变成
  // 两份相同记录，而 finalizeCandidateAdmission 正是读 runHistory 的 digest 做重复拒绝。
  const dedupe = archivedState();
  dedupe.iterationStats.roundBudget = { roundId: 'MIS_SETTLEMENT:round:1' };
  dedupe.benchmark = { ...dedupe.benchmark, runId: 'queue-request-a' };
  projectState.resetMissionRunState(dedupe, 'reduce latency');
  assert.equal(dedupe.runHistory.length, 1);
  assert.equal(dedupe.runHistory[0].runId, 'codex_first_run');
  assert.equal(dedupe.runHistory[0].roundId, 'MIS_SETTLEMENT:round:1');
  assert.equal(dedupe.runHistory[0].queueRequestId, 'queue-request-a');
  // 同一个 runId 的迟到结算投影：本轮队列请求已经变化，归档必须就地刷新而不是追加。
  dedupe.iterationStats.roundBudget = { roundId: 'MIS_SETTLEMENT:round:2' };
  dedupe.benchmark = { ...dedupe.benchmark, runId: 'queue-request-b' };
  projectState.resetMissionRunState(dedupe, 'reduce latency');
  assert.equal(dedupe.runHistory.filter((round) => round.runId === 'codex_first_run').length, 1, '同一 runId 不得产生两条归档记录');
  assert.equal(dedupe.runHistory[0].runId, 'codex_first_run');
  assert.equal(dedupe.runHistory[0].queueRequestId, 'queue-request-b', 'runHistory[0] 必须是最新投影');
  assert.equal(dedupe.runHistory[0].roundId, 'MIS_SETTLEMENT:round:2');
  assert.ok(dedupe.runHistory.length <= 20);

  // ---- B. 归属：候选来自恢复 run，不能被写成首次失败的 runId ---------------------------
  const recoveryRunId = 'codex_recovery_run';
  const attribution = archivedState();
  const admission = inspectCandidateDiff({
    agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py', sourceReferences: [] }], recommendedCandidate: 'agent-candidate' },
    manifest: { dirty: true, diff: 'diff --git a/run.py b/run.py', digest, changedFiles: ['run.py'] },
    provider,
    runId: recoveryRunId,
  });
  assert.equal(admission.verifiedCandidates[0].sourceRunId, recoveryRunId);
  assert.notEqual(admission.verifiedCandidates[0].sourceRunId, attribution.agent.runId);
  attribution.candidateEvaluations = [{
    ...admission.verifiedCandidates[0],
    id: 'candidate-01',
    candidateGenerationPath: 'patch_fallback',
    degraded: true,
    degradationReason: 'structured_edit_failed',
  }];
  attribution.iterationStats.roundBudget = { roundId: 'MIS_SETTLEMENT:round:1' };
  attribution.benchmark = { ...attribution.benchmark, runId: 'queue-request-recovery', candidate: { id: 'candidate-01', digest } };
  projectState.resetMissionRunState(attribution, 'reduce latency');
  const archived = attribution.runHistory[0];
  assert.equal(archived.candidateSourceRunId, recoveryRunId, '归档必须保留产出该候选的恢复 run');
  assert.notEqual(archived.candidateSourceRunId, 'codex_first_run');
  assert.equal(archived.candidateGenerationPath, 'patch_fallback');
  assert.equal(archived.degraded, true);
  assert.equal(archived.degradationReason, 'structured_edit_failed');
  assert.equal(archived.queueRequestId, 'queue-request-recovery');

  // ---- C. Queue 已接受但调用方未收到确认：同一 idempotencyKey 只允许一个 runner ---------
  const queueFile = path.join(root, 'runtime', 'operator-test-queue.jsonl');
  const queue = createOperatorTestQueue({ filePath: queueFile });
  const journal = createCommandJournal({ filePath: path.join(root, 'runtime', 'command-journal.jsonl') });
  const requestId = 'settlement-request-1';
  let persisted = { activeMissionId: 'MIS_SETTLEMENT', stateVersion: 0, commandJournalSeq: 0, requestId: null, taskId: null };
  let submits = 0;
  const saveState = async (state) => {
    persisted = { ...structuredClone(state), stateVersion: state.stateVersion + 1 };
    return structuredClone(persisted);
  };
  const registry = {
    'start-benchmark': {
      isApplied: (state) => state.requestId !== null,
      plan: () => ({ requestId }),
      prepare: async ({ intent, runEffect }) => runEffect(async () => {
        submits += 1;
        const submitted = await queue.submit({
          requestId: intent.requestId, missionId: 'MIS_SETTLEMENT', operator: 'identity',
          candidate: { digest }, matrix: { environments: ['C500'] },
        });
        return { payload: { requestId: submitted.payload.requestId, taskId: submitted.taskId }, result: { taskId: submitted.taskId } };
      }),
      apply: (state, payload) => { state.requestId = payload.requestId; state.taskId = payload.taskId; },
    },
  };
  const execute = () => executeCommand({
    journal, registry, saveState, type: 'start-benchmark', body: {}, idempotencyKey: 'settlement-round-1',
    state: structuredClone(persisted),
  });
  const first = await execute();
  assert.equal(first.status, 'applied');
  // 调用方丢了响应，用同一份 body 重放：必须幂等跳过，不得再排一个 runner。
  const replay = await execute();
  assert.equal(replay.status, 'skipped_idempotent');
  assert.equal(replay.result.taskId, first.result.taskId);
  assert.equal(submits, 1, '重放不得重复触发队列提交');
  const queueLines = (await readFile(queueFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(queueLines.filter((task) => task.payload?.requestId === requestId).length, 1, '同一个 requestId 在队列中只能出现一次');
  assert.equal(replay.state.taskId, first.state.taskId);

  // ---- D. Round 级：已结算 / 已取消的 Round 不得被重新启动 ------------------------------
  const spy = { calls: 0, inputs: [] };
  const startMainRound = async (input) => { spy.calls += 1; spy.inputs.push(input); return input.state; };
  const roundState = (agentOverrides) => archivedState({
    missionPaused: false,
    baseline: { status: 'complete' },
    iterationStats: { round: 1, loopStatus: 'running', lastCountedRunId: 'codex_first_run', consecutiveNoAdopt: 0 },
    agent: { ...archivedState().agent, ...agentOverrides },
  });

  // 正对照：同一状态但 Agent 正常终结 —— 证明这条断言确实走在 settledForResume 上。
  const resumable = await advanceIteration(roundState({ status: 'completed', resourceRelease: RELEASE_CONFIRMED }), { startMainRound });
  assert.equal(spy.calls, 1, '正常终结的无候选轮次应当自动续跑（本断言是下面两条断言的正对照）');
  assert.equal(resumable.action, 'resumed_agent');

  spy.calls = 0;
  spy.inputs.length = 0;
  const cancelled = await advanceIteration(roundState({ status: 'cancelled', resourceRelease: RELEASE_CONFIRMED }), { startMainRound });
  assert.equal(spy.calls, 0, '已取消且已确认释放的 Round 不得被重新启动');
  assert.equal(cancelled.action, 'none');

  const unconfirmed = await advanceIteration(roundState({ status: 'cancelled', resourceRelease: { confirmed: false, status: 'unconfirmed' } }), { startMainRound });
  assert.equal(spy.calls, 0, 'fail-closed：释放未确认时同样不得重启，且必须报为待确认或需人工介入');
  assert.ok(['resource_release_pending', 'needs_human'].includes(unconfirmed.action), `unexpected action: ${unconfirmed.action}`);
  const barrier = await advanceIteration(roundState({ status: 'cancelled', resourceRelease: { blocked: true, status: 'quarantined', confirmed: false } }), { startMainRound });
  assert.equal(spy.calls, 0);
  assert.equal(barrier.action, 'needs_human');

  console.log('[round-settlement-interleaving] run-history dedupe, recovery attribution, idempotent queue replay and settled-round barriers passed');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
