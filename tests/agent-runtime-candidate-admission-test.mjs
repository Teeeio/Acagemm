import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

// 本测试锁死的是「候选准入只有一条权威通道」：工作区 Git Diff。
// 注入缝与 tests/agent-runtime-timeout-recovery-test.mjs 相同：stub client + 真实
// mkdtemp Git 工作区。无 CLI、无网络、无硬件。
const execFileAsync = promisify(execFile);

const workspaces = [];
const createWorkspace = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-candidate-admission-'));
  workspaces.push(directory);
  await execFileAsync('git', ['init'], { cwd: directory });
  await execFileAsync('git', ['config', 'user.name', 'Candidate Admission Test'], { cwd: directory });
  await execFileAsync('git', ['config', 'user.email', 'admission@test.invalid'], { cwd: directory });
  await writeFile(path.join(directory, 'run.py'), 'def run(inputs):\n    return inputs\n');
  await execFileAsync('git', ['add', 'run.py'], { cwd: directory });
  await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: directory });
  return directory;
};

const RUN_ID = 'codex_admission_run';
// 合法的最小 unified diff：以已提交的 run.py 为基线。
const PATCH = [
  'diff --git a/run.py b/run.py',
  '--- a/run.py',
  '+++ b/run.py',
  '@@ -1,2 +1,3 @@',
  ' def run(inputs):',
  '+    # optimized candidate',
  '     return inputs',
  '',
].join('\n');

const message = (payload) => ({
  item: { type: 'agent_message', text: typeof payload === 'string' ? payload : JSON.stringify(payload) },
});
const candidatePlan = (overrides = {}) => ({
  summary: '优化 run.py 入口',
  candidates: [{ id: 'agent-candidate', title: '融合入口', files: 'run.py', sourceReferences: [] }],
  recommendedCandidate: 'agent-candidate',
  ...overrides,
});

const createRuntime = (workspace, run, events) => createAgentRuntime({
  mode: 'codex-cli',
  codexClient: {
    describe: async () => ({ installed: true, loggedIn: true, version: 'test' }),
    readRun: async () => ({ runId: RUN_ID, threadId: 'thread-admission', workspace, ...run }),
    readEvents: async () => events,
    eventText: (event) => event?.text || event?.item?.text || '',
  },
});

const baseState = () => ({
  activeMissionId: 'MIS_ADMISSION',
  missions: [{
    id: 'MIS_ADMISSION',
    title: '候选准入',
    goal: 'reduce latency',
    status: 'running',
    hardware: ['local-gpu'],
    metric: 'latency_p50',
    implementation: null,
    operatorProfile: null,
  }],
  stage: 'diagnosis',
  runtimeEvents: [],
  candidateEvaluations: [],
  runHistory: [],
  iterationStats: { round: 0, loopStatus: 'running' },
  tokenUsage: { runs: {} },
  patchApplied: false,
  agent: {
    status: 'running',
    phase: 'Codex 正在分析',
    runId: RUN_ID,
    runtimeKind: 'codex-cli',
    startedAt: new Date().toISOString(),
    eventCount: 0,
    lastEventAt: Date.now(),
    messages: [],
    artifacts: [],
  },
});

const eventTypes = (state) => state.runtimeEvents.map((event) => event.type);
const findEvent = (state, type) => state.runtimeEvents.find((event) => event.type === type);

try {
  // 用例 1：Provider 不可恢复失败但结果里声明了候选 —— 曾经这里是 fail-open：
  // 候选绕过工作区 Diff 校验直接进候选池，candidateValidation 为 null。
  const failOpenWorkspace = await createWorkspace();
  const failOpen = await createRuntime(
    failOpenWorkspace,
    { status: 'failed', resourceRelease: { confirmed: true, status: 'confirmed' }, error: { code: 'CODEX_EXEC_FAILED', message: 'invalid peer certificate: UnknownIssuer' } },
    [message(candidatePlan({ candidates: [{ id: 'cand-a', files: 'run.py' }, { id: 'cand-b', files: 'run.py' }] }))],
  ).projectState(baseState());
  assert.equal(failOpen.state.candidateEvaluations.length, 0, '声明的候选未经 Git Diff 校验，一个都不许进候选池');
  assert.equal(failOpen.state.agent.candidateValidation.passed, false);
  assert.equal(failOpen.state.agent.candidateValidation.code, 'CODEX_CANDIDATE_INSPECTION_SKIPPED');
  assert.equal(failOpen.state.agent.candidateValidation.classification, 'candidate_inspection_skipped');
  assert.equal(failOpen.state.agent.candidateValidation.declaredCandidateCount, 2);
  assert.equal(failOpen.state.agent.candidateValidation.workspaceAdmission, 'not_reached');
  assert.equal(failOpen.state.agent.status, 'failed');
  assert.equal(failOpen.state.stage, 'diagnosis', '未正常终结的运行不得推进到候选阶段');
  assert.ok(eventTypes(failOpen.state).includes('candidate.diff_rejected'));
  assert.ok(eventTypes(failOpen.state).includes('codex.run_failed'));
  assert.ok(!eventTypes(failOpen.state).includes('candidate.not_proposed'), '上游失败不是「生成了一轮但没产出」');
  assert.equal(failOpen.state.agent.primaryFailure.code, 'CODEX_TLS_TRUST_FAILED');

  // 用例 2：真·空数组 —— 唯一根因是「模型没有提出候选」。
  const emptyWorkspace = await createWorkspace();
  const empty = await createRuntime(
    emptyWorkspace,
    { status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' } },
    [message({ summary: '分析完成，暂无可行方向', candidates: [] })],
  ).projectState(baseState());
  const emptyNotProposed = findEvent(empty.state, 'candidate.not_proposed');
  assert.equal(emptyNotProposed.payload.classification, 'no_candidate_generated');
  assert.equal(emptyNotProposed.payload.format, 'structured-json');
  assert.equal(emptyNotProposed.payload.declaredCandidateCount, 0);
  assert.equal(emptyNotProposed.payload.droppedCandidateCount, 0);
  assert.equal(emptyNotProposed.payload.patchProvided, false);
  assert.equal(empty.state.agent.candidateValidation.code, 'CODEX_CANDIDATE_NOT_PROPOSED');
  assert.equal(empty.state.agent.candidateValidation.passed, null);
  assert.equal(empty.state.stage, 'diagnosis');
  assert.equal(empty.state.candidateEvaluations.length, 0);

  // 用例 3：只有自然语言分析、没有候选也没有 patch —— 是任务契约未满足，不是解析问题。
  const textWorkspace = await createWorkspace();
  const textOnly = await createRuntime(
    textWorkspace,
    { status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' } },
    [message('我分析了 kernel 的访存模式，但没有给出任何可应用的改动。')],
  ).projectState(baseState());
  const textNotProposed = findEvent(textOnly.state, 'candidate.not_proposed');
  assert.equal(textNotProposed.payload.classification, 'task_contract_unmet');
  assert.equal(textNotProposed.payload.format, 'text-fallback');

  // 用例 4：结果内 patch 回退 + 结构化编辑工具失败 —— 降级的是生成路径，不是准入结果。
  const degradedWorkspace = await createWorkspace();
  const degraded = await createRuntime(
    degradedWorkspace,
    { status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' } },
    [message(candidatePlan({ patch: PATCH })), { item: { type: 'apply_patch', status: 'failed' } }],
  ).projectState(baseState());
  assert.equal(degraded.state.candidateEvaluations.length, 1);
  const degradedCandidate = degraded.state.candidateEvaluations[0];
  assert.equal(degradedCandidate.id, 'candidate-01');
  assert.equal(degradedCandidate.candidateGenerationPath, 'patch_fallback');
  assert.equal(degradedCandidate.degraded, true);
  assert.equal(degradedCandidate.degradationReason, 'structured_edit_failed');
  assert.equal(degradedCandidate.editToolStatus, 'failed');
  assert.equal(degradedCandidate.patchValidation, 'passed');
  assert.equal(degradedCandidate.workspaceAdmission, 'passed');
  const degradedEvent = findEvent(degraded.state, 'candidate.degraded_generation');
  assert.ok(degradedEvent, 'patch 回退不再静默成功');
  assert.equal(degradedEvent.payload.candidateGenerationPath, 'patch_fallback');
  assert.equal(degradedEvent.payload.degraded, true);
  assert.equal(degradedEvent.payload.patchValidation, 'passed');
  assert.equal(degradedEvent.payload.workspaceAdmission, 'passed');
  assert.ok(eventTypes(degraded.state).includes('candidate.patch_applied_from_result'));
  assert.equal(degraded.state.stage, 'candidate');
  assert.equal(degraded.state.agent.status, 'awaiting_action');

  // 用例 5：patch 回退但编辑工具从未出现（Agent 用普通 shell 写盘）—— 缺失不判降级。
  const shellWorkspace = await createWorkspace();
  const shellWrite = await createRuntime(
    shellWorkspace,
    { status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' } },
    [message(candidatePlan({ patch: PATCH })), { type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'python - <<PY' } }],
  ).projectState(baseState());
  assert.equal(shellWrite.state.candidateEvaluations.length, 1);
  const shellCandidate = shellWrite.state.candidateEvaluations[0];
  assert.equal(shellCandidate.candidateGenerationPath, 'patch_fallback');
  assert.equal(shellCandidate.degraded, false);
  assert.equal(shellCandidate.degradationReason, null);
  assert.equal(shellCandidate.editToolStatus, 'absent');
  assert.equal(shellCandidate.patchValidation, 'passed');
  assert.ok(eventTypes(shellWrite.state).includes('candidate.patch_fallback_generation'));
  assert.ok(!eventTypes(shellWrite.state).includes('candidate.degraded_generation'), '未降级不得发降级事件');

  // 用例 6：patch 存在但不合法（连路径都解析不出）—— 准入失败，不是「没生成候选」。
  const rejectedWorkspace = await createWorkspace();
  const rejected = await createRuntime(
    rejectedWorkspace,
    { status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' } },
    [message({ summary: '给出一个无法应用的改动', candidates: [], patch: '这不是一个 unified diff\n' })],
  ).projectState(baseState());
  const rejectedNotProposed = findEvent(rejected.state, 'candidate.not_proposed');
  assert.equal(rejected.state.candidateEvaluations.length, 0);
  assert.equal(rejectedNotProposed.payload.classification, 'patch_admission_failed');
  assert.equal(rejectedNotProposed.payload.patchProvided, true);
  assert.equal(rejected.state.agent.candidateValidation.patchValidation, 'not_applicable');
  assert.equal(rejected.state.agent.candidateValidation.workspaceAdmission, 'not_reached');
  assert.ok(eventTypes(rejected.state).includes('candidate.patch_result_rejected'));

  console.log('[agent-runtime-candidate-admission] fail-open guard, empty-candidate root causes and degraded generation paths passed');
} finally {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
}
