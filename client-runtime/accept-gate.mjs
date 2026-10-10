import { runnerMatches } from './runner-aliases.mjs';
import { assertSemanticTaskBinding, semanticTestSpecDigest } from './semantic-snapshot.mjs';
import { createBaselineRequirementState, createBaselineSourcePolicy, normalizeBaselineKind } from './evidence-state.mjs';
import { coverageIsComplete } from './correctness-coverage.mjs';
import {
  DECISION_REASONS,
  EVIDENCE_DECISION_POLICY_VERSION,
  EVIDENCE_DECISION_SCHEMA_VERSION,
  buildExpectedDiagnosticBinding,
  classifyDiagnosticReasons,
  classifyExecution,
  isDevelopmentAcceleratorCoreEvidence,
  evaluateDiagnosticEvidence,
  hasPublicationRestriction,
} from './evidence-decision.mjs';
import { parsePerformanceThreshold, parseRelativeImprovementTarget } from './mission-objective.mjs';
import { evaluateBusinessAcceptance } from './business-acceptance.mjs';

const parseMeasurementValue = (value) => {
  if (Number.isFinite(Number(value))) return Number(value);
  const match = String(value || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
};

const stableShapeValue = (value) => {
  if (Array.isArray(value)) return value.map(stableShapeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableShapeValue(value[key])]));
  }
  return value;
};

const normalizeShapeKey = (shapeKeyOrValue) => {
  if (typeof shapeKeyOrValue === 'string') {
    try { return JSON.stringify(stableShapeValue(JSON.parse(shapeKeyOrValue))); } catch { return shapeKeyOrValue; }
  }
  return JSON.stringify(stableShapeValue(shapeKeyOrValue || {}));
};

const shapeKeyFor = (mission = {}, matrix = {}) => normalizeShapeKey(mission.upstream?.case || matrix?.shape || {
  correctnessCases: matrix?.correctnessCases || 24,
});

const primaryMeasurementFor = (mission = {}, measurements = []) => {
  const primaryHardware = mission.hardware?.[0] || measurements[0]?.environment || '';
  return measurements.find((item) => runnerMatches(item.environment, primaryHardware)) || measurements[0];
};

const baselineEvidenceFor = (state, mission) => {
  const baseline = state.baseline || mission.baseline || createBaselineRequirementState();
  return baseline.evidence || null;
};

const baselineMatchesRun = (baselineEvidence, mission, matrix, primary) => {
  if (!baselineEvidence) return false;
  const sameRunner = runnerMatches(baselineEvidence.environment, primary?.environment);
  const sameShape = normalizeShapeKey(baselineEvidence.shapeKey) === shapeKeyFor(mission, matrix);
  return sameRunner && sameShape;
};

const baselineSourceTrusted = (baseline = {}, baselineEvidence = {}) => {
  if (baseline.required === false) return true;
  const policy = baseline.sourcePolicy || createBaselineSourcePolicy(baseline.kind);
  const baselineKind = normalizeBaselineKind(baselineEvidence.kind || baseline.kind);
  const source = baselineEvidence.source || baseline.source || null;
  if (!source || typeof source !== 'object') return false;
  const singleFileExpanded = source.expandedSingleFile === true;
  if (source.semanticFallback === true || source.authority === 'agent-semantic') {
    return policy.allowAgentSemantic === true
      && (policy.requireSingleFileExpansion === false || singleFileExpanded);
  }
  if (baselineKind === 'naive_v0' || source.kind === 'naive_v0' || source.type === 'naive_v0' || source.authority === 'generated' || source.authority === 'synthetic') {
    const basis = String(source.basedOn || source.basis || source.version || source.commit || '').trim().toLowerCase();
    const generatedMarker = Boolean(source.authority === 'generated' || source.type === 'naive_v0' || source.kind === 'naive_v0');
    const basisMatch = ['v0', 'naive_v0', 'baseline-v0'].includes(basis);
    return generatedMarker && basisMatch && (policy.requireSingleFileExpansion === false || singleFileExpanded);
  }
  if (policy.requireAuthority === false && policy.allowGeneratedV0 === true) return singleFileExpanded;
  const hasAuthority = Boolean(source.repository && source.commit && source.path) && source.authority !== 'generated' && source.authority !== 'synthetic' && source.type !== 'generated';
  return (policy.requireAuthority === false || hasAuthority) && (policy.requireSingleFileExpansion === false || singleFileExpanded);
};

export const buildBaselineEvidence = (state, result = {}) => {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const measurements = Array.isArray(result.benchmark) ? result.benchmark : [];
  const primaryProfile = state.benchmark?.matrix?.testSpec?.benchmark?.primaryProfile || state.testMatrix?.testSpec?.benchmark?.primaryProfile;
  const businessPolicy = state.benchmark?.matrix?.testSpec?.acceptancePolicy || state.testMatrix?.testSpec?.acceptancePolicy;
  const primary = businessPolicy ? measurements.find((item) => item.profile === primaryProfile && runnerMatches(item.environment, mission.hardware?.[0])) : primaryMeasurementFor(mission, measurements);
  const baselineSource = state.benchmark?.baselineSource || state.baseline?.source || mission.baseline?.source || null;
  return {
    kind: state.benchmark?.baselineKind || 'pytorch_reference',
    status: 'complete',
    environment: primary?.environment || result.environment?.requested?.[0] || mission.hardware?.[0] || null,
    value: primary?.value ?? null,
    measurements: structuredClone(measurements),
    testSpecDigest: semanticTestSpecDigest(state.benchmark?.matrix?.testSpec || state.testMatrix?.testSpec || mission.testMatrix?.testSpec),
    // Every later comparison is anchored to this number, so whether it settled is part
    // of the evidence and not a detail of how it was taken. `undefined` preserves the
    // previous reading of a record that predates the field.
    settled: primary?.settled,
    settlements: primary?.settlements,
    unit: primary?.unit || 'us',
    metric: primary?.metric || mission.metric || null,
    shapeKey: shapeKeyFor(mission, state.benchmark?.matrix || state.testMatrix || {}),
    runId: state.benchmark?.runId || null,
    testTaskId: state.benchmark?.testTaskId || null,
    packageId: result.environment?.packageId || null,
    entryMode: result.environment?.entryMode || result.profiler?.metrics?.entry_mode || null,
    liveHardware: result.environment?.liveHardware === true,
    source: baselineSource ? structuredClone(baselineSource) : null,
    materialization: state.benchmark?.baselineMaterialization ? structuredClone(state.benchmark.baselineMaterialization) : null,
    completedAt: state.benchmark?.completedAt || new Date().toISOString(),
  };
};

export function evaluateAcceptGate(state, result = {}) {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const measurements = Array.isArray(result.benchmark) ? result.benchmark : [];
  const expectedCases = Number(state.benchmark?.matrix?.correctnessCases || state.testMatrix?.correctnessCases || 24);
  const iterationPolicy = mission.testScenario?.iterationPolicy || mission.operatorProfile?.iterationPolicy || null;
  const businessTestSpec = mission.semanticSnapshot?.status === 'frozen'
    ? mission.semanticSnapshot.testSpec || {}
    : state.benchmark?.matrix?.testSpec || state.testMatrix?.testSpec || mission.testMatrix?.testSpec || {};
  const requiredBenchmarkProfiles = state.benchmark?.matrix?.testSpec?.benchmark?.requiredProfiles
    || state.testMatrix?.testSpec?.benchmark?.requiredProfiles
    || [];
  const actualBenchmarkProfiles = measurements.map((item) => String(item.profile || '')).filter(Boolean);
  const enforceBenchmarkProfiles = requiredBenchmarkProfiles.length > 0
    && (Boolean(mission.operatorProfile?.id) || iterationPolicy?.requireAllProfilesNoRegression === true || businessTestSpec.acceptancePolicy != null);
  const benchmarkProfilesComplete = !enforceBenchmarkProfiles
    || (actualBenchmarkProfiles.length === requiredBenchmarkProfiles.length
      && new Set(actualBenchmarkProfiles).size === actualBenchmarkProfiles.length
      && requiredBenchmarkProfiles.every((profile) => actualBenchmarkProfiles.includes(profile)));
  // A pass must be earned over the contract's whole case set, not over the subset that
  // happened to run. `total` cannot show that: the frozen runners keep `total` at the
  // requested count even when they abort after the first failure. The attempt is
  // reported separately (executedCases + coverage), so the pass path stays closed
  // unless the record proves full coverage of what the contract required.
  const correctnessPassed = benchmarkProfilesComplete
    && measurements.length > 0
    && measurements.every((item) => item.correctness?.passed === true
      && Number(item.correctness?.total || 0) >= expectedCases
      && coverageIsComplete(item.correctness));
  // A result measurement is valid evidence only as a finite number greater than
  // zero. Lenient display parsing (used for currentBest labels) must not turn a
  // "-1us" string or a boolean into positive evidence.
  const benchmarkValueValid = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const benchmarkValid = measurements.length > 0 && measurements.every((item) => benchmarkValueValid(item?.value));
  const diagnosticEvidenceStructured = result.tracer?.format === 'operator-trace/v1'
    && Array.isArray(result.tracer?.events)
    && result.profiler?.format === 'operator-profile/v1'
    && Boolean(result.profiler?.metrics) && typeof result.profiler.metrics === 'object';
  // Local adapters own the benchmark-core path; their diagnostics stay optional
  // for adoption. The shared GPU runner identifies itself by source, not by a
  // service name, and a shared host is never publication authority.
  const localExecutionEvidence = ['local-c500-adapter', 'local-shared-gpu-adapter'].includes(result.environment?.service)
    || result.environment?.source === 'local-shared-gpu'
    || result.environment?.executionMode === 'shared-host-gpu'
    || isDevelopmentAcceleratorCoreEvidence(result.environment);
  const localC550ToolsCompleted = !localExecutionEvidence
    || (result.tracer?.status === 'completed' && result.profiler?.status === 'completed');
  const execution = classifyExecution(result.environment || {}, result);
  const liveEvidence = execution.liveHardware;
  // Real diagnostics are required for adoption only on other real execution
  // paths. Explicit simulation/CPU and local-adapter benchmark-core results keep
  // their existing structured workflow, but can never satisfy publication.
  const diagnosticsRequired = execution.kind === 'live' && !localExecutionEvidence;
  const expectedDiagnosticBinding = buildExpectedDiagnosticBinding(state);
  const bindingConflict = expectedDiagnosticBinding.conflict === true;
  const tracerDiagnostic = evaluateDiagnosticEvidence('tracer', result.tracer, expectedDiagnosticBinding);
  const profilerDiagnostic = evaluateDiagnosticEvidence('profiler', result.profiler, expectedDiagnosticBinding);
  const bothDiagnosticsEligible = tracerDiagnostic.evidenceEligible && profilerDiagnostic.evidenceEligible;
  const tracerClassification = classifyDiagnosticReasons(tracerDiagnostic.reasons);
  const profilerClassification = classifyDiagnosticReasons(profilerDiagnostic.reasons);
  const diagnosticsBlocking = !bothDiagnosticsEligible
    && (tracerClassification.blocking || profilerClassification.blocking);
  const publicationRestricted = hasPublicationRestriction(result.environment || {});
  // The benchmark core is always required. An explicit simulation/CPU path must
  // still carry the structured mock envelopes its existing workflow consumes;
  // a real path instead needs eligible bound real diagnostics below.
  const requiresStructuredEnvelope = !localExecutionEvidence && execution.kind !== 'live';
  const coreEvidenceValid = measurements.length > 0
    && benchmarkValid
    && (!requiresStructuredEnvelope || diagnosticEvidenceStructured);
  const completeEvidence = coreEvidenceValid && (!diagnosticsRequired || bothDiagnosticsEligible);
  const absoluteThreshold = parsePerformanceThreshold(mission);
  const relativeTarget = parseRelativeImprovementTarget(mission);
  const primary = businessTestSpec.acceptancePolicy != null
    ? measurements.find((item) => item.profile === businessTestSpec.benchmark?.primaryProfile && runnerMatches(item.environment, mission.hardware?.[0]))
    : primaryMeasurementFor(mission, measurements);
  const minimizesMetric = !String(mission.metric || '').toLowerCase().includes('throughput');
  const primaryValue = parseMeasurementValue(primary?.value);
  // Whether the scored reading reached a settled value. The runner takes whole
  // settlements until two consecutive ones agree; when it hits its cap without
  // agreement it says so here, and this number is then not evidence of anything.
  // Absence means "not declared", which keeps records and backends that predate the
  // field on exactly their previous behaviour; only an explicit `false` refuses.
  const measurementSettled = primary?.settled !== false;
  const baseline = state.baseline || mission.baseline || createBaselineRequirementState();
  const baselineEvidence = baselineEvidenceFor(state, mission);
  const baselineKind = normalizeBaselineKind(baselineEvidence?.kind || baseline.kind || 'pytorch_reference');
  const baselineValue = parseMeasurementValue(baselineEvidence?.value);
  const baselineReady = !baseline.required
    || (baseline.status === 'complete'
      && baselineEvidence?.kind === baselineKind
      && Number.isFinite(baselineValue)
      && baselineSourceTrusted(baseline, baselineEvidence)
       && baselineMatchesRun(baselineEvidence, mission, state.benchmark?.matrix || state.testMatrix || {}, primary));
  const frozenSemantic = mission.semanticSnapshot?.status === 'frozen';
  let semanticBindingPassed = !frozenSemantic;
  let semanticBindingDetail = frozenSemantic ? '缺少冻结语义任务绑定' : '当前 Mission 未冻结语义快照';
  if (frozenSemantic) {
    // Two independent checks, because they answer different questions:
    //   1. the run's binding must be the persisted one (detects a binding swapped
    //      between submission and result);
    //   2. that binding's testSpecDigest must equal the digest recomputed from the
    //      frozen snapshot's own test spec (detects a run submitted under a
    //      different test contract than the one that was frozen).
    // Reading the expected digest off the binding itself — as this rule used to —
    // makes check 2 compare a value with itself, so a run executed against a
    // divergent test spec still passed as "using the frozen snapshot".
    const frozenTestSpecDigest = semanticTestSpecDigest(mission.semanticSnapshot.testSpec);
    const currentTestSpec = state.benchmark?.matrix?.testSpec || state.testMatrix?.testSpec || null;
    const currentTestSpecDigest = semanticTestSpecDigest(currentTestSpec);
    const currentContractDiverged = frozenTestSpecDigest && currentTestSpecDigest && currentTestSpecDigest !== frozenTestSpecDigest;
    const runBinding = result.semanticBinding || state.benchmark?.semanticBinding || null;
    const executedTestSpecDigest = runBinding?.testSpecDigest ?? null;
    const testSpecDivergence = frozenTestSpecDigest && executedTestSpecDigest !== frozenTestSpecDigest
      ? (executedTestSpecDigest ? 'executed_test_spec_differs' : 'executed_test_spec_absent')
      : null;
    try {
      if (currentContractDiverged) {
        const error = new Error(`当前测试矩阵已偏离冻结测试契约（frozen=${frozenTestSpecDigest} · current=${currentTestSpecDigest}）；必须保留原任务或显式创建新任务。`);
        error.code = 'SEMANTIC_TEST_SPEC_MISMATCH';
        throw error;
      }
      if (testSpecDivergence === 'executed_test_spec_absent') {
        const error = new Error('冻结语义快照声明了 testSpec，但本次测试任务没有绑定任何 testSpec：无法核对实际执行的是冻结测试契约。');
        error.code = 'SEMANTIC_TEST_SPEC_UNBOUND';
        throw error;
      }
      if (testSpecDivergence === 'executed_test_spec_differs') {
        const error = new Error(`本次测试任务使用的 testSpec 与冻结语义快照不一致（frozen=${frozenTestSpecDigest} · executed=${executedTestSpecDigest}）。`);
        error.code = 'SEMANTIC_TEST_SPEC_MISMATCH';
        throw error;
      }
      assertSemanticTaskBinding(
        runBinding,
        mission.semanticSnapshot,
        { testSpecDigest: state.benchmark?.semanticBinding?.testSpecDigest,
          oracleDigest: mission.semanticSnapshot.correctnessContract?.oracleDigest || state.benchmark?.semanticBinding?.oracleDigest,
          baselineDigest: mission.semanticSnapshot.benchmarkContract?.baselineDigest || state.benchmark?.semanticBinding?.baselineDigest },
      );
      semanticBindingPassed = true;
      // State plainly what was checked. When neither side declares a test spec there
      // is nothing to compare, and that stays unverified rather than being filled in
        // with an invented expectation. Declared frozen reference digests and the
        // submission binding are checked; legacy absent references stay unchecked.
      semanticBindingDetail = [
        `${mission.semanticSnapshot.snapshotId} · ${mission.semanticSnapshot.digest}`,
        frozenTestSpecDigest
          ? `testSpec 已核对（${frozenTestSpecDigest}）`
          : '快照未声明 testSpec：测试契约未核对，未补默认值',
          mission.semanticSnapshot.correctnessContract?.oracleDigest && mission.semanticSnapshot.benchmarkContract?.baselineDigest
            ? `oracle/baseline 内容摘要已核对：${runBinding.oracleDigest} / ${runBinding.baselineDigest}`
            : 'oracle/baseline digest 未绑定：未核对',
      ].join(' · ');
    } catch (error) {
      semanticBindingDetail = error.message;
    }
  }
  const currentBestValue = parseMeasurementValue(state.currentBest?.value);
  const relativeThreshold = Number.isFinite(relativeTarget) && Number.isFinite(baselineValue)
    ? baselineValue * (minimizesMetric ? 1 - relativeTarget : 1 + relativeTarget)
    : null;
  const threshold = Number.isFinite(absoluteThreshold) ? absoluteThreshold : relativeThreshold;
  const hasThreshold = Number.isFinite(threshold);
  const hasComparableBest = Boolean(state.currentBest?.candidateId) && Number.isFinite(currentBestValue);
  const hasBaseline = baselineReady && Number.isFinite(baselineValue);
  const acceptFirstCorrectCandidate = iterationPolicy?.acceptFirstCorrectCandidate === true && !hasComparableBest && correctnessPassed;
  const bestProfileValues = new Map((state.currentBest?.measurements || []).map((item) => [item.profile, parseMeasurementValue(item.value)]));
  const profileComparisons = measurements.map((item) => ({ profile: item.profile, candidate: parseMeasurementValue(item.value), best: bestProfileValues.get(item.profile) }));
  const allProfilesComparable = iterationPolicy?.requireAllProfilesNoRegression === true
    && profileComparisons.length > 0
    && profileComparisons.every((item) => Number.isFinite(item.candidate) && Number.isFinite(item.best));
  const allProfilesNoRegression = allProfilesComparable && profileComparisons.every((item) => minimizesMetric ? item.candidate <= item.best : item.candidate >= item.best);
  const atLeastOneProfileImproved = allProfilesComparable && profileComparisons.some((item) => minimizesMetric ? item.candidate < item.best : item.candidate > item.best);
  const suiteImprovementPassed = allProfilesComparable
    && allProfilesNoRegression
    && (iterationPolicy?.requireStrictImprovement === true ? atLeastOneProfileImproved : true);
  // Reaching a target is decided with room for the measurement's own dust, and for
  // nothing else. The threshold is `baseline * (1 - target)` — a product of a measured
  // baseline and a declared target — so a candidate that meets the target lands a few
  // parts in 1e8 off it: a real run measured an improvement of 0.1999999818101055
  // against a 0.2 target (8.191999979317188us against a 8.191999793052674us threshold,
  // a gap of 0.19 femtoseconds) and was rejected for missing a target it had met.
  // 1e-6 is a part per million, six orders below the timer's own resolution on these
  // readings (one tick is ~1.024us, i.e. 1e-1 relative), so no candidate that missed
  // the target in any measurable way is admitted by it.
  const THRESHOLD_EPSILON = 1e-6;
  const reachesThreshold = (value, limit) => (minimizesMetric
    ? value <= limit * (1 + THRESHOLD_EPSILON)
    : value >= limit * (1 - THRESHOLD_EPSILON));
  const performanceApplicable = Number.isFinite(primaryValue) && (acceptFirstCorrectCandidate || allProfilesComparable || hasThreshold || hasComparableBest || hasBaseline);
  // An unsettled reading refuses the verdict in both directions: it must not adopt on
  // a number that may be noise, and it must not report "no improvement" from one
  // either. `performancePassed: false` plus the `performance.settled` requirement
  // below says which of the two happened.
  const legacyPerformancePassed = measurementSettled && performanceApplicable && (
    acceptFirstCorrectCandidate
      ? true
      : allProfilesComparable
        ? suiteImprovementPassed
        : hasThreshold
          ? reachesThreshold(primaryValue, threshold)
          : hasComparableBest
            ? (minimizesMetric ? primaryValue <= currentBestValue : primaryValue >= currentBestValue)
            : (minimizesMetric ? primaryValue <= baselineValue : primaryValue >= baselineValue)
  );
  const businessEvaluation = evaluateBusinessAcceptance({ testSpec: businessTestSpec, measurements, baselineEvidence,
    baselineReady: hasBaseline, currentBest: state.currentBest || {}, minimizesMetric, testSpecDigest: semanticTestSpecDigest(businessTestSpec) });
  const legacySuiteAllows = iterationPolicy?.requireAllProfilesNoRegression !== true
    || !hasComparableBest || suiteImprovementPassed;
  const performancePassed = businessEvaluation.enabled
    ? businessEvaluation.valid && businessEvaluation.protectedProfilesPassed && businessEvaluation.targetReached && businessEvaluation.eligibleAsBest && legacySuiteAllows
    : legacyPerformancePassed;
  const performanceExpected = businessEvaluation.enabled
    ? `冻结目标 ${businessEvaluation.targetMode || '无效'}；保护 ${(businessEvaluation.protectedProfiles || []).join(', ')}，相对基线退化 ≤ ${Number((businessEvaluation.maxRegressionFraction || 0) * 100)}%；替换最佳须严格提升`
    : acceptFirstCorrectCandidate
    ? '首个通过全部固定 Correctness 的 Triton 版本成为性能 baseline'
    : allProfilesComparable
      ? `全部 ${profileComparisons.length} 个固定性能 profile 无回退，且至少一个 profile 严格提升`
      : hasThreshold
        ? Number.isFinite(absoluteThreshold)
          ? `${minimizesMetric ? '≤' : '≥'} ${threshold}${primary?.unit || ''}`
          : `相对 baseline 至少提升 ${(relativeTarget * 100).toFixed(Number.isInteger(relativeTarget * 100) ? 0 : 1)}%（${minimizesMetric ? '≤' : '≥'} ${Number(threshold.toFixed(6))}${primary?.unit || baselineEvidence?.unit || ''}）`
        : hasComparableBest
          ? `${minimizesMetric ? '≤' : '≥'} current best ${currentBestValue}${primary?.unit || ''}`
          : hasBaseline
            ? `${minimizesMetric ? '≤' : '≥'} ${baselineKind === 'naive_v0' ? 'naive v0 baseline' : 'PyTorch reference baseline'} ${baselineValue}${baselineEvidence?.unit || primary?.unit || ''}`
            : `必须先运行 ${baselineKind === 'naive_v0' ? 'naive v0' : 'PyTorch reference'} 单文件 baseline（同 runner、同输入 shape）`;
  const baselineLabel = baselineKind === 'naive_v0' ? 'naive v0 baseline 已建立' : 'PyTorch reference baseline 已建立';
  const baselineExpected = baselineKind === 'naive_v0'
    ? '同 runner · 同输入 shape · v0 派生的单文件 baseline'
    : '同 runner · 同输入 shape · 上游权威来源 · PyTorch reference 单文件展开版本';
  const evaluatedAt = new Date().toISOString();

  // Single-point decision. The flat Gate fields below are projections of this
  // object; consumers must not reclassify truth from publishable or infer
  // publication from a live boolean.
  const adoptionReasons = [];
  const baselineRequired = Boolean(baseline.required);
  const baselineUnavailable = baselineRequired && !baselineReady;
  // Correctness, benchmark-core completeness, a contradictory candidate binding
  // and frozen semantic binding are hard failures. A missing/mismatched Baseline
  // or an unmet performance target only keeps the candidate as a weak reference,
  // exactly as before. Missing real diagnostics is separable from a malformed
  // core: it pauses for external verification instead of failing the candidate.
  const coreInvalid = !benchmarkProfilesComplete
    || !correctnessPassed
    || !coreEvidenceValid
    || (businessEvaluation.enabled && !businessEvaluation.valid)
    || (frozenSemantic && !semanticBindingPassed);
  const hardBlocked = coreInvalid || bindingConflict || (diagnosticsRequired && diagnosticsBlocking);
  // §9: current best, the mission's final target and publication eligibility are
  // three separate questions. `performancePassed` answers only the second one,
  // and whenever a numeric target parses it hides the current-best comparison
  // entirely (see its branch above). A candidate that is strictly better than
  // current best but short of the target must therefore be judged explicitly,
  // otherwise "better than best, below target" is rolled back and the gain is
  // lost. The all-profile suite branch keeps its own frozen C550 policy and is
  // deliberately not given a second, competing retention rule.
  const improvesCurrentBest = hasComparableBest && Number.isFinite(primaryValue)
    && (minimizesMetric ? primaryValue < currentBestValue : primaryValue > currentBestValue);
  const progressStatus = businessEvaluation.enabled
    ? (!Number.isFinite(primaryValue) || !measurementSettled || businessEvaluation.issues?.includes('CURRENT_BEST_NOT_COMPARABLE')) ? 'not_measured'
      : businessEvaluation.eligibleAsBest ? 'improved_current_best' : 'not_improved'
    : allProfilesComparable
    ? 'not_applicable'
    // An unsettled reading is not a measurement, so it cannot be progress: reading it
    // as `not_improved` is precisely how a real gain gets recorded as no gain when the
    // process happened to catch a boosted clock.
    : (!Number.isFinite(primaryValue) || !measurementSettled)
      ? 'not_measured'
      : !hasComparableBest
        ? 'no_current_best'
        : improvesCurrentBest ? 'improved_current_best' : 'not_improved';
  // Retention never rides on a candidate that failed correctness, evidence or the
  // frozen semantic binding: those are hard failures, not stage progress. A tie
  // is not progress either, so it does not move current best.
  const progressRetainable = progressStatus === 'improved_current_best' && !hardBlocked && !bindingConflict
    && (!businessEvaluation.enabled || (businessEvaluation.valid && businessEvaluation.protectedProfilesPassed && hasBaseline && legacySuiteAllows));
  const businessAcceptance = businessEvaluation.enabled ? { ...businessEvaluation,
    correctUsable: correctnessPassed && coreEvidenceValid && semanticBindingPassed && !bindingConflict,
    eligibleAsBest: progressRetainable, targetReached: businessEvaluation.targetReached && !hardBlocked } : null;
  const progressReference = businessEvaluation.enabled && !hasComparableBest ? `独立基线 ${baselineValue}${primary?.unit || ''}` : `current best ${currentBestValue}${primary?.unit || ''}`;
  const progressReasons = [];
  if (progressStatus === 'improved_current_best' && !progressRetainable) progressReasons.push(DECISION_REASONS.PROGRESS_NOT_RETAINED);
  if (progressStatus === 'not_improved') progressReasons.push(DECISION_REASONS.PROGRESS_NO_GAIN);
  let adoptionStatus;
  if (hardBlocked) {
    adoptionStatus = 'blocked';
    if (!benchmarkProfilesComplete) adoptionReasons.push(DECISION_REASONS.PROFILES_INCOMPLETE);
    if (!correctnessPassed) adoptionReasons.push(DECISION_REASONS.CORRECTNESS_FAILED);
    if (!coreEvidenceValid) adoptionReasons.push(benchmarkValid ? DECISION_REASONS.EVIDENCE_INCOMPLETE : DECISION_REASONS.BENCHMARK_INVALID);
    if (frozenSemantic && !semanticBindingPassed) adoptionReasons.push(DECISION_REASONS.SEMANTIC_BINDING_FAILED);
    if (bindingConflict) adoptionReasons.push(DECISION_REASONS.BINDING_CONFLICT);
    if (diagnosticsRequired && diagnosticsBlocking) adoptionReasons.push(DECISION_REASONS.DIAGNOSTICS_INELIGIBLE);
  } else if (diagnosticsRequired && !bothDiagnosticsEligible) {
    // Missing real diagnostic capability pauses for external verification and
    // is not treated as a candidate hard error.
    adoptionStatus = 'waiting_external_verification';
    adoptionReasons.push(DECISION_REASONS.DIAGNOSTICS_UNAVAILABLE);
  } else if (!measurementSettled) {
    // The verdict is withheld, not rendered against the candidate: it stays a weak
    // reference and the run is re-measurable. Reporting PERFORMANCE_NOT_MET here
    // would turn an unreadable number into the claim that the candidate gained nothing.
    adoptionStatus = 'reference';
    adoptionReasons.push(DECISION_REASONS.MEASUREMENT_UNSETTLED);
  } else if (!performancePassed || baselineUnavailable) {
    adoptionStatus = 'reference';
    if (!performancePassed) adoptionReasons.push(DECISION_REASONS.PERFORMANCE_NOT_MET);
    if (baselineUnavailable) adoptionReasons.push(DECISION_REASONS.BASELINE_UNAVAILABLE);
  } else {
    adoptionStatus = 'allowed';
  }

  const publicationReasons = [];
  let publicationStatus;
  if (execution.kind !== 'live') {
    publicationStatus = 'blocked';
    publicationReasons.push(DECISION_REASONS.EXECUTION_NOT_LIVE);
  } else if (publicationRestricted) {
    publicationStatus = 'blocked';
    publicationReasons.push(DECISION_REASONS.RESTRICTED_ENVIRONMENT);
  } else if (adoptionStatus === 'blocked') {
    publicationStatus = 'blocked';
    publicationReasons.push(DECISION_REASONS.ADOPTION_NOT_ALLOWED);
  } else if (!bothDiagnosticsEligible) {
    if (diagnosticsBlocking) {
      publicationStatus = 'blocked';
      publicationReasons.push(DECISION_REASONS.PUBLICATION_DIAGNOSTICS_INELIGIBLE);
    } else {
      publicationStatus = 'waiting_external_verification';
      publicationReasons.push(DECISION_REASONS.PUBLICATION_DIAGNOSTICS_UNAVAILABLE);
    }
  } else if (adoptionStatus !== 'allowed') {
    publicationStatus = 'blocked';
    publicationReasons.push(DECISION_REASONS.ADOPTION_NOT_ALLOWED);
  } else {
    publicationStatus = 'allowed';
  }

  const decision = {
    schemaVersion: EVIDENCE_DECISION_SCHEMA_VERSION,
    policyVersion: EVIDENCE_DECISION_POLICY_VERSION,
    binding: {
      missionId: expectedDiagnosticBinding.missionId,
      candidateId: expectedDiagnosticBinding.candidateId,
      candidateDigest: expectedDiagnosticBinding.candidateDigest,
      runId: expectedDiagnosticBinding.runId,
      taskId: expectedDiagnosticBinding.taskId,
      sourceRunId: expectedDiagnosticBinding.sourceRunId,
      semanticDigest: expectedDiagnosticBinding.semanticDigest,
    },
    execution: { kind: execution.kind, liveHardware: execution.liveHardware, source: execution.source },
    correctness: { passed: correctnessPassed },
    ...(businessAcceptance ? { businessAcceptance } : {}),
    benchmark: { valid: benchmarkValid },
    diagnostics: { tracer: tracerDiagnostic, profiler: profilerDiagnostic },
    adoption: { status: adoptionStatus, reasons: adoptionReasons },
    publication: { status: publicationStatus, reasons: publicationReasons },
    // Answers "may this be retained as current best?" separately from both
    // adoption (which is the mission target) and publication. Additive: a
    // decision recorded before this field existed has no `progress`, and every
    // consumer must treat that as "no retained claim" rather than as progress.
    progress: { status: progressStatus, retainable: progressRetainable, reasons: progressReasons },
    evaluatedAt,
  };
  const passed = adoptionStatus === 'allowed';
  const publicationAllowed = publicationStatus === 'allowed';
  const resultKind = adoptionStatus === 'allowed' ? 'eligible' : adoptionStatus === 'blocked' ? 'failed' : 'reference';
  const diagnosticActual = (qualification) => {
    const status = qualification.available ? 'real collection' : 'no real collection';
    return qualification.reasons.length ? `${status} · ${qualification.reasons.join(', ')}` : `${status} · eligible`;
  };
  const rules = [
    // `actual` reports the cases that really ran, so a run that stopped early reads
    // as 6/24 here instead of echoing the requested count back as if it had run.
    { id: 'correctness.complete', label: 'Correctness 用例全部通过', required: true, passed: correctnessPassed, actual: measurements.map((item) => {
      const total = Number(item.correctness?.total || expectedCases);
      const executed = Number(item.correctness?.executedCases);
      const shown = item.correctness?.passed === true && Number.isFinite(executed) ? executed : (item.correctness?.passed === true ? total : 0);
      return `${item.environment} ${shown}/${total}`;
    }).join(' · '), expected: `${expectedCases}/${expectedCases}` },
    { id: 'evidence.candidate_binding', label: '候选与测试绑定一致', required: true, passed: !bindingConflict, actual: bindingConflict ? expectedDiagnosticBinding.conflictReasons.join(', ') : '无绑定冲突', expected: '已应用候选与测试候选身份、摘要和来源运行一致' },
    { id: 'benchmark.profiles_complete', label: '固定 Benchmark Shape 完整', required: enforceBenchmarkProfiles, passed: benchmarkProfilesComplete, skipped: !enforceBenchmarkProfiles, actual: actualBenchmarkProfiles.join(', ') || '无 profile', expected: requiredBenchmarkProfiles.join(', ') || '未配置固定 profile' },
    { id: 'evidence.complete', label: localExecutionEvidence ? 'Benchmark 核心证据完整' : 'Benchmark / Tracer / Profiler 证据完整', required: true, passed: completeEvidence, actual: completeEvidence
      ? (localExecutionEvidence && !localC550ToolsCompleted ? 'Benchmark 完整；可选诊断工具未全部完成' : '证据完整')
      : !coreEvidenceValid
        ? (benchmarkValid ? 'Benchmark 或结构化诊断格式缺失' : 'Benchmark 数值无效')
        : '真实必需诊断内容未合格', expected: localExecutionEvidence
      ? 'operator benchmark'
      : diagnosticsRequired
        ? 'operator benchmark + 绑定当前候选/运行的两项合格真实诊断'
        : 'operator benchmark + 结构化 trace/v1 + profile/v1' },
    { id: 'diagnostics.mctracer', label: 'mcTracer 诊断资格', required: false, passed: tracerDiagnostic.evidenceEligible, skipped: false, actual: diagnosticActual(tracerDiagnostic), expected: '真实采集完成 · 非 mock 来源 · 绑定当前候选/运行 · 内容满足规则' },
    { id: 'diagnostics.mcprofiler', label: 'mcProfiler 诊断资格', required: false, passed: profilerDiagnostic.evidenceEligible, skipped: false, actual: diagnosticActual(profilerDiagnostic), expected: '真实采集完成 · 非 mock 来源 · 绑定当前候选/运行 · 内容满足规则' },
    { id: 'diagnostics.required', label: '真实诊断证据覆盖当前候选/运行', required: diagnosticsRequired, passed: bothDiagnosticsEligible, skipped: !diagnosticsRequired, actual: bothDiagnosticsEligible ? '两项诊断均合格' : (diagnosticsRequired ? '真实路径必需诊断未合格' : '当前路径诊断可选'), expected: diagnosticsRequired ? 'tracer + profiler 均 evidenceEligible' : '本地 adapter / 显式模拟路径诊断可选' },
    { id: 'baseline.current_reference', label: baselineLabel, required: baselineRequired, passed: baselineReady, skipped: !baselineRequired, actual: baselineReady ? `${baselineEvidence?.environment} ${baselineEvidence?.value}${baselineEvidence?.unit}${baselineKind === 'naive_v0' ? ' · v0' : ''}` : (baselineEvidence ? 'baseline 与当前 runner/shape/source 不匹配' : '缺少 baseline 证据'), expected: baselineExpected },
    { id: 'semantic.snapshot_binding', label: '测试使用冻结语义快照', required: frozenSemantic, passed: semanticBindingPassed, skipped: !frozenSemantic, actual: semanticBindingDetail, expected: frozenSemantic ? 'task semanticDigest 与 Mission frozen snapshot 一致，且 task testSpecDigest 等于快照自身 testSpec 的摘要' : '未冻结语义快照' },
    // Stated as its own row so an unsettled reading is visible as "not decided" rather
    // than being inferred from a failed target. Not required: an undeclared reading
    // (every record and backend that predates the settling rule) is not a failure.
    { id: 'performance.settled', label: '主测量读数已稳定', required: false, passed: measurementSettled, skipped: primary?.settled === undefined || primary?.settled === null, actual: primary?.settled === false ? `取满 ${primary.settlements ?? '?'} 次结算仍未达成一致` : (primary ? `已稳定（${primary.settlements ?? '?'} 次结算）` : '无测量值'), expected: '两次连续结算相差不超过声明的 settleTolerance（契约默认 2%，最多 8 次结算）' },
    ...(businessAcceptance ? [{ id: 'business.protected_profiles', label: '冻结业务保护场景', required: true,
      passed: businessAcceptance.valid && businessAcceptance.protectedProfilesPassed, skipped: false,
      actual: businessAcceptance.profileComparisons.map((item) => `${item.profile}: ${item.comparable ? `${item.candidate}/${item.baseline}${item.unit || ''}${item.passed ? ' 通过' : ' 退化超限'}` : '缺测或基线不匹配'}`).join(' · ') || businessAcceptance.issues.join(', '),
      expected: `首轮起逐场景比较基线；允许退化 ${Number((businessAcceptance.maxRegressionFraction || 0) * 100)}%` }] : []),
    ...(businessAcceptance ? [{ id: 'business.success_target', label: '达到冻结成功目标', required: false, passed: businessAcceptance.targetReached, skipped: false,
      actual: businessAcceptance.targetReached ? '已达到目标（是否保留最佳另行判定）' : '未达目标或保护场景未满足', expected: JSON.stringify(businessAcceptance.successTarget || {}) }] : []),
    { id: 'performance.target', label: businessAcceptance ? '满足冻结业务采用条件' : hasThreshold ? '达到 Mission 性能目标' : '达到 Mission 性能策略', required: true, passed: performancePassed, skipped: false, actual: primary ? `${primary.environment} ${primary.value}${primary.unit}` : '无测量值', expected: performanceExpected },
    // Informational only: this row never makes a candidate pass or fail. It states
    // the third question — may this candidate replace current best — so that a
    // real improvement short of the mission target is visible rather than only
    // reported as "performance not met".
    { id: 'performance.current_best', label: '相对 current best 的阶段进展', required: false, skipped: progressStatus === 'no_current_best' || progressStatus === 'not_applicable' || progressStatus === 'not_measured', passed: progressStatus === 'no_current_best' || progressStatus === 'not_applicable' || progressStatus === 'not_measured' ? null : progressRetainable, actual: progressStatus === 'improved_current_best' ? (progressRetainable ? `严格优于 ${progressReference}，允许保留为新当前最佳（达到目标另行标记，不授权发布）` : `优于 current best 但验收本身未通过（${progressReasons.join(', ')}），不保留`) : progressStatus === 'not_improved' ? `未严格优于 ${progressReference}或保护场景不通过` : progressStatus === 'not_measured' ? '无可用主测量值' : progressStatus === 'not_applicable' ? '多 profile 套件策略自行判定' : '尚未登记 current best', expected: '严格优于 current best 即保留为新的当前最佳，与“达到任务最终目标”和“可发布”互不等价' },
    { id: 'cross_platform.regression', label: '跨平台相对 current best 无回归', required: false, passed: null, skipped: true, actual: '未配置逐平台 current best 基线', expected: '为各平台登记可比较基线后评估' },
    { id: 'evidence.provenance', label: '真实硬件证据可用于正式发布', required: false, passed: publicationAllowed, skipped: false, actual: publicationAllowed ? '真实、无限制且两项诊断合格的执行证据' : (publicationRestricted ? '显式开发/共享主机限制（不可发布）' : execution.kind !== 'live' ? '非 live 执行（不可发布）' : '发布所需真实诊断尚未合格（不可发布）'), expected: '正式硬件 Gate 授权' },
  ];
  const requiredRules = rules.filter((rule) => rule.required);
  const failedRules = requiredRules.filter((rule) => !rule.passed).map((rule) => rule.id);
  const passedRules = requiredRules.filter((rule) => rule.passed).map((rule) => rule.id);
  const evidenceSource = execution.kind === 'live'
    ? (publicationAllowed ? 'live' : 'shared-gpu-development')
    : execution.kind === 'simulation'
      ? 'simulation'
      : execution.kind === 'cpu'
        ? 'cpu'
        : 'unknown';
  return {
    passed,
    publishable: publicationAllowed,
    evidenceSource,
    liveHardware: execution.liveHardware,
    result: resultKind,
    decision,
    ...(businessAcceptance ? { businessAcceptance } : {}),
    // Flat projection of decision.progress, so a consumer that only reads the flat
    // Gate does not have to reclassify "did this beat current best?" from a
    // performance verdict that answers a different question.
    progress: { status: progressStatus, retainable: progressRetainable, reasons: progressReasons },
    rules,
    passedRules,
    failedRules,
    evaluatedRules: requiredRules.length,
    skippedRules: rules.filter((rule) => rule.skipped).map((rule) => rule.id),
    summary: passed
      ? `${passedRules.length}/${requiredRules.length} 条必需规则通过；${localExecutionEvidence && !localC550ToolsCompleted ? 'mcTracer/mcProfiler 可选诊断未全部完成，不阻塞采用；' : ''}${publicationAllowed ? '证据可用于正式发布。' : liveEvidence ? '当前为共享 GPU 开发证据，不可用于正式发布。' : '当前为 Mock 证据，只能验证流程与生成预览资产。'}`
      : businessAcceptance && resultKind === 'reference'
        ? `正确性与核心证据完整；${!businessAcceptance.protectedProfilesPassed ? `保护场景未满足（${businessAcceptance.issues.join(', ')}）` : !businessAcceptance.targetReached ? '冻结成功目标尚未达到' : !businessAcceptance.eligibleAsBest ? '已达冻结成功目标，但未严格优于已有最佳或缺可比较最佳证据' : '业务条件满足，仍需完整验收资格'}；${progressRetainable ? '允许保留为当前最佳，实际保留以结算状态为准' : '不替换当前最佳'}。`
        : resultKind === 'reference'
        ? adoptionStatus === 'waiting_external_verification'
          ? '正确性与证据完整，但缺少必需的真实诊断证据，暂停等待外部验证；候选保留为弱候选参考。'
          : progressRetainable
            ? '正确性与证据完整，严格优于 current best 但未达到任务最终目标；保留为新的当前最佳，不授权发布。'
            : progressStatus === 'improved_current_best'
              ? '优于 current best，但正确性、证据或冻结语义绑定本身未通过；不保留为当前最佳。'
              : '正确性与证据完整，但未达到性能目标；候选保留为弱候选参考。'
        : '正确性、诊断资格或证据完整性未通过；候选退出候选池并保留失败记录。',
    evaluatedAt,
  };
}
