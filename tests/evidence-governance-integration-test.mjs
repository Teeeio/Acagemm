import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyOperatorTestSnapshot } from '../client-runtime/operator-test-evidence.mjs';
import {
  classifyEvidenceDecision,
  resolveGovernanceDecision,
  runAutomaticAdoption,
  runKnowledgeMaintenance,
  validateEvidenceDecision,
} from '../client-runtime/knowledge-state.mjs';
import { advanceIteration, detectLoopGuard, isExternalVerificationPending } from '../client-runtime/iteration-loop.mjs';

// Independent acceptance of the production integration path:
//   operator test snapshot -> versioned evidence decision -> governance
//   adoption/maintenance -> recoverable external verification wait.
//
// The positive sources below are controlled contract doubles that exercise the
// production projection. They are not real hardware and prove nothing about a
// physical device; `live` is a declared input classification, never proof that
// a real run happened.

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (value) => `sha256:${sha256(value)}`;

const MISSION = 'MIS_EGI';
const CANDIDATE = 'candidate-egi';
const RUN = 'run-egi-1';
const SOURCE_RUN = 'source-run-egi';
const TASK = 'task-egi';
const REMOTE_TASK = 'remote-egi';

const environments = Object.freeze({
  // Real development path: shared host GPU, benchmark core local, diagnostics
  // optional. Adoption is allowed but publication is explicitly restricted.
  sharedGpuDevelopment: { source: 'local-shared-gpu', service: 'local-shared-gpu-adapter', executionMode: 'gpu', liveHardware: true, runtime: 'shared-host-runtime' },
  // Explicit simulation: structured envelopes only, never publication authority.
  simulation: { source: 'simulation', service: 'simulation-runner', executionMode: 'full-simulation', liveHardware: false, runtime: 'simulation-runtime' },
  // Controlled real double: a real-path classification whose bound diagnostics
  // are supplied as eligible contract fixtures.
  controlledReal: { source: 'remote-live-adapter', service: 'remote-operator-runner', executionMode: 'gpu', liveHardware: true, runtime: 'remote-runtime' },
});

const structuredDiagnostics = () => ({
  tracer: { format: 'operator-trace/v1', status: 'completed', events: [] },
  profiler: { format: 'operator-profile/v1', status: 'completed', metrics: {} },
});

const unavailableDiagnostics = () => ({
  tracer: { format: 'operator-trace/v1', status: 'unavailable', events: [] },
  profiler: { format: 'operator-profile/v1', status: 'unavailable', metrics: {} },
});

const eligibleDiagnostics = () => ({
  tracer: {
    format: 'operator-trace/v1',
    status: 'completed',
    source: 'mctracer',
    simulated: false,
    binding: { candidateDigest: digest(CANDIDATE), runId: RUN, backendTaskId: REMOTE_TASK, sourceRunId: SOURCE_RUN },
    events: [{ category: 'kernel', name: 'paged_attention', startUs: 0, durationUs: 12.5 }],
  },
  profiler: {
    format: 'operator-profile/v1',
    status: 'completed',
    source: 'mcProfiler',
    simulated: false,
    binding: { candidateDigest: digest(CANDIDATE), runId: RUN, backendTaskId: REMOTE_TASK, sourceRunId: SOURCE_RUN },
    metrics: { kernelDurationUs: 12.5 },
  },
});

const buildState = ({ environment, diagnostics, value = 41.8, goal = '将 latency p50 控制在 45 us 以下' }) => ({
  activeMissionId: MISSION,
  appliedCandidateId: CANDIDATE,
  missions: [{ id: MISSION, title: 'EGI', goal, metric: 'latency p50', hardware: ['nvidia-gpu'], projectId: 'PRJ_EGI' }],
  stage: 'validation',
  baseline: { required: false },
  agent: {
    runtimeKind: 'claude-code',
    status: 'executing',
    runId: 'agent-egi-1',
    messages: [],
    currentAction: null,
    resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
  },
  benchmark: {
    status: 'running',
    testTaskId: TASK,
    remoteTaskId: null,
    runId: RUN,
    purpose: 'candidate',
    candidate: { id: CANDIDATE, digest: digest(CANDIDATE), sourceRunId: SOURCE_RUN },
    matrix: { correctnessCases: 24 },
    result: null,
  },
  decisionReview: { status: 'idle' },
  candidateEvaluations: [{ id: CANDIDATE, title: 'EGI candidate', version: 'agent.1', files: 'kernel.py', patchDigest: digest(CANDIDATE), sourceRunId: SOURCE_RUN, hypothesis: 'x', change: 'y' }],
  currentBest: { candidateId: null, value: '--' },
  knowledgeDrafts: [],
  publishedAssets: [],
  knowledgeMaintenance: { status: 'idle' },
  failureRecords: [],
  runtimeEvents: [],
  auditEvents: [],
});

const snapshotFor = ({ environment, diagnostics, value = 41.8 }) => ({
  taskId: TASK,
  remoteTaskId: REMOTE_TASK,
  status: 'completed',
  progress: 100,
  completedAt: '2026-09-12T00:00:00.000Z',
  durationMs: 1000,
  resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
  payload: { missionId: MISSION, requestId: RUN, purpose: 'candidate', workspaceId: MISSION },
  result: {
    benchmark: [
      { profile: 'primary', environment: 'MetaX C550', value, unit: 'us', correctness: { passed: true, total: 24 } },
      { profile: 'small', environment: 'MetaX C550', value: value * 0.9, unit: 'us', correctness: { passed: true, total: 24 } },
    ],
    environment,
    ...diagnostics,
  },
});

const project = (options) => {
  const state = buildState(options);
  const snapshot = snapshotFor(options);
  applyOperatorTestSnapshot(state, snapshot);
  return { state, snapshot };
};

const assertSameDecision = (state, label) => {
  const decision = state.benchmark.evidenceDecision;
  assert.ok(decision, `${label}: benchmark must store the versioned decision`);
  assert.equal(validateEvidenceDecision(decision).valid, true, `${label}: decision must be a complete v1 DTO`);
  const candidate = state.candidateEvaluations.find((item) => item.id === CANDIDATE);
  assert.deepEqual(candidate.acceptGate.decision, decision, `${label}: candidate gate carries the same decision value`);
  assert.deepEqual(state.decisionReview.gate.decision, decision, `${label}: review gate carries the same decision value`);
  assert.deepEqual(state.currentBest.evidenceDecision, decision, `${label}: currentBest carries the same decision value`);
  assert.deepEqual(state.knowledgeDrafts[0].evidenceDecision, decision, `${label}: draft carries the same decision value`);
  assert.deepEqual(state.publishedAssets[0].evidenceDecision, decision, `${label}: asset carries the same decision value`);
  return decision;
};

// --- real shared-GPU development: development asset, never simulation --------
{
  const { state } = project({ environment: environments.sharedGpuDevelopment, diagnostics: unavailableDiagnostics() });
  const decision = state.benchmark.evidenceDecision;
  assert.equal(decision.execution.kind, 'live');
  assert.equal(decision.execution.liveHardware, true);
  assert.equal(decision.adoption.status, 'allowed', 'local optional diagnostics must not block adoption');
  assert.deepEqual(decision.publication.reasons, ['publication.restricted_environment']);
  assert.equal(decision.publication.status, 'blocked');

  runAutomaticAdoption(state);
  assert.equal(state.currentBest.candidateId, CANDIDATE);
  assert.equal(state.currentBest.verified, false, 'a shared-GPU development run is not publication-verified');
  assert.equal(state.currentBest.liveHardware, true, 'execution classification stays live, separate from publication');

  runKnowledgeMaintenance(state);
  assert.equal(state.publishedAssets.length, 1);
  assert.equal(state.publishedAssets[0].status, 'development', 'real development evidence must not be flattened into simulation');
  assert.notEqual(state.publishedAssets[0].status, 'simulation');
  assert.equal(state.publishedAssets[0].evidenceLevel, '真实开发证据');
  assert.equal(state.publishedAssets[0].publishable, false);
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 0, 'development evidence is never auto-published');
  assert.equal(state.knowledgeMaintenance.summary.reviewRequired, 1);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, 'development_only');
  assertSameDecision(state, 'shared-gpu-development');
  console.log('[evidence-governance] shared-GPU development yields a development asset with 0 autoPublished');
}

// --- explicit simulation: preview asset only --------------------------------
{
  const { state } = project({ environment: environments.simulation, diagnostics: structuredDiagnostics() });
  const decision = state.benchmark.evidenceDecision;
  assert.equal(decision.execution.kind, 'simulation');
  assert.equal(decision.adoption.status, 'allowed');
  assert.deepEqual(decision.publication.reasons, ['publication.execution_not_live']);

  runAutomaticAdoption(state);
  assert.equal(state.currentBest.verified, false);
  assert.equal(state.currentBest.liveHardware, false);
  runKnowledgeMaintenance(state);
  assert.equal(state.publishedAssets[0].status, 'simulation');
  assert.equal(state.publishedAssets[0].evidenceLevel, '模拟证据');
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 0);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, 'simulation_only');
  assertSameDecision(state, 'simulation');
  console.log('[evidence-governance] simulation yields a simulation asset with 0 autoPublished');
}

// --- controlled real double with eligible bound diagnostics: published -------
{
  const { state } = project({ environment: environments.controlledReal, diagnostics: eligibleDiagnostics() });
  const decision = state.benchmark.evidenceDecision;
  assert.equal(decision.execution.kind, 'live');
  assert.equal(decision.adoption.status, 'allowed');
  assert.equal(decision.publication.status, 'allowed');
  assert.equal(decision.diagnostics.tracer.evidenceEligible, true);
  assert.equal(decision.diagnostics.profiler.evidenceEligible, true);

  runAutomaticAdoption(state);
  assert.equal(state.currentBest.verified, true, 'verified follows publication allowed, not a live boolean');
  runKnowledgeMaintenance(state);
  assert.equal(state.publishedAssets[0].status, 'published');
  assert.equal(state.publishedAssets[0].evidenceLevel, 'Level 3');
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 1);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, 'auto_published');
  assertSameDecision(state, 'controlled-real');
  console.log('[evidence-governance] controlled real double with eligible diagnostics is the only published path');
}

// --- maintenance idempotence: repeat, JSON restore, derived timestamps -------
{
  const { state } = project({ environment: environments.sharedGpuDevelopment, diagnostics: unavailableDiagnostics() });
  runAutomaticAdoption(state);
  runKnowledgeMaintenance(state);
  const settled = JSON.stringify(state);

  runKnowledgeMaintenance(state);
  assert.equal(JSON.stringify(state), settled, 'repeated maintenance must be a no-op');

  const restored = JSON.parse(JSON.stringify(state));
  runKnowledgeMaintenance(restored);
  assert.equal(JSON.stringify(restored), settled, 'JSON restore must not re-run maintenance');

  // Derived timestamps/versions are outputs, never inputs: changing them cannot
  // trigger an endless re-process.
  const before = JSON.parse(JSON.stringify(state));
  state.knowledgeMaintenance.completedAt = '2000-01-01T00:00:00.000Z';
  state.publishedAssets[0].updated = '1999-12-31';
  const eventsBefore = state.runtimeEvents.length;
  runKnowledgeMaintenance(state);
  assert.equal(state.runtimeEvents.length, eventsBefore, 'derived timestamps must not add events');
  assert.equal(state.knowledgeMaintenance.completedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(state.publishedAssets[0].updated, '1999-12-31');
  assert.notEqual(JSON.stringify(state), JSON.stringify(before));

  // A changed draft version is a real input and re-processes exactly once.
  state.knowledgeDrafts[0].version = 'v2.0';
  const eventsAtChange = state.runtimeEvents.length;
  runKnowledgeMaintenance(state);
  assert.equal(state.runtimeEvents.length, eventsAtChange + 1, 'a changed draft version re-processes exactly once');
  const afterChange = JSON.stringify(state);
  runKnowledgeMaintenance(state);
  assert.equal(JSON.stringify(state), afterChange, 'after re-processing it must settle again');

  // A changed candidate/run binding is likewise a real input and re-processes
  // once, falling back to unknown because no bound decision matches it.
  state.knowledgeDrafts[0].evidenceBinding = { candidateId: CANDIDATE, candidateDigest: digest('other'), runId: RUN };
  const eventsAtRebind = state.runtimeEvents.length;
  runKnowledgeMaintenance(state);
  assert.equal(state.runtimeEvents.length, eventsAtRebind + 1, 'a changed binding re-processes exactly once');
  assert.equal(state.publishedAssets[0].status, 'unknown', 'a draft whose binding matches no decision stays unknown');
  console.log('[evidence-governance] maintenance is idempotent across repeat/restore and reprocesses changed inputs once');
}

// --- misbinding and legacy Level 3 are never promoted ------------------------
{
  const { state } = project({ environment: environments.controlledReal, diagnostics: eligibleDiagnostics() });
  assert.equal(state.benchmark.evidenceDecision.publication.status, 'allowed');
  state.knowledgeDrafts = [{
    id: 'exp.legacy', category: 'x', title: 'legacy', conclusion: 'c', hardware: ['C550'],
    operator: 'o', dtype: 'FP16', evidenceLevel: 'Level 3', status: 'validated', evidenceRefs: ['r'],
    evidence: 'e', publishable: true,
  }];
  runKnowledgeMaintenance(state);
  assert.equal(state.publishedAssets[0].status, 'unknown');
  assert.equal(state.publishedAssets[0].evidenceLevel, '未知证据');
  assert.equal(state.publishedAssets[0].publishable, false);
  assert.equal(state.knowledgeMaintenance.summary.autoPublished, 0);
  assert.equal(state.knowledgeMaintenance.changes[0].outcome, 'review_required');
  assert.equal(resolveGovernanceDecision(state, state.knowledgeDrafts[0]), null, 'a legacy draft without a decision must not be backfilled');
  console.log('[evidence-governance] legacy Level 3 without a decision stays unknown and unpublishable');
}

{
  const { state } = project({ environment: environments.controlledReal, diagnostics: eligibleDiagnostics() });
  state.knowledgeDrafts = [{
    id: 'exp.misbound', category: 'x', title: 'misbound', conclusion: 'c', hardware: ['C550'],
    operator: 'o', dtype: 'FP16', evidenceLevel: 'Level 3', status: 'validated', evidenceRefs: ['r'],
    evidence: 'e', publishable: true,
    sourceCandidate: CANDIDATE,
    evidenceBinding: { candidateId: CANDIDATE, candidateDigest: digest('not-the-current-candidate'), runId: RUN },
  }];
  assert.equal(resolveGovernanceDecision(state, state.knowledgeDrafts[0]), null, 'a mismatched digest must not be backfilled');
  runKnowledgeMaintenance(state);
  assert.equal(state.publishedAssets[0].status, 'unknown');
  assert.equal(state.publishedAssets[0].publishable, false);
  assert.equal(classifyEvidenceDecision(null).publishable, false);
  console.log('[evidence-governance] a misbound draft is never promoted by its Level 3 label');
}

// --- required diagnostics unavailable: recoverable external wait -------------
{
  const { state, snapshot } = project({ environment: environments.controlledReal, diagnostics: unavailableDiagnostics() });
  const decision = state.benchmark.evidenceDecision;
  assert.equal(decision.adoption.status, 'waiting_external_verification');
  assert.equal(decision.publication.status, 'waiting_external_verification');
  assert.deepEqual(decision.adoption.reasons, ['adoption.diagnostics_unavailable']);
  assert.equal(state.decisionReview.status, 'waiting_external_verification');
  assert.equal(state.missionPaused, true);
  assert.equal(state.iterationStats.loopStatus, 'blocked');
  assert.equal(state.iterationStats.loopStatusReason, 'external_verification');
  assert.equal(state.candidateEvaluations.length, 1, 'the candidate must be retained during external verification');
  assert.equal(state.candidateEvaluations[0].id, CANDIDATE);
  assert.equal(state.failureRecords.length, 0, 'a recoverable wait must not remove the candidate');
  assert.equal(state.knowledgeDrafts.length, 0, 'a waiting candidate must not form a knowledge draft');
  assert.equal(state.agent.runId, 'agent-egi-1', 'no new Agent may be started to fetch missing tools');
  assert.equal(state.agent.status, 'awaiting_action');
  assert.ok(state.runtimeEvents.some((event) => event.type === 'accept_gate.waiting_external_verification'));
  assert.equal(isExternalVerificationPending(state), true);
  assert.equal(detectLoopGuard(state), 'external_verification');

  // The projection is idempotent for the same terminal snapshot.
  const waitingSnapshot = structuredClone(state);
  applyOperatorTestSnapshot(state, snapshot);
  assert.equal(JSON.stringify(state), JSON.stringify(waitingSnapshot), 're-projecting the same snapshot must be a no-op');

  // Iteration must not call any start/cancel port while waiting.
  let ports = 0;
  const deps = {
    startResearch: async () => { ports += 1; },
    cancelResearch: async () => { ports += 1; },
    startMainRound: async () => { ports += 1; },
    researchDirForMission: () => null,
    now: () => Date.parse('2026-09-12T00:10:00.000Z'),
  };
  const budgetBefore = JSON.stringify({
    missionBudgetMs: state.missionBudgetMs ?? null,
    loopStartedAt: state.iterationStats.loopStartedAt ?? null,
    round: state.iterationStats.round ?? null,
  });
  const waitingAdvance = await advanceIteration(state, deps);
  assert.ok(['paused', 'external_verification'].includes(waitingAdvance.action), `waiting must short-circuit, got ${waitingAdvance.action}`);
  assert.equal(ports, 0, 'waiting must not start a new Agent / round');
  assert.equal(state.agent.runId, 'agent-egi-1');

  // Resume clears only the orchestration pause: budget and candidate facts stay.
  state.missionPaused = false;
  const resumedAdvance = await advanceIteration(state, deps);
  assert.equal(resumedAdvance.action, 'external_verification');
  assert.equal(ports, 0, 'resume with a blocked external wait still must not start a new run');
  assert.equal(JSON.stringify({
    missionBudgetMs: state.missionBudgetMs ?? null,
    loopStartedAt: state.iterationStats.loopStartedAt ?? null,
    round: state.iterationStats.round ?? null,
  }), budgetBefore, 'resume/retest must retain the budget record');
  assert.equal(state.candidateEvaluations.length, 1);

  // The resource release barrier still outranks any restart.
  const barrierState = JSON.parse(JSON.stringify(state));
  barrierState.agent.resourceRelease = { confirmed: false, status: 'unconfirmed', resources: [{ id: 'res-1' }] };
  const barrierAdvance = await advanceIteration(barrierState, deps);
  assert.ok(['resource_release_pending', 'needs_human'].includes(barrierAdvance.action));
  assert.equal(ports, 0, 'an unconfirmed resource release must not start a new run');
  console.log('[evidence-governance] missing required diagnostics wait recoverably with candidate/budget/barrier retained and 0 ports');
}

console.log('[evidence-governance-integration] decision projection, governance idempotence, and external wait contracts passed');
