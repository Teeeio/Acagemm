import assert from 'node:assert/strict';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { createMissionControlService } from '../client-runtime/application/mission-control-service.mjs';

const runtime = createAgentRuntime({
  mode: 'codex-cli',
  codexClient: {
    describe: async () => ({ installed: true, version: 'test' }),
    readRun: async (runId) => ({ runId, status: 'running', workspace: 'DO_NOT_READ_PENDING_WORKSPACE' }),
    readEvents: async () => [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ candidates: [{ id: 'unsafe', files: ['run.py'] }] }) } }],
    cancel: async () => ({ status: 'cancel_requested', resourceRelease: { confirmed: false, status: 'pending' } }),
    eventText: () => '',
  },
});
for (const role of ['agent', 'researchAgent', 'materializer']) {
  const state = {
    activeMissionId: 'MIS_PENDING', missions: [{ id: 'MIS_PENDING', title: 'Pending cancellation' }],
    stage: 'diagnosis', runtimeEvents: [], candidateEvaluations: [], researchNotes: [],
    agent: { status: 'idle' }, baseline: { status: 'missing' },
  };
  const run = { runId: 'pending_' + role, runtimeKind: 'codex-cli', status: 'running',
    startedAt: new Date(Date.now() - 1_000).toISOString(), budgetMs: 1, messages: [], artifacts: [], notes: [], runPhase: 'synthesize' };
  if (role === 'materializer') state.baseline.materializer = run;
  else state[role] = run;
  const result = await runtime.projectState(state);
  const projected = role === 'materializer' ? result.state.baseline.materializer : result.state[role];
  assert.equal(projected.status, 'cancel_requested', role + ' must remain active until actual exit');
  assert.equal(projected.resourceRelease.confirmed, false);
  assert.equal(result.state.candidateEvaluations.length, 0);
  assert.equal(result.state.researchNotes.length, 0);
  assert.ok(!result.state.baseline.materializer?.result);
}

const seen = [];
const saved = [];
const stopState = {
  activeMissionId: 'MIS_STOP', missions: [{ id: 'MIS_STOP', status: 'running' }],
  agent: { runId: 'main', status: 'running' },
  researchAgent: { runId: 'research', status: 'running' },
  baseline: { materializer: { runId: 'materializer', status: 'running' } },
  benchmark: { testTaskId: 'test', status: 'queued' },
};
const service = createMissionControlService({
  loadState: async () => structuredClone(stopState),
  persistState: async state => { saved.push(structuredClone(state)); return state; },
  agentRuntime: { cancelRun: async ({ state, runId }) => {
    seen.push(runId);
    if (runId === 'research') throw Object.assign(new Error('provider offline'), { code: 'TEST_CANCEL_FAILED' });
    return { state, result: { status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } } };
  } },
  operatorTestQueue: { cancel: async taskId => { seen.push(taskId); return { status: 'cancelled' }; } },
  appendRuntimeEvent: (state, type, payload) => { state.runtimeEvents = [...(state.runtimeEvents || []), { type, payload }]; },
  addAuditEvent: () => {},
});
const result = await service.stopMission();
assert.deepEqual(new Set(seen), new Set(['main', 'research', 'materializer', 'test']));
assert.equal(saved[0].missionPaused, true, 'stop intent is durable before any cancellation effect');
assert.equal(result.statusCode, 202);
assert.equal(result.state.missionPaused, true);
const release = result.state.workflowRecovery.resourceRelease;
assert.equal(release.confirmed, false);
assert.equal(release.status, 'unconfirmed');
assert.equal(release.resources.find(item => item.id === 'research').error.code, 'TEST_CANCEL_FAILED');
assert.ok(release.resources.every(item => item.kind && item.id && item.reason && item.deadline && item.nextAction));
console.log('[agent-cancellation-liveness] pending exit blocks artifacts; Mission stop covers all resources and exposes failures');

const { resourceReleaseBarrier, assertResourcesReleased } = await import('../client-runtime/cancellation-contract.mjs');
assert.ok(resourceReleaseBarrier({ agent: { runId: 'failed-owner', status: 'failed', resourceRelease: { confirmed: false } } }));
assert.equal(resourceReleaseBarrier({ agent: { runId: 'active', status: 'running', resourceRelease: { confirmed: false, status: 'active' } } }), null);
assert.throws(() => assertResourcesReleased({ workflowRecovery: { resourceRelease: { confirmed: false, status: 'pending', reason: 'waiting' } } }), error => error.code === 'MISSION_RESOURCE_RELEASE_PENDING');
assert.ok(resourceReleaseBarrier({ workflowRecovery: { resourceRelease: { confirmed: false, status: 'unconfirmed', resources: [] } } }), 'an ownerless empty summary must not be cleared by vacuous every()');

let lateResolve;
const pendingState = {
  activeMissionId: 'MIS_LATE', missions: [{ id: 'MIS_LATE', status: 'running' }],
  missionPaused: false, iterationStats: { loopStatus: 'running' },
  agent: { runId: 'late', status: 'running' },
};
const boundedService = createMissionControlService({
  loadState: async () => { throw new Error('releaseResources must not load'); },
  persistState: async () => { throw new Error('releaseResources must not persist'); },
  cancellationTimeoutMs: 20,
  agentRuntime: { cancelRun: ({ state }) => new Promise(resolve => {
    lateResolve = () => { state.missions[0].title = 'late mutation'; resolve({ state, result: { status: 'cancelled' } }); };
  }) },
  operatorTestQueue: { cancel: async () => { throw new Error('no test is active'); } },
  appendRuntimeEvent: () => {}, addAuditEvent: () => {},
});
const pendingRelease = await boundedService.releaseResources(pendingState, { reason: 'mission_budget' });
assert.equal(pendingRelease.confirmed, false);
assert.equal(pendingRelease.resources[0].error.code, 'MISSION_CANCEL_DEADLINE_EXCEEDED');
assert.equal(pendingState.missionPaused, false);
assert.equal(pendingState.iterationStats.loopStatus, 'running');
const pendingBytes = JSON.stringify(pendingState);
lateResolve();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(JSON.stringify(pendingState), pendingBytes, 'late cancellation port completion cannot mutate returned state');

// A provider transport failure while cancelling must not turn into a safe terminal.
const unknownRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: {
  describe: async () => ({ installed: true, version: 'test' }),
  readRun: async () => { throw Object.assign(new Error('lost run record'), { code: 'TEST_STATUS_UNAVAILABLE' }); },
} });
const unknownState = { activeMissionId: 'MIS_UNKNOWN', runtimeEvents: [], stage: 'diagnosis',
  agent: { runId: 'unknown', status: 'running', runtimeKind: 'codex-cli', messages: [] } };
await unknownRuntime.projectState(unknownState);
assert.equal(unknownState.agent.status, 'cancel_requested');
assert.equal(unknownState.agent.resourceRelease.confirmed, false);
assert.equal(unknownState.agent.resourceRelease.code, 'TEST_STATUS_UNAVAILABLE');
assert.ok(resourceReleaseBarrier(unknownState));

const recoveredRuntime = createAgentRuntime({ mode: 'codex-cli', codexClient: {
  describe: async () => ({ installed: true, version: 'test' }),
  readRun: async () => ({ runId: 'unknown', status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } }),
  readEvents: async () => [], eventText: () => '',
} });
unknownState.workflowRecovery = { resourceRelease: { confirmed: false, status: 'unconfirmed', resources: [{ kind: 'agent', id: 'unknown', confirmed: false, status: 'unconfirmed' }] } };
await recoveredRuntime.projectState(unknownState);
assert.equal(unknownState.agent.resourceRelease.confirmed, true);
assert.equal(unknownState.workflowRecovery.resourceRelease.confirmed, true, 'explicit projection clears the matching stale Mission summary');
assert.equal(resourceReleaseBarrier(unknownState), null, 'confirmed exit clears the per-run cancellation barrier');
await assert.rejects(() => runtime.startRun({ state: { agent: { runId: 'pending', status: 'cancel_requested' } }, mission: {}, goal: 'unused' }), error => error.code === 'MISSION_RESOURCE_RELEASE_PENDING');


const { reconcileResourceRelease } = await import('../client-runtime/cancellation-contract.mjs');
const staleSummary = {
  agent: { runId: 'same-run', status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' } },
  workflowRecovery: { resourceRelease: { confirmed: false, status: 'pending', resources: [{ kind: 'agent', id: 'same-run', confirmed: false, status: 'pending' }] } },
};
const queryBefore = JSON.stringify(staleSummary);
assert.equal(resourceReleaseBarrier(staleSummary), null);
assert.equal(JSON.stringify(staleSummary), queryBefore, 'barrier inspection must not write reconciliation');
assert.equal(reconcileResourceRelease(staleSummary).changed, true);
assert.equal(reconcileResourceRelease(staleSummary).changed, false);
const mismatched = structuredClone(staleSummary);
mismatched.workflowRecovery.resourceRelease = { confirmed: false, status: 'pending', resources: [{ kind: 'agent', id: 'lost-old-run', confirmed: false, status: 'pending' }] };
assert.ok(resourceReleaseBarrier(mismatched), 'a new run ID is not proof the old execution exited');
const orphanRelease = await boundedService.releaseResources(mismatched);
assert.equal(orphanRelease.confirmed, false, 'retrying resource release must not clear an unmatched old execution');
assert.equal(orphanRelease.resources.find(item => item.id === 'lost-old-run').status, 'unconfirmed');
assert.ok(resourceReleaseBarrier(mismatched));
const orphanStopService = createMissionControlService({
  loadState: async () => ({ ...structuredClone(mismatched), activeMissionId: 'MIS_ORPHAN', missions: [{ id: 'MIS_ORPHAN', status: 'running' }] }),
  persistState: async state => state,
  agentRuntime: { cancelRun: async () => { throw new Error('must not guess the owner of an unmatched run'); } },
  operatorTestQueue: { cancel: async () => { throw new Error('no queue resource is active'); } },
  appendRuntimeEvent: () => {}, addAuditEvent: () => {},
});
const orphanStop = await orphanStopService.stopMission();
assert.equal(orphanStop.statusCode, 202, 'durable stop intent must retain unresolved old execution identities');
assert.ok(resourceReleaseBarrier(orphanStop.state));
const noIdentity = { workflowRecovery: { resourceRelease: { confirmed: false, status: 'unconfirmed', reason: 'missing ownership information' } } };
const unknownRelease = await boundedService.releaseResources(noIdentity);
assert.equal(unknownRelease.confirmed, false, 'missing ownership metadata is not evidence of release');
assert.equal(unknownRelease.resources[0].error.code, 'MISSION_RESOURCE_IDENTITY_UNAVAILABLE');

console.log('[agent-cancellation-liveness] reusable release is bounded, late-state isolated and barrier-safe');
