export const createBaselineSourceService = ({ isFixedOperatorMission, isStrictZeroSourceMission, selectResearchBaselineSource, buildSemanticBaselineSource, inferAuthoritativeBaselineSource, isSemanticBaselineSource }) => {
  const select = ({ state, mission, reason = '' }) => {
    const fixed = isFixedOperatorMission(mission);
    const strict = isStrictZeroSourceMission(mission);
    const research = state.researchAgent || {};
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    const researched = selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources });
    const semantic = mission.sourcePolicy?.allowSemanticFallback === true && terminal ? buildSemanticBaselineSource(mission, research) : null;
    const source = fixed ? state.baseline?.source || mission.baseline?.source : strict ? researched || semantic : state.baseline?.source || mission.baseline?.source || researched || inferAuthoritativeBaselineSource(mission, { operator: mission.operator || mission.title, reason });
    return { source: source || null, semanticFallback: Boolean(source && isSemanticBaselineSource(source)) };
  };
  return Object.freeze({ select });
};
