// Application contract: all Agent/workspace effects are injected fakes.
import assert from 'node:assert/strict';
import { createAgentRoundService } from '../client-runtime/application/agent-round-service.mjs';
import { retrieveExperienceContext, emptyExperienceStore } from '../client-runtime/experience-contract.mjs';
import { ROUND_BUDGET_MS } from '../client-runtime/round-budget-contract.mjs';

const mission = { id: 'm', projectId: 'p', operator: 'reduce_sum', hardware: ['cpu'] };
const make = (overrides = {}) => {
  const calls = []; let clock = 1000; let captured;
  const ports = {
    nowMs: () => clock,
    resetMissionRunState: () => calls.push('reset'),
    resetMissionWorkspace: async () => calls.push('workspace'),
    createWorkspaceCheckpoint: async () => { calls.push('checkpoint'); return { id: 'cp' }; },
    startAgentRun: (state) => { calls.push('fallback'); state.agent = { runId: 'fixture-run' }; }, appendRuntimeEvent: () => calls.push('event'),
    isManagedWorkspaceRuntimeMode: (mode) => mode === 'managed',
    roundExperience: {
      collect: async () => { calls.push('collect'); return { skipped: 1 }; },
      prepare: async ({ state, roundId }) => {
        calls.push('experience'); assert.equal(state.iterationStats.roundBudget.roundId, roundId);
        const context = retrieveExperienceContext(emptyExperienceStore(), { projectId: 'p', missionId: 'm', roundId, scope: { operator: 'reduce_sum', hardware: ['cpu'] } }, { now: '2026-09-07T12:00:00.000Z' });
        state.iterationStats.roundExperience = context; return context;
      },
    },
    agentRuntime: { startRun: async (input) => { calls.push('agent'); captured = input; return { handled: true, state: { ...input.state, started: true } }; } },
    ...overrides,
  };
  return { service: createAgentRoundService(ports), calls, ports, setClock: (value) => { clock = value; }, captured: () => captured };
};
const input = (state, runtimeMode = 'managed') => ({ state, mission, goal: 'g', workspace: '/w', runtimeMode });
const stateFor = () => ({ activeMissionId: 'm', iterationStats: {}, workflowRecovery: { checkpoints: [] } });

const managed = make(); const state = stateFor();
const result = await managed.service.startRound(input(state));
assert.equal(result.started, true); assert.equal(state.workflowRecovery.checkpoints.length, 1);
assert.deepEqual(managed.calls, ['collect', 'experience', 'reset', 'checkpoint', 'agent']);
assert.equal(managed.captured().experienceContext, state.iterationStats.roundExperience);
assert.equal(managed.captured().roundId, 'm:round:1');
assert.equal(result.iterationStats.roundExperience, managed.captured().experienceContext);
assert.equal(Date.parse(state.iterationStats.roundBudget.deadlineAt) - Date.parse(state.iterationStats.roundBudget.startedAt), ROUND_BUDGET_MS);

const blocked = make({ roundExperience: { collect: async () => ({}), prepare: async () => { throw Object.assign(new Error('lookup unavailable'), { code: 'ROUND_EXPERIENCE_TIMEOUT' }); } } });
await assert.rejects(blocked.service.startRound(input(stateFor())), (error) => error.code === 'ROUND_EXPERIENCE_TIMEOUT');
assert.deepEqual(blocked.calls, []);

const late = make();
late.ports.roundExperience.prepare = async () => { late.setClock(1000 + ROUND_BUDGET_MS); return {}; };
await assert.rejects(late.service.startRound(input(stateFor())), (error) => error.code === 'ROUND_BUDGET_EXCEEDED');
assert.equal(late.calls.includes('agent'), false); assert.equal(late.calls.includes('reset'), false);

const fixture = make({ agentRuntime: { startRun: async () => ({ handled: false }) } });
const fixtureState = stateFor(); await fixture.service.startRound(input(fixtureState, 'reference-fixture'));
assert.deepEqual(fixture.calls, ['collect', 'experience', 'reset', 'workspace', 'fallback', 'event']);
assert.ok(fixtureState.iterationStats.roundExperience);

assert.throws(() => createAgentRoundService({ ...managed.ports, roundExperience: undefined }), /roundExperience/);
assert.throws(() => createAgentRoundService({ ...managed.ports, nowMs: undefined }), /nowMs/);
console.log('[agent-round-service] budget start, frozen experience, failure barriers, managed and fixture launch contracts passed');
