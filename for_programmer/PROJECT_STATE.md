# Operator Studio 项目状态

> 盘点日期：2026-08-06
>
> 盘点对象：当前工作区，而不是仅盘点 Git HEAD
>
> Git 基线：`f683dcfa5b4894510ee636ddc560849ee20136f9` (`feat: prepare exhibition runtime delivery`)

## 1. 一句话结论

当前项目是一个可在 Windows 本机运行、可离线打包的展会演示系统。React 前端、Node 本地 HTTP 服务、JSON 持久化、候选补丁写盘、检查点恢复、流程状态、审计事件和知识资产维护已经形成闭环；默认 Agent、Benchmark、C500/CUDA 指标和优化证据仍由本地参考 Runtime 生成，不代表真实硬件执行。外部 CLI 仅接通 Mission 请求和状态文件投影，Patch、Benchmark、Decision 动作桥尚未实现。

## 2. 状态标记

| 标记 | 含义 |
| --- | --- |
| A | 已真实实现，并由本次盘点命令验证 |
| B | 已实现，但缺少充分自动化或真实环境验证 |
| C | 占位、固定样例或 Mock |
| D | 只有设计或接口边界，没有实现 |

## 3. 能力盘点

| 能力 | 状态 | 代码证据 | 本次验证结论 |
| --- | --- | --- | --- |
| React 单页应用和生产构建 | A | `src/`、`vite.config.js` | `npm run build` 通过，1581 modules transformed |
| 单进程静态站点与 `/api` 服务 | A | `server/mock-server.mjs` | 临时端口 4183 启动，`/` 为 HTTP 200，`/api/health` 为 `ok` |
| 磁盘 JSON 状态持久化 | A | `server/state-store.mjs` | Smoke 覆盖状态迁移与流程持久化；写入采用临时文件后 `rename` |
| Mission 创建、切换、运行与事件序列 | A | `mock-server.mjs`、`agent-runtime.mjs` | Smoke 和 Runtime contract 通过 |
| 候选 Patch 写入隔离工作区 | A | `applyCandidatePatch()` | Smoke 验证实际文件包含 `plan_cache.get_or_build` |
| 工作区检查点、阶段回退、采用后回退 | A | `createWorkspaceCheckpoint()`、`restoreWorkspaceCheckpoint()` | Smoke 验证文件恢复、后续工件失效和幂等回退 |
| Accept Gate 自动采用与知识自动维护 | A/C | `runAutomaticAdoption()`、`runKnowledgeMaintenance()` | 本地状态机和持久化由 Smoke 验证；Gate 规则、查重与版本计划是固定参考数据 |
| 失败候选记录与失败经验提取 | C | `candidateEvaluations`、`failureRecords` | Smoke 只验证固定 seed 的分类和经验状态；没有由真实失败运行动态生成 |
| 人工介入的发起、撤回、补充验证、调整方向、采用 | B | `/api/actions/*review` | Smoke 覆盖介入阻塞与 redirect；其余分支有代码但未逐分支自动化验证 |
| Demo Runtime Agent 推进与 Benchmark 进度 | C | `refreshAgent()`、`refreshBenchmark()` | 流程可运行，但进度、日志、指标和结论是按时间生成的固定参考数据 |
| C500/CUDA 实机性能结论 | C | `buildBenchmarkLogs()`、seed state | 明确 `liveHardware=false`；不能作为现场实测结果 |
| CLI 文件桥 Mission 请求 | A | `server/agent-runtime.mjs` | Runtime contract 验证请求文件、状态探针和事件序列 |
| CLI 状态投影 | B | `projectState()` | fixture contract 通过，未对接用户的真实 CLI 仓库做端到端验证 |
| CLI Patch/Benchmark/Decision 动作桥 | D | `guardReferenceRuntimeAction()` | CLI 模式主动返回 `409 RUNTIME_ACTION_UNAVAILABLE` |
| 生产级服务、身份认证、多用户并发 | D | 仓库中不存在对应模块 | 当前服务只绑定 `127.0.0.1`，无认证、数据库和并发控制 |

## 4. 当前默认流程

1. 选择或创建 Mission。
2. 启动 Agent Run；Demo Runtime 按时间生成上下文、知识检索、诊断和候选计划。
3. 用户审阅 Candidate 02 并批准 Patch。
4. 服务创建工作区检查点，把补丁真实写入 `runtime/mla-kernels`。
5. 提交测试矩阵；Demo Runtime 生成固定的 Correctness 和 Benchmark 进度/日志。
6. 如没有人工介入阻塞，Accept Gate 自动采用 Candidate 02。
7. 知识维护自动执行查重计划、版本化和 3 个资产发布，流程进入 `published`。
8. 用户可回退到 Patch 前检查点，或在采用后恢复 `candidate-01` 并将关联知识标记为 `superseded`。

## 5. 运行方式

开发模式：

```powershell
npm install
npm run dev
```

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:4174`
- Vite 将 `/api` 代理到 4174。

展会模式：

```powershell
npm run build
npm start
```

- Web + API：`http://127.0.0.1:4173`
- 当前用户浏览器中的 4175 是手工指定端口，不是仓库默认端口。

离线包：

```powershell
npm run demo:package
```

输出 `release/OperatorStudio-Exhibition/` 和同名 ZIP；该目录由 `.gitignore` 排除。

## 6. 持久化位置

| 内容 | 源码运行默认位置 | 离线包运行位置 |
| --- | --- | --- |
| 状态数据库 | `data/mock-db.json` | `%LOCALAPPDATA%\OperatorStudioExhibition\data\mock-db.json` |
| 工作区 | `runtime/mla-kernels/` | `%LOCALAPPDATA%\OperatorStudioExhibition\runtime\mla-kernels/` |
| 检查点 | `runtime/checkpoints/` | `%LOCALAPPDATA%\OperatorStudioExhibition\runtime\checkpoints/` |
| PID | `runtime/operator-studio.pid` | `%LOCALAPPDATA%\OperatorStudioExhibition\runtime\operator-studio.pid` |
| CLI 请求桥 | `runtime/agent-bridge/requests/` | 由 `OPERATOR_BRIDGE_DIR` 决定 |

`data/`、`runtime/`、`dist/`、`release/` 和日志均被 Git 忽略。

## 7. Git 收口说明

盘点开始时工作区已包含多项未提交业务改动，以及未跟踪的 `server/release-guard-test.mjs`。本次工作不修改或回退这些文件，文档描述的是这些改动存在时的当前工作区。文档提交只应包含 `for_programmer/`；因此，该文档 commit 本身不是一个可完全复现业务代码状态的 release tag。正式发布前仍需由代码所有者审查并单独提交现有业务改动。

## 8. 本次实际验证摘要

| 命令/流程 | 结果 |
| --- | --- |
| `npm run build` | PASS |
| `npm run test:runtime` | PASS |
| `npm run test:smoke` | PASS |
| `npm run test:release` | PASS |
| `npm start`，隔离目录、端口 4183 | PASS；首页 200，Health `ok` |
| `scripts/diagnose-exhibition.ps1 -Port 4183` | 7 项全部 PASS |
| `npm run demo:package` | PASS；ZIP 已生成 |

完整命令、覆盖范围和限制见 [TEST_PLAN.md](./TEST_PLAN.md)。
