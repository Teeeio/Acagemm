// Workflow summary projection.
//
// This module is intentionally dependency-free: it only reads the versioned
// evidence decision the domain already computed. It never derives publication
// from `publishable`, `liveHardware` or any other boolean. A missing decision
// stays explicitly unknown and nonpublishable; consumers must not invent live
// facts for historical reports.

export const EVIDENCE_DECISION_SCHEMA_VERSION = 'operator-studio.evidence-decision/v1';

const measurementFor = (task) => task?.result?.benchmark?.[0] || null;

const row = (stage, executor, action, result, next) => `| ${stage} | ${executor} | ${action} | ${result} | ${next} |`;

const isObject = (input) => Boolean(input) && typeof input === 'object' && !Array.isArray(input);
const asList = (input) => (Array.isArray(input) ? input : []);
const isBoolean = (input) => typeof input === 'boolean';
const isIdentityField = (input) => input === null || typeof input === 'string';
const isNonEmptyString = (input) => typeof input === 'string' && input.trim().length > 0;
const isReasons = (input) => Array.isArray(input) && input.every((item) => typeof item === 'string');

const IDENTITY_FIELDS = Object.freeze(['candidateId', 'candidateDigest', 'runId']);
const EXECUTION_KINDS = Object.freeze(['live', 'simulation', 'cpu', 'unknown']);
const ADOPTION_STATUSES = Object.freeze(['allowed', 'reference', 'blocked', 'waiting_external_verification']);
const PUBLICATION_STATUSES = Object.freeze(['allowed', 'blocked', 'waiting_external_verification']);
const BINDING_FIELDS = Object.freeze(['missionId', 'candidateId', 'candidateDigest', 'runId', 'taskId', 'sourceRunId', 'semanticDigest']);

const readDiagnosticQualification = (input) => {
  if (!isObject(input)) return null;
  if (!isBoolean(input.schemaValid) || !isBoolean(input.available) || !isBoolean(input.evidenceEligible)) return null;
  if (!isReasons(input.reasons)) return null;
  return Object.freeze({
    schemaValid: input.schemaValid,
    available: input.available,
    evidenceEligible: input.evidenceEligible,
    reasons: Object.freeze([...input.reasons]),
  });
};

// Read-only projection of the shared domain decision. Only the exact
// implemented schema version with a complete, well-formed DTO is accepted: an
// unknown version, a partial object or a legacy flat Gate can never be mistaken
// for a versioned decision, and nothing is coerced or backfilled.
export const readEvidenceDecision = (input) => {
  if (!isObject(input)) return null;
  if (input.schemaVersion !== EVIDENCE_DECISION_SCHEMA_VERSION) return null;
  if (input.policyVersion !== 'operator-studio.evidence-policy/2026-09-12') return null;
  const binding = input.binding;
  if (!isObject(binding) || !BINDING_FIELDS.every((field) => isIdentityField(binding[field]))) return null;
  const execution = input.execution;
  if (!isObject(execution) || !EXECUTION_KINDS.includes(execution.kind)) return null;
  if (!isBoolean(execution.liveHardware)) return null;
  if (!(execution.source === null || typeof execution.source === 'string')) return null;
  if (!isObject(input.correctness) || !isBoolean(input.correctness.passed)) return null;
  if (!isObject(input.benchmark) || !isBoolean(input.benchmark.valid)) return null;
  if (!isObject(input.diagnostics)) return null;
  const tracer = readDiagnosticQualification(input.diagnostics.tracer);
  const profiler = readDiagnosticQualification(input.diagnostics.profiler);
  if (!tracer || !profiler) return null;
  const adoption = input.adoption;
  if (!isObject(adoption) || !ADOPTION_STATUSES.includes(adoption.status) || !isReasons(adoption.reasons)) return null;
  const publication = input.publication;
  if (!isObject(publication) || !PUBLICATION_STATUSES.includes(publication.status) || !isReasons(publication.reasons)) return null;
  if (execution.liveHardware !== (execution.kind === 'live')) return null;
  if ([tracer, profiler].some((item) => item.evidenceEligible && (!item.available || !item.schemaValid))) return null;
  if (adoption.status === 'allowed' && (!input.correctness.passed || !input.benchmark.valid || adoption.reasons.length)) return null;
  if (publication.status === 'allowed' && (adoption.status !== 'allowed' || execution.kind !== 'live'
    || !tracer.evidenceEligible || !profiler.evidenceEligible || publication.reasons.length)) return null;
  // A publishable decision must be bound to a concrete candidate/run: the same
  // candidate identity the Runtime's resolveGovernanceDecision requires. A DTO
  // that omits or blanks any of the three fields is unknown and cannot authorize
  // publication, even if every other field looks complete.
  if (publication.status === 'allowed'
    && !IDENTITY_FIELDS.every((field) => isNonEmptyString(binding[field]))) return null;
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    policyVersion: input.policyVersion,
    binding: Object.freeze(Object.fromEntries(BINDING_FIELDS.map((field) => [field, binding[field]]))),
    execution: Object.freeze({ kind: execution.kind, liveHardware: execution.liveHardware, source: execution.source }),
    correctness: Object.freeze({ passed: input.correctness.passed }),
    benchmark: Object.freeze({ valid: input.benchmark.valid }),
    diagnostics: Object.freeze({ tracer, profiler }),
    adoption: Object.freeze({ status: adoption.status, reasons: Object.freeze([...adoption.reasons]) }),
    publication: Object.freeze({ status: publication.status, reasons: Object.freeze([...publication.reasons]) }),
  });
};

// Only a decision bound to the caller's explicitly known current
// candidate/digest/run identity is selected. A caller with no identity, or a
// decision whose binding omits a known identity field, never matches by
// default, so another candidate/run can never be presented as the current one.
export const selectEvidenceDecision = (expected, ...candidates) => {
  const constraints = IDENTITY_FIELDS
    .map((field) => [field, expected?.[field]])
    .filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined && fieldValue !== '');
  if (constraints.length !== IDENTITY_FIELDS.length) return null;
  for (const candidate of candidates) {
    const decision = readEvidenceDecision(candidate);
    if (!decision) continue;
    const matches = constraints.every(([field, fieldValue]) => {
      const bound = decision.binding[field];
      return bound !== null && bound !== '' && bound === fieldValue;
    });
    if (matches) return decision;
  }
  return null;
};

const EXECUTION_LABELS = Object.freeze({
  live: 'live(真实执行)',
  simulation: 'simulation(仿真执行)',
  cpu: 'cpu(CPU 执行)',
  unknown: 'unknown(执行来源未声明)',
});

const executionLabel = (decision) => decision
  ? `${EXECUTION_LABELS[decision.execution.kind] || decision.execution.kind} · liveHardware=${decision.execution.liveHardware ? 'true' : 'false'} · source=${decision.execution.source ?? '--'}`
  : 'unknown(无版本化决策)';

const reasonsText = (reasons) => (reasons.length ? reasons.join(', ') : '无');

const diagnosticLine = (label, qualification) => {
  if (!isObject(qualification)) return `${label}: unknown(无版本化决策)`;
  return `${label}: schemaValid=${qualification.schemaValid === true ? 'true' : 'false'} available=${qualification.available === true ? 'true' : 'false'} evidenceEligible=${qualification.evidenceEligible === true ? 'true' : 'false'} reasons=${reasonsText(asList(qualification.reasons).map(String))}`;
};

// Explicit provenance only, for historical reports that predate the decision
// contract. This never authorizes publication and never reads a boolean.
const legacyExecutionKind = (state = {}, tasks = []) => {
  const sources = [state.benchmark?.result?.environment, ...tasks.map((task) => task?.result?.environment)]
    .filter(Boolean)
    .map((environment) => String(environment.source || environment.executionMode || '').toLowerCase())
    .filter(Boolean);
  if (sources.some((source) => source.includes('simulat') || source.includes('mock') || source.includes('fixture'))) return 'simulation';
  if (sources.some((source) => source.includes('cpu-e2e') || source === 'cpu' || source.includes('-cpu'))) return 'cpu';
  if (sources.some((source) => source.includes('gpu') || source.includes('c500') || source.includes('c550'))) return 'live';
  return null;
};

const decisionSection = (decision, legacyKind = null) => {
  if (!decision) {
    return [
      '## Evidence Decision',
      `- decision    unknown(历史记录缺少版本化决策；不得据此发布)`,
      `- execution   ${legacyKind ? `${legacyKind}(历史显式来源，无版本化决策)` : 'unknown(无版本化决策)'}`,
      '- correctness unknown(无版本化决策)',
      '- benchmark   unknown(无版本化决策)',
      '- adoption    unknown(无版本化决策)',
      '- publication unknown(不可发布：缺少版本化决策)',
      '- reasons     evidence.decision.missing',
    ];
  }
  return [
    '## Evidence Decision',
    `- decision    ${decision.schemaVersion} · policy ${decision.policyVersion || '--'}`,
    `- binding     candidate=${decision.binding?.candidateId ?? '--'} run=${decision.binding?.runId ?? '--'}`,
    `- execution   ${executionLabel(decision)}`,
    `- correctness passed=${decision.correctness.passed ? 'true' : 'false'}`,
    `- benchmark   valid=${decision.benchmark.valid ? 'true' : 'false'}`,
    `- diagnostics ${diagnosticLine('tracer', decision.diagnostics?.tracer)} | ${diagnosticLine('profiler', decision.diagnostics?.profiler)}`,
    `- adoption    ${decision.adoption.status} · reasons=${reasonsText(decision.adoption.reasons)}`,
    `- publication ${decision.publication.status} · reasons=${reasonsText(decision.publication.reasons)}`,
  ];
};

export const renderWorkflowSummary = ({ state = {}, tasks = [], initialization = {}, error = null } = {}) => {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const events = state.runtimeEvents || [];
  const baselineTask = tasks.find((task) => task.payload?.purpose === 'baseline');
  const candidateTasks = tasks.filter((task) => task.payload?.purpose === 'candidate');
  const baselineValue = measurementFor(baselineTask)?.value;
  const rollbackEvents = events.filter((event) => event.type === 'workflow.round_rolled_back');
  const research = state.researchAgent || {};
  const materializer = state.baseline?.materializer || {};
  const researchErrorText = String(research.error?.message || '');
  const researchFailure = /UnknownIssuer/i.test(researchErrorText)
    ? 'Agent 网络连接失败（证书链 UnknownIssuer）'
    : research.error?.message
      ? 'Agent 运行失败'
      : null;
  const adoptedEvent = [...events].reverse().find((event) => event.type === 'decision.auto_adopted' && event.payload?.candidate === state.currentBest?.candidateId);
  const benchmark = state.benchmark || {};
  const benchmarkCandidate = benchmark.candidate || {};
  const benchmarkCandidateId = benchmarkCandidate.id || state.appliedCandidateId || null;
  const appliedCandidate = (state.candidateEvaluations || []).find((item) => item.id === benchmarkCandidateId) || {};
  const currentIdentity = {
    candidateId: benchmarkCandidateId,
    candidateDigest: benchmarkCandidate.digest || appliedCandidate.patchDigest || null,
    runId: benchmark.runId || null,
  };
  const currentDecision = selectEvidenceDecision(currentIdentity, benchmark.evidenceDecision, state.decisionReview?.gate?.decision);
  const bestCandidateId = state.currentBest?.candidateId || null;
  const bestIdentity = {
    candidateId: bestCandidateId,
    candidateDigest: state.currentBest?.candidateDigest || state.currentBest?.digest || null,
    runId: state.currentBest?.evidenceRunId || state.currentBest?.runId || null,
  };
  const bestDecision = selectEvidenceDecision(
    bestIdentity,
    state.currentBest?.evidenceDecision,
    state.currentBest?.acceptGate?.decision,
    adoptedEvent?.payload?.gate?.decision,
  ) || (bestCandidateId ? selectEvidenceDecision(bestIdentity, currentDecision) : null);
  const completed = state.stage === 'published'
    && candidateTasks.length === 3
    && state.currentBest?.candidateId
    && adoptedEvent?.payload?.gate?.passed === true;
  const evidenceDecision = bestDecision || currentDecision;
  const adoptionStatus = evidenceDecision?.adoption?.status || null;
  const waitingExternal = adoptionStatus === 'waiting_external_verification';
  // Workflow blockers are read from the loop status plus explicit task/source
  // failures; a decision that only waits for external verification is reported
  // separately instead of being flattened into INCOMPLETE.
  const blocked = ['needs_human', 'blocked', 'failed', 'cancelled', 'timed_out', 'candidate_generation_failed', 'resource_release_unconfirmed'].includes(state.iterationStats?.loopStatus)
    || ['failed', 'timed_out'].includes(research.status)
    || ['failed', 'timed_out'].includes(materializer.status)
    || Boolean(error)
    || adoptionStatus === 'blocked';
  // Adoption/publication wording comes from the versioned decision, never from
  // a recomputed boolean. Missing decisions stay explicitly unknown.
  const legacyKind = legacyExecutionKind(state, tasks);
  const overall = completed
    ? bestDecision
      ? `PASS（采用 ${bestDecision.adoption.status} / 发布 ${bestDecision.publication.status}）`
      : `PASS（历史${legacyKind ? ` ${legacyKind} ` : ''}记录缺少版本化决策，发布状态 unknown，不可发布）`
    : blocked
      ? 'BLOCKED'
      : waitingExternal
        ? `WAITING_EXTERNAL_VERIFICATION（待外部验证：adoption ${adoptionStatus}）`
        : 'INCOMPLETE';
  const rows = [];

  rows.push(row(
    '项目初始化',
    '固定工作流',
    '创建 Mission 描述、空代码仓库和空 Source Registry',
    `代码文件 ${initialization.codeFiles ?? '待检查'}，Source 条目 ${initialization.sourceEntries ?? '待检查'}`,
    '启动调研',
  ));

  if (research.runId || state.researchNotes?.length) {
    const source = state.researchNotes?.flatMap((note) => note.baselineSources || [])[0];
    rows.push(row(
      'Source 调研',
      'Research Agent',
      '从零查找上游实现并固定 repository、commit、path',
      source ? '权威来源已登记并验证' : researchFailure || `未形成可用来源（${research.phase || research.status || 'unknown'}）`,
      source ? '构建 baseline' : '等待人工处理',
    ));
  }

  if (materializer.runId) {
    rows.push(row(
      'Baseline 构建',
      'Materializer Agent + 固定工作流',
      '读取已验证来源，生成并校验单文件 reference',
      materializer.status === 'completed' ? 'Agent baseline 契约通过' : `${materializer.phase || materializer.status}`,
      materializer.status === 'completed' ? '排队 baseline 测试' : '等待生成完成',
    ));
  }

  if (baselineTask) {
    rows.push(row(
      'Baseline 测试',
      '固定工作流',
      '执行固定测试矩阵的 baseline 测量，并保留执行来源标记',
      baselineTask.status === 'completed' ? `${baselineValue} ${measurementFor(baselineTask)?.unit || 'us'}` : baselineTask.status,
      baselineTask.status === 'completed' ? 'Candidate 1' : '等待测试完成',
    ));
  }

  candidateTasks.forEach((task, index) => {
    const ordinal = index + 1;
    const value = measurementFor(task)?.value;
    const improvement = Number.isFinite(Number(baselineValue)) && Number.isFinite(Number(value))
      ? ((Number(baselineValue) - Number(value)) / Number(baselineValue)) * 100
      : null;
    const rolledBack = rollbackEvents.some((event) => event.payload?.candidateDigest === task.payload?.candidate?.digest);
    const taskCandidate = task.payload?.candidate || {};
    const taskIdentity = { candidateId: taskCandidate.id || null, candidateDigest: taskCandidate.digest || null };
    const taskDecision = selectEvidenceDecision(
      taskIdentity,
      measurementFor(task)?.evidenceDecision,
      task.result?.acceptGate?.decision,
      task.result?.decision,
      taskCandidate.acceptGate?.decision,
      (state.candidateEvaluations || []).find((item) => item.id === taskCandidate.id)?.acceptGate?.decision,
    );
    const adoption = taskDecision ? taskDecision.adoption.status : 'unknown';
    const result = task.status !== 'completed'
      ? task.error?.message || task.status
      : `${value} ${measurementFor(task)?.unit || 'us'}${improvement != null ? `，较 baseline ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%` : ''} · adoption ${adoption}${rolledBack ? '，已回退' : ''}`;
    rows.push(row(
      `Candidate ${ordinal}`,
      'Iteration Agent + 固定工作流',
      '生成独立真实 Diff，执行测试和 Accept Gate',
      result,
      taskDecision && adoption === 'allowed' ? '自动采纳' : task.status === 'completed' ? `Candidate ${ordinal + 1}` : '停止',
    ));
  });

  if (state.currentBest?.candidateId) {
    const adoption = bestDecision ? bestDecision.adoption.status : 'unknown';
    const publication = bestDecision ? bestDecision.publication.status : 'unknown';
    const decisionNote = bestDecision
      ? `adoption ${adoption} / publication ${publication}`
      : '无版本化决策，发布状态 unknown 且不可发布';
    rows.push(row(
      '采纳',
      '固定工作流',
      '将达标 Patch 提交到 Iteration Repository，并更新 current best',
      `${state.currentBest.value}（${decisionNote}）`,
      '完成 Mission',
    ));
  }

  if (completed) {
    rows.push(row('完成', '固定工作流', '终止迭代并检查稳定状态', '三轮结束，未启动第四轮', '无'));
  } else if (blocked) {
    rows.push(row('停止', '固定工作流', '在真实 Agent 或来源硬门禁处停止', researchFailure || error?.message || state.iterationStats?.loopStatusReason || research.phase || materializer.phase || '流程未完成', '修复阻断后重跑'));
  } else if (waitingExternal) {
    rows.push(row('待外部验证', '固定工作流', '真实必需诊断证据尚未就绪，候选保留并暂停发布', `adoption ${adoptionStatus} / publication ${evidenceDecision?.publication?.status || 'waiting_external_verification'}`, '补充合格真实诊断证据后重跑'));
  }

  const publicationNote = bestDecision
    ? bestDecision.publication.status === 'allowed'
      ? '本次结果带有可发布的版本化决策。'
      : `本次结果不可发布（publication ${bestDecision.publication.status}: ${reasonsText(bestDecision.publication.reasons)}）。`
    : currentDecision
      ? `当前候选尚未采用，其版本化决策 publication ${currentDecision.publication.status}: ${reasonsText(currentDecision.publication.reasons)}；发布结论以采用后的 currentBest 决策为准。`
      : '历史报告缺少版本化决策，发布状态 unknown，不得视为可发布；仿真来源报告保留不可发布说明。';

  return [
    '# Workflow Summary',
    '',
    `Mission: ${mission.title || 'FlashInfer MLA paged attention on MetaX C550'}`,
    `Result: ${overall}`,
    '',
    '| 阶段 | 执行者 | Workflow 做了什么 | 结果 | 下一步 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    ...decisionSection(evidenceDecision, legacyKind),
    '',
    `说明：${publicationNote}`,
    '',
  ].join('\n');
};
