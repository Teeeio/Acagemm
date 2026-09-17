// 候选生成结果的分类契约。
//
// `candidates: []` 只是结果表现，不是根因标签。本模块把「原始 Agent 结果 + 工作区
// 快照」逐层重放成七个稳定的根因码，外加两个正交标记：已验证候选，以及因准入检查
// 未执行而 fail-closed 丢弃的候选。
//
// 纯模块：不读写文件、不调用 Provider、不 import 任何 Node 内置模块，也不依赖
// 传输层或状态实现。它只消费调用方已经取得的观测值，因此可以在任何层安全复用。

// 七类空候选根因（lastest_demand_for_job.md §三.1 的七行）+ 两个非空结果标记。
export const CANDIDATE_OUTCOME = Object.freeze({
  // 行 1：上游失败。不是候选生成失败，不写候选池、不发 candidate.not_proposed。
  UPSTREAM_FAILURE_NO_CANDIDATE: 'upstream_failure_no_candidate',
  // 行 2：正常结束且确实没有候选。
  NO_CANDIDATE_GENERATED: 'no_candidate_generated',
  // 行 3：Provider 声明了候选，但适配器解析/映射阶段全部丢失。
  PARSE_MAPPING_LOSS: 'parse_mapping_loss',
  // 行 4：结构化编辑工具失败，但结果里存在可验证的 patch。
  TOOL_FAILED_PATCH_PENDING: 'tool_failed_patch_pending',
  // 行 5：真实改动存在但工作区捕获看不到（由 inspectCandidateDiff 承载）。
  WORKSPACE_CAPTURE_GAP: 'workspace_capture_gap',
  // 行 6：patch 存在但不合法，准入失败。
  PATCH_ADMISSION_FAILED: 'patch_admission_failed',
  // 行 7：只给了分析，没有 edit/diff/patch。
  TASK_CONTRACT_UNMET: 'task_contract_unmet',
  // 非空结果：候选通过工作区 Git Diff 准入。
  CANDIDATE_VERIFIED: 'candidate_verified',
  // Fail-closed：Provider 未正常终结，声明的候选未经准入校验，全部丢弃。
  CANDIDATE_INSPECTION_SKIPPED: 'candidate_inspection_skipped',
});

// 候选是怎么被生产出来的。降级的是生成路径，不是 correctness/oracle/Gate 标准。
export const CANDIDATE_GENERATION_PATH = Object.freeze({
  STRUCTURED_EDIT: 'structured_edit',
  PATCH_FALLBACK: 'patch_fallback',
  WORKSPACE_OBSERVED: 'workspace_observed',
});

// 解析层观测到的候选形态。与 CANDIDATE_OUTCOME 共享 parse_mapping_loss 语义，
// 但作用域不同：这里只描述一次 parseAgentResult 的输入输出，不涉及工作区。
export const CANDIDATE_PARSE_CLASSIFICATION = Object.freeze({
  PARSE_MAPPING_LOSS: 'parse_mapping_loss',
  CANDIDATES_PRESENT: 'candidates_present',
  EMPTY_DECLARED_WITH_PATCH: 'empty_declared_with_patch',
  EMPTY_DECLARED: 'empty_declared',
  ANALYSIS_ONLY: 'analysis_only',
  TEXT_FALLBACK_ONLY: 'text_fallback_only',
});

// 工具身份只来自两个字段通道，绝不来自命令正文：普通 shell 里 `git apply foo.patch`
// 之类的字符串不该被误判成结构化编辑工具。
//
// 两个 Provider 把身份放在不同字段上，必须分开判定（词表取自真实采集的 run 事件流，
// 不是推断出来的 schema）：
//   - Codex      → item.type === 'file_change'（结构化编辑）/ 'command_execution'（shell）
//   - Claude Code → claude-client 把每个 tool_use 统一规范化成
//                   item.type === 'command_execution'，真正的工具身份只留在
//                   item.name 上（Write / Edit / Bash）。
//
// 判定顺序：先看「声明的工具名」（更强的证据），再看「事件类型」。只看 item.type
// 会漏掉 Claude 的编辑工具；只看拼接串会先被 shell 分支排除掉。
const normalizeToolToken = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const EDIT_TOOL_NAMES = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'strreplaceeditor']);
const EDIT_TOOL_TYPES = new Set(['filechange', 'applypatch', 'patchapply', 'strreplace', 'editfile', 'createfile']);
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'powershell', 'pwsh']);
const SHELL_TOOL_TYPES = new Set(['commandexecution', 'execcommand', 'shell', 'bash', 'powershell']);

const toolNames = (event = {}) => [event?.item?.name, event?.tool, event?.name].filter(Boolean).map(normalizeToolToken);
const toolTypes = (event = {}) => [event?.item?.type, event?.type].filter(Boolean).map(normalizeToolToken);
const anyTokenIn = (tokens, set) => tokens.some((token) => set.has(token));

const toolFailed = (event = {}) => event?.item?.status === 'failed'
  || event?.status === 'failed'
  || event?.type === 'item.failed'
  || Boolean(event?.item?.error)
  || Boolean(event?.error);

// shell 工具一律不是编辑工具：Claude 的 Bash 与 Codex 的 command_execution 都走这里。
// 工具名优先于事件类型，因此 Claude 那条 item.type='command_execution' 的 Write 仍然
// 会被认成编辑工具，而同一个类型下的 Bash 不会。
const isEditTool = (event = {}) => {
  const names = toolNames(event);
  if (anyTokenIn(names, SHELL_TOOL_NAMES)) return false;
  if (anyTokenIn(names, EDIT_TOOL_NAMES)) return true;
  const types = toolTypes(event);
  if (anyTokenIn(types, SHELL_TOOL_TYPES)) return false;
  return anyTokenIn(types, EDIT_TOOL_TYPES);
};

/**
 * 区分结构化编辑工具的「失败」与「缺失」。
 *
 * - `'failed'`  ：编辑工具出现过且失败了 —— 这是真降级。
 * - `'succeeded'`：编辑工具出现且正常 —— 不是降级。
 * - `'absent'`  ：编辑工具根本没出现 —— 缺失从来不是降级；Agent 用普通 shell
 *   写盘是完全合法的生成路径。
 *
 * 首个失败的编辑工具即定调：后续的 shell 写盘成功不能给一次工具失败翻案。判定
 * 全程只读类型/名称字段，`command_execution` 的命令正文永远不会被匹配，所以
 * `git apply foo.patch` 之类的文本不会把一次成功的 shell 写入标成降级。
 */
export function editToolSignal(events = []) {
  let seen = false;
  for (const event of events) {
    if (!isEditTool(event)) continue;
    seen = true;
    if (toolFailed(event)) return 'failed';
  }
  return seen ? 'succeeded' : 'absent';
}

/**
 * 把「生成路径 + 编辑工具状态」折叠成一组固定的降级标记。
 *
 * `degraded` 只是事实标记：它不参与任何 `passed` 判定，不放宽语言契约、重复
 * digest 拒绝、Accept Gate 或 oracle 标准。`editToolStatus === 'failed'` 才构成
 * 降级理由；`'absent'` 与 `'succeeded'` 都不构成。
 */
export function describeGenerationPath({
  path, editToolStatus = 'absent', degraded = false, degradationReason = null,
}) {
  const isDegraded = degraded === true;
  return {
    candidateGenerationPath: path,
    degraded: isDegraded,
    degradationReason: isDegraded ? (degradationReason || 'unspecified') : null,
    editToolStatus,
  };
}

/**
 * 空候选的根因判定。固定优先级，从上到下第一个命中的分支胜出：
 *
 *   1. Provider 没有正常终结           → 行 1 upstream_failure_no_candidate
 *   2. 声明了候选但解析映射全部丢失     → 行 3 parse_mapping_loss
 *   3. 结构化编辑工具失败（有 patch）   → 行 4 tool_failed_patch_pending
 *   4. patch 存在但不合法               → 行 6 patch_admission_failed
 *   5. 只有文本/分析，没有 edit/diff    → 行 7 task_contract_unmet
 *   6. 否则（正常结束，确实没有候选）   → 行 2 no_candidate_generated
 *
 * 行 5 workspace_capture_gap 不由本函数产出：它描述的是「声明了候选、也有真实
 * diff，但工作区捕获看不见」，由 inspectCandidateDiff 的 Diff 分支承载。
 */
export function classifyEmptyCandidateOutcome({
  providerFinishedNormally = false,
  droppedCandidateCount = 0,
  structuredEditFailed = false,
  patchRejected = false,
  textOnly = false,
} = {}) {
  if (!providerFinishedNormally) return CANDIDATE_OUTCOME.UPSTREAM_FAILURE_NO_CANDIDATE;
  if (Number(droppedCandidateCount) > 0) return CANDIDATE_OUTCOME.PARSE_MAPPING_LOSS;
  if (structuredEditFailed) return CANDIDATE_OUTCOME.TOOL_FAILED_PATCH_PENDING;
  if (patchRejected) return CANDIDATE_OUTCOME.PATCH_ADMISSION_FAILED;
  if (textOnly) return CANDIDATE_OUTCOME.TASK_CONTRACT_UNMET;
  return CANDIDATE_OUTCOME.NO_CANDIDATE_GENERATED;
}

/**
 * 解析层分类。优先级固定：
 *   text-fallback → 非数组候选（类型不可映射）→ 有丢弃 → 有可用候选
 *   → 显式声明空数组 → 完全没提候选（只有分析）
 *
 * 候选数量本身不参与判定，调用方仍应把它作为证据一并记录（类型不可映射时记
 * null，不伪造成 0）。
 */
export function classifyParsedCandidateGeneration({
  format = 'text-fallback',
  rawCandidatesType = 'absent',
  normalizedCandidateCount = 0,
  droppedCandidateCount = 0,
  hasPatch = false,
} = {}) {
  if (format !== 'structured-json') return CANDIDATE_PARSE_CLASSIFICATION.TEXT_FALLBACK_ONLY;
  if (rawCandidatesType === 'non-array') return CANDIDATE_PARSE_CLASSIFICATION.PARSE_MAPPING_LOSS;
  if (Number(droppedCandidateCount) > 0) return CANDIDATE_PARSE_CLASSIFICATION.PARSE_MAPPING_LOSS;
  if (Number(normalizedCandidateCount) > 0) return CANDIDATE_PARSE_CLASSIFICATION.CANDIDATES_PRESENT;
  if (rawCandidatesType === 'array') {
    return hasPatch
      ? CANDIDATE_PARSE_CLASSIFICATION.EMPTY_DECLARED_WITH_PATCH
      : CANDIDATE_PARSE_CLASSIFICATION.EMPTY_DECLARED;
  }
  return CANDIDATE_PARSE_CLASSIFICATION.ANALYSIS_ONLY;
}
