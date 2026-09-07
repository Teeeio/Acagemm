import assert from 'node:assert/strict';
import { createAgentCommands } from '../client-runtime/application/agent-commands.mjs';
import { ROUND_BUDGET_MS } from '../client-runtime/round-budget-contract.mjs';

const epoch = Date.parse('2026-09-07T00:00:00.000Z');
let clock = epoch;
let version = 1;
let reads = 0;
let launches = 0;
let captured;
const state = {
  activeMissionId: 'mission-1', missions: [{ id: 'mission-1', projectId: 'project-1', goal: 'Optimize' }],
  iterationStats: { round: 0 }, runtimeEvents: [], agent: {},
};
const events = [];
const roundExperience = {
  prepare: async ({ state, mission, roundId }) => {
    reads++;
    const existing = state.iterationStats.roundExperience;
    const context = existing?.roundId === roundId ? existing : { projectId: mission.projectId, missionId: mission.id, roundId, versions: { guidance: version } };
    state.iterationStats.roundExperience = structuredClone(context);
    return context;
  },
};
const command = createAgentCommands({
  agentRuntime: {
    describe: async () => ({ mode: 'codex-cli' }),
    startRun: async (input) => {
      launches++; captured = input; events.push('start');
      input.state.agent = { runId: 'run-1', status: 'running' };
      return { handled: true, state: input.state };
    },
  },
  roundExperience, now: () => new Date(clock), isManagedWorkspaceRuntimeMode: () => true,
  resetMissionRunState: (value) => { value.agent = {}; value.stage = 'diagnosis'; value.knowledgeMaintenance = { status: 'idle' }; },
  createWorkspaceCheckpoint: async () => { events.push('checkpoint'); return { id: 'checkpoint' }; },
  appendRuntimeEvent: () => {},
}).runs;
const intent = command.plan({ state });
const recorded = [];
const prepared = await command.prepare({
  state, body: { workspace: 'isolated-workspace' }, intent,
  recordIntent: async (value) => { recorded.push(structuredClone(value)); events.push('intent'); },
  runEffect: (effect) => effect(),
});
assert.deepEqual(events, ['intent', 'checkpoint', 'start']);
assert.equal(captured.experienceContext.versions.guidance, 1);
assert.equal(captured.experienceContext.roundId, 'mission-1:round:1');
assert.equal(prepared.payload.roundBudget.startedAt, new Date(epoch).toISOString());
assert.equal(state.iterationStats.roundBudget, undefined, 'prepare cannot mutate persisted input');
version = 2; clock += 1000;
const replay = structuredClone(state);
command.apply(replay, prepared.payload);
assert.equal(replay.iterationStats.roundExperience.versions.guidance, 1);
assert.equal(replay.iterationStats.roundBudget.startedAt, intent.roundBudget.startedAt);
assert.equal(launches, 1, 'apply cannot relaunch an Agent');
const retryIntent = command.plan({ state: replay });
assert.equal(retryIntent.roundBudget.startedAt, intent.roundBudget.startedAt);
await command.prepare({
  state: replay, body: { workspace: 'isolated-workspace' }, intent: recorded[0],
  recordIntent: async () => {}, runEffect: (effect) => effect(),
});
assert.equal(captured.experienceContext.versions.guidance, 1, 'same-round re-entry keeps frozen versions');
clock = epoch + ROUND_BUDGET_MS;
assert.throws(() => command.plan({ state: replay }), { code: 'ROUND_BUDGET_EXCEEDED' });
const beforeLaunches = launches;
await assert.rejects(command.prepare({
  state, body: { workspace: 'isolated-workspace' }, intent,
  recordIntent: async () => {}, runEffect: (effect) => effect(),
}), { code: 'ROUND_BUDGET_EXCEEDED' });
assert.equal(launches, beforeLaunches);
assert.equal(reads, 2, 'expired round fails before retrieving a new experience context');
// A published/reverted Mission can settle before the legacy evidence counter increments.
// Only a fresh runs plan may allocate the next identity; prepare/apply reuse its intent.
const published = structuredClone(replay);
published.stage = 'published'; published.knowledgeMaintenance = { status: 'completed' };
published.decisionReview = { status: 'resolved', resolution: { outcome: 'reverted' } };
published.agent.status = 'completed';
published.iterationStats = { ...published.iterationStats, performanceRounds: 2, currentRoundCorrectnessAttempts: 3,
  roundBudget: { ...published.iterationStats.roundBudget, status: 'completed', completedAt: new Date(epoch + 5000).toISOString() } };
const publishedBytes = JSON.stringify(published);
clock = epoch + ROUND_BUDGET_MS + 1000;
const newIntent = command.plan({ state: published });
assert.equal(newIntent.roundBudget.roundId, 'mission-1:round:2');
assert.equal(newIntent.roundBudget.startedAt, new Date(clock).toISOString());
assert.equal(JSON.stringify(published), publishedBytes, 'planning a new round cannot mutate or recount the settled Mission');
const newRecords = [];
const restarted = await command.prepare({ state: published, body: { workspace: 'isolated-workspace' }, intent: newIntent,
  recordIntent: async value => { newRecords.push(structuredClone(value)); }, runEffect: effect => effect() });
assert.equal(restarted.payload.roundBudget.status, 'active', 'the old published projection must not complete a new frozen active intent');
assert.equal(captured.experienceContext.roundId, newIntent.roundBudget.roundId);
assert.equal(captured.experienceContext.versions.guidance, 2, 'an admitted new round freezes a new experience context');
const restartedState = structuredClone(published);
command.apply(restartedState, restarted.payload);
assert.equal(restartedState.stage, 'diagnosis');
assert.equal(restartedState.iterationStats.round, 0, 'manual new identity never changes evidence/performance/retry counters');
assert.equal(restartedState.iterationStats.performanceRounds, 2);
assert.equal(restartedState.iterationStats.currentRoundCorrectnessAttempts, 3);
assert.equal(restartedState.iterationStats.roundBudget.roundId, 'mission-1:round:2');
clock += 1000; version = 3;
assert.deepEqual(command.plan({ state: restartedState }).roundBudget, newIntent.roundBudget, 'same-round retry keeps a manual round identity above the evidence counter');
const appliedLaunches = launches;
command.apply(restartedState, restarted.payload);
assert.equal(launches, appliedLaunches, 'prepared replay cannot launch or allocate another round');
assert.equal(restartedState.iterationStats.roundExperience.versions.guidance, 2);
assert.deepEqual(restartedState.iterationStats.roundBudget, newIntent.roundBudget);
clock = Date.parse(newIntent.roundBudget.deadlineAt);
const lateLaunches = launches;
await assert.rejects(command.prepare({ state: published, body: { workspace: 'isolated-workspace' }, intent: newRecords[0],
  recordIntent: async () => {}, runEffect: effect => effect() }), { code: 'ROUND_BUDGET_EXCEEDED' });
assert.equal(launches, lateLaunches, 'expired active replay cannot borrow the old published state to renew its deadline');
console.log('[agent-start-context] first/manual-settled runs freeze distinct contexts; replay/retry cannot refresh deadlines or counters');
