// Independent Phase 2 acceptance for the frozen diagnostic/decision contract.
//
// Authority: docs/development/P2_EVIDENCE_ACCEPTANCE.md (owned by the upstream
// reviewer; this test must not edit it) and TEAM_HANDOFF.md 6.12.
//
// This file encodes the frozen matrix, not the current implementation:
//   - evaluateDiagnosticEvidence(kind, evidence, expectedBinding) is the public
//     diagnostic contract with schemaValid / available / evidenceEligible /
//     reasons.
//   - evaluateAcceptGate returns the versioned `decision` DTO next to its
//     compatible flat fields, and the flat fields are projections of it.
// Until client-runtime/evidence-decision.mjs and the decision DTO are
// integrated these assertions fail; that is the expected hand-off state, not a
// reason to weaken them. Valid real test doubles below are contract fixtures,
// never proof of an actual live publication.
import assert from 'node:assert/strict';
import { evaluateAcceptGate } from '../client-runtime/accept-gate.mjs';
import { evaluateDiagnosticEvidence } from '../client-runtime/evidence-decision.mjs';
import {
  createSemanticSnapshot,
  createSemanticTaskBinding,
  freezeSemanticSnapshot,
} from '../client-runtime/semantic-snapshot.mjs';

const digest = (char) => `sha256:${char.repeat(64)}`;

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Diagnostic contract: evaluateDiagnosticEvidence
// ---------------------------------------------------------------------------

const EXPECTED_BINDING = deepFreeze({
  missionId: 'MIS_P2',
  candidateId: 'candidate-p2',
  candidateDigest: digest('c'),
  runId: 'run-p2-benchmark',
  taskId: 'remote-task-p2',
  sourceRunId: 'run-p2-source',
  semanticDigest: digest('b'),
});

const binding = (overrides = {}) => deepFreeze({ ...EXPECTED_BINDING, ...overrides });

const tracerEvidence = (overrides = {}) => deepFreeze({
  format: 'operator-trace/v1',
  status: 'completed',
  source: 'mctracer',
  simulated: false,
  binding: binding(),
  artifacts: ['artifacts/mctracer/stdout.json'],
  // A qualified kernel trace needs an explicit kernel-category event; a missing
  // category, `runtime` or `tool` events are not kernel measurements.
  events: [{ category: 'kernel', name: 'paged_decode_kernel', startUs: 0, durationUs: 12.5 }],
  ...overrides,
});

const profilerEvidence = (overrides = {}) => deepFreeze({
  format: 'operator-profile/v1',
  status: 'completed',
  source: 'mcProfiler',
  simulated: false,
  binding: binding(),
  artifacts: ['artifacts/mcProfiler/stdout.json'],
  metrics: { kernelDurationUs: 12.5, occupancy: 0.62, bandwidth: 412.5 },
  ...overrides,
});

const evaluateSafely = (kind, evidence, expectedBinding) => {
  try {
    return { dto: evaluateDiagnosticEvidence(kind, evidence, expectedBinding) };
  } catch (error) {
    return { error };
  }
};

const LEGITIMATE_EXPECTATIONS = {
  schemaValid: true,
  available: true,
  evidenceEligible: true,
};

const runDiagnosticCase = (label, kind, evidence, expectedBinding, expected) => {
  const evidenceBefore = structuredClone(evidence);
  const expectedBefore = expectedBinding === undefined ? undefined : structuredClone(expectedBinding);
  const { dto, error } = evaluateSafely(kind, evidence, expectedBinding);
  assert.equal(error, undefined, `${label}: evaluateDiagnosticEvidence must not throw for this contract input (${error?.message})`);
  assert.ok(dto && typeof dto === 'object' && !Array.isArray(dto), `${label}: must return a plain DTO object`);
  assert.deepEqual(evidence, evidenceBefore, `${label}: the evidence input must never be mutated`);
  if (expectedBefore !== undefined) {
    assert.deepEqual(expectedBinding, expectedBefore, `${label}: the expected binding input must never be mutated`);
  }
  for (const key of ['schemaValid', 'available', 'evidenceEligible']) {
    assert.equal(typeof dto[key], 'boolean', `${label}: ${key} must be a boolean`);
  }
  assert.ok(Array.isArray(dto.reasons), `${label}: reasons must be an array`);
  for (const reason of dto.reasons) {
    assert.equal(typeof reason, 'string', `${label}: every reason must be a stable string code`);
    assert.notEqual(reason.trim(), '', `${label}: reason codes must not be empty`);
  }
  assert.equal(dto.schemaValid, expected.schemaValid, `${label}: schemaValid`);
  assert.equal(dto.available, expected.available, `${label}: available`);
  assert.equal(dto.evidenceEligible, expected.evidenceEligible, `${label}: evidenceEligible`);
  if (!expected.available) {
    assert.equal(dto.evidenceEligible, false, `${label}: unavailable evidence can never be eligible`);
  }
  if (expected.evidenceEligible) {
    assert.deepEqual(dto.reasons, [], `${label}: qualified evidence keeps no blocking reasons`);
  } else {
    assert.ok(dto.reasons.length > 0, `${label}: rejected evidence must carry explicit reason codes`);
  }
  const repeat = evaluateDiagnosticEvidence(kind, evidence, expectedBinding);
  assert.deepEqual(repeat, dto, `${label}: evaluation must be deterministic`);
  return dto;
};

const diagnosticCases = [
  // --- four frozen provenance groups, tracer ---------------------------------
  ['tracer: valid real kernel measurement', 'tracer', tracerEvidence(), EXPECTED_BINDING, LEGITIMATE_EXPECTATIONS],
  ['tracer: unavailable tool', 'tracer', tracerEvidence({ status: 'unavailable', events: [] }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['tracer: mocked provenance', 'tracer', tracerEvidence({ status: 'mocked', source: 'mock', simulated: true }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['tracer: format-valid but wrong candidate digest', 'tracer', tracerEvidence({ binding: binding({ candidateDigest: digest('f') }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: wrong benchmark runId', 'tracer', tracerEvidence({ binding: binding({ runId: 'run-other' }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: wrong sourceRunId', 'tracer', tracerEvidence({ binding: binding({ sourceRunId: 'run-source-other' }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: wrong backend taskId', 'tracer', tracerEvidence({ binding: binding({ taskId: 'remote-task-other' }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: wrong frozen semanticDigest', 'tracer', tracerEvidence({ binding: binding({ semanticDigest: digest('e') }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: missing candidate identity in observation', 'tracer', tracerEvidence({ binding: binding({ candidateDigest: null }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: missing run identity in observation', 'tracer', tracerEvidence({ binding: binding({ runId: null }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: binding absent entirely', 'tracer', tracerEvidence({ binding: null }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: empty binding object', 'tracer', tracerEvidence({ binding: {} }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  // --- missing expectation cannot qualify real evidence ----------------------
  ['tracer: expectation lacks candidate digest', 'tracer', tracerEvidence(), binding({ candidateDigest: null }), { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: expectation lacks runId', 'tracer', tracerEvidence(), binding({ runId: null }), { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: expectation is absent', 'tracer', tracerEvidence(), undefined, { schemaValid: true, available: true, evidenceEligible: false }],
  // --- format valid, content invalid ----------------------------------------
  ['tracer: empty events', 'tracer', tracerEvidence({ events: [] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: arbitrary event keys only', 'tracer', tracerEvidence({ events: [{}] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  // A tracer envelope without an events collection is not a valid envelope at
  // all: the format predicate (schemaValid) is independent from real completion
  // (available) and qualification (evidenceEligible).
  ['tracer: unknown keys instead of events', 'tracer', tracerEvidence({ events: undefined, foo: 'bar' }), EXPECTED_BINDING, { schemaValid: false, available: false, evidenceEligible: false }],
  ['tracer: events of the wrong type', 'tracer', tracerEvidence({ events: { name: 'k' } }), EXPECTED_BINDING, { schemaValid: false, available: false, evidenceEligible: false }],
  ['tracer: kernel event without an explicit category', 'tracer', tracerEvidence({ events: [{ name: 'paged_decode_kernel', startUs: 0, durationUs: 12.5 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: runtime category event', 'tracer', tracerEvidence({ events: [{ category: 'runtime', name: 'cudaLaunchKernel', startUs: 0, durationUs: 1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: unknown category event', 'tracer', tracerEvidence({ events: [{ category: 'mystery', name: 'paged_decode_kernel', startUs: 0, durationUs: 1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: one valid kernel mixed with an invalid kernel', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'good_kernel', startUs: 0, durationUs: 5 }, { category: 'kernel', name: 'bad_kernel', startUs: 0, durationUs: -1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: string startUs', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'k', startUs: '0', durationUs: 1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: NaN startUs', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'k', startUs: Number.NaN, durationUs: 1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: Infinity durationUs', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'k', startUs: 0, durationUs: Number.POSITIVE_INFINITY }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: negative startUs', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'k', startUs: -1, durationUs: 1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: zero durationUs', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'k', startUs: 0, durationUs: 0 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: negative durationUs', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'k', startUs: 0, durationUs: -3 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: unnamed kernel event', 'tracer', tracerEvidence({ events: [{ category: 'kernel', startUs: 0, durationUs: 1 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: tool-only trace events', 'tracer', tracerEvidence({ events: [{ category: 'tool', name: 'mctracer', startUs: 0, durationUs: 12.5 }] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['tracer: raw artifact path with no measured events', 'tracer', tracerEvidence({ events: [], artifacts: ['artifacts/mctracer/stdout.json'] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  // Real kernel content whose duration happens to equal a benchmark latency is
  // still real content: provenance decides truth, not numeric coincidence.
  ['tracer: real kernel duration coincidentally equals benchmark latency', 'tracer', tracerEvidence({ events: [{ category: 'kernel', name: 'paged_decode_kernel', startUs: 0, durationUs: 41.8 }] }), EXPECTED_BINDING, LEGITIMATE_EXPECTATIONS],
  ['tracer: artifact metadata marks simulated provenance under a completed status', 'tracer', tracerEvidence({ artifacts: [{ path: 'artifacts/mctracer/stdout.json', simulated: true }] }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  // --- missing status/source never proves availability -----------------------
  ['tracer: status missing', 'tracer', tracerEvidence({ status: undefined, events: [] }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['tracer: status ok is not a completed real collection', 'tracer', tracerEvidence({ status: 'ok' }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['tracer: source missing', 'tracer', tracerEvidence({ source: undefined }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['tracer: unknown source while a tool artifact is present', 'tracer', tracerEvidence({ source: 'unknown' }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['tracer: simulated even though status completed', 'tracer', tracerEvidence({ status: 'completed', simulated: true, source: 'mock' }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  // --- wrong format ---------------------------------------------------------
  ['tracer: profiler format under tracer kind', 'tracer', profilerEvidence(), EXPECTED_BINDING, { schemaValid: false, available: false, evidenceEligible: false }],

  // --- profiler: four provenance groups -------------------------------------
  ['profiler: valid kernelDurationUs', 'profiler', profilerEvidence(), EXPECTED_BINDING, LEGITIMATE_EXPECTATIONS],
  ['profiler: valid without optional occupancy/bandwidth', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 7.25 } }), EXPECTED_BINDING, LEGITIMATE_EXPECTATIONS],
  ['profiler: unavailable tool', 'profiler', profilerEvidence({ status: 'unavailable', metrics: {} }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['profiler: mocked provenance', 'profiler', profilerEvidence({ status: 'mocked', source: 'mock', simulated: true }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['profiler: wrong candidate digest', 'profiler', profilerEvidence({ binding: binding({ candidateDigest: digest('f') }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: wrong run identity', 'profiler', profilerEvidence({ binding: binding({ runId: 'run-other' }) }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  // --- profiler content rules ----------------------------------------------
  ['profiler: empty metrics', 'profiler', profilerEvidence({ metrics: {} }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: arbitrary metric keys only', 'profiler', profilerEvidence({ metrics: { foo: 1 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: benchmark-only p50/p95 metrics', 'profiler', profilerEvidence({ metrics: { p50Us: 41.8, p95Us: 52.1, latencyUs: 41.8 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: tool process duration only', 'profiler', profilerEvidence({ metrics: { toolDurationUs: 812.4 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: string kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: '12.5' } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: boolean kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: true } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: array kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: [12.5] } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: object kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: { value: 12.5 } } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  // A metric explicitly sourced from benchmark latency is not profiler
  // measurement, even when its numeric value is plausible.
  ['profiler: kernelDurationUs explicitly sourced from benchmark', 'profiler', profilerEvidence({ source: 'benchmark', metrics: { kernelDurationUs: 41.8 } }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  // Conversely, a real tool collection whose kernelDurationUs coincides with the
  // benchmark latency stays eligible; equality is not forgery evidence.
  ['profiler: real kernelDurationUs coincidentally equals benchmark latency', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 41.8 } }), EXPECTED_BINDING, LEGITIMATE_EXPECTATIONS],
  ['profiler: NaN kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: Number.NaN } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: Infinity kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: Number.POSITIVE_INFINITY } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: zero kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 0 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: negative kernelDurationUs', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: -2 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: occupancy above one', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, occupancy: 1.4 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: negative occupancy', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, occupancy: -0.1 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: NaN occupancy', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, occupancy: Number.NaN } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: achievedOccupancy above one', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, achievedOccupancy: 1.2 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: string achievedOccupancy', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, achievedOccupancy: '0.6' } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: negative dramBandwidthGbps', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, dramBandwidthGbps: -0.1 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: Infinity dramBandwidthGbps', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, dramBandwidthGbps: Number.POSITIVE_INFINITY } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: valid achievedOccupancy and dramBandwidthGbps', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, achievedOccupancy: 0.62, dramBandwidthGbps: 412.5 } }), EXPECTED_BINDING, LEGITIMATE_EXPECTATIONS],
  ['profiler: negative bandwidth', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, bandwidth: -1 } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: Infinity bandwidth', 'profiler', profilerEvidence({ metrics: { kernelDurationUs: 12.5, bandwidth: Number.POSITIVE_INFINITY } }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: raw artifact path proves no measurement', 'profiler', profilerEvidence({ metrics: {}, artifacts: ['artifacts/mcProfiler/stdout.json'] }), EXPECTED_BINDING, { schemaValid: true, available: true, evidenceEligible: false }],
  ['profiler: status missing', 'profiler', profilerEvidence({ status: undefined, metrics: {} }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['profiler: source missing', 'profiler', profilerEvidence({ source: undefined }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['profiler: simulated even though status completed', 'profiler', profilerEvidence({ status: 'completed', simulated: true, source: 'mock' }), EXPECTED_BINDING, { schemaValid: true, available: false, evidenceEligible: false }],
  ['profiler: tracer format under profiler kind', 'profiler', tracerEvidence(), EXPECTED_BINDING, { schemaValid: false, available: false, evidenceEligible: false }],
];

for (const [label, kind, evidence, expectedBinding, expected] of diagnosticCases) {
  deepFreeze(evidence);
  runDiagnosticCase(label, kind, evidence, expectedBinding, expected);
}

// Fail-closed inputs must never be reported as schema-valid, available or
// eligible evidence; throwing is an acceptable fail-closed implementation.
for (const [label, kind, evidence] of [
  ['tracer: null evidence', 'tracer', null],
  ['tracer: array evidence', 'tracer', []],
  ['tracer: string evidence', 'tracer', 'operator-trace/v1'],
  ['profiler: null evidence', 'profiler', null],
  ['tracer: empty object', 'tracer', {}],
  ['profiler: empty object', 'profiler', {}],
  ['tracer: unknown kind', 'kernel-summary', tracerEvidence()],
  ['profiler: unknown kind', 'latency', profilerEvidence()],
]) {
  const { dto, error } = evaluateSafely(kind, evidence, EXPECTED_BINDING);
  if (error) continue; // fail-closed by rejection
  assert.ok(dto && typeof dto === 'object', `${label}: a returned DTO is required when not rejecting`);
  assert.equal(dto.schemaValid, false, `${label}: malformed input must not be schema-valid`);
  assert.equal(dto.available, false, `${label}: malformed input must never be available`);
  assert.equal(dto.evidenceEligible, false, `${label}: malformed input must never be eligible`);
  assert.ok(Array.isArray(dto.reasons) && dto.reasons.length > 0, `${label}: explicit reason codes are required`);
}

// ---------------------------------------------------------------------------
// Decision contract: evaluateAcceptGate
// ---------------------------------------------------------------------------

const MISSION_ID = 'MIS_P2';
const CANDIDATE_ID = 'candidate-p2';
const CANDIDATE_DIGEST = digest('c');
const RUN_ID = 'run-p2-benchmark';
const SOURCE_RUN_ID = 'run-p2-source';
const TASK_ID = 'remote-task-p2';

const upstreamSource = {
  authority: 'upstream',
  repository: 'https://github.com/flashinfer-ai/flashinfer.git',
  commit: 'ee3fda10',
  path: 'flashinfer/decode.py',
  operator: 'paged_decode',
  expandedSingleFile: true,
};

const baselineEvidence = {
  required: true,
  kind: 'pytorch_reference',
  status: 'complete',
  source: upstreamSource,
  evidence: {
    kind: 'pytorch_reference',
    status: 'complete',
    environment: 'C500',
    value: 50.0,
    unit: 'us',
    shapeKey: JSON.stringify({ correctnessCases: 24 }),
    liveHardware: true,
    source: upstreamSource,
  },
};

const createState = ({ goal = '将 C500 latency p50 控制在 45 us 以下' } = {}) => ({
  activeMissionId: MISSION_ID,
  appliedCandidateId: CANDIDATE_ID,
  missions: [{ id: MISSION_ID, title: 'P2 Gate', goal, metric: 'latency p50', hardware: ['C500'], baseline: baselineEvidence }],
  stage: 'validation',
  agent: { runtimeKind: 'codex-cli', status: 'executing', messages: [], currentAction: null },
  benchmark: {
    status: 'running',
    testTaskId: 'queue-task-p2',
    remoteTaskId: TASK_ID,
    runId: RUN_ID,
    candidate: { id: CANDIDATE_ID, digest: CANDIDATE_DIGEST, sourceRunId: SOURCE_RUN_ID },
    matrix: { correctnessCases: 24 },
  },
  decisionReview: { status: 'idle', policy: { id: 'policy.test' } },
  candidateEvaluations: [{
    id: CANDIDATE_ID,
    title: 'P2 Candidate',
    version: 'agent.1',
    files: 'kernel.py',
    patchDigest: CANDIDATE_DIGEST,
    hypothesis: 'reduce launch overhead',
    change: 'cache launch plan',
  }],
  failureRecords: [],
  knowledgeDrafts: [],
  runtimeEvents: [],
  auditEvents: [],
  currentBest: { candidateId: null, value: '--' },
  baseline: structuredClone(baselineEvidence),
  knowledgeMaintenance: { status: 'idle' },
  testMatrix: { correctnessCases: 24 },
});

const liveEnv = (overrides = {}) => deepFreeze({
  runtime: 'live-runtime',
  liveHardware: true,
  candidateDigest: CANDIDATE_DIGEST,
  runId: RUN_ID,
  sourceRunId: SOURCE_RUN_ID,
  taskId: TASK_ID,
  ...overrides,
});

const defaultBenchmark = (value = 41.8) => [
  { environment: 'C500', value, unit: 'us' },
  { environment: 'CUDA', value: 35.0, unit: 'us' },
];

const gateResult = ({
  environment,
  tracer = tracerEvidence(),
  profiler = profilerEvidence(),
  benchmark = defaultBenchmark(),
  correctness = true,
  extra = {},
}) => deepFreeze({
  benchmark: benchmark.map((item) => ({ ...item, correctness: { passed: correctness, total: 24 } })),
  tracer,
  profiler,
  environment,
  ...extra,
});

const decisionOf = (gate, label) => {
  assert.ok(gate && typeof gate === 'object', `${label}: evaluateAcceptGate must return an object`);
  for (const flat of ['passed', 'publishable', 'result', 'rules', 'passedRules', 'failedRules', 'evidenceSource']) {
    assert.ok(flat in gate, `${label}: compatible flat field ${flat} must be retained`);
  }
  assert.ok(gate.decision && typeof gate.decision === 'object', `${label}: evaluateAcceptGate must return the versioned decision DTO`);
  return gate.decision;
};

const assertDecisionShape = (decision, label) => {
  assert.equal(decision.schemaVersion, 'operator-studio.evidence-decision/v1', `${label}: decision schemaVersion`);
  assert.equal(typeof decision.policyVersion, 'string', `${label}: policyVersion must be a fixed string`);
  assert.notEqual(decision.policyVersion.trim(), '', `${label}: policyVersion must not be empty`);
  assert.ok(decision.binding && typeof decision.binding === 'object', `${label}: decision.binding`);
  for (const field of ['missionId', 'candidateId', 'candidateDigest', 'runId', 'taskId', 'sourceRunId', 'semanticDigest']) {
    assert.ok(field in decision.binding, `${label}: decision.binding.${field} must stay independently inspectable`);
  }
  assert.ok(decision.execution && typeof decision.execution === 'object', `${label}: decision.execution`);
  assert.ok(['live', 'simulation', 'cpu', 'unknown'].includes(decision.execution.kind), `${label}: unknown execution kind ${decision.execution.kind}`);
  assert.equal(typeof decision.execution.liveHardware, 'boolean', `${label}: execution.liveHardware`);
  assert.equal(typeof decision.correctness?.passed, 'boolean', `${label}: correctness.passed`);
  assert.equal(typeof decision.benchmark?.valid, 'boolean', `${label}: benchmark.valid`);
  for (const kind of ['tracer', 'profiler']) {
    const diag = decision.diagnostics?.[kind];
    assert.ok(diag && typeof diag === 'object', `${label}: decision.diagnostics.${kind}`);
    for (const key of ['schemaValid', 'available', 'evidenceEligible']) {
      assert.equal(typeof diag[key], 'boolean', `${label}: diagnostics.${kind}.${key}`);
    }
    assert.ok(Array.isArray(diag.reasons), `${label}: diagnostics.${kind}.reasons`);
  }
  assert.ok(
    ['allowed', 'reference', 'blocked', 'waiting_external_verification'].includes(decision.adoption?.status),
    `${label}: adoption.status ${decision.adoption?.status}`,
  );
  assert.ok(Array.isArray(decision.adoption?.reasons), `${label}: adoption.reasons`);
  assert.ok(
    ['allowed', 'blocked', 'waiting_external_verification'].includes(decision.publication?.status),
    `${label}: publication.status ${decision.publication?.status}`,
  );
  assert.ok(Array.isArray(decision.publication?.reasons), `${label}: publication.reasons`);
};

const runGateCase = (label, state, result) => {
  const stateBefore = structuredClone(state);
  const resultBefore = structuredClone(result);
  const gate = evaluateAcceptGate(state, result);
  assert.deepEqual(state, stateBefore, `${label}: evaluateAcceptGate must not mutate the input state`);
  assert.deepEqual(result, resultBefore, `${label}: evaluateAcceptGate must not mutate the input result`);
  const decision = decisionOf(gate, label);
  assertDecisionShape(decision, label);
  assert.equal(
    gate.publishable,
    decision.publication.status === 'allowed',
    `${label}: flat publishable must be a projection of decision.publication.status, never re-derived from liveHardware`,
  );
  return { gate, decision };
};

// --- local benchmark-core branch: optional diagnostics, mandatory publication rules
{
  const { gate, decision } = runGateCase(
    'local core / unavailable',
    createState(),
    gateResult({
      environment: liveEnv({ service: 'local-c500-adapter', runtime: 'local-c500-runner/v1' }),
      tracer: tracerEvidence({ status: 'unavailable', events: [] }),
      profiler: profilerEvidence({ status: 'unavailable', metrics: {} }),
    }),
  );
  assert.equal(gate.passed, true, 'local benchmark-core development may adopt with optional diagnostics unavailable');
  assert.equal(decision.diagnostics.tracer.available, false, 'unavailable tracer must not be available');
  assert.equal(decision.diagnostics.profiler.available, false, 'unavailable profiler must not be available');
  assert.equal(decision.adoption.status, 'allowed', 'local development adoption may proceed with publication pending');
  assert.equal(decision.publication.status, 'waiting_external_verification', 'unavailable real diagnostics can never authorize publication');
  assert.equal(gate.publishable, false, 'unavailable diagnostics keep the result nonpublishable');
}
{
  const { gate, decision } = runGateCase(
    'local core / mocked',
    createState(),
    gateResult({
      environment: liveEnv({ service: 'local-c500-adapter', runtime: 'local-c500-runner/v1' }),
      tracer: tracerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
      profiler: profilerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
    }),
  );
  assert.equal(gate.passed, true, 'an explicit local development workflow may exercise mock diagnostics');
  assert.equal(decision.execution.kind, 'live', 'explicit diagnostic mock does not rewrite real execution provenance');
  assert.equal(decision.diagnostics.tracer.available, false, 'mock diagnostics are never available');
  assert.equal(decision.diagnostics.profiler.evidenceEligible, false, 'mock diagnostics are never eligible');
  assert.notEqual(decision.publication.status, 'allowed', 'mock diagnostics can never authorize publication');
}
{
  const { gate, decision } = runGateCase(
    'local core / valid real',
    createState(),
    gateResult({ environment: liveEnv({ service: 'local-c500-adapter', runtime: 'local-c500-runner/v1' }) }),
  );
  assert.equal(gate.passed, true);
  assert.equal(decision.diagnostics.tracer.evidenceEligible, true, 'bound real tracer content is eligible');
  assert.equal(decision.diagnostics.profiler.evidenceEligible, true, 'bound real profiler content is eligible');
  assert.equal(decision.publication.status, 'allowed', 'local real hardware with qualified diagnostics may publish');
  assert.equal(gate.publishable, true);
  assert.equal(decision.binding.candidateDigest, CANDIDATE_DIGEST, 'decision binds the current candidate digest');
  assert.equal(decision.binding.runId, RUN_ID, 'decision binds the benchmark runId');
  assert.equal(decision.binding.taskId, TASK_ID, 'decision binds the backend taskId');
  assert.equal(decision.binding.sourceRunId, SOURCE_RUN_ID, 'decision binds the source run identity');
}
{
  const { gate, decision } = runGateCase(
    'local core / wrong binding',
    createState(),
    gateResult({
      environment: liveEnv({ service: 'local-c500-adapter', runtime: 'local-c500-runner/v1' }),
      tracer: tracerEvidence({ binding: binding({ candidateDigest: digest('d') }) }),
      profiler: profilerEvidence({ binding: binding({ runId: 'run-mismatched' }) }),
    }),
  );
  assert.equal(gate.passed, true, 'local development adoption may proceed while the publication evidence is blocked');
  assert.equal(decision.diagnostics.tracer.available, true, 'a real collection stays available even when its binding is wrong');
  assert.equal(decision.diagnostics.tracer.evidenceEligible, false, 'wrong candidate binding is never eligible');
  assert.equal(decision.diagnostics.profiler.evidenceEligible, false, 'wrong run binding is never eligible');
  assert.ok(decision.publication.reasons.length > 0, 'wrong binding must produce explicit blocking reasons');
  assert.equal(decision.publication.status, 'blocked', 'wrong binding is malformed evidence and must block publication explicitly');
  assert.notEqual(decision.publication.status, 'allowed');
  assert.equal(gate.publishable, false);
}

// --- non-local full branch: both qualified diagnostics are required ---------
{
  const { gate, decision } = runGateCase(
    'non-local full / unavailable',
    createState(),
    gateResult({
      environment: liveEnv(),
      tracer: tracerEvidence({ status: 'unavailable', events: [] }),
      profiler: profilerEvidence({ status: 'unavailable', metrics: {} }),
    }),
  );
  assert.equal(gate.passed, false, 'the full real branch must require both eligible diagnostics');
  assert.ok(gate.failedRules.includes('evidence.complete'), 'the failure must be reported on evidence.complete');
  // Missing real diagnostic capability is recoverable, not a candidate defect:
  // adoption waits for external verification rather than hard-blocking, and
  // publication cannot be allowed while the evidence is missing.
  assert.equal(decision.adoption.status, 'waiting_external_verification', 'missing real tools must wait for external verification');
  assert.equal(decision.publication.status, 'waiting_external_verification', 'missing real tools cannot authorize publication');
  assert.notEqual(decision.publication.status, 'allowed');
}
{
  const { gate, decision } = runGateCase(
    'non-local full / mocked',
    createState(),
    gateResult({
      environment: liveEnv(),
      tracer: tracerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
      profiler: profilerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
    }),
  );
  assert.equal(gate.passed, false, 'mock diagnostics cannot satisfy a required real diagnostic branch');
  assert.ok(gate.failedRules.includes('evidence.complete'), 'missing real diagnostics must be reported on evidence.complete, not as a candidate hard error');
  assert.notEqual(decision.adoption.status, 'allowed', 'mock diagnostics must not be adopted as real evidence');
  assert.notEqual(decision.publication.status, 'allowed', 'mock diagnostics can never authorize publication');
}
{
  const { gate, decision } = runGateCase(
    'non-local full / valid real',
    createState(),
    gateResult({ environment: liveEnv() }),
  );
  assert.equal(gate.passed, true, 'fully qualified real diagnostics satisfy the full branch');
  assert.equal(decision.publication.status, 'allowed');
  assert.equal(gate.publishable, true);
  assert.equal(decision.execution.kind, 'live');
  assert.equal(decision.execution.liveHardware, true);
  assert.equal(decision.correctness.passed, true);
  assert.equal(decision.benchmark.valid, true);
}
{
  const { gate, decision } = runGateCase(
    'non-local full / wrong binding',
    createState(),
    gateResult({
      environment: liveEnv(),
      tracer: tracerEvidence({ binding: binding({ sourceRunId: 'run-source-stale' }) }),
      profiler: profilerEvidence({ binding: binding({ taskId: 'remote-task-stale' }) }),
    }),
  );
  assert.equal(gate.passed, false, 'format-valid evidence bound to another run cannot satisfy the full branch');
  assert.equal(decision.diagnostics.tracer.evidenceEligible, false);
  // Malformed/wrong-binding evidence carries explicit blocking reasons, unlike
  // the recoverable waiting state of merely missing tools.
  assert.equal(decision.adoption.status, 'blocked', 'wrong binding must block adoption explicitly');
  assert.equal(decision.publication.status, 'blocked', 'wrong binding must block publication explicitly');
  assert.notEqual(decision.publication.status, 'allowed');
}

// --- simulation / CPU branches ---------------------------------------------
{
  const { gate, decision } = runGateCase(
    'simulation / explicit signals with liveHardware true',
    createState(),
    gateResult({
      environment: liveEnv({ executionMode: 'simulation', simulated: true, liveHardware: true }),
      tracer: tracerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
      profiler: profilerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
    }),
  );
  assert.equal(decision.execution.kind, 'simulation', 'an explicit simulation signal cannot be overridden by liveHardware=true');
  assert.equal(gate.passed, true, 'simulation can exercise the existing workflow with structured mock evidence');
  assert.equal(decision.diagnostics.tracer.evidenceEligible, false);
  assert.notEqual(decision.publication.status, 'allowed', 'simulation is never publishable');
  assert.equal(gate.publishable, false);
}
{
  const { gate, decision } = runGateCase(
    'cpu / explicit signals',
    createState(),
    gateResult({
      environment: deepFreeze({ runtime: 'cpu-e2e', liveHardware: false, executionMode: 'cpu', hardware: 'cpu' }),
      tracer: tracerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
      profiler: profilerEvidence({ status: 'mocked', source: 'mock', simulated: true }),
    }),
  );
  assert.equal(decision.execution.kind, 'cpu', 'explicit CPU execution is classified as cpu');
  assert.notEqual(decision.publication.status, 'allowed', 'CPU execution is never publishable');
  assert.equal(gate.publishable, false);
}
{
  const { decision } = runGateCase(
    'simulation / contradictory completed diagnostic',
    createState(),
    gateResult({
      environment: liveEnv({ executionMode: 'simulation', simulated: true }),
      tracer: tracerEvidence({ status: 'completed', simulated: true, source: 'mock' }),
      profiler: profilerEvidence({ status: 'completed', simulated: true, source: 'mock' }),
    }),
  );
  assert.equal(decision.diagnostics.tracer.available, false, 'simulated provenance wins over a contradictory completed status');
  assert.equal(decision.diagnostics.profiler.available, false, 'simulated provenance wins over a contradictory completed status');
  assert.notEqual(decision.publication.status, 'allowed');
}
{
  // An environment whose source is an explicit mock cannot be reclassified as
  // live by flipping liveHardware=true, even with otherwise qualified content.
  const { gate, decision } = runGateCase(
    'execution / mock environment source with liveHardware true',
    createState(),
    gateResult({ environment: liveEnv({ source: 'mock', service: 'local-c500-adapter', runtime: 'local-c500-runner/v1' }) }),
  );
  assert.notEqual(decision.execution.kind, 'live', 'a mock environment source cannot be live execution');
  assert.equal(decision.adoption.status, 'allowed', 'the retained structured simulation workflow may adopt locally without publication');
  assert.notEqual(decision.publication.status, 'allowed', 'a mock environment source is never publishable');
  assert.equal(gate.publishable, false);
}
{
  // Artifact metadata that marks simulated provenance must win over a
  // contradictory completed status, so the diagnostic is not eligible.
  const { decision } = runGateCase(
    'execution / simulated artifacts under completed status',
    createState(),
    gateResult({
      environment: liveEnv({ service: 'local-c500-adapter', runtime: 'local-c500-runner/v1' }),
      tracer: tracerEvidence({ artifacts: [{ path: 'artifacts/mctracer/stdout.json', simulated: true }] }),
      profiler: profilerEvidence({ artifacts: [{ path: 'artifacts/mcProfiler/stdout.json', simulated: true }] }),
    }),
  );
  assert.equal(decision.diagnostics.tracer.evidenceEligible, false, 'simulated artifacts cannot qualify real evidence');
  assert.equal(decision.diagnostics.profiler.evidenceEligible, false, 'simulated artifacts cannot qualify real evidence');
  assert.notEqual(decision.publication.status, 'allowed');
}

// --- final publication authorization ----------------------------------------
for (const [label, overrides, expectedStatus] of [
  ['publication / backend publishable=false is a restriction', { publishable: false }, 'blocked'],
  ['publication / shared-host source', { source: 'local-shared-gpu', executionMode: 'shared-host-gpu', publishable: false }, 'blocked'],
  ['publication / shared-host execution mode', { executionMode: 'shared-host-gpu' }, 'blocked'],
]) {
  const { gate, decision } = runGateCase(
    label,
    createState(),
    gateResult({ environment: liveEnv(overrides) }),
  );
  assert.equal(gate.passed, true, `${label}: a publication restriction must not erase a valid optimization result`);
  assert.notEqual(decision.publication.status, 'allowed', `${label}: publication must be blocked`);
  assert.equal(decision.publication.status, expectedStatus, `${label}: publication status`);
  assert.equal(gate.publishable, false, `${label}: backend boolean or host restriction must not authorize publication`);
}
{
  const { gate, decision } = runGateCase(
    'publication / adoption fails so publication cannot follow',
    createState(),
    gateResult({ environment: liveEnv(), correctness: false }),
  );
  assert.equal(decision.correctness.passed, false);
  assert.equal(gate.passed, false);
  assert.notEqual(decision.publication.status, 'allowed', 'publication requires a passed adoption');
}
{
  const { gate, decision } = runGateCase(
    'publication / backend publishable=true is not sufficient',
    createState(),
    gateResult({
      environment: liveEnv({ publishable: true }),
      tracer: tracerEvidence({ status: 'unavailable', events: [] }),
      profiler: profilerEvidence({ status: 'unavailable', metrics: {} }),
    }),
  );
  assert.equal(decision.diagnostics.tracer.evidenceEligible, false);
  assert.notEqual(decision.publication.status, 'allowed', 'publishable=true is not a new authorization whitelist');
  assert.equal(gate.publishable, false);
}

// --- invalid benchmark values ----------------------------------------------
for (const [label, value] of [
  ['benchmark / NaN latency', Number.NaN],
  ['benchmark / Infinity latency', Number.POSITIVE_INFINITY],
  ['benchmark / negative latency', -3],
  ['benchmark / zero latency', 0],
  ['benchmark / non-numeric latency', 'fast'],
  ['benchmark / boolean latency', true],
  ['benchmark / array latency', [41.8]],
  ['benchmark / object latency', { value: 41.8 }],
  ['benchmark / null latency', null],
]) {
  const { decision } = runGateCase(
    label,
    createState(),
    gateResult({ environment: liveEnv(), benchmark: defaultBenchmark(value) }),
  );
  assert.equal(decision.benchmark.valid, false, `${label}: malformed benchmark value is not valid evidence`);
  assert.notEqual(decision.publication.status, 'allowed', `${label}: invalid benchmark cannot authorize publication`);
}

// --- legacy results without a decision --------------------------------------
{
  const legacy = deepFreeze({
    benchmark: defaultBenchmark().map((item) => ({ ...item, correctness: { passed: true, total: 24 } })),
    environment: deepFreeze({ runtime: 'live-runtime', liveHardware: true }),
  });
  const { gate, decision } = runGateCase('legacy / no diagnostics or binding retained', createState(), legacy);
  assert.equal(decision.diagnostics.tracer.available, false, 'a legacy result without diagnostics is explicitly unavailable');
  assert.equal(decision.diagnostics.profiler.evidenceEligible, false);
  assert.notEqual(decision.publication.status, 'allowed', 'a legacy liveHardware boolean is not publication authority');
  assert.equal(gate.publishable, false);
  assert.ok(
    ['live', 'unknown'].includes(decision.execution.kind),
    'a legacy result must not fabricate a stronger execution classification than it retained',
  );
}

// --- frozen semantic binding ------------------------------------------------
const semanticSource = {
  authority: 'upstream',
  repository: 'https://example.test/operator.git',
  commit: 'a'.repeat(40),
  path: 'reference/run.py',
  expandedSingleFile: true,
};
const semanticMission = {
  id: 'MIS_P2_SEMANTIC',
  title: 'P2 semantic operator',
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
    source: semanticSource,
    evidence: { kind: 'pytorch_reference', status: 'complete', environment: 'C500', value: 100, unit: 'us', shapeKey: JSON.stringify({ correctnessCases: 24 }), liveHardware: true, source: semanticSource },
  },
};
const semanticSnapshot = freezeSemanticSnapshot(createSemanticSnapshot({ mission: semanticMission, semanticDraft: { operator: 'p2-semantic-operator' } }));
const semanticBinding = createSemanticTaskBinding(semanticSnapshot, {
  testSpec: semanticSnapshot.testSpec,
  oracleDigest: 'sha256:oracle',
  baselineDigest: 'sha256:baseline',
});
const createSemanticState = () => ({
  activeMissionId: semanticMission.id,
  appliedCandidateId: CANDIDATE_ID,
  missions: [{ ...structuredClone(semanticMission), semanticSnapshot }],
  stage: 'validation',
  agent: { runtimeKind: 'codex-cli', status: 'executing', messages: [], currentAction: null },
  benchmark: {
    status: 'running',
    purpose: 'candidate',
    testTaskId: 'queue-task-p2',
    remoteTaskId: TASK_ID,
    runId: RUN_ID,
    candidate: { id: CANDIDATE_ID, digest: CANDIDATE_DIGEST, sourceRunId: SOURCE_RUN_ID },
    matrix: { correctnessCases: 24 },
    semanticBinding,
  },
  decisionReview: { status: 'idle' },
  candidateEvaluations: [{ id: CANDIDATE_ID, title: 'P2 Semantic Candidate', version: 'agent.1', files: 'kernel.py', patchDigest: CANDIDATE_DIGEST, hypothesis: 'h', change: 'c' }],
  failureRecords: [],
  knowledgeDrafts: [],
  runtimeEvents: [],
  auditEvents: [],
  currentBest: { candidateId: null, value: '--' },
  baseline: structuredClone(semanticMission.baseline),
  testMatrix: structuredClone(semanticMission.testMatrix),
});
const semanticEnv = () => liveEnv({ runtime: 'live-runtime' });
// The frozen snapshot adds a semanticDigest expectation on top of the exact
// candidate/run identity used by the non-semantic gate cases.
const semanticDiagnosticBinding = (overrides = {}) => binding({
  missionId: semanticMission.id,
  candidateId: CANDIDATE_ID,
  candidateDigest: CANDIDATE_DIGEST,
  runId: RUN_ID,
  taskId: TASK_ID,
  sourceRunId: SOURCE_RUN_ID,
  semanticDigest: semanticBinding.semanticDigest,
  ...overrides,
});
const semanticBenchmark = () => [{ environment: 'C500', profile: 'primary', value: 80, unit: 'us' }];
const semanticResult = (diagnosticBinding, { semanticOverride } = {}) => deepFreeze({
  semanticBinding: semanticOverride === undefined ? semanticBinding : semanticOverride,
  benchmark: semanticBenchmark().map((item) => ({ ...item, correctness: { passed: true, total: 24 } })),
  tracer: tracerEvidence({ binding: diagnosticBinding }),
  profiler: profilerEvidence({ binding: diagnosticBinding }),
  environment: semanticEnv(),
});

{
  const matching = semanticDiagnosticBinding();
  const { gate, decision } = runGateCase(
    'semantic / matching frozen digest',
    createSemanticState(),
    semanticResult(matching),
  );
  assert.equal(decision.diagnostics.tracer.evidenceEligible, true, 'matching frozen semantic digest qualifies real diagnostics');
  assert.equal(gate.passed, true);
  assert.equal(decision.publication.status, 'allowed');
}
{
  const mismatched = semanticDiagnosticBinding({ semanticDigest: 'sha256:tampered' });
  const { gate, decision } = runGateCase(
    'semantic / mismatched digest',
    createSemanticState(),
    semanticResult(mismatched),
  );
  assert.equal(decision.diagnostics.tracer.evidenceEligible, false, 'a mismatched semantic digest cannot qualify real diagnostics');
  assert.equal(gate.passed, false);
  assert.notEqual(decision.publication.status, 'allowed');
}
{
  const missingBindingState = createSemanticState();
  delete missingBindingState.benchmark.semanticBinding;
  const { gate, decision } = runGateCase(
    'semantic / missing task binding',
    missingBindingState,
    semanticResult(semanticDiagnosticBinding(), { semanticOverride: null }),
  );
  assert.equal(gate.passed, false, 'a frozen snapshot without a task binding must fail the semantic rule');
  assert.notEqual(decision.publication.status, 'allowed');
}

for (const duration of [NaN, Infinity, 0, -1, '5', true, [5]]) {
  const { decision } = runGateCase('required profiler / malformed supplied duration', createState(),
    gateResult({ environment: liveEnv(), profiler: profilerEvidence({ metrics: { kernelDurationUs: duration } }) }));
  assert.equal(decision.adoption.status, 'blocked', 'supplied malformed metrics are not a missing-capability wait');
}
{
  const { decision } = runGateCase('required profiler / missing duration', createState(),
    gateResult({ environment: liveEnv(), profiler: profilerEvidence({ metrics: {} }) }));
  assert.equal(decision.adoption.status, 'waiting_external_verification');
}

console.log('[evidence-decision] diagnostic predicates, four provenance groups, all completeEvidence branches, and publication authorization passed');
