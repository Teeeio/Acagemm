# Module Map

| 目录 | 职责 | 入口 | 输入 | 输出 | 依赖 | 对应测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `src/` | React 产品 UI；消费本地状态、提交用户动作 | `src/main.jsx`, `src/App.jsx` | `/api/*` JSON、用户操作 | 页面、客户端动作请求 | React、Lucide、Vite | Build；Smoke 间接覆盖 | 已实现，UI 自动化覆盖不足 |
| `client-runtime/` | 本地应用运行时；Agent Adapter、Mission、候选工作区、策略、知识、持久化、静态资源 | `local-server.mjs`, `dev.mjs`, `start.mjs` | UI 请求、CLI 文件、Test Service 结果、环境变量 | `/api/*`、本地状态、工作区文件、Agent Bridge 请求 | Node 标准库、`dist/`、`test-service` 契约 | `agent-runtime-test`, `client-runtime-smoke-test`, `release-guard-test`, `product-boundary-test` | 主流程已实现；CLI 动作桥部分实现 |
| `test-service/` | 远端算子测试服务的 Mock；只处理测试任务 | `mock-server.mjs` | Operator、Candidate 标识、测试矩阵 | Benchmark、Tracer、Profiler、日志 | Node 标准库 | `contract-test.mjs`, Smoke | 契约已实现；执行结果为 Mock |
| `tests/` | 运行时契约、产品边界、端到端烟雾、发布守卫 | 各 `*-test.mjs` | 隔离端口和临时目录 | PASS/FAIL | Client Runtime、Test Service | 自身 | 已实现并运行 |
| `scripts/` | Windows 展会诊断、打包、启动、停止、重置 | `*.ps1` | 构建产物、环境变量、Node | 离线包、诊断表、进程控制 | PowerShell、npm | Release Guard；打包脚本内置八组测试 | 已实现，打包需最终复验 |
| `demo-assets/` | `reference-fixture` 和隔离工作区的示例代码模板 | `mla-kernels/` | Reset/测试夹具 | 初始工作区文件 | 文件系统 | Smoke | 测试/样例资产，不是产品数据源 |
| `public/` | 本地静态资源和硬件 Logo | Vite public root | 构建 | 浏览器静态文件 | Vite | Build | 已实现 |
| `for_programmer/` | 架构、契约、状态和后续开发文档 | 本目录 Markdown | 代码、配置、测试结果 | 开发交接材料 | 无 | 人工核对 | 已更新 |

## `client-runtime/` 文件职责

| 文件 | 职责 |
| --- | --- |
| `local-server.mjs` | Loopback HTTP、静态页面、本地业务 API、Test Service 轮询 |
| `state-store.mjs` | 领域状态、流程迁移、工作区/检查点、决策、知识维护 |
| `agent-runtime.mjs` | `codex-cli`（默认）、`unavailable`、`cli-file`、`opencode-server`、`reference-fixture` Adapter |
| `opencode-client.mjs` | OpenCode Headless Server HTTP Client；Session、Prompt、Status、Message、Diff |
| `test-service-client.mjs` | Test Service HTTP Client |
| `operator-test-queue.mjs` | Client-owned persistent serial queue; owns submit, poll, cancellation, and remote task projection |
| `codex-client.mjs` | Codex CLI probe, `codex exec --json` process bridge, JSONL event persistence, thread detection, and cancellation |
| `dev.mjs` | Vite + Client Runtime + Test Service 开发编排 |
| `start.mjs` | 构建产物 + Client Runtime + Test Service 启动编排 |
| `reset-data.mjs` | 显式重置本地状态和工作区 |

## 模块依赖约束

`src -> client-runtime -> test-service contract`。`test-service` 不得反向依赖 `client-runtime`，也不得读取客户端状态目录。Agent Adapter 只存在于 `client-runtime`。
