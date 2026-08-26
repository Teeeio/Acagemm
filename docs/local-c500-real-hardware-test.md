# Local C500 真机测试手册

本文用于测试人员从 Git 仓库拉取测试版后，在沐曦 C500 机器上运行完整算子迭代流程。真实模式只把算子测试交给本机 C500 runner；Research、Baseline、Candidate、Gate、Rollback 和 Adoption 均继续使用生产工作流。

## 1. 环境要求

- Git、Node.js 20+、npm
- 已安装并登录 Claude Code，且 `claude --version` 和 `claude auth status` 可执行
- Python 3.12（现场目标版本 3.12.11）
- PyTorch `2.8.0+metax3.3.0.2`，且 `torch.cuda.is_available()` 为 `True`
- MACA、Triton 和 C500 驱动环境已生效
- `mx-smi` 必须可执行；`mctracer`、`mcProfiler` 为可选诊断工具
- 机器能够访问 Research Agent 所需的公开网络和 Claude Code 服务

## 2. 拉取与安装

```bash
git clone --branch TUI --single-branch https://gitee.com/<组织>/operator-studio-c500-tester.git
cd <repository-directory>
npm ci
npm run verify:local-c500-release
```

如果目标机无法下载 Node/nvm，`TUI` 分支已包含官方 Node.js `v24.19.0`
Linux x64 归档。使用项目内隔离安装，不覆盖系统 Node：

```bash
bash scripts/install-bundled-node.sh
bash scripts/with-bundled-node.sh npm ci
bash scripts/with-bundled-node.sh npm run verify:local-c500-release
```

之后启动 TUI 也通过包装器执行：

```bash
bash scripts/with-bundled-node.sh npm run tester:c500
```

`npm run tester:c500` 自身也带有旧 Node 兼容启动器：在 Linux x86_64 上检测到
系统 Node 低于 20 时，会自动转交给已经安装的 bundled Node。安装依赖时仍建议
使用上述包装器，确保 `npm ci` 使用 npm 11。

安装脚本会先校验官方 SHA-256，并拒绝非 Linux x86_64 平台。归档只解决
Node 安装；首次 `npm ci` 仍需要可访问的 npm registry 或现场 npm 镜像。

仓库内 `.npmrc` 固定使用官方 npm registry，避免全局镜像配置覆盖 lock 中的下载地址。该文件不包含认证信息。

若真机只负责运行已通过发布门禁的 TUI，可使用最小运行时安装，避免安装 Web 开发服务器依赖：

```bash
npm ci --omit=dev
```

不要把 GitHub token 写入 `.env`、命令脚本或项目文件。私有仓库认证使用系统凭据管理器或一次性环境变量。

### GitHub 不可达时的 Source mirror

测试项目迁移到 Gitee 只能解决测试版拉取。严格从零流程仍需要获得 FlashInfer 官方 Source，因此还必须由管理员配置 canonical source 到 Gitee transport 的固定映射。

在一台能够访问 GitHub 和 Gitee 的中转机上建立镜像：

```bash
git clone --mirror https://github.com/flashinfer-ai/flashinfer.git
cd flashinfer.git
git push --mirror https://gitee.com/<组织>/flashinfer-mirror.git
```

在目标机上从 Gitee 读取要固定的 snapshot identity：

```bash
git clone https://gitee.com/<组织>/flashinfer-mirror.git .source-pin-check
git -C .source-pin-check rev-parse HEAD
git -C .source-pin-check rev-parse 'HEAD^{tree}'
```

复制 `docs/source-mirrors.example.json` 为测试目录之外或本次状态目录内的配置文件，替换 Gitee 地址、完整 commit 和完整 tree。然后在启动 doctor/runtime 前设置：

```bash
export OPERATOR_SOURCE_MIRROR_CONFIG="$PWD/source-mirrors.json"
```

PowerShell：

```powershell
$env:OPERATOR_SOURCE_MIRROR_CONFIG = (Resolve-Path '.\source-mirrors.json')
```

安全模型如下：

- Research Agent 只能声明 GitHub/GitLab 官方 canonical source，不能选择 Gitee transport。
- 固定工作流根据管理员配置从 Gitee clone。
- clone 后必须严格匹配完整 commit；配置 tree 时也必须严格匹配 tree。
- Source Registry 和最终 baseline 对外仍记录官方 canonical URL，同时单独记录 Gitee transport。
- Gitee 凭据必须由 Git credential helper 提供，禁止写进 transport URL 或配置文件。

## 3. 真机预检

`TUI` 分支默认使用 Claude Code，启动任何 doctor/runtime 进程之前确认：

```bash
export OPERATOR_RUNTIME_MODE=claude-code
export CLAUDE_COMMAND=claude
claude --version
claude auth status
```

不要把 `CLAUDE_COMMAND` 指向 Codex wrapper，也不要启用 `--dangerously-skip-permissions`。Claude 的账号、模型和企业网关由测试机本地 Claude Code 配置管理，Operator Studio 不读取或保存凭据。

```bash
node --version
claude --version
claude auth status
python --version
mx-smi
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
```

确保没有遗留模拟变量：

```bash
unset OPERATOR_LOCAL_C500_MOCK
unset OPERATOR_LOCAL_C500_MOCK_SCENARIO
```

PowerShell 对应命令：

```powershell
Remove-Item Env:OPERATOR_LOCAL_C500_MOCK -ErrorAction SilentlyContinue
Remove-Item Env:OPERATOR_LOCAL_C500_MOCK_SCENARIO -ErrorAction SilentlyContinue
```

然后运行环境检查：

```bash
npm run tester:c500:doctor
```

预期 backend 为 `local-c500` 且不是 simulation，Python、`mx-smi` 为 `ok`。`mctracer`、`mcProfiler` 可为 `ok` 或 `optional-missing`；缺失不会阻塞流程。

Claude 模式还应看到 runtime mode 为 `claude-code`、status 为 `connected`，并显示本机 Claude Code 版本。

使用镜像时还应看到 `sourceMirror=ok`、映射数量以及 `required`。`sourceMirror=invalid` 时不要发布 Mission；先修复配置文件。

## 4. 启动真机测试

建议每次验收使用全新状态目录和独立端口：

```bash
export LOCAL_C500_TESTER_HOME="$PWD/.local-c500-real-$(date +%Y%m%d-%H%M%S)"
export LOCAL_C500_API_PORT=4275
npm run tester:c500
```

PowerShell：

```powershell
$env:LOCAL_C500_TESTER_HOME = Join-Path $PWD ('.local-c500-real-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$env:LOCAL_C500_API_PORT = '4275'
npm run tester:c500
```

进入 TUI 后按 `P` 发布 Mission。默认 Mission 从零研究并优化 FlashInfer MLA paged attention；测试人员可修改目标、项目名和指标后提交。

## 5. 验收观察项

流程应按以下顺序稳定推进：

```text
Source Research -> Source Verify -> Materializer -> Baseline Test
-> Candidate -> C500 Test -> Accept Gate -> Adopt 或 Rollback -> 下一轮
```

每次真实测试结果必须满足：

- `environment.source=local-c500`
- `environment.liveHardware=true`
- correctness 通过后才产生 benchmark
- tracer 和 profiler 会被主动调用；不可用或失败时记录状态和诊断，但不阻塞 Gate
- Source Verify 显示 mirror pin，导出结果同时包含 canonical、transport、commit 和 tree
- 未达 Gate 的 Candidate 回退后，下一轮从稳定 workspace 开始
- 达标 Candidate 被提交到 Iteration Repository，循环正常终止

真机性能值不要求复现模拟的 `100/92/84/75 us`。模拟序列只用于工作流回归，不能作为真机验收预期。

## 6. 导出与回传

在 TUI 中按 `E` 导出当前 Mission。请回传：

- `.local-c500-real-*/exports/<mission-id>.json`
- `.local-c500-real-*/logs/runtime.log`
- 失败任务对应的 `.local-c500-real-*/local-c500-tasks/<task-id>/`
- TUI 终态截图及失败发生的阶段

回传前检查文件中不包含访问 token、Claude Code 凭据或其他密钥。

## 7. 模拟复现

只有需要排查工作流而不占用真机时才启用：

```bash
export OPERATOR_LOCAL_C500_MOCK=1
export OPERATOR_LOCAL_C500_MOCK_SCENARIO=mla-three-round
export LOCAL_C500_API_PORT=4276
export LOCAL_C500_TESTER_HOME="$PWD/.local-c500-simulation"
npm run tester:c500
```

模拟结果必须显示 `SIMULATION`、`source=simulation`、`liveHardware=false`，并且不可发布为硬件证据。

## 8. 常见问题

- 端口提示模式冲突：旧 runtime 仍在运行。停止旧进程，或更换端口和状态目录。
- `torch.cuda is unavailable`：当前 Python 未加载 MetaX PyTorch/驱动环境。
- `mx-smi is unavailable`：runner 无法确认沐曦 C500 来源，会拒绝生成真机证据。
- `mctracer` 或 `mcProfiler` 失败：记录 `unavailable/failed` 诊断与工件，benchmark 和迭代继续运行。
- Agent 无进展：检查 Claude Code 登录、额度和网络；不要用手工候选绕过 Research、Diff admission 或 Gate。
