# Operator Studio 展会手册

## 展前准备

1. 确认本机 `codex exec` 已可正常调用；默认 `codex-cli` 模式会直接沿用本机 Codex 的 Provider、模型与认证并自动启动或恢复 Agent。
2. 依次运行八组测试和 `npm run build`。
3. 运行 `npm run demo:package` 生成离线包。
4. 在展机启动后运行 `展会诊断.cmd`，所有检查必须为 PASS。

`reference-fixture` 只用于自动化测试，展会诊断会主动拒绝该模式。

## 五分钟展示主线

| 时间 | 操作 | 展示重点 |
| --- | --- | --- |
| 0:00-0:50 | 创建或打开 Mission | 本地客户端持有目标、仓库、硬件和 Agent 上下文。 |
| 0:50-1:40 | 查看 Agent 推理与工具调用 | 所有步骤来自已连接 Agent，未连接时不显示伪造记录。 |
| 1:40-2:30 | 比较候选并审阅 Diff | 候选按通过门禁、弱候选、失败记录分层；失败不进入候选集。 |
| 2:30-3:30 | 应用 Patch 并运行测试 | 工作区真实修改；远端服务只返回 Benchmark/Tracer/Profiler。 |
| 3:30-4:20 | 查看 Accept Gate 与人工介入 | 默认策略自动决策，人工意见仅在需要时阻塞。 |
| 4:20-5:00 | 查看知识维护 | 成功经验和失败经验都可检索、复用并追溯证据。 |

## 现场口径

- 可以说：Operator Studio 是本地 Agentic IDE，Agent 和业务流程不托管在测试服务端。
- 可以说：当前测试服务使用 Mock，但请求、轮询、Benchmark、Tracer、Profiler 契约是真实实现。
- 可以说：Patch、检查点、状态持久化、策略流程和知识维护都在客户端真实执行。
- 不应说：Mock 返回的 C500/CUDA 数字是现场硬件实测。
- 不应说：Codex 已经完成全部领域动作协议；当前 JSONL 运行桥已接通，但结构化 Candidate/Patch/Decision 回写仍需完善。

## 故障恢复

1. 页面打不开：运行 `展会诊断.cmd`，检查 Client Runtime。
2. 测试不启动：检查 `http://127.0.0.1:4180/health` 和 `OPERATOR_TEST_SERVICE_URL`。
3. Agent 未连接：运行 `codex --version` 检查命令；若 Run 启动后失败，直接用本机 `codex exec` 核对其 Provider 与认证配置。
4. 状态不适合展示：仅在确认不需要保留当前数据后运行 `npm run demo:reset`。
5. 不得切换到 `reference-fixture` 冒充真实闭环；Codex 事件、候选和工具调用必须来自真实 thread。
