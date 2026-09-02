export const createBaselineSourceInspectionService = ({ inspectSources, appendRuntimeEvent }) => {
  const inspect = async ({ state, mission, baselineSource }) => {
    const result = await inspectSources(mission.sourceRoot, [baselineSource]);
    if (result.ready && !result.references.some((reference) => !reference.verified)) return { valid: true, state };
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unverified' };
    appendRuntimeEvent(state, 'baseline.source_unverified', { missionId: state.activeMissionId, errors: result.errors }, { kind: 'baseline', mode: 'client' });
    return { valid: false, state };
  };
  return Object.freeze({ inspect });
};
