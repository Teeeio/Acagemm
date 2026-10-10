# Claude Code Adapter Module Contract

`system/api_retry` becomes diagnostic `provider.retry` with bounded numeric
attempt/HTTP status fields only. It is neither a terminal failure nor a success,
and arbitrary provider error bodies are not copied into that event.

Correlated failed tool results for `permissions.blockReadsOutsideWorkingDirectories`
are classified as `CLAUDE_TOOL_PERMISSION_DENIED`, including the installed CLI's
`File ... is outside ...` diagnostic. They cannot become successful generation
just because the final model response says success. Successful file content or
quoted diagnostic text in an ordinary edit mismatch does not grant this classification.

模块归属：`client-runtime/` 下的 provider 适配器，实现 `agent-runtime` 使用的最小 agent 运行契约。
CLI 探测、参数拼装、事件归一化、运行记录与取消传播都在这里；策略与编排不在。

## Purpose

把本机的 Claude Code CLI 包成 `agent-runtime` 能用的运行体。关键约束是**能力边界必须由适配器自己
拥有**：宿主的 `~/.claude/settings.json`、宿主的工作目录默认值，都不得悄悄参与本次运行的授权。

## Public API

Controlled experiment options add `experimentIsolation` and `experimentRoot`
(also selected by `OPERATOR_CLAUDE_EXPERIMENT_ISOLATION=1` and
`OPERATOR_EXPERIMENT_ROOT`). They require working, additional read/write and
managed configuration roots inside the independent experiment. Each call starts
a fresh session; resume hints are discarded and recorded, while required round
facts remain in the explicit prompt. Ordinary runs retain existing behavior.

The controlled call uses `--safe-mode --setting-sources user --settings <managed>`.
Managed settings disable auto memory and set
`permissions.blockReadsOutsideWorkingDirectories=true`; the environment forces
auto memory off even if an inherited value enabled it. Existing tool restrictions,
MCP isolation and deny rules remain. The run records these controls and explicitly
does not claim an OS sandbox. Safe mode skips discovery of CLAUDE.md, hooks,
skills, plugins and auto memory while retaining authentication and permissions.
See [Anthropic CLI reference](https://code.claude.com/docs/en/cli-reference).
Both descriptor and run authentication probes use that same mode and force
`CLAUDE_CODE_SIMPLE=0`. Installed CLI 2.1.289 ignored bearer-only credentials in
bare/simple mode; the prior descriptor used ordinary mode and incorrectly passed
admission before start failed. Credentials are never converted into another type.
The local campaign requires actual CLI read-boundary and context-canary evidence,
in addition to the adapter's argument tests. Authentication still comes from the
existing in-memory credential projection; no host credential file is copied.

Controlled runs use `dontAsk` together with **path-scoped** `Edit(<root>/**)`
auto-approvals for the working and writable directories. They never globally
auto-approve `Edit`/`Write`. The real local CLI canary reproduced an outside write
when global auto-approval and `acceptEdits` were retained; read confinement alone
did not prevent it. With scoped approvals, local read/create still succeeds and
foreign read/create fails. The mode name alone remains no security guarantee.
The installed-CLI canary uses bearer-only local fixture credentials and verifies
local Read/Edit/Write, foreign Read/Edit/Write refusal and absent automatic context.

| 导出 | 说明 |
|---|---|
| `createClaudeClient(options)` | 构造客户端。options：`command`、`bridgeDir`、`permissionMode`、`spawnImpl`、`execFileImpl`、`terminateProcessTreeImpl`、`descriptorTtlMs`、`hostConfigDir`（宿主配置根，供隔离测试注入） |
| `client.describe({ refresh? })` | CLI 是否安装、受管执行上下文是否认证、版本（带 TTL 缓存）；错误只含固定 code/说明 |
| `client.preflight({ workspace })` | `{ ready, code, workspace, command, version, configurationAuthority, permissionMode, permissionModeIsBoundary }` |
| `client.start({ runId, missionId, goal, workspace, additionalDirectories, readOnlyDirectories, protectedDirectories, resumeThreadId, environment })` | 起一次运行并写运行记录 |
| `client.readRun` / `readEvents` / `cancel` | 运行记录、事件流、取消 |
| `normalizeClaudeEvents` / `claudeActivityFromEvent` / `classifyClaudeFailure` / `isClaudeTelemetryEvent` | 事件归一化与故障分类（纯） |

## 能力强制面（本模块的核心语义）

`--permission-mode` **不是**安全边界。本机实测：`acceptEdits` / `dontAsk` /
`bypassPermissions`，以及把配置根隔离到运行时自己的目录，四种情形下 workspace 之外的写入**都成功**。
它决定 CLI 的交互行为，不决定能力上限。

因此 preflight 不再因 mode 而拒绝启动，运行记录里用 `permissionModeIsBoundary: false` 显式标注这一点。

真正有牙齿的两条通道，都由 **grant** 派生（推导见 `claude-permission-surface.mjs`）：

1. **工具面**（主边界）：`--tools` / `--disallowedTools`。持有只读引用根且没有任何可写根的运行，
   写工具从工具面整个摘除——写入不是「被规则拒绝」，而是**不存在该工具**。
2. **配置根 deny 规则**（纵深防御）：`<configRoot>/settings.json` 的 `permissions.deny`，形如
   `Edit(//c/path/**)`。实测配置根里的 deny 规则在显式 `--permission-mode` 下仍然生效。

运行记录登记实际生效的面：

```
enforcedSurface: {
  authority: 'tool-surface',
  toolSurface: { allowedTools, disallowedTools, writeToolsWithheld },
  denyRules: [...],
  permissionModeIsBoundary: false,
}
boundary.enforcement: 'claude-tool-surface-and-config-deny'
```

### 受保护目录：旁路唯一能靠得住的写边界

`protectedDirectories` 是与 workspace 同级、但**不属于本次运行**的目录（研究运行的候选工作区、
基线、Source Registry）。研究员必须能写自己的调研目录，所以写工具摘除在这里不适用；拦得住它的
只有路径级 deny 规则——也就是说，对旁路而言这条规则**就是主边界**，不是纵深防御。

- 规则形如 `Edit(<dir>/**)`，与只读根的规则同形、同一下发通道，写进运行记录的
  `protectedDirectories` 与 `enforcedSurface.denyRules`。
- 目录包含 workspace 时**跳过并登记**（`protectedDirectoriesSkipped`，原因 `contains_workspace`）：
  deny 是前缀匹配，写下去会把 agent 自己锁在门外。跳过要可见，不能静默失效。
- 同一目录既授可写又列受保护 → `CLAUDE_DIRECTORY_GRANT_CONFLICT`。授权面自相矛盾时失败，
  而不是让「保护」被悄悄忽略。

codex 侧不需要额外规则：沙箱把写限制在 `--cd` 与 `--add-dir` 的可写根内，研究运行的可写根恰好
只有调研目录。适配器只登记 `protectedDirectories` 与 `protectedEnforcement: 'sandbox-writable-roots'`，
不把「沙箱顺带挡住」说成「我们额外强制了它」。

### 判定键是 grant，不是 role 名字

写工具摘除的判定是 `readOnlyDirectories.length > 0 && writableDirectories.length === 0`。
此前它写死在 `role === 'research-acquire'` 上，于是任何**别的** role 只要传 `readOnlyDirectories`，
就会同时拿到读授权与写工具——声明的只读与实际的只读不一致。

role 现在只用来挑「联网研究」与非联网这两档读工具集。

### 配置根每次运行独立

`CLAUDE_CONFIG_DIR` 指向 `<bridgeDir>/claude-config/<runId>`（打包目录只读时回退到
`<tmp>/operator-studio-claude-config/<runId>`）。**按运行隔离是必须的**：deny 规则写在配置根里，
共用目录会让并发的两次运行互相覆盖 settings.json，把其中一次的 deny 悄悄抹掉，而那条运行记录里
登记的却是它写过。

隔离的是配置目录，不是进程环境：`PATH` 等照常传递。宿主认证可能来自 `settings.json.env`，
不能假定凭证已在父进程环境中。配置根在创建客户端时取 `options.hostConfigDir`，否则取
`process.env.CLAUDE_CONFIG_DIR`，缺省为 `homedir()/.claude`。只读该根的 `settings.json`，
不读项目设置、不复制 `.credentials.json`/Keychain、不执行 `apiKeyHelper`、不写宿主。

固定投影白名单为 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、
`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、
`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`。只接收不含 NUL 的字符串；
`settings.model` 仅在宿主 `env` 未声明 `ANTHROPIC_MODEL` 时提供缺省。认证、端点与模型映射一起
投影，避免只搬运令牌却丢失网关路由。顺序为宿主白名单缺省 < ambient 进程环境 < 本次显式
`environment`，显式空字符串也覆盖缺省。宿主的其他 `env`、hooks、MCP、permissions、helper
脚本完全不导入。支持范围是这些变量表达的 Anthropic 兼容端点；Bedrock/Vertex/Foundry 模式
明确拒绝，不能因忽略其开关而误投递到另一后端。仅有磁盘登录、helper 或其他 provider 的认证
不被推测为可继承；无受管认证即拒绝准入。

投影值只放在子进程 `env` 的内存对象，不放进 settings、run JSON、事件或诊断。子进程若回显
已知的投影凭据，适配器在结构化事件/运行记录落盘前只递归脱敏字符串值，保留键名、数字、
布尔及 JSON 可解析性；非 JSON 行与错误文本单独替换字面/转义值。原有诊断仍只记录计数和
生命周期，不增加环境快照。该脱敏不是对任意未知敏感数据的识别声明。

`describe` 的版本探针与认证失败分开：CLI 可安装而受管认证不可用。`auth status` 在独立受管
探针配置根执行，使用同一投影规则，只接受 JSON 对象的布尔 `loggedIn:true` 和成功退出。
探针根固定为受管目录下的 `.auth-probe`，客户端内初始化一次后只读复用；该名字不能成为 runId，
不与运行目录共享设置，也不在每次刷新时累积 UUID 目录。
不再用自然语言或退出码猜登录；不保留原始 auth stdout/stderr、账户资料或 JSON 内容。
`preflight` 刷新认证，不沿用缓存的成功准入；`start` 在本次实际受管目录、最终子进程环境中
再次执行相同认证检查，成功后才创建运行记录和模型子进程。显式 `environment.CLAUDE_CONFIG_DIR`
（含空值）被拒绝，runId 必须为安全文件名，受管配置不能写到宿主根内。权限模式、deny/tool
边界、公开 start 参数、预算、队列及取消语义不变。

固定失败码：`CLAUDE_HOST_CONFIG_INVALID` / `CLAUDE_HOST_CONFIG_UNREADABLE`（宿主设置），
`CLAUDE_AUTH_ENV_INVALID`（投影值类型），`CLAUDE_AUTH_CONFIG_UNSUPPORTED`（不支持的认证机制），
`CLAUDE_CONFIG_OVERRIDE_FORBIDDEN` / `CLAUDE_MANAGED_CONFIG_UNAVAILABLE` / `CLAUDE_RUN_ID_INVALID`
（受管目录），`CLAUDE_AUTH_STATUS_INVALID` / `CLAUDE_AUTH_PROBE_FAILED` / `CLAUDE_AUTH_UNAVAILABLE`
（受管认证）。配置缺失可使用进程/显式环境认证；坏 JSON 不静默跳过。错误不携带解析内容或原始异常。

软件回归：`node tests/claude-runtime-test.mjs` 使用真实临时宿主文件与 fake 子进程，检查投影优先级、
端点/模型配套、空值、并发隔离、失败准入、宿主字节不变和凭据回显脱敏，同时保留既有事件/权限
用例；配套运行 `node tests/claude-permission-surface-test.mjs`。不发起真实模型请求。

官方依据：[authentication](https://code.claude.com/docs/en/authentication)、
[environment variables](https://code.claude.com/docs/en/env-vars)、
[settings](https://code.claude.com/docs/en/settings)。这些文档说明 settings 可含环境变量，
`CLAUDE_CONFIG_DIR` 改变配置及相关凭据上下文；宿主探针通过不等于隔离运行认证通过。

## 明确工具权限拒绝

仅由同一事件流中真实 `tool_use.id` 关联的受管工具 `tool_result`
（`is_error === true`）产生 `CLAUDE_TOOL_PERMISSION_DENIED`，固定 `retryable:false`。
工具名限 Read/Write/Edit/Glob/Grep/WebSearch/WebFetch；不接受生成的补位 ID、
无关联结果、成功工具结果、assistant 文本或工具输入作为权限证据。
识别工具首行诊断中的明确文案：`suspicious Windows path pattern that requires manual approval`、
`denied by your permission settings`、`Permission to use <managed tool> ... denied`，以及
`Claude requested permissions to write to ..., but you haven't granted it yet.`。
普通字符串未找到、重复匹配或文件不存在只按稳定诊断开头排除，后附摘录不参与判断；
路径自身含 `old_string`、`not found` 不得遮蔽真实拒绝。

首次拒绝写入 run.error（含 `code/retryable/message/toolUseId/toolName`），并归一化为
`{type:'error',provider:'claude-code',error:{...}}`。后续成功 result、exit 0、进程错误或取消
不得清除拒绝；拒绝后的 result 归一化为 `turn.failed` 并保留 usage。
逻辑失败先带 `resourceRelease:{confirmed:false,status:'active'}`，只有 child close
才确认释放；沿用 Runtime 现有取消/释放屏障，不能把工具拒绝当成进程退出。

`classifyClaudeFailure` 优先读取 typed run.error/normalized error，向现有编排投影
`agent.primaryFailure.code='CLAUDE_TOOL_PERMISSION_DENIED'`、`retryable:false`。
Runtime 对历史 completed run 也读取这一证据，只调整状态投影、不重写旧 run；
释放后状态为 failed，禁止 captureDiff、结果 patch 回退以及 partial diff 候选准入。
取消回执与超时恢复不得把此失败转换为可恢复候选。此模块不暂停 Mission、不续期预算、
不重试或修改授权；循环收尾由现有编排负责。

回归：`tests/claude-runtime-test.mjs` 注入真实 stream-json 事件形状（先 Read 成功、
再 Edit 拒绝、最终 success/exit 0），验证持续失败与磁盘重读；
`tests/agent-runtime-candidate-admission-test.mjs` 使用临时 Git 检查合法 patch/partial diff
均无写入和候选，释放屏障、generation-only 原预算不变，以及普通工具错误仍可合法回退。

## Invariants

- 工具面永远不含 shell 类工具（`Bash` / `NotebookEdit`），任何档位都不含。
- 同一次运行不得把同一目录同时授予可写与只读（`CLAUDE_DIRECTORY_GRANT_CONFLICT`）。
- `role === 'research-acquire'` 却不带任何只读根时**显式失败**（`CLAUDE_ACQUIRE_GRANT_MISSING`）：
  缺根会让它落到「联网 + 有写工具」那一档，比收紧前更宽，绝不能静默通过。
- 写规则名只能是 `Edit(...)`。文件权限检查从不匹配 `Write(...)`；写成 `Write(...)` 会长久地看起来
  「配了 deny」，实际一条都不匹配（2.1.275 起的坑）。
- 路径规则必须归一化成小写盘符、无冒号的双斜杠锚点（`C:\x` → `//c/x`）；`//C:/x` 不匹配。
- 不声称 `--add-dir` 是写权限开关：它只是把目录列为工作目录。只读根的只读性由工具面摘除保证。
- 路径 deny 规则对持有写工具的运行是主边界，对已摘除写工具的运行才是纵深防御。哪种情形适用取决于
  这次运行有没有写工具；运行记录里两者都登记。
- deny 规则只挡写，不挡读。受保护目录既不进 `--add-dir`（不是读授权），也不声称挡住了读——
  读侧没有边界，本仓库不假装有（见 Non-Responsibilities）。

## 错误码

| 码 | 含义 |
|---|---|
| `CLAUDE_NOT_INSTALLED` | 未检测到 CLI |
| `CLAUDE_WORKSPACE_UNAVAILABLE` | workspace 不存在或不是目录 |
| `CLAUDE_DIRECTORY_GRANT_CONFLICT` | 同目录既授可写又授只读，或既授可写又列受保护 |
| `CLAUDE_ACQUIRE_GRANT_MISSING` | acquire 角色未携带只读引用根 |
| `CLAUDE_TOOL_PERMISSION_DENIED` | 已关联受管工具明确权限拒绝/等待人工批准，非重试失败；禁止结果 patch 与候选准入 |
| `CLAUDE_AUTH_REQUIRED` / `CLAUDE_BILLING_UNAVAILABLE` 等 | 运行期故障分类，见 `classifyClaudeFailure` |

`CLAUDE_PERMISSION_MODE_UNSAFE` **已删除**：它拦的是一个名字，不是一个能力差。

## Non-Responsibilities

- 不决定要不要研究、研究哪个阶段、预算多少（`research-policy.mjs`）。
- 不决定给哪个角色授予哪些根（`agent-runtime.mjs` 的调用点）。
- 不做读侧硬限制：实测两侧都没有读边界，仓库不声称有。

Output-token-limit notices: normalize the known CLI user text prefix into provider.output_limit with provider, stable code and optional timestamp only. Do not copy arbitrary provider notice text. This is progress/diagnostic evidence, never a completed turn, retry count, usage estimate or candidate. Existing raw run diagnostics retain numeric thinking events separately.

The known CLI user notice prefix `Output token limit hit.` becomes the bounded `provider.output_limit` event. It records the fact and timestamp only; arbitrary user/provider bodies are not copied into diagnostics. This is upstream generation telemetry, not operator acceptance or resource release proof.

Windows process lifecycle uses [durable Job supervision](claude-process-supervisor.md). The optional localHostRecovery(runId,action) port uses [legacy host recovery](claude-host-recovery.md); capture/recover never start a model and preserve the original raw legacy record.

Legacy native Claude runs can use [task-level retirement](claude-execution-retirement.md), which preserves unknown historical exit while independently proving transport absence and permanently fencing original execution identities.
# Shared process boundary

`OPERATOR_PROCESS_BOUNDARY=appcontainer` requires the shared Windows supervisor
and an operator-owned [execution plan](appcontainer-execution.md). Missing plans
fail before authentication probes; native argv reaches the same AppContainer
launcher used by Codex and the runner. Process records retain observed boundary
evidence for restart checks. This does not create a profile, grant private config
access or approve model network traffic.

# Durable Job loss identity fences

The client consumes the public [job loss retirement adapter](claude-job-loss-retirement.md). A trusted host context selects exact durable retirement; absent that context, `retireExecution` retains the legacy path and eligibility. Start rejects a global retired Mission/run/session/workspace before auth or launch. Read returns the immutable original with an operational disposition and unknown physical release, and excludes old raw events from candidate admission. Cancel cannot rewrite or reterminate a fenced identity.


## Durable Job loss identity fences

The client consumes the public [job loss retirement adapter](claude-job-loss-retirement.md). A trusted host context selects exact durable retirement; absent that context, retireExecution retains the legacy path and eligibility. Start rejects a global retired Mission/run/session/workspace before auth or launch. Read returns the immutable original with an operational disposition and unknown physical release, and excludes old raw events from candidate admission. Cancel cannot rewrite or reterminate a fenced identity.
