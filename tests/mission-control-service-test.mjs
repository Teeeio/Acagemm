import assert from 'node:assert/strict';
import { createMissionControlService } from '../client-runtime/application/mission-control-service.mjs';
import { createMissionControlRoutes } from '../client-runtime/server/mission-control-routes.mjs';

let state = { activeMissionId: 'mission-1', missionPaused: true, missions: [{ id: 'mission-1', status: 'ready' }], iterationStats: {}, benchmark: { status: 'running', testTaskId: 'task-1' }, agent: { runId: 'run-1', status: 'running' } };
const cancellations = [];
const events = [];
const service = createMissionControlService({
  loadState: async () => structuredClone(state), persistState: async (next) => next,
  agentRuntime: { cancelRun: async ({ state: next, runId }) => { cancellations.push(['agent', runId]); return { state: next, result: { status: 'cancel_requested' } }; } },
  operatorTestQueue: { cancel: async (taskId) => cancellations.push(['test', taskId]) },
  appendRuntimeEvent: (_state, type) => events.push(type), addAuditEvent: () => {},
  now: () => new Date('2026-09-02T00:00:00.000Z'), createId: () => 'fixed',
});
await assert.rejects(() => service.cancelRun('other', 'run-1'), (error) => error.code === 'AGENT_MISSION_MISMATCH');
assert.equal((await service.cancelRun('mission-1', 'run-1')).result.status, 'cancel_requested');
assert.equal((await service.addHumanFeedback({ note: 'x' })).payload.code, 'HUMAN_FEEDBACK_REQUIRED');
const feedback = await service.addHumanFeedback({ note: ' try another tile ' });
assert.equal(feedback.feedback.id, 'feedback_fixed');
assert.equal(feedback.state.iterationStats.pendingInjection.direction, 'human_feedback');
const stopped = await service.stopMission();
assert.equal(stopped.state.missionPaused, true);
assert.equal(stopped.state.missions[0].status, 'stopped');
assert.deepEqual(cancellations, [['agent', 'run-1'], ['test', 'task-1'], ['agent', 'run-1']]);
assert.deepEqual(events, ['mission.human_feedback_added', 'mission.stopped']);

const responses = [];
const routes = createMissionControlRoutes({ json: (_response, status, body) => responses.push({ status, body }), readJson: async () => ({ note: 'go' }), missionControl: service });
await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/actions/human-feedback' } });
assert.equal(responses[0].status, 202);
console.log('[mission-control-service] cancellation, feedback, stop, and route contracts passed');
