# 模块归属与功能索引

本文用于多人和 AI 协作开发时快速判断“代码应该放在哪里”。这里的“主责角色”是建议的
代码所有权，不对应具体成员；实际负责人可以在团队分工时填写。

## 判断顺序

新增行为前依次判断：

1. 是否只是展示或用户交互？放入 TUI，未来 GUI 也只调用 HTTP API。
2. 是否只是 URL、JSON、SSE 或 HTTP 状态码转换？放入 HTTP Transport。
3. 是否在协调多个领域能力完成一个用户用例？放入 Application。
4. 是否是可纯计算的 workflow、Gate、Profile 或证据规则？放入 Domain Contract。
5. 是否涉及状态原子写入、Git、进程、网络或硬件？通过端口进入对应 Adapter。
6. 是否只是组装依赖和进程生命周期？只允许放入 Composition Root。

依赖只能沿以下方向前进：

```text
TUI / GUI
  -> HTTP Transport
  -> Application Use Cases
  -> Domain Contracts
  -> Ports
  -> Adapters
```

## 一级模块归属

| 归属模块 | 代码位置 | 功能 | 主要输入 | 主要输出 | 建议主责角色 |
|---|---|---|---|---|---|
| TUI 客户端 | `tools/local-c500-tester/` | 终端交互、只读状态展示、生产 API 调用、启动和环境诊断 | 键盘输入、HTTP snapshot、启动参数 | HTTP command、Ink UI、诊断报告 | 客户端开发 |
| TUI 展示组件 | `tools/local-c500-tester/components/` | 无副作用地渲染 Dashboard、表单、流程状态和活动指示 | ViewModel、viewport、本地表单状态 | Ink element tree | 客户端开发 |
| HTTP Transport | `client-runtime/server/` | 路由匹配、JSON/SSE、请求限制和 HTTP 错误映射 | HTTP request、注入的应用服务 | HTTP response、handled boolean | API/协议开发 |
| Application Use Cases | `client-runtime/application/` | 协调 Mission、Agent、Baseline、测试、Gate、采用和经验治理 | command/query DTO、领域函数、注入端口 | 应用结果、更新后的 state、稳定错误 | 工作流开发 |
| Domain Contracts | `client-runtime/*.mjs` 中的纯规则模块 | 定义 workflow、迭代、Profile、语义绑定、测试规格和错误规则 | 领域状态和不可变输入 | 决策、规范化 DTO、不变量结果 | 领域规则开发 |
| 状态与持久化 | `state-store.mjs`、`state-repository.mjs`、`command-journal.mjs` | 状态兼容、转换、串行写入、版本检查和命令幂等 | state snapshot、mutation、expected version | 原子持久化状态、冲突或恢复结果 | 状态平台开发 |
| Agent Runtime | `agent-runtime.mjs`、`agent-runtime/`、Provider clients | 能力发现、逻辑操作分发、Provider 生命周期和 usage 归一化 | runtime ID、operation、Mission context | 统一事件、Agent 结果、token usage | Agent 集成开发 |
| Workspace 与 Source | `workspace-manager.mjs`、`baseline-resolver.mjs`、`baseline-materializer.mjs`、`source-mirror-policy.mjs` | 隔离工作区、Diff/Checkpoint、Baseline 来源和材料化 | Mission、仓库、Source Registry、Candidate | Workspace identity、Diff、Baseline artifact | 工具链开发 |
| 测试队列 | `operator-test-queue.mjs` | 串行测试生命周期、轮询、取消和终态持久化 | 参数化 test payload、执行端口 | task snapshot、terminal outcome | 执行平台开发 |
| C550 执行适配器 | `local-c500-service-client.mjs`、`tools/local-c500-runner.py` | 把统一测试任务转换为本地 C550 执行和证据 | Candidate 工件、Baseline oracle、固定矩阵 | correctness、benchmark、环境和诊断工件 | 后端/算子开发 |
| Composition Root | `local-server.mjs`、`start.mjs`、`dev.mjs` | 构造服务、注入端口、绑定 HTTP、管理进程生命周期 | 环境变量和模块构造器 | 可运行的本地后端进程 | 平台集成开发 |
| Tests 与 Fixtures | `tests/`、`test-fixtures/`、`test-service/` | 保护模块合同、极端状态和端到端路径 | 测试输入、隔离运行目录 | 断言、fixture evidence、门禁结果 | 各模块主责共同维护 |

`local-c500`、`tester:c500` 和 `OPERATOR_LOCAL_C500_*` 是兼容接口名；执行模块的当前硬件
归属是 C550。C500 与 C550 是不同 Runner 身份，历史 C500 证据不能满足 C550 Gate。

## Application 子域归属

`application/` 不是一个可以任意放逻辑的公共目录。每个服务必须归属下列一个业务子域，
并通过构造参数接收副作用端口。

### 项目、Mission 与用户命令

| 服务合同 | 功能 | 输入 | 输出 |
|---|---|---|---|
| `projects-service.md` | Project 创建、迁移、归档和删除 | Project command/query | Project DTO、saved state |
| `missions-service.md` | Mission 列表和创建 | Mission input、workspace port | Mission list、saved state |
| `mission-query-service.md` | Mission 选择和事件查询 | Mission ID、event cursor | selected state、event DTO |
| `semantic-service.md` | 冻结 Semantic Snapshot | Mission semantic draft | frozen snapshot、saved state |
| `run-service.md` | 启动 Mission 生产流程 | Mission ID、run command | armed/research/Agent outcome |
| `mission-control-service.md` | 取消 Agent、追加反馈、停止 Mission | Mission ID、feedback/control command | persisted terminal/control state |
| `review-action-service.md` | 恢复和人工审查生命周期 | review request/cancel/resolve command | review outcome、saved state |
| `reset-service.md` | 受保护的测试 fixture 重置 | reset command、runtime capability | reset state |

### Source、Research 与 Baseline

| 服务合同 | 功能 | 输入 | 输出 |
|---|---|---|---|
| `source-service.md` | 注册 Git Source、统计来源 | source root、Mission state | source reference/count |
| `research-service.md` | 显式启动或取消 Research | Mission ID、research command | command result、saved state |
| `iteration-research-service.md` | 迭代中的 Research Agent 协调 | round research input | updated state |
| `baseline-service.md` | Baseline 材料化入口 | source、matrix command | materializer run ID、state |
| `baseline-source-service.md` | 选择 Baseline 来源策略 | Mission/state | source selection |
| `baseline-source-inspection-service.md` | 严格校验 Baseline 来源 | baseline context | validation/state |
| `round-artifact-guard.md` | Baseline 工件准入 | Mission/state | pass 或稳定错误 |
| `materializer-policy-service.md` | 决定 Materializer 当前动作 | materializer state | policy action |
| `baseline-materializer-command-service.md` | 提交 Materializer 命令 | baseline context | updated state |
| `baseline-materializer-recovery-service.md` | Materializer 失败恢复和 Research 重定向 | failed materializer state | recovery action/state |
| `baseline-benchmark-service.md` | 提交 Baseline Benchmark | baseline context、fixed matrix | updated state |
| `baseline-failure-projection.md` | 投影 Baseline 测试失败 | benchmark state | changed flag |
| `baseline-orchestration-service.md` | 串联完整 Baseline 流程 | `{ state, mission, reason }` | updated state |

### Candidate、测试与采用

| 服务合同 | 功能 | 输入 | 输出 |
|---|---|---|---|
| `candidate-validation-service.md` | Patch 应用、Benchmark 启动和阶段回滚 | candidate/benchmark command | validation result、state |
| `operator-test-service.md` | 查询和取消串行测试任务 | task ID、queue port | task DTO、queue metadata |
| `benchmark-projection-service.md` | 将 Queue snapshot 投影到 workflow | benchmark/task state | changed state |
| `decision-service.md` | 采用、拒绝和撤销采用 | decision command | decision result、recovery metadata |
| `repository-adoption-service.md` | 将通过 Gate 的 Candidate 写回仓库 | projected state、workspace port | changed state |
| `knowledge-service.md` | 编辑经验草稿和引用经验资产 | draft/reference command | governed state 或稳定错误 |

### 单轮迭代与自动推进

| 服务合同 | 功能 | 输入 | 输出 |
|---|---|---|---|
| `iteration-service.md` | 暴露稳定的迭代领域接口 | iteration ports | immutable iteration API |
| `main-round-orchestration-service.md` | 主 Agent 单轮的预检、恢复和启动 | `{ state, goal, retryMode? }` | updated state |
| `round-preflight-service.md` | 候选生成结算和 Runtime 预检 | round input | round context/blocker |
| `round-recovery-service.md` | 恢复被拒候选的 checkpoint | round state、workspace | recovery metadata |
| `agent-round-service.md` | 初始化并启动 Agent round | round input | updated state |
| `autopilot-context-service.md` | 组装自动推进上下文 | runtime state | autopilot context |
| `autopilot-candidate-service.md` | 选择下一候选 | state | candidate DTO |
| `autopilot-candidate-action-service.md` | 自动应用候选或恢复 | candidate state | updated state |
| `autopilot-validation-service.md` | 自动启动 Candidate Benchmark | candidate state | updated state |
| `autopilot-fixed-profile-service.md` | 固定 Profile 的 Baseline 后推进 | Mission state | state/action result |
| `autopilot-strict-source-service.md` | 严格 Source 路径推进 | Mission state | state/action result |
| `autopilot-candidate-baseline-service.md` | 普通候选的 Baseline 路径推进 | Mission state | state/action result |
| `autopilot-service.md` | 汇总自动推进分支 | runtime state | state/action result |
| `runtime-projection-service.md` | 投影 workflow 和 Agent 状态 | state/runtime snapshot | projected state |
| `runtime-advance-service.md` | 执行 Autopilot、Iteration、Reconcile 尾段 | projected state | advanced state |
| `runtime-state-pipeline-service.md` | 编排加载后状态的迁移和投影顺序 | state/runtime snapshot | projected state、changed flag |

### Runtime 查询与状态控制

| 服务合同 | 功能 | 输入 | 输出 |
|---|---|---|---|
| `runtime-query-service.md` | 查询状态、preflight 和活动 Workspace | Mission ID/query | state/readiness/workspace DTO |
| `runtime-state-service.md` | 处理 TUI patch、暂停/恢复和预算 | state command body | persisted state 或稳定错误 |

以上合同均位于 `client-runtime/application/`。修改某个服务时，必须同时更新同名 `.md` 和
对应 `tests/<name>-test.mjs`。

## 核心领域与基础设施文件

| 文件 | 归属 | 功能 | 不允许承担 |
|---|---|---|---|
| `workflow-kernel.mjs` | Domain / Workflow | outcome、不变量、恢复 effect 和一致性投影 | Provider、硬件、HTTP 调用 |
| `iteration-loop.mjs` | Domain / Iteration | 有界轮次和下一步决策 | 持久化、UI、文件操作 |
| `fixed-operator-profiles.mjs` | Domain / Profile | 固定算子语义和测试矩阵唯一来源 | 运行硬件、动态弱化 Profile |
| `semantic-snapshot.mjs` | Domain / Evidence | 将 Mission/Profile/Test 绑定为不可变摘要 | 修改 Workspace 或提交任务 |
| `test-spec.mjs` | Domain / Test Contract | 测试规格默认值和规范化 | 执行 Correctness/Benchmark |
| `workflow-error.mjs` | Shared Contract | 错误分类、重试性、序列化和恢复动作 | 直接改变 workflow state |
| `runtime-events.mjs` | Shared Contract | 生成统一 Mission 事件 | HTTP/SSE 输出 |
| `state-store.mjs` | State Domain | 状态兼容、领域转换和 Gate 投影 | HTTP 格式和 TUI 展示 |
| `state-repository.mjs` | Persistence Port | 排他队列、乐观版本和原子 persist | workflow 决策 |
| `command-journal.mjs` | Persistence | 幂等 command journal | 业务分支选择 |
| `agent-runtime.mjs` | Agent Adapter Facade | Agent 用例生命周期和 Provider 协调 | Mission 持久化、硬件执行 |
| `workspace-manager.mjs` | Git Adapter | Workspace、Diff、checkpoint、restore、adoption | Gate 结论 |
| `operator-test-queue.mjs` | Execution Port | 串行任务、poll/cancel、终态持久化 | Mission 推进和采用 |
| `local-c500-service-client.mjs` | C550 Adapter | 本地 C550 任务与工件适配 | Gate 和迭代决策 |
| `local-server.mjs` | Composition Root | 组装模块、注入依赖、进程生命周期 | 新增领域规则 |

## 客户端文件归属

| 文件 | 功能 | 允许调用 | 禁止行为 |
|---|---|---|---|
| `launcher.cjs` | 准备 Node/依赖并启动 TUI | 子进程、环境变量 | 实现 workflow |
| `production-api.mjs` | Runtime 生命周期、HTTP client、C550 preflight | Production HTTP API、只读环境探测 | 直接写 persisted state |
| `tui.mjs` | 键盘交互和页面组合 | `production-api.mjs`、纯 ViewModel | 调用 Agent/Runner |
| `tui-state.mjs` | Runtime state 到 ViewModel 的纯投影 | 共享 label/format helper | 网络、文件和进程副作用 |
| `tui-layout.mjs` | 终端尺寸到布局 DTO | 纯计算 | 修改状态 |
| `tui-refresh.mjs` | 并发刷新结果仲裁 | snapshot | 发起业务决策 |
| `terminal-screen.mjs` | alternate-screen 生命周期 | stdout | workflow/state 逻辑 |
| `components/` | Ink 展示组件 | ViewModel | HTTP、文件、进程和持久化 |
| `workflow-summary.mjs` | E2E/冷启动报告 | state/tasks | 修改运行状态 |

## 跨模块改动规则

- UI 新功能：先确认已有 HTTP API；没有时增加 `server route -> application service`，不要在
  TUI 中访问状态文件。
- 新 workflow 状态：先修改 Domain Contract，再由 Application 协调，最后补 Transport 和 UI
  投影。
- 新 Agent 后端：在 `agent-runtime/definitions.mjs` 注册能力并实现 Provider client，不在业务
  服务中按 Provider 名称分支。
- 新执行后端：实现统一执行端口；不得复制 Queue、Profile、Gate 或 Mission 推进逻辑。
- 新持久化字段：更新状态兼容/迁移、语义摘要影响分析、模块合同和恢复测试。
- 任意跨模块 API 改动：同一提交更新调用方、模块文档和契约测试。

## 分工验收

模块负责人交付前至少确认：

- 修改只落在本模块职责内，跨模块调用经过公开 API 或注入端口。
- 同名模块合同已更新，输入、输出、错误、副作用和不变量没有遗漏。
- 最近的模块测试通过。
- 跨模块变更通过 `npm run verify:local-c500-release`。
- 无硬件变更在条件允许时通过 `npm run verify:non-hardware-robustness`。
