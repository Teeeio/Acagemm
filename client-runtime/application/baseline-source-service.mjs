import { missionDeclaresBaselineSource } from '../baseline-resolver.mjs';

export const createBaselineSourceService = ({ isFixedOperatorMission, isStrictZeroSourceMission, selectResearchBaselineSource, buildSemanticBaselineSource, inferAuthoritativeBaselineSource, isSemanticBaselineSource }) => {
  const select = ({ state, mission, reason = '' }) => {
    const fixed = isFixedOperatorMission(mission);
    const strict = isStrictZeroSourceMission(mission);
    const research = state.researchAgent || {};
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    const researched = selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources });
    // 规定了来源的 Mission 不允许语义顶替：这里不产出语义来源，调用方就会走既有的
    // 「terminal 且仍未解析出来源」分支，升级为 needs_human(baseline_source_unresolved)。
    const semanticAllowed = mission.sourcePolicy?.allowSemanticFallback === true && !missionDeclaresBaselineSource(mission);
    const semantic = semanticAllowed && terminal ? buildSemanticBaselineSource(mission, research) : null;
    const source = fixed ? state.baseline?.source || mission.baseline?.source : strict ? researched || semantic : state.baseline?.source || mission.baseline?.source || researched || inferAuthoritativeBaselineSource(mission, { operator: mission.operator || mission.title, reason });
    return { source: source || null, semanticFallback: Boolean(source && isSemanticBaselineSource(source)) };
  };
  return Object.freeze({ select });
};
