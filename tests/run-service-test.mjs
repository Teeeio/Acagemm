import assert from 'node:assert/strict';
import { createRunService } from '../client-runtime/application/run-service.mjs';

const base = { activeMissionId: 'MIS_1', missions: [{ id: 'MIS_1', goal: 'optimize' }], iterationStats: {}, baseline: { status: 'complete' } };
const make = (overrides = {}) => ({ loadState: async () => structuredClone({ ...base, ...overrides.state }), persistState: async (state) => state, executeCommand: async ({ type, state }) => ({ status: 'applied', state, result: { runId: `RUN_${type}` } }), journal: {}, registry: {}, agentRuntime: { async describe() { return { mode: 'fixture' }; } }, buildRuntimePreflight: async () => ({ ready: true, workspace: '/tmp/workspace' }), assertMissionIntent() {}, isStrictZeroSourceMission: () => false, isFixedOperatorMission: () => false, ...overrides });
const service = createRunService(make());
assert.equal((await service.start('MIS_1', {})).result.result.runId, 'RUN_runs');
await assert.rejects(service.start('missing', {}), (error) => error.code === 'MISSION_NOT_FOUND');
const fixed = createRunService(make({ isFixedOperatorMission: () => true }));
assert.equal((await fixed.start('MIS_1', {})).kind, 'armed');
const strict = createRunService(make({ state: { baseline: { status: 'idle' } }, isStrictZeroSourceMission: () => true, selectResearchBaselineSource: () => null }));
assert.equal((await strict.start('MIS_1', {})).kind, 'research');
console.log('[run-service] Agent, fixed-operator, strict-zero-source, preflight, and mission guards passed');
