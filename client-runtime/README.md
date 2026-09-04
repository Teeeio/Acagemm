# Client Runtime Module Contract

## Purpose

`client-runtime` is the local application backend. It owns Mission state, workflow orchestration, Agent coordination, isolated workspaces, serialized operator tests, evidence decisions, and local persistence.

## Inputs

- HTTP commands from the TUI or Web client.
- Agent events and structured results from registered runtimes.
- Operator-test snapshots from the configured test backend.
- Persisted state and command journal entries from the active tester home.

All external outcomes must be normalized before changing Mission state.

## Outputs

- Versioned product state exposed by `/api/state`.
- Runtime health and capability descriptions.
- Runtime events, audit records, candidate evidence, and Gate decisions.
- Mission Workspace changes, checkpoints, test tasks, and artifacts.

## Module Catalog

| Module | Responsibility | Primary input | Primary output |
|---|---|---|---|
| `local-server.mjs` | Runtime composition root and process bootstrap | HTTP request, runtime ports | assembled routes/services and process lifecycle |
| `server/` | HTTP transport and thin route adapters | request/response and injected services | HTTP/SSE/static responses |
| `application/` | transport-neutral use-case orchestration | commands, queries, injected ports | application results and stable errors |
| `application/projects-service.mjs` | Project lifecycle and repository bootstrap | Project command/query | Project DTO or saved state |
| `application/missions-service.mjs` | Mission list and creation | Mission input, state and workspace port | saved Mission state |
| `application/mission-query-service.mjs` | Mission selection and event queries | Mission ID, event cursor | saved state or event DTO |
| `application/semantic-service.mjs` | Semantic Snapshot freeze | Mission semantic draft | frozen snapshot and saved state |
| `application/research-service.mjs` | Mission research start/cancel | Mission ID and research command | command result or saved state |
| `application/run-service.mjs` | Mission run start orchestration | Mission ID and run body | Agent, research, or armed state |
| `application/review-action-service.mjs` | Mission resume and human review lifecycle | review command | command result or resolved outcome |
| `application/decision-service.mjs` | adoption, rejection, and adoption reversal | decision command | command result and recovery metadata |
| `application/candidate-validation-service.mjs` | Patch, Benchmark, and stage rollback orchestration | Candidate/Benchmark command | command result or validation response |
| `application/baseline-service.mjs` | authoritative Baseline materialization orchestration | source and matrix command | command result and materializer run ID |
| `application/operator-test-service.mjs` | serialized test task queries and cancellation | task ID and queue port | task DTO or queue metadata |
| `application/mission-control-service.mjs` | explicit Mission lifecycle controls | IDs or feedback body | persisted state and control result |
| `application/knowledge-service.mjs` | Knowledge draft editing and asset references | draft/reference command | persisted state or governance response |
| `application/runtime-query-service.mjs` | Runtime state, preflight, and active workspace projections | Mission ID or query | state, readiness, or workspace DTO |
| `application/runtime-state-service.mjs` | TUI state patch and pause/budget commands | state command body | persisted state or stable validation error |
| `application/reset-service.mjs` | guarded test-fixture reset orchestration | reset command | reset fixture state |
| `application/source-service.mjs` | source repository registration and counting | Mission source root | source references/count |
| `application/iteration-research-service.mjs` | Agent research start/cancel coordination | research command | updated state |
| `application/round-recovery-service.mjs` | rejected-round checkpoint restoration | round state/workspace | recovery metadata |
| `application/agent-round-service.mjs` | Agent round initialization and launch | round input | updated state |
| `application/round-preflight-service.mjs` | generation settlement and runtime preflight | round input | round context |
| `application/round-artifact-guard.mjs` | strict baseline artifact admission | mission/state | pass or stable error |
| `application/baseline-source-service.mjs` | baseline source policy selection | mission/state | source selection |
| `application/materializer-policy-service.mjs` | baseline materializer state policy | materializer state | policy action |
| `application/baseline-failure-projection.mjs` | baseline failure state projection | benchmark state | changed flag |
| `application/benchmark-projection-service.mjs` | Operator Test snapshot projection | benchmark state | changed state |
| `application/repository-adoption-service.mjs` | Accept Gate repository adoption | projected state | changed state |
| `application/autopilot-candidate-service.mjs` | automatic candidate priority selection | state | candidate DTO |
| `application/autopilot-context-service.mjs` | automatic iteration context preparation | state | autopilot context |
| `application/autopilot-candidate-action-service.mjs` | automatic candidate apply/resume actions | candidate state | updated state |
| `application/autopilot-validation-service.mjs` | automatic candidate benchmark start | candidate state | updated state |
| `application/autopilot-service.mjs` | automatic iteration progression boundary | runtime state | state/action result |
| `application/autopilot-fixed-profile-service.mjs` | fixed Profile post-baseline progression | Mission state | state/action result |
| `application/autopilot-strict-source-service.mjs` | strict source autopilot progression | Mission state | state/action result |
| `application/autopilot-candidate-baseline-service.mjs` | ordinary candidate baseline progression | Mission state | state/action result |
| `application/baseline-benchmark-service.mjs` | baseline benchmark command submission | baseline context | updated state |
| `application/baseline-materializer-command-service.mjs` | baseline materializer command submission | baseline context | updated state |
| `application/baseline-source-inspection-service.mjs` | strict baseline source verification | baseline context | validation/state |
| `application/baseline-materializer-recovery-service.mjs` | materializer failure recovery and research redirect | materializer state | state/action |
| `application/iteration-service.mjs` | formal iteration dependency boundary | iteration ports | immutable iteration API |
| `application/runtime-projection-service.mjs` | workflow and Agent state projection | state/runtime | projected state |
| `application/runtime-advance-service.mjs` | Autopilot, iteration, and reconcile tail | projected state | advanced state |
| `application/baseline-orchestration-service.mjs` | complete Baseline workflow orchestration | baseline command | updated state |
| `application/runtime-state-pipeline-service.mjs` | loaded-state migration and projection pipeline | state/runtime snapshot | projected state and changed flag |
| `application/main-round-orchestration-service.mjs` | main Agent round preflight/recovery/launch | round command | updated state |
| `state-store.mjs` | state compatibility, transitions, persistence | product state, snapshot | normalized persisted state |
| `state-repository.mjs` | serialize state access and enforce optimistic versions | load/save adapters, mutation | isolated snapshot or saved state |
| `iteration-loop.mjs` | bounded iteration policy | Mission state, injected deps | next workflow state/action |
| `workflow-kernel.mjs` | invariants and recovery projection | product state | violations/effect/reconciled state |
| `runtime-events.mjs` | append canonical Mission events | state, type, payload, source | appended event |
| `agent-runtime.mjs` | Agent use-case lifecycle | Mission context, runtime events | Agent state/results |
| `agent-runtime/` | definitions, registry, dispatch, capabilities | runtime ID, operation | definition or provider call |
| `cli-command.mjs` | Resolve direct Agent executables behind Windows npm shims | provider and configured command | executable plus fixed argument prefix |
| `operator-test-queue.mjs` | serialized test lifecycle | test payload | persisted task snapshot |
| `local-c500-service-client.mjs` | C550 production execution and isolated CPU E2E command execution | queue task payload | correctness/benchmark artifacts |
| `workspace-manager.mjs` | Git workspace isolation | Mission/repository/candidate | Diff/checkpoint/restore result |
| `fixed-operator-profiles.mjs` | immutable operator contracts | Profile ID | frozen Profile/test matrix |
| `semantic-snapshot.mjs` | bind semantics to evidence | Mission/Profile/test task | immutable semantic digest |

## Invariants

- State transitions preserve active Mission projection consistency.
- Runtime API, SSE projection, and auto tick state access share the State Repository exclusive queue.
- No simulation result is publishable.
- Test evidence and workspace candidate identities match.
- Every Candidate test uses the persisted Baseline `oracleRunPy`; Candidate-owned
  `reference()` code is never the correctness authority.
- External failures use `workflow-error.mjs` normalization.
- Runtime events use `runtime-events.mjs`; do not define local event appenders.
- Provider capability checks use the Agent Runtime registry.
- `OPERATOR_LOCAL_CPU=1` is restricted to the deterministic CPU E2E runner. Its results use
  `source=cpu-e2e` and `liveHardware=false`; this mode must never satisfy C550 evidence requirements.
- C550 is the only current MetaX production target. New Mission hardware, test-matrix environments,
  simulation descriptors, and execution evidence use `C550`. C500 and C550 are distinct runner
  identities and must never match each other.
- `local-c500`, `LOCAL_C500_*`, and `OPERATOR_LOCAL_C500_*` remain stable compatibility identifiers.
  Historical evidence that actually came from C500 retains its original label and cannot satisfy a
  C550 Gate.

## CPU End-to-End Acceptance

- `npm run e2e:cpu-iteration` is the deterministic fixture smoke test. It verifies the API,
  serialized queue, actual CPU runner, independent Baseline oracle, Gate, adoption, and Knowledge
  flow without invoking a real Agent.
- `npm run e2e:cpu-agent-iteration` is the manual real-Agent acceptance test. It requires a logged-in
  Claude Code CLI by default (`E2E_AGENT_RUNTIME=codex-cli` selects Codex). The harness simulates only
  Project/Mission creation, Baseline submission, and the initial Run command. It then performs GET
  polling while the production autopilot generates and applies a real Candidate, runs actual CPU
  Correctness and Benchmark work, closes the failed-target round, and starts the next Agent round.
- The real-Agent test intentionally uses an unreachable performance target so the continuation branch
  is deterministic. After observing the next round it calls the public stop action solely for cleanup.
  It is intentionally excluded from routine verification because it consumes a live Agent session.

## Dependency Rules

- Pure policy modules may depend on shared contracts, not adapters.
- Adapters may depend on Node APIs and external processes.
- `state-store.mjs` must not import the Agent service facade.
- Provider clients must not import HTTP routes or TUI modules.

## TODO：通用测试执行工具

> 状态：待实现。以下内容是目标契约，不代表当前代码已经支持。当前生产实现仍由
> `operator-test-queue.mjs` 调用 `local-c500-service-client.mjs`。

### 目标

把当前 C550 执行适配器包装为统一的测试执行工具。上层只描述“执行什么测试”和
“需要什么能力”，不区分本地进程或远端服务。工具负责查询后端、匹配能力、传输
执行包、等待终态，并返回统一结果或统一错误。

```text
Operator Test Queue
  -> 通用测试执行工具
     -> 本地执行后端适配器
     -> 远端执行后端适配器
```

`Operator Test Queue` 继续拥有串行调度和终态持久化。通用执行工具不得决定 Mission
推进、Candidate 采纳或 Accept Gate 结果。

### 建议公开接口

| 接口 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `queryBackends(query)` | 位置、硬件、操作、Profile 等过滤条件 | `ExecutionBackend[]` | 查询本地和远端后端的健康状态、能力、环境和限制 |
| `preparePackage(request)` | Candidate、入口文件、测试规格 | `ExecutionPackage` | 构建并校验内容寻址的可移植执行包 |
| `execute(request)` | 参数化任务、后端选择条件、超时和重试预算 | `ExecutionResult` | 完成选择、提交、等待和结果归一化 |
| `cancel(taskId)` | 通用任务 ID | 取消后的任务快照 | 本地和远端使用相同取消语义 |

`execute()` 接收统一的任务描述，至少包含：

- `operation`：`correctness`、`benchmark` 或 `diagnostic`。
- `candidate`：`missionId`、`candidateId`、`patchDigest`、Workspace 身份。
- `profile`：固定 Profile ID 和不可修改的测试矩阵引用。
- `package`：入口、文件清单、每个文件的 SHA-256 和整个包的摘要。
- `backendSelector`：必需能力、允许位置和可选的后端优先级。
- `constraints`：超时、重试预算、最大包大小和取消信号。

返回结果必须包含 `taskId`、`status`、`backendId`、`operation`、Candidate/Package
摘要、日志、工件、环境指纹、evidence 类型和标准错误。任务状态统一为
`queued | preparing | running | completed | failed | cancelled`。

### 本地与远端一致性

本地与远端必须执行相同的生命周期：

```text
查询后端 -> 能力匹配 -> 构建执行包 -> 依赖预检
-> 传输或挂载 -> 提交 -> 等待终态 -> 校验结果 -> 返回
```

允许不同的只有文件传输和通信实现：本地可以复制或挂载任务目录，远端可以上传压缩
包或内容块。两者不得在 Profile、测试矩阵、超时、取消、错误、证据或终态语义上产生
差异；本地适配器也不得因为文件可直接访问而跳过执行包摘要和依赖预检。

### 执行包与文件传输

默认支持“单入口文件”，但不限制为“只能提交一个文件”。建议采用：

- 单文件包：`run.py` 加自动生成的 `manifest.json`，作为默认和最小支持模式。
- 受控多文件包：允许纯源码辅助文件；所有文件必须列入 manifest，使用包内相对路径。
- 禁止绝对路径、`..`、符号链接逃逸和运行时读取 Mission Workspace 之外的隐式文件。
- `packageId` 由 manifest 和文件内容计算；后端落盘后必须再次校验摘要。
- evidence 必须记录 `packageId`、`patchDigest`、Profile 和后端环境指纹。
- 不上传整个 Workspace、虚拟环境、缓存目录或未进入 manifest 的文件。

### 依赖策略

提交前依次执行静态 import 扫描、manifest 校验、后端能力匹配和后端环境预检：

1. 后端预装依赖：manifest 声明名称和版本约束，后端返回实际版本并完成匹配。
2. 包内纯源码依赖：随执行包传输，只允许相对 import 和 manifest 内文件。
3. 第三方依赖安装：初版不支持。未来只有后端明确声明 `packageInstall` 能力时才允许，
   且必须使用锁定版本、隔离环境、大小/时间限制和受控软件源。
4. 无法满足的依赖：必须在正式执行前失败，不得把它记录为 correctness 失败，也不得
   静默切换到环境语义不同的后端。

第一阶段建议只支持单入口文件和包内纯源码文件，不支持任务级下载安装第三方依赖。
这能保证本地、远端和离线 C550 环境具有可复现的最小共同能力。

### 后端能力描述

`queryBackends()` 返回的每个后端至少声明：

- 身份与位置：`backendId`、`local | remote`、端点。
- 可用性：`available`、`healthy`、不可用原因和检查时间。
- 操作能力：correctness、benchmark、diagnostic、cancel。
- 环境：硬件型号、Python、框架、驱动和运行时版本。
- 包能力：最大大小、多文件支持、是否允许安装依赖、是否允许网络访问。
- 调度限制：并发数、排队深度、最大执行时间。
- 证据能力：`simulation` 或 `liveHardware`，两者不可互换。

后端选择必须同时满足操作、Profile、硬件、shape/dtype、运行时版本、依赖和包限制。
没有完全匹配的后端时立即返回错误，不允许通过删减测试或弱化 Profile 获得匹配。

### 统一错误契约

新增执行工具错误必须交给 `workflow-error.mjs` 归一化，并至少区分：

| 错误码 | 含义 | 默认可重试 |
|---|---|---|
| `EXECUTOR_BACKEND_UNAVAILABLE` | 没有满足能力和环境要求的健康后端 | 是 |
| `EXECUTOR_PACKAGE_INVALID` | manifest、路径、大小或摘要不合法 | 否 |
| `EXECUTOR_PACKAGE_TRANSFER_FAILED` | 上传、复制或摘要复核失败 | 是 |
| `EXECUTOR_DEPENDENCY_UNAVAILABLE` | 后端缺少依赖且不支持满足该依赖 | 否 |
| `EXECUTOR_ENVIRONMENT_MISMATCH` | 硬件、驱动或运行时版本不匹配 | 否 |
| `EXECUTOR_SUBMIT_FAILED` | 后端拒绝或未接收任务 | 是 |
| `EXECUTOR_WAIT_TIMEOUT` | 等待任务终态超时 | 是；先查询真实终态 |
| `EXECUTOR_RESULT_INVALID` | 返回结果缺字段、摘要不匹配或证据非法 | 否 |

远端断线后不得直接重复提交。工具必须先使用幂等任务 ID 查询后端；只有确认任务未创建
时才能重试提交，避免同一 benchmark 被执行两次。

### 不可破坏的约束

- `fixed-operator-profiles.mjs` 仍是固定 Profile 和测试矩阵的唯一来源。
- simulation evidence 永远不能转换或发布为 live-hardware evidence。
- 结果中的 Candidate/Package 摘要必须与实际执行内容一致。
- 工具不得修改 Mission 状态、推进 workflow、执行 Accept Gate 或采纳 Candidate。
- 所有任务仍通过 `operator-test-queue.mjs` 串行化，并原子持久化终态。
- 远端地址、凭据和文件路径不得进入任务日志或可发布 evidence。

### 实施拆分与验收

- [ ] 定义并测试 `ExecutionBackend`、`ExecutionPackage`、`ExecutionRequest`、
  `ExecutionResult` schema。
- [ ] 抽取通用 executor port，并让 Queue 只依赖该端口。
- [ ] 将 `local-c500-service-client.mjs` 改造成实现统一契约的本地 adapter。
- [ ] 实现远端 adapter，包含健康检查、幂等提交、轮询/取消和文件传输。
- [ ] 实现内容寻址执行包、路径隔离、摘要复核和依赖预检。
- [ ] 添加本地/远端契约测试，保证相同输入产生相同状态、错误和 evidence 结构。
- [ ] 添加缺失依赖、传输中断、等待超时、取消竞争和断线重连测试。
- [ ] 通过 `npm run test:queue`、相关 executor 测试、
  `npm run verify:local-c500-release` 和 `npm run verify:non-hardware-robustness`。

## TODO：收敛每轮 Agent 工作量与墙钟耗时

> 状态：待实现。当前生产流程保持不变。本 TODO 不授权削弱固定 Profile、Correctness、
> Benchmark、Gate 或重试预算，只用于后续重构时明确 Agent 与确定性模块的职责边界。

### 当前问题

- 主 Agent 单次预算为 10 分钟，但 `ROUND_BUDGET_MS` 仍是未生效的预留定义，尚未限制
  Agent、测试和重试组成的完整单轮墙钟时间。
- Correctness 失败会通过 `startMainRound()` 启动新的完整 Agent 会话并重新读取上下文，
  而不是复用当前轮的精简修复上下文。
- 主 Agent 同时承担瓶颈分析、代码修改、交付文件维护、`report.md` 更新和结构化总结，
  部分工作可由确定性模块完成。
- 固定 Profile 的首次经验调研虽然不阻塞主流程，但可能与主 Agent 争用同一 Provider；
  停滞后的同步 Research Agent 还可能显著延长下一轮开始时间。

### 目标状态

正常 Candidate 轮次最多执行一次主 Agent。系统在 Agent 前组装冻结上下文，在 Agent 后
完成 Diff 校验、测试、Gate、报告更新和经验草稿生成：

```text
确定性上下文组装
  -> 主 Agent：诊断并生成一个有界 Candidate Patch
  -> 确定性 Diff / Candidate 契约校验
  -> Operator Test Queue / 通用测试执行工具
  -> Accept Gate
  -> 系统生成报告与经验草稿
```

Correctness 修复使用同一轮的精简修复路径，只提供失败用例、标准错误、原 Candidate
摘要和允许修改的实现文件；不得重新执行与修复无关的全量分析。经验库读取使用普通查询
服务，不因每轮读取而启动 Agent。Research Agent 仅用于 Baseline 来源缺失、明确停滞或
人工触发的深度调研。

### 实施项

- [ ] 定义并启用完整单轮墙钟预算，覆盖主 Agent、Correctness 修复、测试等待和重试；
  超时后保存终态和可诊断错误，不得留下悬挂任务。
- [ ] 将主 Agent 默认预算从当前 10 分钟调整为可配置的短预算，目标区间 3 至 5 分钟。
- [ ] 为 Correctness 失败增加 2 至 3 分钟的轻量修复操作，复用当前轮上下文或线程，
  不创建一次全量候选分析。
- [ ] 从主 Agent Prompt 中移除每轮 `report.md` 维护；由测试结果、Gate 和状态投影确定性
  生成报告内容。
- [ ] 将经验读取实现为按 Mission/Profile/Baseline/失败摘要查询的非 Agent 服务，并缓存
  本轮冻结的 Experience Context。
- [ ] 为 Baseline Materializer 增加 `source commit + profile digest` 缓存，命中后不启动
  Materializer Agent。
- [ ] 为异步 Research 与主 Agent 增加 Provider 并发能力检查；不支持并发时延后 Research，
  不得拖慢正常 Candidate 生成。
- [ ] 保留现有 `maxGenerationAttempts`、`maxCorrectnessAttempts` 和 `performanceRounds`，
  不以耗时优化为由降低固定测试标准。

### 验收标准

- 一个正常 Candidate 轮次的主 Agent 调用次数为 1；Correctness 修复被单独计数和观测。
- 状态中能分别查看 Agent、执行后端、重试和完整轮次的耗时及超时原因。
- 单轮预算到期后，Agent 和测试任务均能取消或收敛到明确终态，并可安全继续或人工恢复。
- 相同 Mission、Candidate、Profile 和测试结果在重构前后产生相同 Gate 结论。
- 新增正常轮、Correctness 修复、Provider 不支持并发、Agent 超时和测试超时的契约测试。
- 通过 Agent Runtime、迭代循环、队列及发布门禁测试。

## Verification

```bash
npm run test:workflow-kernel
npm run test:loop
npm run test:runtime
npm run test:queue
npm run test:state-store-projection
npm run test:state-repository
npm run test:projects-service
npm run test:missions-service
npm run verify:local-c500-release
```
