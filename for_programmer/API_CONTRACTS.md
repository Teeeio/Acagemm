# HTTP API 合约

## 1. 基本约定

- 展会模式基址：`http://127.0.0.1:4173`。
- 开发模式 API：`http://127.0.0.1:4174`；浏览器从 5173 通过 Vite 代理访问相对路径 `/api`。
- 服务只监听 `127.0.0.1`。
- 请求体为 JSON；没有请求体时按 `{}` 处理。
- 成功响应通常是 `{ state }`、`{ runtime }` 或带附加结果的对象。
- 错误响应为 `{ error: string, code?: string }`。
- API 响应包含 `Cache-Control: no-store`。
- 没有身份认证、租户、CSRF、幂等键或 API 版本前缀。

## 2. Runtime 与查询接口

| Method | Path | 输入 | 成功输出 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | 无 | `{status, service, persistence, runtime, time}` | 健康与 Runtime 真值；本次验证 `status=ok` |
| GET | `/api/runtime` | 无 | `{runtime}` | Runtime descriptor |
| GET | `/api/state` | 无 | `{state}` | Demo 模式可能推进 Agent/Benchmark/自动采用，不是严格只读 |
| GET | `/api/workspace` | 无 | `{patchApplied, workspace, files}` | `files` 是服务端定义的 Diff 模型，不读取任意仓库文件 |
| GET | `/api/missions` | 无 | `{missions, activeMissionId}` | Mission 列表 |
| GET | `/api/missions/{id}/events?after=N` | path id；可选序号 | `{missionId, events, nextSequence}` | 只返回对应 Mission 且 `sequence > after` 的事件 |

## 3. Mission 接口

| Method | Path | 请求体 | 成功 | 主要失败 |
| --- | --- | --- | --- | --- |
| POST | `/api/missions` | `{goal, title?, repository?, hardware?, metric?}` | 201 `{state}`；创建并选中 Mission | 400 goal 为空；409 Mission 暂停 |
| POST | `/api/missions/{id}/select` | `{}` | 200 `{state}` | 404 Mission 不存在 |
| POST | `/api/missions/{id}/runs` | `{goal?}` | 202 `{state}` | 409 暂停；CLI 未连接时 503 |

CLI 模式的 Run 只会写出请求：

```json
{
  "schemaVersion": 1,
  "requestId": "cli_...",
  "missionId": "MIS_...",
  "repository": "mla-kernels",
  "goal": "...",
  "targetHardware": ["C500"],
  "metric": "latency p50",
  "status": "requested",
  "createdAt": "ISO-8601"
}
```

## 4. 流程动作接口

| Method | Path | 请求体 | 前置条件 | 成功和副作用 |
| --- | --- | --- | --- | --- |
| POST | `/api/actions/apply-patch` | `{candidate:"candidate-02"}` | `stage=candidate`；currentAction=`candidate.plan`；Demo 模式 | 200 `{state, workspace}`；创建检查点并真实写工作区 |
| POST | `/api/actions/start-benchmark` | `{matrix?}`，当前服务实际使用已持久化矩阵 | `stage=validation`；currentAction=`test.plan`；Patch 已应用；Demo 模式 | 202 `{state}`；创建运行态 Benchmark |
| POST | `/api/actions/rollback-stage` | `{}` | `stage=validation/evidence`；无待审介入；Demo 模式 | 200 `{state,recovery}`；恢复 Patch 前检查点，后续工件失效 |
| POST | `/api/actions/adopt` | `{candidate?,note?}` | `stage=evidence`；Benchmark complete；无待审介入；Demo 模式 | 200 `{state,maintenance}`；采用并自动维护知识；完成后重复调用幂等 |
| POST | `/api/actions/reject` | `{candidate?}` | `stage=evidence`；currentAction=`adoption.decision`；Demo 模式 | 200 `{state}`；返回 validation 并要求补充验证 |
| POST | `/api/actions/revert-adoption` | `{}` | `stage=published`；存在检查点；Demo 模式 | 200 `{state,recovery}`；恢复 candidate-01，知识标记 superseded；重复调用幂等 |
| POST | `/api/reset` | `{}` | Demo 模式 | 200 `{state}`；重建 seed、工作区和检查点 |

通用保护：`missionPaused=true` 时大部分变更动作返回 409。CLI 模式中涉及本地结果的动作返回：

```json
{
  "error": "CLI Runtime 尚未实现对应动作桥；已拒绝生成本地 Demo 结果。",
  "code": "RUNTIME_ACTION_UNAVAILABLE"
}
```

## 5. 人工介入接口

| Method | Path | 请求体 | 约束 | 结果 |
| --- | --- | --- | --- | --- |
| POST | `/api/actions/request-review` | `{outcome,note,submittedBy?}` | outcome 为 `adopt/supplement/redirect`；note 至少 4 字符；阶段决定可用 outcome | 202；`decisionReview=awaiting_review` 并阻塞自动采用 |
| POST | `/api/actions/cancel-review` | `{}` | 存在 currentAction `review.resolve` | 200；恢复原阶段动作；若 evidence 已完成则继续自动采用 |
| POST | `/api/actions/resolve-review` | `{outcome?,note?}` | 必须存在待处理 request | adopt 采用；supplement 返回 validation；redirect 恢复检查点并返回 candidate |

阶段允许范围：

| 阶段 | 可请求结果 |
| --- | --- |
| `candidate` | `redirect` |
| `validation` | `supplement`、`redirect` |
| `evidence` | `adopt`、`supplement`、`redirect` |

关键错误码：`DECISION_REVIEW_PENDING`、`DECISION_REVIEW_NOT_PENDING`、`DECISION_REVIEW_NOTE_REQUIRED`、`INTERVENTION_OUTCOME_UNAVAILABLE`、`INTERVENTION_ADOPTION_UNAVAILABLE`、`INTERVENTION_VALIDATION_UNAVAILABLE`、`DECISION_REVIEW_OUTCOME_INVALID`。

## 6. 知识接口

| Method | Path | 请求体 | 成功/失败 |
| --- | --- | --- | --- |
| PATCH | `/api/knowledge/drafts/{id}` | 允许字段的局部 patch | 200 `{state}`；404 不存在；发布后 409 `KNOWLEDGE_IMMUTABLE`；非法字段 400 `KNOWLEDGE_PATCH_REJECTED` |
| POST | `/api/knowledge/references` | `{assetId,title,version,reason?}` | 200 `{state,reference}`；缺必填项 400 |
| POST | `/api/knowledge/publish` | 任意 | 410 `KNOWLEDGE_PUBLISH_RETIRED` |
| POST | `/api/knowledge/publish-all` | 任意 | 410 `KNOWLEDGE_PUBLISH_RETIRED` |

没有独立的 `GET /api/knowledge`。知识草稿、发布资产、失败经验和引用都通过 `/api/state` 返回。

草稿可写字段：

```text
title, conclusion, scope, hardware, operator, dtype, layout, shape, runtime,
trigger, procedure, expectedGain, validation, constraints, contraindications,
failedAttempts, evidenceLevel, confidence, evidenceRefs, sourceMission,
sourceCandidate, sourceCommit, owner
```

## 7. 通用状态补丁

`PATCH /api/state` 只接受并保存以下顶层字段：

- `testMatrix`: 必须至少包含一个 `environments` 和一个 `stages` 项。
- `workspace`
- `unreadCount`
- `missionPaused`

其他字段会被忽略；该接口没有字段级类型校验和权限控制。

## 8. `state` 主要字段

| 字段 | 类型/示例 | 语义 |
| --- | --- | --- |
| `schemaVersion` | `4` | 本地状态 schema |
| `stage` | diagnosis/candidate/validation/evidence/curation/published | 活动 Mission 阶段 |
| `activeMissionId`, `missions` | string, array | Mission 选择与快照 |
| `agent` | object | 状态、阶段、进度、当前动作、消息、工件、工具调用 |
| `runtime` | object | Runtime 模式、权威、连接探针和 capabilities |
| `runtimeEvents` | array | 最多 500 条、按 Mission 递增 sequence |
| `benchmark` | object | idle/running/complete、进度、runId、日志 |
| `testMatrix` | object | 环境和验证阶段 |
| `patchApplied` | boolean | 活动工作区是否应用候选补丁 |
| `decisionReview` | object | 策略、请求、阻塞和处理结果 |
| `workflowRecovery` | object | worktree 状态、检查点、恢复和失效工件 |
| `currentBest` | object | 当前采用候选及指标 |
| `candidateEvaluations` | array | accepted/weak_reference/failed 等分类 |
| `failureRecords` | array | 被移除候选的失败事实和提取经验 |
| `knowledgeDrafts` | array | 结构化知识草稿 |
| `publishedAssets` | array | 自动维护后的固定版本资产 |
| `knowledgeMaintenance` | object | 策略、变更计划、统计、回退 |
| `knowledgeReferences` | array | 当前/历史 Mission 引用关系 |
| `auditEvents` | array | 最多 30 条 UI 审计摘要 |

## 9. Runtime Event 合约

```json
{
  "eventId": "evt_..._12",
  "missionId": "MIS_...",
  "sequence": 12,
  "type": "decision.auto_adopted",
  "timestamp": "ISO-8601",
  "source": { "kind": "policy", "mode": "demo" },
  "payload": {}
}
```

- `sequence` 在当前 state 的事件数组上单调递增。
- 数组保留最近 500 条。
- Events 查询以 `after` 做增量读取，但不是 SSE/WebSocket。
- 目前没有跨进程事务保证；事件与状态一起写入同一个 JSON 文件。

## 10. 静态文件回退

非 `/api/` 请求从 `dist/` 读取；文件不存在时回退到 `dist/index.html` 以支持 SPA。`SERVE_WEB=false` 时返回 404 JSON。当前只按扩展名设置少量 MIME 类型。
