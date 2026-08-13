# API Contracts

## 1. Client Runtime API

这些接口只绑定本机 Loopback，属于客户端内部接口，不是远端业务服务。

| Method | Path | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 客户端运行时健康状态 |
| GET | `/api/runtime` | Agent Adapter 连接状态和能力 |
| GET | `/api/state` | 当前产品状态 |
| GET | `/api/workspace` | 工作区文件投影 |
| GET/POST | `/api/missions` | Mission 列表/创建 |
| POST | `/api/missions/{id}/runs` | 启动 Agent Mission |
| POST | `/api/missions/{id}/select` | 切换 Mission |
| GET | `/api/missions/{id}/events` | 递增序列事件 |
| POST | `/api/actions/apply-patch` | 应用候选补丁并创建检查点 |
| POST | `/api/actions/start-benchmark` | 向 Test Service 提交测试任务 |
| POST | `/api/actions/rollback-stage` | 返回补丁应用前 |
| POST | `/api/actions/adopt` | 执行采用策略 |
| POST | `/api/actions/request-review` | 用户主动提交人工意见 |
| POST | `/api/actions/cancel-review` | 撤回未处理意见 |
| POST | `/api/actions/resolve-review` | 处理人工意见 |
| POST | `/api/actions/reject` | 拒绝候选 |
| POST | `/api/actions/revert-adoption` | 回退上一 current best |
| PATCH | `/api/knowledge/drafts/{id}` | 修改尚未固定版本的知识草稿 |
| POST | `/api/knowledge/references` | 引用知识资产 |

`POST /api/knowledge/publish` 和 `publish-all` 已退役，返回 410；知识由验证后的策略自动维护。

For `codex-cli`, `POST /api/missions/{id}/runs` starts a new Codex thread by default. Send `{ "resume": true }` to explicitly resume the last recorded thread for that Mission.

`POST /api/missions/{id}/runs/{runId}/cancel` requests cancellation through the active Agent adapter. Codex maps this to process termination; OpenCode maps it to session abort. The client persists an `agent.run_cancel_requested` event before the adapter reaches its terminal state.

### Agent result projection

The client adapter reads the last Codex `agent_message` and projects it into `state.agent.result`. A structured response should be one JSON object with `schemaVersion: "operator-studio.agent-result/v1"`, `summary`, optional `diagnosis`, `candidates`, `recommendedCandidate`, `nextAction`, and `risks`. Candidate records are normalized locally and include `id`, `title`, `hypothesis`, `change`, `files`, `classification`, `acceptGate`, `status`, and optional benchmark/evidence fields. Plain text remains a supported fallback and never fabricates a candidate.

For Codex, `files` declared by the Agent are descriptive only. The client captures the managed workspace Git Diff, rejects empty or out-of-bound changes, and makes the verified file list and SHA-256 Diff digest authoritative. `apply-patch` therefore admits the already-isolated Diff into validation; it does not write reference fixture files.

Accept Gate returns `evidenceSource` and `publishable`. Mock results (`liveHardware=false`) may pass functional and numeric gates to demonstrate the workflow, but `publishable=false`; derived assets use status `simulation` and are excluded from the formal knowledge catalog.

### SSE event stream

`GET /api/missions/{id}/events/stream?after=0` returns `text/event-stream`. Named events are `ready`, `runtime`, `state`, and `error`. `runtime` contains one persisted client event; `state` contains the latest projected client state. The browser applies state events immediately. If EventSource is unavailable or disconnected, it falls back to `GET /api/state` every 2.5 seconds. This stream is client-runtime infrastructure and does not expose remote benchmark credentials or Provider configuration.

## 2. OpenCode Runtime 上游契约

当 `OPERATOR_RUNTIME_MODE=opencode-server` 时，Client Runtime 使用 OpenCode Headless Server：

| Method | OpenCode Path | 用途 |
| --- | --- | --- |
| GET | `/global/health` | 探测版本和可用性 |
| GET | `/provider` | 读取 Provider 配置摘要 |
| POST | `/session` | 为 Mission 创建 OpenCode Session |
| POST | `/session/{id}/prompt_async` | 异步提交规划提示 |
| GET | `/session/status` | 投影运行状态 |
| GET | `/session/{id}/message` | 投影推理文本和 Tool Part |
| GET | `/session/{id}/diff` | 投影候选文件变更 |

Client Runtime 不读取或保存 OpenCode API key。当前只实现 Mission 和 Observation；Permission、Patch Approval、Abort/Retry 和 Decision 回传尚未接入。

## 3. Operator Test Service API

### `POST /v1/operator-tests`

最小请求：

```json
{
  "operator": "paged_attention",
  "metric": "latency_p50",
  "candidate": { "digest": "sha256:..." },
  "matrix": {
    "environments": ["C500", "CUDA"],
    "stages": ["Correctness", "Probe", "Full Benchmark"],
    "warmup": 50,
    "repeats": 200,
    "correctnessCases": 24
  }
}
```

响应为 `202`：

```json
{ "taskId": "test_...", "status": "queued", "submittedAt": "..." }
```

### `GET /v1/operator-tests/{taskId}`

完成响应：

```json
{
  "taskId": "test_...",
  "status": "completed",
  "progress": 100,
  "logs": [],
  "result": {
    "benchmark": [
      {
        "environment": "C500",
        "metric": "latency_p50",
        "value": 41.8,
        "unit": "us",
        "samples": 200,
        "warmup": 50,
        "correctness": { "passed": true, "total": 24 }
      }
    ],
    "tracer": { "format": "operator-trace/v1", "events": [], "criticalPathUs": 38 },
    "profiler": { "format": "operator-profile/v1", "metrics": {} },
    "environment": { "service": "operator-test-service", "liveHardware": false }
  }
}
```

### Local serial queue contract

`POST /api/actions/start-benchmark` creates a task in the client-owned persistent queue at `runtime/operator-test-queue.jsonl`. The queue owns device serialization, one active task at a time, remote submit/poll/cancel, and local auditability. The remote service remains the only benchmark/tracer/profiler execution boundary.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/operator-tests` | List local queue tasks and projected remote snapshots |
| GET | `/api/operator-tests/{id}` | Read one local queue task |
| POST | `/api/operator-tests/{id}/cancel` | Cancel a waiting or running local task |

`POST /v1/operator-tests/{taskId}/cancel` is the remote cancellation contract. The client may request cancellation; the local queue keeps the audit record even when a real worker cannot stop immediately.

### `GET /v1/operator-tests/{taskId}/events`

返回该测试任务的执行日志事件。`GET /health` 返回服务健康信息。

## 4. 禁止接口

Test Service 不得实现 `/api/missions`、Agent、Candidate、Decision、Knowledge、current best 或工作区接口。`tests/product-boundary-test.mjs` 和 `test-service/contract-test.mjs` 对此做守卫。
