import assert from 'node:assert/strict';
import {
  createDecisionReviewState,
  createKnowledgeMaintenanceState,
  markCandidateAccepted,
  runAutomaticAdoption,
  runKnowledgeMaintenance,
  toPublishedKnowledgeAsset,
} from '../client-runtime/state-store.mjs';

// Contract coverage: exercise the compatibility facade entirely in memory.
// No snapshot access, workspace initialization, Agent, or hardware execution.
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

const stateFor = ({
  source = 'local-c500',
  liveHardware = true,
  publishable = liveHardware,
  objectiveMode = 'threshold',
  runtimeKind = 'codex-cli',
  drafts = [draftFor()],
} = {}) => {
  const objective = { mode: objectiveMode };
  const gate = {
    passed: true,
    publishable,
    evidenceSource: source,
    passedRules: ['correctness', 'performance.target.c550'],
    failedRules: [],
    evaluatedRules: 2,
  };
  return {
    activeMissionId: 'MIS_KNOWLEDGE_CONTRACT',
    missions: [{ id: 'MIS_KNOWLEDGE_CONTRACT', goal: 'Optimize operator latency', objective }],
    objective,
    stage: 'evidence',
    appliedCandidateId: 'candidate-contract',
    candidateEvaluations: [{
      id: 'candidate-contract',
      version: 'agent.4',
      delta: '-12%',
      patchDigest: 'sha256:candidate-contract',
      classification: 'eligible',
      acceptGate: structuredClone(gate),
    }],
    currentBest: { candidateId: 'candidate-previous', status: 'active' },
    benchmark: {
      status: 'complete',
      runId: 'run-knowledge-contract',
      candidate: { id: 'candidate-contract', digest: 'sha256:candidate-contract' },
      result: {
        environment: { source, liveHardware },
        benchmark: [
          { profile: 'C550', value: 41.8, unit: 'us' },
          { environment: 'CUDA', value: 36.1 },
        ],
      },
    },
    knowledgeDrafts: structuredClone(drafts),
    publishedAssets: [],
    knowledgeMaintenance: createKnowledgeMaintenanceState('ready'),
    decisionReview: { ...createDecisionReviewState('auto_ready'), candidateId: 'candidate-contract', gate },
    agent: { runtimeKind, status: 'awaiting_action', currentAction: { type: 'adoption.decision' }, messages: [] },
    runtimeEvents: [],
    auditEvents: [],
  };
};

// The asset formatter checks draft validation/level only. Evidence provenance is
// interpreted by runKnowledgeMaintenance before it calls this formatter.
for (const [status, evidenceLevel, expected] of [
  ['validated', 'Level 3', 'published'],
  ['validated', 'Level 2', 'simulation'],
  ['draft', 'Level 3', 'simulation'],
  ['simulation', 'Level 3', 'simulation'],
]) {
  const draft = draftFor('exp.formatter', { status, evidenceLevel, hardware: ['C550', 'CUDA', 'ROCm MI300', 'unknown'] });
  const before = structuredClone(draft);
  const asset = toPublishedKnowledgeAsset(draft, 'v4.2');
  assert.equal(asset.status, expected, `${status}/${evidenceLevel} formatting`);
  assert.equal(asset.version, 'v4.2');
  assert.equal(asset.description, draft.conclusion);
  assert.equal(asset.kind, 'Experience');
  assert.equal(asset.permissions, 'organization:read');
  assert.deepEqual(asset.hardwareKeys, ['c550', 'nvidia', 'amd']);
  assert.match(asset.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(draft, before, 'formatting must not mutate the supplied draft');
}
assert.equal(toPublishedKnowledgeAsset(draftFor()).version, 'v1.0');

// Acceptance targets the applied candidate before a different review candidate.
{
  const state = stateFor();
  const other = { id: 'candidate-review', classification: 'reference', acceptGate: { passed: false } };
  state.candidateEvaluations.push(other);
  state.decisionReview.candidateId = other.id;
  const otherBefore = structuredClone(other);
  const acceptedAt = markCandidateAccepted(state, 'Human review disposition', 'human_review');
  const accepted = state.candidateEvaluations[0];
  assert.equal(accepted.classification, 'accepted');
  assert.equal(accepted.acceptGate.result, 'accepted');
  assert.equal(accepted.acceptGate.passed, true);
  assert.equal(accepted.patchDigest, 'sha256:candidate-contract');
  assert.equal(accepted.decisionReason, 'Human review disposition');
  assert.equal(accepted.status, '已按人工处置采用');
  assert.equal(accepted.acceptedAt, acceptedAt);
  assert.ok(Number.isFinite(Date.parse(acceptedAt)));
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
  delete state.decisionReview.gate;
  delete state.appliedCandidateId;
  assert.equal(runAutomaticAdoption(state, 'Adopt verified candidate'), state);
  assert.equal(state.stage, 'curation');
  assert.equal(state.currentBest.candidateId, 'candidate-contract');
  assert.equal(state.currentBest.version, 'agent.4');
  assert.equal(state.currentBest.value, '41.8 us');
  assert.equal(state.currentBest.improvement, '-12%');
  assert.equal(state.currentBest.verified, true);
  assert.equal(state.currentBest.liveHardware, true);
  assert.equal(state.currentBest.evidenceRunId, 'run-knowledge-contract');
  assert.deepEqual(state.currentBest.measurements, [
    { profile: 'C550', value: 41.8, unit: 'us' },
    { profile: 'CUDA', value: 36.1, unit: 'us' },
  ]);
  assert.equal(state.decisionReview.status, 'resolved');
  assert.equal(state.decisionReview.resolution.outcome, 'adopt');
  assert.equal(state.decisionReview.resolution.source, 'policy');
  assert.equal(state.knowledgeMaintenance.status, 'ready');
  assert.equal(state.agent.currentAction, null);
  assert.equal(state.runtimeEvents.at(-1).type, 'decision.auto_adopted');
}

// Live hardware does not itself turn a non-publishable Gate into verified best.
{
  const state = stateFor({ liveHardware: true, publishable: false });
  runAutomaticAdoption(state);
  assert.equal(state.currentBest.candidateId, 'candidate-contract');
  assert.equal(state.currentBest.verified, false);
  assert.equal(state.currentBest.liveHardware, false);
}

// Live, simulation, and CPU fixture results remain distinct through adoption
// and governance. These are fabricated state inputs, not hardware evidence.
for (const { source, liveHardware, runtimeKind } of [
  { source: 'local-c500', liveHardware: true, runtimeKind: 'codex-cli' },
  { source: 'reference-fixture', liveHardware: false, runtimeKind: 'reference-fixture' },
  { source: 'cpu-e2e', liveHardware: false, runtimeKind: 'codex-cli' },
]) {
  const state = stateFor({ source, liveHardware, runtimeKind });
  const evidenceBefore = structuredClone(state.benchmark);
  runAutomaticAdoption(state);
  assert.equal(state.currentBest.verified, liveHardware);
  assert.equal(state.currentBest.liveHardware, liveHardware);
  assert.equal(state.currentBest.evidenceSource, source);
  assert.equal(runKnowledgeMaintenance(state), state);
  assert.equal(state.publishedAssets[0].status, liveHardware ? 'published' : 'simulation');
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, liveHardware ? 1 : 0);
  assert.equal(state.knowledgeMaintenance.summary.reviewRequired, liveHardware ? 0 : 1);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, liveHardware ? 'auto_published' : 'simulation_only');
  if (!liveHardware) {
    assert.equal(state.knowledgeDrafts[0].status, 'simulation');
    assert.notEqual(state.knowledgeDrafts[0].evidenceLevel, 'Level 3');
  }
  assert.deepEqual(state.benchmark, evidenceBefore, 'governance must not rewrite execution provenance or candidate binding');
  assert.equal(state.stage, 'published');
  assert.equal(state.agent.status, 'completed');
  assert.equal(state.decisionReview.requiresApproval, false);
  assert.equal(state.runtimeEvents.at(-1).payload.liveEvidence, liveHardware);
  const beforeRepeat = structuredClone(state);
  const publishedBeforeRepeat = state.publishedAssets;
  const eventsBeforeRepeat = state.runtimeEvents;
  assert.equal(runKnowledgeMaintenance(state), state);
  assert.deepEqual(state, beforeRepeat, `${source}: repeated completed maintenance is a no-op`);
  assert.equal(state.publishedAssets, publishedBeforeRepeat);
  assert.equal(state.runtimeEvents, eventsBeforeRepeat);
}

// Hardware provenance alone cannot promote an unvalidated or lower-level draft.
{
  const state = stateFor({ drafts: [
    draftFor('exp.async-plan-cache'),
    draftFor('exp.lower-level', { evidenceLevel: 'Level 2' }),
    draftFor('exp.unvalidated', { status: 'draft' }),
  ] });
  runKnowledgeMaintenance(state);
  assert.deepEqual(state.publishedAssets.map((asset) => asset.status), ['published', 'simulation', 'simulation']);
  assert.deepEqual(state.publishedAssets.map((asset) => asset.version), ['v1.3', 'v1.0', 'v1.0']);
  assert.deepEqual(state.knowledgeMaintenance.summary, { extracted: 3, matched: 1, created: 2, autoPublished: 1, reviewRequired: 2 });
  assert.equal(state.knowledgeDrafts[1].evidenceLevel, 'Level 2');
  assert.equal(state.knowledgeDrafts[2].status, 'draft');
}

// Removing an old mock publication happens during governance; missing provenance
// also fails closed, even if legacy assets were previously marked published.
for (const environment of [{ source: 'cpu-e2e', liveHardware: false }, { source: 'unknown' }, { source: 'unknown', liveHardware: 'true' }]) {
  const state = stateFor();
  state.benchmark.result.environment = environment;
  state.knowledgeMaintenance = createKnowledgeMaintenanceState('completed');
  state.publishedAssets = state.knowledgeDrafts.map((draft) => toPublishedKnowledgeAsset(draft));
  runKnowledgeMaintenance(state);
  assert.ok(state.publishedAssets.every((asset) => asset.status === 'simulation'));
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 0);
}

// Maximize Missions record the current best and keep the evidence stage available
// to the iteration loop after both adoption and experience maintenance.
{
  const state = stateFor({ objectiveMode: 'maximize' });
  runAutomaticAdoption(state);
  assert.equal(state.stage, 'evidence');
  assert.equal(state.agent.status, 'completed');
  const resolution = structuredClone(state.decisionReview.resolution);
  const resolvedAt = state.decisionReview.resolvedAt;
  runKnowledgeMaintenance(state);
  assert.equal(state.stage, 'evidence');
  assert.equal(state.currentBest.candidateId, 'candidate-contract');
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

console.log('[knowledge-state] adoption, source isolation, draft eligibility, maximize, idempotence, and bounded event contracts passed');
