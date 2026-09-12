import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createDecisionReviewState,
  createKnowledgeMaintenanceState,
  markCandidateAccepted,
  runAutomaticAdoption,
  runKnowledgeMaintenance,
  toPublishedKnowledgeAsset,
} from '../client-runtime/state-store.mjs';
import { evaluateAcceptGate } from '../client-runtime/accept-gate.mjs';
import { classifyEvidenceDecision } from '../client-runtime/knowledge-state.mjs';

// Contract coverage: adoption and knowledge governance consume the single
// versioned evidence decision produced by the production Accept Gate. These are
// hardware-free contract fixtures (controlled doubles); a `live` execution
// classification here is a domain input, never proof of a live publication run.
// No snapshot access, workspace initialization, Agent, or hardware execution.
const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (label) => `sha256:${sha256Hex(label)}`;

const MISSION = 'MIS_KNOWLEDGE_CONTRACT';
const CANDIDATE = 'candidate-contract';
const RUN = 'run-knowledge-contract';
const TASK = 'remote-knowledge-contract';
const SOURCE_RUN = 'source-knowledge-contract';
const CANDIDATE_DIGEST = digest('candidate-contract');

const draftFor = (id = 'exp.new-knowledge', overrides = {}) => ({
  id,
  category: 'Optimization experience',
  title: 'Cache a repeated descriptor',
  conclusion: 'Reuse the descriptor within its validated shape scope.',
  hardware: ['C550', 'CUDA'],
  operator: 'mla_paged_attention',
  dtype: 'FP16',
  evidenceLevel: 'Level 3',
  evidenceRefs: ['run-knowledge-contract', 'candidate-contract'],
  evidence: 'validated benchmark evidence',
  confidence: 'high',
  status: 'validated',
  ...overrides,
});

// A production-shaped draft carries an explicit candidate+digest+run binding;
// governance backfills it only when all three match the evaluated decision.
const boundDraft = (id = 'exp.new-knowledge', overrides = {}) => draftFor(id, {
  sourceCandidate: CANDIDATE,
  evidenceBinding: { candidateId: CANDIDATE, candidateDigest: CANDIDATE_DIGEST, runId: RUN },
  ...overrides,
});

const goal = '将 latency p50 控制在 45 us 以下';

const environmentFor = (preset) => {
  if (preset === 'livePublishable') return { source: 'nvidia-smi', service: 'remote-live-adapter', executionMode: 'gpu', liveHardware: true, runtime: 'live-runtime' };
  if (preset === 'liveDevelopment') return { source: 'local-shared-gpu', service: 'local-shared-gpu-adapter', executionMode: 'gpu', liveHardware: true, runtime: 'local-shared-gpu-runner/v1' };
  if (preset === 'simulation') return { source: 'simulation', service: 'local-c500-adapter', executionMode: 'full-simulation', liveHardware: false, runtime: 'local-c500-runner/v1' };
  if (preset === 'cpu') return { source: 'cpu-e2e', service: 'local-cpu-adapter', executionMode: 'cpu-e2e', liveHardware: false, runtime: 'cpu-runner/v1' };
  throw new Error(`unknown preset ${preset}`);
};

const binding = () => ({ candidateDigest: CANDIDATE_DIGEST, runId: RUN, backendTaskId: TASK, sourceRunId: SOURCE_RUN });
const eligibleTracer = () => ({ format: 'operator-trace/v1', status: 'completed', source: 'mctracer', simulated: false, binding: binding(), events: [{ category: 'kernel', name: 'paged_decode', startUs: 0, durationUs: 12.5 }] });
const eligibleProfiler = () => ({ format: 'operator-profile/v1', status: 'completed', source: 'mcProfiler', simulated: false, binding: binding(), metrics: { kernelDurationUs: 12.5, occupancy: 0.62, bandwidth: 412.5 } });
const unavailableTracer = () => ({ format: 'operator-trace/v1', status: 'unavailable', events: [] });
const unavailableProfiler = () => ({ format: 'operator-profile/v1', status: 'unavailable', metrics: {} });
// Format-valid mock envelopes: the explicit simulation/CPU workflow consumes
// their shape, but they can never become real or publishable evidence.
const mockTracer = () => ({ format: 'operator-trace/v1', status: 'mocked', source: 'mock', simulated: true, events: [{ name: 'mctracer', category: 'tool' }] });
const mockProfiler = () => ({ format: 'operator-profile/v1', status: 'mocked', source: 'mock', simulated: true, metrics: { latencyP50Us: 41.8 } });

const resultFor = ({ preset, value }) => ({
  benchmark: [{
    profile: 'primary',
    environment: 'C500',
    value,
    unit: 'us',
    correctness: { passed: true, total: 24 },
  }],
  environment: environmentFor(preset),
  tracer: preset === 'livePublishable' ? eligibleTracer()
    : preset === 'liveDevelopment' ? unavailableTracer() : mockTracer(),
  profiler: preset === 'livePublishable' ? eligibleProfiler()
    : preset === 'liveDevelopment' ? unavailableProfiler() : mockProfiler(),
});

const stateFor = ({
  preset = 'liveDevelopment',
  objectiveMode = 'threshold',
  runtimeKind = 'codex-cli',
  value = 41.8,
  drafts = [boundDraft()],
  includeDecision = true,
} = {}) => {
  const objective = { mode: objectiveMode };
  const mission = { id: MISSION, title: 'MLA Paged Attention', goal, metric: 'latency p50', hardware: ['C500'], objective };
  const state = {
    activeMissionId: MISSION,
    missions: [mission],
    objective,
    stage: 'evidence',
    appliedCandidateId: CANDIDATE,
    candidateEvaluations: [{
      id: CANDIDATE,
      version: 'agent.4',
      delta: '-12%',
      patchDigest: CANDIDATE_DIGEST,
      sourceRunId: SOURCE_RUN,
      classification: 'eligible',
    }],
    currentBest: { candidateId: 'candidate-previous', status: 'active' },
    benchmark: {
      status: 'running',
      testTaskId: 'queue-task-knowledge-contract',
      remoteTaskId: TASK,
      runId: RUN,
      candidate: { id: CANDIDATE, digest: CANDIDATE_DIGEST, sourceRunId: SOURCE_RUN },
      matrix: { correctnessCases: 24 },
      result: null,
    },
    baseline: { required: false },
    knowledgeDrafts: structuredClone(drafts),
    publishedAssets: [],
    knowledgeMaintenance: createKnowledgeMaintenanceState('ready'),
    decisionReview: { ...createDecisionReviewState('auto_ready'), candidateId: CANDIDATE },
    agent: { runtimeKind, status: 'awaiting_action', currentAction: { type: 'adoption.decision' }, messages: [] },
    failureRecords: [],
    runtimeEvents: [],
    auditEvents: [],
  };
  const result = resultFor({ preset, value });
  state.benchmark.result = result;
  if (includeDecision) {
    // The single production domain decision is produced once and bound to the
    // candidate Gate, the review Gate and the benchmark. Tests never hand-fill
    // publishable/live booleans or classify governance themselves.
    const gate = evaluateAcceptGate(state, result);
    assert.ok(gate.decision, `${preset}: the production Accept Gate must return a versioned decision`);
    state.candidateEvaluations[0].acceptGate = gate;
    state.decisionReview = {
      ...state.decisionReview,
      status: gate.passed ? 'auto_ready' : 'resolved',
      gate,
      decision: gate.decision,
      evidenceDecision: gate.decision,
      gateEvaluatedAt: '2026-09-12T00:00:00.000Z',
      requiresApproval: false,
    };
    state.benchmark.evidenceDecision = structuredClone(gate.decision);
  }
  return state;
};

const decisions = {
  livePublishable: stateFor({ preset: 'livePublishable' }).benchmark.evidenceDecision,
  liveDevelopment: stateFor({ preset: 'liveDevelopment' }).benchmark.evidenceDecision,
  simulation: stateFor({ preset: 'simulation' }).benchmark.evidenceDecision,
};

// Sanity: the frozen presets really cover the intended decision shapes.
assert.equal(decisions.livePublishable.execution.kind, 'live');
assert.equal(decisions.livePublishable.publication.status, 'allowed');
assert.equal(decisions.liveDevelopment.execution.kind, 'live');
assert.equal(decisions.liveDevelopment.publication.status, 'blocked');
assert.deepEqual(decisions.liveDevelopment.publication.reasons, ['publication.restricted_environment']);
assert.equal(decisions.simulation.execution.kind, 'simulation');
assert.equal(decisions.simulation.adoption.status, 'allowed');

// The asset formatter classifies only through the same decision. Legacy drafts
// keep their old Level 3/validated labels but can never be published from them.
for (const [status, evidenceLevel] of [['validated', 'Level 3'], ['validated', 'Level 2'], ['draft', 'Level 3'], ['simulation', 'Level 3']]) {
  const draft = draftFor('exp.legacy-formatter', { status, evidenceLevel, hardware: ['C550', 'CUDA', 'ROCm MI300', 'unknown'] });
  const before = structuredClone(draft);
  const asset = toPublishedKnowledgeAsset(draft, 'v4.2');
  assert.equal(asset.status, 'unknown', `${status}/${evidenceLevel}: a record without a decision must stay unknown`);
  assert.equal(asset.evidenceLevel, '未知证据');
  assert.equal(asset.publishable, false);
  assert.equal(asset.publication, 'blocked');
  assert.equal(asset.version, 'v4.2');
  assert.equal(asset.description, draft.conclusion);
  assert.equal(asset.kind, 'Experience');
  assert.equal(asset.permissions, 'organization:read');
  assert.deepEqual(asset.hardwareKeys, ['c550', 'nvidia', 'amd']);
  assert.match(asset.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(draft, before, 'formatting must not mutate the supplied draft');
}
assert.equal(toPublishedKnowledgeAsset(draftFor()).version, 'v1.0');

for (const [label, decision, assetStatus, evidenceLevel, publishable] of [
  ['published', decisions.livePublishable, 'published', 'Level 3', true],
  ['development', decisions.liveDevelopment, 'development', '真实开发证据', false],
  ['simulation', decisions.simulation, 'simulation', '模拟证据', false],
]) {
  const asset = toPublishedKnowledgeAsset(draftFor('exp.formatter', { evidenceDecision: decision }), 'v9.0');
  assert.equal(asset.status, assetStatus, `${label}: asset classification follows the bound decision`);
  assert.equal(asset.evidenceLevel, evidenceLevel);
  assert.equal(asset.publishable, publishable);
  assert.equal(asset.version, 'v9.0');
}

// Candidate acceptance picks the applied candidate before a different review
// candidate and never rewrites the Gate/decision that was already evaluated.
{
  const state = stateFor();
  const other = { id: 'candidate-review', classification: 'reference', acceptGate: { passed: false } };
  state.candidateEvaluations.push(other);
  state.decisionReview.candidateId = other.id;
  const appliedGateBefore = structuredClone(state.candidateEvaluations[0].acceptGate);
  const otherBefore = structuredClone(other);
  const acceptedAt = markCandidateAccepted(state, 'Human review disposition', 'human_review');
  const accepted = state.candidateEvaluations[0];
  assert.equal(accepted.classification, 'accepted');
  assert.equal(accepted.patchDigest, CANDIDATE_DIGEST);
  assert.equal(accepted.decisionReason, 'Human review disposition');
  assert.equal(accepted.status, '已按人工处置采用');
  assert.equal(accepted.acceptedAt, acceptedAt);
  assert.ok(Number.isFinite(Date.parse(acceptedAt)));
  assert.deepEqual(accepted.acceptGate, appliedGateBefore, 'human acceptance must not rewrite the evaluated Gate or its decision');
  assert.equal(state.candidateEvaluations[1], other);
  assert.deepEqual(other, otherBefore, 'acceptance must preserve the other candidate');
  assert.equal(state.stage, 'evidence', 'marking accepted alone does not perform adoption');
  assert.equal(state.runtimeEvents.length, 0);
}

{
  const state = stateFor();
  delete state.appliedCandidateId;
  markCandidateAccepted(state, 'Review candidate fallback');
  assert.equal(state.candidateEvaluations[0].classification, 'accepted');
  assert.equal(state.candidateEvaluations[0].status, '已自动采用');
  const legacy = {};
  markCandidateAccepted(legacy, 'Legacy candidate fallback');
  assert.equal(legacy.candidateEvaluations.length, 3);
  assert.deepEqual(legacy.candidateEvaluations.filter((candidate) => candidate.classification === 'accepted').map((candidate) => candidate.id), ['candidate-02']);
}

// Managed runtime adoption refuses incomplete/failed evidence and human review.
for (const runtimeKind of ['codex-cli', 'claude-code']) {
  for (const [name, alter] of [
    ['missing digest', (state) => { delete state.candidateEvaluations[0].patchDigest; }],
    ['failed gate', (state) => { state.decisionReview.gate.passed = false; }],
    ['failed candidate gate fallback', (state) => { delete state.decisionReview.gate; state.candidateEvaluations[0].acceptGate.passed = false; }],
    ['missing candidate', (state) => { state.candidateEvaluations = []; }],
    ['human review pending', (state) => { state.decisionReview.status = 'awaiting_review'; }],
    ['no candidate identity', (state) => { delete state.appliedCandidateId; delete state.decisionReview.candidateId; }],
  ]) {
    const state = stateFor({ runtimeKind });
    alter(state);
    const before = structuredClone(state);
    assert.equal(runAutomaticAdoption(state), state);
    assert.deepEqual(state, before, `${runtimeKind}: ${name} must remain unchanged`);
  }
}

{
  const state = stateFor({ runtimeKind: 'reference-fixture' });
  state.decisionReview.status = 'awaiting_review';
  const before = structuredClone(state);
  runAutomaticAdoption(state);
  assert.deepEqual(state, before, 'reference evidence cannot bypass a pending human review');
}

// A candidate-owned Gate remains the documented fallback when no review Gate is
// present; this function consumes that decision and does not execute a runner.
{
  const state = stateFor();
  const expectedDecision = structuredClone(state.benchmark.evidenceDecision);
  delete state.decisionReview.gate;
  delete state.appliedCandidateId;
  assert.equal(runAutomaticAdoption(state, 'Adopt verified candidate'), state);
  assert.equal(state.stage, 'curation');
  assert.equal(state.currentBest.candidateId, CANDIDATE);
  assert.equal(state.currentBest.version, 'agent.4');
  assert.equal(state.currentBest.value, '41.8 us');
  assert.equal(state.currentBest.improvement, '-12%');
  // A real shared-GPU development decision is explicitly nonpublishable, but its
  // execution classification stays `live`.
  assert.equal(state.currentBest.verified, false);
  assert.equal(state.currentBest.liveHardware, true);
  assert.equal(state.currentBest.evidenceSource, 'local-shared-gpu');
  assert.deepEqual(state.currentBest.evidenceDecision, expectedDecision);
  assert.equal(state.currentBest.evidenceRunId, RUN);
  assert.deepEqual(state.currentBest.measurements, [{ profile: 'primary', value: 41.8, unit: 'us' }]);
  assert.equal(state.decisionReview.status, 'resolved');
  assert.equal(state.decisionReview.resolution.outcome, 'adopt');
  assert.equal(state.decisionReview.resolution.source, 'policy');
  assert.deepEqual(state.decisionReview.gate.decision, expectedDecision);
  assert.deepEqual(state.decisionReview.evidenceDecision, expectedDecision);
  assert.equal(state.knowledgeMaintenance.status, 'ready');
  assert.equal(state.agent.currentAction, null);
  assert.equal(state.runtimeEvents.at(-1).type, 'decision.auto_adopted');
}

// Provenance is classified by the decision, never by a bare live boolean:
// live development is `development` (not simulation), and simulation/CPU stay
// simulation even when a legacy liveHardware flag would claim otherwise.
for (const { preset, runtimeKind } of [
  { preset: 'liveDevelopment', runtimeKind: 'codex-cli' },
  { preset: 'simulation', runtimeKind: 'codex-cli' },
  { preset: 'cpu', runtimeKind: 'codex-cli' },
]) {
  const state = stateFor({ preset, runtimeKind });
  const evidenceBefore = structuredClone(state.benchmark);
  const decision = state.benchmark.evidenceDecision;
  runAutomaticAdoption(state);
  assert.equal(state.currentBest.verified, false, `${preset}: only a publication-allowed decision may mark verified`);
  assert.equal(state.currentBest.liveHardware, decision.execution.liveHardware, `${preset}: liveHardware is the decision's execution classification`);
  assert.equal(state.currentBest.evidenceSource, decision.execution.source);
  runKnowledgeMaintenance(state);
  const expectedAsset = preset === 'liveDevelopment' ? 'development' : 'simulation';
  const expectedOutcome = preset === 'liveDevelopment' ? 'development_only' : 'simulation_only';
  assert.equal(state.publishedAssets[0].status, expectedAsset, `${preset}: asset status follows decision classification`);
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 0);
  assert.equal(state.knowledgeMaintenance.summary.reviewRequired, 1);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, expectedOutcome);
  assert.equal(state.knowledgeDrafts[0].status, expectedAsset);
  if (preset === 'liveDevelopment') {
    assert.equal(state.knowledgeDrafts[0].evidenceLevel, '真实开发证据');
    assert.notEqual(state.publishedAssets[0].status, 'simulation', 'a real development result must never be presented as simulation');
  } else {
    assert.equal(state.knowledgeDrafts[0].evidenceLevel, '模拟证据');
    assert.notEqual(state.publishedAssets[0].status, 'published');
  }
  assert.deepEqual(state.benchmark, evidenceBefore, 'governance must not rewrite execution provenance or candidate binding');
  assert.equal(state.stage, 'published');
  assert.equal(state.agent.status, 'completed');
  assert.equal(state.decisionReview.requiresApproval, false);
  assert.equal(state.runtimeEvents.at(-1).payload.liveEvidence, decision.execution.kind === 'live');
  assert.equal(state.runtimeEvents.at(-1).payload.publicationStatus, decision.publication.status);
  const beforeRepeat = structuredClone(state);
  const publishedBeforeRepeat = state.publishedAssets;
  const eventsBeforeRepeat = state.runtimeEvents;
  assert.equal(runKnowledgeMaintenance(state), state);
  assert.deepEqual(state, beforeRepeat, `${preset}: repeated completed maintenance is a no-op`);
  assert.equal(state.publishedAssets, publishedBeforeRepeat);
  assert.equal(state.runtimeEvents, eventsBeforeRepeat);
}

// A qualified unrestricted real decision (controlled contract double) can still
// reach the domain's published classification; only publication allowed does.
{
  const state = stateFor({ preset: 'livePublishable' });
  const decision = state.benchmark.evidenceDecision;
  assert.equal(decision.publication.status, 'allowed');
  runAutomaticAdoption(state);
  assert.equal(state.currentBest.verified, true);
  assert.equal(state.currentBest.liveHardware, true);
  assert.deepEqual(state.currentBest.evidenceDecision, decision);
  runKnowledgeMaintenance(state);
  assert.equal(state.publishedAssets[0].status, 'published');
  assert.equal(state.publishedAssets[0].evidenceLevel, 'Level 3');
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 1);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, 'auto_published');
  assert.equal(state.knowledgeDrafts[0].status, 'validated');
}

// Legacy drafts without a decision (or with a foreign/mismatched one) are never
// promoted from their old Level 3 label. Missing/mismatched identity is unknown.
{
  const state = stateFor({
    preset: 'livePublishable',
    drafts: [
      draftFor('exp.legacy-no-decision', { evidenceLevel: 'Level 3', status: 'validated' }),
      draftFor('exp.foreign-decision', {
        evidenceDecision: decisions.livePublishable,
        evidenceBinding: { candidateId: 'other-candidate', candidateDigest: digest('other'), runId: 'other-run' },
      }),
      draftFor('exp.mismatched-binding', {
        evidenceDecision: decisions.livePublishable,
        evidenceBinding: { candidateId: CANDIDATE, candidateDigest: digest('tampered'), runId: RUN },
      }),
    ],
  });
  runAutomaticAdoption(state);
  runKnowledgeMaintenance(state);
  assert.deepEqual(state.publishedAssets.map((asset) => asset.status), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(state.publishedAssets.map((asset) => asset.evidenceLevel), ['未知证据', '未知证据', '未知证据']);
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 0);
  assert.equal(state.knowledgeMaintenance.summary.reviewRequired, 3);
  assert.ok(state.publishedAssets.every((asset) => asset.publishable === false));
  const classification = classifyEvidenceDecision(decisions.livePublishable);
  assert.equal(classification.assetStatus, 'published', 'the decision itself is valid; it simply does not govern these drafts');
}

// Maximize Missions record the current best and keep the evidence stage available
// to the iteration loop after both adoption and experience maintenance.
{
  const state = stateFor({ objectiveMode: 'maximize', preset: 'livePublishable' });
  runAutomaticAdoption(state);
  assert.equal(state.stage, 'evidence');
  assert.equal(state.agent.status, 'completed');
  const resolution = structuredClone(state.decisionReview.resolution);
  const resolvedAt = state.decisionReview.resolvedAt;
  runKnowledgeMaintenance(state);
  assert.equal(state.stage, 'evidence');
  assert.equal(state.currentBest.candidateId, CANDIDATE);
  assert.equal(state.knowledgeMaintenance.status, 'completed');
  assert.deepEqual(state.decisionReview.resolution, resolution);
  assert.equal(state.decisionReview.resolvedAt, resolvedAt);
  assert.deepEqual(state.runtimeEvents.map((event) => event.payload.objectiveMode), ['maximize', 'maximize']);
}

// Canonical event appenders retain bounded history across both transitions.
{
  const state = stateFor();
  state.runtimeEvents = Array.from({ length: 500 }, (_, index) => ({ sequence: index + 1, type: 'retained.event' }));
  state.auditEvents = Array.from({ length: 30 }, (_, index) => ({ title: `retained-audit-${index}` }));
  runAutomaticAdoption(state);
  runKnowledgeMaintenance(state);
  assert.equal(state.runtimeEvents.length, 500);
  assert.equal(state.runtimeEvents[0].sequence, 3);
  assert.deepEqual(state.runtimeEvents.slice(-2).map((event) => [event.sequence, event.type]), [[501, 'decision.auto_adopted'], [502, 'knowledge.maintenance_completed']]);
  assert.ok(state.runtimeEvents.slice(-2).every((event) => event.missionId === state.activeMissionId));
  assert.equal(state.auditEvents.length, 30);
  assert.equal(state.auditEvents.at(-1).title, 'retained-audit-27');
  assert.equal(state.agent.messages.length, 2);
}

console.log('[knowledge-state] decision-driven adoption, source isolation, draft eligibility, maximize, idempotence, and bounded event contracts passed');
