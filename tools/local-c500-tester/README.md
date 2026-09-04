# Local C500 Production Workflow Tester

这是 Operator Studio 生产工作流的 TUI 测试入口。它复用生产 Mission、受管理 Agent、baseline、Mission Workspace、operator-test queue、Accept Gate、adoption 和连续迭代逻辑，只把 queue 后面的执行服务切换为本机沐曦 C550 backend（`local-c500` 是历史兼容名称）。

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

`local-c500` 是后端适配器的兼容名称；当前真机目标固定为 C550。启动器通过 `torch.cuda.get_device_name()` 和 `mx-smi` 校验 C550，并将设备、软件栈和 smoke 结果写入 Mission、测试矩阵和结果环境标签。无法识别 C550、软件栈不匹配或 CUDA smoke 失败时，TUI 在进入交互界面前终止并报告硬件前置检查失败。

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
-> local C500 runner
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
| `tui-refresh.mjs` | 并发刷新仲裁 | 当前/新 snapshot | 最新可见 snapshot |
| `tui-layout.mjs` | 响应式终端布局 | columns/rows | layout DTO |
| `terminal-screen.mjs` | alternate-screen 生命周期 | stdout | ANSI enter/leave |
| `components/` | 展示组件 | ViewModel/viewport | Ink element tree |
| `workflow-summary.mjs` | 冷启动/E2E 报告 | state/tasks | Markdown summary |

TUI 不允许直接读取或写入持久化 state 文件，不允许调用 Agent provider 或 C550 runner，也不拥有工作流状态转换规则。契约变化必须同步更新本 README 和对应测试。

## TUI 操作

- `P`: 发布并立即启动 Mission
- `Space`: 暂停或恢复 Mission
- `N`: 添加人工意见，意见会进入生产迭代上下文
- `D`: 检查 runtime、Python、`mx-smi` 及可选的 `mctracer`、`mcProfiler`
- `S`: 停止 Agent、测试任务和自动循环
- `E`: 导出生产 state、queue task 和 backend 信息
- `Q`: 退出 TUI，并停止本次会话拥有的 API runtime

发布表单的 `Language` 使用左右方向键选择。当前 TUI 只展示并允许发布两个完整的 v0.1 profile：`paged-mqa-logits-triton-v01` 和 `flash-mla-decode-triton-v01`；另外四个 profile 仅作为内部实现保留，待补齐生产验证后再开放。所有语言都保留 `run.py` 作为固定 Runner 桥；native adapter 会同时生成并随任务携带 `operator.cu` / `operator.cpp`。面板顶部的 `Tokens` 是当前 Mission 的 Research、Materializer 和各轮 Iteration Agent 总消耗，重复刷新不会重复计数。

## C550 现场环境

目标环境：

- Python `3.12.11`
- PyTorch `2.8.0+metax3.3.0.2`
- Triton `3.7.1`
- MACA `3.3.0.15`
- vLLM `0.13.0`
- vLLM MetaX `0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8`
- `mx-smi`, `mctracer`, `mcProfiler`

默认真实执行命令是 `python tools/local-c500-runner.py`。Baseline Materializer 根据权威语义生成具名 `get_test_cases()` 和 `get_benchmark_inputs()`；Runner 使用独立 baseline oracle 产生输入与预期结果，只调用候选的 `run(inputs)`，防止候选通过改写 reference 自证正确。Correctness 覆盖 minimal、representative、boundary、ragged 类别，benchmark 覆盖 primary、small、boundary profile，并继续主动尝试 mctracer 和 mcProfiler。两项诊断工具缺失或执行失败会记录 warning/失败工件，但不会阻塞 benchmark、Accept Gate 或采用；`mx-smi`、C550 软件栈、correctness 和 benchmark 仍是硬要求。固定 Profile 每轮最多允许 3 次候选生成，correctness 修复独立允许 4 次；correctness 修复不会消耗候选生成配额。

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
