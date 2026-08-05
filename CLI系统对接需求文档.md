# CLI 系统对接需求文档

## 0. 文档目的

本文件用于把已经在真实算子优化比赛中验证过的 CLI 系统，转换为 Operator Studio 的 Agent 接入基线。

请优先描述真实系统当前已经做到的行为，不需要为了适配网页原型而重新设计。网页端将根据这份信息适配真实的 Agent、Tool、Mission、Artifact 和审批流程。

填写时可以脱敏：不要提交 API Key、密码、私有仓库凭证或不能公开的业务数据。命令、参数、JSON 结构和脱敏后的日志越完整越好。

---

## 1. 系统概况

| 项目 | 内容 |
| --- | --- |
| CLI 系统名称 |  |
| 当前版本 / Git commit |  |
| 运行方式 | 例如 `python -m xxx`、二进制、Docker |
| 支持的操作系统 |  |
| Python / Node / CUDA / 驱动版本 |  |
| 代码仓库结构 | 主要目录和入口文件 |
| 是否允许增加 HTTP / WebSocket 服务层 | 是 / 否 / 需要评估 |
| 是否允许拆分 Agent Runtime 和执行 Worker | 是 / 否 / 需要评估 |
| 当前已验证的硬件 | 例如沐曦 C500、CUDA A100 |
| 比赛中实际完成的任务 | 算子、模型、数据规模、目标指标 |

### 1.1 真实能力边界

请分别列出以下能力目前是否真实可用：

- [ ] 读取和理解本地代码仓库
- [ ] 读取 Git 状态、提交和历史结果
- [ ] 运行构建、测试或 Benchmark
- [ ] 生成代码修改
- [ ] 生成 unified diff / patch
- [ ] 应用和回退 patch
- [ ] 调度不同硬件环境
- [ ] 收集性能、正确性和环境信息
- [ ] 自动重试或调整优化方向
- [ ] 形成知识、经验或规则
- [ ] 从历史经验中检索并复用

不能使用的能力请说明原因和替代方式。

---

## 2. CLI 端到端流程

请按一次真实成功任务的执行顺序填写。每一步都要提供命令、输入、输出和状态变化。

| 步骤 | 用户或 Agent 动作 | 实际命令 / API | 输入 | 主要输出 | 是否需要审批 |
| --- | --- | --- | --- | --- | --- |
| 1 | 创建任务 |  |  |  |  |
| 2 | 读取仓库和环境 |  |  |  |  |
| 3 | 检索经验 / Skill / Tool |  |  |  |  |
| 4 | 分析瓶颈 |  |  |  |  |
| 5 | 生成优化方案 |  |  |  |  |
| 6 | 生成代码修改 |  |  |  |  |
| 7 | 审查和应用 Patch |  |  |  |  |
| 8 | 创建测试矩阵 |  |  |  |  |
| 9 | 执行 Correctness |  |  |  |  |
| 10 | 执行 Probe / Benchmark |  |  |  |  |
| 11 | 分析结果并决定下一轮 |  |  |  |  |
| 12 | 采用候选或回退 |  |  |  |  |
| 13 | 沉淀和发布知识 |  |  |  |  |

### 2.1 最小成功案例

请提供一份可以脱敏后直接复现的成功案例：

```text
# 环境准备

# 创建 Mission

# 启动 CLI / Agent

# 关键命令

# 最终结果
# baseline:
# candidate:
# correctness:
# hardware:
# elapsed time:
```

如果任务不是通过单条命令完成，请提供完整的命令序列或一个脚本入口。

---

## 3. Agent 接入信息

### 3.1 Agent 入口

| 项目 | 内容 |
| --- | --- |
| Agent 类型 | 单 Agent / 多 Agent / Agent + Workflow |
| 启动入口 |  | 
| 是否支持长任务 | 是 / 否；最长持续时间 |
| 是否支持暂停和恢复 |  |
| 是否支持流式输出 | stdout / SSE / WebSocket / 文件 / 其他 |
| 模型供应商和模型名称 | 可脱敏，仅填写能力和版本 |
| Prompt / System instruction 存放位置 |  |
| 上下文来源 | 仓库、profile、知识库、历史任务等 |
| Agent 会话标识 | 例如 `session_id` / `run_id` |
| 并发限制 |  |

### 3.2 Agent 角色

如果是多 Agent，请逐个填写：

| Agent 名称 | 职责 | 输入 | 输出 | 可调用 Tool | 是否可修改代码 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

请说明角色之间如何协作：顺序调用、消息传递、共享状态、主 Agent 调度，还是由固定 Workflow 编排。

### 3.3 Agent Action

请提供真实 Action 示例。建议至少提供“检索经验、生成 Patch、提交测试、采用候选”四类。

```json
{
  "action_id": "脱敏后的 ID",
  "mission_id": "脱敏后的 ID",
  "agent": "Candidate Agent",
  "what": "要做什么",
  "why": "为什么现在做",
  "how": {
    "skills": [],
    "tools": [],
    "steps": []
  },
  "expected_output": [],
  "done_when": [],
  "risk_level": "low|medium|high",
  "approval_required": true,
  "status": "proposed|awaiting_approval|running|completed|failed|blocked|cancelled|rejected"
}
```

---

## 4. Tool / Skill / Runner 契约

### 4.1 Tool 清单

| Tool 名称和版本 | 用途 | 输入 Schema | 输出 Schema | 副作用 | 权限 | 是否需要审批 |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

对有副作用的 Tool，请特别说明：

- 是否写文件、执行命令、访问网络或占用硬件。
- 是否支持 dry-run。
- 是否支持幂等调用。
- 如何取消、超时和回滚。
- 如何记录输入、输出、版本和 digest。

### 4.2 Skill 清单

| Skill 名称和版本 | 解决的问题 | 必要输入 | 产物 | 适用硬件 / 算子 | 失败条件 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

### 4.3 Runner Adapter

| 项目 | C500 | CUDA / 其他平台 |
| --- | --- | --- |
| Runner 入口 |  |  |
| 构建命令 |  |  |
| Correctness 命令 |  |  |
| Benchmark 命令 |  |  |
| 环境快照内容 |  |  |
| 结果文件格式 |  |  |
| 预估执行时间 |  |  |
| 取消方式 |  |  |
| 失败和重试规则 |  |  |

---

## 5. Mission、状态和事件

### 5.1 Mission 数据

请列出一次任务必须持久化的字段：

```json
{
  "mission_id": "",
  "project_id": "",
  "repository": {},
  "goal": "",
  "constraints": [],
  "target_hardware": [],
  "metric": "",
  "baseline": {},
  "current_best": {},
  "status": "",
  "active_action_id": "",
  "created_by": "",
  "created_at": "",
  "updated_at": ""
}
```

### 5.2 状态机

请确认真实状态，补充缺失状态，并说明每个状态的进入条件：

```text
created -> planning -> awaiting_approval -> running
running -> completed | failed | blocked | cancelled
completed -> awaiting_decision -> adopted | rejected | rolled_back
```

### 5.3 实时事件

```json
{
  "event_id": "",
  "mission_id": "",
  "sequence": 0,
  "type": "action.started",
  "timestamp": "",
  "payload": {}
}
```

请提供真实事件类型，例如：

- `agent.message`
- `action.proposed`
- `action.approval_required`
- `tool.started`
- `tool.completed`
- `patch.created`
- `test_task.progress`
- `test_task.completed`
- `evidence.updated`
- `knowledge.draft_created`

---

## 6. 产物和知识沉淀

### 6.1 产物

请列出 Agent 会产生的文件或结构化产物：

| 产物类型 | 示例 | 存放位置 | 是否可下载 | 是否需要版本 |
| --- | --- | --- | --- | --- |
| Context Snapshot |  |  |  |  |
| Bottleneck Report |  |  |  |  |
| Candidate Plan |  |  |  |  |
| Patch / Diff |  |  |  |  |
| Test Plan |  |  |  |  |
| Benchmark Result |  |  |  |  |
| Decision Report |  |  |  |  |
| Experience Draft |  |  |  |  |

### 6.2 经验生成规则

请说明：

- 什么情况下会生成 Experience Draft。
- 成功经验和失败经验如何区分。
- 需要哪些证据才能发布。
- C500、CUDA 等硬件适配规则如何表达。
- 发布后 Agent 如何检索和引用。
- 经验是否需要人工维护者审批。

---

## 7. 用户和审批

| 动作 | 当前默认行为 | 需要审批的条件 | 审批后产生的事件 |
| --- | --- | --- | --- |
| 读取仓库 |  |  |  |
| 修改工作区文件 |  |  |  |
| 执行本地命令 |  |  |  |
| 提交测试 |  |  |  |
| 执行 Full Benchmark |  |  |  |
| 采用候选 |  |  |  |
| 合并代码 |  |  |  |
| 发布经验 |  |  |  |

请说明 CLI 当前是如何让用户确认的：交互式输入、配置策略、审批文件、人工命令，还是其他方式。

---

## 8. 异常、恢复和安全

请提供以下场景的真实行为：

- Agent 进程退出后如何恢复。
- Tool 超时如何处理。
- Worker 不可用如何处理。
- 测试失败是否自动重试，最多几次。
- Patch 应用一半失败如何回滚。
- 用户中断后如何继续。
- 重复提交同一个 Action 是否会造成重复执行。
- 运行命令允许访问哪些目录、网络和环境变量。
- 哪些信息必须脱敏或禁止写入日志。

---

## 9. 网页接入边界

请从以下选项中标记当前 CLI 最适合的接入方式：

- [ ] 直接调用 CLI 子进程
- [ ] CLI 提供 HTTP API
- [ ] CLI 提供 WebSocket / SSE 事件流
- [ ] 抽取为 Python Agent Runtime
- [ ] 通过 MCP Server 暴露 Tool
- [ ] 通过独立 Worker 执行，Agent 只提交任务
- [ ] 其他：

请说明哪些逻辑必须继续由 CLI 保持，哪些逻辑可以迁移到服务端或网页端。

---

## 10. 展会版验收标准

提交信息后，我们将以以下标准改造原型：

- [ ] 页面可以连接真实 CLI Agent，而不是固定演示数据。
- [ ] 输入一个优化目标后可以创建持久化 Mission。
- [ ] Agent 的计划、Tool 调用、Patch 和测试结果可实时查看。
- [ ] 用户可以在网页端审批、拒绝、暂停和恢复 Agent Action。
- [ ] Diff 和结果来自真实 CLI 产物。
- [ ] 至少一个 C500 或 CUDA Runner 可以接入；另一平台可使用契约一致的 Mock Runner。
- [ ] 刷新或重启服务后 Mission 可以恢复。
- [ ] 失败、重试、取消和回滚路径可演示。
- [ ] 每个结论可以追溯到 Agent、Tool、版本、环境和 Run。
- [ ] 不包含任何未脱敏凭证。

---

## 11. 建议提交材料

优先提交以下材料，通常不需要先提供完整源码：

1. 一次成功任务的完整 CLI 命令和脱敏日志。
2. CLI 目录结构和入口文件说明。
3. Agent / Tool / Skill 清单。
4. 一份真实的 Patch、测试结果和环境快照示例。
5. 一次失败或回退任务的日志。
6. 配置文件模板，删除密钥后保留字段结构。
7. 如果已有 API、JSON Schema、数据库表或事件定义，也一并提供。

最小可开始材料是：成功命令序列、关键日志、Patch 示例、Benchmark 结果和配置模板。有了这五类材料，就可以先做第一版真实 Agent Adapter。

