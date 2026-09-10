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
      state.runHistory = [
        {
          runId: state.agent.runId,
          threadId: state.agent.threadId || null,
          runtimeKind: state.agent.runtimeKind || null,
          goal: state.agent.goal,
          stage: state.stage,
          candidateId: historyCandidateId,
          candidateDigest: state.benchmark?.candidate?.digest || historyCandidate?.patchDigest || null,
          candidateSourceRunId: historyCandidate?.sourceRunId
            || (historyCandidateId && state.benchmark?.purpose === 'candidate' ? state.agent.runId : null),
          benchmark: structuredClone(state.benchmark),
          decisionReview: structuredClone(state.decisionReview),
          currentBest: structuredClone(state.currentBest),
          publishedAssets: structuredClone(state.publishedAssets),
          knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
          completedAt: state.benchmark?.completedAt || state.decisionReview?.resolvedAt || null,
        },
        ...(state.runHistory || []),
      ].slice(0, 20);
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
