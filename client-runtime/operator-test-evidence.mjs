import { reconcileResourceRelease } from './cancellation-contract.mjs';
import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';
import { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';
import { createBaselineRequirementState, createBaselineResolutionState, createBaselineSourcePolicy, createDecisionReviewState, normalizeBaselineKind } from './evidence-state.mjs';
import { buildBaselineEvidence, evaluateAcceptGate } from './accept-gate.mjs';
import { classifyEvidenceDecision } from './knowledge-state.mjs';
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

// 后端/来源名不是硬件目标。真实执行目标只能来自驱动探测结果，绝不从 backend
// 字符串、设备型号或当前宿主环境反推；纯字符串无法证明执行真的探测过目标。
const BACKEND_TARGET_NAMES = new Set(['local-shared-gpu', 'local-c500', 'local-c550']);
export const isBackendTargetName = (value) => typeof value === 'string' && BACKEND_TARGET_NAMES.has(value.trim().toLowerCase());

const normalizeTargetValues = (value) => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= 16) break;
  }
  return result;
};

// 返回 null 表示「本轮没有可信的实际执行目标」：此时必须保留旧目标，不得清空。
// 探测凭据是 environment.targetProbe 中真实的 deviceName/driverVersion，或归一化后的
// environment.device + environment.driverVersion。仅硬件/架构字符串不构成执行已探测的证明，
// 因此 shared-GPU 预检失败结果里硬编码的 hardware="nvidia-gpu" 不会覆盖历史目标。
// CPU 的 terminal completed 结果（hardware=cpu 且 executionMode=cpu）可独立保留，不要求 GPU 探测。
export const extractEnvironmentTarget = (environment, { status } = {}) => {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null;
  const probe = environment.targetProbe && typeof environment.targetProbe === 'object' && !Array.isArray(environment.targetProbe) ? environment.targetProbe : {};
  const hardware = normalizeTargetValues(environment.hardware).filter((item) => !isBackendTargetName(item));
  if (!hardware.length) return null;
  const architecture = normalizeTargetValues(environment.architecture).filter((item) => !isBackendTargetName(item));
  const executionMode = typeof environment.executionMode === 'string' ? environment.executionMode.trim().toLowerCase() : null;
  const targetText = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const device = targetText(environment.device) || targetText(probe.deviceName);
  const driverVersion = targetText(environment.driverVersion) || targetText(probe.driverVersion);
  const probed = Boolean(device && driverVersion);
  const cpuDeclared = status === 'completed' && executionMode === 'cpu' && hardware.length === 1 && hardware[0] === 'cpu';
  if (!probed && !cpuDeclared) return null;
  return {
    hardware,
    architecture,
    device,
    driverVersion,
    backend: typeof environment.source === 'string' && environment.source.trim() ? environment.source.trim().toLowerCase() : null,
    executionMode,
  };
};

const projectResolvedTarget = (state, snapshot) => {
  const activeMissionId = typeof state?.activeMissionId === 'string' && state.activeMissionId ? state.activeMissionId : null;
  if (!activeMissionId) return;
  // 任务与 Mission 的归属以提交载荷为准；显式属于别的 Mission 的结果绝不能污染本 Mission。
  if (snapshot?.payload?.missionId != null && snapshot.payload.missionId !== activeMissionId) return;
  const result = snapshot?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  if (result.experienceEvidence?.missionId != null && result.experienceEvidence.missionId !== activeMissionId) return;
  const target = extractEnvironmentTarget(result.environment, { status: snapshot.status });
  if (!target) return;
  const sourceRunId = [snapshot.payload?.requestId, result.experienceEvidence?.runId, snapshot.runId, state.benchmark?.runId]
    .find((value) => typeof value === 'string' && value) || null;
  const previous = state.iterationStats?.resolvedTarget?.missionId === activeMissionId ? state.iterationStats.resolvedTarget : null;
  const mission = state.missions?.find((item) => item.id === activeMissionId);
  const constraints = [
    ['previous', previous && { hardware: normalizeTargetValues(previous.hardware), architecture: normalizeTargetValues(previous.architecture) }],
    ['mission', { hardware: normalizeTargetValues(mission?.hardware).filter((item) => !isBackendTargetName(item)), architecture: normalizeTargetValues(mission?.architecture) }],
  ];
  const issues = [];
  for (const [source, expected] of constraints) {
    if (!expected) continue;
    for (const field of ['hardware', 'architecture']) {
      if (expected[field].length && (!target[field].length || target[field].some((value) => !expected[field].includes(value)))) issues.push({ source, field, expected: expected[field], actual: target[field] });
    }
  }
  const mismatch = issues.length ? { missionId: activeMissionId, sourceTaskId: snapshot.taskId, runId: sourceRunId, issues, detectedAt: snapshot.completedAt || new Date().toISOString() } : null;
  const existingMismatches = state.iterationStats?.resolvedTargetMismatches || [];
  const seen = mismatch && existingMismatches.some((item) => item.sourceTaskId === mismatch.sourceTaskId && JSON.stringify(item.issues) === JSON.stringify(mismatch.issues));
  state.iterationStats = {
    ...(state.iterationStats || {}),
    resolvedTarget: {
      missionId: activeMissionId,
      hardware: target.hardware,
      ...(target.architecture.length ? { architecture: target.architecture } : {}),
      device: target.device,
      driverVersion: target.driverVersion,
      backend: target.backend,
      executionMode: target.executionMode,
      sourceTaskId: snapshot.taskId || null,
      sourceRunId,
      resolvedAt: snapshot.completedAt || new Date().toISOString(),
    },
    ...(mismatch ? { resolvedTargetMismatch: mismatch, resolvedTargetMismatches: seen ? existingMismatches : [...existingMismatches, mismatch].slice(-10) } : {}),
  };
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
  // 同一终态快照的重复投影必须完全无副作用：重复 tick / JSON 恢复不得新增
  // events、时间戳、候选处置或资产版本。
  const canonicalSnapshot = (value) => Array.isArray(value) ? value.map(canonicalSnapshot)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSnapshot(value[key])])) : value;
  const snapshotFingerprint = JSON.stringify(canonicalSnapshot(snapshot));
  const terminalReplay = ['complete', 'failed', 'cancelled'].includes(previousStatus)
    && ['completed', 'failed', 'cancelled'].includes(snapshot.status)
    && state.benchmark.snapshotFingerprint === snapshotFingerprint;
  if (terminalReplay) return finish();
  const nextStatus = snapshot.resourceRelease?.confirmed === false ? 'running' : snapshot.status === 'completed' ? 'complete' : snapshot.status === 'failed' ? 'failed' : snapshot.status === 'cancelled' ? 'cancelled' : 'running';
  // 后端任务身份只来自快照显式携带的 remoteTaskId；队列 testTaskId 不是它的替代，
  // 绝不能回填。快照省略 remoteTaskId 时，只有同一 request（同一 payload.requestId）
  // 已记录过的身份才可保留；新 request 绝不继承上一个 run 的 backend taskId。
  const requestId = snapshot.payload?.requestId != null ? snapshot.payload.requestId : (state.benchmark?.requestId ?? null);
  const snapshotRunId = snapshot.payload?.runId != null ? snapshot.payload.runId : null;
  const sameRequest = (snapshot.payload?.requestId != null && state.benchmark?.requestId != null
      && snapshot.payload.requestId === state.benchmark.requestId)
    || (snapshotRunId != null && state.benchmark?.runId != null && snapshotRunId === state.benchmark.runId
      && (snapshot.payload?.requestId == null || state.benchmark?.requestId == null));
  state.benchmark = {
    ...state.benchmark,
    snapshotFingerprint,
    status: nextStatus,
    ...(snapshot.resourceRelease ? { resourceRelease: structuredClone(snapshot.resourceRelease) } : {}),
    progress: Number(snapshot.progress || 0),
    requestId,
    remoteTaskId: snapshot.remoteTaskId != null
      ? snapshot.remoteTaskId
      : (sameRequest ? (state.benchmark?.remoteTaskId ?? null) : null),
    logs: Array.isArray(snapshot.logs) ? structuredClone(snapshot.logs) : [],
    completedAt: snapshot.completedAt || null,
    durationMs: Number(snapshot.durationMs || state.benchmark.durationMs || 0),
    result: snapshot.result ? structuredClone(snapshot.result) : state.benchmark.result || null,
    source: { kind: 'operator-test-service', mock: snapshot.result?.environment?.liveHardware === false },
    lastServiceError: snapshot.error ? structuredClone(snapshot.error) : null,
  };
  reconcileResourceRelease(state);
  // 终态结果才投影实际执行目标；baseline 分支随后清空 benchmark 也不影响它
  // （目标存放在 iterationStats，随 Mission 持久化/切换）。
  if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) projectResolvedTarget(state, snapshot);
  if (snapshot.payload?.semanticBinding || state.benchmark.semanticBinding) {
    state.benchmark.semanticBinding = structuredClone(snapshot.payload?.semanticBinding || state.benchmark.semanticBinding);
    if (state.benchmark.result && typeof state.benchmark.result === 'object') {
      state.benchmark.result.semanticBinding = structuredClone(state.benchmark.semanticBinding);
    }
  }
  if (snapshot.payload?.packageDigest && snapshot.payload?.admissionId) {
    state.benchmark.executionPackage = {
      packageDigest: snapshot.payload.packageDigest,
      admissionId: snapshot.payload.admissionId,
      preparedArtifactDigest: snapshot.payload.preparedArtifactDigest || state.benchmark.executionPackage?.preparedArtifactDigest || null,
      environmentDigest: snapshot.payload.environmentDigest,
      acceptanceDigest: snapshot.payload.acceptanceDigest,
      workspaceId: snapshot.payload.workspaceId,
      target: structuredClone(snapshot.payload.target),
      build: structuredClone(snapshot.payload.build || {}),
      adapter: structuredClone(snapshot.payload.adapter),
    };
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
  const decision = gate.decision || null;
  // 生产的唯一决策真相：完整深拷贝到 benchmark，候选 Gate 与 review Gate 保留同一值。
  if (decision) state.benchmark.evidenceDecision = structuredClone(decision);
  const candidateId = state.appliedCandidateId || state.benchmark?.candidate?.id || null;
  const recommendation = gate.result === 'eligible' ? 'adopt' : gate.result === 'reference' ? 'reference' : 'reject';
  applyGateDisposition(state, candidateId, gate, decision);
  if (gate.passed && isManagedWorkspaceRuntimeMode(state.agent?.runtimeKind)) ensureEvidenceKnowledgeDraft(state, candidateId, gate);
  appendRuntimeEvent(state, 'accept_gate.evaluated', { candidate: candidateId, result: gate.result, passed: gate.passed, rules: gate.rules }, { kind: 'policy', mode: 'client' });
  // 必需真实诊断缺失是可恢复的：保留候选与隔离工作区，进入可恢复等待，绝不启动新 Agent
  // 去“补工具”或改写代码。人工审批仍优先阻塞，不被该分支覆盖。
  if (decision?.adoption?.status === 'waiting_external_verification' && state.decisionReview?.status !== 'awaiting_review') {
    // 重复投影同一等待决策是幂等的：已处于同一候选/运行的等待状态时不产生新事件、
    // 时间戳或状态改写。
    const alreadyWaiting = state.decisionReview?.status === 'waiting_external_verification'
      && state.decisionReview?.candidateId === candidateId
      && state.decisionReview?.gate?.decision?.binding?.runId === decision.binding?.runId
      && state.missionPaused === true
      && state.iterationStats?.loopStatus === 'blocked'
      && state.iterationStats?.loopStatusReason === 'external_verification';
    if (alreadyWaiting) return finish();
    const decisionClone = structuredClone(decision);
    state.decisionReview = {
      ...(state.decisionReview || createDecisionReviewState('auto_ready')),
      status: 'waiting_external_verification',
      candidateId,
      recommendation: 'reference',
      gate,
      decision: decisionClone,
      evidenceDecision: decisionClone,
      requiresApproval: false,
      gateEvaluatedAt: state.benchmark.completedAt,
      resolution: null,
    };
    state.agent = {
      ...state.agent,
      status: 'awaiting_action',
      phase: '等待外部诊断验证',
      currentAction: {
        id: 'action.external-verification',
        type: 'test.plan',
        title: '恢复后重试同一候选',
        reason: '正确性与 Benchmark 证据完整，但缺少绑定当前候选/运行的真实诊断采集。系统保留候选、工作区与预算记录，不生成新候选或修改代码；外部诊断可用后恢复并重试同一候选。',
        expectedOutput: '真实 mcTracer / mcProfiler 证据 · Accept Gate 重评',
        risk: 'low',
        approvalRequired: false,
      },
    };
    // 复用已有 missionPaused / loopStatus blocked 机制，并给出 external_verification 原因。
    state.missionPaused = true;
    state.iterationStats = {
      ...(state.iterationStats || {}),
      loopStatus: 'blocked',
      loopStatusReason: 'external_verification',
    };
    addAuditEvent(state, '等待外部诊断验证', `${candidateId || 'candidate'} · 缺少必需真实诊断，候选与工作区已保留`, 'warning', 'Clock');
    appendRuntimeEvent(state, 'accept_gate.waiting_external_verification', {
      candidate: candidateId,
      runId: state.benchmark?.runId || null,
      reasons: decision.adoption.reasons,
      publication: decision.publication?.status || null,
    }, { kind: 'policy', mode: 'client' });
    return finish();
  }
  // 不再等待（例如恢复后同一候选重试已产生合格诊断）：只清除 external_verification
  // 编排阻塞标记，恢复可继续的循环状态；既有证据决策、候选与预算事实不变。
  if (state.iterationStats?.loopStatusReason === 'external_verification') {
    const { externalVerificationAcknowledged: _ack, ...restStats } = state.iterationStats;
    state.iterationStats = { ...restStats, loopStatus: 'running', loopStatusReason: null };
    state.missionPaused = false;
  }
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

const applyGateDisposition = (state, candidateId, gate, decision = gate?.decision || null) => {
  if (!candidateId) return;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  if (!candidate) return;
  // 候选 Gate 与 review Gate 保存同一决策对象；decision 与 benchmark.evidenceDecision 同值。
  candidate.acceptGate = gate;
  candidate.evidenceRunId = state.benchmark?.runId || null;
  if (gate.result === 'eligible') {
    candidate.classification = 'eligible';
    candidate.status = 'Accept Gate 已通过';
    candidate.decision = '等待策略自动采用';
    candidate.decisionReason = gate.summary;
    return;
  }
  if (gate.result === 'reference') {
    const waiting = decision?.adoption?.status === 'waiting_external_verification';
    candidate.classification = 'reference';
    candidate.status = waiting ? '等待外部诊断验证' : '弱候选参考';
    candidate.tone = 'reference';
    candidate.decision = waiting ? '暂缓采用，候选与工作区保留等待外部诊断' : '未采用，保留为弱候选参考';
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
  // 只按同一 evidenceDecision 分类：真实但不可发布 => development（明确不可发布）；
  // 显式模拟/CPU => simulation；publication allowed 才 validated。旧无 decision 保守 unknown，
  // 绝不从 Level 3 或 live 布尔自动授权。
  const decision = gate?.decision || state.benchmark?.evidenceDecision || null;
  const classification = classifyEvidenceDecision(decision);
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
    contraindications: classification.publishable
      ? '工作区 Diff、环境、测试矩阵或硬件范围变化时必须重新验证。'
      : `明确不可发布：${classification.reason}`,
    failedAttempts: '无',
    evidence: `${state.benchmark?.runId} · ${gate.passedRules.length}/${gate.evaluatedRules} required gates · ${classification.publication}`,
    evidenceLevel: classification.evidenceLevel,
    confidence: classification.confidence,
    evidenceDecision: decision ? structuredClone(decision) : null,
    publication: classification.publication,
    publishable: classification.publishable,
    evidenceRefs: [state.activeMissionId, candidateId, candidate.patchDigest, state.benchmark?.runId, state.benchmark?.result?.tracer?.format, state.benchmark?.result?.profiler?.format].filter(Boolean),
    // 显式绑定身份：治理回填只认 candidateId+digest+runId 全匹配，绝不缺省匹配。
    evidenceBinding: {
      candidateId,
      candidateDigest: candidate.patchDigest || state.benchmark?.candidate?.digest || null,
      runId: state.benchmark?.runId || null,
    },
    sourceMission: state.activeMissionId,
    sourceCandidate: candidateId,
    sourceCommit: state.workflowRecovery?.worktree?.head || 'isolated-worktree',
    owner: 'Operator Studio',
    status: classification.draftStatus,
  }];
};
