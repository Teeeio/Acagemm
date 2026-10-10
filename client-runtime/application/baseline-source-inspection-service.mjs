export const createBaselineSourceInspectionService = ({ inspectSources, appendRuntimeEvent }) => {
  const inspect = async ({ state, mission, baselineSource }) => {
    // Baseline 是**文件级**来源：显式声明 scope=file，缺路径必须失败。否则一个空路径的
    // baselineSource 会被当成合法的仓库级引用通过，等于放宽严格来源约束。
    const result = await inspectSources(mission.sourceRoot, [{ ...baselineSource, scope: 'file' }]);
    if (result.ready && !result.references.some((reference) => !reference.verified)) return { valid: true, state };
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unverified' };
    appendRuntimeEvent(state, 'baseline.source_unverified', { missionId: state.activeMissionId, errors: result.errors }, { kind: 'baseline', mode: 'client' });
    return { valid: false, state };
  };
  return Object.freeze({ inspect });
};
