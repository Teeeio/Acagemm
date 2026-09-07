import assert from 'node:assert/strict';
import { detectLoopGuard, advanceIteration, ROUND_BUDGET_MS } from '../client-runtime/iteration-loop.mjs';
import { createRuntimeAdvanceService } from '../client-runtime/application/runtime-advance-service.mjs';
import { resourceReleaseBarrier } from '../client-runtime/cancellation-contract.mjs';
import { fixedOperatorProfiles } from '../client-runtime/fixed-operator-profiles.mjs';

const start = Date.parse('2026-01-01T00:00:00.000Z');
const makeState = () => ({
  activeMissionId: 'round-budget-mission', missions: [{ id: 'round-budget-mission', status: 'running', goal: 'bounded operator round' }],
  stage: 'diagnosis', missionPaused: false,
  agent: { status: 'idle', budgetMs: 600000 },
  researchAgent: { status: 'idle' }, baseline: { status: 'complete' }, benchmark: { status: 'idle' },
  iterationStats: { round: 0, loopStatus: 'running', roundBudget: {
    roundId: 'round-budget-mission:round:1', roundNumber: 1, startedAt: new Date(start).toISOString(),
    deadlineAt: new Date(start + ROUND_BUDGET_MS).toISOString(), budgetMs: ROUND_BUDGET_MS, status: 'active',
  } },
  runHistory: [], candidateEvaluations: [], runtimeEvents: [], auditEvents: [],
});
assert.equal(detectLoopGuard(makeState(), { nowMs: start + ROUND_BUDGET_MS }), 'round_budget',
  'the existing 15-minute round budget must apply at its exact deadline');
const { ensureRoundBudgetStarted, inspectRoundBudget, completeRoundBudget } = await import('../client-runtime/round-budget-contract.mjs');

const fresh = makeState();
fresh.iterationStats.roundBudget = null;
const began = ensureRoundBudgetStarted(fresh, { nowMs: start });
assert.equal(began.changed, true);
assert.equal(began.roundBudget.roundId, 'round-budget-mission:round:1');
assert.equal(began.roundBudget.deadlineAt, new Date(start + ROUND_BUDGET_MS).toISOString());
assert.equal(fresh.agent.budgetMs, 600000, 'the single Agent budget is unchanged');
const original = structuredClone(began.roundBudget);
fresh.iterationStats.currentRoundCorrectnessAttempts = 2;
fresh.iterationStats.currentRoundGenerationAttempts = 3;
fresh.agent.runId = 'correctness-retry-agent';
assert.equal(ensureRoundBudgetStarted(fresh, { nowMs: start + 400000 }).changed, false);
assert.deepEqual(fresh.iterationStats.roundBudget, original, 'same-round repairs/generation retries preserve the original clock');
assert.deepEqual(ensureRoundBudgetStarted(fresh, { nowMs: start + 400001, completedRoundId: original.roundId }).roundBudget, original,
  'even an exact completed-round token cannot renew a still-active clock');
assert.equal(fresh.iterationStats.currentRoundCorrectnessAttempts, 2);
assert.equal(fresh.iterationStats.currentRoundGenerationAttempts, 3);
assert.equal(inspectRoundBudget(fresh, { nowMs: start - 1000 }).elapsedMs, 0, 'a backward clock never creates negative duration');
assert.equal(detectLoopGuard(fresh, { nowMs: start + ROUND_BUDGET_MS - 1 }), null);
assert.equal(detectLoopGuard(fresh, { nowMs: start + ROUND_BUDGET_MS }), 'round_budget');
const queryBytes = JSON.stringify(fresh);
inspectRoundBudget(fresh, { nowMs: start + ROUND_BUDGET_MS + 1 });
assert.equal(JSON.stringify(fresh), queryBytes, 'budget inspection and guard are pure');
assert.throws(() => ensureRoundBudgetStarted(fresh, { nowMs: start + ROUND_BUDGET_MS }), error => error.code === 'ROUND_BUDGET_EXCEEDED');

for (const startedAt of [null, undefined]) {
  const legacy = makeState();
  legacy.iterationStats.roundBudget = startedAt;
  legacy.agent.startedAt = '2000-01-01T00:00:00.000Z';
  legacy.benchmark.startedAt = legacy.agent.startedAt;
  assert.equal(detectLoopGuard(legacy, { nowMs: start }), null, 'old Agent/test timestamps do not invent a round start');
  assert.equal(inspectRoundBudget(legacy, { nowMs: start }).status, 'untracked');
}
const paused = makeState();
paused.missionPaused = true;
assert.equal(inspectRoundBudget(paused, { nowMs: start + ROUND_BUDGET_MS }).expired, true, 'pause does not stop wall-clock accounting');
const pausedBytes = JSON.stringify(paused.iterationStats.roundBudget);
paused.missionPaused = false;
assert.equal(JSON.stringify(paused.iterationStats.roundBudget), pausedBytes);
assert.equal(detectLoopGuard(paused, { nowMs: start + ROUND_BUDGET_MS }), 'round_budget', 'resume cannot reset an expired round');

const settled = makeState();
assert.equal(completeRoundBudget(settled, { nowMs: start + 5000 }).changed, true);
assert.equal(completeRoundBudget(settled, { nowMs: start + 6000 }).changed, false);
settled.iterationStats.round = 1;
assert.throws(() => ensureRoundBudgetStarted(settled, { nowMs: start + 10000 }), { code: 'ROUND_BUDGET_ALREADY_COMPLETED' },
  'legacy counter advancement alone cannot grant a new clock to default ensure/replay');
assert.throws(() => ensureRoundBudgetStarted(settled, { nowMs: start + 10000, completedRoundId: 'wrong-round' }),
  { code: 'ROUND_BUDGET_ALREADY_COMPLETED' }, 'automatic new-round admission is bound to the exact settled budget');
const next = ensureRoundBudgetStarted(settled, { nowMs: start + 10000, completedRoundId: settled.iterationStats.roundBudget.roundId });
assert.equal(next.roundBudget.roundNumber, 2);
assert.equal(next.roundBudget.startedAt, new Date(start + 10000).toISOString());
assert.notEqual(next.roundBudget.roundId, original.roundId);

const manual = makeState();
manual.stage = 'published';
manual.knowledgeMaintenance = { status: 'completed' };
manual.missionBudgetStartedAt = new Date(start).toISOString();
manual.missionBudgetMs = 3600000;
manual.iterationStats.performanceRounds = 2;
manual.iterationStats.currentRoundCorrectnessAttempts = 3;
completeRoundBudget(manual, { nowMs: start + 5000 });
const manualStart = start + ROUND_BUDGET_MS + 1;
assert.throws(() => ensureRoundBudgetStarted(manual, { nowMs: manualStart }), { code: 'ROUND_BUDGET_ALREADY_COMPLETED' },
  'a completed budget is not general permission to create a new identity');
for (const unsettled of [
  { stage: 'diagnosis', knowledgeMaintenance: { status: 'completed' } },
  { stage: 'published', knowledgeMaintenance: { status: 'running' } },
]) {
  const notPublished = { ...structuredClone(manual), ...unsettled };
  assert.throws(() => ensureRoundBudgetStarted(notPublished, { nowMs: manualStart, allowSettledRestart: true }),
    { code: 'ROUND_BUDGET_ALREADY_COMPLETED' }, 'manual new-round permission requires completed publication');
}
const second = ensureRoundBudgetStarted(manual, { nowMs: manualStart, allowSettledRestart: true });
assert.equal(second.roundBudget.roundNumber, 2, 'settled manual rerun identity must advance even when evidence round remains zero');
const secondClock = structuredClone(second.roundBudget);
assert.equal(ensureRoundBudgetStarted(manual, { nowMs: manualStart + 100, allowSettledRestart: true }).changed, false,
  'the previous published snapshot cannot complete or replace the new active intent');
manual.missionPaused = true;
assert.deepEqual(ensureRoundBudgetStarted(manual, { nowMs: manualStart + 200, allowSettledRestart: true }).roundBudget, secondClock);
manual.missionPaused = false;
assert.deepEqual(ensureRoundBudgetStarted(manual, { nowMs: manualStart + 300 }).roundBudget, secondClock,
  'resume and prepare preserve a budget identity ahead of legacy evidence accounting');
const lateActive = structuredClone(manual);
for (const status of ['active', 'expired']) {
  lateActive.iterationStats.roundBudget.status = status;
  const lateBytes = JSON.stringify(lateActive);
  assert.throws(() => ensureRoundBudgetStarted(lateActive, { nowMs: manualStart + ROUND_BUDGET_MS, allowSettledRestart: true }),
    { code: 'ROUND_BUDGET_EXCEEDED' }, 'publication projection cannot renew an expired ' + status + ' clock');
  assert.throws(() => ensureRoundBudgetStarted(lateActive, { nowMs: manualStart + ROUND_BUDGET_MS, completedRoundId: secondClock.roundId }),
    { code: 'ROUND_BUDGET_EXCEEDED' }, 'an exact completed-round token cannot renew an expired ' + status + ' clock');
  assert.equal(JSON.stringify(lateActive), lateBytes);
}
completeRoundBudget(manual, { nowMs: manualStart + 400 });
assert.equal(ensureRoundBudgetStarted(manual, { nowMs: manualStart + 500, allowSettledRestart: true }).roundBudget.roundNumber, 3);
assert.equal(manual.iterationStats.round, 0, 'budget identity does not rewrite legacy round accounting');
assert.equal(manual.iterationStats.performanceRounds, 2);
assert.equal(manual.iterationStats.currentRoundCorrectnessAttempts, 3);
assert.equal(manual.missionBudgetStartedAt, new Date(start).toISOString());
assert.equal(manual.missionBudgetMs, 3600000, 'a manual new round never renews the total Mission budget');

for (const fixed of [false, true]) {
  for (const injection of [false, true]) {
    const continuation = makeState();
    if (fixed) continuation.missions[0].operatorProfile = structuredClone(fixedOperatorProfiles.find(profile => profile.iterationPolicy));
    continuation.stage = 'published';
    continuation.knowledgeMaintenance = { status: 'completed' };
    completeRoundBudget(continuation, { nowMs: start + 1000 });
    ensureRoundBudgetStarted(continuation, { nowMs: start + 2000, allowSettledRestart: true });
    continuation.stage = 'evidence';
    continuation.knowledgeMaintenance.status = 'idle';
    continuation.agent = { runId: 'manual-round-2', status: 'completed' };
    continuation.benchmark = { status: 'complete', result: { benchmark: [{ value: 10, unit: 'us', correctness: { passed: true } }] } };
    continuation.decisionReview = { status: 'resolved', recommendation: 'reject', resolution: { outcome: 'reject' } };
    const evidenceCounted = await advanceIteration(continuation, { now: () => start + 3000 });
    assert.equal(evidenceCounted.action, 'round_counted');
    assert.equal(continuation.iterationStats.round, 1);
    assert.equal(continuation.iterationStats.roundBudget.roundNumber, 2);
    assert.equal(continuation.iterationStats.roundBudget.status, 'completed');
    if (fixed) assert.equal(continuation.iterationStats.performanceRounds, 1);
    if (injection) continuation.iterationStats.pendingInjection = { briefing: 'bounded alternative direction' };
    const failedEvidence = structuredClone(continuation);
    failedEvidence.benchmark.result.benchmark[0].correctness.passed = false;
    let forbiddenStarts = 0;
    await assert.rejects(advanceIteration(failedEvidence, {
      now: () => start + 4000,
      startMainRound: async ({ state }) => { forbiddenStarts++; return state; },
    }), { code: 'ROUND_BUDGET_ALREADY_COMPLETED' }, 'failed correctness cannot authorize a fresh budget even with a stale completed projection');
    assert.equal(forbiddenStarts, 0);
    assert.equal(failedEvidence.iterationStats.roundBudget.roundNumber, 2);
    let automaticStarts = 0;
    const automatic = await advanceIteration(continuation, {
      now: () => start + 4000,
      startMainRound: async ({ state }) => {
        automaticStarts++;
        assert.equal(ensureRoundBudgetStarted(state, { nowMs: start + 4001 }).changed, false,
          'AgentRound receives an already admitted active identity, not permission to create another one');
        state.agent = { runId: 'automatic-round-3', status: 'running' };
        state.stage = 'diagnosis';
        return state;
      },
    });
    assert.equal(automatic.action, 'resumed_agent', 'settled manual evidence must admit an automatic next round');
    assert.equal(automaticStarts, 1);
    assert.equal(continuation.iterationStats.roundBudget.roundNumber, 3);
    assert.equal(continuation.iterationStats.roundBudget.startedAt, new Date(start + 4000).toISOString());
    assert.equal(continuation.iterationStats.round, 1, 'automatic budget admission must not double count evidence');
    if (fixed) assert.equal(continuation.iterationStats.performanceRounds, 1);
  }
}

for (const failure of ['correctness', 'no_candidate', 'completed_correctness_failure']) {
  const retried = makeState();
  retried.agent = { status: 'completed', runId: 'generic-' + failure };
  retried.benchmark = failure === 'correctness'
    ? { status: 'failed', lastServiceError: { code: 'CORRECTNESS_FAILED', message: 'independent correctness check failed' } }
    : { status: 'idle' };
  retried.decisionReview = failure === 'correctness' ? { status: 'resolved', recommendation: 'reject', resolution: { outcome: 'reject' } } : { status: 'idle' };
  if (failure === 'completed_correctness_failure') {
    retried.stage = 'evidence';
    retried.benchmark = { status: 'complete', result: { benchmark: [{ correctness: { passed: false } }] } };
    retried.decisionReview = { status: 'resolved', recommendation: 'reject', resolution: { outcome: 'reject' } };
  }
  const beforeBudget = structuredClone(retried.iterationStats.roundBudget);
  const counted = await advanceIteration(retried, { now: () => start + 1000 });
  assert.equal(counted.action, 'round_counted');
  assert.equal(counted.state.iterationStats.round, 1, 'legacy generic failure accounting and MAX_ROUNDS remain unchanged');
  assert.equal(counted.state.iterationStats.roundBudget.status, 'active', 'a diagnostic retry is not completed correctness/benchmark evidence');
  const restarted = await advanceIteration(counted.state, {
    now: () => start + 600000,
    startMainRound: async ({ state }) => { state.agent = { status: 'running', runId: 'retry-' + failure }; return state; },
  });
  assert.equal(restarted.action, 'resumed_agent');
  assert.deepEqual(restarted.state.iterationStats.roundBudget, beforeBudget, 'generic ' + failure + ' retry must not refresh the complete-round clock');
  assert.equal(detectLoopGuard(restarted.state, { nowMs: start + ROUND_BUDGET_MS }), 'round_budget');
}

const malformed = makeState();
malformed.iterationStats.roundBudget.deadlineAt = new Date(start + ROUND_BUDGET_MS * 2).toISOString();
assert.equal(detectLoopGuard(malformed, { nowMs: start }), 'round_budget_invalid', 'persisted metadata cannot weaken the fixed wall-clock limit');
assert.throws(() => ensureRoundBudgetStarted(malformed, { nowMs: start }), error => error.code === 'ROUND_BUDGET_STATE_INVALID');
assert.throws(() => inspectRoundBudget(makeState(), { nowMs: NaN }), error => error.code === 'ROUND_BUDGET_CLOCK_INVALID');
const published = makeState();
published.stage = 'published'; published.knowledgeMaintenance = { status: 'completed' };
const publishedResult = await advanceIteration(published, { now: () => start + 1000 });
assert.equal(publishedResult.action, 'completed');
assert.equal(publishedResult.changed, true);
assert.equal(published.iterationStats.roundBudget.status, 'completed');
assert.equal(detectLoopGuard(published, { nowMs: start + ROUND_BUDGET_MS + 1 }), null, 'a finished Mission is not retroactively timed out');

let nowMs = start + ROUND_BUDGET_MS;
let shutdowns = 0;
let autopilotCalls = 0;
const active = makeState();
active.agent = { runId: 'active-agent', status: 'running', resourceRelease: { confirmed: false, status: 'active' } };
active.benchmark = { testTaskId: 'active-test', status: 'running', resourceRelease: { confirmed: false, status: 'active' } };
const advance = createRuntimeAdvanceService({
  detectGuard: state => detectLoopGuard(state, { nowMs }),
  autopilot: { advance: async state => { autopilotCalls++; return { state, action: 'none' }; } },
  advanceIteration: (state, deps) => advanceIteration(state, { ...deps, now: () => nowMs }),
  iteration: {}, reconcileWorkflowState: state => ({ state, changed: false }),
  releaseResources: async (state, { reason }) => {
    shutdowns++;
    assert.equal(reason, 'round_budget');
    state.agent.status = 'cancel_requested';
    state.agent.resourceRelease = { confirmed: false, status: 'unconfirmed', reason: 'test waits for actual exit' };
    state.benchmark.resourceRelease = { confirmed: false, status: 'unconfirmed' };
    state.workflowRecovery = { resourceRelease: { confirmed: false, status: 'unconfirmed', resources: [
      { kind: 'agent', id: 'active-agent', confirmed: false, status: 'unconfirmed' },
      { kind: 'test', id: 'active-test', confirmed: false, status: 'unconfirmed' },
    ] } };
  },
});
assert.equal(advance.canStartNewWork(active), false);
const pending = await advance.advance({ state: active });
assert.equal(pending.actions.iteration, 'resource_release_pending');
assert.equal(shutdowns, 1);
assert.equal(autopilotCalls, 0);
assert.ok(resourceReleaseBarrier(active));
await advance.advance({ state: active });
assert.equal(shutdowns, 1, 'an outstanding barrier cannot repeatedly trigger new work or claim false termination');
active.agent = { ...active.agent, status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } };
active.benchmark = { ...active.benchmark, status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } };
const closed = await advance.advance({ state: active });
assert.equal(closed.actions.iteration, 'needs_human');
assert.equal(active.iterationStats.loopStatusReason, 'round_budget');
assert.equal(active.iterationStats.roundBudget.status, 'expired');
assert.equal(active.iterationStats.round, 0, 'timeout must not count an evidence or performance round');
assert.equal(active.runtimeEvents.filter(event => event.type === 'loop.round_budget_exceeded').length, 1);
await advance.advance({ state: active });
assert.equal(active.runtimeEvents.filter(event => event.type === 'loop.round_budget_exceeded').length, 1, 'deadline event is idempotent');
assert.equal(autopilotCalls, 0);

const directPaused = makeState();
directPaused.missionPaused = true;
const pausedTermination = await advanceIteration(directPaused, { now: () => nowMs });
assert.equal(pausedTermination.action, 'needs_human', 'expired safety budgets still settle while Mission advancement is paused');
assert.equal(directPaused.missionPaused, true);
for (const missionPaused of [true, false]) {
  const total = makeState();
  total.missionPaused = missionPaused;
  total.missionBudgetMs = 1000;
  total.missionBudgetStartedAt = new Date(start).toISOString();
  total.iterationStats = { roundBudget: null, round: 3, performanceRounds: 2, totalCorrectnessAttempts: 4, loopStatus: 'needs_human', loopStatusReason: 'total_budget' };
  const once = await advanceIteration(total, { now: () => start + 1000 });
  assert.equal(once.action, 'needs_human');
  const bytes = JSON.stringify(total);
  await advanceIteration(total, { now: () => start + 2000 });
  await advanceIteration(total, { now: () => start + 3000 });
  assert.equal(JSON.stringify(total), bytes, 'no-resource total-budget settlement cannot recount or repeat events while paused/needs_human');
  assert.equal(total.iterationStats.round, 3);
  assert.equal(total.iterationStats.performanceRounds, 2);
  assert.equal(total.iterationStats.totalCorrectnessAttempts, 4);
}
console.log('[round-budget] exact deadline, stable same-round clock, pause/restart compatibility and real-release barriers passed');
