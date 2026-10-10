import { canonicalJson, contentDigest } from './execution-package-contract.mjs';
import { inspectRoundBudget } from './round-budget-contract.mjs';
import { assertResourcesReleased, pendingMissionResources } from './cancellation-contract.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

export const pendingTestIdentity = (state, { missionId, manifestDigest } = {}) => {
  const pending = state.iterationStats?.pendingValidation;
  if (!missionId || state.activeMissionId !== missionId || !pending || pending.missionId !== missionId
    || !manifestDigest || pending.manifestDigest !== manifestDigest) {
    throw fail('PENDING_TEST_IDENTITY_MISMATCH', '待测候选已变更或不属于当前任务，请刷新后提交。');
  }
  return pending;
};

// Queue ownership is required even for a raw, ungraded terminal receipt. A
// task id alone cannot authorize replacement of another candidate's evidence.
export const assertPendingTestReceipt = (state, snapshot) => {
  const benchmark = state.benchmark;
  const pending = pendingTestIdentity(state, { missionId: state.activeMissionId, manifestDigest: benchmark?.pendingManifestDigest });
  const submission = state.iterationStats.pendingTest;
  const receipt = submission?.[benchmark.purpose];
  const payload = snapshot?.payload;
  if (submission?.manifestDigest !== pending.manifestDigest || !receipt?.taskId || !receipt.runId
    || snapshot?.taskId !== receipt.taskId || benchmark.testTaskId !== receipt.taskId
    || benchmark.runId !== receipt.runId || payload?.requestId !== receipt.runId
    || payload?.missionId !== pending.missionId || payload?.purpose !== benchmark.purpose
    || payload?.candidate?.id !== benchmark.candidate?.id || payload?.candidate?.digest !== benchmark.candidate?.digest
    || (benchmark.purpose === 'candidate' && (payload.candidate.id !== pending.candidateId
      || payload.candidate.digest !== pending.patchDigest || payload.candidate.sourceRunId !== pending.sourceRunId))) {
    throw fail('PENDING_TEST_RECEIPT_MISMATCH', '测试回执与冻结候选的任务、运行或代码身份不一致。');
  }
  const evidence = snapshot.result?.experienceEvidence;
  if (evidence && (evidence.missionId !== pending.missionId || evidence.runId !== receipt.runId
    || evidence.candidateId !== payload.candidate.id || evidence.patchDigest !== payload.candidate.digest)) {
    throw fail('PENDING_TEST_RECEIPT_MISMATCH', '测试证据声明了其他任务或候选，不能接收。');
  }
  return pending;
};

// Admission is separate from the ordinary mutation guard: a frozen Mission is
// deliberately paused, but explicit testing must still respect resource/budget
// ownership. No clock is started, extended or renewed here.
export const assertPendingTestAdmission = (state, identity, { nowMs = Date.now() } = {}) => {
  const pending = pendingTestIdentity(state, identity);
  assertResourcesReleased(state);
  if (state.iterationStats?.loopStatus === 'stopped') throw fail('MISSION_STOPPED', '任务已停止，不能提交新的测试。');
  if (state.workflowRecovery?.commandRecovery?.status === 'blocked') throw fail('COMMAND_RECOVERY_BLOCKED', '请先处理未完成命令的恢复状态。');
  if (pendingMissionResources(state).some(({ snapshot }) => snapshot.resourceRelease?.confirmed !== true)) {
    throw fail('PENDING_TEST_RESOURCE_BUSY', '生成或测试资源仍在使用中，不能提交另一项测试。');
  }
  const budget = inspectRoundBudget(state, { nowMs });
  if (budget.status !== 'active' || budget.roundId !== pending.roundId) {
    throw fail(budget.expired ? 'ROUND_BUDGET_EXCEEDED' : 'PENDING_TEST_ROUND_INVALID', '原轮次预算已结束或身份不一致；本次提交不会重置预算。');
  }
  let remainingMs = budget.remainingMs;
  if (state.missionBudgetMs != null) {
    const started = Date.parse(state.missionBudgetStartedAt);
    if (!Number.isFinite(started) || !Number.isFinite(state.missionBudgetMs) || state.missionBudgetMs <= 0) {
      throw fail('MISSION_BUDGET_INVALID', '任务预算记录无效，不能隐式重置。');
    }
    remainingMs = Math.min(remainingMs, state.missionBudgetMs - Math.max(0, nowMs - started));
    if (remainingMs <= 0) throw fail('MISSION_BUDGET_EXCEEDED', '任务时间预算已耗尽。');
  }
  if (remainingMs < 1000) throw fail('ROUND_BUDGET_EXCEEDED', '剩余预算不足以提交测试。');
  return { pending, remainingMs };
};

const textFile = (file) => {
  const bytes = Buffer.from(file.content, 'base64');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw fail('PENDING_TEST_ENTRYPOINT_ENCODING', '执行入口必须是有效的 UTF-8 文件。');
  return text;
};

// Accept only a bundle already verified by the immutable-store port. Binary
// dependencies keep their base64 representation through journal serialization.
export const pendingTestInputs = (state, bundle, identity, { nowMs = Date.now() } = {}) => {
  const { pending, remainingMs } = assertPendingTestAdmission(state, identity, { nowMs });
  const manifest = bundle.manifest;
  if (bundle.manifestDigest !== pending.manifestDigest || manifest.missionId !== pending.missionId
    || manifest.candidateId !== pending.candidateId || manifest.patchDigest !== pending.patchDigest
    || canonicalJson(manifest.roundBudget) !== canonicalJson(state.iterationStats.roundBudget)) {
    throw fail('PENDING_TEST_BUNDLE_MISMATCH', '冻结候选与原轮次记录不一致。');
  }
  const metadata = manifest.baseline?.metadata;
  if (!metadata?.kind || !metadata.source) {
    throw fail('PENDING_TEST_BASELINE_PROVENANCE_MISSING', '此旧候选未冻结基线来源，不能借用当前基线的来源信息。');
  }
  const baselineRunPy = textFile(bundle.baseline);
  const materializer = metadata.materializer;
  if (materializer && materializer.runPyDigest !== contentDigest(baselineRunPy)) {
    throw fail('PENDING_TEST_BASELINE_PROVENANCE_MISMATCH', '冻结的独立基线与材料化来源不一致。');
  }
  const baseline = { required: true, ...structuredClone(metadata), oracleRunPy: baselineRunPy,
    ...(materializer ? { materializer: { source: materializer.source,
      result: { ...materializer.result, runPy: baselineRunPy } } } : {}) };
  const mission = { ...structuredClone(manifest.mission), semanticSnapshot: structuredClone(manifest.semanticSnapshot), baseline };
  // The frozen bundle also retains read-only oracle sources for provenance and
  // workspace checks. They are not implementation dependencies: acceptance is
  // supplied independently from the frozen baseline. Use frozen roles rather
  // than a filename convention or the current editable Mission configuration.
  const oraclePaths = new Set((mission.sourcePolicy?.sourceFiles || [])
    .filter(file => file.role === 'oracle').map(file => file.path));
  const matrix = structuredClone(manifest.testMatrix);
  if (!matrix?.environments?.length || !matrix?.stages?.length) throw fail('TEST_MATRIX_INVALID', '冻结测试矩阵缺少环境或验证阶段。');
  return {
    pending, mission, matrix, baseline, remainingMs, deadlineAt: new Date(nowMs + remainingMs).toISOString(),
    baselineBody: { baselineKind: baseline.kind, baselineSource: baseline.source,
      ...(materializer ? { materializerResult: baseline.materializer.result } : { runPy: baselineRunPy }) },
    candidate: structuredClone(manifest.candidate),
    missionRunPy: { content: textFile(bundle.files.find(file => file.path === manifest.entrypoint)),
      source: `pending-candidate:${pending.manifestDigest}:${manifest.entrypoint}`,
      implementationFiles: Object.fromEntries(bundle.files.filter(file => file.path !== manifest.entrypoint && !oraclePaths.has(file.path))
        .map(file => {
          const bytes = Buffer.from(file.content, 'base64');
          const text = bytes.toString('utf8');
          return [file.path, Buffer.from(text).equals(bytes) ? text : { encoding: 'base64', content: file.content }];
        })) },
  };
};
