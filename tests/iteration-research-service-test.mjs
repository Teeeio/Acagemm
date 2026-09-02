import assert from 'node:assert/strict';
import { createIterationResearchService } from '../client-runtime/application/iteration-research-service.mjs';

const calls = [];
const state = { agent: { status: 'idle' } };
const service = createIterationResearchService({
  mkdir: async (...args) => calls.push(['mkdir', ...args]),
  isManagedWorkspaceRuntimeMode: (mode) => mode === 'managed',
  agentRuntime: { mode: 'managed', startResearch: async (input) => { calls.push(['start', input]); return { state: { ...input.state, started: true } }; }, cancelRun: async (input) => ({ ...input.state, cancelled: input.runId }) },
});
assert.equal((await service.startResearch({ state, mission: { id: 'm' }, direction: 'x', workspace: '/w', synchronous: false, runPhase: 'experience' })).started, true);
assert.equal(calls[1][1].runPhase, 'experience');
assert.deepEqual(await service.cancelResearch({ state, runId: 'r1' }), { ...state, cancelled: 'r1' });
const noop = createIterationResearchService({ mkdir: async () => { throw new Error('must not call'); }, isManagedWorkspaceRuntimeMode: () => false, agentRuntime: { mode: 'reference-fixture', startResearch: async () => ({ state: null }), cancelRun: async () => ({}) } });
assert.equal(await noop.startResearch({ state, mission: {}, direction: 'x', workspace: '/w' }), state);
console.log('[iteration-research-service] managed start, cancellation, and unmanaged no-op contracts passed');
