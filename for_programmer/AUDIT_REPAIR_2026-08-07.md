# 审查修复记录（2026-08-07）

本文补充项目收口文档，记录审查报告对应的实现状态。原有 `KNOWN_ISSUES.md` 保留为历史盘点；判断当前状态时以本文、代码和下方验证结果为准。

## 已修复

| 审查项 | 修复结论 | 主要代码/验证 |
| --- | --- | --- |
| P0 CLI 启动误执行 Demo | `loadState({ runtimeMode })` 以当前 Runtime 为权威；CLI 模式不推进 Demo 状态 | `release-guard-test.mjs` 持久化 evidence fixture 后启动 CLI，状态仍停在 evidence |
| P1 Mission 串状态 | 领域状态和工作区按 Mission 保存、切换时完整恢复 | `state-store.mjs` 的 `createMissionDomainState`、`projectActiveMission`、`selectMission`；Smoke 隔离断言 |
| P1 恢复非原子 | Checkpoint 先复制到 stage，再 backup/rename；启动时清理残留 stage/backup | `replaceWorkspaceFrom`、`recoverWorkspaceSwap`；Smoke redirect/rollback |
| P1 无检查点 redirect | 没有合法 checkpoint 时返回 `409 WORKSPACE_CHECKPOINT_MISSING`，不修改流程 | Smoke 的 no-checkpoint review case |
| P1 重跑脏状态 | 新 Run 前清空旧结果、发布资产、决策和知识维护，并写入 `runHistory` | `resetMissionRunState`；Smoke rerun assertions |
| P1 CLI 旧状态串线 | 状态文件必须匹配当前 `runId`，并校验 Mission | `agent-runtime.mjs`；Runtime contract correlation case |
| P1 并发覆盖 | API 请求单进程串行；状态文件临时写入后原子 rename；Run/Checkpoint 使用 UUID | `enqueueApiRequest`、`saveState`；Smoke `Promise.all` PATCH case |
| P1 人工采用分类 | 人工/策略采用统一调用 `markCandidateAccepted`，同步更新 classification、Accept Gate 和审计 | `state-store.mjs`、`mock-server.mjs` |
| P2 阶段不可观察 | Accept Gate 和知识维护拆成两次状态推进；前端保留证据、决策和维护阶段 | `loadState` stage ordering；Smoke waits for published + maintenance completed |
| P2 Intervention 固定 Mission | 人工介入抽屉使用 active Mission、候选、测试矩阵和当前最佳数据 | `HumanInterventionDrawer`；生产构建 + 浏览器 DOM 检查 |
| P2 测试矩阵丢失 | Benchmark 接收并持久化请求体 matrix，日志按实际环境生成 | `start-benchmark`、`buildBenchmarkLogsForMatrix`；Smoke custom matrix case |

## 当前仍是边界

- Demo Runtime 的 Agent、Benchmark 数值和知识变更计划仍是本地参考数据；`liveHardware=false`，不能作为真实硬件执行证明。
- CLI 文件模式目前只支持 Mission request 和 Agent status projection；Patch、Benchmark、Decision 等动作仍返回 `RUNTIME_ACTION_UNAVAILABLE`。
- 服务仍是 localhost 单进程 JSON 存储，没有认证、租户隔离或多进程锁；适用范围是本机开发和受控测试。
- 前端没有独立单元测试或视觉回归套件，本轮用生产构建和浏览器 DOM smoke 做最低限度验证。

## 验证结果

```text
npm run build          PASS
npm run test:runtime   PASS  [runtime] adapter contract passed
npm run test:smoke     PASS  [smoke] full mission workflow passed
npm run test:release   PASS  [release-guard] CLI authority and knowledge governance passed
production start       PASS  :4185 / and /api/health returned 200
```
