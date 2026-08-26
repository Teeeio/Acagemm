# Local C500 Production Workflow Tester

这是 Operator Studio 生产工作流的 TUI 测试入口。它复用生产 Mission、Codex Agent、baseline、Mission Workspace、operator-test queue、Accept Gate、adoption 和连续迭代逻辑，只把 queue 后面的执行服务切换为本机沐曦 C500 backend。

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

Agent Runtime 默认使用 Codex CLI。测试人员使用 Claude Code 时，在启动 doctor/runtime 之前设置：

```bash
export OPERATOR_RUNTIME_MODE=claude-code
export CLAUDE_COMMAND=claude
claude --version
claude auth status
```

Claude Code 复用相同的 Research、Baseline Materializer、Candidate、Workspace Diff、回退和采用工作流。Runtime 使用非交互 `stream-json`，只向各阶段暴露受控的 Read/Write/Edit 工具；Research acquisition 额外允许 WebSearch/WebFetch，Bash 始终禁用。不要设置 `--dangerously-skip-permissions`。

目标机无法访问 GitHub 时，设置 `OPERATOR_SOURCE_MIRROR_CONFIG` 指向管理员维护的 source mirror JSON。Research Agent 仍记录官方 canonical source，固定工作流从配置的 Gitee transport 获取并校验完整 commit/tree。示例见 [`docs/source-mirrors.example.json`](../../docs/source-mirrors.example.json)。

TUI 会在 `http://127.0.0.1:4275` 启动 API-only 生产 runtime。端口可通过 `LOCAL_C500_API_PORT` 覆盖。状态、Mission Workspace、测试任务和导出文件默认写入 `.local-c500-production/`，可通过 `LOCAL_C500_TESTER_HOME` 覆盖。

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
-> Codex Agent candidate in isolated Mission Workspace
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
- `D`: 检查 runtime、Python、`ixsmi`、`mctracer`、`mcProfiler`
- `S`: 停止 Agent、测试任务和自动循环
- `E`: 导出生产 state、queue task 和 backend 信息
- `Q`: 退出 TUI；API runtime 保持运行

## C500 现场环境

目标环境：

- Python `3.12.11`
- PyTorch `2.8.0+metax3.3.0.2`
- Triton `3.7.1`
- MACA `3.3.0.15`
- vLLM `0.13.0`
- vLLM MetaX `0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8`
- `ixsmi`, `mctracer`, `mcProfiler`

默认真实执行命令是 `python tools/local-c500-runner.py`。Runner 加载生产 Mission Workspace 生成的 `run.py`，验证 `get_inputs()`、`run(inputs)`、`reference(inputs)`，执行 correctness、GPU event benchmark、mctracer 和 mcProfiler。只有全部成功才会写出 `environment.liveHardware=true`。

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
npm run build
```

`npm run e2e:local-c500-production -- <API port>` 会使用真实 Codex Agent 生成候选，并通过生产 API和本地 backend 完成闭环。它需要可用的 Codex 网络访问；未设置 mock 时还需要实际 C500 及分析工具。
