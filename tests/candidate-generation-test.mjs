import assert from 'node:assert/strict';
import {
  buildCandidateGenerationPrompt,
} from '../client-runtime/candidate-generation/prompt.mjs';
import {
  candidateWorkspaceRequirements,
  finalizeCandidateAdmission,
  inspectCandidateDiff,
} from '../client-runtime/candidate-generation/admission.mjs';
import {
  CANDIDATE_OUTCOME,
  classifyEmptyCandidateOutcome,
  editToolSignal,
} from '../client-runtime/candidate-generation/classification.mjs';
import { parseAgentResult } from '../client-runtime/agent-result.mjs';

const provider = { slug: 'codex', name: 'Codex' };
const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const mission = {
  id: 'MIS_CANDIDATE_GENERATION',
  goal: 'reduce latency',
  hardware: ['local-gpu'],
  metric: 'latency_p50',
  implementation: null,
  operatorProfile: null,
};

const prompt = buildCandidateGenerationPrompt({
  mission,
  goal: mission.goal,
  workspace: 'C:/workspace/MIS_CANDIDATE_GENERATION',
  baseline: { status: 'ready', oracleRunPy: 'def reference(inputs): return inputs' },
  testMatrix: { environments: ['local-gpu'] },
  workspaceInventory: ['run.py', 'kernel.py'],
  boundaryInstruction: 'BOUNDARY',
});
assert.match(prompt, /Mission ID: MIS_CANDIDATE_GENERATION/);
assert.match(prompt, /run\.py/);
assert.match(prompt, /BOUNDARY/);
assert.match(prompt, /Return one JSON object/);
assert.doesNotMatch(prompt, /Frozen Semantic Snapshot/);

const semanticPrompt = buildCandidateGenerationPrompt({
  mission: {
    ...mission,
    semanticSnapshot: {
      snapshotId: 'SEM_INPUTS_01', status: 'frozen', digest: 'sha256:semantic-digest',
      semanticContract: {
        operator: 'vector_add',
        inputs: [{ name: 'lhs', shape: ['N', 16], dtype: 'float16', device: 'cuda' }],
        outputs: [{ name: 'out', dtype: 'float16' }],
        math: { equation: 'out = lhs + rhs' },
        immutableRules: ['preserve dtype'],
      },
      correctnessContract: { requiredCategories: ['exact', 'edge'], uncovered: [] },
      benchmarkContract: { primaryProfile: 'small', profiles: [{ name: 'small', shape: [1, 16] }] },
      rawIntent: { operator: 'vector_add', goal: 'elementwise addition' },
      conflicts: [], unknowns: [],
    },
    iterationEvidence: {
      roundId: 'MIS_CANDIDATE_GENERATION:round:2',
      candidateDigest: digest,
      correctness: { passed: false, failures: [{ case: 'empty_input', reason: 'shape mismatch' }] },
      benchmark: { profiles: [{ name: 'small', value: 12.5, unit: 'us' }] },
      attemptedDirection: 'shared memory tiling',
    },
  },
  goal: 'reduce latency',
  workspace: 'C:/workspace/MIS_CANDIDATE_GENERATION',
  baseline: {
    status: 'ready',
    oracleRunPy: 'def reference(inputs): return inputs',
    iterationEvidence: { priorCandidateDigest: 'sha256:prior', decision: 'discard', reason: 'correctness_failed' },
  },
  testMatrix: { environments: ['local-gpu'] },
});
assert.match(semanticPrompt, /Frozen Semantic Snapshot \(authoritative contract/);
assert.match(semanticPrompt, /SEM_INPUTS_01/);
assert.match(semanticPrompt, /sha256:semantic-digest/);
assert.match(semanticPrompt, /vector_add/);
assert.match(semanticPrompt, /Correctness contract \(JSON\)/);
assert.match(semanticPrompt, /Benchmark contract \(JSON\)/);
assert.match(semanticPrompt, /MISSION ITERATION EVIDENCE/);
assert.match(semanticPrompt, /empty_input/);
assert.match(semanticPrompt, /shared memory tiling/);
assert.match(semanticPrompt, /BASELINE ITERATION EVIDENCE/);
assert.match(semanticPrompt, /correctness_failed/);

const context = { mission, runHistory: [] };
const matching = inspectCandidateDiff({
  agentResult: {
    candidates: [{ id: 'agent-candidate', files: 'run.py', sourceReferences: [] }],
    recommendedCandidate: 'agent-candidate',
    summary: 'candidate summary',
    sourceReferences: [],
  },
  manifest: { dirty: true, diff: 'diff --git a/run.py b/run.py', digest, changedFiles: ['run.py'] },
  provider,
  runId: 'codex-run-1',
});
assert.equal(matching.candidateValidation.passed, true);
assert.equal(matching.verifiedCandidates[0].patchDigest, digest);
assert.equal(matching.verifiedCandidates[0].sourceRunId, 'codex-run-1');

const mismatch = inspectCandidateDiff({
  agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py' }], recommendedCandidate: 'agent-candidate' },
  manifest: { dirty: true, diff: 'diff', digest, changedFiles: ['kernel.py'] },
  provider,
  runId: 'codex-run-2',
});
assert.equal(mismatch.candidateValidation.code, 'CODEX_CANDIDATE_FILES_MISMATCH');
assert.equal(mismatch.verifiedCandidates.length, 0);

const empty = inspectCandidateDiff({
  agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py' }], recommendedCandidate: 'agent-candidate' },
  manifest: { dirty: false, diff: '', digest, changedFiles: [] },
  provider,
  runId: 'codex-run-3',
});
assert.equal(empty.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_EMPTY');

const observed = inspectCandidateDiff({
  agentResult: { candidates: [], summary: 'workspace changed', sourceReferences: [] },
  manifest: { dirty: true, diff: 'diff', digest, changedFiles: ['run.py'] },
  provider,
  runId: 'codex-run-4',
});
assert.equal(observed.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_OBSERVED');
assert.equal(observed.verifiedCandidates[0].patchDigest, digest);

assert.deepEqual(candidateWorkspaceRequirements(mission), { requiredWorkspaceFiles: ['run.py'], contentFiles: ['run.py'] });
const finalized = finalizeCandidateAdmission({
  admission: matching,
  mission,
  workspaceFiles: ['run.py'],
  entryContent: 'def run(inputs): return inputs',
  runHistory: [],
  round: 0,
  provider,
});
assert.equal(finalized.candidateValidation.passed, true);
assert.equal(finalized.verifiedCandidates[0].id, 'candidate-01');
assert.equal(finalized.verifiedCandidates[0].agentOriginalId, 'agent-candidate');

const repeated = finalizeCandidateAdmission({
  admission: matching,
  mission,
  workspaceFiles: ['run.py'],
  entryContent: 'def run(inputs): return inputs',
  runHistory: [{ candidateDigest: digest }],
  round: 1,
  provider,
});
assert.equal(repeated.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_REPEATED');
assert.equal(repeated.verifiedCandidates.length, 0);
assert.equal(context.runHistory.length, 0);
// --- 生成路径与降级标记 ------------------------------------------------------
// 「编辑工具失败」与「编辑工具缺失」必须区分：缺失（Agent 用普通 shell 写盘）
// 从来不判降级。工具身份只看类型/名称字段，绝不看命令文本正文。
assert.equal(editToolSignal([]), 'absent');
assert.equal(editToolSignal([{ item: { type: 'command_execution', command: 'git apply apply_patch.diff', status: 'failed' } }]), 'absent');
assert.equal(editToolSignal([{ item: { type: 'apply_patch', status: 'failed' } }]), 'failed');
assert.equal(editToolSignal([{ item: { type: 'apply_patch', status: 'completed' } }]), 'succeeded');
assert.equal(editToolSignal([{ item: { type: 'apply_patch', status: 'completed' } }, { item: { type: 'apply_patch', status: 'failed' } }]), 'failed');
// 以下形状逐字取自真实采集的 run 事件流，不是推断出来的 schema。回归价值就在这里：
// 旧实现只认 `apply_patch`，而它在 78 个真实 Codex run 里从未作为 item.type 出现过，
// 于是两个 Provider 在生产里都恒定落回 'absent' —— 编辑工具的"失败"全被读成"缺失"。
//   - Codex: .operator-studio-local/runtime/agent-bridge/codex-runs/codex_MTUULWMN_40A19CE7.jsonl
//     真实序列 item.type === 'file_change'，status: in_progress -> failed
//   - Claude Code: claude-client 把每个 tool_use 规范化成
//     { type: 'item.completed', item: { type: 'command_execution', name, status } }，
//     工具名是唯一身份来源（item.type 恒为 command_execution）。
const codexFileChange = (status) => ({ type: 'item.completed', item: { type: 'file_change', status } });
const claudeTool = (name, status) => ({ type: 'item.completed', item: { type: 'command_execution', name, command: name, status } });
assert.equal(editToolSignal([codexFileChange('completed')]), 'succeeded');
assert.equal(editToolSignal([codexFileChange('failed')]), 'failed');
// 「编辑工具存在且正常」必须与「缺失」区分开：下面两条在旧实现下都会得到 'absent'。
assert.equal(editToolSignal([claudeTool('Edit', 'completed')]), 'succeeded');
assert.equal(editToolSignal([claudeTool('Write', 'failed')]), 'failed');
// Claude 的每条工具都是 command_execution，所以工具名必须优先于事件类型判定：
// shell 与只读工具都不是编辑工具。
assert.equal(editToolSignal([claudeTool('Bash', 'completed')]), 'absent');
assert.equal(editToolSignal([claudeTool('Read', 'completed')]), 'absent');
// 首个失败的编辑工具即定调：随后 shell 正常写盘不能给一次工具失败翻案
// （专家 §三.4 的真实样本：结构化编辑失败后改走 patch）。
assert.equal(editToolSignal([codexFileChange('failed'), claudeTool('Bash', 'completed')]), 'failed');
assert.equal(editToolSignal([codexFileChange('completed'), codexFileChange('failed')]), 'failed');

// 空候选七类：固定优先级。
assert.equal(classifyEmptyCandidateOutcome({ providerFinishedNormally: false }), CANDIDATE_OUTCOME.UPSTREAM_FAILURE_NO_CANDIDATE);
assert.equal(classifyEmptyCandidateOutcome({ providerFinishedNormally: true }), CANDIDATE_OUTCOME.NO_CANDIDATE_GENERATED);
assert.equal(classifyEmptyCandidateOutcome({ providerFinishedNormally: true, droppedCandidateCount: 2 }), CANDIDATE_OUTCOME.PARSE_MAPPING_LOSS);
assert.equal(classifyEmptyCandidateOutcome({ providerFinishedNormally: true, structuredEditFailed: true }), CANDIDATE_OUTCOME.TOOL_FAILED_PATCH_PENDING);
assert.equal(classifyEmptyCandidateOutcome({ providerFinishedNormally: true, patchRejected: true }), CANDIDATE_OUTCOME.PATCH_ADMISSION_FAILED);
assert.equal(classifyEmptyCandidateOutcome({ providerFinishedNormally: true, textOnly: true }), CANDIDATE_OUTCOME.TASK_CONTRACT_UNMET);
assert.equal(
  classifyEmptyCandidateOutcome({ providerFinishedNormally: false, droppedCandidateCount: 9, structuredEditFailed: true, textOnly: true }),
  CANDIDATE_OUTCOME.UPSTREAM_FAILURE_NO_CANDIDATE,
  'upstream failure outranks every downstream symptom',
);
assert.equal(
  classifyEmptyCandidateOutcome({ providerFinishedNormally: true, droppedCandidateCount: 1, structuredEditFailed: true }),
  CANDIDATE_OUTCOME.PARSE_MAPPING_LOSS,
  'parse-mapping loss outranks structured-edit failure',
);

// 解析层证据：声明了什么、映射丢了多少，都要有迹可循。
const droppedCandidates = parseAgentResult([
  { item: { type: 'agent_message', text: JSON.stringify({ summary: 's', candidates: ['x', null, 3] }) } },
]);
assert.equal(droppedCandidates.candidateGeneration.rawCandidatesType, 'array');
assert.equal(droppedCandidates.candidateGeneration.rawCandidateCount, 3);
assert.equal(droppedCandidates.candidateGeneration.normalizedCandidateCount, 0);
assert.equal(droppedCandidates.candidateGeneration.droppedCandidateCount, 3);
assert.equal(droppedCandidates.candidateGeneration.classification, 'parse_mapping_loss');
const nonArrayCandidates = parseAgentResult([
  { item: { type: 'agent_message', text: JSON.stringify({ summary: 's', candidates: 'x' }) } },
]);
assert.equal(nonArrayCandidates.candidateGeneration.rawCandidatesType, 'non-array');
assert.equal(nonArrayCandidates.candidateGeneration.rawCandidateCount, null);
assert.equal(nonArrayCandidates.candidateGeneration.classification, 'parse_mapping_loss');

// 通过分支：候选只需如实携带生成路径，不需要降级就不标降级。
assert.equal(matching.candidateValidation.classification, CANDIDATE_OUTCOME.CANDIDATE_VERIFIED);
assert.equal(matching.candidateValidation.candidateGenerationPath, 'structured_edit');
assert.equal(matching.candidateValidation.degraded, false);
assert.equal(matching.candidateValidation.patchValidation, 'passed');
assert.equal(matching.candidateValidation.workspaceAdmission, 'passed');
assert.equal(matching.verifiedCandidates[0].candidateGenerationPath, 'structured_edit');
assert.equal(matching.verifiedCandidates[0].degraded, false);
assert.equal(matching.verifiedCandidates[0].patchValidation, 'passed');
assert.equal(matching.verifiedCandidates[0].workspaceAdmission, 'passed');

// 声明了候选但没有真实 Diff：区分「工作区捕获缺口」与「patch 不合法」。
assert.equal(empty.candidateValidation.classification, CANDIDATE_OUTCOME.WORKSPACE_CAPTURE_GAP);
const rejectedPatch = inspectCandidateDiff({
  agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py' }], recommendedCandidate: 'agent-candidate' },
  manifest: { dirty: false, diff: '', digest, changedFiles: [] },
  provider,
  runId: 'codex-run-3b',
  generationPath: { path: 'patch_fallback', editToolStatus: 'failed', degraded: true, degradationReason: 'structured_edit_failed', patchRejected: true },
});
assert.equal(rejectedPatch.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_EMPTY');
assert.equal(rejectedPatch.candidateValidation.classification, CANDIDATE_OUTCOME.PATCH_ADMISSION_FAILED);
assert.equal(rejectedPatch.candidateValidation.editToolStatus, 'failed');
assert.equal(rejectedPatch.candidateValidation.patchValidation, 'rejected');
assert.equal(mismatch.candidateValidation.classification, CANDIDATE_OUTCOME.WORKSPACE_CAPTURE_GAP);
assert.equal(mismatch.candidateValidation.workspaceAdmission, 'failed');

// 第二条曾静默的降级路径：模型没返回候选、工作区却有真实 Diff。
assert.equal(observed.candidateValidation.classification, CANDIDATE_OUTCOME.WORKSPACE_CAPTURE_GAP);
assert.equal(observed.candidateValidation.candidateGenerationPath, 'workspace_observed');
assert.equal(observed.candidateValidation.degraded, true);
assert.equal(observed.candidateValidation.degradationReason, 'candidates_absent_but_diff_observed');
assert.equal(observed.verifiedCandidates[0].candidateGenerationPath, 'workspace_observed');
assert.equal(observed.verifiedCandidates[0].degraded, true);
assert.equal(observed.verifiedCandidates[0].degradationReason, 'candidates_absent_but_diff_observed');
assert.equal(observed.verifiedCandidates[0].patchValidation, 'not_applicable');
assert.equal(observed.verifiedCandidates[0].workspaceAdmission, 'passed');

// patch 回退 + 结构化编辑工具失败：降级的是生成路径，不是准入结果。
const degradedAdmission = inspectCandidateDiff({
  agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py' }], recommendedCandidate: 'agent-candidate' },
  manifest: { dirty: true, diff: 'diff --git a/run.py b/run.py', digest, changedFiles: ['run.py'] },
  provider,
  runId: 'codex-run-5',
  generationPath: { path: 'patch_fallback', editToolStatus: 'failed', degraded: true, degradationReason: 'structured_edit_failed', patchRejected: false },
});
assert.equal(degradedAdmission.candidateValidation.classification, CANDIDATE_OUTCOME.CANDIDATE_VERIFIED);
assert.equal(degradedAdmission.candidateValidation.candidateGenerationPath, 'patch_fallback');
assert.equal(degradedAdmission.candidateValidation.degraded, true);
assert.equal(degradedAdmission.verifiedCandidates[0].candidateGenerationPath, 'patch_fallback');
assert.equal(degradedAdmission.verifiedCandidates[0].degradationReason, 'structured_edit_failed');

// 降级不降标（专家硬要求）：degraded 只是透传标记，语言契约、重复 digest 与
// 准入标准一律不变。降级候选照样会被语言契约拒绝。
const tritonMission = { ...mission, implementation: 'triton' };
const degradedButOffContract = finalizeCandidateAdmission({
  admission: degradedAdmission,
  mission: tritonMission,
  workspaceFiles: ['run.py'],
  entryContent: 'def run(inputs): return inputs',
  runHistory: [],
  round: 0,
  provider,
});
assert.equal(degradedButOffContract.candidateValidation.code, 'CANDIDATE_LANGUAGE_CONTRACT_FAILED');
assert.equal(degradedButOffContract.verifiedCandidates.length, 0);
const degradedAndOnContract = finalizeCandidateAdmission({
  admission: degradedAdmission,
  mission: tritonMission,
  workspaceFiles: ['run.py'],
  entryContent: 'import triton\n\n@triton.jit\ndef kernel(): pass',
  runHistory: [],
  round: 0,
  provider,
});
assert.equal(degradedAndOnContract.candidateValidation.passed, true);
assert.equal(degradedAndOnContract.verifiedCandidates[0].id, 'candidate-01');
assert.equal(degradedAndOnContract.verifiedCandidates[0].degraded, true, 'degradation marker must survive admission unchanged');
assert.equal(degradedAndOnContract.verifiedCandidates[0].candidateGenerationPath, 'patch_fallback');

console.log('[candidate-generation] prompt, diff admission, language contract, repeat guard, and generation-path classification passed');
