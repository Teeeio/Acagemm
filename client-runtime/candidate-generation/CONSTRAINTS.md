# Candidate Generation Constraints

这是 03 模块的约束源文件，供开发伙伴实现确定性 Workflow 时引用。可执行字段和现有
Profile 语义仍由代码契约及 fixed-operator-profiles.mjs 提供；本文不覆盖它们。

## Round input

应用层在调用候选生成适配器前冻结：

~~~text
missionId / projectId / roundId / round ordinal
goal and objective
profileId and profile snapshot digest
baseline identity and oracle digest
test specification digest
Mission Workspace identity and baseline digest
remaining round / Mission / Agent budgets
frozen experience context
~~~

缺少 Workspace、Baseline、Profile 或预算的 Round 不能进入 Agent dispatch。

## Deterministic order

~~~text
settle previous generation
→ validate runtime/workspace preflight
→ restore rejected-round checkpoint
→ freeze round context and experience
→ render prompt
→ start Agent in active Mission Workspace
→ wait for provider terminal/release truth
→ inspect real Workspace Diff
→ validate declared files and language contract
→ reject repeated digest
→ assign candidate ordinal
→ expose Candidate Plan to client-owned policy
~~~

任何步骤失败都必须生成稳定错误码和有限终态；不得用空候选掩盖失败，也不得在资源释放
未确认时读取 Diff、应用 Patch 或开始下一轮。

## Agent authority

Agent 可以读取冻结 Context，并在活动 Mission Workspace 内创建或修改候选文件。Agent
返回的是提案：候选 id、假设、变更说明、实际文件清单和风险。

Agent 不能决定：

- 是否需要人工审批；
- 是否采纳或回滚；
- 是否开始下一轮；
- 是否修改测试矩阵、Profile、预算或 Oracle；
- 是否把研究结果、历史测试代码或其他 Workspace 当作 Baseline。

## Workspace authority

Workspace 端口拥有文件和 Diff 的事实来源。候选必须满足：

- Diff 位于活动 Mission Workspace；
- Agent 声明文件与实际 changed files 完全一致；
- changed files 是相对 Workspace Git HEAD 的完整候选差异，包括继承且仍保留的改动，
  不是本轮 Agent 的编辑记录。Prompt 提供生成前检查点清单；最终以真实 Diff 为准，
  新增文件须加入，恢复到 HEAD 的文件须移出，不自动替 Agent 补报；
- Diff 非空，且不同于稳定检查点摘要；
- 文件清单符合当前语言 Candidate Contract；
- patchDigest 来自 Workspace manifest。

候选自报的 repository、commit 和 source reference 只作为可追踪信息，不能替代实际
Workspace Diff 的准入判断。

## Candidate admission is fail-closed

工作区 Git Diff 是候选准入的唯一权威。任何绕过它的路径都必须关闭：

- Provider 未正常终结（不可恢复失败，例如 TLS 信任链或认证失败）时，Agent 声明的候选
  一个都不进入候选池：`*_CANDIDATE_INSPECTION_SKIPPED`、`passed: false`，已声明候选全部丢弃，
  并且不发 `candidate.not_proposed`。
- Agent 没有声明候选、工作区却有真实 Diff 时，观测所得候选必须显式标记降级
  （`candidateGenerationPath: workspace_observed`、`degraded: true`、
  `degradationReason: candidates_absent_but_diff_observed`），不得静默通过。
  这一支的分类是 `workspace_observed_candidate`，**不是** `workspace_capture_gap`：
  后者描述「声明了候选却看不见 Diff」（声明 ⊃ 观测），本支是「有 Diff 却没有声明」
  （观测 ⊃ 声明），方向相反。准入结论仍是 `passed: true` / `workspaceAdmission: passed`，
  编辑工具是否失败只由 `editToolStatus` 如实携带。

## Empty candidates carry exactly one root cause

`candidates: []` 只是结果表现，不是根因标签。分类固定优先级，落在
`candidateValidation.classification` 与 `candidate.not_proposed` 事件载荷上：

| # | classification | 含义 |
|---|---|---|
| 1 | `upstream_failure_no_candidate` | Provider 上游失败。这不是候选生成失败：不写候选池，也不发 `candidate.not_proposed` |
| 2 | `no_candidate_generated` | Provider 正常终结，确实没有提出候选 |
| 3 | `parse_mapping_loss` | 声明了候选，但原始条目无法映射为候选（丢弃计数大于 0） |
| 4 | `tool_failed_patch_pending` | 结构化编辑工具失败，patch 回退仍待处理 |
| 5 | `workspace_capture_gap` | 声明了候选但工作区没有真实 Diff，或声明文件与实际 Diff 不一致 |
| 6 | `patch_admission_failed` | 结果内 patch 存在但不合法，且没能产出 Diff |
| 7 | `task_contract_unmet` | 只返回分析文本，既无候选也无 patch |

优先级 1 → 3 → 4 → 6 → 7 → 2。第 5 类由工作区观测产出（`inspectCandidateDiff` 的
声明分支：无 Diff / 文件清单不一致），不参与该序列。

### 工作区缺件不是候选根因

语言契约要求某些文件存在于**工作区**（`requiredWorkspaceFiles`，含入口桥接文件），另要求 Diff
必须改动某个文件。两者归属方不同，因此失败码也不同：

- `CANDIDATE_LANGUAGE_CONTRACT_FAILED`：Diff 本身不满足契约（改了不该改的文件、没改该改的文件、
  入口内容不符）。这是候选质量问题，下一轮可以修。
- `CANDIDATE_WORKSPACE_CONTRACT_UNMET`：候选的 Diff 没问题，但工作区里**根本不存在**契约声明的
  文件。首轮工作区由 Baseline 物化而来，此时缺件通常意味着 Mission 的物化结果不满足自己声明的
  契约，而不是 Agent 做了什么。该结论带 `workspaceOwned: true` 与 `missingWorkspaceFiles` 列表，
  并**不写 `classification`**：分类只回答「候选去哪了」，把工作区缺陷贴成候选生成根因码会误导
  决策记录与 `loop.needs_human`。重试策略不变（Agent 下一轮仍可能创建该文件）。

同一份 `requiredWorkspaceFiles` 由 `operatorLanguageWorkspaceRequirement()` 单点提供：提示词里
告诉 Agent 的必需文件、收集工作区清单时检查的文件、准入校验时强制的文件三者必须同源。此前提示词
用 adapter 默认值、准入校验用 `[]`、清单收集用写死的 `['run.py']`，导致通用 Mission（没有固定
Profile 契约）被要求「必须存在」却从不被强制。

非空结果另有三个标记，与上面七个根因码并列、不参与优先级序列：
`candidate_verified`（声明并通过工作区 Diff 准入）、`workspace_observed_candidate`
（未声明但观测到 Diff 并准入，见上一节）、`candidate_inspection_skipped`（fail-closed 丢弃）。

## Classification answers "where did the candidate go", never "how was it produced"

分类只回答「候选去哪了」。生成路径与编辑工具状态是另一组事实，走
`candidateGenerationPath` / `editToolStatus` / `degraded` / `degradationReason`。
两者不得混用：拿工具失败去覆盖一个已准入候选的分类，等于给 passed 的候选贴上
空候选根因码，而该标签会流进 `loop.needs_human` 与决策记录。

## Degradation marks the generation path, never the bar

`candidateGenerationPath`、`degraded`、`degradationReason`、`editToolStatus`、
`patchValidation`、`workspaceAdmission` 是事实标记，透传到候选与事件载荷，
**不参与任何 `passed` 判定**。语言契约、必需文件、重复 digest、Oracle、固定测试矩阵与
Gate 一律不变：降级候选照样会被语言契约拒绝。

「编辑工具失败」与「编辑工具缺失」必须区分：Agent 用普通 shell 写入文件属于合法生成路径，
工具身份只看事件的类型/名称字段，**从不读取命令正文**；编辑工具从未出现（`absent`）
永不判降级。禁止用 `--reject`、忽略非法文件或部分应用来让 patch 回退"成功"。

### 重复 digest 的唯一例外

同一个 Workspace Diff 默认不得再买一个硬件测量序号：它已经消耗过一次设备时间。例外只有一种——
**该 digest 的每一次前序尝试都没有产生对候选的观测**（归档轮次的 `benchmark.experimentBrief`
为 `retest_same_candidate`），此时重测同一工件是同一实验的续跑，放行并仍分配新的测量序号。
判定同时要求前序次数小于上界（`MAX_UNOBSERVED_RETESTS = 2`）；缺 brief 的旧轮次**不算**
「无观测」，否则每个历史轮次都会重新开放自己的 digest。已确认的候选失败（correctness 不过、
性能不达标）永远关闭该 digest，不允许为了换一个结果重测。

## Test and decision authority

Candidate Generation 不执行测试。测试队列只接收应用后的 Workspace 候选，并返回绑定
candidateDigest 的 Correctness/Benchmark 凭证。Correctness 必须先于 Benchmark；
Accept Gate、采纳、回滚和下一轮由现有 accept-gate、workflow-kernel、iteration-loop
和 Application decision services 负责。

## Agent roles

| Role | Owns | Output |
|---|---|---|
| Candidate Generator | 在冻结 Context 下生成 patch 提案 | Candidate Plan |
| Workspace Adapter | 应用/回滚工作区并计算 Diff | Workspace receipt |
| Test Tool Adapter | 调用本地或远端测试队列 | task/evidence receipt |
| Workflow Policy | 解释 Gate、预算和停止条件 | adopt/rollback/next-round |
| Experience Collector | 从已验证凭证提取经验 | versioned observation |

这些角色通过端口通信；不能各自复制状态机或持久化规则。

