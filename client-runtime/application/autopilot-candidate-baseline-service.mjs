import { RESEARCH_TRIGGERS, resolveAutomaticResearch } from '../research-policy.mjs';

export const createAutopilotCandidateBaselineService = ({ isManagedWorkspaceRuntimeMode, startBaseline, startResearch, researchDirForMission, agentRuntime, appendRuntimeEvent, addAuditEvent }) => {
  const advance = async ({ state, mission }) => {
    if (state.stage !== 'candidate' || state.agent?.status !== 'awaiting_action' || state.baseline?.status === 'complete') return null;
    const nextState = await startBaseline({ state, mission, reason: state.agent?.currentAction?.reason || state.agent?.result?.summary || '' });
    if (nextState.benchmark?.status === 'running' || nextState.baseline?.status === 'running') return { state: nextState, action: 'baseline_started' };
    const runtime = await agentRuntime.describe();
    const research = state.researchAgent || {};
    if (isManagedWorkspaceRuntimeMode(runtime.mode) && !research.runId && research.status !== 'running') {
      // 必要 baseline 来源解析：阶段显式。自动研究被关闭时给出显式状态，
      // 既不隐式开启研究，也不放宽来源门禁或启用 semantic fallback。
      const resolution = resolveAutomaticResearch({ mission, trigger: RESEARCH_TRIGGERS.BASELINE_SOURCE });
      if (!resolution.allowed) {
        state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'research_disabled_source_unresolved' };
        appendRuntimeEvent(state, 'baseline.source_unresolved', { missionId: state.activeMissionId, reasonCode: resolution.reasonCode }, { kind: 'baseline', mode: 'client' });
        addAuditEvent(state, 'Baseline 来源需要人工确认', resolution.reason, 'warning', 'UserRound');
        return { state, action: 'needs_human' };
      }
      const direction = [`为 Mission ${mission.id} 查找可验证的权威 baseline：${mission.goal}`, '优先检查本地 Source Registry，再检索上游官方仓库、测试和 benchmark。', '必须记录固定 commit、path、operator、confidence 和语义依据。'].join('\n');
      return {
        state: await startResearch({
          state, mission, direction,
          workspace: researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot),
          synchronous: true,
          runPhase: resolution.phase,
          budgetMs: resolution.budgetMs,
          trigger: RESEARCH_TRIGGERS.BASELINE_SOURCE,
        }),
        action: 'baseline_research_started',
      };
    }
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    if (isManagedWorkspaceRuntimeMode(runtime.mode) && research.runId && terminal && research.runPhase !== 'acquire') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' };
      appendRuntimeEvent(state, 'baseline.source_unresolved', { missionId: state.activeMissionId, researchRunId: research.runId }, { kind: 'baseline', mode: 'client' });
      addAuditEvent(state, 'Baseline 来源需要人工确认', 'Research Agent 未找到可固定版本且语义可验证的权威 baseline。', 'warning', 'UserRound');
      return { state, action: 'needs_human' };
    }
    return { state, action: 'none' };
  };
  return Object.freeze({ advance });
};
