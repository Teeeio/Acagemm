import { createBestCandidateExport } from '../best-candidate-export.mjs';
import { canonicalJson } from '../execution-package-contract.mjs';
import { pendingTestIdentity, assertPendingTestAdmission } from '../pending-test-contract.mjs';
import { throwPreparationFailure } from '../generation-preparation.mjs';

export const createCandidateValidationService = ({ loadState, persistState, executeCommand, journal, registry, guardSupportedRuntimeAction, guardMutation = () => {}, guardWorkflowTransition, readPendingCandidate } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || typeof guardSupportedRuntimeAction !== 'function' || typeof guardWorkflowTransition !== 'function') {
    throw new TypeError('Candidate validation service requires state, command, guard, journal, and registry dependencies.');
  }

  const execute = (state, type, body = {}) => executeCommand({ journal, saveState: persistState, registry, state, type, body, expectedVersion: state.stateVersion });

  const getPendingCandidate = async (missionId) => {
    const state = await loadState();
    const mission = state.missions?.find((item) => item.id === missionId);
    if (!mission) throw Object.assign(new Error('任务不存在。'), { status: 404, code: 'MISSION_NOT_FOUND' });
    const pending = (state.activeMissionId === missionId ? state.iterationStats : mission.iterationStats)?.pendingValidation;
    if (!pending || pending.missionId !== missionId) throw Object.assign(new Error('此任务没有已冻结的待测候选。'), { status: 404, code: 'PENDING_CANDIDATE_NOT_FOUND' });
    if (typeof readPendingCandidate !== 'function') throw Object.assign(new Error('待测候选导出尚未接入。'), { status: 503, code: 'PENDING_CANDIDATE_STORE_UNAVAILABLE' });
    // The store verifies frozen bytes; never reconstruct an export from the
    // mutable workspace or advance the workflow during a snapshot query.
    return { pendingValidation: structuredClone(pending), bundle: await readPendingCandidate(pending) };
  };

  const getBestCandidate = async missionId => {
    const state = await loadState();
    const mission = state.missions?.find(item => item.id === missionId);
    if (!mission) throw Object.assign(new Error('任务不存在。'), { status: 404, code: 'MISSION_NOT_FOUND' });
    const best = state.activeMissionId === missionId ? state.currentBest : mission.currentBest;
    if (!best?.candidateId) throw Object.assign(new Error('此任务还没有已验收并保留的最佳候选。'), { status: 404, code: 'BEST_CANDIDATE_NOT_FOUND' });
    if (!best.frozenCandidate?.reference) throw Object.assign(new Error('此旧最佳候选没有绑定冻结源码工件，不能用待测候选或当前工作树代替。'), { status: 409, code: 'BEST_CANDIDATE_SOURCE_UNAVAILABLE' });
    if (typeof readPendingCandidate !== 'function') throw Object.assign(new Error('冻结候选存储尚未接入。'), { status: 503, code: 'PENDING_CANDIDATE_STORE_UNAVAILABLE' });
    const bundle = await readPendingCandidate(best.frozenCandidate.reference);
    if (mission.semanticSnapshot?.digest !== bundle.manifest.semanticDigest
      || ['objective', 'operatorProfile', 'metric', 'hardware', 'targetProfile', 'implementation', 'sourcePolicy'].some(field =>
        canonicalJson(mission[field] ?? null) !== canonicalJson(bundle.manifest.mission[field] ?? null))) {
      throw Object.assign(new Error('任务条件与最佳候选的冻结合同不同，请保留原记录并先处理配置变更。'), { status: 409, code: 'BEST_CANDIDATE_CONTRACT_CHANGED' });
    }
    return createBestCandidateExport({ best, bundle });
  };

  const applyPatch = async (body = {}) => {
    await guardSupportedRuntimeAction('Patch');
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate'], actionType: 'candidate.plan', label: 'Patch 自动策略检查' });
    if (!body.candidate) {
      const error = new Error('候选标识不能为空。'); error.status = 409; error.code = 'CANDIDATE_MISMATCH'; throw error;
    }
    return execute(state, 'apply-patch', body);
  };

  const startBenchmark = async (body = {}) => {
    if (Object.hasOwn(body, 'pendingManifestDigest')) throw Object.assign(new Error('请使用冻结候选提交入口。'), { code: 'PENDING_TEST_EXPLICIT_ENTRY_REQUIRED', status: 400 });
    const state = await loadState();
    guardMutation(state);
    const purpose = body.purpose === 'baseline' || body.testPurpose === 'baseline' ? 'baseline' : 'candidate';
    if (purpose === 'baseline') {
      guardWorkflowTransition(state, { stages: ['diagnosis', 'candidate', 'validation'], label: 'Baseline 提交' });
    } else {
      guardWorkflowTransition(state, { stages: ['validation'], actionType: 'test.plan', label: 'Benchmark 提交' });
      if (!state.patchApplied) return { statusCode: 409, payload: { error: '请先应用候选补丁。', code: 'PATCH_REQUIRED_BEFORE_CANDIDATE_BENCHMARK' } };
    }
    const matrix = body.matrix || state.testMatrix;
    if (!Array.isArray(matrix?.environments) || !matrix.environments.length || !Array.isArray(matrix?.stages) || !matrix.stages.length) {
      return { statusCode: 400, payload: { error: '本次测试矩阵至少需要一个环境和一个验证阶段。', code: 'TEST_MATRIX_INVALID' } };
    }
    const candidateId = body.candidate || state.appliedCandidateId;
    if (purpose !== 'baseline' && !candidateId) {
      return { statusCode: 409, payload: { error: '无法确定本次测试对应的候选，请重新应用候选 Patch。', code: 'TEST_CANDIDATE_MISSING' } };
    }
    return { result: await execute(state, 'start-benchmark', body) };
  };

  const submitPendingCandidate = async (missionId, body = {}) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'manifestDigest')) {
      throw Object.assign(new Error('冻结候选提交只接受 manifestDigest，代码与测试配置来自冻结记录。'), { code: 'PENDING_TEST_REQUEST_INVALID', status: 400 });
    }
    const state = await loadState();
    const identity = { missionId, manifestDigest: body.manifestDigest };
    pendingTestIdentity(state, identity);
    const submission = state.iterationStats.pendingTest;
    if (submission?.manifestDigest === body.manifestDigest && submission.status !== 'baseline_complete') {
      const receipt = submission.candidate || submission.baseline;
      if (receipt?.taskId) return { status: 'skipped_idempotent', state, result: structuredClone(receipt) };
    }
    assertPendingTestAdmission(state, identity);
    return execute(state, 'start-benchmark', { pendingManifestDigest: body.manifestDigest,
      purpose: submission?.status === 'baseline_complete' ? 'candidate' : 'baseline' });
  };

  const newPendingAttempt = async (missionId, body = {}) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'manifestDigest')
      || typeof body.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.manifestDigest)) {
      throw Object.assign(new Error('新尝试只接受冻结候选的 manifestDigest。'), { code: 'PENDING_TEST_REQUEST_INVALID', status: 400 });
    }
    const state = await loadState();
    const prior = await journal.findByKey(`pending-attempt:${missionId}:${body.manifestDigest}`);
    // Recovery commits the snapshot before acknowledging the journal entry.
    // That committed cursor plus the exact child lineage is also an idempotent
    // receipt; active selection has already moved away from the parent.
    if (['prepared', 'applied'].includes(prior?.status) && prior.missionId === missionId
      && Number(state.commandJournalSeq) >= Number(prior.seq) && prior.result?.started === false
      && state.missions?.some(m => m.id === prior.result?.missionId
        && m.attemptOrigin?.missionId === missionId && m.attemptOrigin?.manifestDigest === body.manifestDigest)) {
      return { status: 'skipped_idempotent', state, result: structuredClone(prior.result) };
    }
    pendingTestIdentity(state, { missionId, manifestDigest: body.manifestDigest });
    return execute(state, 'new-pending-attempt', body);
  };

  const rollbackStage = async () => {
    await guardSupportedRuntimeAction('Workflow Rollback');
    const state = await loadState();
    guardMutation(state);
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('请先撤回待处理的人工意见，再返回上一步。'); error.status = 409; error.code = 'DECISION_REVIEW_PENDING'; throw error;
    }
    guardWorkflowTransition(state, { stages: ['validation', 'evidence'], label: '返回上一步' });
    return execute(state, 'rollback-stage');
  };

  const pendingFeedbackAction = async (missionId, body, type) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'manifestDigest')) {
      throw Object.assign(new Error('反馈操作只接受 manifestDigest。'), { code: 'PENDING_TEST_REQUEST_INVALID', status: 400 });
    }
    const state = await loadState();
    // A repeated continue returns the committed original run, even if it has
    // already frozen a later candidate. It never launches another generation.
    if (type === 'continue-pending-candidate' && state.activeMissionId === missionId) {
      const previous = await journal.findByKey(`pending-continue:${missionId}:${body.manifestDigest}`);
      if (previous?.status === 'applied' && previous.missionId === missionId && previous.result?.runId) {
        return { status: 'skipped_idempotent', state, result: structuredClone(previous.result) };
      }
    }
    pendingTestIdentity(state, { missionId, manifestDigest: body.manifestDigest });
    return throwPreparationFailure(await execute(state, type, body));
  };
  const settlePendingCandidate = (missionId, body = {}) => pendingFeedbackAction(missionId, body, 'settle-pending-candidate');
  const continuePendingCandidate = (missionId, body = {}) => pendingFeedbackAction(missionId, body, 'continue-pending-candidate');

  return Object.freeze({ applyPatch, startBenchmark, rollbackStage, getPendingCandidate, getBestCandidate, submitPendingCandidate,
    settlePendingCandidate, continuePendingCandidate, newPendingAttempt });
};
