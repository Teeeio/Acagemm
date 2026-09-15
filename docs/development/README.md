# 开发文档入口

> **当前入口（2026-09-15 UTC，最新真实验收）**：冻结生产源码
> `21c6d7868bd3c5aa74dfcc098f87e3ad4236f948`（git clean）。affine smoke 1 次运行 / 2 候选 /
> 2 次实际模型观测；**严格 N20 20/20 `full_success`、20/20 独立验证且可比、44/44 实际模型观测
> （`deepseek-v4-flash`）、40 个不同候选**；另做**单独** reduction / normalization 两家族覆盖
> （每族两轮）4 个不同候选、4/4 实际模型观测，不计入 N20。权威事实见
> [`evidence/run-diagnostics-20260914/acceptance.json`](evidence/run-diagnostics-20260914/acceptance.json)，
> 原件 reader/diagnostics 见
> [`n20-recovered-20260915/reader.json`](evidence/run-diagnostics-20260914/n20-recovered-20260915/reader.json)、
> [`coverage-recovered-20260915/reader.json`](evidence/run-diagnostics-20260914/coverage-recovered-20260915/reader.json)；
> 范围与冻结输入见 [`evidence/closeout-20260915/ACCEPTANCE.md`](evidence/closeout-20260915/ACCEPTANCE.md)；
> 交付状态与离线复核结果以
> [`evidence/closeout-20260915/closeout.json`](evidence/closeout-20260915/closeout.json) 为单一事实源，
> 便携交付包的操作说明见
> [`evidence/closeout-20260915/PORTABLE.md`](evidence/closeout-20260915/PORTABLE.md)。
> 结论限定该冻结源码、本机共享 GPU 与既定矩阵，
> `publishable=false`；历史失败/unknown 原样保留；Phase 3（KernelWiki 导入器 + 确定性选择器）
> **尚未开始**；本批无生产代码变更、未推送远端。术语：「下游」仅指 dispatch 平台 agent，
> 被测的 Acagemm 运行 agent 不是下游。
>
> 下方 2026-09-12 的「当前状态入口」「Phase 2 当前入口」**均为历史**，最新状态以上方入口为准。

> **历史状态入口（2026-09-12，已被上方 2026-09-15 入口取代）**：交接分支 `handoff/codex-job-supervisor-p1`；实际执行后端是
> 本地共享 NVIDIA GPU（真实本地开发测量、不可发布）与 CPU E2E；Claude Code 是 TUI 默认 Agent
> Runtime，Codex CLI 走显式路径，当前共享 GPU 真实 E2E 入口须显式 `E2E_AGENT_RUNTIME=claude-code`
> 。P1 轮次反馈闭环（`TEAM_HANDOFF.md` §14 第 1–5 项）已验收，
> 验收基线见 [`P1_FEEDBACK_ACCEPTANCE.md`](P1_FEEDBACK_ACCEPTANCE.md)，原件与边界见
> [`evidence/p1-feedback-20260912/README.md`](evidence/p1-feedback-20260912/README.md)。
> 第一阶段的验收**不等于** N=20 稳定性结论，也**不表示** §14 第 6–7 项（Phase 2/3）已完成。
> `TEAM_HANDOFF.md` §3 指出的 README / GOAL / 旧 handoff 反向描述已按本节口径订正（即 §14 第 8 项），
> 历史运行记录（含 C500/C550 历史身份）保持原样。
>
> **Phase 2 历史入口（2026-09-12，最新状态见上方 2026-09-15 入口）**：诊断资格 → 版本化统一决策与治理已按劳务任务集成
> （diagnostic predicate + versionedGate + production/adoption/governance/facts/prompt/UI +
> unknown/binding），对应冻结契约 [`P2_EVIDENCE_ACCEPTANCE.md`](P2_EVIDENCE_ACCEPTANCE.md)；
> **Phase 2 无硬件验收通过：release 136 / non-hardware 38，exit 0**；485 个代码与测试文件
> 运行前后哈希一致。没有新实机运行，**不构成 N=20 或真实发布**。当前证据索引与边界见
> [`evidence/p2-evidence-20260912/README.md`](evidence/p2-evidence-20260912/README.md)；
> 实机回归的观察/台账规则见 [`REAL_GPU_REGRESSION.md`](REAL_GPU_REGRESSION.md)。
> Phase 3（KernelWiki 导入器 + 确定性选择器）**尚未开始**。

本目录是多人开发时的文档入口。开始修改代码前，按以下顺序阅读：

1. [`ARCHITECTURE.md`](ARCHITECTURE.md)：生产链路、依赖方向和不可破坏的边界。
2. [`MODULE_OWNERSHIP.md`](MODULE_OWNERSHIP.md)：模块归属、功能、输入输出和建议主责角色。
3. 待修改目录最近的 `README.md` 或同名模块合同，例如
   `client-runtime/application/foo-service.md`。
4. [`MODULE_CONTRACT_TEMPLATE.md`](MODULE_CONTRACT_TEMPLATE.md)：新增模块文档模板。

## 文档分工

| 文档 | 回答的问题 | 更新时机 |
|---|---|---|
| `ARCHITECTURE.md` | 系统如何分层，依赖可以指向哪里 | 生产链路或模块边界改变 |
| `MODULE_OWNERSHIP.md` | 功能属于哪个模块，应该由谁主责 | 新增、拆分、合并或转移职责 |
| `GENERIC_OPERATOR_GOAL.md` | 通用算子闭环、执行包与隔离环境的范围和验证记录 | 本轮实施/阻塞/验收变化 |
| `P1_FEEDBACK_ACCEPTANCE.md` | P1 §14.1–§14.5 轮次反馈闭环的验收命题、证据类型与结果边界 | 轮次反馈闭环验收变化 |
| `P2_EVIDENCE_ACCEPTANCE.md` | Phase 2 §14.6 诊断资格/统一决策/治理的冻结验收命题与结果边界 | Phase 2 实现或验收变化 |
| `evidence/p2-evidence-20260912/README.md` | Phase 2 证据原件、预检失败根因、最终门禁与实机边界 | Phase 2 证据或最终门禁结果变化 |
| `REAL_GPU_REGRESSION.md` | 真实共享 GPU 回归的观察/台账规则（配置指纹、预算终态、N 语义） | 观察契约或台账规则变化 |
| `STATE_DOMAIN_GOAL.md` | 当前状态领域解耦的范围、决策、风险和验收记录 | 实施阶段或验证结果改变 |
| `CODEX_AGENT_DIAGNOSTIC_HANDOFF.md` | 真实 Codex Agent 闭环的证据、复现命令、开放问题和专家交接 | Agent/CLI/网络/进程生命周期诊断变化 |
| `CURRENT_TASK_HANDOFF.md` | 当前主线的提交状态、P0/P1 进度、短期/长期任务、验收和接手步骤 | 任务转交、工作树或主线阶段变化 |
| 模块 `README.md` | 目录公开合同是什么 | 输入、输出、API、不变量或副作用改变 |
| `application/*.md` | 单个应用服务如何调用 | 服务参数、返回值、错误或依赖改变 |
| `operator-studio-module-workflow.html` | 模块如何参与完整 workflow | 状态、调用关系或数据流改变 |
| `operator-studio-team-briefing-15min.md` | 如何向团队讲解和分工 | 架构或近期任务发生明显变化 |

本轮通用算子的机器可读验证摘要与完整门禁日志由 `GENERIC_OPERATOR_GOAL.md` 链接索引；
这些回归产物不能替代真实隔离后端或真实 Agent 的产品验收（provider 中立，验收须按 provider
分别成立，不能用一个 provider 的结果覆盖另一个）。

03 候选生成的开发伙伴应先阅读
`MODULE_03_CANDIDATE_GENERATION_HANDOFF.md`，再进入
`client-runtime/candidate-generation/CONSTRAINTS.md` 和对应模块 README。

历史方案位于 `docs/superpowers/`，用于追溯设计过程，不代表当前生产合同。
