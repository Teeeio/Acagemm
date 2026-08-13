# Next Steps

## Current implementation baseline

1. Local test queue and cancellation are implemented and contract-tested. The remaining production work is replacing the Mock Test Service worker, not moving queue or Agent logic to the server.
2. Codex native process bridge is implemented and contract-tested. Exhibition validation requires a working local `codex exec`; Operator Studio must not own Provider URLs, model selection, or credentials.
3. Candidate projection, authoritative Git Diff admission, client Decision/Intervention/Rollback, and Mock-safe knowledge maintenance are implemented. Do not add these responsibilities to the remote test service.

## P0：建立耐久 Harness 内核

1. 引入 `Run / Attempt / WorkspaceRevision / PatchArtifact / EvaluationJob / EvidenceBundle / GateDecision / Intervention` 稳定实体。
2. 将事件作为权威历史，现有页面状态改为可重建投影。
3. 为每个命令增加幂等键、前置版本、重试和恢复语义。
4. 逐条迁移 Candidate -> Evaluation -> Gate -> Adoption，不进行一次性重写。

## P0：迁移 Codex app-server Adapter

1. 使用持久 Thread/Turn/Item 协议替代默认一次性 `codex exec --json`。
2. 投影增量 Item、Diff、Approval、Interrupt 与 Resume 事件。
3. 保留 `codex-exec` 作为兼容和故障降级模式。
4. 增加真实用户身份下的 managed-workspace E2E。

## P0：完成 OpenCode 双向动作桥

1. 订阅 `/event` SSE，把 Permission Request 和 Session 生命周期实时投影到前端。
2. 将 OpenCode Diff 转换为 Operator Studio Candidate Schema，并绑定 Session/Message/Part ID。
3. 用户批准后响应 OpenCode Permission 或发送 Build Agent 指令，禁止规划阶段直接修改工作区。
4. 将 Accept Gate、人工意见、拒绝和回退结果写回同一 OpenCode Session。
5. 在明确授权和脱敏仓库中完成真实 Provider 端到端测试。

## P0：接入真实 Operator Test Service

1. 保持 `/v1/operator-tests` 契约，用真实调度器替换 Mock。
2. 增加候选代码/工件传输、鉴权、超时、取消和幂等键。
3. 返回真实 Benchmark、Tracer、Profiler 工件地址与环境快照摘要。
4. 增加失败分类和可重试策略。

## P1：产品和质量收口

1. 把 `App.jsx` 中 reference fixture 常量迁出到测试 fixture。
2. 增加关键路径浏览器 E2E 和移动/展屏视觉回归。
3. 将 `data/mock-db.json` 迁移为语义正确的客户端状态文件名。
4. 对大型 Diff、Tracer 和 Profiler 数据引入分页/虚拟化。
5. 完成离线包和真实 CLI 联机的展前彩排。
