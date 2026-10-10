import { pendingTestIdentity } from './pending-test-contract.mjs';
import { settlePendingTestSnapshot, isInfrastructureTestFailure } from './operator-test-evidence.mjs';
import { runAutomaticAdoption } from './knowledge-state.mjs';
import { settleIterationEvidenceRound, detectLoopGuard, remainingMissionBudgetMs } from './iteration-loop.mjs';
import { assertResourcesReleased, pendingMissionResources } from './cancellation-contract.mjs';
import { ensureRoundBudgetStarted } from './round-budget-contract.mjs';
import { appendRuntimeEvent, addAuditEvent } from './runtime-events.mjs';
import { bindRetainedBestCandidate } from './best-candidate-export.mjs';
import { canonicalJson } from './execution-package-contract.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

// Admission for learning from an explicitly received frozen test. This binding
// permits verification only; the execution verifier still decides eligibility.
export const pendingExperienceBinding = (state, mission) => {
  const feedback = state.iterationStats?.pendingFeedback;
  const pending = pendingTestIdentity(state, { missionId: mission.id, manifestDigest: feedback?.manifestDigest });
  const benchmark = state.benchmark;
  if (mission.executionMode !== 'generate-only' || !mission.projectId
    || feedback?.schemaVersion !== 'operator-studio.pending-feedback/v1'
    || !['ready', 'blocked'].includes(feedback.status)
    || state.iterationStats.pendingTest?.status !== 'settled'
    || feedback.missionId !== mission.id || feedback.taskId !== benchmark?.testTaskId
    || feedback.testRunId !== benchmark?.runId || benchmark.purpose !== 'candidate'
    || benchmark.resourceRelease?.confirmed !== true
    || !['complete', 'failed', 'cancelled'].includes(benchmark.status)
    || ['candidateId', 'patchDigest', 'sourceRunId', 'roundId'].some(key => feedback[key] !== pending[key])
    || benchmark.candidate?.id !== pending.candidateId || benchmark.candidate?.digest !== pending.patchDigest) {
    throw fail('ROUND_EXPERIENCE_PENDING_CONFLICT', 'Experience collection does not match the received frozen candidate test.');
  }
  return { missionId: mission.id, projectId: mission.projectId, manifestDigest: pending.manifestDigest,
    candidateId: pending.candidateId, patchDigest: pending.patchDigest, sourceRunId: pending.sourceRunId,
    roundId: pending.roundId, taskId: feedback.taskId, testRunId: feedback.testRunId,
    feedbackStatus: feedback.status, feedbackReason: feedback.reason };
};

export const assertPendingFeedbackContract = (state, bundle) => {
  const pending = pendingTestIdentity(state, { missionId: state.activeMissionId, manifestDigest: bundle.manifestDigest });
  const mission = state.missions.find(item => item.id === state.activeMissionId);
  if (mission.semanticSnapshot?.digest !== pending.semanticDigest
    || canonicalJson(state.testMatrix) !== canonicalJson(bundle.manifest.testMatrix)
    || ['objective', 'operatorProfile', 'metric', 'hardware', 'targetProfile', 'implementation', 'sourcePolicy'].some(field =>
      canonicalJson(mission[field] ?? null) !== canonicalJson(bundle.manifest.mission[field] ?? null))
    || (state.objective != null && canonicalJson(state.objective) !== canonicalJson(bundle.manifest.mission.objective))) {
    throw fail('PENDING_FEEDBACK_CONTRACT_CHANGED', '任务语义或验收条件已改变，不能用旧测试推进当前任务。');
  }
  return pending;
};

export const settlePendingFeedback = (state, snapshot, workspaceBinding, { nowMs = Date.now() } = {}) => {
  const pending = pendingTestIdentity(state, workspaceBinding);
  if (state.iterationStats.pendingFeedback?.manifestDigest === pending.manifestDigest) return state;
  if (state.iterationStats.roundBudget?.roundId !== pending.roundId) throw fail('PENDING_TEST_ROUND_INVALID', '测试属于其他轮次。');
  assertResourcesReleased(state);
  if (pendingMissionResources(state).some(({ snapshot: resource }) => resource.resourceRelease?.confirmed !== true)) {
    throw fail('PENDING_TEST_RESOURCE_BUSY', '原执行资源仍未确认释放。');
  }
  const stopped = state.iterationStats.loopStatus === 'stopped';
  settlePendingTestSnapshot(state, snapshot, workspaceBinding);
  const infra = snapshot.status === 'failed' && isInfrastructureTestFailure(snapshot);
  const waiting = ['awaiting_review', 'waiting_external_verification'].includes(state.decisionReview?.status);
  let accounting = null;
  if (!infra && snapshot.status !== 'cancelled' && !waiting) {
    if (snapshot.status === 'completed') runAutomaticAdoption(state, '冻结副本测试已核对，按原 Accept Gate 记录候选结果。');
    // This path retains an evidence result; it never publishes or writes back a
    // repository. Explicit continuation is still a separate admitted command.
    state.agent = { ...state.agent, status: 'completed', currentAction: null };
    if (state.benchmark.status === 'complete') state.stage = state.benchmark.evidenceDecision?.correctness?.passed === true ? 'evidence' : 'diagnosis';
    if (snapshot.status === 'completed') bindRetainedBestCandidate(state, pending, { settledAt: new Date(nowMs).toISOString() });
    accounting = settleIterationEvidenceRound(state, { nowMs });
  }
  const reason = stopped ? 'mission_stopped' : infra ? 'infrastructure_failure'
    : snapshot.status === 'cancelled' ? 'test_cancelled' : waiting ? state.decisionReview.status
      : !accounting ? 'evidence_not_settled' : null;
  const feedback = { schemaVersion: 'operator-studio.pending-feedback/v1',
    missionId: pending.missionId, manifestDigest: pending.manifestDigest, candidateId: pending.candidateId,
    patchDigest: pending.patchDigest, sourceRunId: pending.sourceRunId, roundId: pending.roundId,
    taskId: snapshot.taskId, testRunId: state.benchmark.runId, status: reason ? 'blocked' : 'ready', reason,
    accounting: accounting?.action || null, outcome: state.decisionReview?.resolution?.outcome || null,
    settledAt: new Date(nowMs).toISOString() };
  state.iterationStats = { ...state.iterationStats, pendingFeedback: feedback,
    loopStatus: stopped ? 'stopped' : 'blocked', loopStatusReason: stopped ? state.iterationStats.loopStatusReason : reason || 'pending_feedback_ready' };
  state.missionPaused = true;
  appendRuntimeEvent(state, 'pending_candidate.feedback_settled', feedback, { kind: 'policy', mode: 'client' });
  addAuditEvent(state, '冻结候选结果已接收', reason || '已记录评价，可显式继续下一轮生成。', reason ? 'warning' : 'blue', 'CheckCircle2');
  return state;
};

// Return a clone for run preparation. Keeping the original pending record until
// the run command commits makes a failed/unknown start recoverable.
export const preparePendingContinuation = (state, identity, { nowMs = Date.now() } = {}) => {
  const pending = pendingTestIdentity(state, identity);
  const feedback = state.iterationStats.pendingFeedback;
  if (feedback?.manifestDigest !== pending.manifestDigest || feedback.status !== 'ready'
    || feedback.sourceRunId !== state.agent?.runId || feedback.testRunId !== state.benchmark?.runId
    || feedback.taskId !== state.benchmark?.testTaskId || state.iterationStats.pendingTest?.status !== 'settled') {
    throw fail('PENDING_FEEDBACK_NOT_READY', '测试反馈尚不能用于继续生成。');
  }
  assertResourcesReleased(state);
  if (pendingMissionResources(state).some(({ snapshot }) => snapshot.resourceRelease?.confirmed !== true)) {
    throw fail('PENDING_TEST_RESOURCE_BUSY', '原执行资源仍未确认释放。');
  }
  if (state.iterationStats.loopStatus === 'stopped' || state.workflowRecovery?.commandRecovery?.status === 'blocked') {
    throw fail('PENDING_CONTINUATION_BLOCKED', '任务已停止或有待恢复命令。');
  }
  if (state.missionBudgetMs != null && (!Number.isFinite(state.missionBudgetMs) || state.missionBudgetMs <= 0
    || !Number.isFinite(Date.parse(state.missionBudgetStartedAt)))) throw fail('MISSION_BUDGET_INVALID', '任务预算记录无效。');
  const clone = structuredClone(state);
  clone.iterationStats = { ...clone.iterationStats, pendingValidation: null, pendingTest: null,
    loopStatus: 'running', loopStatusReason: null };
  const reason = detectLoopGuard(clone, { nowMs });
  if (reason || remainingMissionBudgetMs(clone, { nowMs }) < 1000) {
    throw fail('PENDING_CONTINUATION_LIMIT', `当前任务不能启动下一次生成：${reason || 'total_budget'}。`);
  }
  ensureRoundBudgetStarted(clone, { nowMs,
    completedRoundId: feedback.accounting === 'round_counted' && clone.iterationStats.roundBudget?.status === 'completed'
      ? pending.roundId : null });
  clone.missionPaused = false;
  return clone;
};
