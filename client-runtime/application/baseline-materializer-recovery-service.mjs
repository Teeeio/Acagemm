import { RESEARCH_TRIGGERS, resolveAutomaticResearch } from '../research-policy.mjs';
import { normalizeWorkflowError, serializeWorkflowError } from '../workflow-error.mjs';

export const createBaselineMaterializerRecoveryService = ({ consumeWorkflowRecoveryBudget, startResearch, researchDirForMission, appendRuntimeEvent, now = () => new Date().toISOString() }) => {
  const recover = async ({ state, mission, baselineSource, materializer }) => {
    if (!['failed', 'cancelled', 'timed_out'].includes(materializer.status)) return null;
    const recovery = consumeWorkflowRecoveryBudget(state, { component: 'baseline-materializer', limit: 1 });
    if (!recovery.allowed || materializer.status === 'cancelled') {
      const missionId = materializer.missionId || state.activeMissionId || mission.id || null;
      const runId = materializer.runId || null;
      const startedAt = materializer.startedAt || null;
      const previous = state.workflowFailure;
      const sameRun = Boolean(runId) && previous?.phase === 'baseline.materializer'
        && previous.details?.missionId === missionId
        && previous.details?.runId === runId
        && previous.details?.startedAt === startedAt
        && previous.details?.materializerStatus === materializer.status;
      const category = materializer.status === 'cancelled' ? 'user_cancel' : materializer.status === 'timed_out' ? 'timeout' : materializer.error?.category;
      state.workflowFailure = serializeWorkflowError(normalizeWorkflowError({ ...materializer.error, retryable: false }, {
        code: `BASELINE_MATERIALIZER_${materializer.status.toUpperCase()}`,
        message: `Baseline materializer ${materializer.status}; explicit human action is required.`,
        category,
        phase: 'baseline.materializer',
        source: 'baseline-materializer',
        occurredAt: materializer.completedAt || (sameRun && previous.occurredAt) || now(),
        details: {
          missionId, runId, startedAt,
          threadId: materializer.threadId || null,
          materializerStatus: materializer.status,
          materializationDir: materializer.materializationDir || null,
          source: structuredClone(materializer.source || baselineSource || null),
          originalError: structuredClone(materializer.error || null),
          recovery: { attempt: recovery.attempt, limit: recovery.limit, reason: materializer.status === 'cancelled' ? 'cancelled' : 'exhausted' },
        },
      }));
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_materializer_failed' };
      return { state, action: 'needs_human' };
    }
    const rejectedSource = { ...(materializer.source || baselineSource), errorCode: materializer.error?.code || 'BASELINE_MATERIALIZER_FAILED', reason: materializer.error?.details?.summary || materializer.error?.message || 'Materializer could not construct the required artifact.' };
    // 改选来源是必要来源解析（仍属自动研究入口），因此同样受统一策略约束：
    // 关闭自动研究时不给「从别的分支悄悄启动采集」留口子，改为显式人工状态。
    const resolution = resolveAutomaticResearch({ mission, trigger: RESEARCH_TRIGGERS.MATERIALIZER_REDIRECT });
    if (!resolution.allowed) {
      state.baseline = { ...(state.baseline || {}), source: null, rejectedSources: [...(state.baseline?.rejectedSources || []), rejectedSource], materializer: { ...materializer, status: 'redirected', phase: '来源改选被策略阻止，等待人工处理', recoveryAttempt: recovery.attempt } };
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'research_disabled_source_unresolved' };
      appendRuntimeEvent(state, 'workflow.recovery_blocked', { component: recovery.component, reasonCode: resolution.reasonCode, rejectedSource }, { kind: 'workflow-kernel', mode: 'client' });
      return { state, action: 'needs_human' };
    }
    state.baseline = { ...(state.baseline || {}), source: null, rejectedSources: [...(state.baseline?.rejectedSources || []), rejectedSource], materializer: { ...materializer, status: 'redirected', phase: '返回 Source 调研', recoveryAttempt: recovery.attempt } };
    const direction = `上一权威 Source 无法物化为 ${mission.title || mission.operator || '目标算子'} baseline。已拒绝 Source：${rejectedSource.repository}@${rejectedSource.commit}:${rejectedSource.path}。请重新固定官方上游实现文件，不要再次选择包装层。`;
    const redirected = await startResearch({
      state, mission, direction,
      workspace: researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot),
      synchronous: true,
      runPhase: resolution.phase,
      budgetMs: resolution.budgetMs,
      trigger: RESEARCH_TRIGGERS.MATERIALIZER_REDIRECT,
    });
    appendRuntimeEvent(redirected, 'workflow.recovery_redirected', { component: recovery.component, attempt: recovery.attempt, limit: recovery.limit, from: 'materializer', to: 'research', rejectedSource }, { kind: 'workflow-kernel', mode: 'client' });
    return { state: redirected, action: 'research_redirected' };
  };
  return Object.freeze({ recover });
};
