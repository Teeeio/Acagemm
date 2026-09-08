# Client Runtime Module Contract

模块归属：Operator Studio 共享后端，包含应用编排、领域规则、端口和适配器。各子模块的
所有权与输入输出索引见
[`docs/development/MODULE_OWNERSHIP.md`](../docs/development/MODULE_OWNERSHIP.md)。

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
| `application/runtime-state-pipeline-service.mjs` | ordered effectful advancement pipeline | state/runtime snapshot | advanced state and changed flag |
| `application/runtime-lifecycle-service.mjs` | separate snapshot reads and explicit advancement | injected snapshot/recovery/pipeline ports | isolated or advanced state |
| `application/runtime-maintenance-service.mjs` | runtime-mode policy and fixture progression | state/runtime and domain ports | changed state |
| `application/main-round-orchestration-service.mjs` | main Agent round preflight/recovery/launch | round command | updated state |
| `state-store.mjs` | compatibility assembly, snapshot schema/version and recovery coordination | state, snapshot | delegated access / normalized snapshot |
| `mission-project-state.mjs` | injected-path Mission/Project rules | state, command and path ports | in-memory normalization / transitions |
| `mission-state-shapes.mjs` | budget and Mission/Research/Agent shapes | fields/overrides | new records / normalized budget |
| `knowledge-state.mjs` | adoption and source-aware Knowledge governance | admitted Candidate/evidence state | updated best/review/assets/events |
| `state-reference-data.mjs` | legacy fixture defaults and metadata | none | shared reference records |
| `state-initialization.mjs` | seed/product state factories | injected Mission domain factory | initial snapshots (no storage) |
| `state-reference-runtime.mjs` | existing reference-fixture progression | state and elapsed clock | fixture state/log projection |
| `accept-gate.mjs` | I/O-free acceptance rules | state and runner evidence | Gate / Baseline evidence |
| `operator-test-evidence.mjs` | in-memory queue evidence projection | state and task snapshot | updated state / decisions / events |
| `evidence-state.mjs` | shared review/Baseline shapes | kind/status/overrides | schema-compatible records |
| `mission-objective.mjs` | objective normalization and queries | Mission/objective | normalized policy |
| `state-identifiers.mjs` | stable legacy identifier formatting | Mission/repository label | ID/name (not authorization) |
| `state-workspace.mjs` | layout, fixture and checkpoint adapter | Mission/paths, initialization port | workspace effects / checkpoint DTO |
| `state-snapshot-storage.mjs` | raw snapshot I/O and injected bootstrap | snapshot / factory ports | atomic file replacement / raw state |
| `state-repository.mjs` | serialize state access and enforce optimistic versions | load/save adapters, mutation | isolated snapshot or saved state |
| `iteration-loop.mjs` | bounded iteration policy | Mission state, injected deps | next workflow state/action |
| `workflow-kernel.mjs` | invariants and recovery projection | product state | violations/effect/reconciled state |
| `runtime-events.mjs` | canonical Mission and audit events | state, event fields | in-memory event |
| `agent-runtime.mjs` | Agent use-case lifecycle | Mission context, runtime events | Agent state/results |
| `agent-runtime/` | definitions, registry, dispatch, capabilities | runtime ID, operation | definition or provider call |
| `candidate-generation/` | Candidate prompt, Workspace Diff admission, language/repeat guards, and candidate identity | frozen Mission round context, Agent result, Workspace manifest | candidate prompt and verified candidate admission |
| `cli-command.mjs` | Resolve direct Agent executables behind Windows npm shims | provider and configured command | executable plus fixed argument prefix |
| `operator-test-queue.mjs` | serialized test lifecycle | test payload | persisted task snapshot |
| `local-c500-service-client.mjs` | C550 production execution and isolated CPU E2E command execution | queue task payload | correctness/benchmark artifacts |
| `workspace-manager.mjs` | Git workspace isolation | Mission/repository/candidate | Diff/checkpoint/restore result |
| `candidate-generation/README.md`, `CONSTRAINTS.md` | 03 候选生成契约与确定性边界 | frozen round context and Workspace facts | Agent proposal/admission contract; no Queue/Gate/iteration decisions |
| `fixed-operator-profiles.mjs` | immutable operator contracts | Profile ID | frozen Profile/test matrix |
| `semantic-snapshot.mjs` | bind semantics to evidence | Mission/Profile/test task | immutable semantic digest |
| `shared-gpu-runtime.mjs` | read-only local shared-GPU capability probe and trusted environment descriptor | host tool/runtime probes | explicit `shared-host-gpu` environment policy |
| `local-shared-gpu-package-adapter.mjs` | Python package materialization, syntax validation, prepared-artifact verification and release inspection | package store manifest/blobs | package-only task directory and non-publishable shared-GPU evidence |
| `windows-job-object.mjs` | Windows Job Object process-tree adapter | executable, arguments and task-owned log paths | helper process, named Job identity and confirmed termination |

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

## Command recovery

Command handlers live in `application/candidate-commands.mjs`,
`application/benchmark-command.mjs`, `application/decision-commands.mjs` and
`application/agent-commands.mjs`. Admission policy belongs to
`application/workflow-command-policy.mjs`; `local-server.mjs` composes these modules.

The [command journal](command-journal.md) persists an intent before external mutations
and the prepared payload before committing Mission state. Benchmark intent freezes
the request ID, Candidate digest, Baseline oracle, matrix and implementation content.
`operatorTestQueue.findByRequestId(requestId, missionId, expectedPayload?)` is a
read-only recovery query. Reusing an ID for different content fails with
`OPERATOR_TEST_REQUEST_CONFLICT`.

Uncertain effects remain recorded and cannot be automatically repeated. Runtime
queries expose a paused `workflowRecovery.commandRecovery` overlay when recovery is
blocked, while preserving the durable snapshot's version for another recovery query.
The pipeline skips automatic advancement for this overlay. Explicit user commands
that save new state still change the version and require the pending operation to be
inspected. Providers without an authoritative recovery query do not automatically
restart an ambiguous run.


## Snapshot queries and advancement

Runtime contract version 9 requires restarting an older Runtime before using
bounded dispatch/cancellation, complete-round budgets and frozen experience input.
The TUI's existing compatibility check will not silently reuse a version 8 process. This is not a persisted state-schema change.

`GET /api/state`, Mission event queries/SSE and Operator Test list/detail return
committed snapshots. Reading does not advance Agents, submit/poll tests, adopt a
Candidate, replay a command journal or save a new state version. Journal inspection
may expose a transient recovery pause without performing recovery.

`POST /api/runtime/advance` runs one application advancement cycle under the same
State Repository exclusive lock as commands and the background tick. It returns
`{ state }`; it is an explicit effectful action, not a query or a guarantee of
backend exactly-once execution. Background ticking defaults to enabled; set
`OPERATOR_AUTO_TICK=0` for deterministic harnesses, which must POST advancement
when they want progress. For compatibility this setting also disables automatic
Candidate actions, while explicit advancement still projects, recovers and settles
iterations. Production TUI keeps using its existing automatic tick.
Runtime-owner liveness checks apply to both automatic and manual advancement.

`state-store.readState()` is the no-write snapshot port.
`state-store.loadState()` is the explicit initialization/migration/recovery port.
Runtime policy previously hidden in loading now belongs to
`application/runtime-maintenance-service.mjs`; access coordination belongs to
`application/runtime-lifecycle-service.mjs`. See [state access](state-store.md).

Queue `readTask(id)` and `readTasks()` are read-only. Production `dispatch()` persists a short claim and starts backend I/O outside locks; `process()` performs
one serialized execution/poll cycle. Legacy Queue `get/list` remain effectful
compatibility APIs and must not be bound to HTTP queries. Preflight/Workspace
endpoints still use their existing idempotent Workspace provisioning ports; this
change does not claim every filesystem-oriented GET is side-effect-free.

## Dependency Rules

- Pure policy modules may depend on shared contracts, not adapters.
- Adapters may depend on Node APIs and external processes.
- `state-store.mjs` must not import the Agent service facade. It remains a
  compatibility assembly/storage boundary, not a pure policy dependency.
- Mission/Project and Knowledge implementations are canonical domain modules;
  every Application service consumes explicit transition ports or pure shared
  shapes. No Application module imports state-store, directly or transitively.
- Gate, evidence, Mission/Project, Knowledge, initialization and iteration policy
  use canonical domain/shared contracts; their full static graph must not reach storage,
  workspace, queue execution, HTTP or provider implementations.
- Workspace and raw snapshot effects use their documented adapters and injected
  ports; see [state access](state-store.md), [Workspace](state-workspace.md), and
  [snapshot storage](state-snapshot-storage.md).
- Provider clients must not import HTTP routes or TUI modules.

## 通用测试工具与闭包执行包

本轮确认范围见 [Generic Operator Goal](../docs/development/GENERIC_OPERATOR_GOAL.md)。
已实现语言无关契约和私有内容寻址存储，并接入人工经验 API、冻结轮次上下文与总轮预算。
共享 GPU MVP 已完成正式组合：测试命令先组装语言无关执行包，经过 Python 语法校验、
准备和短期 admission 后才进入异步工具与本地队列；Runner 只消费适配器准备目录。
强隔离环境、更多语言和完整包执行证据仍按后续扩展推进。

目标调用方向为 application -> asynchronous test tool -> local/future remote queue。
Queue 继续是唯一测试调度与原子终态所有者；工具不增加另一条队列或 workflow。

| 公共模块 | API / 责任 |
|---|---|
| [execution-package-contract](execution-package-contract.md) | 纯 manifest、路径、层、Candidate/Workspace、验收与准入绑定规则 |
| [execution-package-store](execution-package-store.md) | assemble / validate / prepare / reconcilePreparation / verifyAdmission；私有 CAS 与可信准入 |
| [operator-test-tool](operator-test-tool.md) | capabilities / prepare / submit / read-only get / cancel / findByRequestId；仅调用一个队列 |
| [experience-contract](experience-contract.md) | 版本、范围、来源、证据与非发布型开发经验规则 |
| [experience-repository](experience-repository.md) | 私有原子存储、同进程事务、不可变历史 |
| [experience-service](application/experience-service.md) | 注入端口的人工经验、观察记录与冻结检索上下文 |
| [round-experience-service](application/round-experience-service.md) | 冻结版本/来源/范围并注入 Agent；完整可信凭据才记录执行观察 |
| [round-budget-contract](round-budget-contract.md) | 主 Agent、测试与同轮重试共享 15 分钟墙钟；暂停/恢复不刷新 |
| [cancellation-contract](cancellation-contract.md) | 资源释放真相、只读 barrier 与显式推进中的确认收敛 |

执行包是 Candidate 文件、离线直接/传递依赖、精确锁定环境层和独立冻结验收包的
逻辑整体。内容层按摘要复用；不要求每轮重复上传解释器/编译器/大型库。
宿主机文件、隐式 virtualenv、运行时在线安装均不属于允许依赖。
语言适配器可以使用 Python、C++、CUDA 等入口，顶层没有强制 run.py。

准备先检查内容，再在目标隔离环境内完成 build/load；MVP 也允许显式注册的
`shared-host-gpu` 环境由适配器在共享主机上完成 build/load。准入同时绑定全部摘要、
目标、适配器版本与构建配置；提交和执行均须复核。validated=true 无效。
普通 Python 进程或静态 import 扫描不是强隔离沙箱；共享 GPU 必须同时声明
`allowSharedHostGpu=true` 和 `packageBoundary=adapter-enforced`，并明确标记为
非发布型开发证据，不能以普通主机执行降级通过验收。

准备超时保留可观察的未知占用。只有拥有该准备 ID 的适配器确认停止才可重试；
迟到结果不签发准入，也不能覆盖另一准备。Profiler/Tracer 对 CPU 默认 unavailable。
CPU 仅为 cpu-e2e、liveHardware=false；正式 GPU 发布仍由既有 Gate 授权。

本期后续工作：强隔离 Python/CPU 环境层；非固定算子的正式 TUI/API 导入；至少三类非预置算子的真实 Codex 闭环验收及全部发布门禁。
共享 GPU 包执行凭据已接入自动经验记录：组合根会复核 admission、prepared artifact 及候选/任务绑定，经验仍不可发布。

## TODO：收敛每轮 Agent 工作量与墙钟耗时

> 状态：完整轮次预算与冻结经验已实现；精简修复、报告生成和缓存等余项待完成。
> 本 TODO 不授权削弱固定 Profile、Correctness、
> Benchmark、Gate 或重试预算，只用于后续重构时明确 Agent 与确定性模块的职责边界。

### 当前问题

- 主 Agent 单次预算保持 10 分钟；完整轮次现有独立的 15 分钟墙钟预算，覆盖
  Agent、测试、等待和同轮重试，暂停/恢复不重置。
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
  -> 通用异步测试工具 -> Operator Test Queue
  -> Accept Gate
  -> 系统生成报告与经验草稿
```

Correctness 修复使用同一轮的精简修复路径，只提供失败用例、标准错误、原 Candidate
摘要和允许修改的实现文件；不得重新执行与修复无关的全量分析。经验库读取使用普通查询
服务，不因每轮读取而启动 Agent。Research Agent 仅用于 Baseline 来源缺失、明确停滞或
人工触发的深度调研。

### 实施项

- [x] 定义并启用完整单轮墙钟预算，覆盖主 Agent、Correctness 修复、测试等待和重试；
  超时后保存终态和可诊断错误，不得留下悬挂任务。
- [ ] 将主 Agent 默认预算从当前 10 分钟调整为可配置的短预算，目标区间 3 至 5 分钟。
- [ ] 为 Correctness 失败增加 2 至 3 分钟的轻量修复操作，复用当前轮上下文或线程，
  不创建一次全量候选分析。
- [ ] 从主 Agent Prompt 中移除每轮 `report.md` 维护；由测试结果、Gate 和状态投影确定性
  生成报告内容。
- [x] 将经验读取实现为按 Project/Mission/operator/hardware/scope 匹配的非 Agent 服务，
  持久化本轮冻结的 Experience Context 与版本/来源；新包执行证据验证仍待接入。
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

固定 Profile 的手动启动在进入 armed 前复用统一轮次/预算守卫；达到既有上限时同步
拒绝并说明下一步，不能清零固定计数。允许的新轮先冻结预算再持久化，自动启动、
重试和重放只能复用该身份。Run Service 的时钟由组合根显式注入。

## Verification

```bash
npm run test:workflow-kernel
npm run test:loop
npm run test:runtime
npm run test:queue
npm run test:state-store-projection
npm run test:state-domain-boundary
npm run test:state-storage-adapters
npm run test:mission-project-state
npm run test:knowledge-state
npm run test:state-repository
npm run test:projects-service
npm run test:missions-service
npm run verify:local-c500-release
```
