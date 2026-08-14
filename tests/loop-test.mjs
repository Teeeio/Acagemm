import assert from 'node:assert/strict';
import {
  advanceIteration,
  detectStagnation,
  decideResearchTrigger,
  selectResearchDirection,
  buildResearchBriefing,
  evaluateResearchValue,
  detectLoopGuard,
  detectTunnelVision,
  STAGNATION_WINDOW,
  MAX_ROUNDS,
  MAX_RESEARCH_ESCALATIONS,
  TOTAL_BUDGET_MS,
} from '../client-runtime/iteration-loop.mjs';

// ---- 纯函数：停滞判定（尺子 B 采纳尺） ----
assert.equal(STAGNATION_WINDOW, 3);
assert.deepEqual(detectStagnation({ iterationStats: { consecutiveNoAdopt: 2, lastCountedRunId: 'run_1' } }).stagnated, false);
assert.deepEqual(detectStagnation({ iterationStats: { consecutiveNoAdopt: 3, lastCountedRunId: 'run_1' } }).stagnated, true);
// 未计过数时从 runHistory 兜底推导
assert.deepEqual(detectStagnation({ iterationStats: {}, runHistory: [{ runId: 'a', stage: 'diagnosis' }, { runId: 'b', stage: 'diagnosis' }, { runId: 'c', stage: 'candidate' }] }).consecutiveNoAdopt, 3);
// adopted（decisionReview.resolution.outcome === 'adopt'）不计为停滞
assert.deepEqual(detectStagnation({ iterationStats: {}, runHistory: [{ runId: 'a', stage: 'evidence', decisionReview: { resolution: { outcome: 'adopt' } } }, { runId: 'b', stage: 'diagnosis' }, { runId: 'c', stage: 'diagnosis' }] }).consecutiveNoAdopt, 2);

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

let startResearchCalls = 0;
let startMainRoundCalls = 0;
let cancelResearchCalls = 0;
let lastResearchSynchronous = null;
let lastResearchRunPhase = null;
const resetCounters = () => { startResearchCalls = 0; startMainRoundCalls = 0; cancelResearchCalls = 0; lastResearchSynchronous = null; lastResearchRunPhase = null; };
const deps = {
  startResearch: async ({ state, mission, direction, workspace, synchronous, runPhase }) => { startResearchCalls += 1; lastResearchSynchronous = synchronous; lastResearchRunPhase = runPhase; state.researchAgent = { ...state.researchAgent, status: 'running', runId: runPhase === 'synthesize' ? 'codex_research_syn' : 'codex_research_1', runtimeKind: 'codex-cli', direction, researchDir: workspace, startedAt: new Date().toISOString(), budgetMs: runPhase === 'synthesize' ? 4 * 60 * 1000 : 30 * 60 * 1000, notes: [], synchronous: Boolean(synchronous), runPhase, acquireRunId: runPhase === 'synthesize' ? (state.researchAgent?.acquireRunId || 'codex_research_1') : 'codex_research_1', synthesizeRunId: runPhase === 'synthesize' ? 'codex_research_syn' : null, sourceRoot: state.researchAgent?.sourceRoot || null }; return state; },
  cancelResearch: async ({ state, runId }) => { cancelResearchCalls += 1; state.researchAgent = { ...state.researchAgent, status: 'cancel_requested' }; return { state }; },
  startMainRound: async ({ state, goal }) => { startMainRoundCalls += 1; state.agent = { status: 'running', runId: 'codex_MAIN' }; state.iterationStats = { ...state.iterationStats, round: (state.iterationStats.round || 0) + 1 }; return state; },
  researchDirForMission: () => '/tmp/research',
};

// paused / completed 短路
assert.equal((await advanceIteration(makeState({ missionPaused: true }), deps)).action, 'paused');
assert.equal((await advanceIteration(makeState({ stage: 'published', knowledgeMaintenance: { status: 'completed' } }), deps)).action, 'completed');

// 研究员预算超时 → cancel + research_timeout
resetCounters();
let timeout = await advanceIteration(makeState({ researchAgent: { status: 'running', runId: 'codex_research_1', startedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(), budgetMs: 20 * 60 * 1000 } }), deps);
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
assert.equal(guarded.action, 'needs_human');
assert.equal(guarded.state.iterationStats.loopStatusReason, 'max_research');
// total_budget（loopStartedAt 在预算时长之前）
guarded = await advanceIteration(makeState({ iterationStats: { round: 1, loopStartedAt: new Date(Date.now() - TOTAL_BUDGET_MS - 1000).toISOString(), lastCountedRunId: 'run_1', consecutiveNoAdopt: 0 } }), deps);
assert.equal(guarded.action, 'needs_human');
assert.equal(guarded.state.iterationStats.loopStatusReason, 'total_budget');
// needs_human 短路：不再自动升级研究员
resetCounters();
guarded = await advanceIteration(makeState({
  runHistory: [{ runId: 'run_1', stage: 'diagnosis' }],
  iterationStats: { researchRounds: MAX_RESEARCH_ESCALATIONS, lastResearchRunId: 'n1', consecutiveNoAdopt: 3, lastCountedRunId: 'run_1' },
}), deps);
assert.equal(guarded.action, 'needs_human');
assert.equal(startResearchCalls, 0);
// 幂等：needs_human 只发一次 loop.needs_human 事件
guarded = await advanceIteration(guarded.state, deps);
assert.equal(guarded.state.runtimeEvents.filter((event) => event.type === 'loop.needs_human').length, 1);
// 手动接管重置 loopStatus 后循环恢复
guarded = await advanceIteration(makeState({ iterationStats: { loopStatus: 'running', loopStatusReason: null, round: 0, consecutiveNoAdopt: 0 } }), deps);
assert.equal(guarded.action !== 'needs_human', true);

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
// 无 sourceRoot 的 mission（单阶段）：采集终态不触发转移（projectState 已直接产笔记）
resetCounters();
const singlePhaseState = makeState({
  researchAgent: { status: 'completed', runPhase: 'acquire', runId: 'codex_research_1', sourceRoot: null, synthesizeRunId: null, researchDir: '/tmp/research' },
});
let single = await advanceIteration(singlePhaseState, deps);
assert.equal(single.action !== 'research_synthesizing', true);
assert.equal(startResearchCalls, 0);

console.log('[loop] researcher iteration loop policy passed');
