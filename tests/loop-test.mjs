import assert from 'node:assert/strict';
import {
  advanceIteration,
  detectStagnation,
  decideResearchTrigger,
  detectPlateau,
  selectResearchDirection,
  buildResearchBriefing,
  evaluateResearchValue,
  detectLoopGuard,
  detectTunnelVision,
  isResearchExhausted,
  isResolvedEvidenceRound,
  settleGenerationAttemptBeforeStart,
  PLATEAU_NO_IMPROVE_ROUNDS,
  STAGNATION_WINDOW,
  MAX_ROUNDS,
  MAX_RESEARCH_ESCALATIONS,
  TOTAL_BUDGET_MS,
} from '../client-runtime/iteration-loop.mjs';
import { createMission, createSeedState, resumeMissionState } from '../client-runtime/state-store.mjs';

const resumableState = createSeedState();
const resumableMission = resumableState.missions.find((item) => item.id === resumableState.activeMissionId);
resumableState.missionPaused = true;
resumableState.iterationStats = { ...resumableState.iterationStats, loopStatus: 'needs_human', loopStatusReason: 'transient_runtime_failure' };
resumableMission.status = 'needs_human';
const resumedLifecycle = resumeMissionState(resumableState, { source: 'test' });
assert.equal(resumedLifecycle.resumed, true);
assert.equal(resumableState.missionPaused, false);
assert.equal(resumableState.iterationStats.loopStatus, 'running');
assert.equal(resumableState.iterationStats.loopStatusReason, null);
assert.equal(resumableMission.status, 'running');
assert.equal(resumableState.runtimeEvents.at(-1).type, 'mission.resumed');
assert.equal(resumableState.runtimeEvents.at(-1).payload.previousLoopStatus, 'needs_human');

const pausedState = createSeedState();
const pausedMissionId = pausedState.activeMissionId;
pausedState.missionPaused = true;
pausedState.iterationStats = { ...pausedState.iterationStats, loopStatus: 'needs_human', loopStatusReason: 'workflow_invariant:WORKFLOW_SIMULATION_PUBLISH_FORBIDDEN' };
const newMissionState = createMission(pausedState, { goal: 'Run an independent fixed operator profile', title: 'Fresh Mission', repository: 'fresh-mission-repository' });
assert.notEqual(newMissionState.activeMissionId, pausedMissionId);
assert.equal(newMissionState.missionPaused, false, 'a new Mission must not inherit the previous Mission pause flag');
assert.equal(newMissionState.iterationStats.loopStatus, 'running', 'a new Mission must start with its own lifecycle state');

// ---- 纯函数：停滞判定（尺子 B 采纳尺） ----
assert.equal(STAGNATION_WINDOW, 3);
assert.deepEqual(detectStagnation({ iterationStats: { consecutiveNoAdopt: 2, lastCountedRunId: 'run_1' } }).stagnated, false);
assert.deepEqual(detectStagnation({ iterationStats: { consecutiveNoAdopt: 3, lastCountedRunId: 'run_1' } }).stagnated, true);
// 未计过数时从 runHistory 兜底推导
assert.deepEqual(detectStagnation({ iterationStats: {}, runHistory: [{ runId: 'a', stage: 'diagnosis' }, { runId: 'b', stage: 'diagnosis' }, { runId: 'c', stage: 'candidate' }] }).consecutiveNoAdopt, 3);
// adopted（decisionReview.resolution.outcome === 'adopt'）不计为停滞
assert.deepEqual(detectStagnation({ iterationStats: {}, runHistory: [{ runId: 'a', stage: 'evidence', decisionReview: { resolution: { outcome: 'adopt' } } }, { runId: 'b', stage: 'diagnosis' }, { runId: 'c', stage: 'diagnosis' }] }).consecutiveNoAdopt, 2);
assert.equal(detectStagnation({ iterationStats: {}, runHistory: [
  { runId: 'r1', stage: 'evidence', candidateDigest: 'sha256:same', decisionReview: { resolution: { outcome: 'reference' } } },
  { runId: 'r2', stage: 'evidence', candidateDigest: 'sha256:same', decisionReview: { resolution: { outcome: 'reference' } } },
  { runId: 'r3', stage: 'evidence', candidateDigest: 'sha256:same', decisionReview: { resolution: { outcome: 'reference' } } },
] }).stagnated, true);
assert.equal(detectStagnation({ iterationStats: { consecutiveNoAdopt: 2, lastCountedRunId: 'r2' }, runHistory: [
  { runId: 'r1', stage: 'evidence', candidateDigest: 'sha256:same', decisionReview: { resolution: { outcome: 'reference' } } },
  { runId: 'r2', stage: 'evidence', candidateDigest: 'sha256:same', decisionReview: { resolution: { outcome: 'reference' } } },
  { runId: 'r3', stage: 'evidence', candidateDigest: 'sha256:other', decisionReview: { resolution: { outcome: 'reference' } } },
] }).stagnated, false);

// ---- 纯函数：升级决策 ----
const trigger = decideResearchTrigger({ iterationStats: { consecutiveNoAdopt: 3, lastCountedRunId: 'run_1' }, missions: [{ id: 'MIS', goal: 'optimize latency' }], activeMissionId: 'MIS' });
assert.equal(trigger.trigger, true);
assert.match(trigger.reason, /3 轮/);
assert.match(trigger.direction, /optimize latency/);

// ---- 纯函数：调研方向包含卡点 ----
const direction = selectResearchDirection({
  activeMissionId: 'MIS', missions: [{ id: 'MIS', goal: '降低 C500 延迟', hardware: ['C500'], metric: 'latency_p50' }],
  currentBest: { value: '47.0 μs' },
  candidateEvaluations: [{ id: 'c1', acceptGate: { failedRules: ['performance.target.c500'] } }],
  failureRecords: [{ id: 'fail.1', title: 'Adaptive tile 边界失败', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' } }],
});
assert.match(direction, /C500/);
assert.match(direction, /performance.target.c500/);
assert.match(direction, /CORRECTNESS_BOUNDARY_MISMATCH/);

// ---- 纯函数：调研简报 ----
const briefing = buildResearchBriefing({
  mission: { id: 'MIS' },
  researchNotes: [{ direction: '调研 async dispatch', summary: 'async 可降固定开销', findings: ['f1'], suggestedDirections: ['尝试 async cache'], sources: [{ title: 'Paper X', url: 'https://x.invalid' }] }],
  failureRecords: [{ id: 'fail.1', title: 'Adaptive tile 边界失败' }],
  currentBest: { value: '47.0 μs' },
});
assert.match(briefing, /自动注入/);
assert.match(briefing, /async dispatch/);
assert.match(briefing, /Adaptive tile/);

// ---- 纯函数：价值闸 ----
const novelNote = { summary: 'a novel kernel fusion direction with measurements', findings: ['fusion reduces launch overhead'], suggestedDirections: ['try fusion'] };
assert.equal(evaluateResearchValue({ research: novelNote, knowledge: {} }).inject, true);
assert.equal(evaluateResearchValue({ research: novelNote, knowledge: {} }).value, 'medium');

const addressesFailure = evaluateResearchValue({
  research: { summary: 'async dispatch caused correctness boundary mismatch', findings: [] },
  knowledge: { failureRecords: [{ id: 'fail.1', title: 'async dispatch', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: '数值偏差' }] },
});
assert.equal(addressesFailure.inject, true);
assert.equal(addressesFailure.value, 'high');
assert.ok(addressesFailure.matches.some((match) => match.kind === 'addresses_failure'));

const duplicate = evaluateResearchValue({
  research: { summary: 'async plan descriptor cache validated approach', findings: [] },
  knowledge: { publishedAssets: [{ id: 'exp.1', title: 'async plan descriptor cache validated approach', conclusion: '有效', trigger: 'small batch' }] },
});
assert.equal(duplicate.inject, false);
assert.equal(duplicate.value, 'low');

// ---- 纯函数：已决策 evidence 终态识别 ----
const resolvedReferenceEvidence = {
  stage: 'evidence',
  agent: { status: 'completed', runId: 'codex_done' },
  benchmark: { status: 'complete' },
  decisionReview: { status: 'resolved', recommendation: 'reference' },
};
assert.equal(isResolvedEvidenceRound(resolvedReferenceEvidence), true);
assert.equal(isResolvedEvidenceRound({ ...resolvedReferenceEvidence, decisionReview: { status: 'pending', recommendation: 'reference' } }), false);
assert.equal(isResolvedEvidenceRound({ ...resolvedReferenceEvidence, agent: { status: 'awaiting_action', runId: 'codex_done' } }), false);

// ---- advanceIteration：短路与编排 ----
const makeState = (overrides = {}) => {
  const base = {
    activeMissionId: 'MIS',
    missions: [{ id: 'MIS', goal: '优化 C500 延迟', hardware: ['C500'], metric: 'latency_p50' }],
    stage: 'diagnosis',
    agent: { status: 'idle' },
    researchAgent: { status: 'idle', runId: null },
    researchNotes: [],
    iterationStats: { round: 0, consecutiveNoAdopt: 0, lastCountedRunId: null, lastResearchRunId: null, researchRounds: 0, pendingInjection: null, loopStatus: 'running', loopStatusReason: null, loopStartedAt: null },
    runHistory: [],
    benchmark: { status: 'idle' },
    failureRecords: [], publishedAssets: [], knowledgeDrafts: [], knowledgeReferences: [],
    currentBest: { value: '47.0 μs' },
    missionPaused: false,
    knowledgeMaintenance: { status: 'idle' },
    auditEvents: [],
    runtimeEvents: [],
    candidateEvaluations: [],
    patchApplied: false,
  };
  return { ...base, ...overrides };
};

const fixedRoundMission = { id: 'MIS', goal: '三轮后保留最快候选', hardware: ['C550'], metric: 'latency p50', objective: { mode: 'maximize' }, testScenario: { fixedRounds: 3 } };
const humanBlocked = makeState({
  missions: [fixedRoundMission],
  iterationStats: { ...makeState().iterationStats, loopStatus: 'needs_human', loopStatusReason: 'operator_intervention_required' },
  benchmark: { status: 'idle' },
});
assert.equal(detectLoopGuard(humanBlocked), 'operator_intervention_required', 'an idle needs_human Mission must remain stopped');
const staleBlockWithRunningTest = makeState({
  missions: [fixedRoundMission],
  iterationStats: { ...makeState().iterationStats, loopStatus: 'needs_human', loopStatusReason: 'stale_failure' },
  benchmark: { status: 'running', runId: 'run_active', testTaskId: 'task_active' },
});
assert.equal(detectLoopGuard(staleBlockWithRunningTest), null, 'an active operator test is authoritative over a stale needs_human marker');
const fixedRoundTwo = makeState({ missions: [fixedRoundMission], objective: { mode: 'maximize' }, iterationStats: { ...makeState().iterationStats, round: 2 } });
assert.equal(detectLoopGuard(fixedRoundTwo), null, 'fixed-profile mission must continue after two completed rounds');
const fixedRoundThree = makeState({ missions: [fixedRoundMission], objective: { mode: 'maximize' }, iterationStats: { ...makeState().iterationStats, round: 3 }, currentBest: { candidateId: 'candidate-01', value: '16428 us', verified: true, evidenceSource: 'live' } });
assert.equal(detectLoopGuard(fixedRoundThree), 'fixed_rounds_complete');
const fixedRoundComplete = await advanceIteration(fixedRoundThree, {});
assert.equal(fixedRoundComplete.action, 'completed_fixed_rounds');
assert.equal(fixedRoundComplete.state.iterationStats.loopStatus, 'completed');
assert.match(fixedRoundComplete.state.agent.phase, /固定三轮完成/);

const phasedMission = {
  ...fixedRoundMission,
  testScenario: { iterationPolicy: { maxGenerationAttempts: 2, maxCorrectnessAttempts: 4, performanceRounds: 3 } },
};
const phasedGenerationRetry = makeState({
  missions: [phasedMission],
  baseline: { status: 'complete' },
  agent: { status: 'completed', runId: 'generation_attempt_1' },
  iterationStats: { ...makeState().iterationStats, currentRoundGenerationAttempts: 1, lastGenerationAttemptRunId: 'generation_attempt_1' },
});
assert.equal(detectLoopGuard(phasedGenerationRetry), null, 'one failed generation attempt remains retryable');
const phasedGenerationExhausted = makeState({
  missions: [phasedMission],
  baseline: { status: 'complete' },
  agent: { status: 'completed', runId: 'generation_attempt_2' },
  iterationStats: { ...makeState().iterationStats, currentRoundGenerationAttempts: 2, lastGenerationAttemptRunId: 'generation_attempt_2' },
});
assert.equal(detectLoopGuard(phasedGenerationExhausted), 'candidate_generation_failed');
const phasedGenerationStopped = await advanceIteration(phasedGenerationExhausted, {});
assert.equal(phasedGenerationStopped.action, 'needs_human');
assert.equal(phasedGenerationStopped.state.iterationStats.loopStatus, 'needs_human');
assert.equal(phasedGenerationStopped.state.iterationStats.loopStatusReason, 'candidate_generation_failed');
const generationRaceState = makeState({
  missions: [phasedMission],
  baseline: { status: 'complete' },
  agent: { status: 'completed', runId: 'race_attempt_1' },
});
const firstRaceSettlement = settleGenerationAttemptBeforeStart(generationRaceState, phasedMission);
assert.equal(firstRaceSettlement.blocked, false);
assert.equal(firstRaceSettlement.attempt, 1);
assert.equal(firstRaceSettlement.counted, true);
const duplicateRaceSettlement = settleGenerationAttemptBeforeStart(generationRaceState, phasedMission);
assert.equal(duplicateRaceSettlement.attempt, 1);
assert.equal(duplicateRaceSettlement.counted, false);
generationRaceState.agent.runId = 'race_attempt_2';
const finalRaceSettlement = settleGenerationAttemptBeforeStart(generationRaceState, phasedMission);
assert.equal(finalRaceSettlement.blocked, true);
assert.equal(finalRaceSettlement.attempt, 2);
assert.equal(generationRaceState.iterationStats.loopStatus, 'needs_human');
assert.equal(generationRaceState.runtimeEvents.filter((event) => event.type === 'candidate.generation_attempt_failed').length, 2);
assert.equal(generationRaceState.runtimeEvents.filter((event) => event.type === 'loop.needs_human').length, 1);
const phasedCorrectnessFailed = makeState({ missions: [phasedMission], objective: { mode: 'maximize' }, iterationStats: { ...makeState().iterationStats, currentRoundCorrectnessAttempts: 4, totalCorrectnessAttempts: 4, correctnessEstablished: false } });
assert.equal(detectLoopGuard(phasedCorrectnessFailed), 'correctness_failed');
const phasedFailureResult = await advanceIteration(phasedCorrectnessFailed, {});
assert.equal(phasedFailureResult.action, 'failed_correctness');
assert.equal(phasedFailureResult.state.iterationStats.loopStatus, 'failed');
assert.equal(phasedFailureResult.state.agent.phase, 'Correctness Failed');
const phasedPerformanceComplete = makeState({ missions: [phasedMission], objective: { mode: 'maximize' }, iterationStats: { ...makeState().iterationStats, correctnessAttempts: 1, correctnessEstablished: true, performanceRounds: 3 }, currentBest: { candidateId: 'candidate-02', value: '50 us' } });
assert.equal(detectLoopGuard(phasedPerformanceComplete), 'fixed_rounds_complete');
const phasedCompleteResult = await advanceIteration(phasedPerformanceComplete, {});
assert.equal(phasedCompleteResult.action, 'completed_fixed_rounds');
assert.match(phasedCompleteResult.state.agent.phase, /三轮性能优化完成/);

const phasedInitialCorrect = makeState({
  missions: [phasedMission],
  stage: 'evidence',
  baseline: { status: 'complete' },
  agent: { status: 'completed', runId: 'suite_initial' },
  benchmark: { status: 'complete', result: { benchmark: [{ correctness: { passed: true } }] } },
  decisionReview: { status: 'resolved', recommendation: 'adopt', resolution: { outcome: 'adopt' } },
});
const phasedInitialCounted = await advanceIteration(phasedInitialCorrect, {});
assert.equal(phasedInitialCounted.action, 'round_counted');
assert.equal(phasedInitialCounted.state.iterationStats.correctnessEstablished, true);
assert.equal(phasedInitialCounted.state.iterationStats.round, 1);
assert.equal(phasedInitialCounted.state.iterationStats.performanceRounds, 1, 'the first correctness-passed benchmark is performance round 1');
const phasedCorrectnessRetry = {
  ...phasedInitialCounted.state,
  stage: 'diagnosis',
  agent: { status: 'completed', runId: 'suite_retry_1' },
  benchmark: { status: 'failed', lastServiceError: { code: 'LOCAL_C500_RUNNER_FAILED', message: 'correctness failed on case mqa_s2' } },
  decisionReview: { status: 'resolved', recommendation: 'reject', resolution: { outcome: 'reject' } },
};
const phasedRetryCounted = await advanceIteration(phasedCorrectnessRetry, {});
assert.equal(phasedRetryCounted.action, 'correctness_attempt_counted');
assert.equal(phasedRetryCounted.state.iterationStats.round, 1, 'correctness failure stays inside active round 2');
assert.equal(phasedRetryCounted.state.iterationStats.performanceRounds, 1, 'correctness failure cannot consume a performance round');
assert.equal(phasedRetryCounted.state.iterationStats.currentRoundCorrectnessAttempts, 1);
let repairGoal = '';
const phasedRetryResumed = await advanceIteration(structuredClone(phasedRetryCounted.state), {
  startMainRound: async ({ state, goal }) => {
    repairGoal = goal;
    state.agent = { status: 'running', runId: 'suite_retry_2' };
    return state;
  },
});
assert.equal(phasedRetryResumed.action, 'resumed_agent');
assert.equal(phasedRetryResumed.state.iterationStats.round, 1, 'starting a repair Agent must not increment the completed round count');
assert.match(repairGoal, /Candidate 2 第 1 次 correctness 未通过/);
assert.match(repairGoal, /仍属于 Round 2/);
const phasedOptimization = {
  ...phasedRetryCounted.state,
  stage: 'evidence',
  agent: { status: 'completed', runId: 'suite_opt_1' },
  benchmark: { status: 'complete', result: { benchmark: [{ correctness: { passed: true } }] } },
  decisionReview: { status: 'resolved', recommendation: 'reference', resolution: { outcome: 'reject' } },
};
const phasedOptimizationCounted = await advanceIteration(phasedOptimization, {});
assert.equal(phasedOptimizationCounted.action, 'round_counted');
assert.equal(phasedOptimizationCounted.state.iterationStats.round, 2);
assert.equal(phasedOptimizationCounted.state.iterationStats.performanceRounds, 2, 'a correctness-passed completed benchmark consumes round 2 even when discarded');
assert.equal(phasedOptimizationCounted.state.iterationStats.currentRoundCorrectnessAttempts, 0);

let startResearchCalls = 0;
let startMainRoundCalls = 0;
let cancelResearchCalls = 0;
let startBaselineCalls = 0;
let lastResearchSynchronous = null;
let lastResearchRunPhase = null;
let sourceCount = 0;
const resetCounters = () => { startResearchCalls = 0; startMainRoundCalls = 0; cancelResearchCalls = 0; startBaselineCalls = 0; lastResearchSynchronous = null; lastResearchRunPhase = null; sourceCount = 0; };
const deps = {
  startResearch: async ({ state, mission, direction, workspace, synchronous, runPhase }) => { startResearchCalls += 1; lastResearchSynchronous = synchronous; lastResearchRunPhase = runPhase; state.researchAgent = { ...state.researchAgent, status: 'running', runId: runPhase === 'synthesize' ? 'codex_research_syn' : 'codex_research_1', runtimeKind: 'codex-cli', direction, researchDir: workspace, startedAt: new Date().toISOString(), budgetMs: runPhase === 'synthesize' ? 4 * 60 * 1000 : 30 * 60 * 1000, notes: [], synchronous: Boolean(synchronous), runPhase, acquireRunId: runPhase === 'synthesize' ? (state.researchAgent?.acquireRunId || 'codex_research_1') : 'codex_research_1', synthesizeRunId: runPhase === 'synthesize' ? 'codex_research_syn' : null, sourceRoot: state.researchAgent?.sourceRoot || null }; return state; },
  cancelResearch: async ({ state, runId }) => { cancelResearchCalls += 1; state.researchAgent = { ...state.researchAgent, status: 'cancel_requested' }; return { state }; },
  startMainRound: async ({ state, goal }) => { startMainRoundCalls += 1; state.agent = { status: 'running', runId: 'codex_MAIN' }; state.iterationStats = { ...state.iterationStats, round: (state.iterationStats.round || 0) + 1 }; return state; },
  startBaseline: async ({ state }) => { startBaselineCalls += 1; state.baseline = { ...(state.baseline || {}), required: true, status: 'running' }; state.benchmark = { ...(state.benchmark || {}), status: 'running', purpose: 'baseline' }; return state; },
  researchDirForMission: () => '/tmp/research',
  countSources: async () => ({ count: sourceCount }),
};

// paused / completed 短路
assert.equal((await advanceIteration(makeState({ missionPaused: true }), deps)).action, 'paused');
assert.equal((await advanceIteration(makeState({ stage: 'published', knowledgeMaintenance: { status: 'completed' } }), deps)).action, 'completed');

// 综合阶段预算超时 → cancel + research_timeout（projectState 后续收敛产笔记）
resetCounters();
let timeout = await advanceIteration(makeState({ researchAgent: { status: 'running', runPhase: 'synthesize', runId: 'codex_research_1', startedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(), budgetMs: 20 * 60 * 1000 } }), deps);
assert.equal(timeout.action, 'research_timeout');
assert.equal(cancelResearchCalls, 1);

// 同步研究员（停滞升级）运行中 → 主循环串行等待
resetCounters();
let syncWait = await advanceIteration(makeState({ researchAgent: { status: 'running', synchronous: true, runId: 'codex_research_1', startedAt: new Date().toISOString(), budgetMs: 20 * 60 * 1000 } }), deps);
assert.equal(syncWait.action, 'wait_research');
assert.equal(startResearchCalls, 0);
assert.equal(startMainRoundCalls, 0);

// 异步研究员（操作员触发）运行中 → 主循环不阻塞（放行到 round 计数/停滞检测等）
resetCounters();
let asyncRun = await advanceIteration(makeState({ researchAgent: { status: 'running', synchronous: false, runId: 'codex_research_1', startedAt: new Date().toISOString(), budgetMs: 20 * 60 * 1000 } }), deps);
assert.notEqual(asyncRun.action, 'wait_research');
assert.equal(asyncRun.action, 'none', 'async research must not stall the main loop');

// Agent 识别硬基线缺失 → 自动提交 baseline，而不是停在 diagnosis
resetCounters();
const baselineAuto = await advanceIteration(makeState({
  stage: 'diagnosis',
  agent: {
    status: 'completed',
    result: {
      summary: '缺少同 runner 同 shape baseline',
      nextAction: { title: '先物化并排队测试权威单文件基线', reason: '需要 baseline run.py 和 runner 测量' },
    },
  },
  baseline: { required: true, status: 'missing' },
}), deps);
assert.equal(baselineAuto.action, 'baseline_started');
assert.equal(startBaselineCalls, 1);
assert.equal(baselineAuto.state.baseline.status, 'running');

// 研究员终态 → 价值闸 → research_injected（addresses_failure → inject）
resetCounters();
const gatedState = makeState({
  researchAgent: { status: 'completed', runId: 'codex_research_1', runtimeKind: 'codex-cli' },
  researchNotes: [{ id: 'note_codex_research_1', runId: 'codex_research_1', direction: '调研 async dispatch', summary: 'async dispatch 导致 correctness boundary mismatch', findings: [], suggestedDirections: [], sources: [] }],
  failureRecords: [{ id: 'fail.1', title: 'async dispatch', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: '数值偏差' }],
});
let gated = await advanceIteration(gatedState, deps);
assert.equal(gated.action, 'research_injected');
assert.equal(gated.state.iterationStats.lastResearchRunId, 'codex_research_1');
assert.ok(gated.state.iterationStats.pendingInjection);
assert.equal(gated.state.researchAgent.injected, true);
// 幂等：同态再次调用不再重复价值闸（lastResearchRunId 已记）
gated = await advanceIteration(gated.state, deps);
assert.equal(gated.state.iterationStats.pendingInjection === null || gated.action !== 'research_injected', true);

// pendingInjection → 自动续跑（startMainRound 一次，注入简报）
resetCounters();
const resumeState = makeState({
  iterationStats: { lastResearchRunId: 'codex_research_1', researchRounds: 1, pendingInjection: { noteId: 'n1', briefing: '研究员简报', value: 'high' }, consecutiveNoAdopt: 0 },
});
let resumed = await advanceIteration(resumeState, deps);
assert.equal(resumed.action, 'resumed_agent');
assert.equal(startMainRoundCalls, 1);
assert.equal(resumed.state.iterationStats.pendingInjection, null);

// 轮次结算：runHistory[0] 新 → round_counted，计数 increment
resetCounters();
const roundState = makeState({
  runHistory: [{ runId: 'run_1', stage: 'diagnosis', decisionReview: { resolution: null } }],
});
let counted = await advanceIteration(roundState, deps);
assert.equal(counted.action, 'round_counted');
assert.equal(counted.state.iterationStats.consecutiveNoAdopt, 1);
// 幂等：lastCountedRunId 已记，不再重复计数
counted = await advanceIteration(counted.state, deps);
assert.equal(counted.action !== 'round_counted', true);

// 当前已完成 evidence 轮也要结算；下一次调用自动续跑下一主轮
resetCounters();
const terminalEvidence = makeState({
  stage: 'evidence',
  agent: { status: 'completed', runId: 'codex_done', goal: '优化 C500 延迟' },
  benchmark: { status: 'complete', result: { latencyUs: 55 } },
  decisionReview: { status: 'resolved', recommendation: 'reference', resolution: { outcome: 'reference' }, resolvedAt: new Date().toISOString() },
});
let terminalCounted = await advanceIteration(terminalEvidence, deps);
assert.equal(terminalCounted.action, 'round_counted');
assert.equal(terminalCounted.state.iterationStats.lastCountedRunId, 'codex_done');
assert.equal(terminalCounted.state.iterationStats.consecutiveNoAdopt, 1);
let terminalResumed = await advanceIteration(terminalCounted.state, deps);
assert.equal(terminalResumed.action, 'resumed_agent');
assert.equal(startMainRoundCalls, 1);

// 诊断轮无候选：计入未采纳轮次；下一 tick 自动再开主轮
resetCounters();
const noCandidateRound = makeState({
  stage: 'diagnosis',
  agent: { status: 'completed', runId: 'codex_no_candidate', goal: '优化 paged attention' },
  baseline: { required: true, status: 'complete' },
  candidateEvaluations: [],
});
let noCandidateCounted = await advanceIteration(noCandidateRound, deps);
assert.equal(noCandidateCounted.action, 'round_counted');
assert.equal(noCandidateCounted.state.iterationStats.consecutiveNoAdopt, 1);
let noCandidateResumed = await advanceIteration(noCandidateCounted.state, deps);
assert.equal(noCandidateResumed.action, 'resumed_agent');
assert.equal(startMainRoundCalls, 1);

// 停滞升级：连续 3 轮无采纳 + 主线程空闲 → startResearch
resetCounters();
const stallState = makeState({
  runHistory: [{ runId: 'run_1', stage: 'diagnosis', decisionReview: { resolution: null } }],
  iterationStats: { consecutiveNoAdopt: 3, lastCountedRunId: 'run_1', lastResearchRunId: null, researchRounds: 0, pendingInjection: null },
});
let escalated = await advanceIteration(stallState, deps);
assert.equal(escalated.action, 'research_escalated');
assert.equal(startResearchCalls, 1);
assert.equal(lastResearchSynchronous, true, 'stagnation escalation should be synchronous (serial wait)');
assert.match(escalated.state.researchAgent.direction, /C500/);

// 同步研究采集阶段无资料/无笔记：计为一次研究尝试，清空停滞计数，下一 tick 应继续主候选循环
resetCounters();
const noMaterialResearch = makeState({
  stage: 'diagnosis',
  agent: { status: 'completed', runId: 'codex_failed_candidate', goal: '优化 paged attention' },
  baseline: { required: true, status: 'complete' },
  benchmark: { status: 'failed', purpose: 'candidate', logs: [{ message: 'runner timeout' }] },
  decisionReview: { status: 'resolved', recommendation: 'reject', resolution: { outcome: 'reject' } },
  failureRecords: [{ id: 'fail.timeout', title: 'runner timeout', decisionReason: 'runner timeout' }],
  candidateEvaluations: [{ id: 'candidate-01', classification: 'rejected' }],
  researchAgent: { status: 'cancelled', runPhase: 'acquire', acquireHandled: true, runId: 'research_no_material', synchronous: true },
  researchNotes: [],
  iterationStats: { round: 3, consecutiveNoAdopt: 3, lastCountedRunId: 'codex_failed_candidate', lastResearchRunId: null, researchRounds: 0, pendingInjection: null },
});
const noMaterialRecorded = await advanceIteration(noMaterialResearch, deps);
assert.equal(noMaterialRecorded.action, 'research_noted');
assert.equal(noMaterialRecorded.state.iterationStats.consecutiveNoAdopt, 0);
const noMaterialResumed = await advanceIteration(noMaterialRecorded.state, deps);
assert.equal(noMaterialResumed.action, 'resumed_agent');
assert.equal(startMainRoundCalls, 1);

// 主线程活跃 → wait_main（候选/验证/证据期间不自动开新轮）
resetCounters();
const activeState = makeState({ agent: { status: 'running', runId: 'codex_MAIN' } });
assert.equal((await advanceIteration(activeState, deps)).action, 'wait_main');
assert.equal(startMainRoundCalls, 0);

// 研究员不可用（startResearch 不产生 runId，如非 codex-cli 模式）→ 不升级、不发误导审计
resetCounters();
const noopEscalation = await advanceIteration(makeState({
  runHistory: [{ runId: 'run_1', stage: 'diagnosis', decisionReview: { resolution: null } }],
  iterationStats: { consecutiveNoAdopt: 3, lastCountedRunId: 'run_1', lastResearchRunId: null, researchRounds: 0, pendingInjection: null },
}), { ...deps, startResearch: async ({ state }) => state });
assert.equal(noopEscalation.action, 'none');
assert.equal(startResearchCalls, 0);

// ---- 全局兜底：防无休止兜圈 ----
// max_rounds
assert.equal(detectLoopGuard({ iterationStats: { round: MAX_ROUNDS - 1 } }), null);
let guarded = await advanceIteration(makeState({ iterationStats: { round: MAX_ROUNDS, lastCountedRunId: 'run_1', consecutiveNoAdopt: 0 } }), deps);
assert.equal(guarded.action, 'needs_human');
assert.equal(guarded.state.iterationStats.loopStatusReason, 'max_rounds');
// max_research
guarded = await advanceIteration(makeState({ iterationStats: { researchRounds: MAX_RESEARCH_ESCALATIONS, lastResearchRunId: 'n1', consecutiveNoAdopt: 0 } }), deps);
assert.notEqual(guarded.action, 'needs_human', 'max_research no longer stops the main loop');
assert.equal(detectLoopGuard({ iterationStats: { researchRounds: MAX_RESEARCH_ESCALATIONS } }), null);
assert.equal(isResearchExhausted(guarded.state), true);
// explicit mission budget replaces fixed max_research/max_rounds guards
guarded = await advanceIteration(makeState({
  missionBudgetMs: 5 * 60 * 60 * 1000,
  missionBudgetStartedAt: new Date().toISOString(),
  iterationStats: { round: MAX_ROUNDS + 1, researchRounds: MAX_RESEARCH_ESCALATIONS, lastResearchRunId: 'n1', consecutiveNoAdopt: 0 },
}), deps);
assert.notEqual(guarded.action, 'needs_human');
// total_budget（loopStartedAt 在预算时长之前）
guarded = await advanceIteration(makeState({ iterationStats: { round: 1, loopStartedAt: new Date(Date.now() - TOTAL_BUDGET_MS - 1000).toISOString(), lastCountedRunId: 'run_1', consecutiveNoAdopt: 0 } }), deps);
assert.equal(guarded.action, 'needs_human');
assert.equal(guarded.state.iterationStats.loopStatusReason, 'total_budget');
guarded = await advanceIteration(makeState({
  missionBudgetMs: 1,
  missionBudgetStartedAt: new Date(Date.now() - 1000).toISOString(),
  iterationStats: { round: 1, loopStartedAt: new Date().toISOString(), lastCountedRunId: 'run_1', consecutiveNoAdopt: 0 },
}), deps);
assert.equal(guarded.action, 'needs_human');
assert.equal(guarded.state.iterationStats.loopStatusReason, 'total_budget');
guarded = await advanceIteration(makeState({
  objective: { mode: 'maximize' },
  missions: [{ id: 'MIS', goal: '目标不设上限，加速比越高越好', metric: 'latency_p50', objective: { mode: 'maximize' } }],
  missionBudgetMs: 1,
  missionBudgetStartedAt: new Date(Date.now() - 1000).toISOString(),
  iterationStats: { round: 1, loopStartedAt: new Date().toISOString(), lastCountedRunId: 'run_1', consecutiveNoAdopt: 0 },
  currentBest: { candidateId: 'best', value: '42 us' },
}), deps);
assert.equal(guarded.action, 'completed_budget');
assert.equal(guarded.state.stage, 'published');
assert.equal(guarded.state.iterationStats.loopStatus, 'completed');
// needs_human 短路：不再自动升级研究员
resetCounters();
guarded = await advanceIteration(makeState({
  runHistory: [{ runId: 'run_1', stage: 'diagnosis' }],
  iterationStats: { researchRounds: MAX_RESEARCH_ESCALATIONS, lastResearchRunId: 'n1', consecutiveNoAdopt: 3, lastCountedRunId: 'run_1' },
}), deps);
assert.notEqual(guarded.action, 'needs_human');
assert.equal(startResearchCalls, 0);
assert.equal(guarded.state.runtimeEvents.filter((event) => event.type === 'research.exhausted').length, 1);
// 手动接管重置 loopStatus 后循环恢复
guarded = await advanceIteration(makeState({ iterationStats: { loopStatus: 'running', loopStatusReason: null, round: 0, consecutiveNoAdopt: 0 } }), deps);
assert.equal(guarded.action !== 'needs_human', true);

// maximize 平台期：研究耗尽 + 连续无提升达到窗口 → 完成并保留 current best
const plateauState = makeState({
  objective: { mode: 'maximize' },
  missions: [{ id: 'MIS', goal: '不设上限，加速比越高越好', metric: 'latency_p50', objective: { mode: 'maximize' } }],
  iterationStats: { researchRounds: MAX_RESEARCH_ESCALATIONS, researchExhausted: true, consecutiveNoAdopt: PLATEAU_NO_IMPROVE_ROUNDS, lastCountedRunId: 'run_1' },
  currentBest: { candidateId: 'best', value: '40 us' },
});
assert.equal(detectPlateau(plateauState).plateau, true);
guarded = await advanceIteration(plateauState, deps);
assert.equal(guarded.action, 'completed_plateau');
assert.equal(guarded.state.stage, 'published');

// ---- 方向视野检测：死磕识别（收敛守卫） ----
// 同方向 + 同错误码（重复无进展）→ 死磕
const tunnel = detectTunnelVision({ failureRecords: [
  { id: 'f1', title: 'Adaptive tile shape', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile boundary' },
  { id: 'f2', title: 'Tile shape retry', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile boundary again' },
  { id: 'f3', title: 'Shape tile again', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile boundary persists' },
] });
assert.equal(tunnel.tunnelVision, true);
assert.match(tunnel.reason, /shape 特化/);
// 同方向但错误码在变（有信息地演进）→ 收敛守卫放行，不判死磕（方向值得多试）
const converging = detectTunnelVision({ failureRecords: [
  { id: 'f1', title: 'Async dispatch plan', failure: { code: 'CODEX_AUTH_FAILED' }, decisionReason: 'auth' },
  { id: 'f2', title: 'Async dispatch cache', failure: { code: 'CODEX_RATE_LIMITED' }, decisionReason: 'rate' },
  { id: 'f3', title: 'Async dispatch mirror', failure: { code: 'CODEX_NETWORK_FAILED' }, decisionReason: 'network' },
] });
assert.equal(converging.tunnelVision, false);
// 不同方向 → 不判
const diverse = detectTunnelVision({ failureRecords: [
  { id: 'f1', title: 'Tile optimization', failure: { code: 'X1' } },
  { id: 'f2', title: 'Memory layout', failure: { code: 'X2' } },
  { id: 'f3', title: 'Launch overhead', failure: { code: 'X3' } },
] });
assert.equal(diverse.tunnelVision, false);

// ---- 中文分词（B1）：价值闸与死磕检测对中文有效 ----
const zhNovel = evaluateResearchValue({
  research: { summary: '研究员分析了天数平台的显存带宽与访存模式，发现连续访存可降低 bank conflict', findings: ['连续访存减少 bank 冲突'], suggestedDirections: ['尝试 swizzle 布局'], sources: [{ title: '平台文档', url: 'https://x.invalid' }] },
  knowledge: {},
});
assert.equal(zhNovel.inject, true, '中文研究笔记应被识别为 novel（≥5 token）');
assert.equal(zhNovel.value, 'medium');

const zhAddressesFailure = evaluateResearchValue({
  research: { summary: '迁移到天数平台时发生 shape 边界不一致，需检查 tile 划分', findings: [] },
  knowledge: { failureRecords: [{ id: 'fail.zh', title: '天数平台 shape 边界失败', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile 划分' }] },
});
assert.equal(zhAddressesFailure.inject, true, '中文调研命中已知失败 → 注入');
assert.equal(zhAddressesFailure.value, 'high');

// 中文 + 同错误码重复 → 判死磕
const zhTunnel = detectTunnelVision({ failureRecords: [
  { id: 'zf1', title: '迁移天数 tile 边界失败', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile 划分' },
  { id: 'zf2', title: '天数 tile 边界再失败', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile 划分仍不对' },
  { id: 'zf3', title: 'tile 边界依然失败', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile 划分持续' },
] });
assert.equal(zhTunnel.tunnelVision, true, '中文同错误码 + 同方向族 → 判死磕');

// 中文但错误码在变（有信息地演进）→ 收敛守卫放行，不判死磕
const zhConverging = detectTunnelVision({ failureRecords: [
  { id: 'zc1', title: '迁移天数 认证失败', failure: { code: 'CODEX_AUTH_FAILED' } },
  { id: 'zc2', title: '迁移天数 限流失败', failure: { code: 'CODEX_RATE_LIMITED' } },
  { id: 'zc3', title: '迁移天数 网络失败', failure: { code: 'CODEX_NETWORK_FAILED' } },
] });
assert.equal(zhConverging.tunnelVision, false, '中文但错误码在变（有信息地演进）→ 收敛守卫放行');

// ---- 调研方向简报：已试方向 + 继续/换方向 + ROI 排序 ----
const visionDirection = selectResearchDirection({
  activeMissionId: 'MIS', missions: [{ id: 'MIS', goal: '降低 C500 延迟', hardware: ['C500'], metric: 'latency_p50' }],
  candidateEvaluations: [{ id: 'c1', title: 'Adaptive tile', classification: 'reference', decisionReason: '边界失败' }],
  failureRecords: [{ id: 'fail.1', title: 'Tile 边界失败', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' } }],
});
assert.match(visionDirection, /已尝试方向/);
assert.match(visionDirection, /最容易获取收益/);
assert.match(visionDirection, /继续当前方向，还是换方向/);

// ---- 隧道视野升级：同方向重复失败 + 主线程空闲 → 异步（并行）触发研究员 ----
resetCounters();
const visionState = makeState({
  runHistory: [],
  failureRecords: [
    { id: 'f1', title: 'Adaptive tile shape', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile boundary' },
    { id: 'f2', title: 'Tile shape retry', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile boundary again' },
    { id: 'f3', title: 'Shape tile again', failure: { code: 'CORRECTNESS_BOUNDARY_MISMATCH' }, decisionReason: 'tile boundary persists' },
  ],
  iterationStats: { consecutiveNoAdopt: 0, lastCountedRunId: null, lastResearchRunId: null, researchRounds: 0, pendingInjection: null },
});
const visionEscalated = await advanceIteration(visionState, deps);
assert.equal(visionEscalated.action, 'research_escalated');
assert.equal(lastResearchSynchronous, false, 'tunnel vision escalation should be async (parallel review, main thread continues)');
assert.match(visionEscalated.state.researchAgent.direction, /最容易获取收益/);

// ---- 两阶段研究员：采集终态 → 注册资料 + 启动综合阶段 ----
// 采集完成且 sourceRoot 有资料 → 启动综合阶段（runPhase=synthesize）
resetCounters();
const acquireDoneState = makeState({
  researchAgent: { status: 'completed', runPhase: 'acquire', runId: 'codex_research_1', sourceRoot: '/tmp/sources', acquireRunId: 'codex_research_1', synthesizeRunId: null, acquireHandled: false, researchDir: '/tmp/research' },
});
const depsWithRegister = { ...deps, registerSources: async () => ({ count: 7, references: [] }) };
let syn = await advanceIteration(acquireDoneState, depsWithRegister);
assert.equal(syn.action, 'research_synthesizing');
assert.equal(lastResearchRunPhase, 'synthesize');
assert.equal(syn.state.researchAgent.synthesizeRunId, 'codex_research_syn');
assert.equal(syn.state.researchAgent.acquireHandled, true);
// 采集完成但无资料 → 不启动综合，研究结束
resetCounters();
const acquireEmptyState = makeState({
  researchAgent: { status: 'completed', runPhase: 'acquire', runId: 'codex_research_1', sourceRoot: '/tmp/sources', acquireRunId: 'codex_research_1', synthesizeRunId: null, acquireHandled: false },
});
let empty = await advanceIteration(acquireEmptyState, { ...deps, registerSources: async () => ({ count: 0 }) });
assert.equal(empty.action, 'research_no_material');
assert.equal(startResearchCalls, 0);
// 灵活来源策略：本地和远程均无资料，仍进入综合阶段生成 Mission 语义 baseline
resetCounters();
const flexibleMission = { id: 'MIS', goal: '优化 C500 MLA paged attention', hardware: ['C500'], metric: 'latency_p50', sourcePolicy: { strictZeroSource: true, allowSemanticFallback: true } };
const flexibleEmptyState = makeState({
  missions: [flexibleMission],
  researchAgent: { status: 'failed', runPhase: 'acquire', runId: 'codex_research_fallback', sourceRoot: '/tmp/sources', acquireRunId: 'codex_research_fallback', synthesizeRunId: null, acquireHandled: false, researchDir: '/tmp/research', error: { code: 'NETWORK_FAILED', message: 'remote unavailable' } },
});
const semanticSynthesis = await advanceIteration(flexibleEmptyState, { ...deps, registerSources: async () => ({ count: 0 }) });
assert.equal(semanticSynthesis.action, 'research_synthesizing');
assert.equal(lastResearchRunPhase, 'synthesize');
assert.equal(semanticSynthesis.state.researchAgent.synthesizeRunId, 'codex_research_syn');
// 无 sourceRoot 的 mission（单阶段）：采集终态不触发转移（projectState 已直接产笔记）
resetCounters();
const singlePhaseState = makeState({
  researchAgent: { status: 'completed', runPhase: 'acquire', runId: 'codex_research_1', sourceRoot: null, synthesizeRunId: null, researchDir: '/tmp/research' },
});
let single = await advanceIteration(singlePhaseState, deps);
assert.equal(single.action !== 'research_synthesizing', true);
assert.equal(startResearchCalls, 0);

// 资料停滞：sources/ 不再增长（120s）→ 取消采集，进入转综合路径（事件在涨但资料不涨不算进展）
resetCounters();
sourceCount = 3;
const materialPlateauState = makeState({
  researchAgent: { status: 'running', runPhase: 'acquire', runId: 'codex_research_1', sourceRoot: '/tmp/sources', startedAt: new Date().toISOString(), budgetMs: 30 * 60 * 1000, lastEventAt: Date.now(), eventCount: 30, materialCount: 3, materialLastGrownAt: new Date(Date.now() - 130_000).toISOString() },
});
let materialStalled = await advanceIteration(materialPlateauState, deps);
assert.equal(materialStalled.action, 'research_synthesizing', 'material plateau should transition directly to synthesize');
assert.equal(cancelResearchCalls, 1);
assert.equal(lastResearchRunPhase, 'synthesize');
// 资料还在增长（countSources 变大）→ 不取消，继续采集
resetCounters();
sourceCount = 5;
const materialGrowingState = makeState({
  researchAgent: { status: 'running', runPhase: 'acquire', runId: 'codex_research_1', sourceRoot: '/tmp/sources', startedAt: new Date().toISOString(), budgetMs: 30 * 60 * 1000, lastEventAt: Date.now(), eventCount: 30, materialCount: 3, materialLastGrownAt: new Date(Date.now() - 130_000).toISOString() },
});
let growing = await advanceIteration(materialGrowingState, deps);
assert.equal(growing.action !== 'research_timeout', true, 'material still growing must not cancel');
assert.equal(cancelResearchCalls, 0);

console.log('[loop] researcher iteration loop policy passed');
