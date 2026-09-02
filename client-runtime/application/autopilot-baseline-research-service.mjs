export const createAutopilotBaselineResearchService = ({ isManagedWorkspaceRuntimeMode, isResearchAgentActive, startResearch, researchDirForMission, appendRuntimeEvent, addAuditEvent, agentRuntime }) => {
  const advance = async ({ state, mission }) => {
    if (state.baseline?.status === 'complete') return null;
    const research = state.researchAgent || {};
    if (isResearchAgentActive(research)) return null;
    const runtime = await agentRuntime.describe();
    if (isManagedWorkspaceRuntimeMode(runtime.mode) && !research.runId && research.status !== 'running') {
      const direction = [`为 Mission ${mission.id} 查找可验证的权威 baseline：${mission.goal}`, '优先检查本地 Source Registry，再检索上游官方仓库、测试和 benchmark。', '必须记录固定 commit、path、operator、confidence 和语义依据。'].join('\n');
      const workspace = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
      return { state: await startResearch({ state, mission, direction, workspace, synchronous: true }), action: 'baseline_research_started' };
    }
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    if (isManagedWorkspaceRuntimeMode(runtime.mode) && research.runId && terminal && research.runPhase !== 'acquire') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' };
      appendRuntimeEvent(state, 'baseline.source_unresolved', { missionId: state.activeMissionId, researchRunId: research.runId }, { kind: 'baseline', mode: 'client' });
      addAuditEvent(state, 'Baseline 来源需要人工确认', 'Research Agent 未找到可固定版本且语义可验证的权威 baseline。', 'warning', 'UserRound');
      return { state, action: 'needs_human' };
    }
    return null;
  };
  return Object.freeze({ advance });
};
