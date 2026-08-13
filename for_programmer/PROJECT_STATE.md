# Project State

## 2026-08-12 implementation update

- The operator test queue is now a real client-side module at `client-runtime/operator-test-queue.mjs`. It persists JSONL tasks, enforces one active task, polls the remote boundary, and records cancellation locally.
- The remote test service remains Mock by design. It only accepts operator test tasks and returns benchmark, tracer, profiler, logs, and cancellation snapshots.
- A Codex-first native adapter is now implemented at `client-runtime/codex-client.mjs`. Set `OPERATOR_RUNTIME_MODE=codex-cli`; the adapter requires only an available Codex executable, starts `codex exec --json`, inherits the local Codex configuration, persists JSONL events, and projects thread/tool/message state into the local Mission. Official login status is diagnostic only.
- The Codex adapter is implemented and contract-tested with an injected process runner; real credentials and a live provider are not exercised by automated tests.
- Codex Candidate files are now verified against the authoritative Git Diff in a managed Mission workspace. Client-owned Decision, Intervention, Rollback, and Adoption Revert actions are available for both `reference-fixture` and `codex-cli` modes.
- Accept Gate requires an explicit numeric performance target. Mock test results remain usable for workflow demonstrations, but are marked `publishable=false`; their knowledge output is `simulation` and is excluded from the formal knowledge catalog.
- Mission completion is derived from the terminal workflow state (`published` plus completed knowledge maintenance), not from one Agent Run finishing.

## 当前结论

代码已经拆分为客户端本地运行时和单一职责的 Operator Test Service Mock。默认启动不再生成 Demo Agent 数据；Agent 未连接时产品明确显示未连接。

| 能力 | 状态 | 证据/限制 |
| --- | --- | --- |
| React OA 风格产品 UI | 已真实实现并可构建 | `npm run build`；浏览器核验默认未连接态 |
| 本地 Mission/流程/工作区/检查点 | 已真实实现并通过 Smoke | 文件系统写入和状态持久化由 Smoke 覆盖 |
| 人工意见、阻塞、撤回、采用回退 | 已真实实现并通过 Smoke | 客户端动作不依赖 Agent 类型；CLI-file 兼容模式除外 |
| 自动知识维护 | 已真实实现并通过 Smoke/Gate | Mock 只生成仿真预览；真实 Level 3 才正式发布 |
| Operator Test Service HTTP 契约 | 已真实实现并通过契约测试 | 执行数据本身为 Mock |
| Benchmark/Tracer/Profiler 消费链路 | 已真实实现并通过 Smoke | Client Runtime 提交、轮询和落状态 |
| Codex Agent 启动/恢复与 JSONL 投影 | 已实现并有契约测试 | 自动化使用注入进程；本机 Codex 配置由 Codex 自身负责 |
| 旧 CLI 文件状态投影和 Mission 请求 | 已实现并有 Runtime contract 测试 | 兼容适配器，文件协议依赖真实 CLI 产物 |
| Codex Candidate/Patch/Decision 客户端闭环 | 已实现并有 Codex/Workspace/Smoke 测试 | 仍基于一次性 `codex exec --json`，未迁移 app-server |
| 旧 CLI-file Candidate/Patch/Decision 双向桥 | 仅存在边界设计，未实现 | 兼容适配器仍返回 `RUNTIME_ACTION_UNAVAILABLE` |
| OpenCode Headless Server 接入 | 已实现并通过 Mock 契约测试 | 真实 Server 1.1.25 的健康、Session、Message、Diff 已探测 |
| OpenCode Provider 模型调用 | 已尝试但未成功 | 隔离运行目录没有 API key；Zen 返回 401，OpenAI Provider 报 key missing |
| OpenCode Patch/Decision 回传 | 仅存在设计，没有实现 | 当前模式只支持 Mission 和状态/工件观察 |
| 真实 C500/CUDA 执行器 | Mock/占位 | Test Service `liveHardware=false`；不会发布正式知识 |
| 完整浏览器 E2E | 未充分验证 | 当前主要为 Build、API Smoke 和人工浏览器核验 |

## 运行命令

```powershell
npm run dev
npm run build
npm start
```

## 测试命令

```powershell
npm run test:runtime
npm run test:test-service
npm run test:boundary
npm run test:opencode
npm run test:smoke
npm run test:release
```

本文件描述当前工作区代码，不把 Mock 结果、CLI-file 动作桥或尚未实现的耐久工作流内核描述为已交付能力。
