# Codex Agent 真实闭环问题诊断交接

> 供外部专家复核当前“Agent 生成候选 → 应用到 Mission Workspace → 校验 → 测试队列 → 经验沉淀”链路。
> 本文只记录已经采集到的证据和可复现实验，不把一次成功运行描述为稳定性结论。

## 0. 给没有项目背景的专家：产品与问题是什么

### 0.1 产品目标

Operator Studio 是一个面向算子工程师的迭代工作台。长期目标是把“算子代码、依赖、测试后端和经验”解耦：工程师可以在不同平台提交同一份算子执行包，选择本地 CPU/GPU 或云端队列运行，节省本机硬件；系统把经过验证的执行观察和人工指导沉淀成下一轮 Agent 可读取的经验。

当前 MVP 还没有云端服务，测试后端被抽象为异步工具/队列端口：现在接本地 CPU runner，未来可以接本地 GPU 或云端 GPU。Profiler/Tracer 暂不作为本次问题的根因，当前只关心“Agent 能否稳定产生可验证候选”和“测试队列能否给出明确终态”。

### 0.2 本次要诊断的闭环

```text
Mission 目标/语义/固定 Profile/基线 oracle/经验
        │
        ▼
03 Candidate Generation：渲染 Prompt，Agent 在活动 Workspace 生成候选
        │
        ▼
Workspace Diff 准入：真实非空 diff、文件/语言契约、重复 digest 检查
        │
        ▼
Operator Test Tool → 串行 Operator Test Queue → local CPU runner
        │                         │
        │                         ├─ correctness（独立 Baseline oracle）
        │                         └─ benchmark（固定 profile）
        ▼
Evidence Projection / Accept Gate / round outcome / 下一轮或人工介入
```

问题不是“能否手动运行一个 Python 文件”，而是上图每一步能否在失败、取消、网络断开、进程滞后时仍然收敛到**可解释且不可误报的有限终态**。尤其要区分：

- Agent 的 provider 逻辑完成；
- Codex 子进程及其子树已经释放；
- 候选已被 Workspace 准入；
- 测试任务已完成并绑定正确的 candidate digest；
- Mission round 已结算。

### 0.3 关键术语

| 术语 | 在本项目中的含义 |
|---|---|
| Mission | 一次有目标、预算、Profile、Baseline 和多轮迭代记录的任务；不是单次 HTTP 请求。 |
| Round | Mission 的一次 Agent 候选尝试及其测试/决策结算。 |
| Active Mission Workspace | 当前 Round 唯一允许 Agent 写入的隔离 Git 工作区。 |
| Baseline / oracle | 已冻结的参考实现和独立 `reference(inputs)`；Candidate 不能修改它来“证明自己正确”。 |
| Candidate | 从真实 Workspace Diff 生成的候选身份；Agent 自报的 JSON/patch 不是准入事实。 |
| Profile / testSpec | 固定的 shape、dtype、correctness case、benchmark profile、warmup/repeats 和重试语义。 |
| Queue task | 绑定 candidate digest、oracle、矩阵和执行包的异步测试请求；状态由 Queue 原子持久化。 |
| Evidence | 测试结果投影；CPU/simulation evidence 永远不是可发布的 live-hardware evidence。 |
| Experience | 人工指导或已验证执行观察的版本化、不可信上下文；不能覆盖冻结语义、oracle 或 Gate。 |

### 0.4 03 模块的边界

03 模块（`client-runtime/candidate-generation/`）只负责：

1. 把冻结的 Mission、semantic snapshot、Profile/testSpec、Workspace inventory、Baseline 和 experience 渲染成 Agent Prompt；
2. 依据真实 Workspace Diff 检查文件清单、语言契约、非空性和重复 digest；
3. 分配稳定 candidate identity。

它**不**启动/取消 Codex、不读写文件、不提交 Queue、不执行 correctness/benchmark、不做 Accept Gate、不决定 adopt/rollback/下一轮。这样外部专家应把“Prompt/候选准入问题”和“provider/进程/Queue 生命周期问题”分开分析。

### 0.5 本次真实 E2E 的固定输入

为了让实验可重复，`scripts/e2e-cpu-agent-iteration.mjs` 使用一个最小的 `fused_affine_relu` Python 算子：

- `run.py` 暴露 `get_inputs()`、`get_test_cases()`、`get_benchmark_inputs()`、`reference(inputs)`、`run(inputs)`；
- Agent 被要求只优化 `run(inputs)`，不得修改输入工厂、测试 case、benchmark profile 或 oracle；
- correctness 固定 4 个命名 case：`mixed`、`relu-boundary`、`positive`、`all-clamped`；
- benchmark 固定 `primary`、`compact` 两个 profile，warmup=2、repeats=15；
- 执行环境是 `CPU`、`source=cpu-e2e`、`liveHardware=false`；
- 目标刻意设置为几乎不可能达到的 `targetRelativeImprovement=0.999999`，目的是稳定触发“首轮结束后启动下一轮”的控制流，而不是评测优化算法；
- Agent 任务要求“立即读取 `run.py`，产生有界真实单文件 Diff，不要自行运行 benchmark，不要只返回分析”。

所以，某次 E2E 失败时，首先要问的是“Agent/CLI 是否产生了可准入的候选及明确终态”，而不是“CPU latency 是否足够快”。

### 0.6 代码导览（专家可按此进入源码）

| 路径 | 读它是为了回答什么问题 |
|---|---|
| `client-runtime/candidate-generation/README.md`、`CONSTRAINTS.md` | 03 输入/输出、候选准入和 deterministic round 顺序是什么？ |
| `client-runtime/agent-runtime.mjs`、`agent-runtime.md` | Agent 启动、超时、取消、logical completion 与 release barrier 如何投影？ |
| `client-runtime/codex-client.mjs`、`codex-client.md` | Codex CLI 参数、JSONL 事件读取、Windows 清理和错误码如何实现？ |
| `client-runtime/workspace-manager.mjs` | 如何从真实 Git Workspace 捕获 diff、应用 fallback patch、拒绝越界路径？ |
| `client-runtime/operator-test-queue.mjs`、`operator-test-queue.md` | Queue 如何串行化、持久化、取消和处理不确定占用？ |
| `client-runtime/operator-test-evidence.mjs` | Queue snapshot 如何绑定 candidate/oracle 并投影到 Mission？ |
| `client-runtime/experience-contract.mjs`、`round-experience-service.mjs` | 人工/上一轮经验如何冻结并注入，为什么不能覆盖语义和 Gate？ |
| `scripts/e2e-cpu-agent-iteration.mjs` | 本报告所有真实 Agent 样本的最小复现入口和断言是什么？ |

外部专家不需要先理解 TUI；生产调用方向是 `TUI → HTTP API → application orchestration → domain/ports → Agent/Workspace/Queue`，HTTP route 不应复制工作流规则。

## 1. 当前结论（先读这一节）

截至 `2026-09-10`，代码修复基线为 `9c7d946`；诊断文档已在 `4d8e32c` 推送，本文本次补充的是同一代码基线上的新失败样本与专家上下文：

- **真实链路已经可达**：一次使用本机 Codex CLI、`gpt-5.5`、`workspace-write` 的完整首轮候选生成成功，候选被应用、4 个 correctness case 通过、两个 benchmark profile 完成，证据摘要与持久化基线一致。
- **正常网络对照又证明了一次恢复能力**：`3zyDlz` 的第一次 provider attempt 明确返回 capacity，自动恢复 attempt 成功完成候选和 Queue；但现有 E2E 入口把恢复 attempt 误归到初始 run，产生了 false negative，说明“业务状态正确”与“验收观测正确”都需要单独验收。
- **尚不能称为稳定闭环**：同一次 E2E 中启动的后续迭代在 `turn.started` 后进入 `cancel_requested`，资源释放证据未确认（`CODEX_PROCESS_TREE_UNVERIFIED`/`CODEX_CANCEL_UNCONFIRMED`）。历史运行还出现过只有 `thread.started/turn.started`、没有终态事件的情况。
- **最有力的已确认诱因不是模型能力不足**：Windows sandbox helper 缺失、受限网络下 TLS `UnknownIssuer`、用户/项目配置带来的超大上下文、错误 unified patch，以及 Windows 子进程退出/清理时序都被实际观察到。`gpt-5.5` 在最小探针和真实首轮中都能正确理解任务并写入工作区。
- **已经观察到一次明确的容量终态，但它只解释该次尝试**：正常网络对照的第一次 run 收到 `Selected model is at capacity` 和 `turn.failed`；同一 Mission 的自动恢复 run 随后成功生成候选并完成 CPU 测试。因此容量是已确认的瞬时失败类别，不足以解释 TLS、无事件停滞或资源释放未确认等其他样本。
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
| 代码修复基线 | `9c7d946`（与 `origin/main` 对齐；后续仅更新本诊断文档） |

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
| `n4UJ4n`（本次继续回归，2026-09-10） | run `codex_MTUX5QHR_0F68FB4B`、Mission `MIS_MTUX5JFH`；事件共 13 个：`thread.started`、`turn.started`、多次 `error`，错误均为 `invalid peer certificate: UnknownIssuer` / `Connection failed: error sending request`，没有 `file_change`、候选或 `turn.completed`；最终 `status=cancel_requested`、`resourceRelease.code=CODEX_CANCEL_UNCONFIRMED`，E2E 断言 `no completed candidate CPU task was observed` 失败 | 本次是明确的网络/TLS/流式连接失败样本，不应标记为模型理解失败或 CPU correctness 失败。临时工件目录由 `E2E_KEEP_ARTIFACTS=1` 保留。 |
| `3zyDlz`（本次正常网络对照，2026-09-10） | 第一次 run `codex_MTUYOLKO_EC78B991` 在已有 `agent_message` 后收到 `Selected model is at capacity`，5 个事件后 `turn.failed`；运行时自动恢复为 `codex_MTUYPJ8S_CB10DC61`，10 个事件、`turn.completed`、release confirmed。恢复 run 通过 Workspace patch fallback，候选任务 `queue_085B2134FA9C480B` 完成，correctness `4/4`，benchmark `primary 208 us` / `compact 55.3 us`，最终 `decisionReview=reference` | 明确证明一次瞬时容量失败可以被同轮恢复路径吸收；但 E2E 脚本仍以最初 `firstRunId` 关联 round，在恢复 run 已结算而初始 run 无 outcome 时于 line 230 误报 `impossible target unexpectedly resolved as undefined`。这是验收 harness 的 run attribution/race 问题，不应误报为候选或 Queue 失败。 |

### 3.1 最新失败样本的逐事件解释

`n4UJ4n` 的脱敏事件顺序如下：

```text
thread.started
turn.started
error: Reconnecting 2/5 (stream disconnected before completion: invalid peer certificate: UnknownIssuer)
error: Reconnecting 3/5 (same)
error: Reconnecting 4/5 (same)
error: Reconnecting 5/5 (same)
item.completed: error
error: Reconnecting... waiting for network (Connection failed: error sending request) × 6
-- watchdog/cancel path --
status=cancel_requested
resourceRelease=CODEX_CANCEL_UNCONFIRMED
E2E assertion: no completed candidate CPU task was observed
```

这次运行没有进入 Workspace Diff、Candidate Admission 或 Queue；因此“no completed candidate CPU task”是上层验收断言，不是候选代码错误。专家复核时应先检查：

1. 执行环境的 CA 证书链、代理和 WebSocket/HTTPS 出站策略；
2. CLI 在 stream 断开时是否把可重试网络错误、最终 provider error 和本地取消正确区分；
3. 在 provider 已经无法连接后，watchdog 是否仍等待到有限且可解释的 release terminal；
4. 重试次数、退避和总 round budget 是否会导致重复运行或错误占用 Workspace。

本次工件（仅本机，不应原样上传）可从以下相对结构定位：

```text
<temp>/operator-studio-cpu-agent-e2e-n4UJ4n/
  runtime/agent-bridge/codex-runs/codex_MTUX5QHR_0F68FB4B.json
  runtime/agent-bridge/codex-runs/codex_MTUX5QHR_0F68FB4B.jsonl
  runtime/operator-test-queue.jsonl
  runtime/command-journal.jsonl
  data/mock-db.json
  project/repository/run.py
  cpu-tasks/<task-id>/runner.stderr.log
```

专家需要的最小附件是 `.json`（最终状态）、`.jsonl`（完整 Codex 事件）、runtime queue/journal 快照和 E2E stdout/stderr；`project/repository` 与 `cpu-tasks` 用于证明本次没有候选/测试产物，不需要上传整棵目录。

### 3.2 成功与失败状态的判定对照

| 层次 | 成功样本 `Z2tloZ` | 最新失败 `n4UJ4n` | 外部专家应避免的误判 |
|---|---|---|---|
| Provider/CLI | 有 `agent_message`、`file_change`、`turn.completed` | 只有连接错误，无 `turn.completed` | 把 `needs_human` 当作模型拒绝任务 |
| Workspace | 真实 diff 非空，candidate digest 可计算 | 没有 diff | 认为“空 diff”是 Agent 生成了空算子 |
| Queue | 4/4 correctness、2 benchmark profile terminal | 没有 candidate task 可执行 | 认为 CPU runner 让任务失败 |
| Mission | 首轮 outcome `reference/reject` 后启动下一轮 | 资源释放未确认，流程必须停止 | 为追求自动化而绕过 release barrier |

### 3.3 正常网络对照揭示的两个新问题

`3zyDlz` 与 `n4UJ4n` 使用同一代码、同一 `gpt-5.5`、同一 Prompt 和同一 `OPERATOR_CODEX_IGNORE_USER_CONFIG=1` 参数；只改变网络权限后，失败类别发生了变化：

1. **容量错误是真实但可恢复的 provider 失败**：`codex_MTUYOLKO_EC78B991` 明确返回 `Selected model is at capacity`，不是静默卡住。运行时随后启动同轮恢复 `codex_MTUYPJ8S_CB10DC61`，成功返回结构化结果/patch，Workspace 应用 patch，Queue 完成 4/4 correctness 和两个 benchmark。说明“at capacity”需要被分类为可重试的 provider terminal，而不是与模型理解失败混为一谈。
2. **验收脚本错误地把初始 run 当作候选 run**：初始 run 因容量失败，恢复 run 才产生实际 candidate。`e2e-cpu-agent-iteration.mjs` 的 `firstRunId` 仍指向初始 run，后续断言从该 run 的 `runHistory` 查 `decisionReview.resolution.outcome`，得到 `undefined`，于是脚本失败；最终持久化状态实际为 `stage=evidence`、`decisionReview.status=resolved`、`resolution.outcome=reference`、candidate Queue `completed`。这暴露了一个必须修复的测试/观测契约：候选必须绑定**实际产生 diff 的 sourceRunId**，不能只绑定“第一次启动的 run”。

因此，专家分析时请把 `3zyDlz` 拆成三个结果：

```text
provider attempt #1: failed / capacity (可重试)
provider recovery #2: completed / release confirmed
workflow+queue: candidate admitted, 4/4, benchmark complete, decision=reference
harness assertion: false negative due to run attribution race
```

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
- **Codex 尚未接入 Windows Job Object**：当前 Codex 取消仍使用 `taskkill /pid /t`；`client-runtime/windows-job-object.mjs` 只接入 local-c500 runner supervisor。直接复用现有 helper 会丢失 Codex 实时 JSONL，因此不是一个可安全机械替换的小修复。现有逻辑在无法证明子树释放时保持 fail-closed，宁可隔离 Workspace，也不根据 PID 猜测“已经结束”。
- **工具能力协商/空候选**：历史运行出现 `candidates: []` 或“没有结构化编辑工具”的 Agent 反馈；需要记录 CLI 实际暴露的工具集合，不能只看最终文本。
- **上下文上限与复杂度阈值**：已看到 30k/100k 的显著差异，但尚未有 3/6/10 万 token、同 prompt、多次重复的 p95/p99 数据。
- **容量/账号瞬时影响**：`3zyDlz` 已出现明确的 `Selected model is at capacity`；它在同轮恢复后成功，说明需要单独的 capacity 分类、退避和次数指标。尚不能用这一个样本解释其他 TLS/无事件/释放问题。
- **E2E run attribution/race**：恢复 run 产生候选时，验收脚本仍按最初 `firstRunId` 查 round outcome，导致真实 workflow 已结算却在 line 230 报 `undefined`。这属于测试入口/观测契约缺陷，应修复为按 candidate 的 `sourceRunId` 或已结算 round identity 关联。
- **E2E 失败证据持久化**：`E2E_KEEP_ARTIFACTS=1` 才保留临时目录；默认 finally 会清理，外部专家应显式开启。

## 5. 目前不能支持的结论

- 不能说“`gpt-5.5` 能力不足”。它已通过纯文本、最小编辑和真实首轮生成/验证/benchmark。
- 不能说“所有失败都是服务 at capacity”。`3zyDlz` 确实记录了一次明确的 `Selected model is at capacity`，但 `n4UJ4n` 是 TLS `UnknownIssuer`，其他样本是无事件或释放未确认；这些类别必须分开统计。
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
9. `3zyDlz` 的 capacity 失败由同轮恢复吸收，但验收脚本仍误报；应以哪个稳定 identity（candidate sourceRunId、roundId、requestId）关联重试，才能既不漏报也不重复测试？
10. `file_change` 失败后由顶层 unified patch fallback 成功，是否应把“工具失败但 patch fallback 成功”作为可观测的 degraded-success，而不是静默成功？

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

注意：如果首个 provider attempt 因 capacity/TLS 失败而由同轮 recovery run 生成候选，不能只用脚本打印的 `firstRunId` 查 outcome。应同时读取 candidate 的 `sourceRunId`、roundId、Queue requestId 和 `runHistory`，否则可能出现“状态已 `decisionReview=reference`、Queue 已 completed，但脚本断言 outcome=undefined”的假失败。

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
| `CASE_09_CAPACITY_RETRY` | 注入/等待真实 `Selected model is at capacity` | 初次 attempt、恢复 attempt、退避、总预算、重复写入 | capacity 只按策略有限重试；成功后候选/Queue 只执行一次 |
| `CASE_10_RUN_ATTRIBUTION` | 首次 run 失败、同轮恢复 run 生成候选 | sourceRunId、roundId、candidate digest、decision outcome | 验收按实际候选 run 结算，不因初始失败误报 `undefined` |

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

尚未合入的建议修复：E2E 入口应把 `firstRunId` 与 `candidate.sourceRunId` 分开保存，在同轮 capacity/TLS recovery 后等待实际 candidate round 的 decision/evidence terminal，再做断言；这属于测试观测修复，不应改变生产 Candidate/Queue/Gate 规则。

本地回归命令：

```powershell
npm run test:codex
npm run test:codex-cancellation
npm run test:windows-job-object
npm run test:workspace
npm run e2e:cpu-agent-iteration
npm run verify:local-c500-release
npm run verify:non-hardware-robustness
```

当前复核中 `test:codex`、`test:codex-cancellation`、`test:workspace` 通过；独立审计还验证了 `test:windows-job-object` 的两个 Win32 子测例通过。这证明已有单元/契约保护工作，但不能替代真实 Codex 同参重复运行。

已知与 Codex 根因无关的环境噪声：一次 `verify:non-hardware-robustness` 的最终 `test:release` 因 `CLI guard test server did not start` 失败；同一轮的 `verify:local-c500-release`（126 checks）及本地 CPU/runtime 检查通过。外部专家不要把该 guard 失败直接归因于 Agent 模型或候选逻辑。

## 11. 建议的下一步优先级

### P0：先把失败变成可判定的 terminal

1. 保留 `--ignore-user-config`、unelevated fallback 和完整 JSONL/stderr；启动前做登录、网络/TLS、sandbox helper、可写 workspace、Job Object 能力预检。
2. 为“无 `turn.completed`”设置分层 watchdog：首事件超时、首工具超时、turn 超时；每层输出诊断快照和 provider/run ID，禁止无限等待。
3. 把 logical completion、process release、workflow settlement 三个状态持久化；在 release 未确认时禁止复用 workspace、自动重试或宣称闭环成功。
4. 对自动 tick、显式 run、后续 round 做幂等键和写入计数验证，证明不会重复应用同一候选。
5. 为 capacity、TLS/network、tool failure、empty candidate 和 model/schema failure 建立独立错误类别；capacity 恢复必须绑定同一 round/candidate identity，不能让验收脚本只看初始 run。

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
LATEST_REPRO: TLS_UNKNOWN_ISSUER -> CANCEL_UNCONFIRMED (n4UJ4n)
CAPACITY_RETRY: OBSERVED_AND_RECOVERED (3zyDlz)
E2E_RUN_ATTRIBUTION: OPEN (恢复 run 导致 harness false negative)
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

## 14. 希望外部专家返回的分析格式

请不要只回复“模型不稳定”或“重试即可”。针对每个根因候选，按下表返回：

| 字段 | 要求 |
|---|---|
| 根因假设 | 明确属于网络/TLS、账号/容量、Codex CLI、Code Mode 工具桥、Prompt/context、Workspace/patch、进程树/Job Object、Queue 或 workflow 竞态中的哪一类。 |
| 置信度 | `confirmed` / `high` / `medium` / `unverified`，并指出支持和反证。 |
| 最小复现 | 给出可复制命令、只改变的变量、重复次数和期望事件序列。 |
| 观测证据 | 指定应读取的 JSONL event、stderr、run/turn ID、状态快照和时间指标；不要只看最终 stdout。 |
| 建议修复边界 | 说明改 Codex CLI 参数、适配器、Agent Runtime、Workspace、Queue 还是外部网络；不得削弱 fixed Profile、oracle、Gate 或 release barrier。 |
| 风险与回滚 | 是否会改变隔离强度、重试幂等、候选身份或证据可信级别；如何一键回滚。 |
| 验收数据 | 至少报告 N=10，目标 N=20 的成功率、empty-candidate/stuck/release-unconfirmed 比例、首事件/终态/release/queue p95/p99。 |

### 专家分析的最小背景问题

请先回答下面五个问题，再提出代码改动：

1. `n4UJ4n` 的 `UnknownIssuer` 是否足以解释没有任何 `file_change`/`turn.completed`？如果是，如何做启动前 TLS/代理预检并给出有限终态？
2. `Z2tloZ` 同参成功而 `n4UJ4n` 失败，如何证明是环境差异而不是随机模型行为？需要哪些 request/thread/turn/provider ID？
3. 在没有 `turn.completed` 时，怎样区分服务端仍在生成、CLI stream reader 断开、Code Mode host 阻塞和本地 watchdog 超时？
4. `CODEX_CANCEL_UNCONFIRMED` 是否应继续保持 fail-closed？如果要引入 Windows Job Object，应如何同时保留实时 JSONL，不误报进程已释放？
5. 如果将上下文从约 100k 缩到约 30k，哪些字段可以摘要/去重，哪些 semantic snapshot、fixed profile、oracle 和 experience provenance 必须逐字或按 digest 保留？

外部专家若不能访问服务端日志，也请明确列出“仅凭现有本地证据无法判定”的部分；这比把未知问题归因于模型能力或容量更有价值。

## 15. 可直接转发给专家的摘要

> 这是一个 Operator Studio MVP，目标是让 Agent 在隔离 Mission Workspace 中生成算子候选，再由固定 Profile、独立 Baseline oracle 和异步测试队列验证；当前使用 Windows 本地 Codex CLI + `gpt-5.5` + local CPU，未来才接 GPU/云端。请分析“真实 Agent → Workspace Diff → Candidate Admission → Queue → Evidence/round”为什么偶发不收敛。
>
> 已确认：Windows sandbox helper 缺失；受限网络样本 `n4UJ4n` 出现 TLS `UnknownIssuer` 并无 `turn.completed`；正常网络样本 `3zyDlz` 的第一次 attempt 明确返回 `Selected model is at capacity`，同轮 recovery 成功生成候选、4/4 correctness、两个 benchmark、`decisionReview=reference`，但 E2E harness 因仍按初始 run 查 outcome 而误报。历史还有 `thread.started/turn.started` 后无终态、进程释放未确认和 patch hunk 错误。`gpt-5.5` 的最小探针与真实首轮均能成功，因此不要先下“模型能力不足”的结论。
>
> 请按“根因假设/置信度/最小复现/证据字段/代码边界/回滚/验收数据”返回意见；严格区分 provider capacity、TLS/network、工具桥、上下文大小、Workspace patch、进程释放、Queue 和验收脚本 run attribution，不要削弱 fixed Profile、独立 oracle、Gate 或 release barrier。目标是同参 N=20（最低 N=10）得到候选成功率、stuck/empty/release-unconfirmed 比例和各阶段 p95/p99。
