import assert from 'node:assert/strict';
import { createMissionProjectState } from '../client-runtime/mission-project-state.mjs';
import { createRuntimeAdvanceService } from '../client-runtime/application/runtime-advance-service.mjs';
import { createRuntimeStateService } from '../client-runtime/application/runtime-state-service.mjs';
import { createReviewActionService } from '../client-runtime/application/review-action-service.mjs';
import { createWorkflowCommandPolicy } from '../client-runtime/application/workflow-command-policy.mjs';
import { createBenchmarkCommands } from '../client-runtime/application/benchmark-command.mjs';
import { applyOperatorTestSnapshot, isInfrastructureTestFailure } from '../client-runtime/operator-test-evidence.mjs';
import { resourceReleaseBarrier } from '../client-runtime/cancellation-contract.mjs';

const missions = createMissionProjectState({ rootDir: '', workspaceDir: '', workspaceDirForMission: () => '', missionSourceDirFor: () => '' });
const state = { missions: [], projects: [], activeMissionId: null, activeProjectId: null };
missions.createMission(state, { goal: 'Optimize sum', repository: 'memory', operator: 'reduce_sum', hardware: ['CPU'] });
const mission = state.missions.find((item) => item.id === state.activeMissionId);
assert.equal(mission.operator, 'reduce_sum');
assert.deepEqual(mission.testMatrix.environments, ['CPU']);
const blocked = {
  ...structuredClone(state), missionPaused: true,
  agent: { runId: 'old-worker', status: 'cancel_requested', resourceRelease: { confirmed: false, status: 'unconfirmed' } },
};
const code = (error) => error.code === 'MISSION_RESOURCE_RELEASE_PENDING';
for (const operation of [
  () => missions.resumeMissionState(blocked),
  () => missions.createMission(blocked, { goal: 'new', repository: 'next' }),
  () => missions.selectMission(blocked, 'other'),
  () => missions.selectProject(blocked, 'other'),
  () => missions.startAgentRun(blocked, 'new'),
  () => missions.resetMissionRunState(blocked, 'new'),
  () => createWorkflowCommandPolicy({ normalizeMissionBudgetMs: () => null }).guardMutation(blocked),
]) assert.throws(operation, code);
let writes = 0;
const runtimeState = createRuntimeStateService({ loadState: async () => structuredClone(blocked), persistState: async () => { writes += 1; }, resumeMissionState: missions.resumeMissionState, normalizeMissionBudgetMs: () => null });
await assert.rejects(() => runtimeState.patch({ missionPaused: false }), code);
const review = createReviewActionService({ loadState: async () => structuredClone(blocked), persistState: async () => { writes += 1; }, executeCommand: async () => { writes += 1; }, journal: {}, registry: {}, guardSupportedRuntimeAction: async () => {}, guardWorkflowTransition: () => {} });
await assert.rejects(() => review.resume(), code);
assert.equal(writes, 0);

for (const missionPaused of [false, true]) for (const confirmed of [true, false]) {
  const calls = [];
  const service = createRuntimeAdvanceService({
    autopilot: { advance: async () => { calls.push('autopilot'); throw new Error('Must not dispatch after budget.'); } },
    detectGuard: () => 'total_budget',
    releaseResources: async (value) => {
      calls.push('release');
      value.agent.resourceRelease = { confirmed, status: confirmed ? 'confirmed' : 'unconfirmed' };
      value.agent.status = confirmed ? 'cancelled' : 'cancel_requested';
    },
    advanceIteration: async (value) => { calls.push('iteration'); return { state: value, action: 'completed_budget' }; },
    iteration: {}, reconcileWorkflowState: (value) => { calls.push('reconcile'); return { state: value, changed: false }; },
  });
  const result = await service.advance({ state: { missionPaused, agent: { runId: 'r', status: 'running' } } });
  assert.deepEqual(calls, confirmed ? ['release', 'iteration', 'reconcile'] : ['release']);
  assert.equal(result.actions.iteration, confirmed ? 'completed_budget' : 'resource_release_pending');
}

const settledBudgetService = createRuntimeAdvanceService({
  detectGuard: () => 'total_budget',
  autopilot: { advance: async () => { throw new Error('Settled budget cannot dispatch.'); } },
  advanceIteration: async (value) => ({ state: value, action: 'needs_human' }),
  iteration: {}, reconcileWorkflowState: (value) => ({ state: value, changed: false }),
});
assert.equal((await settledBudgetService.advance({ state: { missionPaused: true, iterationStats: { loopStatus: 'needs_human' } } })).changed, false,
  'a stable budget terminal must not persist another state version on every tick');

let submitted;
const commands = createBenchmarkCommands({
  addAuditEvent: () => {}, appendRuntimeEvent: () => {}, baselineMatchesMatrix: () => true,
  createSemanticTaskBinding: () => ({}), hashKey: () => 'digest', isFixedOperatorMission: () => false,
  localC500Config: { enabled: true, mock: false, liveHardware: false, executionMode: 'cpu-e2e' },
  missionShapeKeyFor: () => 'shape', normalizeBaselineKind: (value) => value,
  operatorTestQueue: { submit: async (request) => { submitted = request; return { taskId: 't1', submittedAt: new Date().toISOString() }; } },
  readMissionRunPy: async () => ({ content: 'candidate' }),
  resolveBaselineRunPlan: async () => ({ baselineKind: 'naive_v0', candidateId: 'baseline', runPy: 'independent baseline', runPySource: 'frozen', digestSeed: 'source' }),
});
const command = commands['start-benchmark'];
const prepared = await command.prepare({ state, body: { purpose: 'baseline' }, intent: { runId: 'r1' }, recordIntent: async () => {}, runEffect: (effect) => effect() });
assert.equal(submitted.operator, 'reduce_sum');
assert.deepEqual(submitted.matrix.environments, ['CPU']);
assert.equal(submitted.oracleRunPy, 'independent baseline');
assert.equal(submitted.tracer.enabled, false);
assert.equal(submitted.profiler.enabled, false);
command.apply(state, prepared.payload);
assert.equal(state.benchmark.source.liveHardware, false);

const ownerState = structuredClone(state);
ownerState.agent = { ...ownerState.agent, runId: 'unconfirmed-owner', runtimeKind: 'codex-cli', status: 'cancel_requested', currentAction: null, resourceRelease: { confirmed: false, status: 'unconfirmed' } };
ownerState.workflowRecovery.resourceRelease = { confirmed: false, status: 'pending', resources: [{ kind: 'agent', id: 'unconfirmed-owner', confirmed: false, status: 'pending' }] };
applyOperatorTestSnapshot(ownerState, {
  taskId: 't1', status: 'completed', completedAt: new Date().toISOString(), resourceRelease: { confirmed: true, status: 'confirmed' },
  result: { environment: { source: 'cpu-e2e', liveHardware: false }, benchmark: [{ environment: 'CPU', value: 1, unit: 'us', correctness: { passed: true, total: 24 } }] },
});
assert.equal(ownerState.agent.runtimeKind, 'codex-cli', 'baseline result cannot discard an unconfirmed Agent owner');
assert.equal(ownerState.agent.status, 'cancel_requested');
assert.equal(ownerState.agent.runId, 'unconfirmed-owner');
ownerState.agent.resourceRelease = { confirmed: true, status: 'confirmed' };
ownerState.agent.status = 'cancelled';
assert.equal(resourceReleaseBarrier(ownerState), null, 'matching later provider receipt can clear the preserved owner');


state.benchmark = { ...state.benchmark, status: 'running', testTaskId: 't1' };
state.workflowRecovery.resourceRelease = { confirmed: false, status: 'pending', resources: [{ kind: 'test', id: 't1', confirmed: false, status: 'pending' }] };
applyOperatorTestSnapshot(state, { taskId: 't1', status: 'cancelled', resourceRelease: { confirmed: false, status: 'unconfirmed' } });
assert.equal(state.benchmark.status, 'running');
assert.ok(resourceReleaseBarrier(state));
applyOperatorTestSnapshot(state, { taskId: 't1', status: 'cancelled' });
assert.equal(state.benchmark.status, 'running', 'legacy terminal without release proof must stay observable');
applyOperatorTestSnapshot(state, { taskId: 't1', status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } });
assert.equal(state.benchmark.status, 'cancelled');
assert.equal(state.workflowRecovery.resourceRelease.confirmed, true);
assert.equal(isInfrastructureTestFailure({ error: { role: 'oracle', category: 'correctness' } }), true);
assert.equal(isInfrastructureTestFailure({ error: { role: 'candidate', category: 'correctness' } }), false);
console.log('[generic-runtime-safety] CPU identity/oracle, no false live evidence, resource barriers and pre-dispatch budget shutdown passed');
