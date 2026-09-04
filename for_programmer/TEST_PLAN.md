# Test Plan

## Added implementation gates

- `npm run test:queue`: validates persistent local serial operator-test queue, remote submit/poll, and cancellation.
- `npm run test:codex`: validates Codex CLI probe/login, `codex exec --json` invocation, resume/cancel, JSONL event persistence, structured Candidate parsing, thread projection, and completion.
- `npm run test:boundary`: validates that SSE does not block the serialized API queue and that the remote test-service boundary remains narrow.

2026-08-12 verified results: `test:gate`, `test:codex`, `test:runtime`, `test:queue`, `test:workspace`, `test:intent`, `test:test-service`, `test:opencode`, `test:smoke`, and `build` pass. The final re-run of `test:release` and `test:boundary` was not executed because the external privilege reviewer disconnected; earlier repository evidence reported them passing, but this update does not claim a fresh run.

## 自动化门禁

| 命令 | 覆盖范围 | 通过标准 |
| --- | --- | --- |
| `npm run test:runtime` | `unavailable`、`cli-file`、`reference-fixture` Adapter | 显式禁用不伪造、CLI 探针和 Mission 请求正确 |
| `npm run test:test-service` | Operator Test Service 契约 | 202、轮询、Benchmark/Tracer/Profiler、未知任务、禁止 Mission API |
| `npm run test:boundary` | 产品职责边界 | 默认 Agent 不运行；Test Service 不暴露业务 API |
| `npm run test:opencode` | OpenCode HTTP Adapter | Session、Prompt、Message、Tool、Diff、Provider 错误投影 |
| `npm run test:gate` | Accept Gate 与证据治理 | 数值目标必需；Mock/Live 发布能力隔离；失败候选处置 |
| `npm run test:workspace` | Mission 工作区 | 隔离快照、权威 Git Diff、路径边界 |
| `npm run test:smoke` | 本地完整闭环 | Patch、检查点、测试提交/轮询、证据、决策、知识、恢复 |
| `npm run test:release` | 发布守卫 | 不越权使用 fixture、旧发布 API 退役、知识不可变等 |
| `npm run build` | 前端编译 | Vite 成功且无编译错误 |

## 浏览器验收

1. 默认启动不设置 Agent 环境变量，页面应显示 Agent 未连接。
2. 页面不得出现 Candidate 02、41.8 或固定“24/24”等历史完成态。
3. 连接 CLI 后，Agent 状态、Mission 和事件来自 CLI 投影。
4. Benchmark 完成后，页面数值来自 `benchmark.result`，刷新后保持一致。
5. Test Service 不可用时，页面显示服务错误，不生成本地假结果。
6. 人工意见触发后顶栏出现明显待处理状态，处理或撤回后恢复。

## 发布验收

跨模块变更运行 `npm run verify:local-c500-release`；无硬件变更还应运行
`npm run verify:non-hardware-robustness`。生产启动默认使用受支持的本地 Agent Runtime；
`reference-fixture` 只允许用于自动化测试，不能作为生产证据来源。
