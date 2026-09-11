# Candidate Generation Module

模块归属：03 候选生成｜Agent 与 Mission 工作区。本目录提供候选生成阶段的纯契约和适配器边界，
便于 Agent、Workspace、测试队列和工作流负责人并行开发。

## Purpose

把 Agent 的候选 Prompt、Workspace Diff 准入、语言契约检查和候选身份分配从
agent-runtime.mjs 的 provider 生命周期中抽出。模块只定义候选生成阶段的输入输出，
不拥有 Mission 持久化、Queue、Gate、采纳或下一轮决策。

## Public API

| Export | Input | Output |
|---|---|---|
| buildCandidateGenerationPrompt() | Mission、目标、Workspace 清单、Baseline、测试规格、边界指令 | provider 可消费的候选生成 Prompt |
| inspectCandidateDiff() | Agent 结果、Workspace Diff manifest、稳定检查点摘要、provider 元数据 | 候选准入结果和候选列表 |
| candidateWorkspaceRequirements() | Mission | required workspace/content files |
| finalizeCandidateAdmission() | 准入结果、Mission、Workspace 文件/内容、历史摘要、轮次号 | 语言检查、重复 Diff 检查和候选 ordinal 结果 |
| CANDIDATE_OUTCOME / CANDIDATE_GENERATION_PATH / CANDIDATE_PARSE_CLASSIFICATION | — | 冻结的分类枚举（空候选七类、生成路径三类、解析层六类） |
| classifyEmptyCandidateOutcome() / classifyParsedCandidateGeneration() | Provider 终结事实、候选声明与丢弃计数、编辑工具状态、patch 结果 | 唯一根因分类（固定优先级，纯函数） |
| editToolSignal() | Provider 事件流 | `failed` / `succeeded` / `absent`（只读事件类型与名称字段，从不读命令正文） |
| describeGenerationPath() | 生成路径、编辑工具状态、降级原因 | `candidateGenerationPath` / `degraded` / `degradationReason` / `editToolStatus` 标记 |

## Responsibilities

- 将固定 Profile、语言契约和测试规格拼成 Agent 输入。
- 只接受真实 Workspace Diff 作为候选准入权威。
- 检查 Agent 声明的文件清单与实际 Diff 是否一致。
- 检查语言契约、必需文件和候选 Diff 是否已经在历史轮次使用。
- 生成稳定的 candidateId/version，保留 Agent 原始身份。
- 对 `candidates: []` 给出唯一根因分类，不留下无因标签。
- 对 patch 回退等非结构化生成路径显式标记降级，但绝不因此放宽准入标准。

## Non-Responsibilities

- 不启动或取消 Agent。
- 不读写文件、不调用 Git、不创建 Workspace。
- 不提交 Operator Test Queue。
- 不执行 Correctness/Benchmark。
- 不计算 Accept Gate，不决定 adopt、rollback 或 next round。
- 不改变 fixed-operator-profiles.mjs 中的 shape、dtype、测试矩阵和重试预算。

## Input and output contracts

buildCandidateGenerationPrompt 的 boundaryInstruction、Workspace inventory 和
Baseline 内容必须由应用层/Workspace 端口提供。该函数只渲染字符串，不读取路径。
当 Mission 带有 `semanticSnapshot` 时，Prompt 会显式渲染其 snapshot identity/digest、
semantic/correctness/benchmark contracts、raw intent 及未解决冲突/unknowns；这些字段是
算子语义的权威事实，Agent 不得自行弱化或猜测。若 Mission 或 Baseline 带有可选的
`iterationContext`/`iterationEvidence`，Prompt 会将它们标记为不可信的历史证据，供下一轮
定位失败 case、benchmark profile、候选 digest 和已尝试方向；它们不能覆盖冻结契约，也不能
触发 Queue/Gate 决策。字段缺失时不生成对应段落，保持通用 Mission 的 Prompt 简洁。
生产流程中的上一轮经验优先来自应用层冻结的 `experienceContext`：
`roundExperienceService` 按 Project、Mission、Round 和 Scope 检索并绑定人工指导、已验证
的执行观察与版本摘要，再由 Agent Runtime 以 `experienceInstruction` 传入 Prompt。它与
`iterationContext`/`iterationEvidence` 是不同层次：前者是受 Project/版本约束的经验上下文，
后者是本轮或上一轮的局部诊断快照。两者都只是不可信事实，不能替代 Semantic Snapshot、
独立 oracle、固定测试矩阵或 Gate；执行观察必须来自已验证的测试队列终态，不能由普通经验
写入 API 伪造。
inspectCandidateDiff 的 manifest 至少包含 dirty、diff、digest 和 changedFiles。
返回的 candidateValidation 是策略结果；调用方仍需通过命令日志保存外部效果和状态应用。
当 Provider 没有可用的文件编辑工具时，Prompt 允许返回顶层统一 Git Patch；Patch 的路径
校验与应用属于 Agent Runtime/Workspace 适配器，本模块仍只以最终 Workspace Diff 作为准入权威。

finalizeCandidateAdmission 不修改任何输入对象。它要求 workspaceFiles 和 entryContent
已由 Workspace 端口读取，并通过 validateOperatorLanguageCandidate 执行当前语言契约。

## Adding test inputs for another operator

新增算子类型时只增加 Mission 的语义与测试数据，不复制候选生成流程。先冻结一个
`semanticSnapshot`，至少填写：

```json
{
  "semanticContract": {
    "operator": "vector_add",
    "inputs": [{"name":"x","shape":["B","N"],"dtype":["float16","float32"],"layout":"contiguous"}],
    "outputs": [{"shape":["B","N"],"dtype":"same-as-x"}],
    "math": {"formula":"y = x + bias"},
    "edgeCases": ["N=1", "N not divisible by tile"],
    "invariants": ["不修改输入", "输出 shape 与 x 相同"]
  },
  "correctnessContract": {"requiredCategories":["minimal","representative","boundary"]},
  "benchmarkContract": {"primaryProfile":"primary","metric":"latency_p50"}
}
```

然后在冻结 `testSpec` 中声明 correctness 类别、容差、benchmark profiles、warmup 和
repeats；由 Baseline Oracle 实现 `get_test_cases()` 与 `get_benchmark_inputs()`，每个
输入都应是确定性的、具名的、可序列化的包内数据。Candidate 只能修改实现路径，不能
修改这些输入工厂或 `reference(inputs)`。Python/Triton 使用 `run.py` bridge；C++/CUDA
等语言通过对应 language adapter 声明入口和允许文件，测试输入结构保持不变。

推荐为每种算子至少覆盖：最小规模、代表规模、非整除/边界规模、不同 dtype，以及与
生产最接近的 primary benchmark。新增 case 后必须同步更新 semantic snapshot digest、
Baseline oracle 和 testSpec，避免 Agent 看到的语义与队列实际执行的输入不一致。

## Dependencies

允许依赖纯契约：operator-language.mjs、test-spec.mjs 和 fixed-operator-profiles.mjs。
禁止依赖 HTTP/TUI、state-store、持久化、Workspace 实现、Queue、Provider client、
Agent runtime facade 和 Node effectful builtins。

## Error and evidence rules

准入失败使用现有稳定错误码（*_CANDIDATE_DIFF_EMPTY、*_CANDIDATE_FILES_MISMATCH、
CANDIDATE_LANGUAGE_CONTRACT_FAILED 和 *_CANDIDATE_DIFF_REPEATED），由应用层映射为有限终态。
Candidate 的 patchDigest 必须来自实际 Workspace manifest；Agent 自报的来源只作信息标记。
`classification.mjs` 提供的分类常量（`CANDIDATE_OUTCOME`、`CANDIDATE_GENERATION_PATH`、
`CANDIDATE_PARSE_CLASSIFICATION`）是这些终态的语义载体：`*_CANDIDATE_NOT_PROPOSED` 承载
空候选七类之一，`*_CANDIDATE_INSPECTION_SKIPPED` 表示 Provider 未正常终结因而声明候选
全部丢弃，`*_CANDIDATE_UPSTREAM_FAILURE` 表示这不是候选生成失败。降级标记
（`degraded` / `degradationReason` / `candidateGenerationPath` / `editToolStatus` /
`patchValidation` / `workspaceAdmission`）只描述生成路径，不参与任何 `passed` 判定。

`editToolStatus` 由 `editToolSignal()` 产出，**必须分两个字段通道**判定工具身份，命令正文永远不参与匹配：

| Provider | 结构化编辑 | shell / 只读工具 | 身份来源 |
|---|---|---|---|
| Codex | `item.type: 'file_change'` | `item.type: 'command_execution'` | `item.type` |
| Claude Code | `item.name: 'Write' / 'Edit'` | `item.name: 'Bash' / 'Read'` | `item.name`（`item.type` 恒为 `command_execution`） |

工具名优先于事件类型，否则 Claude 那条 `item.type: 'command_execution'` 的 `Write` 会被 shell 分支排除。
`absent`（编辑工具从未出现）永不判降级——Agent 用普通 shell 写盘是合法的生成路径；只有出现且失败才是
`failed`，且首个失败即定调，后续 shell 写盘成功不给它翻案。回归夹具使用真实采集到的事件形状，
不是推断的 schema。

## Verification

~~~bash
npm run test:candidate-generation
npm run test:agent-runtime-candidate-admission
npm run test:round-settlement-interleaving
npm run test:agent-runtime
npm run test:module-boundary
~~~

## Known limitations

当前 Prompt 仍包含固定的 run.py bridge 说明，这是现有 Python/Triton Profile 的兼容要求。
未来 C++/CUDA/Rust 适配器应通过语言契约提供对应 entrypoint 说明，不应在本模块重新复制
Workflow 或 Gate 规则。
