import assert from 'node:assert/strict';
import { evaluateAcceptGate } from '../client-runtime/state-store.mjs';
import { createSemanticSnapshot, createSemanticTaskBinding, freezeSemanticSnapshot } from '../client-runtime/semantic-snapshot.mjs';

const source = {
  authority: 'upstream',
  repository: 'https://example.test/operator.git',
  commit: 'a'.repeat(40),
  path: 'reference/run.py',
  expandedSingleFile: true,
};
const mission = {
  id: 'MIS_GATE_SEMANTIC',
  title: 'Semantic gate operator',
  goal: 'optimize operator latency p50',
  metric: 'latency p50',
  hardware: ['C500'],
  testMatrix: {
    correctnessCases: 24,
    environments: ['C500'],
    testSpec: {
      schemaVersion: 'operator-studio.test-spec/v1',
      correctness: { requestedCases: 24, requiredCategories: ['minimal'] },
      benchmark: { requiredProfiles: ['primary'], primaryProfile: 'primary' },
    },
  },
  baseline: {
    required: true,
    kind: 'pytorch_reference',
    status: 'complete',
    source,
    evidence: { kind: 'pytorch_reference', status: 'complete', environment: 'C500', value: 100, unit: 'us', shapeKey: JSON.stringify({ correctnessCases: 24 }), liveHardware: true, source },
  },
};
const snapshot = freezeSemanticSnapshot(createSemanticSnapshot({ mission, semanticDraft: { operator: 'semantic-gate-operator' } }));
const binding = createSemanticTaskBinding(snapshot, { testSpec: snapshot.testSpec, oracleDigest: 'sha256:oracle', baselineDigest: 'sha256:baseline' });
const result = {
  semanticBinding: binding,
  benchmark: [{ environment: 'C500', value: 80, unit: 'us', profile: 'primary', correctness: { passed: true, total: 24 } }],
  tracer: { format: 'operator-trace/v1', events: [{ name: 'kernel' }] },
  profiler: { format: 'operator-profile/v1', metrics: { kernelDurationUs: 20 } },
  environment: { liveHardware: true, service: 'local-c500-adapter' },
};
const state = {
  activeMissionId: mission.id,
  missions: [{ ...mission, semanticSnapshot: snapshot }],
  mission,
  semanticSnapshot: snapshot,
  baseline: mission.baseline,
  testMatrix: mission.testMatrix,
  benchmark: { purpose: 'candidate', matrix: { correctnessCases: 24 }, semanticBinding: binding },
  currentBest: { candidateId: null, value: '--' },
  iterationStats: {},
};

const accepted = evaluateAcceptGate(state, result);
assert.equal(accepted.passed, true);
assert.ok(accepted.passedRules.includes('semantic.snapshot_binding'));

const missing = evaluateAcceptGate({ ...state, benchmark: { ...state.benchmark, semanticBinding: null } }, { ...result, semanticBinding: null });
assert.equal(missing.passed, false);
assert.ok(missing.failedRules.includes('semantic.snapshot_binding'));

const tampered = evaluateAcceptGate(state, { ...result, semanticBinding: { ...binding, semanticDigest: 'sha256:tampered' } });
assert.equal(tampered.passed, false);
assert.ok(tampered.failedRules.includes('semantic.snapshot_binding'));

const staleSpec = evaluateAcceptGate(state, { ...result, semanticBinding: { ...binding, testSpecDigest: 'sha256:stale' } });
assert.equal(staleSpec.passed, false);
assert.ok(staleSpec.failedRules.includes('semantic.snapshot_binding'));

console.log('[accept-gate-semantic-extreme] frozen snapshot binding is required and tamper resistant');
