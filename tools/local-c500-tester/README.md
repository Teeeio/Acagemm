# Local C500 Production Workflow Tester

这是 Operator Studio 生产工作流的 TUI 测试入口。它复用生产 Mission、受管理 Agent、baseline、Mission Workspace、operator-test queue、Accept Gate、adoption 和连续迭代逻辑，只把 queue 后面的执行服务切换为本机沐曦 C500 backend。

## 启动

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

未设置 `OPERATOR_LOCAL_C500_MOCK` 时默认使用真实 C500 runner。真机部署、验收项目和结果回传见 [`docs/local-c500-real-hardware-test.md`](../../docs/local-c500-real-hardware-test.md)。

`TUI` 分支默认使用 Claude Code。测试人员在启动 doctor/runtime 之前确认：

```bash
export OPERATOR_RUNTIME_MODE=claude-code
export CLAUDE_COMMAND=claude
claude --version
claude auth status
```

Claude Code 复用相同的 Research、Baseline Materializer、Candidate、Workspace Diff、回退和采用工作流。Runtime 使用非交互 `stream-json`，只向各阶段暴露受控的 Read/Write/Edit 工具；Research acquisition 额外允许 WebSearch/WebFetch，Bash 始终禁用。不要设置 `--dangerously-skip-permissions`。

Claude Candidate 默认允许 5 分钟无事件窗口，Codex 保持 2 分钟；现场网关确实更慢时可通过 `OPERATOR_MAIN_AGENT_STALL_MS` 调整。Windows 本地路径若被 Claude 转成包含 `~1` 一类片段的 8.3 短路径，可能触发其路径安全拦截；真机 Linux 不受影响，本地验证应使用不触发短路径转换的工作目录。

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
-> Claude Code Agent candidate in isolated Mission Workspace
-> Git diff admission
-> production operator-test queue
-> local C500 runner
-> Accept Gate
-> adoption / rollback / knowledge
-> budget-aware iteration loop
```

`tools/local-c500-tester/cli.mjs` 及同目录旧 workflow 文件仅作为历史原型保留，不在 TUI 正常路径中执行。

## TUI 操作

- `P`: 发布并立即启动 Mission
- `Space`: 暂停或恢复 Mission
- `N`: 添加人工意见，意见会进入生产迭代上下文
- `D`: 检查 runtime、Python、`mx-smi` 及可选的 `mctracer`、`mcProfiler`
- `S`: 停止 Agent、测试任务和自动循环
- `E`: 导出生产 state、queue task 和 backend 信息
- `Q`: 退出 TUI；API runtime 保持运行

发布表单的 `Language` 使用左右方向键选择。当前 adapter 包括 `PyTorch Python`、`Triton`、`CUDA C++ Extension` 和 `MXMACA C++ Extension`。所有语言都保留 `run.py` 作为固定 Runner 桥；native adapter 会同时生成并随任务携带 `operator.cu` / `operator.cpp`。面板顶部的 `Tokens` 是当前 Mission 的 Research、Materializer 和各轮 Iteration Agent 总消耗，重复刷新不会重复计数。

## C500 现场环境

目标环境：

- Python `3.12.11`
- PyTorch `2.8.0+metax3.3.0.2`
- Triton `3.7.1`
- MACA `3.3.0.15`
- vLLM `0.13.0`
- vLLM MetaX `0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8`
- `mx-smi`, `mctracer`, `mcProfiler`

默认真实执行命令是 `python tools/local-c500-runner.py`。Baseline Materializer 根据权威语义生成具名 `get_test_cases()` 和 `get_benchmark_inputs()`；Runner 使用独立 baseline oracle 产生输入与预期结果，只调用候选的 `run(inputs)`，防止候选通过改写 reference 自证正确。Correctness 覆盖 minimal、representative、boundary、ragged 类别，benchmark 覆盖 primary、small、boundary profile，并继续主动尝试 mctracer 和 mcProfiler。两项诊断工具缺失或执行失败会记录 warning/失败工件，但不会阻塞 benchmark、Accept Gate 或采用；`mx-smi`、C500 来源、correctness 和 benchmark 仍是硬要求。

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

Mock 只替代 queue 后面的硬件输出。Mission 解析、Agent、Workspace diff、baseline、Accept Gate 和循环仍走生产模块。Mock 结果始终标记 `source=simulation`、`liveHardware=false`，不能成为真实硬件证据。

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

`npm run e2e:local-c500-production -- <API port>` 会使用当前配置的真实 Agent（TUI 默认 Claude Code）生成候选，并通过生产 API 和本地 backend 完成闭环。它需要可用的 Claude Code 服务；未设置 mock 时还需要实际 C500 及分析工具。
