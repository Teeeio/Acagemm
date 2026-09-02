export const createAutopilotFixedProfileService = ({ isResearchAgentActive, startResearch, startMainRound, researchDirForMission, appendRuntimeEvent }) => {
  const advance = async ({ state, mission }) => {
    if (state.baseline?.status !== 'complete') return null;
    const research = state.researchAgent || {};
    if (mission.sourcePolicy?.researchEnabled !== false && !research.runId) {
      const direction = `为 ${mission.title || mission.operator} 搜寻 C500 / ${mission.operatorProfile?.language || 'target'} 的实现经验。只输出优化方向与参考；不得修改冻结语义、Correctness 或 Benchmark。`;
      try {
        state = await startResearch({ state, mission, direction, workspace: researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot), synchronous: false, runPhase: 'experience' });
      } catch (error) {
        state.researchAgent = { ...research, status: 'failed', runPhase: 'experience', phase: '经验调研不可用（不阻塞）', progress: 100, error: { code: error.code || 'EXPERIENCE_RESEARCH_FAILED', message: error.message } };
        appendRuntimeEvent(state, 'research.experience_unavailable', { missionId: state.activeMissionId, error: error.message }, { kind: 'research', mode: 'client' });
      }
    }
    if (isResearchAgentActive(state.researchAgent || {}) && state.researchAgent?.synchronous) return { state, action: 'wait_experience_research' };
    if (!state.agent?.runId && ['idle', 'ready', 'awaiting_action', 'completed', 'failed', 'cancelled'].includes(state.agent?.status)) {
      const correctnessRepair = Number(state.iterationStats?.currentRoundCorrectnessAttempts || 0) > 0 && state.iterationStats?.correctnessEstablished !== true;
      return { state: await startMainRound({ state, goal: mission.goal, retryMode: correctnessRepair ? 'correctness' : 'generation' }), action: 'candidate_agent_started' };
    }
    return { state, action: 'none' };
  };
  return Object.freeze({ advance });
};
