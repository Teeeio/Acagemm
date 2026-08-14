# Decisions

## 2026-08-07 local execution boundary

- Operator test serialization belongs to the client. The queue owns device locking, cleanup hooks, submit/poll/cancel state, and audit history; the remote service is intentionally limited to benchmark/tracer/profiler execution.
- Codex is the first native Agent adapter. The client starts `codex exec --json` and projects its JSONL events; users do not manually launch or resume Codex for normal product use.

## D-001 本地 Agentic IDE

Agent 推理、工具调用、候选、工作区、流程、决策、知识和 current best 全部属于客户端。原因是现有 CLI 已验证有效，产品目标是给该能力提供可视化、可审计和可恢复的本地工作台，而不是把 Agent 搬到中心服务。

## D-002 测试服务单一职责

远端只接收算子测试任务，返回 Benchmark、Tracer、Profiler 和执行元数据。这样硬件资源可以集中调度，同时代码上下文、Agent 过程和知识资产留在用户设备。

## D-003 默认拒绝伪造 Agent 数据

默认 Runtime 为 `codex-cli`，只自动探测本机 Codex 可执行文件；Provider、模型、base URL 和认证由本机 Codex 管理。命令不可用时显式降级，绝不生成 Agent 数据。只有自动化测试显式设置 `reference-fixture` 才生成参考数据；展会诊断拒绝该模式。

## D-004 Accept Gate 默认自动化

证据满足策略时自动形成采用建议。人工意见是条件式介入：用户主动提交或风险信号命中时阻塞，不把每次优化都变成人工审批关卡。

## D-005 失败不进入候选集但保留记录

完全失败的运行从候选比较中排除，仍保留审计和负向经验，用于避免重复错误。弱候选可以保留为参考，但不能更新 current best。

## D-006 本地 HTTP 是实现细节

`client-runtime/local-server.mjs` 使用 Loopback `/api` 连接 React UI。这是桌面/本地客户端内部通信，不改变“远端服务只负责测试”的产品边界。

## D-007 真实 CLI 协议不猜测

当前只按已知文件实现 status 投影和 Mission 请求。Candidate/Patch/Decision 格式未得到真实 CLI 契约前保持显式不可用，避免通过固定数据伪装接通。

## D-008 OpenCode 使用 Headless Server API

OpenCode 集成使用其官方 Headless Server HTTP API，不解析终端彩色文本。Session、Message、Tool Part 和 Diff 都保留原始 OpenCode ID；第一阶段使用只读 `plan` Agent，Patch 和 Decision 回传完成前不允许通过展会诊断。

## D-009 Agent 动作与客户端工作流动作分离

Codex 负责推理并在受管 Mission workspace 中形成真实 Diff；客户端负责 Candidate 准入、测试排队、Accept Gate、人工介入、采用和回退。这些动作不能因为 Agent Adapter 不同而被禁用。`cli-file` 与 OpenCode 只有在缺少权威 Candidate/工作区契约时继续显式拒绝。

## D-010 Mock 证据不等于 Level 3

`liveHardware=false` 的结果可以验证 Benchmark、Tracer、Profiler、Gate、决策和知识维护链路，但 `publishable=false`，知识状态为 `simulation`，不得进入正式知识目录。只有真实硬件证据满足 Gate 时才发布固定知识版本。

## D-011 Mission 完成由工作流终态决定

Agent Run 完成只表示本轮 Agent 已停止输出，不表示 Mission 完成。Mission 仅在采用、知识维护和发布终态完成后标记 `completed`。

## D-012 研究员子 Agent：勿增实体，复用既有机制

主优化线程之外设立研究员子 Agent（第二个 Codex 线程，开放沙箱联网，纯只读产笔记），解决"主 agent 死磕小方向、忽略大方向"的问题。设计遵循"若无需要，勿增实体"：

- **不新增全局 planner 实体**。"策略/编排"职责已在 `iteration-loop.advanceIteration`，"外部大视野"职责就是研究员本身。新增 planner 会与循环抢编排权、与研究员抢外部视野，属于重复实体。
- **全局 ROI 判断由研究员承担**：简报列出已尝试方向与失败原因，要求它从算子全局角度排序（最容易收益 vs 低 ROI 死磕陷阱），明确回答"继续还是换方向"。
- **死磕检测是触发器不是裁决器**：`detectTunnelVision` 只标"同一方向重复无进展失败"（收敛守卫——错误码在变则放行，避免误伤需要耐心的方向），命中后仅异步触发研究员做第二意见，不自己否决方向。
- **并行/串行按触发来源**：停滞升级=同步（下一轮依赖调研结果，串行等待）；隧道视野/操作员=异步（主线程继续，研究员并行审查）。
- **研究员产物永不进候选池**：候选准入仍由工作区 Git Diff 把关，调研笔记只是上下文。
