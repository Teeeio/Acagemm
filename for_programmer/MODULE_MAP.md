# 模块地图

## 1. 核心目录与文件

| 路径 | 职责 | 入口 | 输入 | 输出 | 直接依赖 | 对应测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `src/` | 浏览器 SPA、OA 风格界面、流程交互、状态展示 | `src/main.jsx` -> `src/App.jsx` | 用户操作；`/api/state`、`/api/workspace` 和动作响应 | DOM UI；HTTP 请求 | React、ReactDOM、lucide-react、浏览器 Fetch | 无组件/E2E 测试；生产构建只验证可编译 | B |
| `server/` | 本地 HTTP API、静态资源服务、领域状态、Runtime 适配器 | `server/mock-server.mjs`；开发编排为 `server/dev.mjs` | HTTP 请求、环境变量、JSON 状态、CLI 文件 | JSON API、静态文件、状态文件、工作区文件、事件 | Node 标准库、`dist/`、`demo-assets/` | `runtime-test.mjs`、`smoke-test.mjs`、`release-guard-test.mjs` | A/C 混合 |
| `scripts/` | 展会诊断、离线打包、重置、停止服务 | 各 `.ps1`；由 npm scripts 或根目录 `.cmd` 调用 | 项目目录、端口、Node/npm、当前构建 | PASS/FAIL 诊断、release 包、重置状态、停止进程 | PowerShell、npm、Node、SHA256/ZIP 系统能力 | 本次实际运行诊断和打包；无脚本单元测试 | A |
| `demo-assets/` | 工作区初始模板 | `demo-assets/mla-kernels/` | 仓库内固定文件 | 首次启动/重置时复制到 `runtime/mla-kernels` | 文件系统 | Smoke 通过重置、Patch、恢复间接覆盖 | A（模板内容是样例） |
| `public/` | Vite 原样复制的品牌 Logo | `public/logos/*.svg` | 静态 SVG | `/logos/*.svg` | Vite public 目录约定 | 构建间接覆盖；无像素/视觉测试 | B |
| `data/` | 源码运行时 JSON 数据库 | `data/mock-db.json` | `saveState()` | 持久化 schemaVersion 4 状态 | `state-store.mjs` | Smoke 使用隔离数据目录覆盖同一行为 | A；运行产物，Git 忽略 |
| `runtime/` | 活动工作区、检查点、PID、CLI Bridge、测试临时目录 | 由服务和测试按需创建 | 模板、Patch、检查点、环境变量 | 实际工作区文件、恢复点、请求 JSON、PID | Node 文件系统 | Smoke、Release Guard、启动验收 | A；运行产物，Git 忽略 |
| `dist/` | Vite 生产构建产物 | `dist/index.html` | `src/`、`public/`、Vite 配置 | 浏览器可加载的 HTML/CSS/JS | Vite | `npm run build`、启动验收 | A；生成物，Git 忽略 |
| `release/` | 离线展会目录和 ZIP | `scripts/prepare-exhibition-package.ps1` | dist、server、assets、scripts、文档、Node 二进制 | `OperatorStudio-Exhibition/` 和 ZIP、`MANIFEST.sha256` | PowerShell、Node、构建和三组测试 | `npm run demo:package` 实际通过 | A；生成物，Git 忽略 |
| `for_programmer/` | 当前项目收口文档 | `PROJECT_STATE.md` | 当前代码、配置、测试和运行结果 | 架构、合约、问题、计划 | 无运行时依赖 | 链接/文件清单/内容人工校验 | A（文档） |

状态：A 已真实实现并验证；B 已实现但未充分验证；C Mock/固定样例；D 仅设计未实现。

## 2. `src/` 细分

### `src/main.jsx`

- 职责：引入全局样式，把 `<App />` 挂载到 `#root`，启用 `React.StrictMode`。
- 输入：`index.html` 中的 `#root`。
- 输出：React 应用实例。
- 依赖：`react`、`react-dom/client`、`styles.css`、`App.jsx`。
- 测试：仅由 `npm run build` 覆盖模块解析和编译。

### `src/App.jsx`

- 职责：完整应用壳、Mission 流程导航、Agent 工作台、迭代/代码/实验/决策/知识页面、弹窗/抽屉、API 请求、轮询和通知。
- 入口：默认导出的 `App()`。
- 输入：浏览器事件；服务端 `state`、`workspace`、错误响应。
- 输出：页面 UI；Mission、Patch、Benchmark、Review、Rollback、Knowledge 等 HTTP 请求。
- 依赖：React hooks、lucide-react、相对路径 `/api`。
- 测试：没有直接测试。Smoke 只验证后端流程，不渲染 React。
- 状态：B。功能广，但 204365 字节单文件导致维护和回归风险较高。

### `src/styles.css`

- 职责：整个应用的 OA 布局、组件样式、响应式规则和状态色。
- 输入：`App.jsx` 使用的 className。
- 输出：生产 CSS bundle。
- 依赖：浏览器 CSS。
- 测试：构建通过；没有截图回归或多视口自动化。
- 状态：B。

## 3. `server/` 细分

### `server/mock-server.mjs`

- 职责：HTTP 路由、参数校验、工作流前置条件、静态文件服务、错误响应、启动 PID。
- 入口：`node server/mock-server.mjs` / `npm start`。
- 输入：HTTP、`API_PORT`/`PORT`、`SERVE_WEB`、Runtime 环境变量。
- 输出：JSON、`dist` 静态资源、PID；调用状态层产生磁盘副作用。
- 依赖：`state-store.mjs`、`agent-runtime.mjs`、Node `http/fs/path/url`。
- 测试：Smoke 覆盖 Demo 主链；Release Guard 覆盖 CLI 权威拒绝；临时端口启动验收。
- 状态：A 作为本地演示服务；不是生产服务。

### `server/state-store.mjs`

- 职责：schemaVersion 4 状态、seed 数据、迁移、Mission 投影、Agent/Benchmark 时间推进、候选与失败记录、知识维护、Patch/Checkpoint I/O。
- 入口：导出的 `loadState()`、`saveState()`、`resetDemoData()` 及领域函数。
- 输入：`data/mock-db.json`、工作区模板、当前时间、领域动作。
- 输出：完整 state、`runtime/mla-kernels`、`runtime/checkpoints`、审计/Runtime 事件。
- 依赖：Node `fs/promises`、`path`、`agent-runtime.mjs` 的事件追加。
- 测试：Smoke 主流程覆盖；部分介入分支和迁移组合未逐一覆盖。
- 状态：A/C 混合。文件操作真实，Agent/Benchmark/指标为 Mock。

### `server/agent-runtime.mjs`

- 职责：统一 Runtime 描述、Runtime Event 序号、Demo/CLI 模式分派、CLI 文件探针、Mission 请求写出、Agent 状态投影。
- 入口：`agentRuntime` 单例或 `createAgentRuntime(options)`。
- 输入：`OPERATOR_RUNTIME_MODE`、`OPERATOR_CLI_ROOT`、状态/队列/知识记录文件。
- 输出：Runtime descriptor、Bridge 请求 JSON、投影后的 Agent 状态、Runtime Event。
- 依赖：Node 文件系统和 path。
- 测试：`runtime-test.mjs` 和 `release-guard-test.mjs`。
- 状态：Mission/状态边界 A；真实动作桥 D。

### `server/dev.mjs`

- 职责：同时拉起 API-only 服务和 Vite 开发服务器，并在 SIGINT/SIGTERM 时结束子进程。
- 入口：`npm run dev`。
- 输入：当前环境和源码。
- 输出：4174 API、5173 Web。
- 依赖：Node child_process、Vite、mock server。
- 测试：未自动验证双进程退出和 Windows 信号行为。
- 状态：B。

### 测试文件

| 文件 | 输入/隔离方式 | 主要断言 | 未覆盖 |
| --- | --- | --- | --- |
| `runtime-test.mjs` | OS 临时目录中的 CLI fixture | Demo/CLI descriptor、探针、Mission request、序列、非法状态 | 真实 CLI 目录、持续文件更新 |
| `smoke-test.mjs` | `runtime/smoke-*` 隔离 data/runtime，独立端口 | Mission、Patch、Checkpoint、Benchmark、介入阻塞/redirect、自动采用、知识、回退、幂等 | React UI；adopt/supplement/cancel 的全部组合；并发 |
| `release-guard-test.mjs` | `runtime/release-guard-*` CLI fixture，端口 4201 | CLI 权威、禁用动作不变更状态、退役发布 API | 外部 CLI 执行器、网络异常恢复 |

## 4. 根目录配置与文档

| 文件 | 职责 | 输入 | 输出/影响 | 测试 |
| --- | --- | --- | --- | --- |
| `package.json` | 依赖与开发、构建、测试、打包命令 | npm | 命令入口 | 本次逐项运行核心命令 |
| `vite.config.js` | React 构建与开发代理 | `/api` 请求 | 代理到 4174、生产 bundle | Build 通过；代理未单独验收 |
| `index.html` | SPA HTML 壳 | Vite 注入 | `#root` 和入口脚本 | Build + 静态启动通过 |
| `.gitignore` | 隔离依赖和运行产物 | 工作树文件 | 忽略 node_modules/dist/data/runtime/release/log | `git status` 实际确认生成物未出现 |
| `README.md` | 使用说明与能力边界 | 人工维护 | 开发者说明 | 非可执行；部分内容可能滞后于当前未提交代码 |
| `DELIVERY.md`、`EXHIBITION.md` | 交付和现场操作 | 人工维护 | 展会手册 | 诊断/打包流程实际验证 |
| `CLI系统对接需求文档.md` | CLI 参考系统需求与边界 | 设计材料 | 对接目标 | 仅设计证据，不是实现 |
| `原型文档.md` | 产品原型需求 | 设计材料 | UI/流程意图 | 仅设计证据，不是运行合约 |
| 根目录 `.cmd` | Windows 双击启动、停止、诊断、重置 | Node 或内置 node.exe | 调用服务和 PowerShell 脚本 | 底层命令已验收；双击 GUI 行为未自动验证 |

## 5. 依赖边界总结

- 前端不直接读写文件，只依赖 HTTP API。
- `mock-server.mjs` 是 HTTP 边界，领域数据集中在 `state-store.mjs`。
- `state-store.mjs` 与 `agent-runtime.mjs` 目前存在双向协作：状态层使用 `appendRuntimeEvent`，HTTP 层同时调用两者。
- 所有持久化都是单机文件系统，没有数据库、队列、鉴权或远程服务。
- 测试不依赖真实 GPU；它们验证的是流程、文件副作用和权威边界。
