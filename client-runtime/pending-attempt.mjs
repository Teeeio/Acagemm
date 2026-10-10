import { pendingTestIdentity, assertPendingTestReceipt } from './pending-test-contract.mjs';
import { assertPendingFeedbackContract } from './pending-feedback.mjs';
import { inspectRoundBudget, expireRoundBudget } from './round-budget-contract.mjs';
import { assertResourcesReleased, pendingMissionResources } from './cancellation-contract.mjs';
import { applyOperatorTestSnapshot } from './operator-test-evidence.mjs';
import { createSemanticSnapshot } from './semantic-snapshot.mjs';
import { appendRuntimeEvent } from './runtime-events.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

// A new attempt is a new paused Mission. The old clocks, terminal tasks and
// evidence remain attached to their original identities, never reused as new evidence.
export const preparePendingAttempt = (state, bundle, snapshot, { missionState, missionId, nowMs = Date.now() }) => {
  const pending = pendingTestIdentity(state, { missionId: state.activeMissionId, manifestDigest: bundle.manifestDigest });
  assertPendingFeedbackContract(state, bundle);
  if (state.workflowRecovery?.commandRecovery?.status === 'blocked') throw fail('COMMAND_RECOVERY_BLOCKED', '请先完成原命令的恢复。');
  const parent = structuredClone(state);
  if (parent.iterationStats.pendingTest?.baseline?.taskId || parent.iterationStats.pendingTest?.candidate?.taskId) {
    assertPendingTestReceipt(parent, snapshot);
    if (!['completed', 'failed', 'cancelled'].includes(snapshot.status) || snapshot.resourceRelease?.confirmed !== true) {
      throw fail('PENDING_ATTEMPT_TEST_ACTIVE', '原测试尚未结束或未确认释放资源。');
    }
    applyOperatorTestSnapshot(parent, snapshot);
  } else if (snapshot) throw fail('PENDING_TEST_RECEIPT_MISMATCH', '没有对应原测试，不能接收回执。');
  assertResourcesReleased(parent);
  if (pendingMissionResources(parent).length) throw fail('PENDING_ATTEMPT_RESOURCE_ACTIVE', '请先等待原任务的执行资源释放。');
  const round = inspectRoundBudget(parent, { nowMs });
  if (round.status === 'invalid' || round.roundId !== pending.roundId) throw fail('PENDING_TEST_ROUND_INVALID', '原轮次计时记录无效。');
  const budget = parent.missionBudgetMs;
  if (budget != null && (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(Date.parse(parent.missionBudgetStartedAt)))) {
    throw fail('MISSION_BUDGET_INVALID', '原任务预算记录无效。');
  }
  const missionExpired = budget != null && nowMs >= Date.parse(parent.missionBudgetStartedAt) + budget;
  if (!round.expired && !missionExpired) throw fail('PENDING_ATTEMPT_NOT_EXPIRED', '原预算尚未耗尽，请通过原任务接收结果或继续迭代。');
  const manifest = bundle.manifest;
  const original = parent.missions.find(m => m.id === pending.missionId);
  const baseline = manifest.baseline.metadata;
  if (!baseline?.kind || !baseline.source) throw fail('PENDING_TEST_BASELINE_PROVENANCE_MISSING', '冻结副本缺少原基线来源。');
  const origin = {
    schemaVersion: 'operator-studio.attempt-origin/v1', missionId: pending.missionId,
    experimentId: original.experiment?.id || null, roundId: pending.roundId,
    candidateId: pending.candidateId, sourceRunId: pending.sourceRunId,
    manifestDigest: pending.manifestDigest, patchDigest: pending.patchDigest,
    testRunId: snapshot?.payload?.requestId || null, taskId: snapshot?.taskId || null,
    terminalStatus: snapshot?.status || 'not_submitted',
    reason: missionExpired ? 'mission_budget_expired' : 'round_budget_expired',
    createdAt: new Date(nowMs).toISOString(), initialSource: 'frozen-candidate',
  };
  const oracleRunPy = Buffer.from(bundle.baseline.content, 'base64').toString('utf8');
  const input = {
    ...structuredClone(manifest.mission), projectId: original.projectId,
    missionPaused: true, executionMode: 'generate-only', missionBudgetMs: budget,
    testMatrix: structuredClone(manifest.testMatrix),
    baseline: { required: true, kind: baseline.kind, status: 'missing', source: structuredClone(baseline.source),
      sourcePolicy: structuredClone(baseline.sourcePolicy), oracleRunPy,
      materializer: { status: 'completed', mode: 'artifact-import', source: { kind: 'frozen-candidate-bundle',
        manifestDigest: pending.manifestDigest, missionId: pending.missionId }, result: { runPy: oracleRunPy } } },
    experiment: { id: `experiment_${missionId}` },
  };
  // Reuse semantic requirements, but create a fresh Mission/snapshot identity.
  input.semanticSnapshot = createSemanticSnapshot({ mission: { ...input, id: missionId }, snapshot: {
    ...structuredClone(manifest.semanticSnapshot), missionId, snapshotId: `SEM_${missionId}`,
    status: 'draft', digest: null, createdAt: origin.createdAt, updatedAt: origin.createdAt,
    projection: { ...structuredClone(manifest.semanticSnapshot.projection), id: missionId },
  } });
  // Validate through the canonical creation transition without publishing state.
  const planned = missionState.createMission(structuredClone(parent), input, { missionId });
  const mission = structuredClone(planned.missions.find(m => m.id === missionId));
  mission.attemptOrigin = origin;
  // Carry only the actual frozen baseline source declaration, not a research
  // run or the prior task's general suggestions/experience/candidate evidence.
  mission.researchNotes = [{ id: `baseline-provenance-${missionId}`, kind: 'inherited-baseline-provenance',
    summary: '独立基线来源随冻结工件继承；本任务尚未进行研究或测试。',
    baselineSources: [structuredClone(baseline.source)], origin: structuredClone(origin) }];
  return { mission, pending: structuredClone(pending), parentSnapshot: structuredClone(snapshot), origin };
};

export const applyPendingAttempt = (state, payload, missionState) => {
  const { mission, origin, parentSnapshot } = payload;
  pendingTestIdentity(state, { missionId: origin.missionId, manifestDigest: origin.manifestDigest });
  if (state.missions.some(item => item.id === mission.id)) throw fail('PENDING_ATTEMPT_ID_CONFLICT', '新任务身份已存在。');
  if (parentSnapshot) applyOperatorTestSnapshot(state, parentSnapshot);
  expireRoundBudget(state, { nowMs: Date.parse(origin.createdAt) });
  state.missionPaused = true;
  state.iterationStats = { ...state.iterationStats, loopStatus: 'paused_budget',
    loopStatusReason: origin.reason === 'mission_budget_expired' ? 'total_budget' : 'round_budget' };
  appendRuntimeEvent(state, 'pending_candidate.new_attempt', { ...origin, nextMissionId: mission.id }, { kind: 'policy', mode: 'client' });
  missionState.projectActiveMission(state);
  state.missions.unshift(structuredClone(mission));
  missionState.selectMission(state, mission.id);
  appendRuntimeEvent(state, 'mission.attempt_created', origin, { kind: 'policy', mode: 'client' });
  return state;
};
