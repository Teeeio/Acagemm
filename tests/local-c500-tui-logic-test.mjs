import assert from 'node:assert/strict';
import { deriveTuiViewModel, deriveWorkflowTopology, renderDashboardSnapshot, renderWorkflowTopologySnapshot, resolveDashboardCommand } from '../tools/local-c500-tester/tui-state.mjs';

const mission = (overrides = {}) => ({ id: 'MIS_TUI', title: 'MLA C500', goal: 'improve baseline by 20%', status: 'running', ...overrides });
const task = (purpose, status = 'completed', value = null) => ({
  taskId: `${purpose}-${status}-${value ?? 'none'}`,
  status,
  payload: { purpose },
  result: value == null ? null : {
    benchmark: [{ value, unit: 'us' }],
    environment: { source: 'simulation', liveHardware: false },
  },
});

const idle = deriveTuiViewModel({ state: {}, mission: null, tasks: [] });
assert.equal(idle.hasMission, false);
assert.equal(idle.actions.publish, true);
assert.equal(idle.actions.pause, false);
assert.equal(idle.actions.feedback, false);
assert.equal(idle.actions.export, false);
assert.equal(resolveDashboardCommand({ input: ' ', viewModel: idle }), null);
assert.equal(resolveDashboardCommand({ input: 'q', viewModel: idle }), 'quit');

const runningSnapshot = {
  mission: mission(),
  state: {
    stage: 'validation',
    missionPaused: false,
    agent: { status: 'executing', phase: 'Candidate 1' },
    iterationStats: { loopStatus: 'running', round: 0 },
    baseline: { status: 'complete', kind: 'pytorch_reference' },
    benchmark: { status: 'running', progress: 60, candidate: { id: 'candidate-01' } },
  },
  tasks: [task('baseline'), task('candidate', 'running')],
};
const running = deriveTuiViewModel(runningSnapshot);
assert.equal(running.displayedRounds, 1);
assert.equal(running.activeTasks, 1);
assert.match(running.banner, /^TESTING \/ 60%/);
assert.equal(running.actions.pause, true);
assert.equal(resolveDashboardCommand({ input: ' ', viewModel: running }), 'pause');
assert.equal(resolveDashboardCommand({ input: 'n', viewModel: running }), 'feedback');

const liveClaudeActivity = deriveTuiViewModel({
  ...runningSnapshot,
  state: {
    ...runningSnapshot.state,
    agent: {
      status: 'running',
      phase: 'Claude Code 正在分析',
      messages: [{ title: 'Claude Code Mission 已启动', detail: 'Run claude_TEST · 2.1.247 (Claude Code)' }],
      activity: { status: 'running', name: 'Read', summary: '读取 run.py' },
    },
  },
});
assert.equal(liveClaudeActivity.currentActivity, '运行中 · Read · 读取 run.py');
const preToolClaudeActivity = deriveTuiViewModel({
  ...runningSnapshot,
  state: {
    ...runningSnapshot.state,
    agent: {
      status: 'running',
      phase: 'Claude Code 正在分析',
      messages: [{ title: 'Claude Code Mission 已启动', detail: 'Run claude_TEST · 2.1.247 (Claude Code)' }],
    },
  },
});
assert.equal(preToolClaudeActivity.currentActivity, 'Claude Code 正在分析');

const paused = deriveTuiViewModel({
  ...runningSnapshot,
  state: { ...runningSnapshot.state, missionPaused: true },
});
assert.equal(paused.actions.pause, false);
assert.equal(paused.actions.resume, true);
assert.equal(paused.statusLabel, 'paused');
assert.match(paused.banner, /^PAUSED/);
assert.equal(resolveDashboardCommand({ input: ' ', viewModel: paused }), 'resume');

const needsHumanSnapshot = {
  mission: mission({ status: 'needs_human' }),
  state: { iterationStats: { loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' } },
  tasks: [],
};
const needsHuman = deriveTuiViewModel(needsHumanSnapshot);
assert.equal(needsHuman.needsHuman, true);
assert.equal(needsHuman.actions.pause, false);
assert.equal(needsHuman.actions.resume, true);
assert.equal(needsHuman.actions.feedback, true);
assert.equal(needsHuman.actions.stop, true);
assert.match(needsHuman.banner, /ACTION REQUIRED \/ baseline_source_unresolved/);
assert.equal(resolveDashboardCommand({ input: ' ', viewModel: needsHuman }), 'resume');

const failedBaselineSnapshot = {
  mission: mission({ status: 'needs_human' }),
  state: {
    stage: 'candidate',
    baseline: { status: 'failed', error: { code: 'LOCAL_C500_RUNNER_FAILED', message: 'CUDA out of memory' } },
    benchmark: { status: 'failed', progress: 100, testTaskId: 'baseline-failed-1', lastServiceError: { code: 'LOCAL_C500_RUNNER_FAILED', message: 'CUDA out of memory' } },
    iterationStats: { loopStatus: 'needs_human', loopStatusReason: 'baseline_test_failed' },
  },
  tasks: [{ ...task('baseline', 'failed'), taskId: 'baseline-failed-1', error: { code: 'LOCAL_C500_RUNNER_FAILED', message: 'CUDA out of memory' } }],
};
const failedBaseline = deriveTuiViewModel(failedBaselineSnapshot);
assert.equal(failedBaseline.failure.code, 'LOCAL_C500_RUNNER_FAILED');
assert.match(failedBaseline.failure.message, /CUDA out of memory/);
assert.match(failedBaseline.banner, /LOCAL_C500_RUNNER_FAILED/);
assert.match(renderDashboardSnapshot(failedBaselineSnapshot), /error       LOCAL_C500_RUNNER_FAILED: CUDA out of memory/);

const stopped = deriveTuiViewModel({
  mission: mission({ status: 'stopped' }),
  state: { missionPaused: true, iterationStats: { loopStatus: 'stopped', loopStatusReason: 'stopped_by_tester' } },
  tasks: [],
});
assert.equal(stopped.actions.resume, true);
assert.equal(stopped.actions.stop, false);
assert.equal(stopped.statusLabel, 'stopped');
assert.equal(resolveDashboardCommand({ input: ' ', viewModel: stopped }), 'resume');

const completedSnapshot = {
  mission: mission({ status: 'published' }),
  state: {
    stage: 'published',
    iterationStats: { loopStatus: 'completed', round: 2 },
    currentBest: { candidateId: 'candidate-03', value: '75 us', improvement: '25%' },
    benchmark: { status: 'completed', result: { environment: { source: 'simulation', liveHardware: false } } },
  },
  tasks: [task('baseline', 'completed', 100), task('candidate', 'completed', 92), task('candidate', 'completed', 84), task('candidate', 'completed', 75)],
};
const completed = deriveTuiViewModel(completedSnapshot);
assert.equal(completed.terminal, true);
assert.equal(completed.simulation, true);
assert.equal(completed.statusLabel, 'completed');
assert.equal(completed.displayedRounds, 3);
assert.equal(completed.actions.pause, false);
assert.equal(completed.actions.feedback, false);
assert.equal(completed.actions.stop, false);
assert.equal(completed.actions.export, true);
assert.match(completed.banner, /COMPLETED \/ simulation only/);

const completedTopology = deriveWorkflowTopology(completedSnapshot);
assert.deepEqual(completedTopology.recentCandidates.map((candidate) => candidate.value), ['92 us', '84 us', '75 us']);
assert.deepEqual(completedTopology.recentCandidates.map((candidate) => candidate.improvement), ['+8%', '+16%', '+25%']);
assert.equal(completedTopology.currentNode.title, 'ADOPT');
assert.equal(completedTopology.iterationNodes.rollback.status, 'pending');
assert.match(renderWorkflowTopologySnapshot(completedSnapshot), /\{ ✓ ADOPT \[F\] \| · ROLLBACK \[F\] \}/);

const retrySnapshot = {
  mission: mission(),
  state: {
    baseline: { status: 'complete', evidence: { value: 100 } },
    iterationStats: { loopStatus: 'running', round: 1 },
    runtimeEvents: [{ type: 'accept_gate.evaluated', payload: { candidate: 'candidate-02', passed: false, result: 'reference' } }],
  },
  tasks: [
    task('baseline', 'completed', 100),
    { ...task('candidate', 'failed'), taskId: 'candidate-02-attempt-1', submittedAt: '2026-08-26T01:00:00Z', payload: { purpose: 'candidate', candidate: { id: 'candidate-02', digest: 'sha256:same' } } },
    { ...task('candidate', 'completed', 84), taskId: 'candidate-02-attempt-2', submittedAt: '2026-08-26T01:01:00Z', payload: { purpose: 'candidate', candidate: { id: 'candidate-02', digest: 'sha256:same' } } },
  ],
};
const retryTopology = deriveWorkflowTopology(retrySnapshot);
assert.equal(retryTopology.candidates.length, 1, '同一 Candidate 的测试重试只能占一行');
assert.equal(retryTopology.candidates[0].taskId, 'candidate-02-attempt-2');
assert.equal(retryTopology.candidates[0].attempt, 2);
assert.equal(retryTopology.candidates[0].value, '84 us');
assert.equal(retryTopology.candidates[0].gate, 'rejected');
assert.equal(deriveTuiViewModel(retrySnapshot).displayedRounds, 2, '测试重试不能增加迭代轮数');

const correctnessRepairSnapshot = {
  mission: mission(),
  state: {
    baseline: { status: 'complete', evidence: { value: 100 } },
    iterationStats: { loopStatus: 'running', round: 0, currentRoundCorrectnessAttempts: 1 },
    agent: {
      status: 'running', runId: 'claude-repair-1', startedAt: new Date(Date.now() - 65_000).toISOString(), eventCount: 7,
      phase: 'Claude Code 正在分析',
      toolCalls: [{ id: 'tool-1', status: 'running', name: 'Read', summary: 'inspecting paged_mqa_logits.py' }],
    },
  },
  tasks: [
    task('baseline', 'completed', 100),
    { ...task('candidate', 'failed'), taskId: 'candidate-01-attempt-1', submittedAt: '2026-08-28T01:00:00Z', payload: { purpose: 'candidate', candidate: { id: 'candidate-01', digest: 'sha256:first' } }, error: { code: 'LOCAL_C500_RUNNER_FAILED', message: 'correctness failed', correctness: { failedCaseName: 'mqa_s2-float16', referenceCache: { enabled: true, hits: 9, misses: 1 } } } },
  ],
};
const repairTopology = deriveWorkflowTopology(correctnessRepairSnapshot);
assert.equal(repairTopology.candidates.length, 1);
assert.equal(repairTopology.candidates[0].round, 1, 'correctness repair must retain candidate-01 / round 1');
assert.equal(repairTopology.candidates[0].attempt, 2);
assert.equal(repairTopology.candidates[0].disposition, 'correctness repair');
assert.equal(repairTopology.currentNode.progressMode, 'activity');
assert.match(repairTopology.currentNode.detail, /Read.*inspecting paged_mqa_logits\.py/);
assert.match(repairTopology.currentNode.meta, /claude-repair-1.*events 7.*elapsed 1m/);
assert.doesNotMatch(renderWorkflowTopologySnapshot(correctnessRepairSnapshot), /Current.*8%/);
const repairView = deriveTuiViewModel(correctnessRepairSnapshot);
assert.match(repairView.queue[0].line, /FAIL mqa_s2-float16/);
assert.match(repairView.queue[0].line, /ref-cache 9\/10 hit/);

const preBaselineTopology = deriveWorkflowTopology({
  mission: mission(),
  state: {
    agent: { status: 'running', progress: 40, phase: 'waiting for baseline' },
    researchAgent: { status: 'running', progress: 30, phase: 'discovering source' },
    baseline: { status: 'missing', materializer: { status: 'idle' } },
    iterationStats: { round: 0, loopStatus: 'running' },
  },
  tasks: [],
});
assert.equal(preBaselineTopology.candidates.length, 0, 'baseline 完成前不得虚构 Candidate 轮次');
assert.equal(preBaselineTopology.currentNode.title, 'SOURCE RESEARCH');

const rendered = renderDashboardSnapshot({ ...completedSnapshot, health: { testBackend: { kind: 'local-c500', mock: true } } });
assert.match(rendered, /workflow    COMPLETED \/ simulation only/);
assert.match(rendered, /rounds      3/);
assert.match(rendered, /queue       0 active \/ 4 total/);
assert.match(rendered, /value       75 us/);
assert.doesNotMatch(rendered, /\[Space\]|\[N\] Feedback|\[S\] Stop/);
assert.match(rendered, /\[E\] Export/);

let seed = 0x5eed1234;
const random = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];
for (let index = 0; index < 300; index += 1) {
  const hasMission = random() > 0.2;
  const randomTasks = Array.from({ length: Math.floor(random() * 6) }, (_, taskIndex) => task(
    taskIndex === 0 ? 'baseline' : 'candidate',
    pick(['waiting', 'running', 'completed', 'failed', 'cancelled']),
  ));
  const snapshot = {
    mission: hasMission ? mission({ status: pick(['running', 'needs_human', 'stopped', 'published', 'failed']) }) : null,
    state: {
      missionPaused: random() > 0.7,
      iterationStats: { loopStatus: pick(['running', 'needs_human', 'stopped', 'completed', 'failed']), round: Math.floor(random() * 5) },
      benchmark: { status: pick(['idle', 'running', 'completed']), progress: Math.floor(random() * 101) },
    },
    tasks: randomTasks,
  };
  const view = deriveTuiViewModel(snapshot);
  assert.equal(view.actions.pause && view.actions.resume, false, 'pause and resume must be mutually exclusive');
  const logicalCandidates = new Set(randomTasks
    .filter((item) => item.payload.purpose === 'candidate')
    .map((item) => item.payload.candidate?.id || item.payload.candidate?.digest || item.taskId));
  assert.ok(view.displayedRounds >= logicalCandidates.size);
  if (!hasMission) assert.deepEqual(
    Object.entries(view.actions).filter(([, enabled]) => enabled).map(([name]) => name),
    ['publish', 'doctor', 'quit'],
  );
  assert.doesNotThrow(() => renderDashboardSnapshot(snapshot));
}

console.log('[local-c500-tui-logic] state policy, commands, terminal UX, and 300 randomized snapshots passed');
