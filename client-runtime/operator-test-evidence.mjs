import { reconcileResourceRelease } from './cancellation-contract.mjs';
import { enqueueTraceRecord } from './iteration-trace.mjs';
import { testTimings } from './generation-origin.mjs';
import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';
import { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';
import { createBaselineRequirementState, createBaselineResolutionState, createBaselineSourcePolicy, createDecisionReviewState, normalizeBaselineKind } from './evidence-state.mjs';
import { buildBaselineEvidence, evaluateAcceptGate } from './accept-gate.mjs';
import { classifyEvidenceDecision } from './knowledge-state.mjs';
import { safeMissionId } from './state-identifiers.mjs';
import { assertPendingTestReceipt } from './pending-test-contract.mjs';
import { canonicalJson } from './execution-package-contract.mjs';
import { isDevelopmentAcceleratorCoreEvidence } from './evidence-decision.mjs';

export const isInfrastructureTestFailure = (failure = {}) => {
  const error = failure.error || failure;
  if (error.role === 'oracle' || ['infrastructure', 'environment', 'transport'].includes(error.category)) return true;
  const code = String(error?.code || failure.code || '').toUpperCase();
  if (code === 'OPERATOR_REFERENCE_CACHE_FAILURE' && error.role === 'backend') return true;
  // 队列等待阶段的 deadline 不是对候选的判断：任务从未提交到后端，没有跑过任何东西，
  // 也就没有任何关于候选的观测。把它当作候选失败会一边把「排队等太久」记成代码错误、
  // 消耗一次修复预算，一边让模型去改一个根本没执行过的实现。
  // 执行阶段的 deadline（phase 是 execution）**故意不在此列**：那时任务确实跑了并且超出了
  // 允许时间，是关于候选的真实观测，只是不该被叙述成 correctness 未通过。
  if (code.includes('DEADLINE') && String(error?.phase || '').toLowerCase().includes('waiting')) return true;
  if (['REMOTE_UNREACHABLE', 'REMOTE_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  // Runner provenance is stronger than arbitrary compiler/candidate text.
  // PyTorch headers such as HermeticPyObjectTLS.h are thread-local storage,
  // not network failures; a candidate exception stays eligible for repair.
  if (error.role === 'candidate') return false;
  const message = [
    error?.message,
    failure.message,
    failure.summary,
    ...(Array.isArray(failure.logs) ? failure.logs.map((log) => log?.message || log?.detail || '') : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /remote api unreachable|\b(?:tls|ssl)\b|socket disconnected|connection refused|connection reset|network timed? ?out|connect timed? ?out|econnreset|econnrefused|etimedout|eai_again|enotfound/.test(message);
};

// Minimal attempt brief (IMPLEMENTATION_MAP §4bis, P2): why this attempt ended and
// what the next one should do about it.
//
// It is a projection, not a new source of truth: `stage` is the runner's own
// `failure.phase` verbatim, `coverage` is the runner's own manifest, and
// `nextAction` is routed by the same `isInfrastructureTestFailure` predicate that
// decides whether the candidate survives — so the brief cannot disagree with the
// branch that acts on it. Nothing here is inferred from a model's narration, and a
// record that predates coverage reports `coverage: null` rather than a fabricated
// one. The vocabulary (`nextAction` values, schema id) lives in the leaf module
// `experiment-brief.mjs`, which admission also reads; re-exported here so the two
// ends cannot drift.
import { EXPERIMENT_BRIEF_SCHEMA_VERSION, NEXT_ACTION_FIX_FAILED_CASE, NEXT_ACTION_RETEST_SAME_CANDIDATE } from './experiment-brief.mjs';
export { EXPERIMENT_BRIEF_SCHEMA_VERSION, NEXT_ACTION_FIX_FAILED_CASE, NEXT_ACTION_RETEST_SAME_CANDIDATE };

const briefText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// `suspectedCause` is a kind plus the evidence it was read from, never a claim. A
// candidate-side throw is the only case where the observation points at the
// candidate's own code; an oracle-side failure points at the frozen contract, and
// everything else stays 'unknown' until someone looks.
// The frozen runner puts the case identity inside the typed error's `details`
// (`{case, caseIndex, category}`), not at the top level; read both spellings so this
// works for the runner's terminal record and for the client-side transport errors.
const briefDetails = (error) => (error?.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {});
// `infraFailure` is passed in rather than recomputed, so the cause and the nextAction
// can never disagree about whether this attempt produced an observation.
const suspectedCause = (error, infraFailure) => {
  const code = briefText(error?.code);
  const role = briefText(error?.role);
  if (role === 'oracle') return { kind: 'oracle_contract', basis: code };
  if (infraFailure) return { kind: 'environment', basis: code };
  if (role === 'candidate') return { kind: 'candidate_implementation', basis: [code, briefText(briefDetails(error).case)].filter(Boolean).join(' @ ') || null };
  return { kind: 'unknown', basis: code };
};

export const createExperimentBrief = ({ result = null, error = null } = {}) => {
  const failure = result?.error || error || null;
  const correctness = result?.correctness || null;
  const coverage = correctness?.coverage ?? null;
  const infraFailure = isInfrastructureTestFailure({ error: failure, result });
  return {
    schemaVersion: EXPERIMENT_BRIEF_SCHEMA_VERSION,
    // The runner reports the phase it failed in. An attempt that never reached the
    // runner (transport failure, pre-submission rejection) has no phase to report and
    // says so, rather than borrowing the phase it would have reached.
    stage: briefText(failure?.phase) || briefText(correctness?.status) || 'not_run',
    failedCase: briefText(correctness?.failedCaseName) ?? briefText(failure?.failedCaseName) ?? briefText(briefDetails(failure).case),
    suspectedCause: suspectedCause(failure, infraFailure),
    nextAction: infraFailure ? NEXT_ACTION_RETEST_SAME_CANDIDATE : NEXT_ACTION_FIX_FAILED_CASE,
    coverage: coverage ? structuredClone(coverage) : null,
  };
};

// 后端/来源名不是硬件目标。真实执行目标只能来自驱动探测结果，绝不从 backend
// 字符串、设备型号或当前宿主环境反推；纯字符串无法证明执行真的探测过目标。
const BACKEND_TARGET_NAMES = new Set(['local-shared-gpu', 'local-c500', 'local-c550', 'local-metax-c500', 'local-ascend910b']);
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
  const developmentNamespace = [environment.source, environment.service].some(value =>
    ['metax-c500', 'local-metax-c500', 'python-metax-c500', 'local-ascend910b', 'ascend910b-adapter'].includes(typeof value === 'string' ? value.trim().toLowerCase() : ''));
  if (developmentNamespace && !isDevelopmentAcceleratorCoreEvidence(environment)) return null;
  const probe = environment.targetProbe && typeof environment.targetProbe === 'object' && !Array.isArray(environment.targetProbe) ? environment.targetProbe : {};
  const hardware = normalizeTargetValues(environment.hardware).filter((item) => !isBackendTargetName(item));
  if (!hardware.length) return null;
  const architecture = normalizeTargetValues(environment.architecture).filter((item) => !isBackendTargetName(item));
  const executionMode = typeof environment.executionMode === 'string' ? environment.executionMode.trim().toLowerCase() : null;
  const targetText = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const device = targetText(environment.device) || targetText(probe.deviceName);
  const driverVersion = targetText(environment.driverVersion) || targetText(probe.driverVersion)
    || (isDevelopmentAcceleratorCoreEvidence(environment) ? targetText(probe.versions?.driver) : null);
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
  return projectOperatorTestSnapshot(state, snapshot);
}

// Explicit settlement reuses the ordinary Gate and failure classification. The
// application supplies a read-only workspace verification, never client input.
export function settlePendingTestSnapshot(state, snapshot, workspaceBinding) {
  const pending = assertPendingTestReceipt(state, snapshot);
  if (state.benchmark.pendingSettlement?.manifestDigest === pending.manifestDigest) return state;
  if (state.benchmark.purpose !== 'candidate' || !['completed', 'failed', 'cancelled'].includes(snapshot.status)
    || snapshot.resourceRelease?.confirmed !== true
    || state.benchmark.snapshotFingerprint !== canonicalJson(snapshot)
    || workspaceBinding?.missionId !== pending.missionId || workspaceBinding?.manifestDigest !== pending.manifestDigest
    || workspaceBinding?.candidateId !== pending.candidateId || workspaceBinding?.patchDigest !== pending.patchDigest
    || state.appliedCandidateId !== pending.candidateId || state.agent?.runId !== pending.sourceRunId) {
    throw Object.assign(new Error('测试尚未结束、资源尚未释放或工作区身份不一致。'), { code: 'PENDING_TEST_SETTLEMENT_INVALID', status: 409 });
  }
  return projectOperatorTestSnapshot(state, snapshot, workspaceBinding);
}

function projectOperatorTestSnapshot(state, snapshot, pendingSettlement = null) {
  if (!snapshot || snapshot.taskId !== state.benchmark?.testTaskId) return state;
  if (state.benchmark.pendingManifestDigest) {
    assertPendingTestReceipt(state, snapshot);
    if (state.benchmark.pendingSettlement) return state;
  }
  const pendingBinding = state.benchmark.pendingManifestDigest ? {
    manifestDigest: state.benchmark.pendingManifestDigest, purpose: state.benchmark.purpose,
    runId: state.benchmark.runId, taskId: state.benchmark.testTaskId,
  } : null;
  // A test result is not proof that an independently owned Agent has exited.
  const preservedAgent = (pendingBinding && !pendingSettlement) || state.agent?.resourceRelease?.confirmed === false || state.agent?.status === 'cancel_requested'
    ? structuredClone(state.agent) : null;
  let projectedTestRunId = null;
  const finish = () => {
    if (pendingBinding && projectedTestRunId
      && state.iterationStats?.pendingTest?.manifestDigest === pendingBinding.manifestDigest
      && snapshot.resourceRelease?.confirmed !== false
      && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
      const baseline = pendingBinding.purpose === 'baseline';
      const status = snapshot.status !== 'completed' ? snapshot.status
        : baseline ? (state.baseline?.status === 'complete' && state.baseline?.evidence?.runId === pendingBinding.runId ? 'baseline_complete' : 'failed')
          : 'results_ready';
      state.iterationStats.pendingTest = { ...state.iterationStats.pendingTest, status,
        completedAt: snapshot.completedAt || null,
        error: structuredClone(snapshot.error || (baseline && status === 'failed' ? state.baseline?.error : null) || null) };
      state.missionPaused = true;
    }
    if (pendingSettlement) {
      state.benchmark.pendingSettlement = structuredClone(pendingSettlement);
      delete state.benchmark.decisionDeferred;
      state.iterationStats.pendingTest = { ...state.iterationStats.pendingTest, status: 'settled',
        settledAt: pendingSettlement.verifiedAt };
    }
    if (projectedTestRunId && state.benchmark?.runId === projectedTestRunId) {
      enqueueTraceRecord(state, 'test', projectedTestRunId, { ...state.benchmark, stageTimings: testTimings(state.benchmark) });
    }
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
  const previousStatus = pendingSettlement ? 'deferred' : state.benchmark.status;
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
    submittedAt: snapshot.submittedAt || (sameRequest ? state.benchmark.submittedAt || null : null),
    submissionStartedAt: snapshot.submissionStartedAt || (sameRequest ? state.benchmark.submissionStartedAt || null : null),
    executionStartedAt: snapshot.executionStartedAt || (sameRequest ? state.benchmark.executionStartedAt || null : null),
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
  // Preserve complete receipt bindings before Baseline settlement clears the slot.
  projectedTestRunId = state.benchmark.runId;
  if (state.benchmark.purpose === 'baseline') enqueueTraceRecord(state, 'test', projectedTestRunId, {
    ...state.benchmark, stageTimings: testTimings(state.benchmark),
  });
  if (pendingBinding && pendingBinding.purpose === 'candidate' && !pendingSettlement) {
    // Frozen test bytes need not match the mutable workspace now. Preserve the
    // receipt, but no Gate/current-best/adoption decision may use that workspace
    // until explicit feedback settlement verifies its identity.
    state.benchmark.decisionDeferred = { reason: 'frozen_candidate_requires_workspace_binding',
      manifestDigest: pendingBinding.manifestDigest };
    state.missionPaused = true;
    if (['complete', 'failed', 'cancelled'].includes(nextStatus) && previousStatus !== nextStatus) {
      appendRuntimeEvent(state, 'pending_candidate.test_finished', { ...pendingBinding,
        status: nextStatus, error: snapshot.error || null }, { kind: 'operator-test-queue', mode: 'client' });
    }
    return finish();
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
      // Recorded on both branches: an infrastructure failure must not be remembered as
      // a candidate failure, but it still has to say why this attempt produced no
      // observation and that the next one is a retest of the same artifact.
      const brief = createExperimentBrief({ result: snapshot.result || null, error: snapshot.error || null });
      state.benchmark = { ...(state.benchmark || {}), experimentBrief: brief };
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
          experimentBrief: brief,
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
    // An unsettled baseline measurement is not a baseline. Every later candidate is
    // judged as an improvement over this number, so recording one the runner itself
    // reported as unrepeatable would anchor the whole Mission to a coin flip. The task
    // did complete, so this retries the measurement rather than failing the Mission.
    if (evidence.settled === false) {
      const unsettledReason = `baseline 主测量读数未稳定：取满 ${evidence.settlements ?? '?'} 次连续结算仍未达成一致。`;
      state.baseline = {
        ...(state.baseline || createBaselineRequirementState()),
        kind: baselineKind,
        status: 'failed',
        error: { code: 'BASELINE_MEASUREMENT_UNSETTLED', message: `${unsettledReason}该数值不能作为比较基准，请重新测量。` },
        failedAt: evidence.completedAt || new Date().toISOString(),
      };
      const unsettledRun = structuredClone(state.benchmark);
      state.stage = state.patchApplied ? 'validation' : 'candidate';
      state.benchmark = {
        status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null,
        durationMs: unsettledRun.durationMs || 0,
        logs: [{ sequence: 1, progress: 100, message: `${unsettledReason}该次测量未作为 ${baselineLabel}。` }],
        matrix: structuredClone(unsettledRun.matrix || state.testMatrix || {}),
        purpose: null, baselineKind: null, candidate: null, testTaskId: null, result: null,
        source: unsettledRun.source || null, lastServiceError: null,
      };
      // The task completed, so this is not a Mission failure: the operator re-submits
      // the same baseline matrix and the next measurement decides. Reusing the existing
      // retry action keeps the runtime's actionable-state vocabulary unchanged.
      state.decisionReview = {
        ...(state.decisionReview || createDecisionReviewState('resolved')),
        status: 'resolved', recommendation: 'baseline', requiresApproval: false,
        resolution: { outcome: 'baseline_unsettled', source: 'baseline_gate', note: `${unsettledReason}需要重新测量后才能建立 ${baselineLabel}。`, resolvedAt: evidence.completedAt },
      };
      state.agent = {
        ...state.agent,
        status: 'awaiting_action',
        phase: 'Baseline 读数未稳定，待重新测量',
        runId: state.agent?.runId || null,
        runtimeKind: state.agent?.runId && (state.candidateEvaluations || []).some(candidate => candidate.sourceRunId === state.agent.runId)
          ? state.agent.runtimeKind || null : null,
        result: null,
        currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '重新测量 baseline', reason: unsettledReason, expectedOutput: 'Baseline Benchmark（同 runner · 同输入 shape）', risk: 'low', approvalRequired: false },
      };
      addAuditEvent(state, 'Baseline 读数未稳定', `${evidence.environment} ${evidence.value}${evidence.unit} · 未作为基准`, 'warning', 'Activity');
      appendRuntimeEvent(state, 'baseline.measurement_unsettled', {
        taskId: snapshot.taskId, runId: unsettledRun.runId,
        value: evidence.value, unit: evidence.unit, settlements: evidence.settlements ?? null,
      }, { kind: 'operator-test-service', mode: snapshot.result?.environment?.liveHardware ? 'live' : 'mock' });
      return finish();
    }
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
      runtimeKind: state.agent?.runId && (state.candidateEvaluations || []).some(candidate => candidate.sourceRunId === state.agent.runId)
          ? state.agent.runtimeKind || null : null,
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
