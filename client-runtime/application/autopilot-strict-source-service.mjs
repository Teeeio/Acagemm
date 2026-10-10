import { RESEARCH_TRIGGERS, resolveAutomaticResearch } from '../research-policy.mjs';
import { missionDeclaresBaselineSource } from '../baseline-resolver.mjs';
import { buildBaselineSourceFailure } from './baseline-source-failure.mjs';

export const createAutopilotStrictSourceService = ({ isStrictZeroSourceMission, isResearchAgentActive, selectResearchBaselineSource, buildSemanticBaselineSource, startResearch, startBaseline, startMainRound, researchDirForMission, now = () => new Date().toISOString() }) => {
  const advance = async ({ state, mission, candidate }) => {
    if (!isStrictZeroSourceMission(mission)) return null;
    const research = state.researchAgent || {};
    if (state.baseline?.status !== 'complete' && isResearchAgentActive(research)) return { state, action: 'wait_research' };
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    // 规定了来源的 Mission 不能用语义来源顶替：不产出语义来源，下面就会落到
    // `baseline_source_unresolved` 的 needs_human 分支，而不是继续跑一个自造的正确性判据。
    const semanticAllowed = mission.sourcePolicy?.allowSemanticFallback === true && !missionDeclaresBaselineSource(mission);
    const source = selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources })
      || (semanticAllowed && terminal && (research.runPhase === 'synthesize' || research.acquireHandled === true) ? buildSemanticBaselineSource(mission, research) : null);
    if (state.baseline?.status !== 'complete' && !source) {
      if (!research.runId) {
        // 必要来源解析不是可选研究：它由来源门禁驱动，阶段的显式选择放在这里。
        // 但自动研究被关闭时，必须返回显式状态而不是悄悄启动采集，也不放宽门禁。
        const resolution = resolveAutomaticResearch({ mission, trigger: RESEARCH_TRIGGERS.BASELINE_SOURCE });
        if (!resolution.allowed) {
          state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'research_disabled_source_unresolved' };
          return { state, action: 'needs_human' };
        }
        const direction = `从零研究 ${mission.title || mission.goal}：在官方上游仓库中固定可验证的 ${mission.operator || mission.title || '目标算子'} baseline source，记录 repository、commit、path 和 operator；不得生成候选代码。`;
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
      if (terminal) {
        if (research.runPhase === 'acquire' && research.acquireHandled !== true) return { state, action: 'none' };
        state.workflowFailure = buildBaselineSourceFailure({ state, mission, now: () => now() });
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
