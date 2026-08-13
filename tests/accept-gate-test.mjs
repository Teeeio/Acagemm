import assert from 'node:assert/strict';
import { applyOperatorTestSnapshot, evaluateAcceptGate, runAutomaticAdoption, runKnowledgeMaintenance, toPublishedKnowledgeAsset } from '../client-runtime/state-store.mjs';

const createState = ({ goal = '将 C500 latency p50 控制在 45 us 以下', correctness = true } = {}) => ({
  activeMissionId: 'MIS_GATE',
  appliedCandidateId: 'candidate-real',
  missions: [{ id: 'MIS_GATE', title: 'Gate Operator', goal, metric: 'latency p50', hardware: ['C500', 'CUDA'] }],
  stage: 'validation',
  agent: { runtimeKind: 'codex-cli', status: 'executing', messages: [], currentAction: null },
  benchmark: { status: 'running', testTaskId: 'task-gate', runId: 'run-gate', matrix: { correctnessCases: 24 } },
  decisionReview: { status: 'idle', policy: { id: 'policy.test' } },
  candidateEvaluations: [{ id: 'candidate-real', title: 'Real Candidate', version: 'agent.1', files: 'kernel.cu', patchDigest: 'sha256:test', hypothesis: 'reduce launch overhead', change: 'cache launch plan' }],
  failureRecords: [],
  knowledgeDrafts: [],
  runtimeEvents: [],
  auditEvents: [],
  currentBest: { candidateId: null, value: '--' },
  knowledgeMaintenance: { status: 'idle' },
  testMatrix: { correctnessCases: 24 },
  correctness,
});

const result = ({ value = 41.8, correctness = true, liveHardware = false } = {}) => ({
  benchmark: [
    { environment: 'C500', value, unit: 'us', correctness: { passed: correctness, total: 24 } },
    { environment: 'CUDA', value: 36.8, unit: 'us', correctness: { passed: correctness, total: 24 } },
  ],
  tracer: { format: 'operator-trace/v1', events: [{ name: 'kernel' }] },
  profiler: { format: 'operator-profile/v1', metrics: { kernelDurationUs: 20 } },
  environment: { runtime: liveHardware ? 'live-runtime' : 'mock-runtime', liveHardware },
});

const passingState = createState();
const passingGate = evaluateAcceptGate(passingState, result());
assert.equal(passingGate.passed, true);
assert.equal(passingGate.result, 'eligible');
assert.equal(passingGate.publishable, false);
assert.equal(passingGate.evidenceSource, 'mock');
assert.ok(passingGate.skippedRules.includes('cross_platform.regression'));
applyOperatorTestSnapshot(passingState, { taskId: 'task-gate', status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: result() });
assert.equal(passingState.decisionReview.recommendation, 'adopt');
assert.equal(passingState.candidateEvaluations[0].classification, 'eligible');
assert.equal(passingState.knowledgeDrafts.length, 1);
assert.equal(passingState.knowledgeDrafts[0].evidenceLevel, '模拟证据');
assert.equal(passingState.knowledgeDrafts[0].status, 'simulation');
runAutomaticAdoption(passingState);
assert.equal(passingState.stage, 'curation');
assert.equal(passingState.currentBest.candidateId, 'candidate-real');
assert.equal(passingState.currentBest.verified, false);
runKnowledgeMaintenance(passingState);
assert.equal(passingState.publishedAssets[0].status, 'simulation');
assert.equal(passingState.knowledgeMaintenance.summary.autoPublished, 0);
assert.equal(passingState.knowledgeMaintenance.summary.reviewRequired, 1);
const staleMockState = createState();
staleMockState.benchmark.result = result();
staleMockState.knowledgeDrafts = [{ ...passingState.knowledgeDrafts[0], status: 'validated', evidenceLevel: 'Level 3' }];
staleMockState.publishedAssets = [toPublishedKnowledgeAsset(staleMockState.knowledgeDrafts[0])];
staleMockState.knowledgeMaintenance = { status: 'completed' };
runKnowledgeMaintenance(staleMockState);
assert.equal(staleMockState.publishedAssets[0].status, 'simulation');
assert.equal(staleMockState.knowledgeDrafts[0].evidenceLevel, '模拟证据');

const liveState = createState();
const liveGate = evaluateAcceptGate(liveState, result({ liveHardware: true }));
assert.equal(liveGate.passed, true);
assert.equal(liveGate.publishable, true);
applyOperatorTestSnapshot(liveState, { taskId: 'task-gate', status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: result({ liveHardware: true }) });
runAutomaticAdoption(liveState);
runKnowledgeMaintenance(liveState);
assert.equal(liveState.currentBest.verified, true);
assert.equal(liveState.publishedAssets[0].status, 'published');

const missingTargetState = createState({ goal: '优化 C500 latency p50' });
const missingTargetGate = evaluateAcceptGate(missingTargetState, result());
assert.equal(missingTargetGate.passed, false);
assert.equal(missingTargetGate.result, 'reference');
assert.ok(missingTargetGate.failedRules.includes('performance.target'));

const referenceState = createState();
applyOperatorTestSnapshot(referenceState, { taskId: 'task-gate', status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: result({ value: 48.2 }) });
assert.equal(referenceState.decisionReview.recommendation, 'reference');
assert.equal(referenceState.candidateEvaluations[0].classification, 'reference');
assert.equal(referenceState.stage, 'evidence');

const failedState = createState();
applyOperatorTestSnapshot(failedState, { taskId: 'task-gate', status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: result({ correctness: false }) });
assert.equal(failedState.decisionReview.recommendation, 'reject');
assert.equal(failedState.candidateEvaluations.length, 0);
assert.equal(failedState.failureRecords[0].failure.disposition, 'candidate_removed');
assert.equal(failedState.failureRecords[0].extractedExperience.status, 'extracted');

console.log('[accept-gate] provenance, target, eligible, reference, and hard-failure dispositions passed');
