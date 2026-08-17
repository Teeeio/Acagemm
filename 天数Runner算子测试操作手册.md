# 天数智芯 Runner 算子测试操作手册

> 目的：让使用者能通过接口在**真实天数智芯 Iluvatar MR-V100 GPU** 上运行算子测试，并获取真实正确性与性能结果。
> 本文档内容均经 2026-08-17 实测验证。

## 1. 概览

- 测试平台：`gpu-iluvatar-mainstream`（天数智芯 Iluvatar MR-V100，真实 GPU）
- 运行模式：pull-runner（任务先入服务端队列，runner 上线后自动领取执行）
- 支持能力：`correctness`（正确性）、`benchmark`（性能基准）、`profile`（性能剖析）
- 并发：一次只能执行 1 个任务（串行，`max_concurrency: 1`）
- 当前状态（2026-08-17）：平台 `available`，在线 runner 1 个（节点 `d54347d75191`）

## 2. 接口与认证

```text
Base URL:  https://frp-act.com:61110
证书:      自签名，curl 需加 -k
认证:      Bearer Token（登录后获得）
```

**登录获取 Token：**

```bash
curl -kfsS -X POST https://frp-act.com:61110/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo_admin","password":"demo123"}'
```

返回：`{"access_token":"demo-token", "token_type":"Bearer", "expires_in":86400}`（24 小时有效）

后续所有业务请求加请求头：`Authorization: Bearer <access_token>`

## 3. 提交测试任务

```bash
curl -kfsS -X POST https://frp-act.com:61110/api/v1/test-jobs \
  -H "Authorization: Bearer demo-token" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-iluvatar-correctness-<唯一值>" \
  -d '{
    "system_id": "system-demo",
    "candidate_id": "candidate-demo-001",
    "test_type": "correctness",
    "scope": "demo-workspace/operator/vector_add",
    "target_platforms": ["gpu-iluvatar-mainstream"]
  }'
```

**字段说明：**

| 字段 | 必填 | 说明 |
|---|---|---|
| `system_id` | 是 | 系统标识，当前用 `system-demo` |
| `candidate_id` | 是 | 被测候选算子标识，区分不同提交 |
| `test_type` | 是 | `correctness` / `benchmark` / `profile` |
| `scope` | 是 | 算子测试作用域，如 `demo-workspace/operator/vector_add`（需是 runner 上存在的目录） |
| `target_platforms` | 是 | 目标平台，填 `["gpu-iluvatar-mainstream"]` |

**返回：** `{"id":"test-xxxx", "status":"pending"|"scheduled", "target_platforms":[...]}`，`id` 用于查询结果。

**重要 — Idempotency-Key：** 相同 Key 的重复提交会返回**之前的同一任务**（幂等）。每次新测试务必换一个唯一值（如加时间戳/随机串）。

## 4. 查询结果

```bash
curl -kfsS "https://frp-act.com:61110/api/v1/test-jobs/<任务id>?system_id=system-demo" \
  -H "Authorization: Bearer demo-token"
```

**任务状态：**

| 状态 | 含义 |
|---|---|
| `pending` / `scheduled` | 已入队，等待 runner 领取 |
| `running` | runner 正在执行 |
| `needs_review` | **执行完成并通过**（等待人工审查，视为成功） |
| `failed` | 执行失败，看 `platform_results[].error_summary` |

**通过示例（实测）：**

```json
{
  "id": "test-bdc527b0cf08",
  "status": "needs_review",
  "platform_results": [{
    "platform_id": "gpu-iluvatar-mainstream",
    "platform_name": "天数智芯 Iluvatar MR-V100",
    "status": "passed",
    "correctness": "pass",
    "node_id": "node-gpu-iluvatar-mainstream-d54347d75191",
    "evidence_id": "evidence-b4db4f9e75f2",
    "latency_us": 52.225,
    "throughput": 20078046912.4,
    "started_at": "2026-08-17T08:16:51Z",
    "finished_at": "2026-08-17T08:16:55Z"
  }]
}
```

**失败示例：**

```json
{
  "id": "test-2138f45266d7",
  "status": "failed",
  "platform_results": [{
    "platform_id": "gpu-iluvatar-mainstream",
    "status": "failed",
    "correctness": "not_run",
    "node_id": "node-gpu-iluvatar-mainstream-0b15eebdd5b2",
    "error_summary": "command exit code is non-zero"
  }]
}
```

## 5. 平台与 runner 状态

```bash
curl -kfsS https://frp-act.com:61110/api/v1/test-platforms \
  -H "Authorization: Bearer demo-token"
```

重点字段：

- 平台：`status`（`available` 可提交 / `unavailable` 无在线 runner）、`online_runner_count`、`queue_depth`
- runner：`status`（`online` / `offline`）、`last_seen_at`（最后心跳，心跳间隔 15s，超时 75s 判离线）
- 提交前建议确认平台为 `available` 且 `online_runner_count > 0`，否则任务会一直排队

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 提交后一直 `pending`，`queue_depth` 增长 | 无在线 runner。等 runner 上线自动领取执行 |
| 平台 `unavailable` | runner 心跳超时离线，需在云端把 runner 容器恢复 |
| `failed` + `command exit code is non-zero` | runner 环境问题（工作区/依赖缺失）。实测：同一提交在容器 `d54347d75191` 正常通过、在容器 `0b15eebdd5b2` 稳定失败 → **换回正常容器** |
| 重复提交返回旧任务 | Idempotency-Key 撞了，换新 Key |
| 认证报 401 | Token 过期（24h），重新登录 |
