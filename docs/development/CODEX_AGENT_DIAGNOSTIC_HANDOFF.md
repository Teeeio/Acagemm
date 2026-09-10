# Codex Agent 真实闭环问题诊断交接

> 供外部专家复核当前“Agent 生成候选 → 应用到 Mission Workspace → 校验 → 测试队列 → 经验沉淀”链路。
> 本文只记录已经采集到的证据和可复现实验，不把一次成功运行描述为稳定性结论。

## 1. 当前结论（先读这一节）

截至 `2026-09-10`、提交 `9c7d946`：

- **真实链路已经可达**：一次使用本机 Codex CLI、`gpt-5.5`、`workspace-write` 的完整首轮候选生成成功，候选被应用、4 个 correctness case 通过、两个 benchmark profile 完成，证据摘要与持久化基线一致。
- **尚不能称为稳定闭环**：同一次 E2E 中启动的后续迭代在 `turn.started` 后进入 `cancel_requested`，资源释放证据未确认（`CODEX_PROCESS_TREE_UNVERIFIED`/`CODEX_CANCEL_UNCONFIRMED`）。历史运行还出现过只有 `thread.started/turn.started`、没有终态事件的情况。
- **最有力的已确认诱因不是模型能力不足**：Windows sandbox helper 缺失、受限网络下 TLS `UnknownIssuer`、用户/项目配置带来的超大上下文、错误 unified patch，以及 Windows 子进程退出/清理时序都被实际观察到。`gpt-5.5` 在最小探针和真实首轮中都能正确理解任务并写入工作区。
- **目前没有容量结论**：现有日志没有发现 `429`、`rate_limit`、`capacity`、`overloaded` 等服务端容量信号，因此不能把问题归因于“模型服务 at capacity”。网络/TLS 或 Code Mode/CLI 流事件桥接仍需进一步区分。
- **建议外部专家将问题定义为**：`间歇性收敛 + 终态/资源释放可观测性不足`，而不是“模型不会生成算子”。

## 2. 范围、环境与生产边界

### 2.1 本次诊断范围

本报告针对 Windows 主机上的本地 Codex Agent 运行时，使用本地 CPU 测试后端验证控制面和候选闭环。没有把 GPU、真实云端队列或 live hardware evidence 当作本次结论的一部分。

已确认的环境基线：

| 项目 | 值 |
|---|---|
| Host | Windows（Node.js 运行时；WSL2/Ubuntu 已安装，但本报告证据来自 Windows 路径） |
| Node.js | `22.23.2` |
| Codex CLI | `0.153.4` |
| 模型 | `gpt-5.5` |
| Agent 适配器 | `E2E_AGENT_RUNTIME=codex-cli` |
| Codex 沙箱 | 生产探针使用 `workspace-write` + Windows `unelevated` fallback |
| 测试后端 | `local-c500` / CPU；不是 live hardware |
| 当前提交 | `9c7d946`（与 `origin/main` 对齐） |

### 2.2 不可破坏的生产边界

生产调用方向是：

```text
TUI -> HTTP API -> application orchestration -> domain rules -> ports -> Agent/Workspace/Queue/Gate
```

本诊断不改变这些边界：

- Agent 只能写当前 Mission Workspace；
- 候选必须有非空、可应用的工作区 diff，才能进入验证/测试队列；
- candidate evidence 必须匹配被应用的 candidate；
- 测试队列串行执行并原子持久化 terminal outcome；
- simulation/CPU evidence 不能发布成 live-hardware evidence；
- fixed Profile、形状、dtype、correctness case、benchmark profile、重试预算不是可为“提高通过率”而削弱的参数。

## 3. 证据时间线

下表中的运行 ID 是本机临时工件的逻辑标识；未将认证信息、完整 prompt 或原始秘密复制到仓库。

| 证据 | 观察 | 结论/影响 |
|---|---|---|
| 受限环境历史运行（`VX1Mza` 系列） | stderr 出现 `invalid peer certificate: UnknownIssuer`、WebSocket 重连、回退 HTTPS、等待网络 | 受限网络/TLS 会让 Agent 在没有业务终态的情况下卡住；放行网络后该错误未复现。需保留为环境前置检查项。 |
| 默认 Windows sandbox 探针 | `codex-windows-sandbox-setup.exe` 不存在；`file_change` helper 创建失败 | 不是模型拒绝编辑，而是本机 sandbox helper 缺失。使用 `windows.sandbox="unelevated"` 后可完成直接写文件和结构化 `file_change`。 |
| 纯文本最小探针 | `gpt-5.5`，`codex exec --json`，约 11.8s，`thread.started → turn.started → agent_message(OK) → turn.completed`；输入约 19,044 tokens、输出 5 | CLI、登录和模型基本可用；不支持“模型完全不可用”的判断。 |
| workspace-write + 用户配置 | 约 93.9s；输入约 100,966 tokens（缓存约 81,792）；首次 `file_change` helper 失败，随后 PowerShell 写文件成功并正常 `turn.completed` | 配置/系统上下文显著放大首轮延迟；helper 错误可由 unelevated fallback 绕过，但不能忽略其诊断意义。 |
| workspace-write + `unelevated`、保留配置 | 约 77.5s；输入约 101,262 tokens（缓存约 79,744）；`file_change`、验证、`turn.completed` 均成功 | `unelevated` 是当前 Windows MVP 的可行 fallback，但大上下文仍然存在。 |
| `--ephemeral --ignore-user-config` 最小单文件探针 | 输入约 30,096 tokens（缓存约 16,128），完成 `file_change → 验证 → turn.completed`，无 stderr | 强证据表明用户/项目 Codex 配置及其附带上下文是主要延迟放大器之一；并不等于已证明它是所有卡住的唯一根因。 |
| `CFwMC7` | Agent 返回了顶层 unified patch，但 `git apply --check` 报 `corrupt patch at line 20/42`，随后 `CODEX_CANDIDATE_DIFF_EMPTY` | 以前的 patch hunk 行数不规范；已在工作区应用路径加入 `--recount`，并用临时 Git 仓库验证修复。 |
| `5j3sBk` | 只有 `thread.started`、`turn.started`，没有 `item`、`agent_message`、`turn.completed` | 间歇性“无事件终态”仍未根除；需要区分 provider 仍生成、stream reader 丢事件、Code Mode host 阻塞还是 watchdog 过早取消。 |
| `tX5uzO` | Agent 实际修改了 `run.py` 并返回结构化候选；逻辑任务已完成，但进程树/资源释放确认失败 | logical completion、candidate admission、process release 不能合并为一个状态。 |
| `Z2tloZ`（`9c7d946` 后最新真实 E2E） | 首轮 `codex_MTUUUUJA_345DC9BF`：`completed`、logical complete；候选队列 `queue_4F6CD35A12034C46`；correctness `4/4`；benchmark：`primary 176.8 us`、`compact 43.6 us`；digest `sha256:26e395d41cc07ee198bbd202571e2056df0778500fc514af34fc9086dd8069cd`；baseline oracle 匹配，应用后 diff 非空 | 证明真实首轮闭环可达。同期后续 run `codex_MTUUWJOX_72B05DB6` 只有 `thread.started/turn.started` 后进入 `cancel_requested`，所以不能据此宣布全流程稳定。 |

## 4. 已确认问题、已修复问题与未解决问题

### 4.1 已确认且已有缓解

1. **Windows sandbox helper 缺失**

   默认隔离路径依赖本机 `codex-windows-sandbox-setup.exe`，当前安装未提供该程序。客户端现在默认使用 `windows.sandbox="unelevated"` fallback；该模式下结构化编辑和验证探针均能成功。它降低隔离强度，必须继续在产品风险说明中保留。

2. **用户/项目配置造成上下文膨胀**

   同一类单文件探针的输入量从约 30k（`--ignore-user-config`）增加到约 100k（加载配置），首轮延迟也明显增加。当前客户端默认 `--ignore-user-config`，可用 `OPERATOR_CODEX_IGNORE_USER_CONFIG=0` 做 A/B 实验。

3. **统一补丁 hunk 计数不可靠**

   Workspace Manager 现在先执行 `git apply --recount --check --binary`，通过后再应用；空补丁、绝对路径、越界路径和非仓库路径仍会被拒绝。

4. **候选没有本地 diff 时的 fallback**

   Agent result 现在识别顶层 `patch`/`unifiedDiff`，由 Workspace Manager 安全应用后重新抓取 diff；这不绕过候选准入。

5. **候选 benchmark 调度时序**

   候选 benchmark 不再在候选任务完成前暂停 Mission；只有 task 和 benchmark 都进入 terminal 后才暂停，避免误把调度状态当作候选失败。

6. **Windows 子进程完成后的清理窗口**

   已扩大 grace/force/logical cleanup 窗口，并将“逻辑完成”和“进程树释放”分开记录。`turn.completed` 仍不等于进程已经释放。

### 4.2 仍未解决或未证实

- **无终态事件**：部分运行停在 `turn.started`，还没有足够证据判断是 provider/网络、CLI stream reader、Code Mode host、工具协商还是任务复杂度。
- **后续迭代的取消与资源释放**：仍可能出现 `CODEX_PROCESS_TREE_UNVERIFIED` 或 `CODEX_CANCEL_UNCONFIRMED`。在释放证据不完整时，不能自动复用同一 workspace 或把运行标为完全成功。
- **工具能力协商/空候选**：历史运行出现 `candidates: []` 或“没有结构化编辑工具”的 Agent 反馈；需要记录 CLI 实际暴露的工具集合，不能只看最终文本。
- **上下文上限与复杂度阈值**：已看到 30k/100k 的显著差异，但尚未有 3/6/10 万 token、同 prompt、多次重复的 p95/p99 数据。
- **容量/账号瞬时影响**：目前没有 429 或 capacity 日志，不能排除短时影响，但也不能据此归因。
- **E2E 失败证据持久化**：`E2E_KEEP_ARTIFACTS=1` 才保留临时目录；默认 finally 会清理，外部专家应显式开启。

## 5. 目前不能支持的结论

- 不能说“`gpt-5.5` 能力不足”。它已通过纯文本、最小编辑和真实首轮生成/验证/benchmark。
- 不能说“服务 at capacity”。当前没有 `429`、`rate_limit`、`overloaded` 或明确容量字段。
- 不能说“CPU/GPU 测试队列导致 Agent 卡住”。最新首轮在候选进入队列后正常完成；当前异常发生在 Agent 事件/进程生命周期层。
- 不能把 fixture、mock 或仅有 CPU queue 通过当成真实 provider 的稳定性证明。
- 不能把 `turn.completed` 单独当作进程释放、候选准入或 workflow terminal 的证明。

## 6. 给外部专家的核心问题

请对每个问题给出“已确认 / 高概率 / 待验证”的置信度、最小复现、建议参数、代码边界和回滚方案：

1. 没有 `turn.completed` 时，服务端仍在生成、Code Mode host 阻塞、CLI stream reader 丢事件，还是本地 watchdog 取消？如何用最小探针区分？
2. `candidates: []` 是模型主动返回空结果、工具不可用、adapter 丢失 `file_change`，还是 prompt schema 不符合？
3. 约 30k 与 100k token 的 p95/p99 首事件、首工具调用、`file_change`、`turn.completed` 阈值是多少？应如何裁剪 context 而不删除冻结的 correctness/profile 语义？
4. `gpt-5.5` 与 `gpt-5.6-sol` 在当前 CLI/Code Mode 组合中的工具支持、空候选率和终态稳定性是否不同？是否需要 pin CLI/model 版本？
5. Windows `unelevated` 是否改变工具事件、文件写入或进程树语义？推荐的 sandbox 与 Job Object 配置是什么？
6. 哪一种 terminal/cancel/retry 策略能避免重复写入、重复测试或错误地进入 `needs_human`？
7. 真实闭环 SLO 应如何定义？建议至少包含候选成功率、空候选率、首事件 p95、`turn.completed` p95、stuck rate、process-release-confirmed rate、queue completion rate。
8. 哪些 request/thread/run ID 和脱敏日志可以交给服务端支持团队查询容量、限流或断流？

## 7. 可直接执行的最小复现实验

以下命令中的 `<repo>`、`<temp-workspace>` 由专家替换；不要把 token、cookie、完整环境变量或个人配置上传。

### 7.1 登录与纯文本探针

```powershell
codex login status
codex exec --model gpt-5.5 --sandbox read-only --cd <repo> --json -
# stdin: Return exactly OK.
```

期望事件至少为：`thread.started`、`turn.started`、`agent_message`、`turn.completed`，并以退出码 0 结束。

### 7.2 单文件编辑探针（推荐先做）

在临时 Git 仓库中运行，固定一个变量一次只比较一项：

```powershell
codex exec --ephemeral --ignore-user-config `
  --model gpt-5.5 `
  --sandbox workspace-write `
  -c 'windows.sandbox="unelevated"' `
  --cd <temp-workspace> --json -
# stdin: Read README.md, create probe-write.txt containing exactly OK, verify it,
# then return JSON {"status":"passed"}.
```

保留 stdout 的完整 JSONL、stderr、退出码、首事件/每个 item/终态时间。用 `--ignore-user-config` 与不使用该参数各重复至少 5 次。

### 7.3 真实 Agent 闭环

```powershell
$env:E2E_AGENT_RUNTIME='codex-cli'
$env:E2E_KEEP_ARTIFACTS='1'
$env:OPERATOR_CODEX_MODEL='gpt-5.5'
$env:OPERATOR_CODEX_IGNORE_USER_CONFIG='1'
$env:OPERATOR_MAIN_AGENT_BUDGET_MS='180000'
$env:E2E_AGENT_TIMEOUT_MS='300000'
npm run e2e:cpu-agent-iteration
```

每次记录 `missionId`、`firstRunId`、`continuedRunId`、candidate task id、候选 digest、queue terminal、`liveHardware`，并保留 `%TEMP%/operator-studio-cpu-agent-e2e-*` 中的 runtime/data、Codex JSONL、stderr 和状态快照。不要将原始临时目录直接公开；先脱敏。

## 8. 统一事件与终态判定

建议专家把每次运行规范化为以下时间线，每个事件同时记录 wall-clock、monotonic 时间、run/thread/turn ID、模型、provider、sandbox、context token estimate 和脱敏 payload hash：

```text
run.created
  -> thread.started
  -> turn.started
  -> item.started / item.completed (file_change, command, agent_message, ...)
  -> turn.completed OR error
  -> process_exit / process_release_confirmed
  -> candidate_admitted
  -> queue.task_terminal
  -> evidence.persisted
```

必须分开判断三个层次：

1. **Logical completion**：收到 `turn.completed` 或明确 provider error；
2. **Resource release**：子进程关闭、进程树/Job Object 释放证据完整；否则保留 `CODEX_PROCESS_TREE_UNVERIFIED`；
3. **Workflow settlement**：候选验证通过、测试队列 terminal、证据摘要与 applied candidate 匹配。

任何一层失败都不能由另一层的成功覆盖。取消请求也必须持久化为状态转换，而不是简单删除运行记录。

## 9. 实验矩阵（建议至少同参重复 10 次，最好 20 次）

| CASE | 只改变的变量 | 主要指标 | 通过条件 |
|---|---|---|---|
| `CASE_01_TEXT` | 纯文本；模型/网络固定 | 首事件、`turn.completed`、退出码 | 10/10 有完整终态 |
| `CASE_02_EDIT_NO_CONFIG` | `--ignore-user-config` + unelevated | `file_change`、写入校验、耗时、输入 token | 10/10 写入且完整终态 |
| `CASE_03_EDIT_CONFIG` | 仅移除 `--ignore-user-config` | 同上，记录 context token | 与 CASE_02 对比 p95/p99，不允许静默卡住 |
| `CASE_04_PATCH` | 正常 hunk、错误 hunk、空 patch、越界路径 | `git apply` 结果、候选拒绝码 | 非法 patch 全部拒绝且不污染 workspace |
| `CASE_05_REAL_E2E` | 完整 prompt + local-c500 | 候选成功率、correctness、benchmark、digest | 连续 10（目标 20）次全链路 terminal |
| `CASE_06_CANCEL_RELEASE` | 单轮/后续轮、不同 cleanup 窗口 | cancel latency、子进程、workspace 锁 | 无重复写入；release confirmed 或明确人工接管 |
| `CASE_07_NETWORK` | 正常网络/受限网络 | TLS、重连、HTTP 状态、首事件 | 网络失败有明确 terminal reason，不得无限等待 |
| `CASE_08_MODEL` | `gpt-5.5` vs `gpt-5.6-sol` | 工具调用、空候选率、p95 | 只比较稳定性，不改变 fixed profile 语义 |

建议先用原生 `codex exec --json` 最小探针，再用生产脚本同参，最后用 fixture/mock；三层结果必须分开报表。

## 10. 当前代码改动索引

本报告对应的关键提交为 `9c7d946`，其前置修复包括 `1b550ef`、`46bda66`。主要文件和职责：

- `client-runtime/codex-client.mjs`：`--ignore-user-config` 默认策略、Windows unelevated fallback、进程清理窗口和结构化工具边界；
- `client-runtime/workspace-manager.mjs`：安全 workspace 路径校验、`git apply --recount --check --binary`、应用后重新抓取 diff；
- `client-runtime/agent-result.mjs`：识别顶层 `patch`/`unifiedDiff`；
- `client-runtime/agent-runtime.mjs`：无工作区 diff 时安全应用候选 patch，再进行候选准入；
- `scripts/eval-candidate-generation.mjs`：候选任务和 benchmark terminal 后才暂停 Mission；
- `scripts/e2e-cpu-agent-iteration.mjs`：真实 Agent + local CPU 的手动验收入口，`E2E_KEEP_ARTIFACTS=1` 保留证据；
- `client-runtime/codex-client.md`：明确 `turn.completed` 不等于进程释放，以及 `CODEX_PROCESS_TREE_UNVERIFIED` 等契约错误。

本地回归命令：

```powershell
npm run test:codex
npm run test:codex-cancellation
npm run test:workspace
npm run e2e:cpu-agent-iteration
npm run verify:local-c500-release
npm run verify:non-hardware-robustness
```

已知与 Codex 根因无关的环境噪声：一次 `verify:non-hardware-robustness` 的最终 `test:release` 因 `CLI guard test server did not start` 失败；同一轮的 `verify:local-c500-release`（126 checks）及本地 CPU/runtime 检查通过。外部专家不要把该 guard 失败直接归因于 Agent 模型或候选逻辑。

## 11. 建议的下一步优先级

### P0：先把失败变成可判定的 terminal

1. 保留 `--ignore-user-config`、unelevated fallback 和完整 JSONL/stderr；启动前做登录、网络/TLS、sandbox helper、可写 workspace、Job Object 能力预检。
2. 为“无 `turn.completed`”设置分层 watchdog：首事件超时、首工具超时、turn 超时；每层输出诊断快照和 provider/run ID，禁止无限等待。
3. 把 logical completion、process release、workflow settlement 三个状态持久化；在 release 未确认时禁止复用 workspace、自动重试或宣称闭环成功。
4. 对自动 tick、显式 run、后续 round 做幂等键和写入计数验证，证明不会重复应用同一候选。

### P1：降低变量并提高可观测性

1. 记录实际 prompt 字节数、估算 token、配置来源、CLI/model/provider/sandbox 版本；对 baseline、experience、fixed profile 做紧凑投影和去重，但不能删除冻结语义。
2. 加一个生产前置的“单文件真实 file_change smoke”，通过后再发送完整候选任务；工具集合不符合预期时立即产生明确 terminal reason。
3. 为 `candidates: []` 分类：模型空结果、工具不可用、adapter 解析丢失、patch 校验拒绝；每类单独计数。
4. 统一保存脱敏状态快照、完整事件、git diff 摘要、候选 digest、queue terminal 和错误码。

### P2：扩大兼容性实验

1. 对 gpt-5.5 与 gpt-5.6-sol 做同参矩阵，先比较稳定性和工具事件，再决定默认模型；不要把模型切换当作未经验证的修复。
2. 在 WSL2/Linux 复现同一套最小探针，比较 sandbox、进程树和 TLS 行为；这属于兼容性实验，不应替代 Windows 回归。
3. 把 fixture/mock、local CPU、未来 GPU/cloud queue 的指标分开，避免硬件性能噪声掩盖 Agent 控制面问题。

## 12. 验收建议与循环状态

当前循环状态应标记为：

```text
REAL_AGENT_FIRST_ROUND: PASS (已出现一次完整样本)
REAL_AGENT_STABILITY: NOT_PROVEN
NO_EVENT_STALL: OPEN
PROCESS_RELEASE_AFTER_CANCEL: OPEN
PATCH_ADMISSION_REGRESSION: MITIGATED (需重复回归)
```

建议的放量门槛是同一提交、同一模型、同一 prompt/profile、同一后端连续 **N=20** 次（最低 N=10）满足：

- 候选生成、应用、校验、correctness、benchmark、evidence、queue terminal 全部完成；
- 无 `CODEX_CANCEL_UNCONFIRMED`、`CODEX_PROCESS_TREE_UNVERIFIED`、无终态超时；
- 无重复写入、无 candidate/evidence digest 不匹配；
- 报告首事件、`file_change`、`turn.completed`、process release、queue terminal 的 p95/p99；
- 任何失败都有可复现的 terminal reason 和保留的脱敏工件。

在达到该门槛前，对外应使用“首轮路径已打通，稳定性仍在验证”这一表述。

## 13. 证据与敏感信息处理

- 运行时临时目录默认位于 `%TEMP%/operator-studio-cpu-agent-e2e-*`；只有设置 `E2E_KEEP_ARTIFACTS=1` 才应保留。
- 对外共享前删除 token、cookie、认证 header、完整用户配置、绝对用户名路径和未脱敏 prompt；保留事件类型、时间、错误码、run/thread/turn ID、payload hash 和必要的统计量。
- 不要把未审查的 Codex JSONL、stderr 或 `.env` 提交到 GitHub。
- 本报告本身不包含凭据；临时 artifact ID 仅用于在本机定位证据。
