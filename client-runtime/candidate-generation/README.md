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

## Responsibilities

- 将固定 Profile、语言契约和测试规格拼成 Agent 输入。
- 只接受真实 Workspace Diff 作为候选准入权威。
- 检查 Agent 声明的文件清单与实际 Diff 是否一致。
- 检查语言契约、必需文件和候选 Diff 是否已经在历史轮次使用。
- 生成稳定的 candidateId/version，保留 Agent 原始身份。

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

inspectCandidateDiff 的 manifest 至少包含 dirty、diff、digest 和 changedFiles。
返回的 candidateValidation 是策略结果；调用方仍需通过命令日志保存外部效果和状态应用。

finalizeCandidateAdmission 不修改任何输入对象。它要求 workspaceFiles 和 entryContent
已由 Workspace 端口读取，并通过 validateOperatorLanguageCandidate 执行当前语言契约。

## Dependencies

允许依赖纯契约：operator-language.mjs、test-spec.mjs 和 fixed-operator-profiles.mjs。
禁止依赖 HTTP/TUI、state-store、持久化、Workspace 实现、Queue、Provider client、
Agent runtime facade 和 Node effectful builtins。

## Error and evidence rules

准入失败使用现有稳定错误码（*_CANDIDATE_DIFF_EMPTY、*_CANDIDATE_FILES_MISMATCH、
CANDIDATE_LANGUAGE_CONTRACT_FAILED 和 *_CANDIDATE_DIFF_REPEATED），由应用层映射为有限终态。
Candidate 的 patchDigest 必须来自实际 Workspace manifest；Agent 自报的来源只作信息标记。

## Verification

~~~bash
npm run test:candidate-generation
npm run test:agent-runtime
npm run test:module-boundary
~~~

## Known limitations

当前 Prompt 仍包含固定的 run.py bridge 说明，这是现有 Python/Triton Profile 的兼容要求。
未来 C++/CUDA/Rust 适配器应通过语言契约提供对应 entrypoint 说明，不应在本模块重新复制
Workflow 或 Gate 规则。

