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
- Diff 非空，且不同于稳定检查点摘要；
- 文件清单符合当前语言 Candidate Contract；
- patchDigest 来自 Workspace manifest。

候选自报的 repository、commit 和 source reference 只作为可追踪信息，不能替代实际
Workspace Diff 的准入判断。

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

