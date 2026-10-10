import { detectLoopGuard } from '../iteration-loop.mjs';
import { ensureRoundBudgetStarted } from '../round-budget-contract.mjs';
import { assertResourcesReleased } from '../cancellation-contract.mjs';
import { semanticTestSpecDigest, freezeSemanticSnapshot, assertSemanticSnapshot } from '../semantic-snapshot.mjs';
import { assertGenerationOnlyAction } from './workflow-command-policy.mjs';
import { isDraftPreparationRetry, generationPreparationFailureFor, throwPreparationFailure } from '../generation-preparation.mjs';

const notFound = () => { const error = new Error('Mission 不存在。'); error.status = 404; error.code = 'MISSION_NOT_FOUND'; return error; };
const fixedRunNextAction = '检查已有证据和固定 Profile 限制；已耗尽的轮数或重试次数不会重置。需要独立新实验时创建新的 Mission。';
const draftError = (code, message) => Object.assign(new Error(message), { code, status: 409, retryable: false });
const activeExecutionStatuses = new Set(['queued', 'waiting', 'running', 'executing', 'awaiting_action', 'awaiting_approval', 'cancel_requested']);
const freshDraftSnapshot = (snapshot) => {
  const stats = snapshot.iterationStats || {};
  const retry = isDraftPreparationRetry(snapshot);
  return snapshot.stage === 'diagnosis' && (!snapshot.missionBudgetStartedAt || retry)
    && snapshot.agent?.status === 'idle' && !snapshot.agent?.runId && !snapshot.agent?.currentAction
    && !activeExecutionStatuses.has(snapshot.researchAgent?.status)
    && !activeExecutionStatuses.has(snapshot.baseline?.materializer?.status)
    && snapshot.benchmark?.status === 'idle' && !snapshot.benchmark?.runId
    && !snapshot.benchmark?.testTaskId && !snapshot.benchmark?.result
    && !snapshot.patchApplied && !snapshot.appliedCandidateId && !snapshot.currentBest?.candidateId
    && !snapshot.candidateEvaluations?.length && !snapshot.failureRecords?.length && !snapshot.runHistory?.length
    && stats.round === 0 && stats.loopStatus === 'running' && !stats.loopStatusReason && !stats.loopStartedAt
    && (!stats.roundBudget || (retry && JSON.stringify(stats.roundBudget) === JSON.stringify(generationPreparationFailureFor(snapshot).roundBudget)))
    && !stats.pendingInjection && !stats.stoppedAt && !stats.completedAt
    && !stats.lastCountedRunId && !stats.lastGenerationAttemptRunId && !stats.lastCorrectnessAttemptRunId
    && ['round', 'performanceRounds', 'correctnessAttempts', 'generationAttempts', 'currentRoundCorrectnessAttempts',
      'currentRoundGenerationAttempts', 'totalCorrectnessAttempts'].every((field) => (stats[field] ?? 0) === 0)
    && snapshot.workflowRecovery?.commandRecovery?.status !== 'blocked';
};
const admitDraft = (state, mission) => {
  if (state.activeMissionId !== mission.id || state.missionPaused !== true || mission.missionPaused !== true
    || mission.status !== 'ready' || !freshDraftSnapshot(state) || !freshDraftSnapshot(mission)) {
    throw draftError('MISSION_DRAFT_START_INVALID', 'Only an active, paused, never-started draft can use startDraft.');
  }
  assertResourcesReleased(mission);
  const materializer = state.baseline?.materializer;
  const declared = mission.baseline?.materializer;
  if (materializer?.status !== 'completed' || declared?.status !== 'completed'
    || typeof materializer?.result?.runPy !== 'string' || !materializer.result.runPy.trim()
    || declared?.result?.runPy !== materializer.result.runPy) {
    throw draftError('GENERIC_MISSION_BASELINE_NOT_READY', 'Draft start requires a completed independent baseline artifact.');
  }
  // test-spec.mjs normalizes/defaults rather than validates. Check the stored
  // contract here without replacing missing cases, profiles or measurements.
  const spec = state.testMatrix?.testSpec;
  const names = (items) => Array.isArray(items) && items.length > 0 && items.every((item) => typeof item === 'string' && item.trim());
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  if (spec?.schemaVersion !== 'operator-studio.test-spec/v1'
    || !positiveInteger(spec.correctness?.requestedCases) || !names(spec.correctness?.requiredCategories)
    || !names(spec.benchmark?.requiredProfiles) || !spec.benchmark.requiredProfiles.includes(spec.benchmark.primaryProfile)
    || !positiveInteger(spec.benchmark?.warmup) || !positiveInteger(spec.benchmark?.repeats)
    || spec.generation?.deterministic !== true || !Number.isSafeInteger(spec.generation?.seed)
    || !Number.isFinite(spec.correctness?.atol) || spec.correctness.atol < 0
    || !Number.isFinite(spec.correctness?.rtol) || spec.correctness.rtol < 0
    || semanticTestSpecDigest(spec) !== semanticTestSpecDigest(mission.testMatrix?.testSpec)) {
    throw draftError('MISSION_DRAFT_TEST_SPEC_INVALID', 'Draft start requires the unchanged, explicit correctness and benchmark testSpec.');
  }
  state.missionPaused = false;
  mission.missionPaused = false;
};

export const createRunService = ({ loadState, persistState, executeCommand, journal, registry, agentRuntime, buildRuntimePreflight, guardMutation = () => {}, assertMissionIntent, isStrictZeroSourceMission, isFixedOperatorMission, selectResearchBaselineSource, missionState, nowMs } = {}) => {
  if (typeof missionState?.selectMission !== 'function' || typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || !agentRuntime || typeof buildRuntimePreflight !== 'function') {
    throw new TypeError('Run service requires state, command, runtime, and preflight dependencies.');
  }
  if (typeof nowMs !== 'function') throw new TypeError('Run service requires an injected nowMs clock.');
  const admitFixedRun = (state) => {
    const currentTime = nowMs();
    const reason = detectLoopGuard(state, { nowMs: currentTime });
    if (reason) {
      throw Object.assign(new Error('固定 Profile 当前不能启动新的执行：' + reason + '。'), {
        code: 'FIXED_OPERATOR_RUN_BLOCKED', status: 409, retryable: false,
        details: { reason, nextAction: fixedRunNextAction },
      });
    }
    try {
      // This explicit API arming is a manual admission, not Autopilot permission.
      // Active/repaired rounds retain their existing clock; only settled
      // publication may allocate a fresh identity within the remaining limits.
      ensureRoundBudgetStarted(state, { nowMs: currentTime, allowSettledRestart: true });
    } catch (error) {
      error.details = { ...(error.details || {}), nextAction: error.details?.nextAction || fixedRunNextAction };
      throw error;
    }
  };
  const start = async (missionId, body = {}) => {
    const loadedState = await loadState();
    const startDraft = body.startDraft === true;
    const requestedMission = loadedState.missions.find((item) => item.id === missionId);
    const generationOnly = requestedMission?.executionMode === 'generate-only';
    if (generationOnly || loadedState.iterationStats?.pendingValidation) {
      assertResourcesReleased(loadedState);
      assertGenerationOnlyAction(loadedState, 'run');
      if (!startDraft || loadedState.activeMissionId !== missionId) {
        throw draftError('GENERATION_ONLY_RUN_UNAVAILABLE', 'Generation-only starts require the active fresh paused draft and startDraft:true; restart/testing authorization is not implemented.');
      }
    }
    // Check the original active owner before selection or unpausing a clone.
    // Failed admission must not mutate even a load port returning shared state.
    if (startDraft) assertResourcesReleased(loadedState);
    const state = startDraft ? structuredClone(loadedState) : loadedState;
    if (!startDraft) guardMutation(state);
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission) throw notFound();
    if (startDraft) {
      admitDraft(state, mission);
      if (generationOnly || mission.sourcePolicy?.mode === 'existing-source-project') {
        const frozen = mission.semanticSnapshot?.status === 'frozen'
          ? assertSemanticSnapshot(mission.semanticSnapshot, { requireFrozen: true })
          : freezeSemanticSnapshot(mission.semanticSnapshot, { now: new Date(nowMs()).toISOString() });
        if (frozen.missionId !== mission.id || semanticTestSpecDigest(frozen.testSpec) !== semanticTestSpecDigest(state.testMatrix.testSpec)) {
          throw draftError('SEMANTIC_SNAPSHOT_MISMATCH', 'Source iteration start requires the frozen Mission semantics and testSpec to match.');
        }
        mission.semanticSnapshot = structuredClone(frozen);
        state.semanticSnapshot = structuredClone(frozen);
      }
      if (isStrictZeroSourceMission(mission)) {
        const source = selectResearchBaselineSource?.(state.researchNotes, mission, {
          operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources,
        });
        const declared = mission.baseline?.source || mission.upstream?.baselineSource || mission.upstream?.reference;
        if (!source || source.semanticFallback === true || source.authority === 'agent-semantic'
          || (declared && ['repository', 'commit', 'path'].some((field) => !declared[field] || declared[field] !== source[field]))) {
          throw draftError('BASELINE_SOURCE_UNRESOLVED', 'Strict draft start requires its authoritative baseline source to be resolved; startDraft never launches research.');
        }
      }
      guardMutation(state);
    }
    if (state.activeMissionId !== missionId) missionState.selectMission(state, missionId);
    // Auto-tick and explicit Run commands share the writer lock. If auto-tick
    // has already started this Mission, reject before opening a journal entry
    // or creating a checkpoint. A late admission rejection inside runEffect
    // would otherwise leave an ambiguous external-effect marker.
    if (state.agent?.runId && ['running', 'executing', 'awaiting_action', 'cancel_requested', 'awaiting_approval'].includes(state.agent.status)) {
      throw Object.assign(new Error('An Agent run is already active for this Mission.'), {
        code: 'AGENT_RUN_ALREADY_ACTIVE', status: 409,
        details: { missionId, runId: state.agent.runId },
      });
    }
    let goal = body.goal?.trim() || mission.goal;
    let advisory = null;
    if (!body.goal && state.iterationStats?.pendingInjection) {
      const pending = state.iterationStats.pendingInjection;
      // 研究建议经不可信上下文边界进入 prompt；goal 只带可核验身份，不拼裸文本。
      // 材料只有在真正提交成功后才会被清除，否则保持待交付，避免「显示已注入但没交付」。
      advisory = pending.advisory || null;
      if (advisory) {
        goal = [goal, `【研究建议】${pending.noteId} · ${pending.digest}`].filter(Boolean).join('\n');
        state.iterationStats = {
          ...state.iterationStats,
          pendingInjection: { ...pending, stage: 'selected', selectedAt: pending.selectedAt || new Date().toISOString() },
        };
      } else {
        // 旧格式（无 advisory 封装）保持既有文本注入行为，但同样在提交成功前不清除材料。
        goal = `${goal}\n【调研注入】${pending.briefing || ''}`;
      }
    }
    if (state.iterationStats) state.iterationStats = { ...state.iterationStats, loopStatus: 'running', loopStatusReason: null };
    const fixedOperator = isFixedOperatorMission(mission);
    if (fixedOperator) admitFixedRun(state);
    if (!startDraft && isStrictZeroSourceMission(mission)
        && state.baseline?.status !== 'complete'
        && !selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title })) {
      assertMissionIntent(goal, mission);
      if (state.researchAgent?.runId && ['running', 'cancel_requested'].includes(state.researchAgent?.status)) {
        return { kind: 'research', statusCode: 202, payload: { state, research: state.researchAgent, runId: state.researchAgent.runId, idempotent: true } };
      }
      const direction = `从零研究 ${mission.title || mission.goal}：在官方上游仓库中固定可验证的 MLA paged attention baseline source，记录 repository、commit、path 和 operator；不得生成候选代码。`;
      const result = await executeCommand({ journal, saveState: persistState, registry, state, type: 'research', body: { direction, synchronous: true }, expectedVersion: state.stateVersion });
      return { kind: 'research', statusCode: 202, result };
    }
    const runtimeDescriptor = await agentRuntime.describe();
    const preflight = await buildRuntimePreflight(mission);
    if (!preflight.ready) {
      const failure = !preflight.workspaceCheck.ready ? preflight.workspaceCheck : preflight.agentCheck;
      const error = new Error(failure.detail || 'Agent Runtime 预检失败。');
      error.status = 503;
      error.code = failure.code || 'RUNTIME_PREFLIGHT_FAILED';
      error.details = preflight;
      throw error;
    }
    assertMissionIntent(goal, mission);
    if (startDraft) guardMutation(state); // Preflight time consumes, never renews, the admitted Mission clock.
    if (fixedOperator && !generationOnly) {
      admitFixedRun(state); // Preflight time cannot silently renew the admitted clock.
      state.agent = { ...(state.agent || {}), runId: null, status: 'idle', phase: state.baseline?.status === 'complete' ? '等待固定候选轮次' : '等待固定 baseline', progress: 0, currentAction: null, goal };
      state.stage = 'candidate';
      return { kind: 'armed', statusCode: 202, payload: { state: await persistState(state), runId: null, armed: true } };
    }
    const resumeThreadId = body.resume === true
      ? state.agent?.threadId || state.runHistory?.find((run) => run.runtimeKind === runtimeDescriptor.mode && run.threadId)?.threadId || null
      : null;
    const result = await executeCommand({ journal, saveState: persistState, registry, state, type: 'runs', body: { ...body, goal, advisory, resumeThreadId, workspace: preflight.workspace }, expectedVersion: state.stateVersion });
    throwPreparationFailure(result);
    // 提交核对：只有执行端真实 run 绑定到该 material digest 才算已交付；
    // 否则材料保留为待交付状态，操作员可以重试，不需要重新做一次研究。
    if (advisory && state.iterationStats?.pendingInjection) {
      const bound = state.agent?.researchAdvisory;
      if (state.agent?.runId && bound && bound.digest === advisory.digest) {
        state.iterationStats = {
          ...state.iterationStats,
          pendingInjection: null,
          researchInjection: { noteId: state.iterationStats.pendingInjection.noteId, digest: advisory.digest, missionId: state.iterationStats.pendingInjection.missionId, researchRunId: state.iterationStats.pendingInjection.researchRunId, roundId: state.agent.roundId || null, runId: state.agent.runId, status: 'submitted', evidence: 'agent-run-binding', submittedAt: new Date().toISOString() },
        };
      } else {
        state.iterationStats = { ...state.iterationStats, pendingInjection: { ...state.iterationStats.pendingInjection, stage: 'uncertain', delivery: { reason: 'run_not_bound', at: new Date().toISOString() } } };
      }
    }
    return { kind: 'run', statusCode: 202, result };
  };
  return Object.freeze({ start });
};
