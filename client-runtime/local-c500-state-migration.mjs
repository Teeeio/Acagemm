const FLEXIBLE_SOURCE_POLICY_REVISION = 'local-c500-flexible-source-v1';
const MATERIALIZER_DELIVERY_REVISION = 'local-c500-materializer-file-v1';
const FIXED_ITERATION_POLICY_REVISION = 'local-c500-fixed-iteration-v2';
const FIXED_GENERATION_ATTEMPT_LIMIT = 3;
const TUI_FIXED_PROFILE_IDS = new Set([
  'paged-mqa-logits-triton-v01',
  'flash-mla-decode-triton-v01',
]);
const RECOVERABLE_SOURCE_BLOCKERS = new Set([
  'baseline_source_unresolved',
  'baseline_source_unverified',
]);
const TERMINAL_RESEARCH_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

const isManagedC500TesterMission = (mission = {}) => (
  mission.testScenario?.id === 'mla-three-round'
  && (mission.hardware || []).some((item) => String(item).toUpperCase() === 'C500')
);

const isTuiFixedProfileMission = (mission = {}) => TUI_FIXED_PROFILE_IDS.has(
  mission.testScenario?.id || mission.operatorProfile?.id,
);

const flexibleSourcePolicy = (current = {}) => ({
  ...(current || {}),
  mode: 'agent-flexible',
  strictZeroSource: true,
  localFirst: true,
  allowDiscoveredSources: true,
  allowSemanticFallback: true,
  revision: FLEXIBLE_SOURCE_POLICY_REVISION,
  materializerRevision: MATERIALIZER_DELIVERY_REVISION,
});

const recoveredResearchAgent = (current = {}) => ({
  ...current,
  status: 'idle',
  runPhase: 'acquire',
  phase: '等待重新调研',
  progress: 0,
  runId: null,
  threadId: null,
  startedAt: null,
  completedAt: null,
  acquireRunId: null,
  synthesizeRunId: null,
  acquireHandled: false,
  error: null,
  messages: [
    ...(current.messages || []),
    {
      id: `research-source-policy-recovery-${current.runId || 'legacy'}`,
      phase: 'research',
      status: 'ready',
      title: '来源策略已升级，准备重新调研',
      detail: '将按本地 Source、可访问网络来源、Mission 语义 fallback 的顺序重新执行。',
      time: '刚刚',
    },
  ].slice(-50),
});

export const migrateLocalC500TesterState = (state, { enabled = true } = {}) => {
  if (!enabled || !state?.activeMissionId || !Array.isArray(state.missions)) return { state, changed: false, recovery: null };
  const mission = state.missions.find((item) => item.id === state.activeMissionId);
  const managedC500Mission = isManagedC500TesterMission(mission);
  const fixedProfileMission = isTuiFixedProfileMission(mission);
  if (!mission || (!managedC500Mission && !fixedProfileMission)) return { state, changed: false, recovery: null };

  const previousPolicy = mission.sourcePolicy || {};
  const policyChanged = managedC500Mission && (previousPolicy.mode !== 'agent-flexible'
    || previousPolicy.localFirst !== true
    || previousPolicy.allowDiscoveredSources !== true
    || previousPolicy.allowSemanticFallback !== true
    || previousPolicy.revision !== FLEXIBLE_SOURCE_POLICY_REVISION
    || previousPolicy.materializerRevision !== MATERIALIZER_DELIVERY_REVISION);
  if (policyChanged) mission.sourcePolicy = flexibleSourcePolicy(previousPolicy);

  const previousGenerationLimit = Number(
    mission.testScenario?.iterationPolicy?.maxGenerationAttempts
      ?? mission.operatorProfile?.iterationPolicy?.maxGenerationAttempts
      ?? 0,
  );
  const iterationPolicyChanged = fixedProfileMission
    && (previousGenerationLimit !== FIXED_GENERATION_ATTEMPT_LIMIT
      || mission.testScenario?.iterationPolicy?.revision !== FIXED_ITERATION_POLICY_REVISION);
  if (iterationPolicyChanged) {
    if (mission.testScenario?.iterationPolicy) {
      mission.testScenario.iterationPolicy = {
        ...mission.testScenario.iterationPolicy,
        maxGenerationAttempts: FIXED_GENERATION_ATTEMPT_LIMIT,
        revision: FIXED_ITERATION_POLICY_REVISION,
      };
    }
    if (mission.operatorProfile?.iterationPolicy) {
      mission.operatorProfile.iterationPolicy = {
        ...mission.operatorProfile.iterationPolicy,
        maxGenerationAttempts: FIXED_GENERATION_ATTEMPT_LIMIT,
        revision: FIXED_ITERATION_POLICY_REVISION,
      };
    }
  }

  const blockedReason = state.iterationStats?.loopStatus === 'needs_human'
    ? state.iterationStats?.loopStatusReason
    : null;
  const recoverSourceBlock = RECOVERABLE_SOURCE_BLOCKERS.has(blockedReason);
  const recoverMaterializerBlock = blockedReason === 'baseline_materializer_failed'
    && previousPolicy.materializerRevision !== MATERIALIZER_DELIVERY_REVISION;
  const recoverGenerationBlock = iterationPolicyChanged
    && blockedReason === 'candidate_generation_failed'
    && Number(state.iterationStats?.currentRoundGenerationAttempts || 0) < FIXED_GENERATION_ATTEMPT_LIMIT;
  let recoveredRunId = null;
  if (recoverSourceBlock || recoverMaterializerBlock || recoverGenerationBlock) {
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null };
    mission.iterationStats = { ...(mission.iterationStats || {}), loopStatus: 'running', loopStatusReason: null };
    if (recoverGenerationBlock && mission.status === 'needs_human') mission.status = 'running';
    if (recoverSourceBlock && (TERMINAL_RESEARCH_STATUSES.has(state.researchAgent?.status) || state.researchAgent?.phase === '研究员状态读取失败')) {
      recoveredRunId = state.researchAgent?.runId || null;
      state.researchAgent = recoveredResearchAgent(state.researchAgent);
      mission.researchAgent = structuredClone(state.researchAgent);
    }
    if (recoverMaterializerBlock) {
      const previousMaterializer = state.baseline?.materializer || null;
      recoveredRunId = previousMaterializer?.runId || recoveredRunId;
      state.baseline = {
        ...(state.baseline || {}),
        materializerHistory: previousMaterializer
          ? [...(state.baseline?.materializerHistory || []), {
            runId: previousMaterializer.runId || null,
            status: previousMaterializer.status || 'failed',
            error: previousMaterializer.error || null,
            completedAt: previousMaterializer.completedAt || null,
          }].slice(-5)
          : state.baseline?.materializerHistory || [],
        materializer: {
          status: 'retry_ready',
          phase: '使用文件交付协议重新展开',
          progress: 0,
          result: null,
          error: null,
        },
      };
      mission.baseline = structuredClone(state.baseline);
      const recoveryAttempts = { ...(state.workflowKernel?.recoveryAttempts || {}) };
      delete recoveryAttempts['baseline-materializer'];
      state.workflowKernel = { ...(state.workflowKernel || {}), recoveryAttempts };
    }
  }

  const stalePhase = state.researchAgent?.phase === '研究员状态读取失败';
  if (stalePhase) {
    state.researchAgent = { ...state.researchAgent, phase: '研究员处理失败' };
    mission.researchAgent = structuredClone(state.researchAgent);
  }

  const changed = policyChanged || iterationPolicyChanged || recoverSourceBlock || recoverMaterializerBlock || recoverGenerationBlock || stalePhase;
  return {
    state,
    changed,
    recovery: changed ? {
      missionId: mission.id,
      previousMode: previousPolicy.mode || null,
      policyRevision: FLEXIBLE_SOURCE_POLICY_REVISION,
      materializerRevision: MATERIALIZER_DELIVERY_REVISION,
      iterationPolicyRevision: iterationPolicyChanged ? FIXED_ITERATION_POLICY_REVISION : null,
      previousGenerationLimit: iterationPolicyChanged ? previousGenerationLimit : null,
      generationAttemptLimit: fixedProfileMission ? FIXED_GENERATION_ATTEMPT_LIMIT : null,
      iterationPolicyChanged,
      previousBlocker: blockedReason,
      recoveredRunId,
    } : null,
  };
};

export { FLEXIBLE_SOURCE_POLICY_REVISION, MATERIALIZER_DELIVERY_REVISION, FIXED_ITERATION_POLICY_REVISION, FIXED_GENERATION_ATTEMPT_LIMIT };
