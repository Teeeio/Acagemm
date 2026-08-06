# 后续开发路线

本路线以“从可信展会原型走向可真实使用项目”为目标。当前收口任务没有实施以下功能。

## P0：先建立可复现基线

### 1. 审查并提交当前业务工作树

- 逐文件审查现有未提交的前端、服务端、脚本和文档改动。
- 将 `server/release-guard-test.mjs` 纳入源码提交。
- 业务提交与本次文档提交保持分离。
- 在干净工作树重新运行 `build`、三组测试、启动诊断和打包。
- 为通过验收的 commit 打 tag，记录 Node 版本和 ZIP SHA256。

完成标准：任意工程师 checkout tag 后，可复现本文件记录的测试结果，`git status` 为空。

### 2. 定义统一 Runtime Action/Event/Artifact 合约

- 将 Mission、Patch、Benchmark、Decision、Intervention、Rollback 定义为版本化命令。
- 定义状态、进度、日志、Artifact、错误、取消和幂等语义。
- 明确 Operator Studio 与 CLI/Worker 谁拥有 current best、Accept Gate 和知识版本的最终权威。
- 使用 JSON Schema 或 OpenAPI 维护机器可验证合约。

完成标准：Demo 和 CLI 使用同一合约；切换 Runtime 不需要维护两套工作流状态机。

### 3. 接通真实 CLI 动作桥

建议顺序：

1. Mission request + acknowledgement。
2. 事件流与 Agent status。
3. Candidate Plan 和真实 Diff Artifact。
4. Patch apply 到 Git worktree。
5. Test task submit、progress、logs、metrics、environment snapshot。
6. Accept Gate result 与 current best 更新。
7. 知识候选与失败经验回传。
8. Cancel、Retry、Rollback 和断线恢复。

完成标准：CLI 模式下可从新 Mission 走到发布/回退，且没有任何 `*.mock` capability 或本地伪结果。

### 4. 引入真实执行与证据可信链

- 实际连接 C500/CUDA Worker，而不是按时间推进 Benchmark。
- 保存代码 commit、Patch digest、容器/驱动/编译器、硬件、参数、原始日志和统计方法。
- Accept Gate 只能消费签名或可追溯证据。
- UI 对“历史样例”“实时运行”“导入结果”使用不同标识。

完成标准：任一性能数字可以追溯到执行环境、原始样本和候选 commit。

## P1：生产后端与领域治理

### 5. 拆分生产服务

- API 层：认证、授权、租户和请求校验。
- Workflow 层：显式状态机和幂等命令。
- Runtime Gateway：CLI/Worker 适配。
- Persistence：关系型数据库保存 Mission/Decision/Knowledge，Artifact Store 保存日志和补丁。
- Event Transport：SSE/WebSocket 或消息队列，替代全量 420ms 轮询。

完成标准：并发请求不丢状态，查询无副作用，服务可重启恢复运行任务。

### 6. 将恢复机制升级为 Git worktree

- 每个 Mission/Candidate 使用独立 worktree 和 branch。
- Checkpoint 记录 base commit、patch commit 和 provenance。
- Rollback 产生明确的新事件/commit，不静默覆盖历史。
- 处理工作区脏状态、冲突和外部修改。

完成标准：Diff、采用、撤回和回退都可用 Git 对象重放和审计。

### 7. 完善知识生命周期

- 把选项库移到组织级可维护字典，并提供版本。
- 真实实现相似度查重、适用范围判断、证据等级、冲突检测和例外审核。
- 将失败记录转为结构化负向经验，但不重新进入 Candidate 集。
- 建立 supersede、deprecate、rollback、引用影响分析。

完成标准：检索结果可按硬件/算子/dtype/layout/shape/runtime 过滤，每条知识都有证据和来源链。

## P1：前端可维护性与质量

### 8. 拆分前端模块

建议边界：

```text
src/app/             应用壳、路由、错误边界
src/api/             HTTP client、contract types
src/features/mission
src/features/agent
src/features/candidate
src/features/benchmark
src/features/decision
src/features/knowledge
src/components/      通用 OA 控件
src/styles/          token、layout、feature styles
```

- 引入 TypeScript 或至少运行时 schema 校验。
- 将 server state 与 view state 分离。
- 用查询库或事件订阅管理加载、错误、重试和缓存。

完成标准：核心页面不再依赖一个 200 KB 组件文件；每个 feature 有独立测试。

### 9. 建立浏览器回归

- 组件测试覆盖 ControlledSelect、Diff、Candidate 分类、介入面板和知识详情。
- E2E 覆盖主流程、介入、回退、刷新持久化和错误态。
- 固定展会分辨率截图，并检查遮挡、文本溢出和无障碍焦点。

完成标准：UI 变更必须通过浏览器测试和视觉基线，不能只以 Vite Build 为准。

## P2：交付与运维

### 10. 强化离线发布

- 在发布包中加入 `for_programmer/` 或单独生成开发者包。
- 校验 manifest 的脚本化入口。
- 生成 SBOM、依赖许可证清单和签名。
- 在全新 Windows 用户、无 npm、断网环境复验。
- 将诊断输出保存为机器可读 JSON 和现场日志。

完成标准：发布包有版本、来源 commit、校验、回滚说明和验收报告。

### 11. 建立可观测和故障恢复

- 为请求、Mission、Run、Action、Artifact 分配相关 ID。
- 结构化日志，区分用户错误、Runtime 错误和系统错误。
- 提供任务取消、超时、重试、恢复和死信处理。
- 明确数据备份、保留和清理策略。

完成标准：现场失败后能在不读取浏览器控制台的情况下定位到具体命令、事件和工件。

## 建议迭代顺序

| 里程碑 | 目标 | 退出条件 |
| --- | --- | --- |
| M0 可复现基线 | 收干净现有改动和发布 tag | 干净 checkout 全部 Gate 通过 |
| M1 CLI 闭环 | 真实 CLI 完成 Mission 到结果 | 无 Demo 结果混入 CLI 模式 |
| M2 真实硬件证据 | C500/CUDA Worker 和可追溯指标 | 数字可追溯到原始运行 |
| M3 生产服务 | 多用户、持久化、事件、鉴权 | 并发与恢复测试通过 |
| M4 工程质量 | 前端拆分、E2E、安全、发布治理 | 发布清单全部自动化 |

## 下一次开发开始前的检查清单

- 阅读 `PROJECT_STATE.md` 和 `KNOWN_ISSUES.md`，不要把 Mock 指标当作实机事实。
- 确认目标 Runtime 模式和权威边界。
- 从干净 branch/worktree 开始，不覆盖当前未提交业务改动。
- 对任何 API 变化同步更新 `API_CONTRACTS.md` 和 contract tests。
- 对任何状态字段变化提供 schema migration fixture。
- 对任何流程变化补 Smoke/E2E，并在独立 data/runtime 目录执行。
- 只在 `runtime.liveHardware=true` 且证据链完整时展示“实时硬件结果”。
