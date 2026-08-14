# 展会交付验收

## 必须通过

- `npm run build` 成功。
- 16 组测试全部通过：Runtime、Queue、Test Service、Boundary、OpenCode、Codex、Smoke、Release Guard、Workspace、Three-Layer、Intent、Gate、Research、Loop、Journal（及 Build 门禁）。
- `npm start` 后 Client Runtime 的 `/api/health` 和 Test Service 的 `/health` 均返回 `status: ok`。
- `展会诊断.cmd` 的 Runtime authority 必须为 PASS；默认要求本机 `codex-cli` 可执行，Provider 与认证由 Codex 自身负责，`unavailable` 和 `reference-fixture` 均不能通过展会诊断。
- 断开公网后，页面、Logo、本地状态和 Mock 测试服务仍可使用。

## 核心闭环

- Codex Agent 的 thread、运行事件、消息和工具调用能进入本地 Mission 状态；未连接时页面明确显示未连接，不生成新的样例结果。
- Candidate Diff 可逐文件查看，应用补丁会真实写入隔离工作区并生成恢复检查点。
- 客户端只把算子测试任务提交给 Test Service；服务返回 Benchmark、Tracer 和 Profiler。
- 测试完成后，Accept Gate 根据证据自动给出策略结果；只有用户发起意见或命中风险信号时才阻塞人工处理。
- 失败运行不保留为候选，但保留审计记录并可提取负向经验。
- 采用、回退、知识提取和知识版本关系均持久化且可审计。
- 研究员子 Agent 可真实联网调研（arXiv/GitHub 公开来源），产出带来源笔记并经价值闸注入下一轮；`npm run research:smoke` 真机两轮 PASS。

## 当前交付缺口

- Codex 原生运行桥已完成启动、恢复和 JSONL 状态投影；结构化 Candidate/Patch/Decision 的完整双向领域协议仍需实现。
- Test Service 是契约级 Mock，不代表真实 C500/CUDA 硬件测试。
- `data/mock-db.json` 名称尚未迁移，但该文件属于客户端本地数据，不是服务端数据库。

以上缺口未关闭前，可以进行产品和接口联调，但不能宣称已经完成真实 Codex Agent 全闭环或真实硬件验收。
