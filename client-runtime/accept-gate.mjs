import { runnerMatches } from './runner-aliases.mjs';
import { assertSemanticTaskBinding } from './semantic-snapshot.mjs';
import { createBaselineRequirementState, createBaselineSourcePolicy, normalizeBaselineKind } from './evidence-state.mjs';
import {
  DECISION_REASONS,
  EVIDENCE_DECISION_POLICY_VERSION,
  EVIDENCE_DECISION_SCHEMA_VERSION,
  buildExpectedDiagnosticBinding,
  classifyDiagnosticReasons,
  classifyExecution,
  evaluateDiagnosticEvidence,
  hasPublicationRestriction,
} from './evidence-decision.mjs';

const parsePerformanceThreshold = (mission = {}) => {
  const text = `${mission.goal || ''} ${mission.metric || ''}`;
  const match = text.match(/(?:<|<=|≤|低于|不高于|控制在)\s*(\d+(?:\.\d+)?)\s*(?:μs|us|ms)\b/i)
    || text.match(/(?:<|<=|≤)\s*(\d+(?:\.\d+)?)(?![\d.]|\s*%)/i);
  return match ? Number(match[1]) : null;
};

const parseRelativeImprovementTarget = (mission = {}) => {
  const explicit = Number(mission.objective?.targetRelativeImprovement);
  if (Number.isFinite(explicit) && explicit > 0) return explicit > 1 ? explicit / 100 : explicit;
  const text = `${mission.goal || ''} ${mission.metric || ''}`;
  const match = text.match(/(?:相对\s*(?:baseline|基线)\s*)?(?:至少\s*)?(?:提升|改善|改进|improv(?:e|ement)?)\s*(?:至少\s*)?(\d+(?:\.\d+)?)\s*%/i)
    || text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:以上|或以上|的)?\s*(?:提升|改善|改进|improv(?:e|ement)?)/i);
  return match ? Number(match[1]) / 100 : null;
};

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
  const primary = primaryMeasurementFor(mission, measurements);
  const baselineSource = state.benchmark?.baselineSource || state.baseline?.source || mission.baseline?.source || null;
  return {
    kind: state.benchmark?.baselineKind || 'pytorch_reference',
    status: 'complete',
    environment: primary?.environment || result.environment?.requested?.[0] || mission.hardware?.[0] || null,
    value: primary?.value ?? null,
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
  const requiredBenchmarkProfiles = state.benchmark?.matrix?.testSpec?.benchmark?.requiredProfiles
    || state.testMatrix?.testSpec?.benchmark?.requiredProfiles
    || [];
  const actualBenchmarkProfiles = measurements.map((item) => String(item.profile || '')).filter(Boolean);
  const enforceBenchmarkProfiles = requiredBenchmarkProfiles.length > 0
    && (Boolean(mission.operatorProfile?.id) || iterationPolicy?.requireAllProfilesNoRegression === true);
  const benchmarkProfilesComplete = !enforceBenchmarkProfiles
    || (actualBenchmarkProfiles.length === requiredBenchmarkProfiles.length
      && new Set(actualBenchmarkProfiles).size === actualBenchmarkProfiles.length
      && requiredBenchmarkProfiles.every((profile) => actualBenchmarkProfiles.includes(profile)));
  const correctnessPassed = benchmarkProfilesComplete
    && measurements.length > 0
    && measurements.every((item) => item.correctness?.passed === true && Number(item.correctness?.total || 0) >= expectedCases);
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
    || result.environment?.executionMode === 'shared-host-gpu';
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
  const primary = primaryMeasurementFor(mission, measurements);
  const minimizesMetric = !String(mission.metric || '').toLowerCase().includes('throughput');
  const primaryValue = parseMeasurementValue(primary?.value);
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
    try {
      assertSemanticTaskBinding(
        result.semanticBinding || state.benchmark?.semanticBinding,
        mission.semanticSnapshot,
        { testSpecDigest: state.benchmark?.semanticBinding?.testSpecDigest },
      );
      semanticBindingPassed = true;
      semanticBindingDetail = `${mission.semanticSnapshot.snapshotId} · ${mission.semanticSnapshot.digest}`;
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
  const performanceApplicable = Number.isFinite(primaryValue) && (acceptFirstCorrectCandidate || allProfilesComparable || hasThreshold || hasComparableBest || hasBaseline);
  const performancePassed = performanceApplicable && (
    acceptFirstCorrectCandidate
      ? true
      : allProfilesComparable
        ? suiteImprovementPassed
        : hasThreshold
          ? (minimizesMetric ? primaryValue <= threshold : primaryValue >= threshold)
          : hasComparableBest
            ? (minimizesMetric ? primaryValue <= currentBestValue : primaryValue >= currentBestValue)
            : (minimizesMetric ? primaryValue <= baselineValue : primaryValue >= baselineValue)
  );
  const performanceExpected = acceptFirstCorrectCandidate
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
    || (frozenSemantic && !semanticBindingPassed);
  const hardBlocked = coreInvalid || bindingConflict || (diagnosticsRequired && diagnosticsBlocking);
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
    benchmark: { valid: benchmarkValid },
    diagnostics: { tracer: tracerDiagnostic, profiler: profilerDiagnostic },
    adoption: { status: adoptionStatus, reasons: adoptionReasons },
    publication: { status: publicationStatus, reasons: publicationReasons },
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
    { id: 'correctness.complete', label: 'Correctness 用例全部通过', required: true, passed: correctnessPassed, actual: measurements.map((item) => `${item.environment} ${item.correctness?.passed ? item.correctness.total : 0}/${item.correctness?.total || expectedCases}`).join(' · '), expected: `${expectedCases}/${expectedCases}` },
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
    { id: 'semantic.snapshot_binding', label: '测试使用冻结语义快照', required: frozenSemantic, passed: semanticBindingPassed, skipped: !frozenSemantic, actual: semanticBindingDetail, expected: frozenSemantic ? 'task semanticDigest 与 Mission frozen snapshot 一致' : '未冻结语义快照' },
    { id: 'performance.target', label: hasThreshold ? '达到 Mission 性能目标' : '达到 Mission 性能策略', required: true, passed: performancePassed, skipped: false, actual: primary ? `${primary.environment} ${primary.value}${primary.unit}` : '无测量值', expected: performanceExpected },
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
    rules,
    passedRules,
    failedRules,
    evaluatedRules: requiredRules.length,
    skippedRules: rules.filter((rule) => rule.skipped).map((rule) => rule.id),
    summary: passed
      ? `${passedRules.length}/${requiredRules.length} 条必需规则通过；${localExecutionEvidence && !localC550ToolsCompleted ? 'mcTracer/mcProfiler 可选诊断未全部完成，不阻塞采用；' : ''}${publicationAllowed ? '证据可用于正式发布。' : liveEvidence ? '当前为共享 GPU 开发证据，不可用于正式发布。' : '当前为 Mock 证据，只能验证流程与生成预览资产。'}`
      : resultKind === 'reference'
        ? adoptionStatus === 'waiting_external_verification'
          ? '正确性与证据完整，但缺少必需的真实诊断证据，暂停等待外部验证；候选保留为弱候选参考。'
          : '正确性与证据完整，但未达到性能目标；候选保留为弱候选参考。'
        : '正确性、诊断资格或证据完整性未通过；候选退出候选池并保留失败记录。',
    evaluatedAt,
  };
}
