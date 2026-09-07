import assert from 'node:assert/strict';
import { createRuntimeMaintenanceService } from '../client-runtime/application/runtime-maintenance-service.mjs';

const calls = [];
const service = createRuntimeMaintenanceService({
  isManagedWorkspaceRuntimeMode: (mode) => mode === 'managed',
  runKnowledgeMaintenance: (state) => { calls.push('knowledge'); return { ...state, curated: true }; },
  runAutomaticAdoption: (state) => { calls.push('adopt'); return { ...state, adopted: true }; },
  isMaximizeMission: () => false,
  refreshReferenceBenchmark: (state) => { calls.push('fixture-benchmark'); return { ...state, benchmark: { ...state.benchmark, progress: 100 } }; },
  refreshReferenceAgent: (state) => { calls.push('fixture-agent'); return { state: { ...state, fixtureAdvanced: true }, changed: true }; },
});
const base = () => ({
  activeMissionId: 'm1', missions: [{ id: 'm1' }],
  stage: 'evidence', agent: { runtimeKind: 'managed' },
  benchmark: { status: 'complete', testTaskId: 'task1' },
  decisionReview: { status: 'auto_ready', recommendation: 'adopt', gate: { passed: true } },
  knowledgeMaintenance: { status: 'idle' },
});
let state = base();
let result = service.advance({ state, runtimeMode: 'managed' });
assert.equal(result.changed, true);
assert.equal(result.state.adopted, true);
assert.deepEqual(calls.splice(0), ['adopt']);

state = base();
state.missions[0].projectRoot = '/project';
result = service.advance({ state, runtimeMode: 'managed' });
assert.equal(result.changed, false, 'three-layer repository adoption remains owned by its application service');
assert.deepEqual(calls.splice(0), []);

state = base();
state.decisionReview.status = 'awaiting_review';
result = service.advance({ state, runtimeMode: 'managed' });
assert.equal(result.changed, false);
assert.deepEqual(calls.splice(0), []);

state = base();
state.stage = 'diagnosis';
state.benchmark = { status: 'idle' };
result = service.advance({ state, runtimeMode: 'reference-fixture' });
assert.equal(result.state.fixtureAdvanced, true);
assert.deepEqual(calls.splice(0), ['fixture-benchmark', 'fixture-agent']);

state.agent.runId = 'cli_live';
result = service.advance({ state, runtimeMode: 'reference-fixture' });
assert.equal(result.changed, false);
assert.deepEqual(calls.splice(0), [], 'fixture projection cannot advance a real Agent');

state = base();
state.stage = 'curation';
state.knowledgeMaintenance.status = 'ready';
result = service.advance({ state, runtimeMode: 'managed' });
assert.equal(result.state.curated, true);
assert.deepEqual(calls.splice(0), ['knowledge']);
console.log('[runtime-maintenance] extracted policy and fixture isolation passed');
