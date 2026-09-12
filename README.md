# Operator Studio

Operator Studio 是面向异构算子优化的本地 Agent 工作台。当前生产客户端是 TUI；后续 GUI
将复用同一个 HTTP API、应用编排、工作区、测试队列、Gate 和经验库，不再建立第二套流程。

- 交接分支：`handoff/codex-job-supervisor-p1`；P1 §14.1–§14.5 已验收，基线与原件见
  [P1 轮次反馈闭环验收](docs/development/P1_FEEDBACK_ACCEPTANCE.md)（2026-09-12）。
- Phase 2（`§14.6`）诊断资格 + 版本化统一决策与治理已按劳务任务集成，对应冻结契约
  [Phase 2 证据治理验收](docs/development/P2_EVIDENCE_ACCEPTANCE.md)；**无硬件验收通过：
  release 136 / non-hardware 38，exit 0**。此结果不构成 N=20 或真实发布。当前证据索引见
  [Phase 2 证据归档](docs/development/evidence/p2-evidence-20260912/README.md)，实机观察/台账规则见
  [真实共享 GPU 回归](docs/development/REAL_GPU_REGRESSION.md)；Phase 3（KernelWiki）尚未开始。
- 兼容 TUI 入口 `npm run tester:c500` 是保留的 C500/C550 launcher：`tools/local-c500-tester/launcher.cjs`
  无条件写入 `OPERATOR_TEST_BACKEND=local-c500`，**不能**用它选择当前共享 GPU 后端。
- 当前共享 GPU 真实 E2E 入口（PowerShell；显式选择已验证的 Claude 路径）：
  `$env:E2E_AGENT_RUNTIME='claude-code'; npm run e2e:shared-gpu-agent-iteration`。
- 实际执行后端：本地共享 NVIDIA GPU（`OPERATOR_TEST_BACKEND=local-shared-gpu`，真实本地开发测量、
  `publishable=false`）与 CPU E2E；`C500` / `C550` 是保留的兼容/历史标识，**不是当前唯一目标真机**

## 当前状态

- TUI 已接入生产 HTTP API，不直接修改持久化状态。
- Claude Code 是 TUI 默认 Agent Runtime；Codex CLI 可显式选择。
- Candidate 只允许写入当前 Mission Workspace，并由 Git Diff 和摘要准入。
- Baseline 与 Candidate 通过串行 Operator Test Queue 执行 Correctness 和 Benchmark。
- Accept Gate 自动决定采用、保留参考、拒绝或进入人工处理。
- 未达到目标的已结算轮次会自动回滚并开始下一轮，不需要用户逐轮点击继续。
- 经验查询、草稿生成和经验沉淀已进入生产 workflow；仿真证据不能发布为真机经验。
- P1 轮次反馈闭环（`TEAM_HANDOFF.md` §14 第 1–5 项）已验收：经验回流、轮次事实冻结、
  发送前 prompt/selection 审计和一次真实两轮生产路径。验收基线见
  [P1 反馈闭环验收](docs/development/P1_FEEDBACK_ACCEPTANCE.md)，原件与边界见
  [P1 证据归档](docs/development/evidence/p1-feedback-20260912/README.md)。
- Phase 2 诊断资格与统一决策/治理已集成；**最终 release 136 / non-hardware 38 均通过**，
  485 个代码与测试文件在运行前后 SHA256 一致。真实共享 GPU 结果保留 development 分类，
  无绑定历史经验保持 `unknown`，治理重复执行与 JSON 恢复不重复写入。
  预检失败和精确迁移记录、最终日志及证明范围见
  [Phase 2 证据归档](docs/development/evidence/p2-evidence-20260912/README.md)。
- P1 当时的最终门禁为 release `132 checks` / non-hardware `34 checks`，exit 0（归档日志
  [final-gates.log](docs/development/evidence/p1-feedback-20260912/final-gates.log)）。
  P1 验收对新版 E2E driver 的 observer 做了真实原件只读回放，**未**重跑整段实机；单次真实两轮
  **不构成 N=20 稳定性**。§14 第 6 项现由 Phase 2 无硬件验收覆盖，第 7 项仍待开发；
  第 8 项文档订正已完成。
- CPU 端到端测试会真实执行轻量算子，用于验证无真实 GPU 环境下的完整迭代闭环。

### 硬件与后端命名（兼容/历史身份）

- 当前开发与验收后端是本地共享 NVIDIA GPU（`local-shared-gpu`）和 CPU E2E；两者都产出
  开发证据，不能直接发布为真机证据。
- `C550` 是保留的沐曦兼容/历史目标标识，不再声称是当前唯一目标。共享 GPU 的开发运行
  不得回填或冒充 `C550` 证据。
- 固定 Profile 语义（`client-runtime/fixed-operator-profiles.mjs`）仍以 `C550` 作为保留的
  Profile/设备标识，测试矩阵 `environments` 与旧执行证据沿用该标识；这是兼容身份，不表示
  当前开发或验收运行在 C550 真机上。
- `tester:c500`、`local-c500`、`LOCAL_C500_*`、`OPERATOR_LOCAL_C500_*` 和
  `LOCAL_C500_*` 错误码是稳定的兼容接口，暂不重命名；其中的 `c500` 不表示任务会在
  C500 上执行。
- C500 与 C550 是不同设备，Runner 匹配时不会视为同一后端。旧状态或历史证据中真实的
  `C500` / `C550` 标签必须原样保留；某条记录能否通过当前 Gate，要按它的目标、版本与证据
  资格逐项判定，**不**按标签一概放行或一概拒绝。
- 当前验收没有可发布的 C550 真机证据。P1 真实 GPU 结果来自
  `source=local-shared-gpu` / `publishable=false`；真实执行与发布资格分别判定。

## 系统边界

```mermaid
flowchart LR
  TUI[TUI 当前客户端] --> API[Production HTTP API]
  GUI[GUI 规划中] -.复用同一后端.-> API

  API --> APP[Application Orchestration]
  APP --> DOMAIN[Workflow / Gate / Profile / Knowledge Rules]
  DOMAIN --> PORTS[Ports]

  PORTS --> AGENT[Agent Runtime Adapters]
  PORTS --> WS[Mission Workspace]
  PORTS --> QUEUE[Serialized Operator Test Queue]
  PORTS --> STORE[State / Events / Knowledge]

  AGENT --> CLAUDE[Claude Code]
  AGENT --> CODEX[Codex CLI]
  AGENT --> OPENCODE[OpenCode 实验适配器]

  QUEUE --> GPU[本地共享 NVIDIA GPU Runner]
  QUEUE --> CPU[CPU E2E Runner]
  QUEUE --> C550[C500 / C550 兼容/历史适配器]
  QUEUE --> MOCK[Mock / Reference Fixture]
```

依赖方向固定为：

```text
TUI / future GUI
  -> HTTP API
  -> application orchestration
  -> domain rules
  -> ports
  -> adapters
```

Domain 不得依赖 TUI、HTTP、Claude、Codex、硬件适配器或文件系统实现。HTTP Route 不得复制
workflow、Gate、Profile 或硬件规则。

## 生产 Workflow

```text
创建/选择 Project
-> 创建 Mission 并冻结目标、shape、dtype、指标和测试矩阵
-> 解析或生成 Baseline
-> 在同一执行后端实测 Baseline
-> 查询与当前任务相关的经验
-> Agent 在隔离 Mission Workspace 生成 Candidate
-> Git Diff、文件范围和 Candidate 摘要准入
-> 串行提交 Correctness
-> Correctness 通过后执行 Benchmark
-> Accept Gate 对比 Baseline、目标和证据来源
   -> 达标：采用 Candidate -> 更新仓库 -> 生成经验草稿 -> 经验治理
   -> 未达标：保留弱候选证据或生成失败记录 -> 恢复稳定工作区 -> 自动进入下一轮
   -> 基础设施或契约失败：按统一错误契约重试、停止或请求人工处理
```

Baseline oracle 会独立持久化。Candidate 测试必须使用该 oracle 的 correctness cases 和
benchmark profiles，不能用 Candidate 自己提供的 `reference()` 或输入替换验收标准。

## 经验生命周期

经验不是 Agent 的自由文本缓存，而是受 evidence 和 Gate 约束的资产：

1. **查询经验**：目标解析、瓶颈诊断和 Candidate 生成前，按算子、Profile、硬件、shape、
   dtype、历史失败与已尝试方向查询。
2. **生成草稿或失败记录**：通过候选准入和证据条件的结果，根据 Candidate Diff、测试证据、
   环境指纹和 Gate 结论生成经验草稿；硬门禁失败生成 Failure Record，并提取负向经验边界。
   弱候选只保留为参考，不要求每份证据都转成知识草稿。
3. **沉淀经验**：只有来源、语义绑定、Candidate 摘要和证据等级满足治理规则的草稿才可进入
   正式经验库；需要审核的保留为草稿，重复项合并，低价值项不发布。
4. **证据隔离**：`simulation` 只做流程仿真；`cpu-e2e` 真实执行但只用于验证闭环；共享 GPU
   开发证据是真实的本地 correctness/benchmark 测量，可用于本机开发判定。三者都不能升级或
   冒充为可发布的真机 `liveHardware` 经验——真实来源不自动带来发布权。

## 快速启动

### 兼容 TUI（`tester:c500`，固定 C500 后端）

`npm run tester:c500` 是保留的 C500/C550 兼容 launcher：`tools/local-c500-tester/launcher.cjs`
固定写入 `OPERATOR_TEST_BACKEND=local-c500`，因此**不能**通过环境变量把它切到本地共享 GPU。
目标机先完成所选 Agent 的登录，然后运行：

```bash
npm ci
npm run tester:c500
```

Linux 目标机使用保留的 C500/C550 兼容脚本：

```bash
bash scripts/c500-test.sh verify
bash scripts/c500-test.sh doctor
bash scripts/c500-test.sh start
```

默认 Agent 是 Claude Code。显式切换到 Codex：

```bash
export OPERATOR_RUNTIME_MODE=codex-cli
npm run tester:c500
```

详细部署、环境检查、端口和 TUI 操作见
[`tools/local-c500-tester/README.md`](tools/local-c500-tester/README.md)。

### 当前共享 GPU 真实 E2E（PowerShell，已验证入口）

当前实际后端是本地共享 NVIDIA GPU。它的真实入口是共享 GPU E2E driver
（`scripts/e2e-shared-gpu-agent-iteration.mjs`）。显式选择 P1 已验收的 Claude 路径：

```powershell
$env:E2E_AGENT_RUNTIME = 'claude-code'
npm run e2e:shared-gpu-agent-iteration
```

它会启动已登录的 Claude Code 并消耗真实 Agent 会话，因此默认不进门禁。结果标记为
`source=local-shared-gpu`、`publishable=false`：这是真实的本地 correctness/benchmark 测量，
可用于本机开发判定，但**不能**作为真机发布证据。

### 无硬件体验

完整界面与状态机仿真，不调用模型、Python 或硬件：

```bash
npm run tester:c500:simulation
```

仿真结果始终是 `liveHardware=false`，不得作为真机发布验收证据。

### Web 开发客户端

`src/` 中现有 Web 界面是开发客户端，不是当前生产操作入口：

```powershell
npm install
npm run dev
```

- Web：`http://127.0.0.1:5173`
- Client Runtime：`http://127.0.0.1:4174`
- Mock Test Service：`http://127.0.0.1:4180`

后续 GUI 应继续调用 Production HTTP API，不得直接读取状态文件或复制 workflow。

## 状态查询与自动推进

`GET /api/state`、Mission 事件/SSE 和测试任务查询只读取快照，不再驱动流程。
Runtime 默认开启后台 tick，生产 TUI 的自动推进保持不变。确定性测试可设置
`OPERATOR_AUTO_TICK=0`，并通过 `POST /api/runtime/advance` 显式推进一次。该兼容开关也会
关闭自动 Candidate 动作，但显式推进仍负责恢复、投影和轮次结算。该入口与
后台 tick 共用应用服务和状态锁，不是第二套 workflow。

## Agent Runtime

| Runtime | 状态 | 用途与限制 |
|---|---|---|
| `claude-code` | 生产可用，TUI 默认 | Candidate、Research、Baseline Materializer、结构化事件和取消 |
| `codex-cli` | 生产可用，可选 | 复用本机 Codex 配置，通过 JSONL 投影运行过程 |
| `opencode-server` | 实验 | 当前缺少完整 Patch/Decision 动作桥，不满足生产验收 |
| `cli-file` | 兼容 | 只保留已验证的旧文件协议边界，不是新功能扩展目标 |
| `reference-fixture` | 仅测试 | 生成确定性参考数据，不能产生可发布证据 |

Operator Studio 不保存或注入 Agent Provider 的 API key、模型地址和登录凭据。认证与模型配置
由对应的本机 Agent CLI 管理。

## 执行后端

| 后端 | 是否真实执行 | Evidence | 用途 |
|---|---:|---|---|
| 本地共享 NVIDIA GPU runner（`local-shared-gpu`） | 是（真实 GPU 测量） | `source=local-shared-gpu`, `publishable=false` | 当前开发用的真实 Correctness、Benchmark；本地开发可用，不可发布 |
| CPU E2E runner | 是 | `source=cpu-e2e`, `liveHardware=false` | 开发机端到端流程验证 |
| C500/C550 local runner | 保留兼容/历史 | 按目标/版本/证据资格逐项判定 | 兼容旧状态与历史证据，不作为当前开发后端 |
| Hardware Mock | 否 | `liveHardware=false` | 真实 Agent + 可重复多轮工作流测试 |
| Full Simulation | 否 | `liveHardware=false` | TUI/API/状态机快速检查 |
| `test-service` Mock/remote adapter | 兼容路径 | 取决于适配器返回 | 旧 HTTP 测试服务契约与远端联调 |

通用异步测试工具、内容寻址执行包与可信准入、版本化开发经验已建立独立模块和契约测试；
共享 GPU MVP 已接入生产组合根，提交前会完成包组装、语法校验、准备和 admission，Runner
只读取已准备包目录。共享主机 GPU 结果是真实的本地开发测量（nonpublishable live
development evidence），可用于本机开发判定，但不能直接发布为真机经验。强隔离
环境与真实 Agent 多算子验收（provider 中立，验收须按 provider 分别成立）仍属于后续扩展，
当前范围和进展见 [通用算子 Goal](docs/development/GENERIC_OPERATOR_GOAL.md)。

## 核心模块

| 目录 | 职责 |
|---|---|
| `tools/local-c500-tester/` | Ink TUI、Production API Client、启动器和保留的 C500/C550 兼容环境预检 |
| `client-runtime/server/` | HTTP、SSE 和静态资源的薄适配层 |
| `client-runtime/application/` | 与传输无关的用例编排 |
| `client-runtime/` | Workflow、Agent、Workspace、Queue、Gate、Knowledge 和持久化边界 |
| `test-service/` | 旧 HTTP Operator Test Service 契约的 Mock/remote compatibility adapter |
| `test-fixtures/` | Reference Fixture 使用的隔离样例，不是产品数据源 |
| `src/` | Web 开发客户端；未来 GUI 可复用 Production API |
| `tests/` | 单元、契约、集成、鲁棒性和端到端测试 |
| `docs/development/` | 当前架构图、团队讲稿和开发约束 |

每个模块目录的 README 定义模块功能、输入、输出、不变量、副作用和公开接口。修改契约时必须
同步更新对应 README。

## 不可破坏的约束

- `client-runtime/fixed-operator-profiles.mjs` 是固定 Profile 和测试矩阵的唯一语义来源。
- Simulation evidence 不能变成可发布的真机 evidence。
- Candidate evidence 必须匹配实际应用到 Mission Workspace 的 Candidate。
- 固定 shape、dtype、correctness cases、benchmark profiles 和重试预算不得弱化。
- Agent 写入范围仅限当前 Mission Workspace。
- Operator tests 必须串行执行并原子持久化终态。
- 生产行为只能走客户端 -> Production API -> Client Runtime，不得建立第二套 workflow。
- 外部失败必须通过统一错误契约归一化。

## 数据目录

普通 Client Runtime 默认写入：

```text
.operator-studio-local/
  data/mock-db.json
  runtime/
```

保留的 C500/C550 兼容 TUI 默认写入：

```text
.local-c500-production/
  data/
  runtime/
  local-c500-tasks/
```

可通过 `OPERATOR_STORAGE_ROOT`、`OPERATOR_DATA_DIR`、`OPERATOR_RUNTIME_DIR` 或
`LOCAL_C500_TESTER_HOME` 覆盖。运行时目录不应提交到 Git。

## 验证

跨模块修改必须运行：

```bash
npm run verify:local-c500-release
```

无硬件改动还应运行：

```bash
npm run verify:non-hardware-robustness
```

CPU 流程测试：

```bash
npm run e2e:cpu-iteration        # Reference Fixture + 实际 CPU 执行
npm run e2e:cpu-agent-iteration  # 真实 Agent + 实际 CPU 执行，手动验收
```

Linux x86_64 兼容性验收（需在 Linux 主机执行；Windows 上会明确跳过 Linux 专属检查）：

```bash
npm run verify:linux-compatibility
```

该命令覆盖原生 Python 路径解析、tar/ZIP 执行包导入以及 POSIX 进程组在 leader
提前退出后的 descendant 回收；它不把 Linux 通过外推为真机发布证据。

真实 Agent E2E 会消耗真实 Agent 会话，因此不加入日常验证套件：`e2e:cpu-agent-iteration`
默认使用已登录的 Claude Code（`E2E_AGENT_RUNTIME=codex-cli` 可切到 Codex）；共享 GPU driver
`e2e:shared-gpu-agent-iteration` 走已验证的 Claude 路径时显式设置
`E2E_AGENT_RUNTIME=claude-code`（见「当前共享 GPU 真实 E2E」）。

## 开发文档

- [开发文档入口](docs/development/README.md)
- [模块归属与功能索引](docs/development/MODULE_OWNERSHIP.md)
- [开发架构与依赖方向](docs/development/ARCHITECTURE.md)
- [Client Runtime 模块契约](client-runtime/README.md)
- [Application 编排模块契约](client-runtime/application/README.md)
- [Server 传输模块契约](client-runtime/server/README.md)
- [TUI 模块契约（C500/C550 兼容入口）](tools/local-c500-tester/README.md)
- [测试模块契约](tests/README.md)
- [当前模块与 Workflow 可视化](docs/development/operator-studio-module-workflow.html)
- [15 分钟团队讲稿](docs/development/operator-studio-team-briefing-15min.md)
