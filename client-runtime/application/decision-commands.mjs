export const createDecisionCommands = ({
  addAuditEvent,
  adoptCandidateState,
  appendRuntimeEvent,
  createDecisionReviewState,
  hasMissionBudgetInput,
  interventionOutcomeMeta,
  normalizeMissionBudgetMs,
  restoreWorkspaceCheckpoint,
  runAutomaticAdoption,
  validateMissionBudgetInput,
  workspaceManager,
  now = () => new Date(),
}) => Object.freeze({
  'resume-mission': {
    tracksEffects: true,
    keyFor: (state, body) => `resume-mission:${state.activeMissionId}:${state.stage}:${state.candidateEvaluations?.[0]?.patchDigest || 'no-candidate'}:${body?.missionBudgetMs ?? body?.missionBudgetHours ?? 'keep'}`,
    isApplied: (state, payload) => state.stage === 'candidate'
      && state.agent?.status === 'awaiting_action'
      && state.missionBudgetStartedAt === payload?.missionBudgetStartedAt,
    prepare: async ({ state, body }) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const hasCandidate = Array.isArray(state.candidateEvaluations) && state.candidateEvaluations.length > 0;
      const currentBestEmpty = !state.currentBest?.candidateId && (!state.currentBest?.value || state.currentBest.value === '--' || state.currentBest.value === '—');
      const budgetEnded = state.stage === 'published'
        && state.agent?.phase === 'Mission budget 已到，保留 current best'
        && currentBestEmpty
        && hasCandidate;
      if (!budgetEnded) {
        const error = new Error('当前 Mission 不满足预算兜底恢复条件。');
        error.status = 409;
        error.code = 'MISSION_RESUME_NOT_APPLICABLE';
        error.details = { stage: state.stage, agentPhase: state.agent?.phase || null, currentBest: state.currentBest || null, candidateCount: state.candidateEvaluations?.length || 0 };
        throw error;
      }
      const requestedBudget = hasMissionBudgetInput(body)
        ? validateMissionBudgetInput(body)
        : { ok: true, value: normalizeMissionBudgetMs(state.missionBudgetMs) || 5 * 60 * 60 * 1000 };
      if (!requestedBudget.ok) {
        const error = new Error('missionBudgetMs 必须是正数毫秒；传 null、空值或 0 表示不启用时间限制。');
        error.status = 400;
        error.code = 'INVALID_MISSION_BUDGET';
        throw error;
      }
      return {
        payload: {
          missionId: state.activeMissionId,
          missionTitle: mission.title || state.activeMissionId,
          candidateId: state.candidateEvaluations[0].id || 'candidate-01',
          candidateDigest: state.candidateEvaluations[0].patchDigest || null,
          missionBudgetMs: requestedBudget.value,
          missionBudgetStartedAt: now().toISOString(),
        },
      };
    },
    apply: (state, payload) => {
      state.stage = 'candidate';
      state.patchApplied = false;
      state.missionPaused = false;
      state.missionBudgetMs = payload.missionBudgetMs;
      state.missionBudgetStartedAt = payload.missionBudgetStartedAt;
      state.benchmark = { ...(state.benchmark || {}), status: 'idle', progress: 0, runId: null, testTaskId: null, startedAt: null, completedAt: null, durationMs: 0, logs: [], result: null, lastServiceError: null };
      state.decisionReview = createDecisionReviewState('idle');
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null };
      state.agent = {
        ...(state.agent || {}),
        status: 'awaiting_action',
        phase: 'Candidate Plan 已生成',
        progress: 100,
        currentAction: {
          id: `action.${payload.candidateId}.resume`,
          type: 'candidate.plan',
          title: `提交 ${payload.candidateId} 测试`,
          reason: 'Mission 预算兜底结束后恢复：保留已有单文件候选，刷新预算窗口并继续真实 runner 验证。',
          expectedOutput: 'Correctness · Benchmark · Tracer · Profiler',
          risk: 'medium',
          approvalRequired: false,
          approvalPolicy: 'client-controlled',
        },
      };
      appendRuntimeEvent(state, 'mission.resumed_after_budget', { missionId: payload.missionId, candidateId: payload.candidateId, candidateDigest: payload.candidateDigest, missionBudgetMs: payload.missionBudgetMs, missionBudgetStartedAt: payload.missionBudgetStartedAt }, { kind: 'mission', mode: 'client' });
      addAuditEvent(state, 'Mission 已从预算结束态恢复', `${payload.missionTitle} · ${payload.candidateId} · budget ${payload.missionBudgetMs ? `${Math.round(payload.missionBudgetMs / 60 / 60 / 1000)}h` : 'none'}`, 'blue', 'RefreshCw');
    },
  },
  'adopt': {
    tracksEffects: true,
    keyFor: (state) => `adopt:${state.activeMissionId}:${state.appliedCandidateId || state.decisionReview?.candidateId}`,
    isApplied: (state) => state.knowledgeMaintenance?.status === 'completed' && state.publishedAssets?.length === state.knowledgeDrafts?.length,
    apply: (state, payload) => { adoptCandidateState(state, payload?.note || '证据完整且未命中人工复核信号。', 'policy'); },
    prepare: async ({ body }) => ({ payload: { note: body?.note || '' }, result: null }),
  },
  'reject': {
    tracksEffects: true,
    keyFor: (state) => `reject:${state.activeMissionId}:${state.appliedCandidateId || state.decisionReview?.candidateId}`,
    isApplied: (state) => state.decisionReview?.resolution?.outcome === 'supplement' && state.decisionReview?.resolution?.source === 'direct_action',
    apply: (state) => {
      state.stage = 'validation';
      state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
      state.decisionReview = { ...createDecisionReviewState('resolved'), recommendation: null, resolution: { outcome: 'supplement', source: 'direct_action', note: '需要补充验证', resolvedAt: now().toISOString() } };
      state.agent = { ...state.agent, status: 'awaiting_action', phase: '补充验证', currentAction: { id: 'action.revalidation', type: 'test.plan', title: '运行补充验证矩阵', reason: '效果决策要求补充验证。', expectedOutput: 'Updated Full Benchmark · refreshed Level 3 evidence', risk: 'medium', approvalRequired: false } };
      const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
      appendRuntimeEvent(state, 'decision.revalidation_requested', { candidate: candidateId || null, reason: '需要补充验证' }, { kind: 'policy', mode: 'client' });
      addAuditEvent(state, '候选退回验证', `${candidateId || '当前候选'} · 需要补充验证`, 'warning', 'TriangleAlert');
    },
  },
  'request-review': {
    tracksEffects: true,
    keyFor: (state) => `request-review:${state.activeMissionId}`,
    isApplied: (state) => state.decisionReview?.status === 'awaiting_review',
    apply: (state, payload) => {
      const requestedAt = now().toISOString();
      const outcomeMeta = interventionOutcomeMeta[payload.outcome];
      state.decisionReview = {
        ...(state.decisionReview || createDecisionReviewState('auto_ready')),
        status: 'awaiting_review', requiresApproval: true,
        request: { candidateId: payload.candidate || state.appliedCandidateId || null, outcome: payload.outcome, note: payload.note, originStage: payload.originStage, submittedBy: payload.submittedBy || 'Yilin Lu', requestedAt },
        resolution: null, requestedAt, resolvedAt: null,
      };
      state.agent = {
        ...state.agent,
        status: 'awaiting_approval', phase: '人工介入待处理',
        currentAction: { id: 'action.resolve-decision-review', type: 'review.resolve', title: '处理人工介入事项', reason: payload.note, expectedOutput: outcomeMeta.expectedOutput, risk: 'high', approvalRequired: true, reviewMode: 'human_requested' },
        messages: [...(state.agent?.messages || []), { id: `review-${now().getTime()}`, phase: 'approval', status: 'waiting', title: '已收到人工介入意见', detail: `${outcomeMeta.label} · ${payload.note}`, time: '刚刚' }],
      };
      appendRuntimeEvent(state, 'decision.review_requested', { candidate: state.appliedCandidateId || state.decisionReview?.candidateId || null, originStage: payload.originStage, outcome: payload.outcome, note: payload.note }, { kind: 'approval', mode: 'client' });
      addAuditEvent(state, '流程已被人工介入阻塞', `${outcomeMeta.label} · ${payload.note}`, 'warning', 'ShieldCheck');
    },
    prepare: async ({ state, body }) => {
      const outcome = ['adopt', 'supplement', 'redirect'].includes(body.outcome) ? body.outcome : 'redirect';
      const allowedOutcomes = state.stage === 'evidence' ? ['adopt', 'supplement', 'redirect'] : state.stage === 'validation' ? ['supplement', 'redirect'] : ['redirect'];
      if (!allowedOutcomes.includes(outcome)) {
        const error = new Error('当前阶段尚不支持该介入指令，请先查看证据状态。');
        error.status = 409; error.code = 'INTERVENTION_OUTCOME_UNAVAILABLE'; throw error;
      }
      const note = String(body.note || '').trim();
      if (note.length < 4) {
        const error = new Error('请填写具体的审批意见后再提交。');
        error.status = 400; error.code = 'DECISION_REVIEW_NOTE_REQUIRED'; throw error;
      }
      return { payload: { outcome, note, candidate: body.candidate || null, originStage: state.stage, submittedBy: body.submittedBy || null }, result: null };
    },
  },
  'cancel-review': {
    tracksEffects: true,
    keyFor: (state) => `cancel-review:${state.activeMissionId}`,
    isApplied: (state) => !state.decisionReview?.request,
    apply: (state) => {
      const previousRequest = state.decisionReview?.request;
      const candidateId = state.appliedCandidateId || previousRequest?.candidateId || state.decisionReview?.candidateId;
      const restoredStatus = state.stage === 'evidence' ? 'auto_ready' : 'idle';
      const restoredAction = state.stage === 'evidence'
        ? { id: 'action.adoption-decision', type: 'adoption.decision', title: `确认 ${candidateId || '候选'} 的策略建议`, reason: '人工意见已撤回，当前未命中强制复核信号。', expectedOutput: 'Policy Decision · current best update', risk: 'medium', approvalRequired: false, reviewMode: 'conditional' }
        : state.stage === 'validation'
          ? { id: 'action.validation-resumed', type: 'test.plan', title: '继续异构验证', reason: '人工介入已撤回，恢复原验证计划。', expectedOutput: 'Correctness · Full Benchmark · Level 3 evidence', risk: 'medium', approvalRequired: false }
          : { id: 'action.candidate-resumed', type: 'candidate.plan', title: '继续候选自动检查', reason: '人工介入已撤回，恢复原 Candidate Plan 和自动策略。', expectedOutput: 'Candidate Plan · patch proposal', risk: 'medium', approvalRequired: false, approvalPolicy: 'client-controlled' };
      state.decisionReview = { ...createDecisionReviewState(restoredStatus), cancelledRequest: previousRequest || null };
      state.agent = { ...state.agent, status: 'awaiting_action', phase: state.stage === 'evidence' ? '效果策略评估' : state.stage === 'validation' ? '异构验证' : '候选补丁审查', currentAction: restoredAction };
      appendRuntimeEvent(state, 'decision.review_cancelled', { candidate: candidateId || null }, { kind: 'approval', mode: 'client' });
      addAuditEvent(state, '人工审批意见已撤回', '流程恢复为条件式策略决策', 'blue', 'ShieldCheck');
      if (state.stage === 'evidence' && state.benchmark?.status === 'complete') runAutomaticAdoption(state, `人工介入已撤回，Accept Gate 继续按策略自动采用 ${candidateId || '候选'}。`);
    },
  },
  'revert-adoption': {
    tracksEffects: true,
    keyFor: (state) => `revert-adoption:${state.activeMissionId}:${state.currentBest?.candidateId || state.appliedCandidateId}`,
    isApplied: (state) => state.decisionReview?.resolution?.outcome === 'reverted',
    prepare: async ({ state, runEffect }) => {
      const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const repositoryAdoption = state.workflowRecovery?.repositoryAdoption;
      const repositoryRevert = mission.projectRoot && repositoryAdoption?.commit
        ? await runEffect(() => workspaceManager.revertAdoption({ repository: mission.repository, commit: repositoryAdoption.commit }))
        : null;
      const recovery = await runEffect(() => restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId));
      return { payload: { checkpointId: checkpoint.id, recovery, repositoryRevert, repositoryAdoption, revertedAt: now().toISOString(), previousBest: state.workflowRecovery?.previousBest || { candidateId: null, version: 'baseline', value: '--', improvement: '--', status: 'active' } }, result: { recovery, repositoryRevert } };
    },
    apply: (state, payload) => {
      const revertedCandidateId = state.currentBest?.candidateId || state.appliedCandidateId || 'candidate';
      state.currentBest = payload.previousBest;
      state.decisionReview = { ...(state.decisionReview || createDecisionReviewState('resolved')), status: 'resolved', recommendation: null, requiresApproval: false, resolution: { outcome: 'reverted', source: 'human_recovery', note: `已恢复上一稳定版本 ${payload.previousBest.version || 'baseline'}`, resolvedAt: payload.revertedAt }, resolvedAt: payload.revertedAt };
      state.publishedAssets = (state.publishedAssets || []).map((asset) => ({ ...asset, status: 'superseded', supersededAt: payload.revertedAt, supersededBy: `rollback.${payload.previousBest.version || 'baseline'}` }));
      state.knowledgeMaintenance = { ...state.knowledgeMaintenance, rollback: { status: 'completed', reason: `${revertedCandidateId} adoption reverted`, revertedAt: payload.revertedAt }, changes: (state.knowledgeMaintenance?.changes || []).map((change) => ({ ...change, outcome: 'superseded' })) };
      state.agent = { ...state.agent, status: 'completed', phase: '已回退到上一稳定版本', currentAction: null, messages: [...(state.agent?.messages || []), { id: `adoption-revert-${now().getTime()}`, phase: 'decision', status: 'completed', title: '采用结果已回退', detail: `current best 已恢复为 ${payload.previousBest.version || 'baseline'}，${revertedCandidateId} 关联知识已标记为被替代。`, time: '刚刚' }] };
      state.workflowRecovery = {
        ...state.workflowRecovery,
        repositoryAdoption: payload.repositoryRevert ? { ...payload.repositoryAdoption, status: 'reverted', ...payload.repositoryRevert } : payload.repositoryAdoption,
        worktree: { ...state.workflowRecovery.worktree, status: 'reverted', revertedAt: payload.revertedAt },
        lastRecovery: { type: 'adoption_revert', from: revertedCandidateId, to: payload.previousBest.candidateId || 'baseline', checkpointId: payload.checkpointId, restoredAt: payload.recovery.restoredAt },
        invalidatedArtifacts: [...(state.workflowRecovery.invalidatedArtifacts || []), { type: 'decision', id: `decision.${revertedCandidateId}` }, ...(state.publishedAssets || []).map((asset) => ({ type: 'knowledge', id: `${asset.id}@${asset.version}` }))],
      };
      appendRuntimeEvent(state, 'decision.adoption_reverted', { from: revertedCandidateId, to: payload.previousBest.candidateId || 'baseline', checkpointId: payload.checkpointId }, { kind: 'recovery', mode: 'client' });
      appendRuntimeEvent(state, 'knowledge.assets_superseded', { assets: state.publishedAssets.map((asset) => `${asset.id}@${asset.version}`) }, { kind: 'knowledge', mode: 'client' });
      addAuditEvent(state, '已回退到上一稳定版本', `${revertedCandidateId} → ${payload.previousBest.version || 'baseline'} · ${payload.checkpointId}`, 'warning', 'History');
    },
  },
  'resolve-review': {
    tracksEffects: true,
    keyFor: (state, body) => `resolve-review:${state.activeMissionId}:${body?.outcome || state.decisionReview?.request?.outcome}`,
    isApplied: (state) => state.decisionReview?.status === 'resolved',
    prepare: async ({ state, body, runEffect }) => {
      const outcome = body.outcome || state.decisionReview?.request?.outcome;
      const note = String(body.note || state.decisionReview?.request?.note || '').trim();
      if (outcome === 'redirect') {
        const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
        if (!checkpoint) {
          const error = new Error('当前 Mission 没有可恢复的工作区检查点，无法调整优化方向。');
          error.status = 409; error.code = 'WORKSPACE_CHECKPOINT_MISSING'; throw error;
        }
        const recovery = await runEffect(() => restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId));
        return { payload: { outcome, note, checkpointId: checkpoint.id, recovery }, result: { review: null, recovery } };
      }
      return { payload: { outcome, note, checkpointId: null, recovery: null }, result: null };
    },
    apply: (state, payload) => {
      const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
      const resolvedAt = now().toISOString();
      if (payload.outcome === 'adopt') {
        adoptCandidateState(state, payload.note, 'human_review');
        return;
      }
      if (payload.outcome === 'redirect') {
        const invalidatedArtifacts = [
          state.benchmark?.runId ? { type: 'benchmark', id: state.benchmark.runId } : null,
          state.stage === 'evidence' && candidateId ? { type: 'evidence', id: `decision.${candidateId}` } : null,
        ].filter(Boolean);
        state.stage = 'candidate';
        state.patchApplied = false;
        state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
        state.decisionReview = { ...state.decisionReview, status: 'resolved', requiresApproval: false, recommendation: null, resolution: { outcome: payload.outcome, source: 'human_review', note: payload.note, resolvedAt }, resolvedAt };
        state.agent = {
          ...state.agent, status: 'awaiting_action', phase: '调整优化方向',
          currentAction: { id: 'action.redirect-candidate', type: 'candidate.plan', title: '根据人工意见生成新候选方向', reason: payload.note, expectedOutput: 'Revised Candidate Plan · isolated worktree', risk: 'medium', approvalRequired: true, reviewMode: 'resolved' },
          messages: [...(state.agent?.messages || []), { id: `review-redirect-${now().getTime()}`, phase: 'candidate', status: 'completed', title: '人工介入已调整优化方向', detail: `${payload.checkpointId || 'candidate baseline'} 已恢复，${invalidatedArtifacts.length} 个后续工件已失效。`, time: '刚刚' }],
        };
        state.workflowRecovery = {
          ...state.workflowRecovery,
          worktree: { ...state.workflowRecovery?.worktree, status: payload.checkpointId ? 'restored' : 'clean' },
          lastRecovery: payload.checkpointId ? { type: 'intervention_redirect', from: state.decisionReview.request?.originStage || 'workflow', to: 'candidate', checkpointId: payload.checkpointId, restoredAt: payload.recovery.restoredAt } : state.workflowRecovery?.lastRecovery,
          invalidatedArtifacts: [...(state.workflowRecovery?.invalidatedArtifacts || []), ...invalidatedArtifacts],
        };
        appendRuntimeEvent(state, 'decision.review_resolved', { candidate: candidateId || null, outcome: payload.outcome, note: payload.note }, { kind: 'approval', mode: 'client' });
        appendRuntimeEvent(state, 'workflow.redirected_by_intervention', { candidate: candidateId || null, checkpointId: payload.checkpointId || null, invalidatedArtifacts }, { kind: 'recovery', mode: 'client' });
        addAuditEvent(state, '人工介入已调整优化方向', `${payload.checkpointId || 'candidate baseline'} · ${payload.note}`, 'warning', 'GitBranch');
        return;
      }
      // supplement
      state.stage = 'validation';
      state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
      state.decisionReview = { ...state.decisionReview, status: 'resolved', requiresApproval: false, recommendation: null, resolution: { outcome: payload.outcome, source: 'human_review', note: payload.note, resolvedAt }, resolvedAt };
      state.agent = {
        ...state.agent, status: 'awaiting_action', phase: '补充验证',
        currentAction: { id: 'action.supplement-validation', type: 'test.plan', title: '运行补充验证矩阵', reason: payload.note, expectedOutput: 'Updated Full Benchmark · refreshed Level 3 evidence', risk: 'medium', approvalRequired: false, reviewMode: 'resolved' },
        messages: [...(state.agent?.messages || []), { id: `review-resolved-${now().getTime()}`, phase: 'approval', status: 'completed', title: '审批意见已处理', detail: `流程返回验证阶段 · ${payload.note}`, time: '刚刚' }],
      };
      appendRuntimeEvent(state, 'decision.review_resolved', { candidate: candidateId || null, outcome: payload.outcome, note: payload.note }, { kind: 'approval', mode: 'client' });
      addAuditEvent(state, '审批意见已处理：补充验证', payload.note, 'warning', 'TestTube2');
    },
  },
});
