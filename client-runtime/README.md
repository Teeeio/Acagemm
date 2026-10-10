# Client Runtime Module Contract

Claude cancellation waits for terminal record settlement on the supervised Job
path. Legacy unsupervised child ports may acknowledge termination before their
actual `close` callback; cancellation then returns the existing pending request
without fabricating a close timestamp or resource-release proof. Diagnostics still
persist the first request before close and settle final fields through the actual
callback. The injected diagnostics matrix retains its original assertions.

The composition root supplies public bootstrap identity to HTTP validation for
optional pinned-client connection preconditions. A foreign instance header fails
before effects. This does not alter owner watchdog, provider admission,
authentication, workflow contracts or persistence.

Reference content identity uses the pure public `semanticSourceDigest(source)`
from `semantic-snapshot.mjs`. New snapshots with an available independent baseline
freeze its exact bytes as correctness `oracleDigest` and benchmark `baselineDigest`.
Existing snapshots without those fields retain their original digest and unknown
reference binding; they are never retroactively upgraded. Task binding refuses a
reference that differs from a declared frozen digest.

The [durable Job loss preview](claude-job-loss-preview.md) is a read-only
preparation adapter. It pins reviewed record/Job identities and two trusted
absence observations, blocks unknown queue/foreign resources, and preserves
historical release and remote outcome uncertainty. It exposes no commit or
logical-lease mutation; the existing legacy retirement interface stays unchanged.

`windows-job-object.mjs` exports `preflightIndependentSupervisor({environment,
tempRoot,platform})`, a CPU-only Windows lifetime admission. Explicit
`OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR=1` uses a native suspended bootstrap,
the enclosing Job's existing breakaway permission, and a kernel membership
check before resuming the supervisor. Remaining inherited Jobs, denied escape
or incomplete evidence return `PROCESS_BOUNDARY_SUPERVISOR_LIFETIME_UNAVAILABLE`
before a provider target starts. There is no nested-process fallback or host
limit/ACL change. Successful `started`/`result` values retain the optional
`supervision` identity; ordinary deployments retain their existing transport.
This prospective admission cannot release an interrupted historical run.
Detachment alone does not survive termination of an enclosing tool Job.

[Claude process supervision](claude-process-supervisor.md) reconciles a failed
termination request against the original bound terminal receipt. A missing Job
handle alone remains unknown; only strict identity and zero-member evidence
permit cancellation to continue. The run retains its termination error and
receipt digest in `processTerminationRecovery` without changing result history.

The shared [AppContainer execution adapter](appcontainer-execution.md) connects
Claude, Codex and native local runners through the existing Job process port.
Explicit AppContainer selection refuses missing operator-owned provisioning,
implementation drift, token mismatch and ordinary-process fallback. It consumes
existing profile/resource identities and makes no security-setting changes.
Activation and real private-write/network/GPU acceptance remain separate steps.

The [resource preflight](appcontainer-execution.md) consumes pinned current leases
and actual child-probe receipts before provider authentication or target launch.
Claude/Codex `preflight({workspace, environment?})` now runs the same boundary
admission as launch before CLI/authentication probes. Managed Runtime preflight
preserves boundary blocking codes, actionable detail and `resourcePreflight`;
it does not hide them behind a generic disconnected-provider diagnosis.
Windows short/long paths are canonicalized; missing/drifted/expired resources and
cleanup uncertainty return structured blocking details. It never repairs ACLs
or invokes UAC. The separate [operator provisioning adapter](appcontainer-provisioning.md)
reuses existing ACL/UAC implementations, journals exact file Read transactions,
observes real helper wait/exit/termination and preserves failed cleanup for
explicit recovery. Its diagnostic CLI defaults to displaying a frozen packet.

Optional [Mission target profiles](mission-target-profile.md) provide versioned,
user-declared architecture for first-round experience retrieval without a client
GPU. Create/import, frozen candidates, generation origin and new attempts retain
this intent. It never supplies observed evidence or backend availability.

The [command journal](command-journal.md) tolerates bounded transient Windows
atomic replacement conflicts without repeating external effects. Exhausted or
nonretryable writes preserve the previous durable intent and block for recovery.

Production initialization opens an empty device-independent home. Empty Mission
lists survive restart without implicit C550 examples or workspaces; only explicit
reference-fixture mode seeds examples. Existing Missions remain intact, and new
idle Agents claim no retrieved experience before actual retrieval. See
[initialization](state-initialization.md) and [Mission state](mission-project-state.md).

Test failure classification gives structured runner provenance precedence over
diagnostic keywords. Candidate compilation errors remain repairable even when
compiler output lists PyTorch TLS headers; explicit infrastructure failures still
block regeneration. Typed backend reference-cache failures also block candidate
regeneration without changing execution-timeout handling. See
[evidence projection](operator-test-evidence.md).

The [operator test tool](operator-test-tool.md) preserves queue cancellation
reason and request deadline through the package adapter boundary. Worker timeout
receipts must retain the queue's cause; frozen execution deadlines stay unchanged.

Frozen pending-test inputs retain declared oracle files for provenance, but
exclude them from implementation dependencies using the frozen source roles.
The independent baseline remains the sole acceptance source; ordinary package
path-collision checks remain enforced. See [pending test admission](pending-test-contract.md).

[Generation preparation diagnostics](generation-preparation.md) retain bound
experience-read failures through the command journal before reporting errors.
Explicit retries preserve original clocks and unconsumed test feedback.

Mission intent recognition accepts an explicitly named operator from the stored
`operatorProfile.operator`/`operator` and ordinary English optimization actions;
it does not require custom operators to belong to a fixed kernel-name vocabulary.
Empty, unrelated/destructive, and operator/action-ambiguous requests retain their
existing refusal. Semantic/test/workspace admission remains in the run service.

[Experiment memory](experiment-memory.md) binds actual retrieval to trusted
storage identity at Mission creation and checks it before generation. Prepared
prompt audits and iteration reports distinguish independent learning, facts-only
controls and separately identified continuous chains. Missing audits stay unknown.

[Independent experiments](experiment-storage.md) freeze initial experience and
source inputs, create separate writable stores and bind startup to a pinned
manifest. Explicit data/runtime paths suppress legacy migration. Controlled
Claude runs use fresh sessions, disabled automatic context discovery and confined
read roots. Ordinary deployments remain unchanged; production APIs still own all
Mission workflow, and live isolation must be separately verified.

[Explicit attempts](pending-attempt.md) create a new paused Mission from an
expired frozen candidate through the existing journal. Parent clocks/evidence and
later user edits remain intact; child history and generation origin retain the
source link. Workspace staging/inspection is an adapter, never a domain effect.

模块归属：Operator Studio 共享后端，包含应用编排、领域规则、端口和适配器。各子模块的
所有权与输入输出索引见
[`docs/development/MODULE_OWNERSHIP.md`](../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

Preparation drafts live in `state.missionDrafts` with versioned forms and are
not projected into executable Mission state. Missions service and its HTTP
routes own saving, reopening and promotion. New generic form test contracts
carry `correctness.toleranceScope=output-dtype`, tensor layout and an explicit
cosine limit through test-spec normalization; fixed/legacy contracts keep their
existing semantics. Goal latency limits in ms convert to us; structured
`objective.targetLatencyUs` survives normalization and takes precedence.

`client-runtime` is the local application backend. It owns Mission state, workflow orchestration, Agent coordination, isolated workspaces, serialized operator tests, evidence decisions, and local persistence.

Committed iteration history lives in [iteration-trace.md](iteration-trace.md).
Pure projections and a pending outbox preserve facts beyond display limits;
the storage adapter prepares immutable history before atomic snapshot commit.
Read-only Mission trace queries report coverage and corruption explicitly.
New Missions have creation-only experiment identities. Generation starts freeze
their conditions and pre-generation workspace ancestry, and stage timings retain
unknowns rather than borrowing observer timestamps; see [generation-origin.md](generation-origin.md).

[Iteration evaluation](iteration-evaluation.md) derives reliability, efficiency
and per-profile candidate comparisons from complete committed history. Its read-only
API exports original facts and a reproducible report, keeps missing metrics unknown,
and never grants release evidence. Baseline comparison identity is frozen at test
submission; old records without that link cannot borrow a later baseline.

Iteration progress is separate from target adoption. Resolved, correctness-passed
current-best retention resets the optional persisted `consecutiveNoProgress`
counter without reporting adoption or publication. Stagnation and plateau use
that progress counter; legacy adoption counters remain readable. See
[iteration-loop.md](iteration-loop.md) for recovery and settlement ordering.

New project IDs use a SHA-256 digest of the entire repository path (128-bit prefix),
not the first eight path bytes. Managed projects under a common storage root stay
independent. Existing persisted project IDs are retained; this does not migrate or
repair historical collisions automatically.

Ordinary Git working trees may be imported as independent managed projects through Projects service and the workspace import port (`projects-service.md`, `workspace-manager.md`). Source edits and non-ignored new files are preserved without changing the source repository. Mission creation accepts `missionPaused:true` for an atomic saved draft; this does not require a hardware probe or an Agent run. Explicit stop intent remains authoritative when budgets expire; unresolved resource-release barriers still prevent new work.

`executionMode: 'generate-only'` uses the same journaled Agent and candidate
admission path, then pauses with `iterationStats.pendingValidation`. The
[pending candidate store](pending-candidate-store.md) freezes the complete declared
source bytes, independent baseline, semantic/test contract and original budget in
a portable untested bundle. Export is a read-only application query; it is neither
test admission nor release evidence. Explicit [frozen test admission](pending-test-contract.md)
uses the existing Benchmark command, package preparation and serialized queue.
Baseline and candidate use frozen bytes and the original budgets; background
tests continue across Mission selection. Candidate receipts await workspace-bound
feedback settlement and never directly adopt/publish a detached candidate.
Frozen background commands recover through explicit Mission-scoped journal views.
The completed baseline is committed before candidate submission; recovery retains
the visible Mission and original absolute deadline. See [command-journal.md](command-journal.md).
The [feedback contract](pending-feedback.md) connects verified results to explicit
continuation using the same Gate, retry limits and prior-round facts. File conflicts
preserve user edits and receipts; the next generated candidate freezes again.

Manual research uses the shared [research policy contract](research-policy.md). For
`synthesize`, the policy returns `budgetMs: null` so Runtime preserves an existing
session deadline and uses its remaining budget; without a session it uses the
configured synthesis budget. Other manual phases keep their numeric phase budgets.

Automatic patch-policy rejection is persisted with the observed Agent completion
as a paused Mission requiring human intervention. Managed Agent projection retains
that control state only for the matching Mission/run; risk checks, candidate diff
admission and execution budgets are unchanged. See the application candidate-action
contract and [Agent lifecycle contract](agent-runtime.md).

Windows MVP Codex runs use the unelevated sandbox fallback when the optional
Windows sandbox helper is unavailable. Boundary mode keeps Codex's structured
file-edit tools enabled by default; the workspace sandbox and post-run Mission
Workspace Diff audit remain the write boundary. The `shell_tool` is **on** by
default as well: confinement comes from `--sandbox workspace-write` plus
`--add-dir` for each writable root, not from a narrower tool surface. Read-only
additional roots are deliberately not passed to the CLI, because the sandbox
already allows reading anywhere and only writes are confined. Set
`OPERATOR_CODEX_DISABLE_SHELL_TOOL=1` only when a stricter tool surface is
required for a controlled diagnostic run; it takes effect only in boundary mode
(`OPERATOR_AGENT_ROOTS` set), so it is never the thing that protects a run.
Runs also ignore the local Codex `config.toml` by default to prevent an
unexpectedly large user-rule context from starving the Agent turn; set
`OPERATOR_CODEX_IGNORE_USER_CONFIG=0` to opt back in. That flag does not cover
the host Codex home's own `AGENTS.md`, which Codex assembles into every run, so
each run is additionally pointed at a Mission-scoped Codex home that carries the
provider credential and nothing else. `client-runtime/codex-client.md` states
what is and is not copied; set `OPERATOR_CODEX_ISOLATE_HOME=0` to run against
the host home unchanged.

On Windows, native Codex executables are launched through the Job Object
supervisor by default. Each run receives an independent Job, a file-backed
stdin bridge, a `started` handshake after containment and resume, and live
stdout/stderr tailing into the normal JSONL event path. The terminal receipt
contains `releaseProof.activeProcessCount`; a closed helper or closed output
pipe alone is never treated as process-tree release. Set
`OPERATOR_CODEX_JOB_OBJECT=0` only for a controlled compatibility diagnostic;
the legacy path remains fail-closed when its process tree cannot be verified.

The helper timeout (`DEFAULT_JOB_HELPER_TIMEOUT_MS`, 60s) bounds one helper
invocation: the start handshake and the terminate request, both dominated by
PowerShell cold start. It is a scheduling-delay tolerance, not a release
deadline — expiry still fails closed through the normal quarantine path, only
later. Override with `OPERATOR_CODEX_JOB_START_TIMEOUT_MS`; a value below 1s
falls back to the default rather than shrinking the bound. Measured cold-start
latency on the development machine was 1.3–1.9s idle and 5.2–9.4s under
16-way CPU load, so the earlier 15s default misreported ordinary load as
`CODEX_JOB_START_TIMEOUT` and quarantined a healthy workspace.

`windows-job-object.mjs` also exports `removeTreeEventually(target, { attempts,
baseDelayMs })` and `RETRYABLE_CLEANUP_CODES`. Windows holds a directory busy
for a short window after its owner exits; every teardown in this area must use
that bounded, non-throwing helper instead of a bare `rm`, and should assert on
its return value when a leak would matter.

Agent 运行的失败原因与资源生命周期是两条独立契约：`agent.primaryFailure`
保存 Provider/传输等上游原因，`resourceRelease` 保存进程树是否已确认退出。
取消在有限重试后会进入 `needs_human` 与 `blocked/quarantined` 投影；释放未确认
前，Mission Workspace、恢复和新测试始终 fail-closed。恢复尝试生成的候选必须
携带 `candidate.sourceRunId`，Queue 请求与 `benchmark.candidate.sourceRunId`
沿用该来源，不能用 Round 的首次 attempt ID 代替。

Claude 适配器仍为每次运行建立独立权限配置。用户级配置中的认证、服务端点与模型映射只按固定白名单
传入子进程内存，进程环境和显式运行参数优先；不复制宿主 hooks、MCP、权限或凭据文件，也不执行
宿主认证脚本。就绪检查使用同样的受管认证上下文，避免宿主显示已登录而真正运行时没有认证。
配置缺失、格式错误或认证方式不受支持时给出明确准入错误，不能据此声称已经收到模型响应。
具体支持范围、错误码与隔离约束见 [Claude 适配器合同](claude-client.md)。

Baseline 来源的权威要求只对**零来源** Mission 可跳过：Mission 自身预先声明了来源
（`mission.baseline.source` / `mission.upstream.baselineSource` / `mission.upstream.reference`）
时，语义来源（`authority:'agent-semantic'`、`semanticFallback:true`）一律被拒，选源服务与
autopilot 都不产出它，最终落回 `needs_human(baseline_source_unresolved)`，错误码
`BASELINE_MANDATED_SOURCE_NO_SUBSTITUTE`（409）。判定只看 Mission 的声明，不看运行时
`state.baseline.source`——后者可能正是解析出来的语义来源，用它做判据会自我印证。
零来源 Mission 允许跳过，但 `resolution` 必须如实标成
`strategy:'semantic_fallback'`、`attemptedAuthority:false`、`skippedAuthority:true` 并带非空
`skippedAuthorityReason`；这些字段在 `createBaselineResolutionState` 的白名单内，缺失即被静默
丢弃，会导致语义 baseline 在 UI 与证据里又长得像权威来源。语义 baseline 不含上游权威，
不能作为上游算子的证据。

每个新 Claude run 在既有 run JSON 中附带一个有界的 `diagnostics`
（`operator-studio.agent-run-diagnostics/v1`），键集合固定为
`schemaVersion/provider/runId/missionId/stdout/stderr/events/firstModelObservedAt/cancellation/close`，
只保留计数、字节数、客户端边界的真实 UTC 时间、事件类别计数和子进程关闭事实，不复制
stdout/stderr 正文、thinking、prompt、路径或凭据，也不新增另一路持久化或无界事件数组。
`events`（`systemInit/thinkingTokens/assistant/result/other/invalidJson`）在遥测过滤前按既有
type/subtype 逐行计数一次，含 close 时的未终止尾行，空行为 no-op；合法 JSON 的
primitive/array（含 `null`）固定归 `other` 且不改变正常事件语义，主行、尾行、close 时重载的
raw events 与 `readEvents` 都不得因此崩溃；`firstModelObservedAt` 只在既有
[model-observation](model-observation.md) 权威首次给出 `observed` 时写入一次，init/usage/configured
标签不设置，后续 conflict 既不回退历史时间也不使当前 DTO 可比，诊断永不改写该 DTO。`close` 在真实
子进程 `close` 回调前为 null，之后严格为 `{at, exitCode, signal}`，exitCode 为回调整数值或 null，
signal 为固定 Node 信号名或 null，不虚构成功码，也不构成新的进程树释放证明。

Runtime 通过既有 provider cancel 端口 `cancel(runId, context?)` 提供可选诊断上下文；只有 Claude
接收该附加参数，其他 provider 调用形状不变。对仍存活的自有子进程，首次真实取消在等待终止前即把
`cancellation` 固定为 `{requestedAt, context}` 并经既有串行原子 run writer 落盘，因此在终止 pending
期间即可观察；重复调用不覆盖首个 requestedAt/context，子进程已消失时不伪造请求，旧的无 diagnostics
记录保持可读且不回填。context 为 `operator-studio.cancellation-context/v1`，仅复制白名单标量
（`runId/missionId/role/trigger/triggeredAt/budgetMs/elapsedMs/stallTimeoutMs/idleMs`），逐字段校验：
非法 schema、身份、role/trigger 枚举、时间或数值（负值、非正 stall timeout、非有限数）一律
`context=null` 且不阻止取消；未知预算/耗时为 null，绝不猜成 0；多余键被丢弃，所以原始正文、
stderr、thinking、路径与凭据无法进入诊断。`cancel(runId)` 的旧调用合法地产生 `context=null`。
仅新 stderr 活动与取消须在 close 前可观察：每个非空 stderr chunk 都立即请求既有串行原子 writer
的写入，同一时刻至多排队一次并把期间的 chunk 合并进同一次写入，所以单条 stderr 无需后续事件或
等到 close 即已落盘，也不引入新 timer、不新增无界数组、不改 `lastActivityAt`。诊断不改变状态机、
轮次预算、释放屏障、重试/单飞语义或既有 `lastActivityAt`/stall 行为。

归档轮次的必需事实（上一轮 candidate/digest、Correctness 结果、失败分类、Gate、
Decision、回滚真实性与 currentBest 资产状态）在 `resetMissionRunState` 归档时写入
`iterationStats.roundFacts`，版本见
[mission-project-state](mission-project-state.md#round-facts-snapshot)。该快照
独立于经验库预算：零命中、预算耗尽或未检索都不能丢事实，缺失观测一律
`unknown`/`not_observed`，绝不用当前已前移的 roundBudget 或 Mission 声明补齐。
自动轮次（`agent-round-service` + `agent-runtime.startRun`）与手动命令
（`agent-commands` 冻结 intent/payload/apply）通过同一 `selectRoundFactsForPrompt`
投影进 Prompt 的 `iterationContext`；只有绑定当前 Mission 与当前 Round 才会投递，
Mission 切换、新轮次和重放都不会拿到别轮事实。

Provider 中立的发送前 prompt 审计（`operator-studio.prompt-audit/v1`）在
`agent-runtime.startRun` 调用 provider **之前**原子写入
`<bridgeDir>/prompt-audits/<runId>.json`，写入失败以 `PROMPT_AUDIT_WRITE_FAILED`
阻止发送，不假称 provider 已收到。Claude 与 Codex 共用同一 helper，审计的 `prompt`
严格等于 `start.goal`；OpenCode 与 cli-file 主启动分支各自记录真正交付的
prompt/request.goal，不记录仅存在于内存的字符串。审计件含 `promptDigest`
（`sha256:<hex>`，UTF-8 字节）、`promptBytes`（`Buffer.byteLength`）、Mission/Project/
Round/Run 绑定、`runtimeMode`、`createdAt`、`deliveryStage:prepared-before-send`、轮次事实快照与经验选择清单；
`state.agent.promptAudit` 只保留 `path/digest/bytes/schemaVersion` 引用，
`resetMissionRunState` 归档时随 `runHistory[].promptAudit` 保留，旧审计不被新状态改写。
runId 必须是安全文件名（含路径分隔符或 `..` 时拒绝发送），rename 沿用既有有界重试
处理 Windows EPERM/EBUSY 竞态。选择清单来自
[round-experience-service](application/round-experience-service.md) 保存的同 round
sidecar，审计不重建、不改写选中集合。

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
| `platform-runtime.mjs` | Platform-neutral executable/path resolution for local adapters | platform, environment and repository/storage root | resolved Python executable, shell-safe argument and canonical storage root |
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
| `application/benchmark-package-preparation-service.mjs` | execution package preparation port (`createBenchmarkPackagePreparer`); language/environment/entrypoints come from the injected adapter port mapping, never from this module | request, mission, frozen matrix, injected store/adapter identity/adapter port mapping | admission-bound Benchmark request |
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
| `application/source-registry-integrity-service.mjs` | source root integrity gate: a modified or unverifiable registry stops auto-advance (a local fetch failure is never reported as an upstream modification) | source root, Mission/state | `needs_human` escalation + durable event |
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
| `accept-gate.mjs` | I/O-free acceptance rules and the single versioned evidence decision | state, runner result and diagnostic envelopes | Gate / Baseline evidence / decision |
| `correctness-coverage.mjs` | the correctness-coverage manifest: builder, pass-path rule (`coverageIsComplete`), and the shared schema id | correctness record from a runner or a fixture | manifest / pass-path verdict (never a substitute for runner evidence); coverage counts must be finite nonnegative safe integers (numeric strings remain compatible), with positive required count and full equality; optional executed/passed counters may be absent but, when present, must be valid and agree |
| `experiment-brief.mjs` | the attempt brief's leaf vocabulary (`nextAction` values, schema id, "produced no observation") shared by producer and consumer | brief record | route discriminator only; no policy of its own |
| `evidence-decision.mjs` | I/O-free diagnostic qualification and versioned decision helpers | diagnostic envelope, expected candidate/run binding | three diagnostic predicates, fail-closed execution classification, binding-conflict projection, stable reason codes |
| `model-observation.mjs` | I/O-free response-model observation contract (schema, pure observe/bind/summarize); byte-exact identities | raw Claude stream metadata, required run identities | frozen DTO, deep-detached binding, comparability summary |
| `operator-test-evidence.mjs` | in-memory queue evidence projection, infrastructure/candidate failure distinction, minimal attempt brief (`createExperimentBrief`) | state and task snapshot | updated state / decisions / events / `benchmark.experimentBrief` |
| `evidence-state.mjs` | shared review/Baseline shapes | kind/status/overrides | schema-compatible records |
| `mission-objective.mjs` | objective normalization, goal-text performance targets (`describeMissionGoal`, used by Accept Gate and the create form) | Mission/objective | normalized policy, parsed threshold |
| `state-identifiers.mjs` | stable legacy identifier formatting | Mission/repository label | ID/name (not authorization) |
| `state-workspace.mjs` | layout, fixture and checkpoint adapter | Mission/paths, initialization port | workspace effects / checkpoint DTO |
| `state-snapshot-storage.mjs` | raw snapshot I/O and injected bootstrap | snapshot / factory ports | atomic file replacement / raw state |
| `state-repository.mjs` | serialize state access and enforce optimistic versions | load/save adapters, mutation | isolated snapshot or saved state |
| `iteration-loop.mjs` | bounded iteration policy | Mission state, injected deps | next workflow state/action |
| `workflow-kernel.mjs` | invariants and recovery projection | product state | violations/effect/reconciled state |
| `runtime-events.mjs` | canonical Mission and audit events | state, event fields | in-memory event |
| `agent-runtime.mjs` | Agent use-case lifecycle | Mission context, runtime events | Agent state/results |
| `agent-runtime/` | definitions, registry, dispatch, capabilities | runtime ID, operation | definition or provider call |
| `candidate-generation/` | Candidate prompt, Workspace Diff admission, empty-candidate root-cause classification, degraded generation-path markers, language/repeat guards (including the retest exception for artifacts no attempt ever observed), and candidate identity | frozen Mission round context, Agent result, Workspace manifest, archived round briefs | candidate prompt and verified candidate admission |
| `cli-command.mjs` | Resolve direct Agent executables behind Windows npm shims | provider and configured command | executable plus fixed argument prefix |
| `operator-test-queue.mjs` | serialized test lifecycle | test payload | persisted task snapshot |
| `local-c500-service-client.mjs` | C550 production execution and isolated CPU E2E command execution | queue task payload | correctness/benchmark artifacts |
| `workspace-manager.mjs` | Git workspace isolation; Source Registry inspection counts only registered sources (temporary `.acquiring-*` clone directories are never inspected) | Mission/repository/candidate | Diff/checkpoint/restore result |
| `candidate-generation/README.md`, `CONSTRAINTS.md` | 03 候选生成契约与确定性边界 | frozen round context and Workspace facts | Agent proposal/admission contract; no Queue/Gate/iteration decisions |
| `fixed-operator-profiles.mjs` | immutable operator contracts | Profile ID | frozen Profile/test matrix |
| `semantic-snapshot.mjs` | bind semantics to evidence | Mission/Profile/test task | immutable semantic digest |
| `shared-gpu-runtime.mjs` | read-only local shared-GPU capability probe and trusted environment descriptor | host tool/runtime probes | explicit `shared-host-gpu` environment policy |
| `local-shared-gpu-package-adapter.mjs` | Python package materialization, syntax validation, prepared-artifact verification, release inspection, plus the frozen adapter identity and the Python/NVIDIA port mapping | package store manifest/blobs | package-only task directory and non-publishable shared-GPU evidence |
| `target-capability-registry.mjs` | the single declaration point for "can this backend really run on this machine": adapter identity, locked environment, target, language and verification level; `available` is derived from `verified` and unverified targets are refused instead of substituted | environment id | capability record / typed refusal |
| `windows-job-object.mjs` | Windows Job Object process-tree adapter | executable, arguments and task-owned log paths | helper process, named Job identity and confirmed termination |

## Invariants

- State transitions preserve active Mission projection consistency.
- Runtime API, SSE projection, and auto tick state access share the State Repository exclusive queue.
- No simulation result is publishable.
- Accept Gate evidence decisions are versioned
  (`operator-studio.evidence-decision/v1`). Flat `passed`/`publishable`/
  `evidenceSource`/`liveHardware`/`result` fields are projections of one
  decision; consumers do not reclassify truth from a boolean or infer
  publication from `liveHardware`.
- Diagnostic qualification is three independent predicates
  (`schemaValid`/`available`/`evidenceEligible`). Only an explicit `completed`
  status and an explicit non-mock `source`/`metricsSource`/`provenance` prove a
  real collection (a top-level tool name or artifact path is not a source);
  mock/simulated provenance wins over a contradictory status; tracer content
  requires well-formed kernel-categorised events; profiler provenance is never
  guessed from value equality. Required real evidence must be bound to the
  current candidate/run and a contradictory benchmark/applied candidate binding
  blocks.
- Publication requires a passed adoption, live execution, no explicit
  development/shared-host restriction and two eligible bound real diagnostics.
  Explicit simulation/mock/fixture/scripted and CPU signals outrank
  `liveHardware=true`. Backend names and `publishable=true` are not publication
  authority; missing real diagnostics pauses for external verification instead
  of driving new Agent edits or being reported as complete evidence.
- Response-model observation is provider-reported (`assistant.message.model`),
  bound exactly by provider/run/mission/session and never promoted from
  init/env/usage labels or declared configuration. `unknown`/`conflict` never
  blocks a workflow and never becomes comparable; it is not remote attestation.
- Test evidence and workspace candidate identities match.
- The Workspace Git Diff is the only candidate admission authority. A Provider that
  did not terminate normally yields no candidates at all, and a candidate the Agent
  never declared is admitted only as explicitly degraded (`workspace_observed`).
- `candidates: []` always carries exactly one root-cause classification
  (`upstream_failure_no_candidate`, `no_candidate_generated`, `parse_mapping_loss`,
  `tool_failed_patch_pending`, `workspace_capture_gap`, `patch_admission_failed`,
  `task_contract_unmet`). Degraded markers describe the generation path only; they never
  relax the language contract, the repeat guard, the fixed test matrix, or the Gate.
- A classification answers "where did the candidate go", never "how was it produced".
  A candidate observed in the Workspace but never declared is admitted and labelled
  `workspace_observed_candidate` — never `workspace_capture_gap`, which names the
  opposite state (declared but no visible Diff). Edit-tool failure is carried by
  `editToolStatus` and never rewrites the classification of an admitted candidate.
- Structured edit-tool identity is read only from a structured tool field, never from command
  text. Codex reports the edit tool as `item.type: 'file_change'`, while `claude-client.mjs`
  normalizes every tool into `item.type: 'command_execution'` and keeps the real identity in
  `item.name` (`Write` / `Edit` / `Bash`). A declared tool name therefore outranks the event
  type. An edit tool that never appeared is `absent` and is never a degradation; only an edit
  tool that appeared and failed is, and the first failure is not overturned by a later
  successful shell write.
- Every Candidate test uses the persisted Baseline `oracleRunPy`; Candidate-owned
  `reference()` code is never the correctness authority.
- External failures use `workflow-error.mjs` normalization.
- Durable state is replaced by write-to-temp then rename. A Windows handle overlap
  (`EPERM`/`EBUSY`/`EACCES`) is retried a bounded number of times and then rethrown — never
  swallowed, so a bounded operation cannot be left half-applied by a transient lock.
- Runtime events use `runtime-events.mjs`; do not define local event appenders.
- Provider capability checks use the Agent Runtime registry.
- Windows Codex MVP runs with the explicit `unelevated` fallback when the
  optional Codex Sandbox helper is unavailable. Candidate writes remain bound
  to the active Mission Workspace, and process-tree cleanup remains owned by
  the runtime/Job Object boundary; operators may override this with
  `OPERATOR_CODEX_WINDOWS_SANDBOX`.
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
- `E2E_RUN_ROOT` overrides the harness run root. On Windows `os.tmpdir()` may contain an
  8.3 short alias. The installed Claude CLI rejects paths containing `~` followed by a digit;
  an explicit permission rejection is a terminal failure, never permission to apply the
  result patch through another writer. Production API storage roots are resolved before new
  task admission so their derived project/workspace paths use the same filesystem identity.
  A literal long directory name containing `~3` is not a short alias to rewrite. Existing
  rejected runs are not migrated or retried. The emitted `summary` reports
  `candidateGenerationPath`, `editToolStatus`, `degradedGeneration` and `degradationReason`.
  Patch recovery remains available for ordinary edit errors without a permission rejection.

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
| [execution-package-contract](execution-package-contract.md) | 纯 manifest、路径、层、Candidate/Workspace、验收与准入绑定规则；canonical 纯 `contentDigest(bytes)`（仅 `node:crypto`，无 I/O） |
| [execution-package-store](execution-package-store.md) | assemble / validate / prepare / reconcilePreparation / verifyAdmission；私有 CAS 与可信准入；`contentDigest` 仅为指向 contract canonical 函数的同绑定兼容导出 |
| [execution-package-import](execution-package-import.md) | 将目录或 tar/tar.gz/zip 归档读取为候选、依赖、独立验收层；拒绝链接、设备、越界路径后交给 package store 准入 |
| [operator-test-tool](operator-test-tool.md) | capabilities / prepare / submit / read-only get / cancel / findByRequestId；仅调用一个队列 |
| [experience-contract](experience-contract.md) | 版本、范围、来源、证据与非发布型开发经验规则；可选版本绑定的选择元数据与上下文硬上限 |
| [experience-selection](experience-selection.md) | 纯规范化与确定性排序：`normalizeSelectionMetadata`、`rankExperienceCandidates`、`WIKI_SELECTION_POLICY_VERSION`、配额与排除原因 |
| [kernel-wiki-import](kernel-wiki-import.md) | 纯解析/构建/原子导入：`parseKernelWikiPage`、`buildKernelWikiSnapshot`、`applyKernelWikiSnapshot`；来源固定为 Git blob，绝不解释上游性能声明 |
| [experience-repository](experience-repository.md) | 私有原子存储、同进程事务、不可变历史 |
| [experience-service](application/experience-service.md) | 注入端口的人工经验、观察记录、KernelWiki 快照导入、冻结检索上下文与审计选择清单 |
| [round-experience-service](application/round-experience-service.md) | 冻结版本/来源/范围并注入 Agent；保存同轮选择 sidecar；完整可信凭据才记录执行观察；可用显式 `experienceCondition` 研究条件准备同一冻结上下文 |
| [round-budget-contract](round-budget-contract.md) | 主 Agent、测试与同轮重试共享 15 分钟墙钟；暂停/恢复不刷新 |
| [cancellation-contract](cancellation-contract.md) | 资源释放真相、只读 barrier 与显式推进中的确认收敛 |
| [model-observation](model-observation.md) | 无 I/O 的响应模型观测 DTO、按原始字节精确匹配的 provider/run/mission/session 绑定与必需 run 汇总；仅 `assistant.message.model` 是响应身份，unknown/conflict 不阻 workflow 也不可比 |

研究条件（facts-only / local-only / local-and-wiki）是同一冻结上下文的三种可选经验
注入：显式条件经 `createRoundExperienceService({...,experienceCondition})` 传入，
`local-server.mjs` 另外读取环境变量 `OPERATOR_EXPERIENCE_CONDITION`。条件在检索排序与
配额之前生效：`facts-only` 注入零条可选经验，`local-only` 排除全部 kernel-wiki 单元，
`local-and-wiki` 保持既有选择不变；未知/空/非字符串条件在改变任何状态之前以
`EXPERIENCE_INVALID` 失败，同一 round 的冻结上下文不得改换条件。实际使用的条件与策略
版本写入持久化的选择 sidecar 与发送前 prompt audit；`local-and-wiki` 记录的
`policyVersion` 仍是当前 D 的 `WIKI_SELECTION_POLICY_VERSION`，绝不回退到旧
retrieve-only 常量。研究编排侧（九槽位调度、条件收据、只读报告复核）位于
`scripts/experience-condition-study.mjs` 与 `scripts/run-experience-condition-study.mjs`，
接口与验收矩阵见 `docs/development/EXPERIENCE_STUDY_CONTRACT.md`；条件矩阵的独立验收
分别在 `tests/experience-condition-runtime-test.mjs` 与
`tests/experience-condition-study-test.mjs`。研究结果只作探索性对照，报告恒为
`strictN20Passed=false`，不得标注为 N20、稳定性或发布证据。

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

旁路材料（研究/复核产出的 advisory）只在轮次冻结边界注入：材料产生时把身份写进
持久化的 `pendingInjection` 账本——Project/Mission、产生它的轮次、`researchRunId`/`noteId`/
`digest`、语义与测试契约摘要、验收摘要、观测到的 target 与工具链版本，以及
`applicability = exact_artifact | task_semantics`（引用具体工件时才带 `baseArtifactDigest`）。
选择注入之前用同一个函数重算当前身份并比对：语义、测试契约、target 或所引用工件已经
变化，材料就不进本轮，但仍留在账本里并写明 `discardReason`（`semantics_changed`、
`test_spec_changed`、`target_mismatch`、`stale_artifact_reference` 等）。未知不补假值：
一侧没声明的事实既不算通过也不算失效，只记为核对不出结论。被替换或清空的材料同样留下
原因（`superseded_by_newer_material`、`research_run_produced_no_material`）。已经判定的
材料保持判定，下一个 tick 不得把它重新选中——提交不等于使用，更不等于有效。

研究员只能写自己的调研目录：`prepareAgentBoundary` 保护与调研目录同级的其余目录（候选工作区、
基线、Source Registry），并把这份清单同时写进提示词与运行下发参数；claude 侧由路径 deny 规则
真正拒绝写入（对持有写工具的研究运行而言这是它唯一的写边界），codex 侧由沙箱把写限制在可写根内
并登记这一点。授权面自相矛盾（同目录既授可写又列受保护）显式失败，包含 workspace 的规则跳过并
登记，不静默失效。建议型旁路（停滞、视野审视、经验）不再让主线空等：只有需要解析来源的
`acquire` 阶段保持同步。

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


### GPU experience environment preflight (2026-09-16)

The composition root injects a shared-resolver environment preflight into the
round experience service. Automatic and manual starts warm/check the bound
environment before the three-second collect phase, within existing total clocks.
The GPU probe uses the existing package inspection allowance (default 30000 ms,
maximum probe timeout 30000 ms) instead of the probe helper's generic 5000 ms
fallback. The enclosing preflight still caps the whole query by remaining budgets.
This accommodates a slow Python/Torch import without inventing a missing runtime;
timeout, drift and failed evidence checks remain fail-closed.

## Reviewed intake, fixed business acceptance and retained source exports

The source policy can carry intakeReview (approved files, sourcePolicy and reviewDigest). Frozen manifests distinguish approved inputs from explicit implementation outputs. The pure [pending-candidate-bundle-contract.mjs](pending-candidate-bundle-contract.mjs) validator is public; pending-candidate-store remains the filesystem trust adapter.

[business-acceptance.mjs](business-acceptance.mjs) evaluates the optional testSpec.acceptancePolicy against the frozen semantic/test identity, independent baseline and all protected profile measurements. [business-acceptance.md](business-acceptance.md) documents initial baseline requirements, comparability, allowed regression, ties and below-target progress. Legacy tasks without the policy retain their gate behavior.

[best-candidate-export.mjs](best-candidate-export.mjs) binds a retained best to immutable source and acceptance identity, and supplies the common pure assertBestCandidateExport validator. GET /api/missions/:id/best-candidate reads that original trusted bundle; it never substitutes current workspace or pending source. [best-candidate-export.md](best-candidate-export.md) specifies the DTO and stable missing-source errors. Explicit frozen feedback and ordinary automatic benchmark/adoption both bind the immutable source before round archival. Historical bests without an immutable source remain errors. File materialization and the offline validation CLI belong to tools/local-c500-tester, not this domain module. No export grants new hardware performance or publication evidence.

Imported-source ordinary starts freeze complete semantics before generation. The pending bundle boundary normalizes the intake SHA-256 representation without changing its identity or file guards. Baseline completion preserves the released provider identity only for its matching held candidate, keeping real automatic repository adoption and immutable best export connected. See operator-test-evidence.md and application/run-service.md.

Automatic continuation and archived round facts preserve the actual source-admission failure code, detail and affected file list. Accepted Gate feedback states the accepted result truthfully. Temporary probes never gain implicit source approval. See iteration-loop.md and mission-project-state.md; retry limits, release barriers and original clocks are unchanged.

Legacy local Claude host recovery uses the immutable [host recovery contract](claude-host-recovery.md). Capture never releases resources; recovery requires independently verified later same-host Windows boot and leaves remote result/cost unknown.

Legacy native Claude runs can use [task-level retirement](claude-execution-retirement.md), which preserves unknown historical exit while independently proving transport absence and permanently fencing original execution identities.

Durable native Claude Job loss uses the separate [exact approved retirement adapter](claude-job-loss-retirement.md). It archives raw evidence and only the exact logical lease, retains unknown physical/remote facts, and applies permanent checkout-wide Mission/run/session/workspace and experiment fences. A host-configured maintenance API disables probes and advancement; ordinary production admission remains unchanged.

## C500 / 910B and Linux lifecycle

The production composition reuses the original package store, test-tool and queue
for `local-metax-c500` and `local-ascend910b`; see
[accelerator package contract](accelerator-package-adapter.md). Static catalog
entries stay unverified; explicit machine qualification authorizes development
admission only. Linux Claude uses the [POSIX lifecycle port](posix-process-supervisor.md).
Windows Job/AppContainer behavior and historical fixed C550 contracts remain.

The pure evidence-decision contract recognizes exact, probed, nonpublishable C500/910B worker envelopes for the same local benchmark-core Gate path. Foreign/incomplete envelopes retain generic live diagnostic requirements; these development namespaces cannot grant publication. No new fixed Profile semantics or verdict producer is introduced.
