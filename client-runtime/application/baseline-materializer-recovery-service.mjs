export const createBaselineMaterializerRecoveryService = ({ consumeWorkflowRecoveryBudget, startResearch, researchDirForMission, appendRuntimeEvent }) => {
  const recover = async ({ state, mission, baselineSource, materializer }) => {
    if (!['failed', 'cancelled', 'timed_out'].includes(materializer.status)) return null;
    const recovery = consumeWorkflowRecoveryBudget(state, { component: 'baseline-materializer', limit: 1 });
    if (!recovery.allowed || materializer.status === 'cancelled') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_materializer_failed' };
      return { state, action: 'needs_human' };
    }
    const rejectedSource = { ...(materializer.source || baselineSource), errorCode: materializer.error?.code || 'BASELINE_MATERIALIZER_FAILED', reason: materializer.error?.details?.summary || materializer.error?.message || 'Materializer could not construct the required artifact.' };
    state.baseline = { ...(state.baseline || {}), source: null, rejectedSources: [...(state.baseline?.rejectedSources || []), rejectedSource], materializer: { ...materializer, status: 'redirected', phase: '返回 Source 调研', recoveryAttempt: recovery.attempt } };
    const direction = `上一权威 Source 无法物化为 ${mission.title || mission.operator || '目标算子'} baseline。已拒绝 Source：${rejectedSource.repository}@${rejectedSource.commit}:${rejectedSource.path}。请重新固定官方上游实现文件，不要再次选择包装层。`;
    const redirected = await startResearch({ state, mission, direction, workspace: researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot), synchronous: true });
    appendRuntimeEvent(redirected, 'workflow.recovery_redirected', { component: recovery.component, attempt: recovery.attempt, limit: recovery.limit, from: 'materializer', to: 'research', rejectedSource }, { kind: 'workflow-kernel', mode: 'client' });
    return { state: redirected, action: 'research_redirected' };
  };
  return Object.freeze({ recover });
};
