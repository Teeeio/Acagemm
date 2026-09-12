import { assertResourcesReleased } from './cancellation-contract.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';
import { projectIdForRepository, projectNameForRepository } from './state-identifiers.mjs';
import { normalizeMissionObjective } from './mission-objective.mjs';
import { createDecisionReviewState, createBaselineRequirementState } from './evidence-state.mjs';
import { MLA_OPTIMIZATION_TEST_GOAL } from './mission-intent.mjs';
import { normalizeOperatorLanguage } from './operator-language.mjs';
import { normalizeMissionTestMatrix } from './test-spec.mjs';
import { emptyTokenUsage, normalizeTokenUsageLedger } from './token-usage.mjs';
import { createSemanticSnapshot, normalizeSemanticSnapshot } from './semantic-snapshot.mjs';
import { knowledgeDrafts, candidateEvaluations, failureRecords, agentProfiles, capabilityRegistry } from './state-reference-data.mjs';
import { normalizeMissionBudgetMs, createCurrentBestState, createResearchAgentState, createIterationStats, createIdleAgent } from './mission-state-shapes.mjs';
import { createKnowledgeMaintenanceState, markCandidateAccepted, toPublishedKnowledgeAsset } from './knowledge-state.mjs';
import { isInfrastructureTestFailure } from './operator-test-evidence.mjs';

// 轮次必需事实的快照版本。事实来自生产已观测状态，独立于经验库预算；缺失观测一律
// 记 unknown/not_observed，绝不用当前（可能已前移）的预算或 Mission 声明补齐。
export const ROUND_FACTS_SCHEMA_VERSION = 'operator-studio.round-facts/v1';

const factsText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const factsNumber = (value) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const factsBoolean = (value) => (typeof value === 'boolean' ? value : null);
const factsFiles = (value) => {
  if (Array.isArray(value)) return value.map(factsText).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
  return [];
};

const roundCorrectnessFacts = (benchmark) => {
  const measurements = Array.isArray(benchmark?.result?.benchmark) ? benchmark.result.benchmark : [];
  const environments = [];
  const cases = [];
  for (const measurement of measurements) {
    if (!measurement || typeof measurement !== 'object') continue;
    const correctness = measurement.correctness && typeof measurement.correctness === 'object' ? measurement.correctness : null;
    for (const item of Array.isArray(correctness?.caseResults) ? correctness.caseResults : []) {
      if (!item || typeof item !== 'object') continue;
      cases.push({
        environment: factsText(measurement.environment),
        profile: factsText(measurement.profile),
        case: factsText(item.case),
        dtype: factsText(item.dtype),
        passed: factsBoolean(item.passed),
        maxDiff: factsNumber(item.maxDiff),
        rmse: factsNumber(item.rmse),
        cosDiff: factsNumber(item.cosDiff),
      });
    }
    environments.push({
      environment: factsText(measurement.environment),
      profile: factsText(measurement.profile),
      stage: factsText(measurement.stage),
      passed: correctness?.passed === true ? true : correctness?.passed === false ? false : null,
      total: factsNumber(correctness?.total),
      passedCases: factsNumber(correctness?.passedCases),
      failedCase: factsNumber(correctness?.failedCase),
      failedCaseName: factsText(correctness?.failedCaseName),
      failedCaseCategory: factsText(correctness?.failedCaseCategory),
      error: factsText(correctness?.error),
    });
  }
  const firstFailure = environments.find((item) => item.passed === false) || null;
  const totals = environments.map((item) => item.total).filter((value) => value !== null);
  return {
    status: firstFailure || cases.some((item) => item.passed === false) ? 'failed'
      : environments.length && environments.every((item) => item.passed === true) ? 'passed' : 'not_observed',
    total: totals.length ? Math.max(...totals) : null,
    failedCase: firstFailure?.failedCase ?? null,
    failedCaseName: firstFailure?.failedCaseName ?? null,
    failedCaseCategory: firstFailure?.failedCaseCategory ?? null,
    error: firstFailure?.error ?? null,
    environments,
    cases,
  };
};

const findRoundFailureRecord = (state, candidateId) => {
  const records = Array.isArray(state.failureRecords) ? state.failureRecords.filter((item) => item && typeof item === 'object') : [];
  const queueRunId = factsText(state.benchmark?.runId);
  return records.find((item) => candidateId && factsText(item.candidateId) === candidateId)
    || records.find((item) => candidateId && factsText(item.sourceAttempt) === candidateId)
    || records.find((item) => queueRunId && factsText(item.evidence) === queueRunId)
    || null;
};

const roundFailureFacts = (state, candidateId) => {
  const serviceError = state.benchmark?.lastServiceError;
  if (serviceError && typeof serviceError === 'object') {
    return {
      classification: isInfrastructureTestFailure({ error: serviceError }) ? 'infrastructure' : 'operator',
      code: factsText(serviceError.code),
      message: factsText(serviceError.message),
      source: 'benchmark.lastServiceError',
    };
  }
  const record = findRoundFailureRecord(state, candidateId);
  if (!record) return null;
  const failure = record.failure && typeof record.failure === 'object' ? record.failure : record;
  return {
    classification: isInfrastructureTestFailure(failure) ? 'infrastructure' : 'operator',
    code: factsText(failure.code),
    message: factsText(failure.message) || factsText(record.decisionReason),
    source: 'failureRecords',
  };
};

const roundGateFacts = (gate) => {
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return null;
  if (!Object.hasOwn(gate, 'passed') && !factsText(gate.result) && !factsText(gate.summary)) return null;
  return {
    passed: factsBoolean(gate.passed),
    result: factsText(gate.result),
    publishable: factsBoolean(gate.publishable),
    evidenceSource: factsText(gate.evidenceSource),
    failedRules: Array.isArray(gate.failedRules) ? gate.failedRules.map(factsText).filter(Boolean) : [],
    passedRules: Array.isArray(gate.passedRules) ? gate.passedRules.map(factsText).filter(Boolean) : [],
    evaluatedRules: factsNumber(gate.evaluatedRules),
    summary: factsText(gate.summary),
  };
};

const roundDecisionFacts = (decisionReview) => {
  if (!decisionReview || typeof decisionReview !== 'object' || Array.isArray(decisionReview)) return null;
  const resolution = decisionReview.resolution && typeof decisionReview.resolution === 'object' ? decisionReview.resolution : null;
  if (!decisionReview.status && !resolution && !decisionReview.gate) return null;
  return {
    status: factsText(decisionReview.status),
    recommendation: factsText(decisionReview.recommendation),
    candidateId: factsText(decisionReview.candidateId),
    outcome: factsText(resolution?.outcome),
    source: factsText(resolution?.source),
    note: factsText(resolution?.note),
    resolvedAt: factsText(resolution?.resolvedAt) || factsText(decisionReview.resolvedAt),
    gateEvaluatedAt: factsText(decisionReview.gateEvaluatedAt),
  };
};

// 回滚状态只报告真实执行过的恢复。工作区未被恢复时不得声称 clean：要么明确
// 记录 unknown（拒绝了却没有回滚记录），要么 not_performed（本轮无需回滚）。
const roundRollbackFacts = (workflowRecovery, decisionReview, candidateId, candidateDigest) => {
  const recovery = workflowRecovery?.lastRecovery;
  const checkpoints = Array.isArray(workflowRecovery?.checkpoints) ? workflowRecovery.checkpoints : [];
  const checkpoint = checkpoints.find((item) => item?.id === recovery?.checkpointId) || null;
  const stableDigest = factsText(recovery?.stableDigest) || factsText(checkpoint?.stableDigest);
  const conflict = (candidateId && recovery?.candidateId && candidateId !== recovery.candidateId)
    || (candidateDigest && recovery?.candidateDigest && candidateDigest !== recovery.candidateDigest)
    || (recovery?.stableDigest && checkpoint?.stableDigest && recovery.stableDigest !== checkpoint.stableDigest);
  if (recovery?.type === 'round_rollback' && !conflict && factsText(recovery.checkpointId)
    && stableDigest && recovery.workspaceClean === true && factsText(recovery.restoredAt)) {
    return {
      performed: true,
      status: 'performed',
      checkpointId: factsText(recovery.checkpointId),
      stableDigest,
      workspaceClean: recovery.workspaceClean === true,
      restoredAt: factsText(recovery.restoredAt),
      candidateId: factsText(recovery.candidateId),
      candidateDigest: factsText(recovery.candidateDigest),
    };
  }
  const rejected = decisionReview?.gate?.passed === false || decisionReview?.resolution?.outcome === 'reject';
  return {
    performed: false,
    status: rejected || recovery ? 'unknown' : 'not_performed',
    checkpointId: null,
    stableDigest: null,
    workspaceClean: null,
    restoredAt: null,
    reason: conflict ? 'Recovery record conflicts with the archived candidate or checkpoint.' : rejected
      ? 'Round was rejected but no rollback record was observed for this run.'
      : 'No completed rollback was observed for this run.',
  };
};

const roundCurrentBestFacts = (state) => {
  const best = state.currentBest;
  if (!best || typeof best !== 'object' || Array.isArray(best)) return null;
  const candidateId = factsText(best.candidateId);
  const candidate = (state.candidateEvaluations || []).find((item) => item?.id === candidateId) || null;
  const asset = candidateId ? (state.publishedAssets || []).find((item) => item?.sourceCandidate === candidateId) || null : null;
  return {
    candidateId,
    version: factsText(best.version),
    value: best.value ?? null,
    improvement: best.improvement ?? null,
    status: factsText(best.status),
    candidateStatus: factsText(candidate?.status),
    candidateClassification: factsText(candidate?.classification),
    candidateDecision: factsText(candidate?.decision),
    assetStatus: factsText(asset?.status),
    assetVersion: factsText(asset?.version),
  };
};

const roundCandidateFacts = ({ candidate, failureRecord, candidateId, candidateDigest, generationPath, degraded, degradationReason, sourceRunId }) => {
  const id = factsText(candidateId);
  const digest = factsText(candidateDigest);
  const title = factsText(candidate?.title) || factsText(failureRecord?.title);
  const direction = factsText(candidate?.change) || factsText(candidate?.hypothesis)
    || factsText(failureRecord?.change) || factsText(failureRecord?.hypothesis);
  const files = factsFiles(candidate?.files);
  if (!id && !digest && !title) return null;
  return {
    id,
    digest,
    title: title || null,
    direction: direction || null,
    files: files.length ? files : factsFiles(failureRecord?.files),
    generationPath: factsText(generationPath),
    degraded: degraded === true,
    degradationReason: factsText(degradationReason),
    sourceRunId: factsText(sourceRunId),
  };
};

// 供 Agent Runtime 投影用：只有当快照绑定的是当前 Mission 且是当前 Round 时才返回，
// 否则返回 null。快照是深拷贝，后续状态变化不会回写旧事实。
export const selectRoundFactsForPrompt = (state, mission) => {
  const facts = state?.iterationStats?.roundFacts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
  if (facts.schemaVersion !== ROUND_FACTS_SCHEMA_VERSION) return null;
  const missionId = factsText(mission?.id);
  if (!missionId || factsText(facts.target?.missionId) !== missionId) return null;
  if (factsText(facts.previous?.missionId) !== missionId) return null;
  const currentRoundId = factsText(state?.iterationStats?.roundBudget?.roundId);
  if (!currentRoundId || factsText(facts.target?.roundId) !== currentRoundId) return null;
  const factsProjectId = factsText(facts.target?.projectId);
  const missionProjectId = factsText(mission?.projectId);
  if (factsProjectId && missionProjectId && factsProjectId !== missionProjectId) return null;
  if (facts.previous?.projectId && missionProjectId && facts.previous.projectId !== missionProjectId) return null;
  return structuredClone(facts);
};

export const createMissionProjectState = ({ rootDir, workspaceDir, workspaceDirForMission, missionSourceDirFor } = {}) => {
  if (typeof rootDir !== 'string' || typeof workspaceDir !== 'string' || typeof workspaceDirForMission !== 'function' || typeof missionSourceDirFor !== 'function') {
    throw new TypeError('Mission/Project state requires root paths and workspace/source path query ports.');
  }

  const createProjectRecord = (repository, overrides = {}) => ({
    id: overrides.id || projectIdForRepository(repository),
    name: overrides.name || projectNameForRepository(repository),
    repository: String(repository || '').trim(),
    root: overrides.root || (path.isAbsolute(repository) ? repository : null),
    sourceRoot: overrides.sourceRoot || (path.isAbsolute(repository) ? path.join(repository, '.operator-studio', 'sources') : null),
    runtimeRoot: overrides.runtimeRoot || (path.isAbsolute(repository) ? path.join(repository, '.operator-studio') : null),
    layout: overrides.layout || 'legacy-compatible',
    defaultBranch: overrides.defaultBranch || 'HEAD',
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  });

  const ensureProjects = (state) => {
    const existing = Array.isArray(state.projects) ? state.projects : [];
    const byRepository = new Map(existing.map((project) => [project.repository, project]));
    for (const mission of state.missions || []) {
      if (!byRepository.has(mission.repository)) byRepository.set(mission.repository, createProjectRecord(mission.repository));
    }
    state.projects = [...byRepository.values()];
    for (const mission of state.missions || []) {
      const project = state.projects.find((item) => item.id === mission.projectId) || state.projects.find((item) => item.repository === mission.repository);
      if (project) mission.projectId = project.id;
    }
    if (!state.activeProjectId || !state.projects.some((project) => project.id === state.activeProjectId)) {
      state.activeProjectId = state.missions?.find((mission) => mission.id === state.activeMissionId)?.projectId || state.projects[0]?.id || null;
    }
    return state;
  };

  const createWorkflowRecoveryState = (missionId = '', repository = '', projectRoot = '') => ({
    worktree: {
      id: missionId ? `workspace.${missionId}` : 'workspace.unassigned',
      candidateId: null,
      path: path.relative(rootDir, missionId ? workspaceDirForMission(missionId, repository, projectRoot) : workspaceDir).replaceAll('\\', '/'),
      status: 'clean',
    },
    checkpoints: [],
    lastRecovery: null,
    invalidatedArtifacts: [],
  });

  const createMissionDomainState = (missionId, stage = 'diagnosis') => {
    const published = stage === 'published';
    const state = {
      baseline: createBaselineRequirementState(),
      testMatrix: normalizeMissionTestMatrix({ environments: ['C550', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] }),
      tokenUsage: emptyTokenUsage(),
      runtimeEvents: [],
      knowledgeDrafts: structuredClone(knowledgeDrafts),
      candidateEvaluations: structuredClone(candidateEvaluations),
      failureRecords: structuredClone(failureRecords),
      publishedAssets: [],
      knowledgeMaintenance: createKnowledgeMaintenanceState(published ? 'completed' : 'idle'),
      decisionReview: createDecisionReviewState(published ? 'resolved' : 'idle'),
      workflowRecovery: createWorkflowRecoveryState(missionId),
      currentBest: createCurrentBestState(published ? 'candidate-02' : 'candidate-01'),
      knowledgeReferences: [],
      auditEvents: [],
      runHistory: [],
      missionPaused: false,
      objective: normalizeMissionObjective(),
      missionBudgetMs: null,
      missionBudgetStartedAt: null,
      researchNotes: [],
      researchAgent: createResearchAgentState(),
      iterationStats: createIterationStats(),
    };
    if (published) {
      markCandidateAccepted(state, '历史 Mission 已完成采用。', 'policy');
      state.publishedAssets = state.knowledgeDrafts.map((draft) => toPublishedKnowledgeAsset(draft, 'v1.0'));
    }
    return state;
  };

  function normalizeMissionState(state) {
    ensureProjects(state);
    if (!Array.isArray(state.missions) || !state.missions.length) {
      const fallback = { id: state.agent?.missionId || 'MIS_01JH7R', title: 'MLA Paged KV Cache', goal: state.agent?.goal || '优化 MLA Paged KV Cache 在 C550 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C550', 'CUDA'], metric: 'latency p50', stage: state.stage || 'diagnosis', status: state.agent?.status || 'ready', updatedLabel: '刚刚', result: { value: '41.8 μs', improvement: '−22.3%' }, patchApplied: Boolean(state.patchApplied), benchmark: structuredClone(state.benchmark || {}), agent: structuredClone(state.agent || createIdleAgent()) };
      state.missions = [fallback];
      state.activeMissionId = fallback.id;
    }
    if (!state.activeMissionId || !state.missions.some((mission) => mission.id === state.activeMissionId)) state.activeMissionId = state.missions[0].id;
    const activeMission = state.missions.find((mission) => mission.id === state.activeMissionId);
    const staleConnectionProbe = /OPERATOR_STUDIO_CODEX_OK|只读验证.*Codex|Connect an Agent and define an operator optimization goal/i.test(`${activeMission?.goal || ''} ${state.agent?.goal || ''}`);
    if (staleConnectionProbe && !state.missions.some((mission) => mission.id === 'MIS_REAL_MLA')) {
      const missionId = 'MIS_REAL_MLA';
      const domain = createMissionDomainState(missionId, 'diagnosis');
      const realMission = {
        id: missionId,
        ...domain,
        title: 'MLA Paged KV Cache / C550 P50 优化',
        goal: MLA_OPTIMIZATION_TEST_GOAL,
        repository: 'mla-kernels',
        hardware: ['C550', 'CUDA'],
        metric: 'latency p50',
        stage: 'diagnosis',
        status: 'ready',
        updatedLabel: '刚刚',
        result: { value: '--', improvement: 'new' },
        patchApplied: false,
        benchmark: { status: 'idle', progress: 0, runId: null, testTaskId: null, startedAt: null, completedAt: null, durationMs: 0, logs: [], result: null },
        knowledgeDrafts: [], candidateEvaluations: [], failureRecords: [], publishedAssets: [], knowledgeReferences: [],
        currentBest: { candidateId: null, version: null, value: '--', improvement: '--', status: 'empty' },
        runtimeEvents: [], auditEvents: [], runHistory: [],
        agent: createIdleAgent(missionId, MLA_OPTIMIZATION_TEST_GOAL),
      };
      state.missions = [realMission, ...state.missions];
      state.activeMissionId = missionId;
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.agent = structuredClone(realMission.agent);
      state.benchmark = structuredClone(realMission.benchmark);
      state.candidateEvaluations = [];
      state.failureRecords = [];
      state.knowledgeDrafts = [];
      state.publishedAssets = [];
      state.currentBest = structuredClone(realMission.currentBest);
    }
    if (!Array.isArray(state.agentProfiles)) state.agentProfiles = structuredClone(agentProfiles);
    if (!state.capabilityRegistry) state.capabilityRegistry = structuredClone(capabilityRegistry);
    if (!Array.isArray(state.runtimeEvents)) state.runtimeEvents = [];
    if (!state.testMatrix?.environments?.length || !state.testMatrix?.stages?.length) state.testMatrix = { environments: ['C550', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] };
    state.testMatrix = normalizeMissionTestMatrix(state.testMatrix);
    state.tokenUsage = normalizeTokenUsageLedger(state.tokenUsage);
    if (!Array.isArray(state.agent?.toolCalls)) state.agent = { ...state.agent, toolCalls: [] };
    const seedDrafts = new Map(knowledgeDrafts.map((draft) => [draft.id, draft]));
    state.knowledgeDrafts = Array.isArray(state.knowledgeDrafts)
      ? state.knowledgeDrafts.map((draft) => ({ ...(seedDrafts.get(draft.id) || {}), ...draft }))
      : structuredClone(knowledgeDrafts);
    if (!Array.isArray(state.publishedAssets)) state.publishedAssets = [];
    if (!Array.isArray(state.candidateEvaluations)) state.candidateEvaluations = structuredClone(candidateEvaluations);
    if (!Array.isArray(state.failureRecords)) state.failureRecords = structuredClone(failureRecords);
    if (!state.knowledgeMaintenance?.policy) {
      const maintenanceStatus = state.stage === 'curation' ? 'ready' : (state.stage === 'published' && state.publishedAssets.length ? 'completed' : 'idle');
      state.knowledgeMaintenance = createKnowledgeMaintenanceState(maintenanceStatus);
    }
    if (!Array.isArray(state.knowledgeReferences)) state.knowledgeReferences = [];
    if (!Array.isArray(state.runHistory)) state.runHistory = [];
    if (typeof state.missionPaused !== 'boolean') state.missionPaused = false;
    if (!Array.isArray(state.researchNotes)) state.researchNotes = [];
    if (!state.researchAgent) state.researchAgent = createResearchAgentState();
    state.iterationStats = { ...createIterationStats(), ...(state.iterationStats || {}) };
    if (!state.decisionReview?.policy) {
      const reviewStatus = state.stage === 'evidence' ? 'auto_ready' : (['curation', 'published'].includes(state.stage) ? 'resolved' : 'idle');
      state.decisionReview = createDecisionReviewState(reviewStatus);
    }
    const activeMissionRecord = state.missions.find((mission) => mission.id === state.activeMissionId);
    state.objective = normalizeMissionObjective(state.objective || activeMissionRecord?.objective || {}, activeMissionRecord || {});
    const missionBudgetMsInput = Object.hasOwn(state, 'missionBudgetMs') ? state.missionBudgetMs : activeMissionRecord?.missionBudgetMs ?? null;
    const missionBudgetStartedAtInput = Object.hasOwn(state, 'missionBudgetStartedAt') ? state.missionBudgetStartedAt : activeMissionRecord?.missionBudgetStartedAt ?? null;
    state.missionBudgetMs = normalizeMissionBudgetMs(missionBudgetMsInput);
    state.missionBudgetStartedAt = missionBudgetStartedAtInput ?? null;
    const expectedWorkspacePath = path.relative(rootDir, workspaceDirForMission(state.activeMissionId, activeMissionRecord?.repository, activeMissionRecord?.projectRoot)).replaceAll('\\', '/');
    if (!state.workflowRecovery?.worktree) state.workflowRecovery = createWorkflowRecoveryState(state.activeMissionId, activeMissionRecord?.repository, activeMissionRecord?.projectRoot);
    else state.workflowRecovery.worktree.path = expectedWorkspacePath;
    if (!state.baseline) state.baseline = structuredClone(activeMissionRecord?.baseline || createBaselineRequirementState());
    state.baseline = createBaselineRequirementState(state.baseline);
    if (!state.currentBest || !Object.hasOwn(state.currentBest, 'candidateId')) state.currentBest = createCurrentBestState(state.stage === 'published' ? 'candidate-02' : 'candidate-01');
    state.missions = state.missions.map((mission) => {
      const defaults = createMissionDomainState(mission.id, mission.stage || 'diagnosis');
      const next = {
        ...defaults,
        ...mission,
        implementation: normalizeOperatorLanguage(mission.implementation),
        testMatrix: normalizeMissionTestMatrix(mission.testMatrix || defaults.testMatrix),
        tokenUsage: normalizeTokenUsageLedger(mission.tokenUsage),
        objective: normalizeMissionObjective(mission.objective || defaults.objective, mission),
        semanticSnapshot: mission.semanticSnapshot
          ? normalizeSemanticSnapshot({ snapshot: mission.semanticSnapshot, mission })
          : createSemanticSnapshot({ mission: { ...mission, testMatrix: normalizeMissionTestMatrix(mission.testMatrix || defaults.testMatrix) }, semanticDraft: mission.semanticDraft || {} }),
      };
      if (mission.id !== state.activeMissionId) return next;
      return {
        ...next,
        objective: structuredClone(state.objective),
        baseline: structuredClone(createBaselineRequirementState(state.baseline || next.baseline || createBaselineRequirementState())),
        testMatrix: structuredClone(state.testMatrix),
        tokenUsage: structuredClone(state.tokenUsage),
        decisionReview: structuredClone(state.decisionReview),
        workflowRecovery: structuredClone(state.workflowRecovery),
        currentBest: structuredClone(state.currentBest),
        knowledgeDrafts: structuredClone(state.knowledgeDrafts),
        candidateEvaluations: structuredClone(state.candidateEvaluations),
        failureRecords: structuredClone(state.failureRecords),
        publishedAssets: structuredClone(state.publishedAssets),
        knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
        knowledgeReferences: structuredClone(state.knowledgeReferences),
        runtimeEvents: structuredClone(state.runtimeEvents),
        auditEvents: structuredClone(state.auditEvents || []),
        runHistory: structuredClone(state.runHistory || []),
        missionPaused: Boolean(state.missionPaused),
        missionBudgetMs: normalizeMissionBudgetMs(state.missionBudgetMs),
        missionBudgetStartedAt: state.missionBudgetStartedAt ?? null,
        researchNotes: structuredClone(state.researchNotes || []),
        researchAgent: structuredClone(state.researchAgent || createResearchAgentState()),
        iterationStats: structuredClone(state.iterationStats || createIterationStats()),
      };
    });
    ensureProjects(state);
    return state;
  }

  function projectActiveMission(state) {
    if (!Array.isArray(state.missions)) return state;
    const index = state.missions.findIndex((mission) => mission.id === state.activeMissionId);
    if (index === -1) return state;
    if (!state.agent) state.agent = createIdleAgent(state.activeMissionId, state.agent?.goal || state.missions[index]?.goal);
    if (state.stage === 'candidate'
      && !state.patchApplied
      && !state.agent.currentAction
      && Array.isArray(state.candidateEvaluations)
      && state.candidateEvaluations.length > 0) {
      const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId || state.candidateEvaluations[0]?.id || 'candidate-01';
      state.agent = {
        ...state.agent,
        status: state.agent.status === 'idle' ? 'awaiting_action' : state.agent.status,
        phase: 'Candidate Plan 已生成',
        currentAction: {
          id: `action.${candidateId}.resume`,
          type: 'candidate.plan',
          title: `提交 ${candidateId} 测试`,
          reason: '候选已在 Mission 工作区形成，恢复后可继续真实 runner 验证。',
          expectedOutput: 'Correctness · Benchmark · Tracer · Profiler',
          risk: 'medium',
          approvalRequired: false,
          approvalPolicy: 'client-controlled',
        },
      };
    }
    const deriveMissionStatus = () => {
      if (state.iterationStats?.loopStatus === 'failed' || state.agent?.status === 'failed') return 'failed';
      if (state.agent?.status === 'awaiting_approval') return 'awaiting_approval';
      if (['running', 'executing', 'cancel_requested'].includes(state.agent?.status)) return 'running';
      if (state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed') return 'completed';
      return 'ready';
    };
    state.missions[index] = {
      ...state.missions[index],
      stage: state.stage,
      status: deriveMissionStatus(),
      patchApplied: state.patchApplied,
      benchmark: structuredClone(state.benchmark),
      baseline: structuredClone(state.baseline || state.missions[index].baseline || createBaselineRequirementState()),
      testMatrix: structuredClone(state.testMatrix),
      tokenUsage: structuredClone(state.tokenUsage || emptyTokenUsage()),
      decisionReview: structuredClone(state.decisionReview),
      workflowRecovery: structuredClone(state.workflowRecovery),
      currentBest: structuredClone(state.currentBest),
      knowledgeDrafts: structuredClone(state.knowledgeDrafts),
      candidateEvaluations: structuredClone(state.candidateEvaluations),
      failureRecords: structuredClone(state.failureRecords),
      publishedAssets: structuredClone(state.publishedAssets),
      knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
      knowledgeReferences: structuredClone(state.knowledgeReferences),
      runtimeEvents: structuredClone(state.runtimeEvents),
      workflowFailure: structuredClone(state.workflowFailure || state.missions[index].workflowFailure || null),
      auditEvents: structuredClone(state.auditEvents),
      runHistory: structuredClone(state.runHistory || []),
      missionPaused: Boolean(state.missionPaused),
      objective: structuredClone(state.objective || normalizeMissionObjective(state.missions[index].objective, state.missions[index])),
      missionBudgetMs: normalizeMissionBudgetMs(state.missionBudgetMs),
      missionBudgetStartedAt: state.missionBudgetStartedAt ?? null,
      researchNotes: structuredClone(state.researchNotes || []),
      researchAgent: structuredClone(state.researchAgent || createResearchAgentState()),
      iterationStats: structuredClone(state.iterationStats || createIterationStats()),
      agent: structuredClone(state.agent),
      updatedLabel: '刚刚',
    };
    return state;
  }

  function selectMission(state, missionId) {
    if (missionId !== state.activeMissionId) assertResourcesReleased(state);
    projectActiveMission(state);
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission) {
      const error = new Error('Mission 不存在。');
      error.status = 404;
      throw error;
    }
    const defaults = createMissionDomainState(mission.id, mission.stage || 'diagnosis');
    state.activeMissionId = mission.id;
    state.activeProjectId = mission.projectId || state.projects?.find((project) => project.repository === mission.repository)?.id || state.activeProjectId;
    state.stage = mission.stage || 'diagnosis';
    state.patchApplied = Boolean(mission.patchApplied);
    state.benchmark = structuredClone(mission.benchmark || { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] });
    state.baseline = createBaselineRequirementState(mission.baseline || defaults.baseline || createBaselineRequirementState());
    state.objective = normalizeMissionObjective(mission.objective || defaults.objective, mission);
    state.testMatrix = structuredClone(mission.testMatrix || defaults.testMatrix);
    state.tokenUsage = structuredClone(mission.tokenUsage || defaults.tokenUsage || emptyTokenUsage());
    state.decisionReview = structuredClone(mission.decisionReview || defaults.decisionReview);
    state.workflowRecovery = structuredClone(mission.workflowRecovery || defaults.workflowRecovery);
    state.currentBest = structuredClone(mission.currentBest || defaults.currentBest);
    state.knowledgeDrafts = structuredClone(mission.knowledgeDrafts || defaults.knowledgeDrafts);
    state.candidateEvaluations = structuredClone(mission.candidateEvaluations || defaults.candidateEvaluations);
    state.failureRecords = structuredClone(mission.failureRecords || defaults.failureRecords);
    state.publishedAssets = structuredClone(mission.publishedAssets || defaults.publishedAssets);
    state.knowledgeMaintenance = structuredClone(mission.knowledgeMaintenance || defaults.knowledgeMaintenance);
    state.knowledgeReferences = structuredClone(mission.knowledgeReferences || defaults.knowledgeReferences);
    state.runtimeEvents = structuredClone(mission.runtimeEvents || defaults.runtimeEvents);
    state.workflowFailure = structuredClone(mission.workflowFailure || null);
    state.auditEvents = structuredClone(mission.auditEvents || defaults.auditEvents);
    state.runHistory = structuredClone(mission.runHistory || defaults.runHistory);
    state.missionPaused = Boolean(mission.missionPaused ?? false);
    state.missionBudgetMs = normalizeMissionBudgetMs(mission.missionBudgetMs);
    state.missionBudgetStartedAt = mission.missionBudgetStartedAt ?? null;
    state.researchNotes = structuredClone(mission.researchNotes || defaults.researchNotes || []);
    state.researchAgent = structuredClone(mission.researchAgent || defaults.researchAgent || createResearchAgentState());
    state.iterationStats = structuredClone(mission.iterationStats || defaults.iterationStats || createIterationStats());
    state.agent = structuredClone(mission.agent || createIdleAgent(mission.id, mission.goal));
    addAuditEvent(state, 'Mission 已切换', `${mission.id} · ${mission.title}`, 'blue', 'GitBranch');
    return state;
  }

  function resumeMissionState(state, { source = 'client' } = {}) {
    assertResourcesReleased(state);
    const previousLoopStatus = state.iterationStats?.loopStatus || null;
    const wasPaused = state.missionPaused === true;
    const resumableLoop = ['stopped', 'needs_human'].includes(previousLoopStatus);
    state.missionPaused = false;
    if (resumableLoop) {
      state.iterationStats = {
        ...(state.iterationStats || {}),
        loopStatus: 'running',
        loopStatusReason: null,
        stoppedAt: null,
      };
    }
    const activeMission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (activeMission && (wasPaused || resumableLoop) && !['completed', 'published', 'archived'].includes(activeMission.status)) {
      activeMission.status = 'running';
      activeMission.missionPaused = false;
      activeMission.iterationStats = structuredClone(state.iterationStats || activeMission.iterationStats || {});
    }
    if (wasPaused || resumableLoop) {
      appendRuntimeEvent(state, 'mission.resumed', {
        missionId: state.activeMissionId,
        source,
        previousLoopStatus,
      }, { kind: 'mission', mode: 'client' });
    }
    return { state, resumed: wasPaused || resumableLoop, previousLoopStatus };
  }

  function selectProject(state, projectId) {
    if (projectId !== state.activeProjectId) assertResourcesReleased(state);
    projectActiveMission(state);
    const project = state.projects?.find((item) => item.id === projectId);
    if (!project) { const error = new Error('项目不存在。'); error.status = 404; throw error; }
    state.activeProjectId = project.id;
    const linkedMissions = state.missions.filter((mission) => mission.projectId === project.id || mission.repository === project.repository);
    const selectedMission = linkedMissions.find((mission) => mission.status === 'running')
      || linkedMissions.find((mission) => mission.status !== 'completed')
      || linkedMissions[0]
      || null;
    if (selectedMission) selectMission(state, selectedMission.id);
    else addAuditEvent(state, '项目已切换', `${project.name} · 尚未创建 Mission`, 'blue', 'FolderGit2');
    return { project, selectedMission };
  }

  function createMission(state, input) {
    assertResourcesReleased(state);
    projectActiveMission(state);
    const id = `MIS_${Date.now().toString(36).toUpperCase()}`;
    const title = input.title?.trim() || input.goal.trim().slice(0, 30);
    const hardware = Array.isArray(input.hardware) && input.hardware.length ? input.hardware : ['C550'];
    const project = state.projects?.find((item) => item.id === input.projectId) || state.projects?.find((item) => item.repository === input.repository);
    const repository = project?.repository || input.repository?.trim() || 'mla-kernels';
    const sourcePolicy = input.sourcePolicy ? structuredClone(input.sourcePolicy) : null;
    const strictMissionWorkspace = sourcePolicy?.strictZeroSource === true || sourcePolicy?.mode === 'agent-research-only';
    const sourceRoot = strictMissionWorkspace
      ? missionSourceDirFor(id, repository, project?.root || input.projectRoot || '')
      : project?.sourceRoot || input.sourceRoot || null;
    const mission = {
      id,
      ...createMissionDomainState(id, 'diagnosis'),
      title,
      goal: input.goal.trim(),
      projectId: project?.id || projectIdForRepository(repository),
      repository,
      projectRoot: project?.root || input.projectRoot || null,
      sourceRoot,
      runtimeRoot: project?.runtimeRoot || input.runtimeRoot || null,
      hardware,
      metric: input.metric?.trim() || 'latency p50',
      implementation: normalizeOperatorLanguage(input.implementation),
      operator: String(input.operatorProfile?.operator || input.operator || '').trim() || null,
      operatorProfile: input.operatorProfile ? structuredClone(input.operatorProfile) : null,
      testMatrix: normalizeMissionTestMatrix({ environments: hardware, ...(input.testMatrix || {}) }),
      sourcePolicy,
      testScenario: input.testScenario ? structuredClone(input.testScenario) : null,
      objective: normalizeMissionObjective(input.objective || {}, { ...input, metric: input.metric?.trim() || 'latency p50' }),
      missionBudgetMs: normalizeMissionBudgetMs(input),
      missionBudgetStartedAt: null,
      stage: 'diagnosis',
      status: 'ready',
      updatedLabel: '刚刚',
      result: { value: '—', improvement: 'new' },
      patchApplied: false,
      benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] },
      baseline: createBaselineRequirementState(input.baseline || {}),
      knowledgeDrafts: [],
      candidateEvaluations: [],
      failureRecords: [],
      publishedAssets: [],
      knowledgeReferences: [],
      currentBest: { candidateId: null, version: null, value: '--', improvement: '--', status: 'empty' },
      agent: createIdleAgent(id, input.goal.trim()),
    };
    mission.semanticSnapshot = createSemanticSnapshot({ mission, semanticDraft: input.semanticDraft || {}, snapshot: input.semanticSnapshot || null });
    mission.workflowRecovery = createWorkflowRecoveryState(id, repository, mission.projectRoot);
    state.missions = [mission, ...state.missions];
    if (!state.projects?.some((item) => item.id === mission.projectId)) state.projects = [createProjectRecord(repository, { id: mission.projectId }), ...(state.projects || [])];
    state.activeProjectId = mission.projectId;
    return selectMission(state, id);
  }

  function createProject(state, input) {
    const repository = String(input.repository || '').trim();
    if (!repository) { const error = new Error('请选择或输入本地 Git 仓库路径。'); error.status = 400; throw error; }
    if (state.projects?.some((project) => project.repository.toLowerCase() === repository.toLowerCase())) { const error = new Error('该仓库已经登记为项目。'); error.status = 409; throw error; }
    const project = createProjectRecord(repository, {
      name: String(input.name || '').trim() || projectNameForRepository(input.root || repository),
      defaultBranch: String(input.defaultBranch || '').trim() || 'HEAD',
      root: input.root || null,
      sourceRoot: input.sourceRoot || null,
      runtimeRoot: input.runtimeRoot || null,
      layout: input.layout || 'legacy-compatible',
    });
    state.projects = [project, ...(state.projects || [])];
    state.activeProjectId = project.id;
    return project;
  }

  function updateProject(state, projectId, input) {
    const project = state.projects?.find((item) => item.id === projectId);
    if (!project) { const error = new Error('项目不存在。'); error.status = 404; throw error; }
    if (input.repository && input.repository !== project.repository && state.missions.some((mission) => mission.projectId === projectId)) { const error = new Error('项目已有 Mission，不能直接更换仓库路径；请新建项目。'); error.status = 409; throw error; }
    if (input.name !== undefined) project.name = String(input.name).trim() || project.name;
    if (input.defaultBranch !== undefined) project.defaultBranch = String(input.defaultBranch).trim() || 'HEAD';
    if (input.status !== undefined) {
      if (!['active', 'archived'].includes(input.status)) { const error = new Error('项目状态无效。'); error.status = 400; throw error; }
      const running = state.missions.some((mission) => mission.projectId === projectId && mission.status === 'running');
      if (input.status === 'archived' && running) { const error = new Error('项目仍有运行中的 Mission，不能归档。'); error.status = 409; throw error; }
      project.status = input.status;
    }
    project.updatedAt = new Date().toISOString();
    return project;
  }

  function deleteProject(state, projectId) {
    const project = state.projects?.find((item) => item.id === projectId);
    if (!project) { const error = new Error('项目不存在。'); error.status = 404; throw error; }
    const linked = state.missions.filter((mission) => mission.projectId === projectId);
    if (linked.length) { const error = new Error(`项目仍关联 ${linked.length} 个 Mission，请先保留为归档项目。`); error.status = 409; throw error; }
    state.projects = state.projects.filter((item) => item.id !== projectId);
    if (state.activeProjectId === projectId) state.activeProjectId = state.projects.find((item) => item.status === 'active')?.id || state.projects[0]?.id || null;
    return project;
  }

  function resetMissionRunState(state, goal, { referenceFixture = false } = {}) {
    assertResourcesReleased(state);
    if (state.agent?.runId) {
      const historyCandidateId = state.appliedCandidateId || state.decisionReview?.candidateId || state.benchmark?.candidate?.id || null;
      const historyCandidate = (state.candidateEvaluations || []).find((candidate) => candidate.id === historyCandidateId)
        || (state.candidateEvaluations || []).find((candidate) => candidate.patchDigest && candidate.patchDigest === state.benchmark?.candidate?.digest)
        || null;
      const candidateDigest = state.benchmark?.candidate?.digest || historyCandidate?.patchDigest || null;
      const candidateSourceRunId = historyCandidate?.sourceRunId
        || (historyCandidateId && state.benchmark?.purpose === 'candidate' ? state.agent.runId : null);
      const failureRecord = findRoundFailureRecord(state, historyCandidateId);
      const candidateSummary = roundCandidateFacts({
        candidate: historyCandidate,
        failureRecord,
        candidateId: historyCandidateId,
        candidateDigest,
        generationPath: historyCandidate?.candidateGenerationPath,
        degraded: historyCandidate?.degraded,
        degradationReason: historyCandidate?.degradationReason,
        sourceRunId: candidateSourceRunId,
      });
      // 结构化事实只使用 run 启动时保存的 roundId。raw runHistory 的历史兼容字段
      // 仍可回退当前预算，但明确标记来源；该回退不是原 round 身份的证据。
      const sourceRoundId = factsText(state.agent.roundId);
      const budgetRoundId = factsText(state.iterationStats?.roundBudget?.roundId);
      const archivedEntry = {
        runId: state.agent.runId,
        threadId: state.agent.threadId || null,
        runtimeKind: state.agent.runtimeKind || null,
        goal: state.agent.goal,
        stage: state.stage,
        // 归属字段：这一轮属于哪个 Round、哪个队列请求，必须随归档一起留下。
        // 结算投影迟到时，恢复 run 的归属不能被写成首次失败的 runId。
        roundId: sourceRoundId || budgetRoundId || null,
        sourceRoundId,
        roundIdSource: sourceRoundId ? 'run' : budgetRoundId ? 'roundBudget' : 'unknown',
        queueRequestId: state.benchmark?.runId || null,
        candidateId: historyCandidateId,
        candidateDigest,
        candidateSourceRunId,
        candidateGenerationPath: historyCandidate?.candidateGenerationPath || null,
        degraded: historyCandidate?.degraded === true,
        degradationReason: historyCandidate?.degradationReason || null,
        // 编辑工具的失败与缺失是两件事，归档必须带着这个事实标记，否则验收报告看不出生成路径为什么降级。
        editToolStatus: historyCandidate?.editToolStatus || null,
        promptAudit: structuredClone(state.agent.promptAudit || null),
        candidateSummary,
        benchmark: structuredClone(state.benchmark),
        decisionReview: structuredClone(state.decisionReview),
        currentBest: structuredClone(state.currentBest),
        publishedAssets: structuredClone(state.publishedAssets),
        knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
        completedAt: state.benchmark?.completedAt || state.decisionReview?.resolvedAt || null,
      };
      // 同一个 runId 只允许有一条归档记录。无条件前插会产生两条相同的 runHistory[0]，
      // 而 finalizeCandidateAdmission 正是读 runHistory 的 digest 做重复拒绝——重复条目
      // 会污染该输入。就地替换保持时序位置，新一轮仍排在最前。
      const archivedHistory = state.runHistory || [];
      const archivedIndex = archivedHistory.findIndex((round) => round?.runId === archivedEntry.runId);
      const sourceMissionId = archivedHistory[archivedIndex]?.roundFacts?.previous?.missionId
        || state.agent.missionId || state.activeMissionId || null;
      const sourceProjectId = state.missions?.find((item) => item.id === sourceMissionId)?.projectId || null;
      const priorFacts = [archivedHistory[archivedIndex]?.roundFacts, state.iterationStats?.roundFacts]
        .find((facts) => facts?.schemaVersion === ROUND_FACTS_SCHEMA_VERSION
          && facts.previous?.runId === state.agent.runId && facts.previous?.missionId === sourceMissionId);
      state.runHistory = (archivedIndex >= 0
        ? archivedHistory.map((round, index) => (index === archivedIndex ? archivedEntry : round))
        : [archivedEntry, ...archivedHistory]
      ).slice(0, 20);
      const mission = state.missions?.find((item) => item.id === state.activeMissionId);
      // 轮次必需事实：与经验库预算完全独立，零命中/预算满都完整保留。目标 Round 与
      // 来源 run/round 分开记录；旧 run 缺 roundId 时只记 unknown，不拿当前预算补齐。
      state.iterationStats = {
        ...(state.iterationStats || {}),
        roundFacts: {
          schemaVersion: ROUND_FACTS_SCHEMA_VERSION,
          recordedAt: new Date().toISOString(),
          target: {
            missionId: state.activeMissionId || null,
            projectId: mission?.projectId || state.activeProjectId || null,
            roundId: budgetRoundId,
            roundNumber: factsNumber(state.iterationStats?.roundBudget?.roundNumber),
          },
          previous: {
            missionId: sourceMissionId,
            projectId: sourceProjectId,
            runId: state.agent.runId,
            roundId: sourceRoundId,
            roundIdSource: sourceRoundId ? 'run' : 'unknown',
            threadId: state.agent.threadId || null,
            runtimeKind: state.agent.runtimeKind || null,
            goal: factsText(state.agent.goal),
            stage: factsText(state.stage),
            completedAt: archivedEntry.completedAt,
            candidateId: historyCandidateId || null,
            candidateDigest: factsText(candidateDigest),
            queueRequestId: factsText(archivedEntry.queueRequestId),
            candidateSourceRunId: factsText(candidateSourceRunId),
          },
          candidate: candidateSummary,
          correctness: roundCorrectnessFacts(state.benchmark),
          failure: roundFailureFacts(state, historyCandidateId),
          gate: roundGateFacts(state.decisionReview?.gate || historyCandidate?.acceptGate),
          decision: roundDecisionFacts(state.decisionReview),
          rollback: roundRollbackFacts(state.workflowRecovery, state.decisionReview, historyCandidateId, candidateDigest),
          currentBest: roundCurrentBestFacts(state),
        },
      };
      // reset 保留 agent.runId；重放必须复用首次冻结的来源事实。只让投递目标跟随
      // 当前已准入 Round，历史归档中的快照保持首次写入内容且不与运行态共用引用。
      if (priorFacts) {
        state.iterationStats.roundFacts = { ...structuredClone(priorFacts), target: state.iterationStats.roundFacts.target };
      }
      archivedEntry.roundFacts = structuredClone(priorFacts || state.iterationStats.roundFacts);
    }
    state.stage = 'diagnosis';
    state.patchApplied = false;
    state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
    state.decisionReview = createDecisionReviewState('idle');
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    state.workflowRecovery = createWorkflowRecoveryState(state.activeMissionId, mission?.repository, mission?.projectRoot);
    state.currentBest = referenceFixture ? createCurrentBestState('candidate-01') : structuredClone(state.currentBest?.candidateId ? state.currentBest : { candidateId: null, version: null, value: '--', improvement: '--', status: 'empty' });
    state.knowledgeDrafts = referenceFixture ? structuredClone(knowledgeDrafts) : [];
    state.candidateEvaluations = referenceFixture ? structuredClone(candidateEvaluations) : [];
    state.failureRecords = referenceFixture ? structuredClone(state.failureRecords?.length ? state.failureRecords : failureRecords) : [];
    state.publishedAssets = referenceFixture ? [] : structuredClone(state.publishedAssets || []);
    state.knowledgeMaintenance = createKnowledgeMaintenanceState('idle');
    state.knowledgeReferences = [];
    state.agent = { ...(state.agent || {}), missionId: state.activeMissionId, goal: goal.trim() };
    return state;
  }

  function startAgentRun(state, goal, { reset = true } = {}) {
    assertResourcesReleased(state);
    if (reset) resetMissionRunState(state, goal, { referenceFixture: true });
    const runId = `agent_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
    state.agent = {
      status: 'running',
      phase: '上下文读取',
      progress: 0,
      missionId: state.agent?.missionId || 'MIS_01JH7R',
      runId,
      roundId: state.iterationStats?.roundBudget?.roundId || null,
      profileId: 'profile.operator-orchestrator',
      goal: goal.trim(),
      startedAt: new Date().toISOString(),
      durationMs: 7200,
      currentAction: null,
      toolCalls: [],
      messages: [{ id: `agent-start-${runId}`, phase: 'Mission', status: 'running', title: 'Orchestrator 已接管 Mission', detail: `Run ${runId} 已启动，正在建立 Context Snapshot。`, time: '刚刚' }],
      artifacts: [
        { id: 'artifact-context', kind: 'Context Snapshot', title: '正在读取仓库上下文', status: 'running', meta: 'repository · constraints · baseline' },
        { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: '等待知识检索', status: 'queued', meta: 'C550 · paged_attention · validated' },
      ],
    };
    addAuditEvent(state, 'Orchestrator 已启动 Agent Run', `${runId} · ${goal.trim()}`, 'blue', 'Activity');
    return state;
  }

  return Object.freeze({ createWorkflowRecoveryState, createMissionDomainState, normalizeMissionState, projectActiveMission, selectMission, resumeMissionState, selectProject, createMission, createProject, updateProject, deleteProject, resetMissionRunState, startAgentRun });
};
