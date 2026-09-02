export const createAutopilotStrictSourceService = ({ isStrictZeroSourceMission, isResearchAgentActive, selectResearchBaselineSource, buildSemanticBaselineSource, startResearch, startBaseline, startMainRound, researchDirForMission }) => {
  const advance = async ({ state, mission, candidate }) => {
    if (!isStrictZeroSourceMission(mission)) return null;
    const research = state.researchAgent || {};
    if (state.baseline?.status !== 'complete' && isResearchAgentActive(research)) return { state, action: 'wait_research' };
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    const source = selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources })
      || (mission.sourcePolicy?.allowSemanticFallback === true && terminal && (research.runPhase === 'synthesize' || research.acquireHandled === true) ? buildSemanticBaselineSource(mission, research) : null);
    if (state.baseline?.status !== 'complete' && !source) {
      if (!research.runId) {
        const direction = `从零研究 ${mission.title || mission.goal}：在官方上游仓库中固定可验证的 MLA paged attention baseline source，记录 repository、commit、path 和 operator；不得生成候选代码。`;
        return { state: await startResearch({ state, mission, direction, workspace: researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot), synchronous: true }), action: 'baseline_research_started' };
      }
      if (terminal) {
        if (research.runPhase === 'acquire' && research.acquireHandled !== true) return { state, action: 'none' };
        state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' };
        return { state, action: 'needs_human' };
      }
      return { state, action: 'wait_research' };
    }
    if (state.baseline?.status !== 'complete') {
      const nextState = await startBaseline({ state, mission, reason: 'strict zero-source workflow' });
      const materializerStatus = nextState.baseline?.materializer?.status;
      return { state: nextState, action: materializerStatus === 'running' ? 'baseline_materializer_started' : nextState.baseline?.status === 'running' ? 'baseline_started' : 'none' };
    }
    if (!candidate && !state.agent?.runId && ['idle', 'ready', 'awaiting_action', 'completed'].includes(state.agent?.status)) return { state: await startMainRound({ state, goal: mission.goal }), action: 'candidate_agent_started' };
    return null;
  };
  return Object.freeze({ advance });
};
