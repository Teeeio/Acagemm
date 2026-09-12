import { candidateEvaluations } from './state-reference-data.mjs';

import { isMaximizeMission } from './mission-objective.mjs';

import { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';

import { createDecisionReviewState } from './evidence-state.mjs';

import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';

import { EVIDENCE_DECISION_POLICY_VERSION, EVIDENCE_DECISION_SCHEMA_VERSION } from './evidence-decision.mjs';

// 统一证据决策是知识治理的唯一分类依据。以下状态/级别常量是消费者契约：
// - published 只来自 decision.publication.status === 'allowed'
// - 真实执行（execution.kind === 'live'）但不可发布 => development（明确不可发布）
// - 显式 simulation/cpu/unknown => simulation，只能验证流程
// - 旧记录没有 decision => unknown，绝不从 Level 3 或 live 布尔自动授权
export const EVIDENCE_DECISION_DRAFT_STATUS = Object.freeze({
  VALIDATED: 'validated',
  DEVELOPMENT: 'development',
  SIMULATION: 'simulation',
  UNKNOWN: 'unknown',
});
export const EVIDENCE_DECISION_ASSET_STATUS = Object.freeze({
  PUBLISHED: 'published',
  DEVELOPMENT: 'development',
  SIMULATION: 'simulation',
  UNKNOWN: 'unknown',
});
export const PUBLISHED_EVIDENCE_LEVEL = 'Level 3';
export const DEVELOPMENT_EVIDENCE_LEVEL = '真实开发证据';
export const SIMULATION_EVIDENCE_LEVEL = '模拟证据';
export const UNKNOWN_EVIDENCE_LEVEL = '未知证据';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const decisionField = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isStringOrNull = (value) => value === null || typeof value === 'string';
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

const DECISION_EXECUTION_KINDS = new Set(['live', 'simulation', 'cpu', 'unknown']);
const DECISION_ADOPTION_STATUSES = new Set(['allowed', 'reference', 'blocked', 'waiting_external_verification']);
const DECISION_PUBLICATION_STATUSES = new Set(['allowed', 'blocked', 'waiting_external_verification']);
const DECISION_BINDING_KEYS = Object.freeze(['missionId', 'candidateId', 'candidateDigest', 'runId', 'taskId', 'sourceRunId', 'semanticDigest']);
const DIAGNOSTIC_PREDICATE_KEYS = Object.freeze(['schemaValid', 'available', 'evidenceEligible']);

const validDiagnosticPredicate = (value) => isPlainObject(value)
  && DIAGNOSTIC_PREDICATE_KEYS.every((key) => typeof value[key] === 'boolean')
  && isStringArray(value.reasons)
  && (value.evidenceEligible !== true || (value.schemaValid === true && value.available === true));

// The governance consumer only accepts an already-recognized, complete v1 DTO.
// It validates structure and internal consistency; it never recomputes the
// authoritative policy, so a malformed or future-schema record is unknown and
// non-publishable rather than being promoted from a single status field.
export const validateEvidenceDecision = (decision) => {
  if (!isPlainObject(decision)) return { valid: false, reason: '缺少统一证据决策，保守视为未知且不可发布。' };
  if (decision.schemaVersion !== EVIDENCE_DECISION_SCHEMA_VERSION || decision.policyVersion !== EVIDENCE_DECISION_POLICY_VERSION) {
    return { valid: false, reason: '证据决策 schema/策略版本未识别，保守视为未知且不可发布。' };
  }
  const binding = decision.binding;
  if (!isPlainObject(binding) || !DECISION_BINDING_KEYS.every((key) => hasOwn(binding, key) && isStringOrNull(binding[key]))) {
    return { valid: false, reason: '证据决策绑定字段缺失或形状无效，保守视为未知且不可发布。' };
  }
  const execution = decision.execution;
  if (!isPlainObject(execution) || !DECISION_EXECUTION_KINDS.has(execution.kind)
    || typeof execution.liveHardware !== 'boolean' || !hasOwn(execution, 'source') || !isStringOrNull(execution.source)) {
    return { valid: false, reason: '证据决策执行分类字段缺失或形状无效，保守视为未知且不可发布。' };
  }
  if (!isPlainObject(decision.correctness) || typeof decision.correctness.passed !== 'boolean'
    || !isPlainObject(decision.benchmark) || typeof decision.benchmark.valid !== 'boolean') {
    return { valid: false, reason: '证据决策正确性/benchmark 字段缺失或形状无效，保守视为未知且不可发布。' };
  }
  const diagnostics = decision.diagnostics;
  if (!isPlainObject(diagnostics) || !validDiagnosticPredicate(diagnostics.tracer) || !validDiagnosticPredicate(diagnostics.profiler)) {
    return { valid: false, reason: '证据决策诊断三元判定缺失或形状无效，保守视为未知且不可发布。' };
  }
  if (!isPlainObject(decision.adoption) || !DECISION_ADOPTION_STATUSES.has(decision.adoption.status) || !isStringArray(decision.adoption.reasons)
    || !isPlainObject(decision.publication) || !DECISION_PUBLICATION_STATUSES.has(decision.publication.status) || !isStringArray(decision.publication.reasons)) {
    return { valid: false, reason: '证据决策采用/发布字段缺失或形状无效，保守视为未知且不可发布。' };
  }
  // Execution kind and liveHardware state the same fact twice: a `live` kind
  // must declare liveHardware, and every non-live kind must not. Either mismatch
  // is a malformed DTO and stays unknown/non-publishable.
  if ((execution.kind === 'live') !== (execution.liveHardware === true)) {
    return { valid: false, reason: '证据决策执行分类与 liveHardware 未双向一致，保守视为未知且不可发布。' };
  }
  if (decision.adoption.status === 'allowed' && (!decision.correctness.passed || !decision.benchmark.valid || decision.adoption.reasons.length)) {
    return { valid: false, reason: '证据决策采用结论与正确性/benchmark 字段不一致，保守视为未知且不可发布。' };
  }
  // A publication grant must name the candidate and run it was observed on. A
  // structurally complete binding object whose identity fields are all null may
  // not authorize publication from eligible flags alone.
  const publicationBindingComplete = ['candidateId', 'candidateDigest', 'runId']
    .every((key) => typeof binding[key] === 'string' && binding[key].trim());
  if (decision.publication.status === 'allowed' && !publicationBindingComplete) {
    return { valid: false, reason: '证据决策发布缺少候选/运行绑定身份，保守视为未知且不可发布。' };
  }
  if (decision.publication.status === 'allowed'
    && (decision.adoption.status !== 'allowed'
      || execution.kind !== 'live' || execution.liveHardware !== true
      || !diagnostics.tracer.evidenceEligible || !diagnostics.profiler.evidenceEligible
      || decision.publication.reasons.length)) {
    return { valid: false, reason: '证据决策发布结论与采用/执行/诊断字段不一致，保守视为未知且不可发布。' };
  }
  return { valid: true, reason: null };
};

const unknownClassification = (reason) => ({
  known: false,
  executionKind: 'unknown',
  adoptionStatus: 'blocked',
  publicationStatus: 'blocked',
  draftStatus: EVIDENCE_DECISION_DRAFT_STATUS.UNKNOWN,
  assetStatus: EVIDENCE_DECISION_ASSET_STATUS.UNKNOWN,
  evidenceLevel: UNKNOWN_EVIDENCE_LEVEL,
  confidence: '未经证据决策判定，不可发布',
  publication: 'blocked',
  publishable: false,
  reason,
});

// Pure classification of one evidence decision into draft/asset governance state.
// It never reads a legacy level or live boolean for authorization.
export const classifyEvidenceDecision = (decision) => {
  const validation = validateEvidenceDecision(decision);
  if (!validation.valid) return unknownClassification(validation.reason);
  const executionKind = decisionField(decision.execution?.kind, 'unknown');
  const adoptionStatus = decisionField(decision.adoption?.status, 'blocked');
  const publicationStatus = decisionField(decision.publication?.status, 'blocked');
  const publication = publicationStatus === 'allowed'
    ? 'published'
    : publicationStatus === 'waiting_external_verification' ? 'waiting' : 'blocked';
  if (publicationStatus === 'allowed') {
    return {
      known: true, executionKind, adoptionStatus, publicationStatus,
      draftStatus: EVIDENCE_DECISION_DRAFT_STATUS.VALIDATED,
      assetStatus: EVIDENCE_DECISION_ASSET_STATUS.PUBLISHED,
      evidenceLevel: PUBLISHED_EVIDENCE_LEVEL,
      confidence: '中',
      publication: 'published',
      publishable: true,
      reason: '统一证据决策允许正式发布。',
    };
  }
  if (executionKind === 'live') {
    return {
      known: true, executionKind, adoptionStatus, publicationStatus,
      draftStatus: EVIDENCE_DECISION_DRAFT_STATUS.DEVELOPMENT,
      assetStatus: EVIDENCE_DECISION_ASSET_STATUS.DEVELOPMENT,
      evidenceLevel: DEVELOPMENT_EVIDENCE_LEVEL,
      confidence: '仅开发验证',
      publication,
      publishable: false,
      reason: publicationStatus === 'waiting_external_verification'
        ? '真实开发证据：发布所需外部诊断仍在等待，明确不可发布。'
        : '真实开发证据：环境受限或缺少发布授权，明确不可发布。',
    };
  }
  if (executionKind === 'unknown') {
    // A recognized DTO may still admit it cannot classify execution. That is
    // not a simulation claim: keep it unknown/未知证据 and non-publishable
    // instead of fabricating a simulated provenance.
    return {
      known: true, executionKind, adoptionStatus, publicationStatus,
      draftStatus: EVIDENCE_DECISION_DRAFT_STATUS.UNKNOWN,
      assetStatus: EVIDENCE_DECISION_ASSET_STATUS.UNKNOWN,
      evidenceLevel: UNKNOWN_EVIDENCE_LEVEL,
      confidence: '执行分类未知，不可发布',
      publication: 'blocked',
      publishable: false,
      reason: '执行分类未知：无法确认真实/模拟来源，明确不可发布并转人工治理。',
    };
  }
  return {
    known: true, executionKind, adoptionStatus, publicationStatus,
    draftStatus: EVIDENCE_DECISION_DRAFT_STATUS.SIMULATION,
    assetStatus: EVIDENCE_DECISION_ASSET_STATUS.SIMULATION,
    evidenceLevel: SIMULATION_EVIDENCE_LEVEL,
    confidence: '仅供流程验证',
    publication,
    publishable: false,
    reason: '非真实执行（模拟 / CPU），只能验证流程，明确不可发布。',
  };
};

// Identity matching is explicit: a decision only governs a record when the
// identity fields the record exposes agree. Missing identity never defaults to a
// match, so another candidate/run's decision can never be backfilled.
const decisionMatchesIdentity = (decision, identity = {}) => {
  if (!isPlainObject(decision?.binding)) return false;
  const binding = decision.binding;
  for (const key of ['candidateId', 'candidateDigest', 'runId']) {
    const expected = identity?.[key];
    if (typeof expected !== 'string' || !expected) return false;
    if (binding[key] !== expected) return false;
  }
  return true;
};

const draftBindingIdentity = (draft = {}) => {
  const binding = isPlainObject(draft?.evidenceBinding) ? draft.evidenceBinding : null;
  const candidateId = (binding && typeof binding.candidateId === 'string' && binding.candidateId)
    || (typeof draft?.sourceCandidate === 'string' && draft.sourceCandidate ? draft.sourceCandidate : null);
  const candidateDigest = binding && typeof binding.candidateDigest === 'string' ? binding.candidateDigest : null;
  const runId = binding && typeof binding.runId === 'string' ? binding.runId : null;
  return {
    candidateId,
    candidateDigest,
    runId,
    // Only an explicit, complete binding may authorize a backfill from current
    // state; a draft that merely names its source candidate cannot.
    explicit: Boolean(binding && binding.candidateId && binding.candidateDigest && binding.runId),
  };
};

const currentRunIdentity = (state = {}) => {
  const benchmark = isPlainObject(state?.benchmark) ? state.benchmark : {};
  const candidateId = (typeof state?.appliedCandidateId === 'string' && state.appliedCandidateId)
    || (typeof benchmark.candidate?.id === 'string' && benchmark.candidate.id ? benchmark.candidate.id : null);
  const candidate = (Array.isArray(state?.candidateEvaluations) ? state.candidateEvaluations : []).find((item) => item?.id === candidateId);
  return {
    candidateId: candidateId || null,
    candidateDigest: (typeof benchmark.candidate?.digest === 'string' && benchmark.candidate.digest ? benchmark.candidate.digest : null)
      || (typeof candidate?.patchDigest === 'string' && candidate.patchDigest ? candidate.patchDigest : null),
    runId: typeof benchmark.runId === 'string' && benchmark.runId ? benchmark.runId : null,
  };
};

const currentRunDecisions = (state = {}) => [
  state?.benchmark?.evidenceDecision,
  state?.decisionReview?.gate?.decision,
  state?.decisionReview?.evidenceDecision,
];

// The decision that governs one draft/record. A draft keeps its own bound
// decision; only an explicit candidate+digest+run match may backfill it from
// current state. Other candidates'/runs' decisions are never substituted.
export const resolveGovernanceDecision = (state = {}, draft = null) => {
  if (draft) {
    const identity = draftBindingIdentity(draft);
    const own = draft.evidenceDecision;
    if (validateEvidenceDecision(own).valid && decisionMatchesIdentity(own, identity)) return structuredClone(own);
    if (!identity.explicit) return null;
    const backfill = currentRunDecisions(state).find((item) => validateEvidenceDecision(item).valid && decisionMatchesIdentity(item, identity));
    return backfill ? structuredClone(backfill) : null;
  }
  const identity = currentRunIdentity(state);
  if (!identity.candidateId && !identity.runId) return null;
  const found = currentRunDecisions(state).find((item) => validateEvidenceDecision(item).valid && decisionMatchesIdentity(item, identity));
  return found ? structuredClone(found) : null;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value === undefined ? null : value;
};

// Decision identity/content without self-generated evaluation timestamps. The
// full decision participates except `evaluatedAt`, including diagnostics, so a
// changed diagnostic field re-processes exactly once.
const decisionFingerprintPart = (decision) => {
  const validation = validateEvidenceDecision(decision);
  if (!validation.valid) return null;
  return canonicalize({
    schemaVersion: decision.schemaVersion,
    policyVersion: decision.policyVersion,
    binding: decision.binding,
    execution: decision.execution,
    correctness: decision.correctness,
    benchmark: decision.benchmark,
    diagnostics: decision.diagnostics,
    adoption: decision.adoption,
    publication: decision.publication,
  });
};

// Only stable draft identity/content participates. Derived governance fields
// (status/level/confidence/publication/publishable) and generated timestamps are
// outputs, so they can never drift the input fingerprint. Version, evidence and
// the explicit binding are inputs and therefore included.
const DRAFT_FINGERPRINT_FIELDS = Object.freeze([
  'id', 'version', 'category', 'title', 'conclusion', 'scope', 'hardware', 'operator', 'dtype', 'layout',
  'shape', 'runtime', 'trigger', 'procedure', 'expectedGain', 'validation', 'constraints', 'evidence',
  'contraindications', 'failedAttempts', 'evidenceRefs', 'evidenceBinding', 'sourceMission', 'sourceCandidate',
  'sourceCommit', 'owner',
]);
const draftFingerprintPart = (draft) => {
  const record = {};
  for (const field of DRAFT_FINGERPRINT_FIELDS) record[field] = draft?.[field];
  return canonicalize(record);
};

// Idempotency is keyed on the actual per-draft inputs (its own bound decision
// identity/content plus stable draft content). Global run/stage/Agent fields are
// deliberately excluded so an unrelated benchmark cannot re-run maintenance over
// old drafts.
const knowledgeInputFingerprint = (state, maximizeObjective) => {
  const drafts = Array.isArray(state.knowledgeDrafts) ? state.knowledgeDrafts : [];
  return JSON.stringify(canonicalize({
    drafts: drafts.map((draft) => ({
      ...draftFingerprintPart(draft),
      decision: decisionFingerprintPart(resolveGovernanceDecision(state, draft)),
    })),
    objectiveMode: maximizeObjective ? 'maximize' : 'gate',
  }));
};

const knowledgeChangePlan = [
  { draftId: 'exp.async-plan-cache', action: 'update', targetId: 'exp.fixed-overhead', targetTitle: '短序列下优先量化固定开销', previousVersion: 'v1.2', nextVersion: 'v1.3', scopeDelta: '适用范围未扩大', reason: '命中已有固定开销经验，补充 plan cache、host mirror 与双平台证据。' },
  { draftId: 'exp.c550-plan-cache-boundary', action: 'create', targetId: 'exp.c550-plan-cache-boundary', targetTitle: '沐曦 C550 plan cache 与 host mirror 边界准则', previousVersion: null, nextVersion: 'v1.0', scopeDelta: 'C550 专项范围', reason: '未发现等价硬件专项经验，创建新的 C550 经验资产。' },
  { draftId: 'exp.cross-platform-adoption-gate', action: 'update', targetId: 'policy.cross-platform-adoption-gate', targetTitle: 'C550 / CUDA 跨平台候选采用门禁', previousVersion: 'v2.3', nextVersion: 'v2.4', scopeDelta: '策略适用范围未扩大', reason: '合并本次失败候选与 Level 3 双平台验证证据。' },
];

export const createKnowledgeMaintenanceState = (status = 'idle') => {
  const completed = status === 'completed';
  const ready = status === 'ready';
  return {
    status,
    trigger: 'decision.adopted',
    triggerLabel: status === 'idle' ? '等待效果决策' : '效果决策 · Candidate 02 已采用',
    policy: {
      id: 'policy.knowledge.evidence-decision',
      label: '证据决策驱动的知识治理',
      version: 'v3.0',
      rule: 'evidenceDecision.publication.status = allowed',
      exception: '真实开发证据只形成 development 资产；证据缺失、模拟或冲突时转人工治理',
    },
    startedAt: completed ? new Date().toISOString() : null,
    completedAt: completed ? new Date().toISOString() : null,
    summary: { extracted: completed ? 3 : 0, matched: completed ? 2 : 0, created: completed ? 1 : 0, autoPublished: completed ? 3 : 0, reviewRequired: 0 },
    steps: [
      { id: 'extract', label: '经验提取', detail: completed ? '3 个结构化经验对象' : '等待效果决策', status: completed ? 'completed' : (ready ? 'queued' : 'idle') },
      { id: 'deduplicate', label: '查重与合并', detail: completed ? '2 条合并 · 1 条新建' : '等待经验提取', status: completed ? 'completed' : 'idle' },
      { id: 'evidence', label: '证据与边界校验', detail: completed ? 'Level 3 · 13 个证据引用' : '等待匹配结果', status: completed ? 'completed' : 'idle' },
      { id: 'publish', label: '策略发布', detail: completed ? '3 条自动发布 · 0 条需复核' : '等待策略判定', status: completed ? 'completed' : 'idle' },
    ],
    changes: completed ? knowledgeChangePlan.map((change) => ({ ...change, outcome: 'auto_published' })) : knowledgeChangePlan.map((change) => ({ ...change, outcome: 'pending' })),
  };
};

export const toPublishedKnowledgeAsset = (draft, version = 'v1.0') => {
  const hardwareKeys = draft.hardware.map((item) => ({ C550: 'c550', CUDA: 'nvidia', 'ROCm MI300': 'amd' }[item])).filter(Boolean);
  // 只按同一 evidenceDecision 分类；旧记录没有决策时明确 unknown/不可发布，
  // 绝不因为 draft.status === 'validated' 或 evidenceLevel === 'Level 3' 而授权发布。
  const classification = classifyEvidenceDecision(draft.evidenceDecision || null);
  return {
    ...draft,
    kind: 'Experience',
    version,
    description: draft.conclusion,
    tags: [draft.category, draft.operator, draft.dtype, ...draft.hardware, classification.evidenceLevel].filter(Boolean),
    tone: 'ochre',
    icon: 'Lightbulb',
    hardwareKeys,
    permissions: 'organization:read',
    status: classification.assetStatus,
    evidenceLevel: classification.evidenceLevel,
    publication: classification.publication,
    publishable: classification.publishable,
    updated: new Date().toISOString().slice(0, 10),
  };
};

const knowledgeChangeOutcome = (asset) => {
  if (asset?.status === EVIDENCE_DECISION_ASSET_STATUS.PUBLISHED) return 'auto_published';
  if (asset?.status === EVIDENCE_DECISION_ASSET_STATUS.DEVELOPMENT) return 'development_only';
  if (asset?.status === EVIDENCE_DECISION_ASSET_STATUS.SIMULATION) return 'simulation_only';
  return 'review_required';
};

export function runKnowledgeMaintenance(state) {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const maximizeObjective = isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: mission.goal });
  const decision = resolveGovernanceDecision(state);
  const executionKind = decision?.execution?.kind || 'unknown';
  const liveEvidence = executionKind === 'live';
  const publishedStatus = decision?.publication?.status || 'blocked';
  const drafts = Array.isArray(state.knowledgeDrafts) ? state.knowledgeDrafts : [];
  // 幂等以输入决策身份/内容 + draft 稳定内容为指纹；自身生成的时间戳/状态/版本绝不进入
  // 指纹。重复 tick / JSON 恢复不得改变 events / timestamps / counters / assets 版本；
  // draft 内容或候选/run 变化才允许重新处理一次。
  const fingerprint = knowledgeInputFingerprint(state, maximizeObjective);
  if (state.knowledgeMaintenance?.status === 'completed'
    && state.knowledgeMaintenance.inputFingerprint === fingerprint
    && Array.isArray(state.publishedAssets)
    && state.publishedAssets.length === drafts.length) return state;
  const startedAt = new Date().toISOString();
  const activeCandidateId = state.appliedCandidateId || state.currentBest?.candidateId || 'candidate';
  const maintainedDrafts = drafts.map((draft) => {
    const draftDecision = resolveGovernanceDecision(state, draft);
    const classification = classifyEvidenceDecision(draftDecision);
    return {
      ...draft,
      evidenceLevel: classification.evidenceLevel,
      confidence: classification.confidence,
      status: classification.draftStatus,
      publication: classification.publication,
      publishable: classification.publishable,
      evidenceDecision: draftDecision ? structuredClone(draftDecision) : null,
    };
  });
  state.knowledgeDrafts = maintainedDrafts;
  const activeChanges = maintainedDrafts.map((draft) => knowledgeChangePlan.find((change) => change.draftId === draft.id) || {
    draftId: draft.id,
    action: 'create',
    targetId: draft.id,
    targetTitle: draft.title,
    previousVersion: null,
    nextVersion: 'v1.0',
    scopeDelta: '当前 Mission 验证范围',
    reason: `由 ${activeCandidateId} 的 Patch 与测试证据自动提取。`,
  });
  const versionByDraft = new Map(activeChanges.map((change) => [change.draftId, change.nextVersion]));
  state.publishedAssets = maintainedDrafts.map((draft) => toPublishedKnowledgeAsset(draft, versionByDraft.get(draft.id) || 'v1.0'));
  const publishedCount = state.publishedAssets.filter((asset) => asset.status === EVIDENCE_DECISION_ASSET_STATUS.PUBLISHED).length;
  const developmentCount = state.publishedAssets.filter((asset) => asset.status === EVIDENCE_DECISION_ASSET_STATUS.DEVELOPMENT).length;
  const simulationCount = state.publishedAssets.filter((asset) => asset.status === EVIDENCE_DECISION_ASSET_STATUS.SIMULATION).length;
  const unknownCount = state.publishedAssets.filter((asset) => asset.status === EVIDENCE_DECISION_ASSET_STATUS.UNKNOWN).length;
  const pendingPublicationCount = state.publishedAssets.filter((asset) => asset.publication !== 'published').length;
  state.knowledgeMaintenance = {
    ...createKnowledgeMaintenanceState('completed'),
    startedAt,
    completedAt: new Date().toISOString(),
    // 输入指纹是幂等依据，不是展示字段；它不包含本函数生成的任何时间戳。
    inputFingerprint: fingerprint,
    summary: {
      extracted: drafts.length,
      matched: activeChanges.filter((change) => change.action === 'update').length,
      created: activeChanges.filter((change) => change.action === 'create').length,
      autoPublished: publishedCount,
      reviewRequired: drafts.length - publishedCount,
    },
    changes: activeChanges.map((change, index) => ({ ...change, outcome: knowledgeChangeOutcome(state.publishedAssets[index]) })),
    triggerLabel: maximizeObjective
      ? `效果决策 · ${activeCandidateId} 已采用`
      : developmentCount > 0 && publishedCount === 0
        ? `真实开发证据 · ${activeCandidateId} 形成 development 资产（不可发布）`
        : unknownCount > 0 && simulationCount === 0
          ? `未知执行分类 · ${activeCandidateId} 证据不可发布，转人工治理`
          : `仿真闭环 · ${activeCandidateId} 仅生成预览资产`,
  };
  // stage 仍沿用既有工作流兼容值（published 只是阶段名，不等于正式资产发布）；
  // 资产是否正式发布由 asset.publication 明确表达（waiting / blocked / published）。
  state.stage = maximizeObjective ? 'evidence' : 'published';
  state.decisionReview = {
    ...(state.decisionReview || createDecisionReviewState('resolved')),
    status: 'resolved',
    requiresApproval: false,
    recommendation: 'adopt',
    resolution: state.decisionReview?.resolution || { outcome: 'adopt', source: 'policy' },
    resolvedAt: state.decisionReview?.resolvedAt || new Date().toISOString(),
  };
  const agentTitle = maximizeObjective
    ? 'Current best 经验已记录'
    : publishedCount > 0
      ? '知识资产已自动维护'
      : developmentCount > 0
        ? '真实开发证据已记录（不可发布）'
        : unknownCount > 0 && simulationCount === 0
          ? '未知执行分类证据已记录（不可发布）'
          : '仿真经验预览已生成';
  const agentDetail = maximizeObjective
    ? `${state.currentBest?.value || 'current best'} 已记录，Mission 继续优化。`
    : publishedCount > 0
      ? `${publishedCount} 条经验已完成查重、版本化和策略发布。`
      : developmentCount > 0
        ? `${developmentCount} 条真实开发证据已记录为 development 资产，${pendingPublicationCount} 条等待 / 阻塞正式发布。`
        : unknownCount > 0 && simulationCount === 0
          ? `${unknownCount} 条经验的执行分类未知，明确不可发布并转人工治理。`
          : `${simulationCount + unknownCount} 条经验仅用于验证客户端闭环，不会进入正式知识资产库。`;
  state.agent = {
    ...state.agent,
    status: 'completed',
    phase: maximizeObjective ? 'Current best 已更新，继续优化' : '知识自动维护完成',
    progress: 100,
    currentAction: null,
    messages: [...(state.agent?.messages || []), { id: `knowledge-${Date.now()}`, phase: 'knowledge', status: 'completed', title: agentTitle, detail: agentDetail, time: '刚刚' }],
  };
  appendRuntimeEvent(state, 'knowledge.maintenance_completed', {
    policyId: state.knowledgeMaintenance.policy.id,
    summary: state.knowledgeMaintenance.summary,
    changes: state.knowledgeMaintenance.changes,
    liveEvidence,
    executionKind,
    publicationStatus: publishedStatus,
    objectiveMode: maximizeObjective ? 'maximize' : 'gate',
  }, { kind: 'knowledge', mode: 'client' });
  addAuditEvent(state, maximizeObjective ? 'Current best 经验已记录，继续优化' : publishedCount > 0 ? '知识资产已按策略自动维护' : developmentCount > 0 ? '真实开发证据已记录为 development 资产' : unknownCount > 0 && simulationCount === 0 ? '未知执行分类证据已记录（不可发布）' : '仿真经验预览已生成', `${state.publishedAssets.length} Experiences · ${state.knowledgeMaintenance.policy.version} · ${developmentCount} development · ${simulationCount} simulation · ${unknownCount} unknown · ${pendingPublicationCount} not published`, liveEvidence ? 'blue' : 'warning', 'BookOpen');
  return state;
}

export function markCandidateAccepted(state, note, source = 'policy') {
  const acceptedAt = new Date().toISOString();
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId || 'candidate-02';
  state.candidateEvaluations = (state.candidateEvaluations || candidateEvaluations).map((candidate) => candidate.id === candidateId
    ? {
        ...candidate,
        classification: 'accepted',
        status: source === 'human_review' ? '已按人工处置采用' : '已自动采用',
        tone: 'adopted',
        decision: source === 'human_review' ? '人工介入采用为 current best' : '策略自动采用为 current best',
        decisionReason: note,
        acceptedAt,
        // 采用只改候选采用状态：原 Gate 及其 decision 是既定事实，人工采用也不改写结论。
      }
    : candidate);
  return acceptedAt;
}

// Select the review Gate for the adopted candidate, rejecting a review Gate that
// belongs to a different candidate. The Gate's embedded decision must additionally
// be bound to the adopted candidate/run, otherwise it is treated as no decision
// rather than copied from another candidate/run.
const adoptionGateFor = (state, candidate, candidateId) => {
  const review = state.decisionReview || {};
  const reviewMatchesCandidate = !review.candidateId || review.candidateId === candidateId;
  const gate = (reviewMatchesCandidate && review.gate) || candidate?.acceptGate || { passed: false, passedRules: [], evaluatedRules: 0 };
  const decision = isPlainObject(review.gate?.decision) && reviewMatchesCandidate ? review.gate.decision : candidate?.acceptGate?.decision;
  const runId = state.benchmark?.runId || null;
  return {
    gate,
    decision: validateEvidenceDecision(decision).valid
      && decisionMatchesIdentity(decision, { candidateId, candidateDigest: candidate?.patchDigest, runId }) ? decision : null,
  };
};

export function runAutomaticAdoption(state, note = 'Accept Gate 全部通过，策略自动采用 Candidate 02。') {
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const isCodexCandidate = isManagedWorkspaceRuntimeMode(state.agent?.runtimeKind);
  const { gate, decision } = adoptionGateFor(state, candidate, candidateId);
  if (gate?.decision && !decision) return state;
  if (state.decisionReview?.status === 'awaiting_review' || !candidateId || (isCodexCandidate && (!candidate?.patchDigest || gate?.passed !== true))) return state;
  // 决策存在时只认真实 adoption 字段：等待外部验证 / 阻塞绝不自动采用。
  if (isPlainObject(decision) && decision.adoption?.status !== 'allowed') return state;
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const maximizeObjective = isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: mission.goal });
  const resolvedAt = markCandidateAccepted(state, note, 'policy');
  state.stage = maximizeObjective ? 'evidence' : 'curation';
  const primaryMeasurement = state.benchmark?.result?.benchmark?.[0];
  // 真实硬件事实与“可正式发布”是两个独立维度：verified 只由 publication allowed 决定，
  // liveHardware 只陈述执行分类。旧无 decision 一律不可发布授权。
  const publicationAllowed = isPlainObject(decision) ? decision.publication?.status === 'allowed' : false;
  const realHardware = isPlainObject(decision)
    ? decision.execution?.liveHardware === true
    : state.benchmark?.result?.environment?.liveHardware === true;
  const decisionClone = isPlainObject(decision) ? structuredClone(decision) : null;
  state.currentBest = {
    candidateId,
    candidateDigest: candidate.patchDigest || null,
    version: candidate.version || 'agent.1',
    value: primaryMeasurement ? `${primaryMeasurement.value} ${primaryMeasurement.unit}` : '--',
    improvement: candidate.delta || 'new',
    status: 'active',
    evidenceSource: (isPlainObject(decision) && decision.execution?.source) || gate.evidenceSource || 'unknown',
    verified: publicationAllowed,
    liveHardware: realHardware,
    evidenceDecision: decisionClone,
    evidenceRunId: state.benchmark?.runId || null,
    measurements: (state.benchmark?.result?.benchmark || []).map((measurement) => ({
      profile: measurement.profile || measurement.environment,
      value: measurement.value,
      unit: measurement.unit || 'us',
    })),
  };
  // 保留原 review Gate 及其结论；仅在决策确属当前候选/运行时放入同一克隆。
  const reviewGate = isPlainObject(gate)
    ? (decisionClone ? { ...gate, decision: decisionClone } : (() => { const { decision: _foreign, ...rest } = gate; return rest; })())
    : gate;
  state.decisionReview = {
    ...createDecisionReviewState('resolved'),
    candidateId,
    recommendation: 'adopt',
    gate: reviewGate,
    evidenceDecision: decisionClone,
    resolution: { outcome: 'adopt', source: 'policy', note, resolvedAt },
    resolvedAt,
  };
  state.knowledgeMaintenance = createKnowledgeMaintenanceState('ready');
  state.agent = {
    ...state.agent,
    status: maximizeObjective ? 'completed' : 'executing',
    phase: maximizeObjective ? 'Accept Gate 自动采用，继续优化' : 'Accept Gate 自动采用',
    currentAction: null,
    messages: [...(state.agent?.messages || []), { id: `auto-adopt-${Date.now()}`, phase: 'decision', status: 'completed', title: `Accept Gate 已自动采用 ${candidateId}`, detail: `${gate.passedRules?.length || 0} / ${gate.evaluatedRules || gate.passedRules?.length || 0} 条必需规则通过 · current best 已更新${maximizeObjective ? ' · Mission 继续优化' : ''}`, time: '刚刚' }],
  };
  appendRuntimeEvent(state, 'decision.auto_adopted', { candidate: candidateId, policyId: state.decisionReview.policy.id, passedRules: gate.passedRules || [], gate, objectiveMode: maximizeObjective ? 'maximize' : 'gate' }, { kind: 'policy', mode: 'client' });
  addAuditEvent(state, maximizeObjective ? 'Accept Gate 自动采用候选，继续优化' : 'Accept Gate 自动采用候选', `${candidateId} · ${gate.passedRules?.length || 0}/${gate.evaluatedRules || gate.passedRules?.length || 0} required rules passed`, 'green', 'ShieldCheck');
  return state;
}
