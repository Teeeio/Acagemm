import { RESEARCH_TRIGGERS, resolveAutomaticResearch } from '../research-policy.mjs';

export const createAutopilotFixedProfileService = ({ isResearchAgentActive, startResearch, startMainRound, researchDirForMission, appendRuntimeEvent }) => {
  const advance = async ({ state, mission }) => {
    if (state.baseline?.status !== 'complete') return null;
    const research = state.researchAgent || {};
    if (mission.sourcePolicy?.researchEnabled !== false && !research.runId) {
      // 统一走 research-policy：phase 与预算显式，且不再写死 C550 等历史硬件——
      // 目标硬件、后端、dtype、shape 全部来自当前冻结任务契约。
      const resolution = resolveAutomaticResearch({ mission, trigger: RESEARCH_TRIGGERS.EXPERIENCE });
      const target = [
        mission.title || mission.operator || '目标算子',
        (mission.hardware || []).join('/') || '目标硬件',
        mission.operatorProfile?.language || 'target',
      ].join(' · ');
      const direction = `为 ${target} 搜寻实现经验。只输出优化方向与参考；不得修改冻结语义、Correctness 或 Benchmark。`;
      try {
        state = await startResearch({
          state, mission, direction,
          workspace: researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot),
          synchronous: false,
          runPhase: resolution.phase,
          budgetMs: resolution.budgetMs,
          trigger: RESEARCH_TRIGGERS.EXPERIENCE,
        });
      } catch (error) {
        state.researchAgent = { ...research, status: 'failed', runPhase: 'experience', phase: '经验调研不可用（不阻塞）', progress: 100, error: { code: error.code || 'EXPERIENCE_RESEARCH_FAILED', message: error.message } };
        appendRuntimeEvent(state, 'research.experience_unavailable', { missionId: state.activeMissionId, error: error.message, reasonCode: error.reasonCode || null }, { kind: 'research', mode: 'client' });
      }
    } else if (mission.sourcePolicy?.researchEnabled === false && !research.runId) {
      // 关闭自动研究：本地经验与已审查 Wiki 的检索不受影响（那是 round-experience 路径），
      // 这里只保证经验调研不会从本分支悄悄启动。事件按 Mission 幂等，不随 tick 重复堆积。
      const missionId = state.activeMissionId;
      if (!state.runtimeEvents?.some((event) => event.type === 'research.skipped_disabled'
        && event.payload?.trigger === RESEARCH_TRIGGERS.EXPERIENCE && event.payload?.missionId === missionId)) {
        appendRuntimeEvent(state, 'research.skipped_disabled', { missionId, trigger: RESEARCH_TRIGGERS.EXPERIENCE, phase: 'experience' }, { kind: 'research', mode: 'client' });
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
