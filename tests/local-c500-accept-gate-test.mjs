import assert from 'node:assert/strict';
import { evaluateLocalAcceptGate, adoptAcceptedCandidate } from '../tools/local-c500-tester/accept-gate.mjs';

const base = {
  baseline: { status: 'complete', source: 'authoritative_library_reference', latency_p50_us: 100, shapeKey: 'shape-1', runner: 'local-c500' },
  candidate: { id: 'candidate-001', digest: 'sha256:candidate-001' },
  result: {
    candidate: { digest: 'sha256:candidate-001' },
    matrix: { shapeKey: 'shape-1' },
    correctness: 'pass',
    benchmark: { status: 'completed', latency_p50_us: 80, speedup: 1.25 },
    tracer: { status: 'completed' },
    profiler: { status: 'completed' },
    environment: { liveHardware: true, source: 'local-c500' },
  },
  currentBest: null,
};

const accepted = evaluateLocalAcceptGate(base);
assert.equal(accepted.passed, true);
assert.equal(accepted.publishable, true);
assert.equal(accepted.result, 'adopt');

const mock = evaluateLocalAcceptGate({
  ...base,
  result: { ...base.result, environment: { liveHardware: false, source: 'simulation' } },
});
assert.equal(mock.passed, true);
assert.equal(mock.publishable, false);
assert.equal(mock.result, 'reference');
assert.match(mock.failedRules.join(','), /evidence.provenance/);

const mismatch = evaluateLocalAcceptGate({
  ...base,
  result: { ...base.result, candidate: { digest: 'sha256:other' } },
});
assert.equal(mismatch.passed, false);
assert.equal(mismatch.result, 'reject');
assert.match(mismatch.failedRules.join(','), /candidate.digest/);

const regression = evaluateLocalAcceptGate({
  ...base,
  currentBest: { speedup: 1.5 },
  result: { ...base.result, benchmark: { ...base.result.benchmark, speedup: 1.25 } },
});
assert.equal(regression.passed, false);
assert.equal(regression.result, 'reference');

const adoption = adoptAcceptedCandidate({ gate: accepted, candidate: base.candidate, experience: { title: 'fast path' } });
assert.equal(adoption.adopted, true);
assert.equal(adoption.currentBest.candidate_id, 'candidate-001');
assert.equal(adoption.experience.status, 'validated');

process.stdout.write('[local-c500-accept-gate] gate, provenance and adoption policy passed\n');
