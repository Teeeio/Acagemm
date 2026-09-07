import { detectLoopGuard } from '../iteration-loop.mjs';
import { ensureRoundBudgetStarted } from '../round-budget-contract.mjs';

const notFound = () => { const error = new Error('Mission 不存在。'); error.status = 404; error.code = 'MISSION_NOT_FOUND'; return error; };
const fixedRunNextAction = '检查已有证据和固定 Profile 限制；已耗尽的轮数或重试次数不会重置。需要独立新实验时创建新的 Mission。';

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
    const state = await loadState();
    guardMutation(state);
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission) throw notFound();
    if (state.activeMissionId !== missionId) missionState.selectMission(state, missionId);
    let goal = body.goal?.trim() || mission.goal;
    if (!body.goal && state.iterationStats?.pendingInjection) {
      goal = `${goal}\n【调研注入】${state.iterationStats.pendingInjection.briefing}`;
      state.iterationStats = { ...state.iterationStats, pendingInjection: null };
    }
    if (state.iterationStats) state.iterationStats = { ...state.iterationStats, loopStatus: 'running', loopStatusReason: null };
    const fixedOperator = isFixedOperatorMission(mission);
    if (fixedOperator) admitFixedRun(state);
    if (isStrictZeroSourceMission(mission)
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
    if (fixedOperator) {
      admitFixedRun(state); // Preflight time cannot silently renew the admitted clock.
      state.agent = { ...(state.agent || {}), runId: null, status: 'idle', phase: state.baseline?.status === 'complete' ? '等待固定候选轮次' : '等待固定 baseline', progress: 0, currentAction: null, goal };
      state.stage = 'candidate';
      return { kind: 'armed', statusCode: 202, payload: { state: await persistState(state), runId: null, armed: true } };
    }
    const resumeThreadId = body.resume === true
      ? state.agent?.threadId || state.runHistory?.find((run) => run.runtimeKind === runtimeDescriptor.mode && run.threadId)?.threadId || null
      : null;
    const result = await executeCommand({ journal, saveState: persistState, registry, state, type: 'runs', body: { ...body, goal, resumeThreadId, workspace: preflight.workspace }, expectedVersion: state.stateVersion });
    return { kind: 'run', statusCode: 202, result };
  };
  return Object.freeze({ start });
};
