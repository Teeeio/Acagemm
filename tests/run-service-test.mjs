import assert from 'node:assert/strict';
// In-memory application/route integration; Provider and workspace ports are doubles.
import { createRunService } from '../client-runtime/application/run-service.mjs';
import { createRunRoutes } from '../client-runtime/server/run-routes.mjs';
import { createAutopilotFixedProfileService } from '../client-runtime/application/autopilot-fixed-profile-service.mjs';
import { createAgentRoundService } from '../client-runtime/application/agent-round-service.mjs';
import { fixedOperatorProfiles, fixedOperatorTestMatrix, isFixedOperatorMission } from '../client-runtime/fixed-operator-profiles.mjs';
import { ensureRoundBudgetStarted, completeRoundBudget, ROUND_BUDGET_MS } from '../client-runtime/round-budget-contract.mjs';
import { emptyExperienceStore, retrieveExperienceContext } from '../client-runtime/experience-contract.mjs';
import { MAX_ROUNDS } from '../client-runtime/iteration-loop.mjs';

const base = { activeMissionId: 'MIS_1', missions: [{ id: 'MIS_1', goal: 'optimize' }, { id: 'MIS_2', goal: 'second goal' }], iterationStats: {}, baseline: { status: 'complete' } };
const selections = [];
const make = (overrides = {}) => ({ missionState: { selectMission(state, id) { selections.push(id); state.activeMissionId = id; return state; } }, loadState: async () => structuredClone({ ...base, ...overrides.state }), persistState: async (state) => state, executeCommand: async ({ type, state }) => ({ status: 'applied', state, result: { runId: `RUN_${type}` } }), journal: {}, registry: {}, agentRuntime: { async describe() { return { mode: 'fixture' }; } }, buildRuntimePreflight: async () => ({ ready: true, workspace: '/tmp/workspace' }), nowMs: () => Date.parse('2026-09-07T00:00:00.000Z'), assertMissionIntent() {}, isStrictZeroSourceMission: () => false, isFixedOperatorMission: () => false, ...overrides });
const service = createRunService(make());
assert.equal((await service.start('MIS_1', {})).result.result.runId, 'RUN_runs');
const selected = await service.start('MIS_2', {});
assert.equal(selected.result.state.activeMissionId, 'MIS_2');
assert.deepEqual(selections, ['MIS_2']);
assert.throws(() => createRunService(make({ missionState: undefined })), TypeError);
await assert.rejects(service.start('missing', {}), (error) => error.code === 'MISSION_NOT_FOUND');
const fixed = createRunService(make({ isFixedOperatorMission: () => true }));
const firstFixed = await fixed.start('MIS_1', {});
assert.equal(firstFixed.kind, 'armed');
assert.equal(firstFixed.payload.state.iterationStats.roundBudget.status, 'active');
assert.equal(firstFixed.payload.state.iterationStats.roundBudget.roundId, 'MIS_1:round:1', 'first fixed arming freezes its initial clock before 202');
const strict = createRunService(make({ state: { baseline: { status: 'idle' } }, isStrictZeroSourceMission: () => true, selectResearchBaselineSource: () => null }));
assert.equal((await strict.start('MIS_1', {})).kind, 'research');
const epoch = Date.parse('2026-09-07T00:00:00.000Z');
const profile = fixedOperatorProfiles.find(item => item.iterationPolicy);
const fixedMission = { id: 'MIS_1', projectId: 'PROJECT_1', goal: 'optimize the frozen operator', operatorProfile: structuredClone(profile), sourcePolicy: { researchEnabled: false }, hardware: ['C550'] };
const fixedState = () => {
  const state = { activeMissionId: fixedMission.id, missions: [structuredClone(fixedMission)],
    stage: 'published', knowledgeMaintenance: { status: 'completed' },
    agent: { runId: 'old-published-run', status: 'completed', resourceRelease: { confirmed: true } },
    baseline: { status: 'complete' }, benchmark: { status: 'idle' }, researchAgent: { status: 'idle' },
    missionBudgetStartedAt: new Date(epoch).toISOString(), missionBudgetMs: 3600000,
    testMatrix: fixedOperatorTestMatrix(profile), runHistory: [],
    iterationStats: { round: 0, performanceRounds: 1, currentRoundCorrectnessAttempts: 0, currentRoundGenerationAttempts: 0, loopStatus: 'completed' } };
  ensureRoundBudgetStarted(state, { nowMs: epoch });
  completeRoundBudget(state, { nowMs: epoch + 1000 });
  return state;
};
const fixedHarness = (initial, options = {}) => {
  let persisted = structuredClone(initial);
  let clock = options.nowMs ?? epoch + ROUND_BUDGET_MS + 1000;
  const calls = { saves: 0, commands: 0, preflights: 0, responses: 0 };
  const runs = createRunService(make({ isFixedOperatorMission,
    loadState: async () => structuredClone(persisted),
    persistState: async state => { calls.saves++; persisted = structuredClone(state); return state; },
    executeCommand: async () => { calls.commands++; throw new Error('Fixed arming must not invoke the normal runs journal plan.'); },
    registry: { runs: { plan: () => { throw new Error('Fixed API bypasses normal runs.plan.'); } } },
    nowMs: () => clock,
    buildRuntimePreflight: async () => { calls.preflights++; if (options.preflightClock != null) clock = options.preflightClock; return { ready: true, workspace: 'test-workspace' }; },
  }));
  const route = createRunRoutes({ runs, readJson: async request => request.body,
    json: (response, status, payload) => { calls.responses++; Object.assign(response, { status, payload }); } });
  const request = async (body = {}) => {
    const response = {};
    await route({ request: { method: 'POST', body }, response, url: new URL('http://test.local/api/missions/MIS_1/runs') });
    return response;
  };
  return { request, calls, snapshot: () => structuredClone(persisted), nowMs: () => clock, setClock: value => { clock = value; } };
};

for (const [field, limit, reason] of [
  ['performanceRounds', profile.iterationPolicy.performanceRounds, 'fixed_rounds_complete'],
  ['currentRoundCorrectnessAttempts', profile.iterationPolicy.maxCorrectnessAttempts, 'correctness_failed'],
  ['currentRoundGenerationAttempts', profile.iterationPolicy.maxGenerationAttempts, 'candidate_generation_failed'],
]) {
  const exhausted = fixedState();
  exhausted.iterationStats[field] = limit;
  const harness = fixedHarness(exhausted);
  await assert.rejects(harness.request(), error => error.status === 409 && error.code === 'FIXED_OPERATOR_RUN_BLOCKED'
    && error.details?.reason === reason && typeof error.details.nextAction === 'string',
  'the actual fixed POST route must reject ' + reason + ' before acknowledging armed');
  assert.equal(harness.calls.saves, 0);
  assert.equal(harness.calls.commands, 0);
  assert.equal(harness.calls.responses, 0, 'a failed fixed admission must not send 202');
  assert.deepEqual(harness.snapshot(), exhausted, 'fixed rejection must not clear limits or completed state');
}
assert.throws(() => createRunService(make({ nowMs: undefined })), TypeError);

const totalExpired = fixedState();
const totalHarness = fixedHarness(totalExpired, { nowMs: epoch + totalExpired.missionBudgetMs });
await assert.rejects(totalHarness.request(), error => error.code === 'FIXED_OPERATOR_RUN_BLOCKED' && error.details.reason === 'total_budget');
assert.equal(totalHarness.calls.saves, 0);
const maxRounds = fixedState();
maxRounds.missionBudgetMs = null;
maxRounds.iterationStats.round = MAX_ROUNDS;
const maxHarness = fixedHarness(maxRounds);
await assert.rejects(maxHarness.request(), error => error.code === 'FIXED_OPERATOR_RUN_BLOCKED' && error.details.reason === 'max_rounds');
assert.equal(maxHarness.calls.saves, 0);
const unsettled = fixedState();
unsettled.stage = 'evidence';
unsettled.knowledgeMaintenance.status = 'idle';
const unsettledHarness = fixedHarness(unsettled);
await assert.rejects(unsettledHarness.request(), error => error.code === 'ROUND_BUDGET_ALREADY_COMPLETED'
  && error.status === 409 && typeof error.details?.nextAction === 'string');
assert.equal(unsettledHarness.calls.responses, 0, 'manual fixed API cannot invent automatic evidence settlement permission');
assert.deepEqual(unsettledHarness.snapshot(), unsettled);
const expired = fixedState();
expired.stage = 'diagnosis';
expired.iterationStats.roundBudget.status = 'active';
const expiredHarness = fixedHarness(expired);
await assert.rejects(expiredHarness.request({ resume: true, allowSettledRestart: true, completedRoundId: expired.iterationStats.roundBudget.roundId, roundBudget: { status: 'completed' } }),
  error => error.code === 'FIXED_OPERATOR_RUN_BLOCKED' && error.details.reason === 'round_budget',
  'body fields cannot forge admission permission or replace the persisted expired budget');
assert.equal(expiredHarness.calls.saves, 0);
const preflightStart = epoch + ROUND_BUDGET_MS + 1000;
const lateHarness = fixedHarness(fixedState(), { nowMs: preflightStart, preflightClock: preflightStart + ROUND_BUDGET_MS });
await assert.rejects(lateHarness.request(), error => error.code === 'ROUND_BUDGET_EXCEEDED'
  && error.status === 409 && typeof error.details?.nextAction === 'string',
'a manual budget frozen before preflight must expire even while the old snapshot remains published');
assert.equal(lateHarness.calls.preflights, 1);
assert.equal(lateHarness.calls.saves, 0);
assert.equal(lateHarness.calls.responses, 0);

const contextFor = (roundId, clock) => retrieveExperienceContext(emptyExperienceStore(), {
  projectId: fixedMission.projectId, missionId: fixedMission.id, roundId,
  scope: { operator: profile.operator, hardware: fixedMission.hardware }, allowedProjectIds: [],
}, { now: new Date(clock).toISOString() });
const runThroughActualServices = async (harness, armedState, expectedBudget, expectedRetryMode) => {
  let launches = 0;
  let preparedContexts = 0;
  const seenRetries = [];
  const agentRound = createAgentRoundService({
    nowMs: harness.nowMs,
    resetMissionRunState: state => { state.stage = 'diagnosis'; state.agent = { status: 'idle' }; state.benchmark = { status: 'idle' }; },
    resetMissionWorkspace: async () => { throw new Error('No reference workspace effect is expected.'); },
    createWorkspaceCheckpoint: async () => { throw new Error('No managed workspace effect is expected.'); },
    startAgentRun: () => { throw new Error('No simulation fallback is expected.'); },
    appendRuntimeEvent() {}, isManagedWorkspaceRuntimeMode: () => false,
    roundExperience: {
      collect: async () => ({ status: 'skipped' }),
      prepare: async ({ state, roundId }) => {
        preparedContexts++;
        const context = state.iterationStats.roundExperience?.roundId === roundId
          ? state.iterationStats.roundExperience : contextFor(roundId, harness.nowMs());
        state.iterationStats.roundExperience = context;
        return context;
      },
    },
    agentRuntime: { startRun: async ({ state, roundId, experienceContext }) => {
      launches++;
      assert.deepEqual(state.iterationStats.roundBudget, expectedBudget, 'actual AgentRound consumes the API-frozen budget without restarting it');
      assert.equal(roundId, expectedBudget.roundId);
      assert.equal(experienceContext.roundId, expectedBudget.roundId);
      state.agent = { runId: 'injected-provider-' + launches, status: 'running', resourceRelease: { confirmed: false } };
      return { handled: true, state };
    } },
  });
  const autopilot = createAutopilotFixedProfileService({
    isResearchAgentActive: agent => agent.status === 'running',
    startResearch: async () => { throw new Error('Research is explicitly disabled for this integration.'); },
    researchDirForMission: () => 'unused', appendRuntimeEvent() {},
    startMainRound: async ({ state, goal, retryMode }) => {
      seenRetries.push(retryMode);
      return agentRound.startRound({ state, mission: fixedMission, goal, workspace: 'injected-workspace', runtimeMode: 'test-provider' });
    },
  });
  const started = await autopilot.advance({ state: armedState, mission: fixedMission });
  assert.equal(started.action, 'candidate_agent_started');
  assert.equal(launches, 1);
  assert.equal(preparedContexts, 1);
  assert.deepEqual(seenRetries, [expectedRetryMode]);
  assert.equal(started.state.iterationStats.roundExperience.roundId, expectedBudget.roundId);
  assert.equal((await autopilot.advance({ state: started.state, mission: fixedMission })).action, 'none');
  assert.equal(launches, 1, 'repeated Autopilot observation cannot start a second Agent');
  return started.state;
};

const publishedRemaining = fixedState();
publishedRemaining.iterationStats.roundExperience = contextFor(publishedRemaining.iterationStats.roundBudget.roundId, epoch);
const remainingHarness = fixedHarness(publishedRemaining);
const admitted = await remainingHarness.request();
assert.equal(admitted.status, 202);
assert.equal(admitted.payload.armed, true);
const admittedBudget = structuredClone(admitted.payload.state.iterationStats.roundBudget);
assert.equal(admittedBudget.roundNumber, 2, 'real fixed manual API receives a new monotonic identity when settled and under the fixed limits');
assert.equal(admittedBudget.status, 'active');
assert.equal(admittedBudget.startedAt, new Date(remainingHarness.nowMs()).toISOString());
assert.equal(admitted.payload.state.stage, 'candidate');
assert.deepEqual(admitted.payload.state.testMatrix, publishedRemaining.testMatrix);
assert.deepEqual(admitted.payload.state.missions[0].operatorProfile, profile);
assert.equal(admitted.payload.state.iterationStats.round, 0);
assert.equal(admitted.payload.state.iterationStats.performanceRounds, 1);
assert.equal(admitted.payload.state.missionBudgetStartedAt, publishedRemaining.missionBudgetStartedAt);
remainingHarness.setClock(remainingHarness.nowMs() + 1000);
const duplicateArming = await remainingHarness.request();
assert.deepEqual(duplicateArming.payload.state.iterationStats.roundBudget, admittedBudget, 'repeated manual arming cannot refresh active time');
const running = await runThroughActualServices(remainingHarness, duplicateArming.payload.state, admittedBudget, 'generation');
assert.equal(running.iterationStats.round, 0);
assert.equal(running.iterationStats.performanceRounds, 1);
assert.notEqual(running.iterationStats.roundExperience.roundId, publishedRemaining.iterationStats.roundExperience.roundId);
assert.equal(remainingHarness.calls.commands, 0, 'this tests the real fixed branch, not normal journal runs.plan');

const repair = fixedState();
repair.stage = 'diagnosis';
repair.knowledgeMaintenance.status = 'idle';
repair.iterationStats.roundBudget.status = 'active';
repair.iterationStats.performanceRounds = 0;
repair.iterationStats.currentRoundCorrectnessAttempts = 1;
repair.iterationStats.correctnessEstablished = false;
repair.iterationStats.roundExperience = contextFor(repair.iterationStats.roundBudget.roundId, epoch);
const repairHarness = fixedHarness(repair, { nowMs: epoch + 5000 });
const armedRepair = await repairHarness.request();
assert.deepEqual(armedRepair.payload.state.iterationStats.roundBudget, repair.iterationStats.roundBudget);
const repaired = await runThroughActualServices(repairHarness, armedRepair.payload.state, repair.iterationStats.roundBudget, 'correctness');
assert.equal(repaired.iterationStats.currentRoundCorrectnessAttempts, 1, 'manual arming and AgentRound cannot reset fixed correctness attempts');
assert.equal(repaired.iterationStats.currentRoundGenerationAttempts, 0);
assert.deepEqual(repaired.iterationStats.roundExperience, repair.iterationStats.roundExperience);
console.log('[run-service] route/service integration passed: fixed synchronous rejection, frozen arming, actual Autopilot/AgentRound with injected effects, and ordinary starts');
