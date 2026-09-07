import { reconcileResourceRelease } from './cancellation-contract.mjs';
import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';
import { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';
import { createBaselineRequirementState, createBaselineResolutionState, createBaselineSourcePolicy, createDecisionReviewState, normalizeBaselineKind } from './evidence-state.mjs';
import { buildBaselineEvidence, evaluateAcceptGate } from './accept-gate.mjs';
import { safeMissionId } from './state-identifiers.mjs';

export const isInfrastructureTestFailure = (failure = {}) => {
  const error = failure.error || failure;
  if (error.role === 'oracle' || ['infrastructure', 'environment', 'transport'].includes(error.category)) return true;
  const code = String(error?.code || failure.code || '').toUpperCase();
  const message = [
    error?.message,
    failure.message,
    failure.summary,
    ...(Array.isArray(failure.logs) ? failure.logs.map((log) => log?.message || log?.detail || '') : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (['REMOTE_UNREACHABLE', 'REMOTE_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  return /remote api unreachable|tls|ssl|socket disconnected|connection refused|connection reset|network timed? ?out|connect timed? ?out|econnreset|econnrefused|etimedout|eai_again|enotfound/.test(message);
};

export function applyOperatorTestSnapshot(state, snapshot) {
  if (!snapshot || snapshot.taskId !== state.benchmark?.testTaskId) return state;
  // A test result is not proof that an independently owned Agent has exited.
  const preservedAgent = state.agent?.resourceRelease?.confirmed === false || state.agent?.status === 'cancel_requested'
    ? structuredClone(state.agent) : null;
  const finish = () => {
    if (preservedAgent) state.agent = preservedAgent;
    return state;
  };
  if (!snapshot.resourceRelease && state.benchmark.resourceRelease?.confirmed === false
    && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    snapshot = {
      ...snapshot,
      resourceRelease: {
        ...state.benchmark.resourceRelease,
        confirmed: false,
        status: 'unconfirmed',
        reason: 'Legacy terminal snapshot does not confirm release of the outstanding execution resource.',
        nextAction: 'Continue observing the owning backend until resource release is confirmed.',
      },
    };
  }
  const previousStatus = state.benchmark.status;
  const nextStatus = snapshot.resourceRelease?.confirmed === false ? 'running' : snapshot.status === 'completed' ? 'complete' : snapshot.status === 'failed' ? 'failed' : snapshot.status === 'cancelled' ? 'cancelled' : 'running';
  state.benchmark = {
    ...state.benchmark,
    status: nextStatus,
    ...(snapshot.resourceRelease ? { resourceRelease: structuredClone(snapshot.resourceRelease) } : {}),
    progress: Number(snapshot.progress || 0),
    logs: Array.isArray(snapshot.logs) ? structuredClone(snapshot.logs) : [],
    completedAt: snapshot.completedAt || null,
    durationMs: Number(snapshot.durationMs || state.benchmark.durationMs || 0),
    result: snapshot.result ? structuredClone(snapshot.result) : state.benchmark.result || null,
    source: { kind: 'operator-test-service', mock: snapshot.result?.environment?.liveHardware === false },
    lastServiceError: snapshot.error ? structuredClone(snapshot.error) : null,
  };
  reconcileResourceRelease(state);
  if (snapshot.payload?.semanticBinding || state.benchmark.semanticBinding) {
    state.benchmark.semanticBinding = structuredClone(snapshot.payload?.semanticBinding || state.benchmark.semanticBinding);
    if (state.benchmark.result && typeof state.benchmark.result === 'object') {
      state.benchmark.result.semanticBinding = structuredClone(state.benchmark.semanticBinding);
    }
  }
  if (nextStatus === 'cancelled') {
    state.agent = {
      ...state.agent,
      status: 'cancelled',
      phase: '测试已取消',
      progress: state.benchmark.progress,
      currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '重新提交测试矩阵', reason: '本次测试已取消，候选仍保留在隔离工作区。', expectedOutput: 'Correctness · Benchmark · Tracer · Profiler', risk: 'low', approvalRequired: false },
    };
    if (previousStatus !== 'cancelled') {
      addAuditEvent(state, '算子测试已取消', `Queue ${snapshot.taskId}`, 'warning', 'CircleStop');
      appendRuntimeEvent(state, 'operator_test.cancelled', { taskId: snapshot.taskId, runId: state.benchmark.runId }, { kind: 'operator-test-queue', mode: 'client' });
    }
    return finish();
  }
  if (nextStatus === 'failed') {
    if (state.benchmark?.purpose === 'baseline') {
      // Keep the baseline projection truthful. Previously only benchmark.status
      // changed, which rendered as "baseline running · benchmark failed" in TUI.
      state.baseline = {
        ...(state.baseline || createBaselineRequirementState()),
        status: 'failed',
        error: snapshot.error ? structuredClone(snapshot.error) : { code: 'BASELINE_TEST_FAILED', message: 'Baseline operator test failed.' },
        failedAt: snapshot.completedAt || new Date().toISOString(),
      };
    }
    // 测试提交/执行失败：恢复 test.plan 动作，操作员可直接重试（否则 guard 拦死，流程卡在 validation）
    if (previousStatus !== 'failed') {
      const candidateId = state.appliedCandidateId || state.benchmark?.candidate?.id || null;
      const failedSummary = snapshot.error?.message || snapshot.result?.summary || '执行失败';
      const infraFailure = isInfrastructureTestFailure(snapshot);
      if (isManagedWorkspaceRuntimeMode(state.agent?.runtimeKind) && state.benchmark?.purpose === 'candidate' && !infraFailure) {
        state.stage = 'diagnosis';
        state.decisionReview = {
          ...(state.decisionReview || createDecisionReviewState('resolved')),
          status: 'resolved',
          candidateId,
          recommendation: 'reject',
          requiresApproval: false,
          resolution: { outcome: 'reject', source: 'operator_test', note: failedSummary, resolvedAt: snapshot.completedAt || new Date().toISOString() },
          resolvedAt: snapshot.completedAt || new Date().toISOString(),
        };
        state.failureRecords = [{
          id: `fail.${Date.now()}`,
          title: `候选测试失败：${candidateId || 'candidate'}`,
          candidateId,
          failure: { code: snapshot.error?.code || 'OPERATOR_TEST_FAILED', message: failedSummary },
          decisionReason: failedSummary,
          extractedExperience: { status: 'extracted', summary: failedSummary },
          createdAt: snapshot.completedAt || new Date().toISOString(),
        }, ...(state.failureRecords || [])].slice(0, 20);
        state.candidateEvaluations = (state.candidateEvaluations || []).map((candidate) => candidate.id === candidateId
          ? { ...candidate, classification: 'rejected', status: '测试失败', decision: 'reject', decisionReason: failedSummary, tone: 'red' }
          : candidate);
        state.agent = {
          ...state.agent,
          status: 'completed',
          phase: '候选测试失败，继续优化',
          currentAction: null,
        };
      } else {
        state.agent = {
          ...state.agent,
          status: 'awaiting_action',
          phase: infraFailure ? '远端测试基础设施待恢复' : '异构验证待重试',
          currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '重新提交测试矩阵', reason: infraFailure ? '远端 API / runner 基础设施暂不可达，候选未被判定失败，恢复后可重试同一候选。' : '本次测试提交/执行失败，候选仍保留在隔离工作区，可重试。', expectedOutput: 'Correctness · Benchmark · Tracer · Profiler', risk: infraFailure ? 'low' : 'medium', approvalRequired: false },
        };
      }
      addAuditEvent(state, infraFailure ? '远端测试基础设施不可达' : '算子测试失败', `Queue ${snapshot.taskId} · ${snapshot.error?.message || '执行失败'}`, infraFailure ? 'warning' : 'error', infraFailure ? 'RefreshCw' : 'XCircle');
      appendRuntimeEvent(state, infraFailure ? 'operator_test.infra_failed' : 'operator_test.failed', { taskId: snapshot.taskId, runId: state.benchmark.runId, error: snapshot.error?.message || null, errorCode: snapshot.error?.code || null }, { kind: 'operator-test-queue', mode: 'client' });
    }
    return finish();
  }
  if (nextStatus !== 'complete') return finish();

  state.stage = 'evidence';
  if (state.benchmark?.purpose === 'baseline') {
    const evidence = buildBaselineEvidence(state, snapshot.result || {});
    const baselineKind = normalizeBaselineKind(evidence.kind);
    const baselineLabel = baselineKind === 'naive_v0' ? 'naive v0 baseline' : 'PyTorch reference baseline';
    const previousKind = normalizeBaselineKind(state.baseline?.kind);
    state.baseline = {
      ...(state.baseline || createBaselineRequirementState()),
      sourcePolicy: createBaselineSourcePolicy(baselineKind, previousKind === baselineKind ? state.baseline?.sourcePolicy : undefined),
      kind: evidence.kind,
      status: 'complete',
      source: evidence.source || state.baseline?.source || null,
      evidence,
      resolution: {
        ...(state.baseline?.resolution || createBaselineResolutionState({}, baselineKind)),
        status: 'resolved',
        strategy: baselineKind === 'naive_v0' ? 'fallback_naive_v0' : 'authoritative_first',
        kind: baselineKind,
        attemptedAuthority: baselineKind !== 'pytorch_reference',
        reused: false,
        reason: baselineKind === 'naive_v0'
          ? '权威算子库 baseline 不可用，已使用基于 v0 的 naive 单文件 baseline。'
          : '已使用权威算子库 reference 的单文件展开版本建立 baseline。',
        resolvedAt: evidence.completedAt,
        previousEvidenceRunId: evidence.runId || null,
      },
    };
    if (previousStatus !== 'complete') {
      addAuditEvent(state, `${baselineLabel} completed`, `${evidence.environment} ${evidence.value}${evidence.unit}`, 'green', 'Baseline');
      appendRuntimeEvent(state, 'baseline.completed', {
        taskId: snapshot.taskId,
        runId: state.benchmark.runId,
        baseline: structuredClone(evidence),
      }, { kind: 'operator-test-service', mode: snapshot.result?.environment?.liveHardware ? 'live' : 'mock' });
    }
    const completedBaselineRun = structuredClone(state.benchmark);
    state.stage = state.patchApplied ? 'validation' : 'candidate';
    state.benchmark = {
      status: 'idle',
      progress: 0,
      runId: null,
      startedAt: null,
      completedAt: null,
      durationMs: completedBaselineRun.durationMs || 0,
      logs: [{ sequence: 1, progress: 100, message: `${baselineLabel} 已完成：${evidence.environment} ${evidence.value}${evidence.unit}` }],
      matrix: structuredClone(completedBaselineRun.matrix || state.testMatrix || {}),
      purpose: null,
      baselineKind: null,
      candidate: null,
      testTaskId: null,
      result: null,
      source: completedBaselineRun.source || null,
      lastServiceError: null,
    };
    state.decisionReview = {
      ...(state.decisionReview || createDecisionReviewState('resolved')),
      status: 'resolved',
      recommendation: 'baseline',
      requiresApproval: false,
      resolution: { outcome: 'baseline', source: 'baseline_gate', note: `${baselineLabel} 已建立，后续优化候选可进入 Accept Gate。`, resolvedAt: evidence.completedAt },
    };
    state.agent = {
      ...state.agent,
      status: 'awaiting_action',
      phase: 'Baseline 已建立',
      runId: state.agent?.runId || null,
      runtimeKind: null,
      result: null,
      currentAction: state.patchApplied
        ? { id: 'action.validation-after-baseline', type: 'test.plan', title: '提交优化候选测试', reason: `同 runner / 同 shape 的 ${baselineLabel} 已完成，且候选补丁已应用。`, expectedOutput: 'Candidate Benchmark · Accept Gate compare', risk: 'medium', approvalRequired: false }
        : { id: 'action.optimize-after-baseline', type: 'candidate.plan', title: '生成或提交优化候选', reason: `同 runner / 同 shape 的 ${baselineLabel} 已完成。`, expectedOutput: 'Candidate Patch · optimized run.py · benchmark compare', risk: 'medium', approvalRequired: false },
    };
    return finish();
  }

  if (previousStatus !== 'complete') {
    const measurements = snapshot.result?.benchmark || [];
    const summary = measurements.map((item) => `${item.environment} ${item.value}${item.unit}`).join(' / ') || 'Benchmark completed';
    addAuditEvent(state, 'Operator benchmark completed', summary, 'green', 'CheckCircle2');
    appendRuntimeEvent(state, 'operator_test.completed', {
      taskId: snapshot.taskId,
      runId: state.benchmark.runId,
      benchmark: structuredClone(measurements),
      tracerFormat: snapshot.result?.tracer?.format || null,
      profilerFormat: snapshot.result?.profiler?.format || null,
    }, { kind: 'operator-test-service', mode: snapshot.result?.environment?.liveHardware ? 'live' : 'mock' });
  }
  const gate = evaluateAcceptGate(state, snapshot.result || {});
  const candidateId = state.appliedCandidateId || state.benchmark?.candidate?.id || null;
  const recommendation = gate.result === 'eligible' ? 'adopt' : gate.result === 'reference' ? 'reference' : 'reject';
  applyGateDisposition(state, candidateId, gate);
  if (gate.passed && isManagedWorkspaceRuntimeMode(state.agent?.runtimeKind)) ensureEvidenceKnowledgeDraft(state, candidateId, gate);
  appendRuntimeEvent(state, 'accept_gate.evaluated', { candidate: candidateId, result: gate.result, passed: gate.passed, rules: gate.rules }, { kind: 'policy', mode: 'client' });
  if (state.decisionReview?.status === 'awaiting_review') {
    state.decisionReview = { ...state.decisionReview, candidateId, recommendation, gate, gateEvaluatedAt: state.benchmark.completedAt };
    state.agent = {
      ...state.agent,
      status: 'awaiting_approval',
      phase: 'Human intervention pending',
      currentAction: { ...(state.agent?.currentAction || {}), type: 'review.resolve', approvalRequired: true, reviewMode: 'human_requested' },
    };
  } else {
    state.decisionReview = {
      ...(state.decisionReview || createDecisionReviewState('auto_ready')),
      status: gate.passed ? 'auto_ready' : 'resolved',
      candidateId,
      recommendation,
      gate,
      requiresApproval: false,
      gateEvaluatedAt: state.benchmark.completedAt,
      resolution: gate.passed ? null : { outcome: recommendation, source: 'accept_gate', note: gate.summary, resolvedAt: state.benchmark.completedAt },
    };
    state.agent = {
      ...state.agent,
      status: gate.passed ? 'awaiting_action' : 'completed',
      phase: gate.passed ? 'Accept Gate 已通过' : gate.result === 'reference' ? '候选保留为参考' : '候选验证失败',
      currentAction: gate.passed ? {
        id: 'action.adoption-decision',
        type: 'adoption.decision',
        title: 'Accept Gate 已通过，策略将自动采用',
        reason: gate.summary,
        expectedOutput: '更新 current best 并自动沉淀知识',
        risk: 'low',
        approvalRequired: false,
        reviewMode: 'conditional',
      } : null,
    };
  }
  return finish();
}

const applyGateDisposition = (state, candidateId, gate) => {
  if (!candidateId) return;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  if (!candidate) return;
  candidate.acceptGate = gate;
  if (gate.result === 'eligible') {
    candidate.classification = 'eligible';
    candidate.status = 'Accept Gate 已通过';
    candidate.decision = '等待策略自动采用';
    candidate.decisionReason = gate.summary;
    return;
  }
  if (gate.result === 'reference') {
    candidate.classification = 'reference';
    candidate.status = '弱候选参考';
    candidate.tone = 'reference';
    candidate.decision = '未采用，保留为弱候选参考';
    candidate.decisionReason = gate.summary;
    return;
  }
  const failedAt = new Date().toISOString();
  state.failureRecords = [{
    id: `failure.${candidateId}.${Date.now()}`,
    recordType: 'failure',
    sourceAttempt: candidateId,
    label: `${candidate.label || candidateId} Failure Record`,
    version: candidate.version || 'agent.1',
    date: failedAt,
    status: '已退出候选池',
    tone: 'failed',
    title: candidate.title,
    hypothesis: candidate.hypothesis,
    change: candidate.change,
    files: candidate.files,
    evidence: state.benchmark?.runId || 'operator test',
    decision: 'Accept Gate 硬门禁失败，禁止形成候选',
    decisionReason: gate.summary,
    failure: { gate: 'Accept Gate', code: 'ACCEPT_GATE_HARD_FAILURE', failedRules: gate.failedRules, disposition: 'candidate_removed' },
    retainedArtifacts: [candidate.patchDigest, state.benchmark?.runId, state.benchmark?.result?.tracer?.format, state.benchmark?.result?.profiler?.format].filter(Boolean),
    extractedExperience: { id: `negative.${candidateId}`, status: 'extracted', title: `${candidate.title} 的失败边界`, rule: gate.summary, reuse: `后续候选必须先满足：${gate.failedRules.join('、')}`, evidenceLevel: 'negative evidence' },
  }, ...(state.failureRecords || [])];
  state.candidateEvaluations = state.candidateEvaluations.filter((item) => item.id !== candidateId);
};

const ensureEvidenceKnowledgeDraft = (state, candidateId, gate) => {
  if (!candidateId || state.knowledgeDrafts?.some((draft) => draft.sourceCandidate === candidateId)) return;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  if (!candidate) return;
  const measurements = state.benchmark?.result?.benchmark || [];
  state.knowledgeDrafts = [...(state.knowledgeDrafts || []), {
    id: `exp.${safeMissionId(state.activeMissionId).toLowerCase()}.${candidateId}`,
    code: `EXP-${Date.now().toString(36).toUpperCase()}`,
    category: 'Mission 验证经验',
    title: candidate.title,
    conclusion: candidate.change || candidate.hypothesis,
    scope: `${(mission.hardware || []).join(' / ') || '目标硬件'} · ${mission.metric || '性能指标'}`,
    hardware: mission.hardware || [],
    operator: mission.title || 'operator',
    dtype: '由项目配置继承',
    layout: '由项目配置继承',
    shape: '由测试矩阵继承',
    runtime: state.benchmark?.result?.environment?.runtime || 'client-managed-runtime',
    trigger: candidate.hypothesis,
    procedure: `应用 Patch ${candidate.patchDigest}，通过串行测试队列执行 Correctness、Benchmark、Tracer 与 Profiler。`,
    expectedGain: measurements.map((item) => `${item.environment} ${item.value}${item.unit}`).join(' · '),
    validation: gate.summary,
    constraints: `仅适用于本次已验证的 Mission 范围；${gate.skippedRules.length ? '未评估规则不得外推。' : '所有配置门禁均已评估。'}`,
    contraindications: '工作区 Diff、环境、测试矩阵或硬件范围变化时必须重新验证。',
    failedAttempts: '无',
    evidence: `${state.benchmark?.runId} · ${gate.passedRules.length}/${gate.evaluatedRules} required gates`,
    evidenceLevel: gate.publishable ? 'Level 3' : '模拟证据',
    confidence: gate.publishable ? '中' : '仅供流程验证',
    evidenceRefs: [state.activeMissionId, candidateId, candidate.patchDigest, state.benchmark?.runId, state.benchmark?.result?.tracer?.format, state.benchmark?.result?.profiler?.format].filter(Boolean),
    sourceMission: state.activeMissionId,
    sourceCandidate: candidateId,
    sourceCommit: state.workflowRecovery?.worktree?.head || 'isolated-worktree',
    owner: 'Operator Studio',
    status: gate.publishable ? 'validated' : 'simulation',
  }];
};
