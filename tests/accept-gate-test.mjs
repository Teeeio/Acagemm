import assert from 'node:assert/strict';
import { applyOperatorTestSnapshot } from '../client-runtime/operator-test-evidence.mjs';
import { evaluateAcceptGate } from '../client-runtime/accept-gate.mjs';
import { runAutomaticAdoption, runKnowledgeMaintenance, toPublishedKnowledgeAsset } from '../client-runtime/state-store.mjs';

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

const createState = ({ goal = '将 C500 latency p50 控制在 45 us 以下', correctness = true, baseline = baselineEvidence } = {}) => ({
  activeMissionId: 'MIS_GATE',
  appliedCandidateId: 'candidate-real',
  missions: [{ id: 'MIS_GATE', title: 'Gate Operator', goal, metric: 'latency p50', hardware: ['C500', 'CUDA'], baseline }],
  stage: 'validation',
  agent: { runtimeKind: 'codex-cli', status: 'executing', messages: [], currentAction: null },
  benchmark: {
    status: 'running',
    testTaskId: 'task-gate',
    remoteTaskId: 'backend-task-gate',
    runId: 'run-gate',
    candidate: { id: 'candidate-real', digest: 'sha256:test', sourceRunId: 'source-run-gate' },
    matrix: { correctnessCases: 24 },
  },
  decisionReview: { status: 'idle', policy: { id: 'policy.test' } },
  candidateEvaluations: [{ id: 'candidate-real', title: 'Real Candidate', version: 'agent.1', files: 'kernel.cu', patchDigest: 'sha256:test', hypothesis: 'reduce launch overhead', change: 'cache launch plan' }],
  failureRecords: [],
  knowledgeDrafts: [],
  runtimeEvents: [],
  auditEvents: [],
  currentBest: { candidateId: null, value: '--' },
  baseline,
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
// P2_EVIDENCE_ACCEPTANCE.md: the legacy flat `evidenceSource` is a projection of
// the same decision's execution classification, not an independent publication
// authority. Assert it against that decision instead of the removed `'mock'`
// literal; the nonpublishability itself is asserted separately above.
assert.equal(passingGate.evidenceSource, passingGate.decision.execution.kind);
assert.equal(passingGate.decision.execution.kind, 'simulation');
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

// Legacy migration (P2_EVIDENCE_ACCEPTANCE.md): a `liveHardware` boolean is not
// publication authority, and "looks like operator-trace/v1 + operator-profile/v1"
// is not real diagnostic qualification. These test doubles carry no
// status/source/content/binding, so the full real branch must fail and the
// result must stay nonpublishable. The old `passed=true`/`publishable=true`
// assertions were the defect this contract closes.
const liveState = createState();
const liveGate = evaluateAcceptGate(liveState, result({ liveHardware: true }));
assert.equal(liveGate.passed, false, 'format-only diagnostics cannot satisfy the required full real diagnostic branch');
assert.equal(liveGate.publishable, false, 'a liveHardware boolean alone never authorizes publication');
assert.ok(liveGate.failedRules.includes('evidence.complete'));
assert.equal(liveGate.decision?.diagnostics?.tracer?.evidenceEligible, false);
assert.notEqual(liveGate.decision?.publication?.status, 'allowed');

// Dedicated qualified real positive: real completed tool provenance, content
// that satisfies the kernel-measurement rules, and an exact candidate/run
// binding. This is a controlled contract test double, not proof of a live
// publication run.
const qualifiedBinding = {
  missionId: 'MIS_GATE',
  candidateId: 'candidate-real',
  candidateDigest: 'sha256:test',
  runId: 'run-gate',
  taskId: 'backend-task-gate',
  sourceRunId: 'source-run-gate',
  semanticDigest: null,
};
const qualifiedRealResult = ({ value = 41.8 } = {}) => ({
  ...result({ value, liveHardware: true }),
  environment: {
    runtime: 'local-c500-runner/v1',
    service: 'local-c500-adapter',
    source: 'local-c500',
    liveHardware: true,
    publishable: true,
    candidateDigest: 'sha256:test',
    runId: 'run-gate',
    sourceRunId: 'source-run-gate',
    taskId: 'backend-task-gate',
  },
  tracer: {
    format: 'operator-trace/v1',
    status: 'completed',
    source: 'mctracer',
    simulated: false,
    binding: qualifiedBinding,
    artifacts: ['artifacts/mctracer/stdout.txt'],
    events: [{ category: 'kernel', name: 'paged_decode_kernel', startUs: 0, durationUs: 12.5 }],
  },
  profiler: {
    format: 'operator-profile/v1',
    status: 'completed',
    source: 'mcProfiler',
    simulated: false,
    binding: qualifiedBinding,
    artifacts: ['artifacts/mcProfiler/stdout.txt'],
    metrics: { kernelDurationUs: 12.5, occupancy: 0.62, bandwidth: 412.5 },
  },
});
const qualifiedState = createState();
const qualifiedGate = evaluateAcceptGate(qualifiedState, qualifiedRealResult());
assert.equal(qualifiedGate.passed, true, 'fully qualified real diagnostics satisfy the full real branch');
assert.equal(qualifiedGate.publishable, true, 'qualified unrestricted real evidence may pass the domain publication policy');
assert.equal(qualifiedGate.decision?.publication?.status, 'allowed');
// The production snapshot must carry its own backend identity and the queue
// request id. Omitting remoteTaskId/payload.requestId would leave the expected
// task binding null, so the fixture would "pass" without ever checking the
// sourceRunId / queue runId / remoteTaskId distinction.
applyOperatorTestSnapshot(qualifiedState, {
  taskId: 'task-gate',
  remoteTaskId: 'backend-task-gate',
  payload: { requestId: 'run-gate', runId: 'run-gate' },
  status: 'completed',
  progress: 100,
  completedAt: new Date().toISOString(),
  result: qualifiedRealResult(),
});
assert.equal(qualifiedState.benchmark.remoteTaskId, 'backend-task-gate');
assert.equal(qualifiedState.benchmark.requestId, 'run-gate');
const qualifiedDecision = qualifiedState.benchmark.evidenceDecision;
assert.ok(qualifiedDecision, 'the production apply path stores the exact decision on benchmark.evidenceDecision');
assert.equal(qualifiedDecision.binding.runId, 'run-gate', 'queue runId is retained as its own identity');
assert.equal(qualifiedDecision.binding.taskId, 'backend-task-gate', 'remoteTaskId is retained as its own identity');
assert.equal(qualifiedDecision.binding.sourceRunId, 'source-run-gate', 'sourceRunId is retained as its own identity');
assert.notEqual(qualifiedDecision.binding.runId, qualifiedDecision.binding.taskId);
assert.notEqual(qualifiedDecision.binding.runId, qualifiedDecision.binding.sourceRunId);
runAutomaticAdoption(qualifiedState);
runKnowledgeMaintenance(qualifiedState);
assert.equal(qualifiedState.currentBest.verified, true);
// Consumer projection uses the same decision's execution.source; the flat Gate
// evidenceSource is not consulted and no legacy string grants publication.
assert.equal(qualifiedState.currentBest.evidenceSource, qualifiedDecision.execution.source);
assert.equal(qualifiedState.currentBest.evidenceSource, 'local-c500');
assert.equal(qualifiedState.publishedAssets[0].status, 'published');

const sharedGpuState = createState();
const sharedGpuGate = evaluateAcceptGate(sharedGpuState, {
  ...result({ liveHardware: true }),
  environment: {
    runtime: 'local-shared-gpu-runner/v1', source: 'local-shared-gpu',
    executionMode: 'gpu', liveHardware: true, publishable: false,
  },
});
assert.equal(sharedGpuGate.passed, true, 'shared GPU measurements may still drive development iteration');
assert.equal(sharedGpuGate.publishable, false, 'shared GPU evidence cannot authorize publication');
assert.equal(sharedGpuGate.evidenceSource, 'shared-gpu-development');

const incompleteLocalC500State = createState();
const incompleteLocalC500Gate = evaluateAcceptGate(incompleteLocalC500State, {
  ...result({ liveHardware: true }),
  tracer: { format: 'operator-trace/v1', status: 'missing', events: [] },
  profiler: { format: 'operator-profile/v1', status: 'missing', metrics: {} },
  environment: { runtime: 'local-c500-runner/v1', service: 'local-c500-adapter', liveHardware: true },
});
assert.equal(incompleteLocalC500Gate.passed, true, 'local benchmark-core development may adopt with unavailable optional diagnostics');
// Legacy migration: missing/mock diagnostics used to be projected to
// publishable=true through the liveHardware boolean. The frozen contract says
// missing status never proves availability and publication requires both
// qualified real diagnostics, so this result stays nonpublishable.
assert.equal(incompleteLocalC500Gate.publishable, false);
assert.equal(incompleteLocalC500Gate.result, 'eligible');
assert.ok(!incompleteLocalC500Gate.failedRules.includes('evidence.complete'));
assert.equal(incompleteLocalC500Gate.rules.find((rule) => rule.id === 'diagnostics.mctracer')?.passed, false);
assert.equal(incompleteLocalC500Gate.rules.find((rule) => rule.id === 'diagnostics.mcprofiler')?.passed, false);
assert.equal(incompleteLocalC500Gate.decision?.diagnostics?.tracer?.available, false);
assert.notEqual(incompleteLocalC500Gate.decision?.publication?.status, 'allowed', 'unavailable diagnostics must block publication');

const maximizeState = createState({ goal: '目标不设上限，加速比越高越好' });
maximizeState.objective = { mode: 'maximize', metric: 'latency p50', direction: 'minimize', completionPolicy: 'budget_or_plateau' };
maximizeState.missions[0].objective = maximizeState.objective;
applyOperatorTestSnapshot(maximizeState, { taskId: 'task-gate', status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: qualifiedRealResult({ value: 39.5 }) });
assert.equal(maximizeState.decisionReview.recommendation, 'adopt');
runAutomaticAdoption(maximizeState);
assert.equal(maximizeState.stage, 'evidence', 'maximize mission 采用后不应进入发布终态');
assert.equal(maximizeState.currentBest.candidateId, 'candidate-real');
assert.equal(maximizeState.knowledgeMaintenance.status, 'ready');
runKnowledgeMaintenance(maximizeState);
assert.equal(maximizeState.stage, 'evidence', 'maximize mission 经验记录后仍应继续迭代');
assert.equal(maximizeState.knowledgeMaintenance.status, 'completed');
assert.equal(maximizeState.agent.phase, 'Current best 已更新，继续优化');
assert.ok(maximizeState.runtimeEvents.some((event) => event.type === 'decision.auto_adopted' && event.payload?.objectiveMode === 'maximize'));
assert.ok(maximizeState.runtimeEvents.some((event) => event.type === 'knowledge.maintenance_completed' && event.payload?.objectiveMode === 'maximize'));

const baselineRunState = createState({ baseline: { required: true, kind: 'pytorch_reference', status: 'missing', evidence: null } });
baselineRunState.benchmark.purpose = 'baseline';
baselineRunState.benchmark.baselineKind = 'pytorch_reference';
baselineRunState.benchmark.baselineSource = upstreamSource;
applyOperatorTestSnapshot(baselineRunState, { taskId: 'task-gate', status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: result({ value: 55, liveHardware: true }) });
assert.equal(baselineRunState.baseline.status, 'complete');
assert.equal(baselineRunState.baseline.evidence.kind, 'pytorch_reference');
assert.equal(baselineRunState.baseline.evidence.source.repository, upstreamSource.repository);
assert.equal(baselineRunState.decisionReview.recommendation, 'baseline');
assert.equal(baselineRunState.currentBest.candidateId, null);

const generatedBaselineState = createState({
  goal: '优化 C500 latency p50',
  baseline: {
    required: true,
    kind: 'pytorch_reference',
    status: 'complete',
    evidence: { ...baselineEvidence.evidence, source: { ...upstreamSource, authority: 'generated' } },
  },
});
const generatedBaselineGate = evaluateAcceptGate(generatedBaselineState, result());
assert.equal(generatedBaselineGate.passed, false, '自动生成 baseline 不能作为采用依据');
assert.ok(generatedBaselineGate.failedRules.includes('baseline.current_reference'));

const naiveV0State = createState({
  goal: '优化 C500 latency p50',
  baseline: {
    required: true,
    kind: 'naive_v0',
    status: 'complete',
    sourcePolicy: { requireAuthority: false, requireSingleFileExpansion: true, allowGeneratedV0: true },
    evidence: {
      ...baselineEvidence.evidence,
      kind: 'naive_v0',
      value: 58.0,
      source: {
        authority: 'generated',
        kind: 'naive_v0',
        type: 'naive_v0',
        repository: 'mission-workspace',
        commit: 'v0',
        path: 'generated/paged_decode/naive_v0/run.py',
        expandedSingleFile: true,
        basedOn: 'v0',
      },
    },
  },
});
const naiveV0Gate = evaluateAcceptGate(naiveV0State, result());
assert.equal(naiveV0Gate.passed, true, '显式标注的 naive_v0 baseline 应允许作为当前有效基线');
assert.ok(naiveV0Gate.rules.find((rule) => rule.id === 'baseline.current_reference')?.passed);

const noBaselineState = createState({ goal: '优化 C500 latency p50', baseline: { required: true, kind: 'pytorch_reference', status: 'missing', evidence: null } });
const noBaselineGate = evaluateAcceptGate(noBaselineState, result());
assert.equal(noBaselineGate.passed, false, '缺少 PyTorch reference baseline 时不能采用优化候选');
assert.ok(noBaselineGate.failedRules.includes('baseline.current_reference'));
assert.ok(noBaselineGate.failedRules.includes('performance.target'));

const noTargetInitialState = createState({ goal: '优化 C500 latency p50' });
const noTargetInitialGate = evaluateAcceptGate(noTargetInitialState, result());
assert.equal(noTargetInitialGate.passed, true, '无阈值且无 current best 时，应与 PyTorch reference baseline 比较');
assert.equal(noTargetInitialGate.result, 'eligible');

const suitePolicy = { acceptFirstCorrectCandidate: true, requireStrictImprovement: true, requireAllProfilesNoRegression: true };
const suiteResult = (profiles, values) => ({
  ...result(),
  // P2_EVIDENCE_ACCEPTANCE.md: fixed-matrix KEEP/DISCARD is exercised on the
  // documented local benchmark-core live path, where the real diagnostics stay
  // optional. The dedicated qualified-real positive above owns the full
  // status/source/binding/events/metrics publication branch. A bare
  // liveHardware=true plus format-only envelopes is no longer live evidence.
  environment: { runtime: 'local-c500-runner/v1', service: 'local-c500-adapter', source: 'local-c500', liveHardware: true },
  benchmark: profiles.map((profile, index) => ({ environment: 'C500', profile, value: values[index], unit: 'us', correctness: { passed: true, total: 24 } })),
});
const createSuiteState = (profiles, bestValues = null) => {
  const state = createState({ goal: '建立 Triton baseline 后进行三轮优化', baseline: structuredClone(baselineEvidence) });
  state.missions[0].testScenario = { iterationPolicy: suitePolicy };
  state.testMatrix = { correctnessCases: 24, testSpec: { benchmark: { requiredProfiles: profiles, primaryProfile: profiles[0] } } };
  state.benchmark.matrix = structuredClone(state.testMatrix);
  state.baseline.evidence.shapeKey = JSON.stringify({ correctnessCases: 24 });
  if (bestValues) state.currentBest = { candidateId: 'candidate-best', value: `${bestValues[0]} us`, measurements: profiles.map((profile, index) => ({ profile, value: bestValues[index], unit: 'us' })) };
  return state;
};
for (const suiteProfiles of [['MQA Medium', 'MQA Large'], ['MLA Medium', 'MLA Large']]) {
  const suiteInitialGate = evaluateAcceptGate(createSuiteState(suiteProfiles), suiteResult(suiteProfiles, [120, 130]));
  assert.equal(suiteInitialGate.passed, true, '首个通过固定 Correctness 的 Triton 版本必须成为性能 baseline，即使暂未快于 PyTorch');
  assert.match(suiteInitialGate.rules.find((rule) => rule.id === 'performance.target')?.expected || '', /首个通过/);

  const suiteBestState = createSuiteState(suiteProfiles, [120, 130]);
  assert.equal(evaluateAcceptGate(suiteBestState, suiteResult(suiteProfiles, [119, 130])).passed, true, '至少一项严格提升且另一个固定 profile 无回退时 KEEP');
  assert.equal(evaluateAcceptGate(suiteBestState, suiteResult(suiteProfiles, [120, 130])).passed, false, '两个 profile 全部持平时 DISCARD');
  assert.equal(evaluateAcceptGate(suiteBestState, suiteResult(suiteProfiles, [119, 131])).passed, false, '任一固定 profile 回退时 DISCARD');
  const missingProfileGate = evaluateAcceptGate(suiteBestState, suiteResult([suiteProfiles[0]], [119]));
  assert.equal(missingProfileGate.passed, false, '缺少任一固定 Benchmark shape 时不得通过 Gate');
  assert.ok(missingProfileGate.failedRules.includes('benchmark.profiles_complete'));
}

const researchBriefingState = createState({ goal: '相对 baseline 至少提升 20%；同族方向连续两轮改善低于 3% 时停止。' });
researchBriefingState.baseline.evidence.value = 100;
const researchBriefingGate = evaluateAcceptGate(researchBriefingState, result({ value: 75 }));
assert.equal(researchBriefingGate.passed, true, '研究简报中的百分比不能被解析成绝对延迟阈值');
assert.match(
  researchBriefingGate.rules.find((rule) => rule.id === 'performance.target')?.expected || '',
  /baseline 至少提升 20%/,
);

const aliasBaseline = {
  ...baselineEvidence,
  evidence: { ...baselineEvidence.evidence, environment: 'gpu-iluvatar-mainstream', value: 55.0 },
};
const aliasState = createState({
  goal: '优化天数 latency p50',
  baseline: aliasBaseline,
});
aliasState.missions[0].hardware = ['Iluvatar MR-V100'];
aliasState.testMatrix = { environments: ['天数 Iluvatar'], correctnessCases: 24 };
aliasState.benchmark.matrix = { environments: ['天数 Iluvatar'], correctnessCases: 24 };
const aliasGate = evaluateAcceptGate(aliasState, {
  ...result({ value: 49.0 }),
  benchmark: [{ environment: '天数 Iluvatar', value: 49.0, unit: 'us', correctness: { passed: true, total: 24 } }],
});
assert.equal(aliasGate.passed, true, 'runner 显示名、中文名和平台 ID 应归一到同一 runner');

const noTargetFasterState = createState({ goal: '优化 C500 latency p50' });
noTargetFasterState.currentBest = { candidateId: 'candidate-best', value: '45.0 us' };
const noTargetFasterGate = evaluateAcceptGate(noTargetFasterState, result({ value: 41.8 }));
assert.equal(noTargetFasterGate.passed, true, '无阈值时应与 current best 比较，latency 更低则通过');
assert.equal(noTargetFasterGate.result, 'eligible');

const noTargetSlowerState = createState({ goal: '优化 C500 latency p50' });
noTargetSlowerState.currentBest = { candidateId: 'candidate-best', value: '45.0 us' };
const noTargetSlowerGate = evaluateAcceptGate(noTargetSlowerState, result({ value: 48.2 }));
assert.equal(noTargetSlowerGate.passed, false);
assert.equal(noTargetSlowerGate.result, 'reference');
assert.ok(noTargetSlowerGate.failedRules.includes('performance.target'));

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

const infraFailedState = createState();
applyOperatorTestSnapshot(infraFailedState, {
  taskId: 'task-gate',
  status: 'failed',
  progress: 100,
  completedAt: new Date().toISOString(),
  error: { code: 'REMOTE_UNREACHABLE', message: 'remote API unreachable: Client network socket disconnected before secure TLS connection was established' },
});
assert.equal(infraFailedState.stage, 'validation');
assert.equal(infraFailedState.agent.status, 'awaiting_action');
assert.equal(infraFailedState.agent.phase, '远端测试基础设施待恢复');
assert.equal(infraFailedState.decisionReview.status, 'idle');
assert.equal(infraFailedState.candidateEvaluations[0].classification, undefined);
assert.equal(infraFailedState.failureRecords.length, 0);
assert.equal(infraFailedState.benchmark.lastServiceError.code, 'REMOTE_UNREACHABLE');
assert.ok(infraFailedState.runtimeEvents.some((event) => event.type === 'operator_test.infra_failed'));

const runnerTimeoutState = createState();
runnerTimeoutState.benchmark.purpose = 'candidate';
applyOperatorTestSnapshot(runnerTimeoutState, {
  taskId: 'task-gate',
  status: 'failed',
  progress: 100,
  completedAt: new Date().toISOString(),
  error: { code: 'REMOTE_TEST_FAILED', message: 'Compute runner did not return before the task timeout.' },
});
assert.equal(runnerTimeoutState.stage, 'diagnosis');
assert.equal(runnerTimeoutState.agent.status, 'completed');
assert.equal(runnerTimeoutState.agent.phase, '候选测试失败，继续优化');
assert.equal(runnerTimeoutState.decisionReview.recommendation, 'reject');
assert.equal(runnerTimeoutState.failureRecords[0].failure.code, 'REMOTE_TEST_FAILED');
assert.equal(runnerTimeoutState.candidateEvaluations[0].classification, 'rejected');
assert.ok(runnerTimeoutState.runtimeEvents.some((event) => event.type === 'operator_test.failed'));

// P2_EVIDENCE_ACCEPTANCE.md 5: an identical terminal snapshot is a governance
// no-op, including after a JSON round-trip restore. Idempotency is keyed on the
// full canonical snapshot content, never on a coincident completedAt.
const sameCompletedAt = '2026-09-12T00:00:00.000Z';
const productionSnapshot = (overrides = {}) => ({
  taskId: 'task-gate',
  remoteTaskId: 'backend-task-gate',
  payload: { requestId: 'run-gate', runId: 'run-gate' },
  status: 'completed',
  progress: 100,
  completedAt: sameCompletedAt,
  result: result(),
  ...overrides,
});
const replayState = createState();
applyOperatorTestSnapshot(replayState, productionSnapshot());
const afterFirstApply = {
  runtimeEvents: replayState.runtimeEvents.length,
  auditEvents: replayState.auditEvents.length,
  knowledgeDrafts: replayState.knowledgeDrafts.length,
  classification: replayState.candidateEvaluations[0]?.classification,
  recommendation: replayState.decisionReview.recommendation,
  snapshotFingerprint: replayState.benchmark.snapshotFingerprint,
};
assert.ok(afterFirstApply.runtimeEvents > 0, 'the first projection is processed');
applyOperatorTestSnapshot(replayState, productionSnapshot());
assert.equal(replayState.runtimeEvents.length, afterFirstApply.runtimeEvents, 'same-object replay adds no events');
assert.equal(replayState.auditEvents.length, afterFirstApply.auditEvents, 'same-object replay adds no audit entries');
assert.equal(replayState.knowledgeDrafts.length, afterFirstApply.knowledgeDrafts, 'same-object replay adds no draft version');
assert.equal(replayState.candidateEvaluations[0]?.classification, afterFirstApply.classification);
assert.equal(replayState.decisionReview.recommendation, afterFirstApply.recommendation);
const restoredState = JSON.parse(JSON.stringify(replayState));
applyOperatorTestSnapshot(restoredState, JSON.parse(JSON.stringify(productionSnapshot())));
assert.equal(restoredState.benchmark.snapshotFingerprint, afterFirstApply.snapshotFingerprint);
assert.equal(restoredState.runtimeEvents.length, afterFirstApply.runtimeEvents, 'JSON-restore replay adds no events');
assert.equal(restoredState.auditEvents.length, afterFirstApply.auditEvents, 'JSON-restore replay adds no audit entries');
assert.equal(restoredState.knowledgeDrafts.length, afterFirstApply.knowledgeDrafts, 'JSON-restore replay adds no draft version');
assert.equal(restoredState.benchmark.completedAt, sameCompletedAt);

// Same task, same completedAt, same result: only the resource-release
// confirmation changes. That is a different fact and must be processed.
const releaseChangeState = createState();
applyOperatorTestSnapshot(releaseChangeState, productionSnapshot({ resourceRelease: { confirmed: true, status: 'confirmed' } }));
assert.equal(releaseChangeState.benchmark.status, 'complete');
assert.equal(releaseChangeState.benchmark.resourceRelease.confirmed, true);
applyOperatorTestSnapshot(releaseChangeState, productionSnapshot({
  resourceRelease: {
    confirmed: false, status: 'unconfirmed',
    reason: 'release not confirmed yet', nextAction: 'keep observing the owning backend',
  },
}));
assert.equal(releaseChangeState.benchmark.completedAt, sameCompletedAt);
assert.equal(releaseChangeState.benchmark.status, 'running', 'an unconfirmed release must not stay a terminal snapshot');
assert.equal(releaseChangeState.benchmark.resourceRelease.confirmed, false);
applyOperatorTestSnapshot(releaseChangeState, productionSnapshot({ resourceRelease: { confirmed: true, status: 'confirmed' } }));
assert.equal(releaseChangeState.benchmark.status, 'complete', 'a later release confirmation is processed again');
assert.equal(releaseChangeState.benchmark.resourceRelease.confirmed, true);

// Same task, same completedAt, same release: a result/diagnostic change is a
// different observation and must be re-evaluated, not swallowed by the equal
// timestamp.
const diagnosticChangeState = createState();
applyOperatorTestSnapshot(diagnosticChangeState, productionSnapshot());
assert.notEqual(diagnosticChangeState.benchmark.evidenceDecision.publication.status, 'allowed', 'simulation result is not publication authority');
applyOperatorTestSnapshot(diagnosticChangeState, productionSnapshot({ result: qualifiedRealResult() }));
assert.equal(diagnosticChangeState.benchmark.completedAt, sameCompletedAt);
assert.equal(diagnosticChangeState.benchmark.result.tracer.status, 'completed', 'the changed diagnostic envelope is projected');
assert.equal(diagnosticChangeState.benchmark.evidenceDecision.diagnostics.tracer.evidenceEligible, true);
assert.equal(diagnosticChangeState.benchmark.evidenceDecision.publication.status, 'allowed', 'the re-evaluated decision reflects the upgraded diagnostics');

// Required real diagnostics missing pauses for external verification without
// removing the candidate or driving a new Agent; a correct retry of the same
// candidate/run does not spawn a new Agent either.
const waitingState = createState();
applyOperatorTestSnapshot(waitingState, productionSnapshot({ result: result({ liveHardware: true }) }));
assert.equal(waitingState.benchmark.status, 'complete');
assert.equal(waitingState.decisionReview.status, 'waiting_external_verification');
assert.equal(waitingState.missionPaused, true);
assert.equal(waitingState.iterationStats.loopStatus, 'blocked');
assert.equal(waitingState.iterationStats.loopStatusReason, 'external_verification');
assert.equal(waitingState.agent.currentAction.id, 'action.external-verification');
assert.equal(waitingState.agent.runtimeKind, 'codex-cli');
assert.equal(waitingState.candidateEvaluations.length, 1, 'the waiting candidate is preserved');
assert.equal(waitingState.candidateEvaluations[0].id, 'candidate-real');
assert.equal(waitingState.failureRecords.length, 0, 'waiting for diagnostics is not a candidate failure');
applyOperatorTestSnapshot(waitingState, productionSnapshot({ result: qualifiedRealResult() }));
assert.equal(waitingState.missionPaused, false, 'a qualified retry clears the external-verification pause');
assert.equal(waitingState.iterationStats.loopStatus, 'running');
assert.equal(waitingState.iterationStats.loopStatusReason, null);
assert.equal(waitingState.decisionReview.status, 'auto_ready');
assert.equal(waitingState.agent.runtimeKind, 'codex-cli', 'the retry reuses the same Agent runtime, it does not spawn a new Agent');
assert.equal(waitingState.agent.currentAction.id, 'action.adoption-decision');
assert.equal(waitingState.candidateEvaluations.length, 1, 'the retry does not generate a new candidate');
assert.equal(waitingState.candidateEvaluations[0].id, 'candidate-real');

console.log('[accept-gate] provenance, target, eligible, reference, hard-failure, snapshot-replay and diagnostic-wait dispositions passed');
