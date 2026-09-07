# 03 候选生成｜Agent 与 Mission Workspace 重构交接说明

本文是 03 模块的开发交接文档。目标是让接手的开发伙伴可以在已有解耦边界上，把
“Agent 自由发散”继续重构为可观测、可量化、可恢复的确定性 Workflow，而不重复
实现测试队列、Gate、采纳或下一轮策略。

## 一、当前状态

03 已从 client-runtime/agent-runtime.mjs 中抽出独立的纯候选生成契约：

| 文件 | 作用 |
|---|---|
| client-runtime/candidate-generation/prompt.mjs | 根据冻结的 Round Context 渲染 Agent Prompt |
| client-runtime/candidate-generation/admission.mjs | 以 Workspace Diff 为事实源，执行文件清单、语言契约、重复摘要和 Candidate 身份准入 |
| client-runtime/candidate-generation/index.mjs | 对外公开模块入口 |
| client-runtime/candidate-generation/README.md | 输入、输出、职责和依赖合同 |
| client-runtime/candidate-generation/CONSTRAINTS.md | 03 的约束源和确定性顺序 |
| tests/candidate-generation-test.mjs | Prompt、Diff、语言、重复摘要和编号契约测试 |

agent-runtime.mjs 仍负责 Provider 生命周期、进程状态、取消和事件投影；它只调用
Candidate Generation 的公开函数，不再内联候选 Prompt 和准入细节。

当前刻意没有在本目录实现完整状态机。确定性状态机应放在 Application Workflow
边界，并由 workflow-kernel.mjs、iteration-loop.mjs 和现有 Application 服务共同
解释 Gate、预算、测试和下一轮。

## 二、目标生产路径

~~~text
TUI / HTTP
  -> Application Round Orchestration
  -> Round Preflight / Recovery
  -> freeze Round Context
  -> Candidate Generation Prompt
  -> Agent Provider（仅在 Mission Workspace 内工作）
  -> Agent terminal/release
  -> Workspace Diff inspection
  -> Candidate Generation admission
  -> Application Candidate/Test workflow
  -> Test Tool（本地 CPU/GPU 或未来云端队列）
  -> Correctness
  -> Benchmark
  -> Accept Gate
  -> adopt / rollback / next round
~~~

所有箭头表示调用关系，不表示模块可以直接导入下游实现。Application 和 Domain
只能依赖公开契约或注入端口；Git、文件、进程、HTTP、队列和硬件都由 Adapter 提供。

## 三、Round Context：进入 Agent 前必须冻结

一轮候选生成必须使用不可变的输入快照，至少包含：

- projectId、missionId、roundId、round ordinal；
- Mission goal/objective；
- Profile ID、Profile 快照和语义摘要；
- Baseline 身份、Baseline digest 和 oracle 身份；
- fixed test matrix/spec digest；
- Mission Workspace identity、稳定检查点和 baseline digest；
- Mission、round、Agent 剩余预算；
- 本轮冻结的经验上下文及其来源/版本。

冻结后，Agent 不能刷新 Profile、测试矩阵、Baseline、预算或经验版本。缺少
Workspace、Baseline、Profile 或预算的 Round 必须在 dispatch 前以稳定错误终止。

## 四、建议的确定性状态机

状态名可以按现有状态模型适配，但必须保持以下顺序和单向约束：

| 顺序 | 状态 | 进入条件 | 终态/失败 |
|---:|---|---|---|
| 1 | round.preflight | 前一轮已 settlement，资源释放已确认 | preflight error |
| 2 | workspace.restored | 已恢复 rejected-round checkpoint | restore error |
| 3 | context.frozen | Round Context 已生成并绑定 digest | context error |
| 4 | prompt.rendered | 调用 buildCandidateGenerationPrompt() | prompt error |
| 5 | agent.running | Provider 在活动 Workspace 启动 | dispatch/release error |
| 6 | agent.settled | Provider 返回终态且资源释放已确认 | timeout/cancel/failure |
| 7 | diff.inspected | Workspace adapter 返回真实 manifest | diff error |
| 8 | candidate.admitted | 文件、语言、重复摘要检查通过 | admission rejection |
| 9 | candidate.waiting_test | Candidate digest 已绑定测试请求 | queue submission error |
| 10 | candidate.decided | Correctness、Benchmark 和 Gate 有终态 | adopt/rollback/next round |

每个状态迁移都应记录：missionId、roundId、candidateDigest（若已产生）、输入摘要、
输出摘要、稳定错误码和时间戳。任何重试都必须依据同一 frozen context；不得在重试中
悄悄生成新预算、新 Profile 或新 Candidate ordinal。

资源释放未确认时禁止执行以下动作：

- 读取或接受 Workspace Diff；
- 应用、回滚或采纳 Candidate；
- 提交测试队列；
- 开启下一轮 Agent。

## 五、职责边界

| 角色 | 可以做什么 | 明确不能做什么 |
|---|---|---|
| Candidate Generation | 渲染 Prompt；检查真实 Diff；校验文件/语言/重复摘要；分配 Candidate 身份 | 启动 Agent、读写文件、提交测试、计算 Gate、采纳、回滚、推进下一轮 |
| Agent Runtime/Provider | 启动、观察、取消 Provider；归一化事件和 usage | 修改 Mission 持久化状态；替代 Workspace Diff 事实；决定采纳 |
| Workspace Adapter | 创建/恢复 Workspace；读取文件；计算真实 Git Diff 和 digest | 解释 Gate；自行决定 Candidate 是否可发布 |
| Test Tool Adapter | 接收绑定了 Candidate digest 的任务；串行执行 Correctness/Benchmark；返回证据 | 修改 Candidate；跳过 Correctness 直接 Benchmark；决定下一轮 |
| Workflow Policy | 解释预算、重试、Gate、adopt/rollback/next-round | 重新实现 Agent Prompt、Git Diff 或测试队列 |
| Experience Collector | 从可信终态提取版本化观察 | 把人工建议或模拟结果直接升级为可发布证据 |

Agent 返回的是 Candidate Plan，不是决策。recommendedCandidate 只表示 Agent 建议，
不表示通过 Gate，也不表示应该自动采纳。

## 六、候选准入不变量

实现或重构时必须保持以下规则：

1. patchDigest 必须来自活动 Mission Workspace 的 manifest。
2. Agent 声明的文件集合必须与真实 changedFiles 完全一致。
3. Workspace Diff 必须非空，且不能等于稳定 checkpoint digest。
4. 文件集合必须满足当前 operator-language.mjs 的语言契约。
5. 同一个 Candidate digest 不得重复消耗硬件测试序号。
6. Candidate 测试必须绑定 Candidate digest 和 Baseline oracle；不能使用 Candidate 自带的 reference() 作为正确性权威。
7. Simulation/CPU 证据不能变成 C550 live-hardware 发布证据。
8. fixed Profile 的 shape、dtype、correctness cases、benchmark profiles 和 retry budget 不得在 03 中弱化。
9. Agent 只能写活动 Mission Workspace，不能读取 Source Registry、其他 Workspace、历史测试目录或外部 Baseline。
10. 测试任务保持串行，terminal outcome 必须原子持久化。

## 七、稳定错误码

当前准入函数保留以下错误码，Application 层可以映射为 UI 状态，但不要改变其语义：

- *_CANDIDATE_DIFF_EMPTY
- *_CANDIDATE_FILES_MISMATCH
- *_CANDIDATE_DIFF_OBSERVED
- CANDIDATE_LANGUAGE_CONTRACT_FAILED
- *_CANDIDATE_DIFF_REPEATED

错误必须收敛到有限终态，不能通过返回“空候选”掩盖 Provider、Workspace 或资源释放
失败。

## 八、多语言和依赖扩展方式

语言契约集中在 client-runtime/operator-language.mjs，Profile 的固定语义集中在
client-runtime/fixed-operator-profiles.mjs。Candidate Generation 通过
mission.operatorProfile.candidateContract 接收：

- allowedFiles
- requiredChangedFiles
- requiredChangedAny
- requiredWorkspaceFiles
- contentFiles

新增 CUDA/C++、Rust 或其他语言时，应新增语言 adapter 和对应 entrypoint/build
contract，不要在 Prompt、Agent Runtime 或测试队列里复制 run.py 规则。
当前 Prompt 保留 run.py bridge 是为了兼容现有 Python/Triton Profile；这不是未来
语言扩展的长期硬编码方案。

算子源文件和依赖文件的打包、摘要、可信准入由
execution-package-contract.mjs / execution-package-store.mjs 负责。Candidate
Generation 只提供 Workspace Candidate 和 digest，不应重新实现文件打包或环境隔离。

## 九、开发顺序

建议开发伙伴按以下顺序实施确定性 Workflow：

1. 先定义 Round Context 和状态迁移 DTO，所有输入使用 digest/版本绑定。
2. 把现有 agent-round-service、round-preflight-service 和 main-round-orchestration-service
   的调用整理成一个明确的 round coordinator；不要把策略放回 agent-runtime.mjs。
3. 通过 candidate-generation/index.mjs 调用 Prompt 和 admission。
4. 为每个状态迁移补充稳定事件、错误和原子持久化恢复测试。
5. 通过 operator-test-tool.mjs 提交绑定 digest 的测试任务，保持 Correctness 在 Benchmark 之前。
6. 让 workflow-kernel.mjs / iteration-loop.mjs 只负责 Gate、预算和下一轮决策。
7. 最后接入经验沉淀；只能从已验证、身份匹配的 evidence 生成经验观察。

## 十、交付验收

重构提交至少应通过：

~~~bash
npm run test:candidate-generation
npm run test:codex
npm run test:state-domain-boundary
npm run test:module-boundary
npm run verify:local-c500-release
~~~

还应人工确认：

- 失败、取消、超时和资源未释放都有终态；
- 重试不会重复提交同一个 Candidate digest；
- Candidate evidence 与 Mission Workspace 中实际应用的 Candidate 一致；
- Agent 无法越过 Workspace 边界；
- 本地测试工具和未来云端 GPU 队列都可以实现同一个 Test Tool port；
- 没有新增第二套 Mission/Gate/Queue 状态机。

相关规范：

- client-runtime/candidate-generation/README.md
- client-runtime/candidate-generation/CONSTRAINTS.md
- docs/development/ARCHITECTURE.md
- docs/development/MODULE_OWNERSHIP.md
