# Known Issues

- **P0: the workflow is not yet a durable event-sourced harness.** Runtime events exist, but mutable `stage`, Agent, benchmark, review, and knowledge states remain the primary persistence model. Crash-safe attempt replay, idempotent step execution, and checkpoint-based orchestration are not complete.
- **P0: Codex still uses one-shot `codex exec --json`.** Managed workspace, authoritative Diff, Candidate admission, client Decision, Intervention, Rollback, and knowledge projection are connected, but persistent app-server Thread/Turn/Item streaming is not implemented.
- **P0: Queue cleanup and real device lease are not implemented.** The local queue is persistent, serial, and cancellable, but environment cleanup and hardware ownership are still hooks to add when the real worker is connected.
- **P1: Real structured Codex E2E is environment-dependent.** A user-terminal Codex run has completed successfully, but the isolated automated process did not inherit the user's local Provider authentication and returned HTTP 401. Structured Candidate projection is contract-tested, not yet verified end to end under the user's terminal identity.

1. **P1：旧 CLI 文件动作桥未闭环。** `cli-file` 只实现 Mission 请求与状态投影；该兼容适配器的 Candidate、Patch、Decision 输入输出协议尚未接入。
2. **P0：真实硬件测试未接入。** `test-service/mock-server.mjs` 返回确定性 Mock 数据，所有结果标记 `liveHardware=false`。
3. **P0：OpenCode 动作桥未闭环。** 已接入 Session、Message、Tool 和 Diff，但 Permission、Patch Approval、Decision 和 Retry/Abort 尚未接入。
4. **P1：OpenCode 真实模型尚未完成成功调用。** 本机 OpenCode Server 1.1.25 可用，但隔离数据目录没有 Provider API key；实际 Mission 外发需要用户明确授权。
5. **P1：前端仍保留 reference fixture 常量。** 正式 Mission 优先使用后端状态，但历史资产和多个回退默认值仍在 `App.jsx`，应迁移为独立 fixture 包并禁止产品模式回退。
6. **P1：本地数据库文件名有误导性。** `data/mock-db.json` 实际是客户端状态文件，建议迁移为 `operator-studio.json` 并提供兼容读取。
7. **P1：Test Service Mock 任务只存内存。** 服务重启后任务消失；真实实现需要持久化或由任务调度系统提供恢复能力。
8. **P1：浏览器自动化覆盖不足。** 当前 UI 主要依赖 Build、API Smoke 和人工浏览器核验，尚缺关键路径 Playwright 回归。
9. **P2：远端鉴权、租户隔离、上传协议未设计。** 当前契约只覆盖本地原型所需字段。
10. **P2：开发沙箱可能触发 Git dubious ownership。** 正常 Windows 用户启动不受影响；自动化环境应使用明确的仓库所有权和独立临时目录。
