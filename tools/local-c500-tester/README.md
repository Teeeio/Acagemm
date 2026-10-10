# C550 Production Workflow Tester

`stopProductionRuntime()` returns `false` for `attach-only` before health reads
or process signals. This remains true after owner exit, missing owner metadata,
identity drift and reuse of the original port by another service. Attached
clients have no stop capability; the original owner keeps its existing rules.

`stable-runtime-host.mjs` exposes `startStableRuntimeHost`: an explicitly started
ordinary terminal performs strict CPU supervisor admission, then owns the existing
TUI and Production Runtime. It records immutable bootstrap/owner/port/home identity
and stops only its own Runtime on close. It creates no service, account, credential,
scheduled task or security grant. A recorded CPU check is diagnostic context;
every real provider start must still prove its own independent supervisor.

The host passes an AbortSignal to `showTui({signal})`; the default TUI unmounts
its existing screen on abort. Catchable SIGINT/SIGTERM/SIGHUP request owned
Runtime cleanup and retain conventional exit codes. Each fresh host writes
`<record>.lifecycle.jsonl` exclusively, recording normal return, exception code,
captured signal, or an observed process exit with an unknown trigger. The immutable
close receipt carries `exitReason` and cleanup status. Error messages/credentials
are not logged. Forced termination, machine failure and uncatchable signals cannot
be logged reliably; missing closure remains unknown, never proof of release.
These records do not distinguish user quit from another normal TUI return, and
Runtime closure still grants no model/GPU release authority. Existing callers
that ignore the AbortSignal are responsible for ending their own UI callback.

`runtime-attachment.mjs` exposes `createRuntimeAttachmentRecord`,
`runtimeAttachmentEnvironment`, `assertRuntimeAttachment`, and
`inspectRuntimeAttachment`. Records contain only allowlisted nonsecret connection
settings and bootstrap identity; frozen experiment input is independently inspected.
Inspection retries transient GET failures with bounded backoff, never effects.
`OPERATOR_RUNTIME_CONNECTION_MODE=attach-only` pins PID, owner, startedAt and home;
every API request rechecks the original service and carries its bootstrap
precondition. Missing, changed or incompatible instances cannot be started,
replaced or adopted by the connected client. Existing ordinary launch/reuse is
unchanged. This identity precondition is not authentication or a new permission.

`node tools/local-c500-tester/connect-runtime.mjs <host-ready.json> [--once]`
reopens the same TUI or prints one snapshot. Closing that client retains the
original TUI owner. Different controlled experiments remain incompatible. A
dead or uncertain attempt is inspected through its saved intents/receipts rather
than automatically resubmitted. New independent experiments need their own
reviewed preparation and original manual owner.

H 状态说明以只读分页展示当前 Mission 的错误、原截止时间与资源释放信息。
配置提交失败时 Ctrl+E 打开错误说明，Esc 保留表单并返回；错误码、HTTP 状态与
服务端诊断中的 nextAction 保留，任意配置及凭据字段不直接展开。D 诊断新增
现有 GET /api/runtime/preflight 的 Agent 生成准入结果；readAgentPreflight(client)
读取正式 {preflight} 回执，读取失败和缺失回执显示未知/未就绪。硬件就绪不能替代 Agent
准入。模拟和硬件 mock 不新增真实探测；原硬件 Doctor 检查与正式准入规则保持不变。

importMissionSpecification 的 /missions 已成功而 /runs 失败时仍抛出原错误，
并附带 error.savedMission（missionId、创建状态回执、project、started:false）。
started:false 表示客户端未确认启动成功，不能据此证明进程没有启动。App 仅凭
匹配的 activeMissionId 回到已保存任务并清除被消费的草稿身份，显示“启动未确认”；
不会再次创建或自动重试。后续显式 Space 仍使用 resumeMission 与服务端准入。

generationOutcome(snapshot) 只读取正常 completed 的 no_candidate_generated
分类，分别统计已记录生成与已完成候选测量（不含基线）；模型 summary 标记为未验证。
最近候选值要求 requestId/candidateId/digest 与结果环境匹配；基线值还要求同语义、
同单位、绑定的已完成基线任务及测量值一致，缺失时显示比较绑定未知。无 accepted
best 保留原业务结果，不产生新的 Gate 或性能上限结论。operationalDetailLines(view)
格式化 deriveTuiViewModel 的 generationOutcome、resourceRelease/resourceState、
roundClock、missionDeadline 与 actionBlocks；资源屏障只复用 cancellation-contract。
暂停提示说明仅停止后续推进，原时钟继续且在途工作未取消。没有退出证据不会显示
“已释放”；队列空不能替代 Agent 退出，资源屏障时恢复入口保持受阻。
operation-feedback.mjs 仅处理诊断文本与已保存回执，不改持久状态。

素材清单的纳入、排除与系统生成条目分别保持稳定显示身份，包括同名 run.py。
.gitignore 文件仍默认排除，必须逐项明确选回；确认添加不隐式修改忽略规则或选择
基线。素材确认测试在自有临时 Git 边界验证普通导入与显式选回，不继承父项目规则。

missionAcceptanceSummary(mission) 读取冻结 testSpec，用 business-acceptance.mjs
公开 normalizeAcceptancePolicy 校验已有策略，仅格式化，不评估候选或改 Gate。
ViewModel 的 acceptanceSummary 在工作台与 H 明示 primary-only / 未启用回退保护；
requiredProfiles 只称必测场景。只有显式 acceptancePolicy 才显示保护场景与退化限额。
未知/无效回执不推定保护。保存/启动预览与 shape 主场景提示沿用原配置，不默认改策略。

P0（2026-10-08）：新建通用任务新增可选「目标架构」，支持方向键建议、直接输入及
Ctrl+U 清空；切换硬件会清空旧架构。草稿、任务、重开与候选另建任务均保留配置。
架构未知仍可保存和开发，客户端无需 GPU。此处是用户声明，不是实测或执行能力。
K 经验页分别显示目标架构未知、没有适用经验与读取失败，并展示冻结来源及能力目录
内容版本。目录只是静态登记，不代表后端已连接。规格导入保留 targetProfile；
硬件覆盖与原配置不符时明确拒绝，不静默改写目标。

经验读取失败由正式状态持久化，重开 Mission 仍显示故障。绑定的首次生成准备失败
允许 Space 显式重试；已接收测试后的读取失败继续使用 R，保留原反馈与截止时间。
客户端只复用 `generation-preparation.mjs` 的纯身份判断，不直接修改任务文件。

I「轨迹评价」读取当前 Mission 的正式 evaluation/export，分为总览、迭代轨迹、
场景性能、经验审计和故障记录。1—5/Tab 切换分类，方向键/PgUp/PgDn 翻页，
R 显式刷新；这是标明时间的完整快照，不冒充持续刷新的状态。
E 导出当前查看的原始 JSON（含 Markdown 和全部事实），每次写独立文件，不覆盖
旧导出。任务/记录身份不符拒绝展示；读取失败保留带原身份和时间的旧快照。
`mission-history.mjs` 仅校验回执与格式化，不重新计算评价、Gate 或发布资格。
`loadMissionHistory(missionId)`、`exportMissionHistory(missionId, document)` 是
Production API 客户端的只读查询/用户导出接口，不改 Runtime 状态。

冻结测试结束后工作台提供 F「接收结果」，服务端核对当前文件与受测副本后记录
评价；R「继续生成」按剩余预算启动下一轮并带入原测试反馈。两个操作均经正式
HTTP API，接收结果不要求 GPU 或 Agent 在线，继续只做生成准入。工作区有后续
编辑时保留文件并显示冲突；基础设施故障和取消不会直接启动代码重写。

Baseline source diagnostics are current only while the unresolved-source human-action state
and mission/run/start/status/phase identity match. An explicit conflicting research mission
also hides the old diagnosis; resumed execution retains its history without displaying it as
the active blocker. The production source-service projection is covered by the TUI logic test.

证据展示要求完整的 candidateId/candidateDigest/runId 匹配。
Current best 从自身的 candidateDigest/evidenceRunId 及 evidenceDecision 读取；
候选卡使用 patchDigest/evidenceRunId，队列行使用 payload.candidate.digest/requestId。
字段不足时显示未知，不借用其他运行的决定。只接受当前已识别 v1/策略版本及一致的 DTO。

模块归属：当前 TUI 客户端、Production API Client 和启动/诊断工具。详细文件归属见
[`docs/development/MODULE_OWNERSHIP.md`](../../docs/development/MODULE_OWNERSHIP.md)。

受控实验启动先调用 `experiment-storage.mjs` 的公开环境核验，要求 Tester Home
与实验根目录一致，并保留冻结的队列目录。连接或重启前核对服务报告的实验身份、
data/runtime 路径；不同实验或普通服务之间不能通过 reuse/replace 混用。
同一实验重启保留已学习的记录，记录数增长不构成身份冲突。普通启动的目录约定不变。
若记录的 Runtime PID 仍存活但健康接口未响应，启动器明确报错，不能再开同目录服务。
通用规格可携带经过 `generation-origin.mjs` 校验的可选 experiment 归属信息，
导入保留 batchId/taskId/replicate；可信存储绑定仍由服务端建立，不增加普通表单字段。

经验摘要区分未读取、读取中、读取失败、空库、没有适用经验和关闭可选经验。
空库仅由同轮冻结 context/selection 的零 revision 确认；未知数据不显示成空库。
失败和选择必须匹配当前 Mission/Project/round；目标来自声明时明确标记。
F 接收测试后显示绑定测试的新增/已有记录或未入库原因，R 后保留上次反馈来源；
K 可查看记录版本、证据及排除原因。TUI 只读取正式状态，不查询或改写底层文件。
K 页面按实际换行后的文本行分页，多行执行观察也不能挤掉标题和返回提示；
上下翻页可读到记录末行，原始内容和评价导出保持不变。Esc 返回工作台后可按 Q 退出。

这是 Operator Studio 的 TUI 客户端。它复用生产 Mission、受管理 Agent、baseline、Mission Workspace、operator-test queue、Accept Gate、adoption 和连续迭代逻辑。

冻结候选的原预算耗尽且执行资源已释放后，A「从候选另建任务」通过正式 API
建立新暂停 Mission；复制冻结版本并保留来源关联，原任务和后续编辑保留。
新任务显示来源及 Space「开始生成」，不会自动运行 Agent 或测试。
Q 退出仍停止本 TUI 拥有的本地 Runtime；重新进入恢复持久化任务及原时钟，
不意味着客户端关闭期间后台服务仍持续运行。以后云端常驻服务另行实现。

`npm run tui` 打开通用入口，当前本地测试后端为 NVIDIA；`npm run tester:c500` 保留 MetaX 现场兼容入口。打开客户端、导入普通 Git 仓库和保存任务不要求本地 GPU、目标编译器或已连接的 Agent。环境检查由显式 Doctor 或启动本地迭代触发；云端测试尚未部署。

交互启动首先显示任务首页，选择“进入已有 Mission”或“创建新 Mission”，不会直接进入活动任务面板。已有任务列表按 Mission ID 保持选择，显示名称、状态、语言和目标；确认后通过 `selectMission(id)` 调用已有 `POST /api/missions/:id/select`。打开任务不启动、恢复或停止迭代，切换失败留在列表并显示错误。外部活动任务改变时返回选择页，避免在未选择的任务上继续操作。

首页用 ↑↓ 和 Enter 选择，1 进入列表，2/N 新建；列表用 ↑↓、PageUp/PageDown 浏览，Enter 打开，N 新建，Esc 返回首页。新建页按任务与素材、张量与语义、测试与性能、确认与提交分组；PgUp/PgDn 切换分组。张量和 shape 每项一行，Enter 进入单项编辑；编辑页 Esc 返回总览并保留修改，总览 Esc 返回进入表单前的页面。工作台用 M 或 Esc 返回任务列表，Q 退出。空列表默认选中新建，刷新不会替用户打开任务；后台正在运行的工作不会因返回入口而停止。

通用创建默认使用无需 JSON 的交互表单，已有 `operator-studio.generic-mission/v1` 文件作为可选导入入口。显式提交动作是保存、仅生成候选、启动本地迭代。仅生成绕过本地执行端和 GPU Doctor 检查，仍要求 Agent 准入；其 Runtime 等待行为由持久化的 `mission.executionMode` 控制。生成后可按 T 提交冻结候选或按 E 导出。提交时才检查冻结目标与后端、运行测试预检，不要求生成 Agent 在线；基线和候选按原字节串行测试，可返回任务列表或保存其他配置。面板区分基线测试、候选测试和结果待处理；结果暂不自动采纳或继续生成。原预算过期不自动续期。本入口仍是开发版本，不是 Windows 发行包。

## C500、C550 与共享 GPU 的边界

- **当前 handoff 的真实执行后端是本地共享 NVIDIA GPU**：`OPERATOR_TEST_BACKEND=local-shared-gpu`
  （`tools/local-shared-gpu-runner.py`，`nvidia-smi` + CUDA event 计时），结果带
  `source=local-shared-gpu`、`executionMode=gpu`、`hardware=nvidia-gpu`、`publishable=false`。
  它是真实开发执行，但属于显式发布限制，当前没有 C550 正式发布证据。详见下一节。
- `C550` 是固定 Profile / `local-c500` 兼容通道声明的 MetaX 目标型号。C500 与 C550 是
  不同设备，不共享 Runner 身份；C500 结果不能通过 C550 的生产预检或发布门禁。
- 目录 `tools/local-c500-tester/`、命令 `tester:c500`、后端类型 `local-c500`、
  `LOCAL_C500_*` / `OPERATOR_LOCAL_C500_*` 环境变量和 `LOCAL_C500_*` 错误码是为兼容已有
  自动化保留的稳定程序标识，不代表当前目标硬件仍是 C500。
- `launcher.cjs` 的后端选择**可继承**：不指定时默认 `local-c500`（`tester:c500` 的语义未变），
  也可以显式指定 `--backend local-shared-gpu`，或预先设置 `OPERATOR_TEST_BACKEND`。
  `npm run tester:local-gpu` 就是前者的一层封装，因此正式入口现在有一条**不经过 E2E driver**
  的路径能选到本地共享 GPU：
  - `npm run tester:local-gpu`（TUI）、`npm run tester:local-gpu:doctor`（机器可读预检）。
  - 未知后端名会被拒绝；`--simulation` 与非 C550 后端组合会被拒绝（完整模拟断言的是
    mock C550 backend，两者组合的预检永远无法通过）。
- **所选后端会传递给被拉起的 client runtime**，两侧由同一个 `expectedBackendKind` 决定。
  这是必需的：TUI 进程按自己的环境解析 launch mode，而 client runtime 是从
  `OPERATOR_TEST_BACKEND` 自己推导 descriptor 的独立进程。该值此前被写死为 `local-c500`，
  于是 `tester:local-gpu` 会拉起一个自报 `kind=local-c500` / `device=C550` / `publishable=true`
  的 runtime——而真正执行的是本机 NVIDIA 设备。预检读的正是 runtime 的这份自报，因此当时
  预检仍会拒绝启动。现在预检显式要求 `backend.kind === 'local-shared-gpu'`，两侧不一致即失败。
  同一 kind 也参与「旧实例是否可复用」的判断：后端种类不同的实例不会被当作可连接实例，
  否则 Mission 会跑在操作者没选的后端上、证据也会被标成那个后端。
- **启动本地迭代时的预检按所选后端判定**。打开 TUI 不运行此检查。`local-shared-gpu` 分支要求：后端自报
  `liveHardware=true`、**显式** `publishable=false`（未标记的 descriptor 按失败处理，不视为发布授权）、
  Python 可用、以及一条厂商中立的 CUDA smoke（真的在设备上分配并同步，并报告设备名与 compute
  capability）。`mx-smi`、C550 软件栈版本与 C550 CUDA smoke **在该分支不被要求**——要求它们正是
  此前本地 NVIDIA 后端无法从正式入口到达的原因。C550 分支的原有硬判据一条未放宽。
- 预检探测的 Python 走 `resolvePythonExecutable`（即运行时真正会用的解释器），doctor 结果里以
  `pythonExecutable` 明示，避免出现「预检报告的 Python 与运行时的不是同一个」。
- 已持久化的真实 C500/C550 历史证据保持原设备标签，不进行型号改写；历史 device 标签和旧
  launcher 文档只在其原始作用域内有效。

## 共享 GPU 与证据决策契约

当前仓库还有一条 opt-in 的共享 GPU 真实执行路径：`OPERATOR_TEST_BACKEND=local-shared-gpu`
（`tools/local-shared-gpu-runner.py`，`nvidia-smi` + CUDA event 计时）。它复用同一个
operator-test queue 端口，`source=local-shared-gpu`、`executionMode=gpu`：

- 它是**真实开发执行**，不是 simulation，也不是可发布结果。共享主机属于显式发布限制，
  决策结果是不可发布（或等待外部验证），不会因为 `liveHardware=true` 就被当成可发布。
- TUI、运行摘要和资产 outcome 不再根据 `publishable` / `liveHardware` 等布尔值自行推导
  采用或发布；它们读取同一份带版本的领域决策。
- 正确性记录现在都带 coverage manifest（`coverage.complete` 为真才代表冻结合同的全部 case 都跑过
  并通过）；Accept Gate 通过路径要求它，因此「`total` 达标但只跑了前几个 case」不再算通过。
- 固定 Profile 可以声明一个「快速必测前缀」（`testSpec.correctness.prefix`）：前缀 case 先跑，
  其余仍按 oracle 顺序全跑，**不是筛选**，只是让失败更早出现。回滚开关是 `OPERATOR_TEST_PRETEST=0`
  （缺省/`1`/`true`/`on`/`enabled` 为开启，`0`/`false`/`off`/`disabled` 为关闭；其它取值是配置错误
  `OPERATOR_PRETEST_CONFIG_INVALID`，不会静默降级）。开关由 runner 自己解析，因此不改变冻结
  `testSpec` 的摘要，也就不会让同一个 Mission 在不同环境下产出不同的包/语义 digest。
  CPU runner（`tools/local-cpu-runner.py`）不实现前缀重排，会如实记 `prefix.source: 'not_evaluated'`。
- 共享 GPU E2E 脚本默认 provider 是 `codex-cli`，**不是 Claude**；要用 Claude 必须显式覆盖
  `E2E_AGENT_RUNTIME=claude-code`。准确命令（Linux/macOS；Windows 用
  `$env:E2E_AGENT_RUNTIME='claude-code'`）：

  ```bash
  E2E_AGENT_RUNTIME=claude-code E2E_GPU_FAMILIES=affine E2E_KEEP_ARTIFACTS=1 npm run e2e:shared-gpu-agent-iteration
  ```

  该 E2E 直接启动生产 runtime，不经过 `tools/local-c500-tester/launcher.cjs`，因此不受
  `local-c500` 硬编码影响。TUI 入口（`npm run tester:c500`）本身默认 Claude Code，但仍走
  `local-c500` 兼容后端。

决策契约由 `client-runtime/evidence-decision.mjs` 定义，schemaVersion 为
`operator-studio.evidence-decision/v1`，公开字段可分别检查：

- `execution`：`live | simulation | cpu | unknown`、`liveHardware`、`source`。
- `correctness`：`passed`；`benchmark`：`valid`。
- `diagnostics`：`tracer` / `profiler` 的 `schemaValid`、`available`、`evidenceEligible` 与原因码。
- `adoption`：`allowed | reference | blocked | waiting_external_verification` 及 reasons。
- `publication`：`allowed | blocked | waiting_external_verification` 及 reasons。

存放位置固定为 `benchmark.evidenceDecision`，缺失时回退到同一候选/运行的 Gate
(`decisionReview.gate.decision`)；采用后复制到 `currentBest.evidenceDecision`，知识草稿和
发布资产各自携带 `evidenceDecision`。TUI/摘要只做只读投影，不生产决策、不修改 state，
也不通过 HTTP 之外的方式读取或写入持久化状态。

读取方只接受 `schemaVersion` **恰为** `operator-studio.evidence-decision/v1` 且
binding/execution/correctness/benchmark/diagnostics/adoption/publication 结构完整的 DTO：
未知版本、旧 flat Gate、缺字段或枚举非法的对象一律视为 `unknown`，不做字段回填或改写。
`publication.status=allowed` 额外要求 binding 的 candidateId/candidateDigest/runId 都是非空
字符串；缺绑定、空绑定或错绑定的 DTO 一律 `unknown`，不能被展示为可发布。
选择决策时按调用方明确给出的当前 candidate/digest/run 身份精确匹配；身份缺失不默认匹配，
也不会把其它 candidate/run 的决策当作当前结果，current best 只使用与自身匹配的决策。

知识草稿/资产展示与 Runtime 相同：以草稿自身 `evidenceBinding` 的 candidateId/candidateDigest/runId
三字段调用 `selectEvidenceDecision`，草稿决策、维护 change 决策和发布资产决策都必须绑定到同一
draft 身份。change 行先找到自己的 draft，再按同一 binding 选择决策，不直接读取任意 change DTO。
草稿无法给出自身完整身份时显示 `unknown`，不用当前 benchmark/currentBest 或 DTO 自身身份补齐；
没有版本化决策的旧记录仍显示 `unknown` 且不可发布。

兼容规则：旧报告或旧资产没有版本化决策时，显示为 `unknown` 且**不可发布**，不补造 live
事实；历史 simulation 报告继续保留不可发布说明。真实共享 GPU 结果显示真实开发执行、
不可发布/待外部验证；`development` / `development_only` 草稿与变更也明确显示为仅开发。

## 启动

目标机已经完成所选 Agent 后端登录后，正常测试只需要：

```bash
npm run tester:c500
```

该入口固定使用仓库内置 Node 24.19.0 和 Linux x64 依赖包，默认选择 Claude Code，但实际入口是 Agent Runtime 注册表与能力兼容层。可通过 `OPERATOR_RUNTIME_MODE=claude-code|codex-cli|opencode-server` 选择后端；生产预检按能力检查 Research、Materializer、Iteration、Workspace Write、结构化事件、取消、Usage，而不是按后端名称放行。当前 OpenCode 尚缺生产所需能力，会明确拒绝，不会静默回退。真机模式必须通过 C550 设备、CUDA smoke 和软件栈预检，不会把 C500 或未知设备当作可执行目标。

在目标机上推荐使用统一环境入口。它会固定当前 checkout 为 Tester Home、安装仓库内置 Node，并安装锁定依赖：

```bash
bash scripts/c500-test.sh verify   # 非硬件健壮性门禁、构建与 mock 闭环
bash scripts/c500-test.sh doctor   # 真机环境检查，不启动 Mission
bash scripts/c500-test.sh start    # Agent Runtime + C550 真机 TUI（默认 Claude Code）
```

`start` 检测到同一端口上有活动的 Operator Studio 实例时，会先显示中文选择：连接旧实例并继续原工作流，或停止旧 TUI/Runtime 后启动新实例。无法识别的端口占用不会被自动终止。无人值守启动必须显式选择策略：

```bash
bash scripts/c500-test.sh start --reuse-existing   # 复用兼容的旧 Runtime 和工作流状态
bash scripts/c500-test.sh start --replace-existing # 停止可识别的旧实例并重新启动
```

也可以设置 `OPERATOR_EXISTING_RUNTIME_POLICY=reuse` 或 `replace`。连接模式只增加当前控制面板，不转移旧 Runtime 的所有权；关闭新面板不会停止旧实例。

需要体验只模拟硬件、仍使用真实 Agent 时：

```bash
bash scripts/c500-test.sh mock
```

三种模式的边界固定如下：

- `real-c550`：真实 Agent Runtime + 真实 C550；设备、软件栈、smoke、Correctness 和 Benchmark 都是硬门禁。
- `hardware-mock`：真实 Agent Runtime + Mock C550；跳过硬件探测，但仍执行语义、baseline、真实 Agent 写入、Git Diff、三轮候选、队列和 Gate。证据永久标记 `liveHardware=false`。
- `full-simulation`：Reference Fixture + Mock C550；不调用模型、硬件或 Python，只验证 TUI/API/状态机交互。

开发机还可以运行 CPU 全迭代 E2E。该入口使用 Reference Fixture 快速生成 Candidate，
但 Correctness 和 Benchmark 会由独立 Python CPU runner 实际执行；Queue、状态投影、Gate、
自动采纳和经验治理仍走生产模块。结果固定标记为 `source=cpu-e2e`、
`liveHardware=false`，只证明流程集成，不证明 C550 正确性或性能：

```bash
npm run e2e:cpu-iteration
```

兼容层 + Mock C550 的真实后端闭环命令：

```powershell
node scripts/e2e-agent-runtime-hardware-mock.mjs codex-cli paged-mqa-logits-triton-v01 900000 300000
node scripts/e2e-agent-runtime-hardware-mock.mjs claude-code paged-mqa-logits-triton-v01 900000 300000
```

四个位置参数依次是 Runtime、Profile、整个 E2E 超时和单次 Agent 预算；也支持 `--runtime`、`--profile`、`--timeout-ms`、`--agent-budget-ms`。测试使用系统临时目录并在成功、失败、SIGINT 或 SIGTERM 后清理。

需要体验完整模拟流程时（不调用任何硬件、Python、tracer/profiler 或模型）：

```bash
# Windows / 已安装依赖
npm run tester:c500:simulation

# Linux 目标机，使用统一环境入口
bash scripts/c500-test.sh simulation
```

完整模拟模式会把 Agent Runtime 固定为 `reference-fixture`，把测试后端固定为本地模拟结果；发布、语义/测试矩阵、baseline、候选、Accept Gate、采用、人工暂停/恢复/停止、导出和错误恢复仍走同一套生产 TUI/API 状态机。顶部会显示 `FULL SIMULATION`，所有结果标记为 `liveHardware=false`，不能作为真实硬件证据。模拟模式默认使用系统临时目录，退出 TUI 后自动删除状态、队列、日志和工作区；只有显式设置 `LOCAL_C500_TESTER_HOME` 时才会保留这些产物。

没有真机时运行 `npm run verify:non-hardware-robustness`。该门禁串行覆盖语义冻结与篡改检测、Agent 后端兼容契约、工作流状态机、统一错误恢复、队列竞态、token 精确计数、TUI 极端视口与刷新、持久化、mock 闭环和构建；运行期间会设置硬件禁用保护，默认 Python 真机 runner、`mx-smi`、mctracer 和 mcProfiler 均不可启动。

入口默认使用 `claude-code`、当前项目目录下的 `.local-c500-production/` 和端口 `4275`。如果更换容器或 checkout 路径，只需在新目录重新运行上述命令；不要复用旧目录中的 PID 文件或手工复制状态。

Runtime 的自动推进检查绑定其原始 TUI 会话：所有者正常退出时会主动停止 detached runtime，异常退出时 runtime 通过 `ownerPid` 在下一个 tick 内自停。连接到旧实例的新控制面板不是所有者，退出该面板不会中断原工作流。

在本工作树根目录运行：

```powershell
npm run tester:c500
```

目标机无法访问 Node/nvm 下载服务时，可使用仓库内置的 Linux x64 Node：

```bash
bash scripts/install-bundled-node.sh
bash scripts/with-bundled-node.sh npm ci
bash scripts/with-bundled-node.sh npm run tester:c500
```

未设置 `OPERATOR_LOCAL_C500_MOCK` 时默认使用真实 C550 runner（`local-c500` 仅是兼容命名）。真机部署、验收项目和结果回传见 [`docs/local-c500-real-hardware-test.md`](../../docs/local-c500-real-hardware-test.md)。

`main` 分支的 TUI 默认使用 Claude Code，也可显式选择 Codex。测试人员在启动 doctor/runtime 之前确认所选后端：

```bash
export OPERATOR_RUNTIME_MODE=claude-code
export CLAUDE_COMMAND=claude
claude --version
claude auth status

# 或
export OPERATOR_RUNTIME_MODE=codex-cli
codex --version
codex login status
```

`local-c500` 是后端适配器的兼容名称；在该兼容入口内，声明的真机目标是 C550（当前 handoff 的实际真实执行后端是共享 NVIDIA GPU，见开头边界节）。启动器通过 `torch.cuda.get_device_name()` 和 `mx-smi` 校验 C550，并将设备、软件栈和 smoke 结果写入 Mission、测试矩阵和结果环境标签。无法识别 C550、软件栈不匹配或 CUDA smoke 失败时，TUI 在进入交互界面前终止并报告硬件前置检查失败。该预检只作用于 `local-c500` 真机模式，不适用于共享 GPU 路径。

Claude Code 复用相同的 Research、Baseline Materializer、Candidate、Workspace Diff、回退和采用工作流。Runtime 使用非交互 `stream-json`，只向各阶段暴露受控的 Read/Write/Edit 工具；Research acquisition 额外允许 WebSearch/WebFetch，Bash 始终禁用。不要设置 `--dangerously-skip-permissions`。

Claude Candidate 默认允许 5 分钟无事件窗口，Codex 保持 2 分钟；现场网关确实更慢时可通过 `OPERATOR_MAIN_AGENT_STALL_MS` 调整。单次 Agent 默认预算为 10 分钟，可通过 `OPERATOR_MAIN_AGENT_BUDGET_MS` 调整。固定 Profile 每轮候选生成最多自动尝试 2 次，连续失败后进入 `needs_human / candidate_generation_failed`，不会无限重启。Codex 在 Windows 上默认沿用其自身 `[windows] sandbox` 配置，兼容层只固定 `workspace-write`，不会强制覆盖为另一个 Windows 子模式。

Source 调研默认采用灵活的本地优先策略：Research Agent 先读取当前 Mission 的 Source Registry，再搜索可访问的 HTTPS Git 来源（包括 Gitee、GitHub 和 GitLab）；固定工作流在 clone 后自动记录 origin、commit 和 tree。没有可用源码时，Research Agent 会整理 Mission 语义规格，由 Baseline Materializer 生成带 `semanticFallback` 标记的 reference，流程继续进入真机测试。`OPERATOR_SOURCE_MIRROR_CONFIG` 仅用于后续需要 canonical/mirror pin 的严格来源模式，不再是实机闭环前置条件。

TUI 会在 `http://127.0.0.1:4275` 启动 API-only 生产 runtime。端口可通过 `LOCAL_C500_API_PORT` 覆盖。状态、Mission Workspace、测试任务和导出文件默认写入 `.local-c500-production/`，可通过 `LOCAL_C500_TESTER_HOME` 覆盖。

更新分支后再次启动 TUI 时，启动器会校验后台 runtime 协议版本。仅当服务、运行目录和 PID 文件均属于当前 Tester 时，旧 runtime 才会被自动重启；升级前因 `baseline_source_unresolved` 阻塞的 `mla-three-round` Mission 会保留原数据并自动迁移到灵活来源策略，然后重新开始 Research。

发布操作依次调用：

```text
POST /api/projects
POST /api/missions
POST /api/missions/:id/runs
```

runtime 内部继续执行生产链路：

```text
Mission intent
-> source research / baseline resolution and materialization
-> selected Agent Runtime candidate in isolated Mission Workspace
-> Git diff admission
-> production operator-test queue
-> C550 runner（兼容文件名 `tools/local-c500-runner.py`）
-> Accept Gate
-> adoption / rollback / knowledge
-> budget-aware iteration loop
```

旧版独立 CLI workflow 已删除。当前目录只保留生产 TUI、Production API client、launcher、环境诊断和生产报告能力。任何新的 CLI 入口都必须调用 Production API，不得重新实现 Mission、Candidate、Gate 或迭代循环。

## 模块开发合同

| 文件/目录 | 职责 | 输入 | 输出/副作用 |
|---|---|---|---|
| `launcher.cjs` | 选择 Node、准备依赖并启动 TUI | CLI 参数、环境变量 | TUI 进程 |
| `tui.mjs` | Ink 交互和本地 UI 状态 | 键盘、只读 snapshot | Ink UI、Production API 命令 |
| `tui-state.mjs` | Runtime state 到 ViewModel 的纯投影 | state/mission/tasks | ViewModel/文本 snapshot |
| `production-api.mjs` | Runtime 生命周期和 HTTP client | TUI command DTO | API response、受控 Runtime 进程 |
| `mission-form.mjs` | 通用/示例字段、`missionFieldRow` 投影、`missionDimensionNote` 尺寸约束提示与 `copyMissionFormItem` 复制 | 本地 draft、键盘 | 新 draft、显示文本，无 I/O |
| `mission-configuration.mjs` | 总览、单项编辑和提交预览的导航/投影 | draft、瞬时 editor、键盘/视口 | 兼容 draft、焦点与显式提交意图，无 I/O |
| `mission-spec.mjs` | 通用任务 DTO 校验与纯表单组装 | 字段 draft 或已有规范 | 规范化 DTO；语义/执行模式透传，不补未声明测试 |
| `tui-refresh.mjs` | 并发刷新仲裁 | 当前/新 snapshot | 最新可见 snapshot |
| `tui-layout.mjs` | 响应式终端布局 | columns/rows | layout DTO |
| `terminal-screen.mjs` | alternate-screen 生命周期 | stdout | ANSI enter/leave |
| `components/` | 展示组件 | ViewModel/viewport | Ink element tree |
| `workflow-summary.mjs` | 冷启动/E2E 报告 | state/tasks | Markdown summary |

TUI 不允许直接读取或写入持久化 state 文件，不允许调用 Agent provider 或 C550 runner，也不拥有工作流状态转换规则。契约变化必须同步更新本 README 和对应测试。

### Windows 存储根身份

Production API 在首次导出 `testerHome` 前调用平台适配器公开 helper
`resolveCanonicalStorageRoot(rootDir, { platform, realpath })`（`client-runtime/platform-runtime.mjs`）。
Windows 默认以 `fs.realpathSync.native` 展开用户已选择存储根的现存前缀，再原样拼回尚未创建的后缀；
只有 `ENOENT` 才向父级查找，`EACCES`、`EIO`、`ENOTDIR` 等错误直接抛出。项目、导出、数据与运行目录
从这个唯一根派生，使后续工作区路径的表示一致；非 Windows 保留 `path.resolve`，不访问文件系统。

解析前检查原始 Windows 输入：设备命名空间、ADS、保留设备名、非法字符及尾随点/空格返回
`PLATFORM_STORAGE_ROOT_INVALID`，不靠路径归一化消除歧义。普通中文、空格、`~draft` 与字面 `build~3`
原样保留；8.3 短名只由文件系统确认，不猜测映射、不删除 `~数字`。字面目录仍可能被 Provider 权限规则拒绝。
归一化仅确认同一目录身份，不增加 root 授权、不更改权限或宿主设置，也不迁移既有 Provider grants，
不修改或重试已被拒绝的运行。用户源码仓库不因存储根归一化而重命名或改写。

局部回归：`node tests/platform-runtime-test.mjs` 验证真实 Windows 短/长路径、缺失后缀、原始输入边界和
注入的文件系统错误；`node tests/generic-tui-production-api-test.mjs` 验证真实无模型/无 GPU 的保存任务、
受管项目及 Runtime 使用统一存储根，并保留用户 Git 工作副本。

### 当前 blocker 与历史诊断

`state.workflowFailure` 中的 `phase='baseline.source'` 记录只在它确实是**当前**未解析研究时才作为当前
blocker 展示：要求 `loopStatus=needs_human` 且 `loopStatusReason=baseline_source_unresolved`、记录中存在
非空 `runId`、`details.missionId` 等于当前 active Mission，且 `research.runId` / `startedAt` /
`status` / `runPhase` 与当前 research（`state.researchAgent || mission.researchAgent || {}`）完全一致。
不一致的历史记录仍然持久保留在 state 中（诊断不丢失），只是不再出现在当前 blocker 显示里；
`benchmark.lastServiceError` -> `benchmarkTask.error` -> `state.baseline.error` -> 当前 workflowFailure
的优先级与 materializer 过滤规则均保持不变。

## TUI 操作

张量每个轴都可选择 B/M/N/K 等常用尺寸符号，也可直接填写自定义符号或固定大小。←→ 选项顺序稳定，不随刚选中的符号重新排列，避免只能在前两个选项间循环。B 可以放在第一维组成 `[B,M,N]`，也可以按算子语义放在其他位置；客户端不自动移动轴。

### 通用算子导入

素材选择完全在终端内完成，无原生窗口、无路径输入要求。默认打开项目目录；“常用位置”提供项目目录、用户目录、Windows 磁盘或 Linux 根目录及当前客户端会话最近五个目录。源码栏 Enter 打开浏览器，↑↓ 浏览、Enter 进入目录、Space 勾选文件，Tab 聚焦可见按钮、←→ 切换按钮、Enter 执行、Backspace 上一级、Esc 取消。进入目录后选“使用当前文件夹”，先生成只读清单，再选“确认添加”；已选清单支持按来源移除，文件夹内文件作为同一来源，避免静默排除部分依赖。Ctrl+S 仅保留为源码确认的辅助快捷键。

独立基线栏 Enter 打开单选浏览器，只显示目录及 .py 文件；run.py 显示禁用原因。选中文件 Enter 立即绑定并返回，不要求再次选择或保存素材；“已导入文件”可直接绑定现有清单中的基线，“移除基线”只解除角色，保留素材。“取消”与 Esc 保留原草稿。已导入文件夹中的基线保持真实相对路径，不再重复添加同名文件。选择仅代表素材就绪，独立基线合同仍在原有准入入口校验。

`P` 默认进入通用创建，`inputMode=form, sourceMode=managed` 无需 JSON 或 Git 仓库。应用选择只更新草稿，提交时才创建受管项目并复制文件；原始文件不变。目录保留相对层级，单个文件放入任务根目录；冲突、链接、超限和读取错误保留已有草稿及当前浏览位置。未提供基线可先保存；生成/启动的准入要求不变。手动 Softmax 素材位于项目目录 `manual-examples/softmax`，从项目目录可直接浏览进入。

`mission-sources.mjs` 是 Production API client 的本地素材适配器：`listMissionSourceDirectory` 浏览；`previewMissionSources` 返回选择路径、相对文件清单、字节数与摘要（不含正文）；`stageMissionSources` 校验预览身份后生成短生命周期 Git 快照，再复用现有 `/api/projects/import` 和 Mission API，成功或失败均清理暂存快照。它不修改用户源文件或 Runtime 状态。无 `run.py` 时只建立抛出 `NotImplementedError` 的待实现入口，不推断语义、不生成测试证据。不拷贝 `.git`、`.operator-studio`、依赖包及 Python 缓存；拒绝链接、特殊文件、路径冲突、选择后内容变化，最多 64 个文件（含系统入口）、单个 2 MiB、合计 8 MiB。空目录不保留。所有文件检查先于当前 Mission 的停止/切换。

旧程序调用的仓库模式和 `spec-file` 导入继续兼容。交互表单只通过添加、编辑、删除张量配置输入输出，不展示 `name:dtype[dim,dim]@layout` 编辑行；该格式仅保留为内部存储与旧 API 合同。形状用 ←→ 选维数，各维单独填名称或数值，布局选项按维数联动：零维自动为标量，四维才提供 channels_last；改变维数使旧布局失效时要求重新选择。总览每项一行，进入单项编辑后可完成、复制、删除；复制自动生成唯一名称，shape 副本不继承主场景。shape 编辑页提供可见的“设为主场景”。所有普通字段的 Enter 确认下一项，不提交 Mission；在“检查并提交”查看摘要后，通过“确认提交”创建。校验错误会自动打开相应编辑页并定位，Ctrl+D 删除快捷键仍可用。旧的损坏项也可逐项修复或删除。时间预算可空；验收要求不会因空字段获得隐式默认。

`publishMissionDraft(draft)` 使用同一个 `importMissionSpecification(spec)`。文件检查先于 Runtime/项目导入和旧 Mission 停止：`run.py` 与所有声明依赖必须存在、为常规安全文件，每文件 ≤2 MiB，总计 ≤8 MiB、最多64个；原仓库与受管快照逐文件字节一致。路径逃逸、链接、硬链接、缺失文件、内容漂移均拒绝。独立基线额外限 UTF-8 `.py`、≤200000字节、既有五函数桥接合同，并与语言适配器允许写入的候选文件分离。静态结构检查不是正确性执行。新增公开依赖为 `baseline-materializer.mjs` 的纯 `validateBaselineRunPy`；不调用材料化模板或模型。

基线采用 `source.authority=user-provided`，包含原仓库、受管仓库 HEAD、实际文件摘要。HEAD 不冒充脏工作副本的文件身份。`materializer.status=completed` 只说明用户文件工件就绪；`baseline.status=missing`、`evidence=null`，无性能值或权威声明。

仅生成模式额外要求「声明源码总字节 + 独立基线/materializer.runPy 的 UTF-8 字节」≤4 MiB，与待测存储输入上限一致；基线同时在 sourceFiles 中时两份均计入。超限在连接 Runtime、导入项目或停止旧任务之前返回 `GENERIC_GENERATION_INPUT_TOO_LARGE`。普通 iterate 保留原有源码限制。待测 bundle 的8MiB上限不扩大输入额度，最终生成产物仍需经过 Runtime 冻结检查。

普通 Git 仓库通过 `POST /api/projects/import` 导入独立三层工作副本，保留工作区修改和非忽略新文件，原仓库不变。已登记的受管仓库复用现有项目。`execution=save` 原子保存暂停任务；`generate-only` 传 `executionMode=generate-only`，`start` 保持 `iterate` 及本地预检。两个启动动作均先创建 paused，再调用 `/runs {startDraft:true}`，Agent 准入失败不解除暂停。首次保存的 generate-only 草稿可用同一入口恢复；已运行或有 pendingValidation 时返回 `409 GENERATION_ONLY_TEST_NOT_ENABLED`，不重置预算。规格、校验规则和示例见
[`GENERIC_MISSION_SPEC.md`](./GENERIC_MISSION_SPEC.md)。

已配置共享 GPU package store 的 Runtime 还提供
`importExecutionPackage(input)` → `POST /api/execution-packages/import`：接受本地
目录或归档路径、候选/验收入口、冻结 testSpec 和 Mission/Workspace/Candidate
绑定，返回内容地址 manifest 与可信 admission。全部文件（含依赖）在导入时进入
包内，后端先验证路径/内容再 prepare；该客户端不读写 Runtime state、不安装依赖。

- `M` / `Esc`: 从工作台返回已有 Mission 列表
- `P`: 创建通用任务，或显式选择固定示例（首页/列表也接受 P 作为 N 的兼容键）
- `Space`: 暂停或恢复 Mission
- `N`: 添加人工意见，意见会进入生产迭代上下文
- `D`: 检查当前执行后端；NVIDIA 不探测 MetaX 工具链
- `K`: 查看当前项目经验；本轮选入经验由 Runtime 的实际选择记录展示
- `S`: 停止 Agent、测试任务和自动循环
- `E`: 导出生产 state、queue task 和 backend 信息
- `Q`: 退出 TUI，并停止本次会话拥有的 API runtime

枚举字段使用左右方向键选择。C550 与 NVIDIA、Ascend 均可作为任务目标保存；当前后端不匹配或语言尚未接入时拒绝启动本地迭代，不替换为另一设备。NVIDIA 语言支持读取 `target-capability-registry.mjs` 的公共 `capabilitySupportsLanguage`，最终测试准入仍由 Runtime 决定。固定示例模式保留两个完整 v0.1 Profile：`paged-mqa-logits-triton-v01` 和 `flash-mla-decode-triton-v01`；其语义和矩阵仍只由固定 Profile 模块定义。所有语言保留 `run.py` 作为 Runner 桥。面板顶部 Tokens 累计当前 Mission 的实际 Agent 消耗，重复刷新不会重复计数。

导出 schema 为 `operator-studio.mission-export/v1`，包含状态快照及 `pendingCandidate`（无待测候选时为 null）。有 `iterationStats.pendingValidation` 时读取 `GET /api/missions/:id/pending-candidate`，将 `{pendingValidation,bundle}` 连同冻结文件字节导出；清单必须与状态快照一致，失败不覆盖已有导出。客户端不从可变 Mission Workspace 重新收集候选，也不启动环境探测。

## C550 现场环境

目标环境：

- Python `3.12.11`
- PyTorch `2.8.0+metax3.3.0.2`
- Triton `3.7.1`
- MACA `3.3.0.15`
- vLLM `0.13.0`
- vLLM MetaX `0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8`
- `mx-smi`, `mctracer`, `mcProfiler`

默认真实执行命令是 `python tools/local-c500-runner.py`。Baseline Materializer 根据权威语义生成具名 `get_test_cases()` 和 `get_benchmark_inputs()`；Runner 使用独立 baseline oracle 产生输入与预期结果，只调用候选的 `run(inputs)`，防止候选通过改写 reference 自证正确。Correctness 覆盖 minimal、representative、boundary、ragged 类别，benchmark 覆盖 primary、small、boundary profile（任务声明了 `testSpec.benchmark.shapes` 时改为这些具名 shape，Runner 在测量前核对每个 profile 的输入形状，不符记为 `OPERATOR_BENCHMARK_SHAPE_MISMATCH` 的 oracle 合同错误；Gate 仍只按主场景评判），并继续主动尝试 mctracer 和 mcProfiler。两项诊断工具缺失或执行失败会记录 warning/失败工件，但不会阻塞 benchmark、Accept Gate 或采用；`mx-smi`、C550 软件栈、correctness 和 benchmark 仍是硬要求。固定 Profile 每轮最多允许 3 次候选生成，correctness 修复独立允许 4 次；correctness 修复不会消耗候选生成配额。

现场工具参数不同可设置：

```powershell
$env:OPERATOR_LOCAL_C500_COMMAND='python "tools/local-c500-runner.py"'
$env:OPERATOR_LOCAL_C500_MCTRACER_COMMAND='...'
$env:OPERATOR_LOCAL_C500_MCPROFILER_COMMAND='...'
npm run tester:c500
```

命令模板支持 `{tool}`、`{artifactDir}`、`{python}`、`{runner}`、`{runPy}`。

## Mock 边界

工作流回归可显式启用：

```powershell
$env:OPERATOR_LOCAL_C500_MOCK='1'
npm run tester:c500
```

Mock 只替代 queue 后面的硬件输出。Mission 解析、Agent Runtime 兼容层、Workspace diff、baseline、Accept Gate 和循环仍走生产模块；它连接所选且通过能力预检的 Agent 后端。Mock 结果始终标记 `source=simulation`、`liveHardware=false`，不能成为真实硬件证据，也不会创建 `verified=true` 的 current best。若不希望调用任何模型，请使用上面的完整模拟模式。

真实与模拟 runtime 不能复用同一个端口。切换模式时请停止旧 runtime，或同时更换 `LOCAL_C500_API_PORT` 和 `LOCAL_C500_TESTER_HOME`。TUI 会拒绝连接模式不一致的旧服务，避免把模拟结果误认为真机结果。

## 验证

创建页 Ctrl+S 保存“待配置”草稿：只需算子与目标，其他项可后续补齐。
`saveMissionConfigurationDraft` / `loadMissionConfigurationDraft` 使用
`/api/mission-drafts`，不停止、切换或启动已有 Mission。所选素材先通过
既有 `/api/projects/import {activate:false}` 保存独立副本；重开草稿继续
使用副本，更新要求版本一致。列表按 Enter 重开配置；完整提交验证通过后
按 draftId/revision 原子转成 Mission。已有完整配置的 `execution=save`
仍是冻结后的暂停 Mission，与可编辑准备草稿不同。

新表单的 dtype 容差按每个输出生效；布局进入冻结合同并实际校验
（strided 允许任意步长，channels_last 要求四维，scalar 要求零维）。
余弦误差上限默认 1e-5 且显式可见。2 ms 转为 2000 us；识别到数值目标
时创建 threshold objective，持续优化仍为 maximize。固定 Profile 保持原合同。

```powershell
npm run verify:local-c500-release
```

发布门禁会串行执行工作流内核、恢复、Research/Baseline、Candidate、Gate、TUI 和构建检查。也可单独运行：

```powershell
npm run test:local-c500-production-backend
npm run test:local-c500-production-tui
npm run test:intent
npm run test:loop
npm run test:gate
npm run test:workspace
npm run test:queue
npm run test:operator-language
npm run test:test-spec
npm run test:token-usage
npm run build
```

`npm run e2e:agent-runtime-hardware-mock -- codex-cli paged-mqa-logits-triton-v01 900000 300000` 会使用所选真实 Agent Runtime 和 Mock C550 完成生产链路三轮闭环。旧的 `e2e:local-c500-production` / `e2e:local-c500-cold-start` 是 Codex 定向诊断脚本，不再代表通用兼容层验收。

三轮实机完成后，按 `E` 导出 Mission，再用报告命令计算每轮相对 baseline 的加速比、精确 token 和墙钟时间：

```bash
node scripts/report-c500-iteration.mjs \
  .local-c500-real-c550/exports/<MISSION_ID>.json \
  > .local-c500-real-c550/iteration-report.json \
  2> .local-c500-real-c550/iteration-report-errors.log
```

报告要求恰好检测到 3 个已完成 candidate round；`speedup` 对 latency 使用 `baseline / candidate`，对 throughput 使用 `candidate / baseline`。`tokenUsage.completeness` 必须为 `exact`，否则只能作为不完整统计，不能用于成本结论。

## 导入边界、业务成功条件与最佳源码（2026-10-08）

新素材提交前必须在清单里确认最终文件范围。清单分别展示纳入文件、排除文件及原因、系统生成的 run.py 入口。系统入口只用于保存空任务，未执行且没有性能证据。普通 .gitignore 排除项可逐项选回依赖；凭据、敏感配置、链接和系统目录不能通过该选项加入。取消不改变原配置。

previewMissionSources(selections, {includeIgnoredPaths}) 返回 sourcePolicy、reviewDigest、files、excludedFiles、generatedFiles；不暴露内部内容 Map。保存/提交携带 sourcePolicy、sourceReviewDigest、importedFiles；素材内容、忽略规则或显式选回范围变化时拒绝，须重新预览并确认。准备草稿复制到受管目录后重新绑定该副本身份，原用户目录保持只读。sourcePolicy.intakeReview 保存批准边界供冻结候选核对。详细约束见 [mission-sources.md](mission-sources.md)。

新表单默认启用固定业务策略：保护全部必测场景、允许退化 0%，主场景严格优于独立基线；数值目标可设相对提升或延迟上限。策略保存到既有 testSpec.acceptancePolicy，使用原 testSpecDigest，不引入另一套任务身份。旧任务不补写策略；旧准备草稿缺该字段时以 legacy 模式重开。只有正确性覆盖、冻结契约及各保护场景的环境/单位/稳定测量可比较时才判定；缺测量拒绝。可用且有改进但未达数值目标的候选可以成为 best。工作台分别显示正确可用、已保留最佳、已采纳、目标达成，不能把 Gate 的可采纳资格当作实际采纳。

B 导出已验收最佳源码，E 保留原任务/待测候选导出。客户端 exportBestCandidate() 查询 GET /api/missions/:id/best-candidate，经共用 assertBestCandidateExport 校验后，writeBestCandidateExport(document, exportHome) 创建独立新目录，包含 sources/、baseline/oracle.py、test-matrix.json、原回执和 REPLAY.md。无最佳或旧最佳缺冻结源码明确报错，不取 pending 或当前工作树兜底。

显式 generate-only 候选经 F 结算，以及普通自动迭代模式，均在接受并保留 best 后绑定该次测试前冻结的原始源码。后续候选、工作区修改和重启不会替换已绑定源码。历史 best 若未保存不可变源码仍报 BEST_CANDIDATE_SOURCE_UNAVAILABLE；导出不会补造历史证据。

离线文件身份检查（不会执行算子）：

    node tools/local-c500-tester/replay-best.mjs --validate "<导出目录>"

verifyBestCandidateDirectory(directory) 使用与服务端相同的纯契约校验，并核对解包后的源码、独立基线、测试矩阵与历史执行描述。execution-package-input.json 是原运行回执的描述，可能为空或含原路径，不能直接宣称可移植执行包。脱离原工作区的硬件执行重放仍需明确目标环境并构造新的执行包，本次未验证；离线通过不产生新性能、跨硬件或发布资格。

新导入的受管项目目录使用最多 32 字符的算子名称、时间标识与随机后缀；完整目标仍保存在 Mission 元数据中，避免长目标生成深 Windows 工作区路径。已经登记的项目仍优先按原 repository/root 匹配，不迁移旧目录。保存或提交失败时表单保持打开且内容不清空，可修正后重试。

## 旧运行未知状态的恢复（2026-10-09）

电脑不必一遇到“等待资源释放”就重启。先用 I 轨迹评价及事件记录区分：GPU 队列
仍在执行、Agent 本机运输进程仍在运行，或只是旧运行缺少退出回执。不要删除运行
文件、改 released 字段或通过换 Tester Home 绕过冲突。

本次已在原 Tester Home 完成原生 Claude 任务级退役：旧记录、预算、最佳源码和
未知远端结果保留，旧 Mission/run/session 永久禁止再生成及候选准入。它没有
被记作正常退出，也没有恢复旧任务预算。退役后从正常新建任务入口保存新的
Mission，使用新的任务工作区和 session，仍经过原有队列、正确性、性能及 Gate。
旧 Mission 可用于查阅历史；继续生成必须另建任务，不能对旧任务按恢复。

退役要求 Agent 工具面禁止 Bash、两次完整本机普查无 Claude/旧身份进程，
以及所有 GPU 队列和其他执行资源都有明确释放回执。任何条件未知或不满足，
继续保持屏障。技术操作入口为同一服务的
POST /api/missions/:missionId/runs/:runId/retire-execution，请求体为空对象；
它是受控维护入口，TUI 当前没有新增退役按钮。见
[任务退役契约](../../client-runtime/claude-execution-retirement.md)。

退役只隔离旧本机运输和结果归属；原进程树历史退出、远端模型完成及费用仍未知。
已保存的 Windows 重启检查点继续作为兜底，不能把网络重连或服务重启当整机重启。
当前共享 NVIDIA 的收益仍属开发测量，不是发布或跨硬件验证。下一次真实模型调用
需要通过宿主执行审批；审批拒绝时保留准备好的任务，不换命令绕过。

## Current accelerator targets

Generic Mission target choices include C500 and Ascend910B. Use
`npm run tester:metax-c500` or `npm run tester:ascend910b`; each reuses the same
Production API, Runtime, queue and Gate. Doctor requires actual exact-device and
version qualification. Saving a Mission does not require device readiness.
C550 fixed examples retain the historical route via `npm run tester:c550:legacy`.
See [machine handoff](../../docs/development/ACCELERATOR_MACHINE_HANDOFF.md).
Linux arm64 requires already provisioned Node 20+ and native locked dependencies;
no x64 archive fallback/install is attempted there.

C500/910B launcher entries on every platform require existing Node 20+ and platform-native dependencies. Missing dependencies fail before TUI startup; no installer or bundled fallback runs. The C500 shell start/doctor modes also use existing Node/npm. Historical compatibility/mock helpers retain their existing bootstrap behavior.
