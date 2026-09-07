# Test Service HTTP Client

## Purpose / Responsibilities

既有 Operator Test Service 的单次 JSON HTTP transport adapter。负责有限传输 deadline、调用者取消和稳定错误，不负责任务排队、轮询策略、重试、硬件或 Mission 规则。

## Public API

`createTestServiceClient(baseUrl?, {timeoutMs=5000,fetchImpl=globalThis.fetch}={})` 返回 `submit/get/events/cancel`。`testServiceClient` 是默认实例。URL 默认来自 OPERATOR_TEST_SERVICE_URL，否则使用 127.0.0.1 与 TEST_SERVICE_PORT（默认 4180）；此选择与原实现兼容。

| 方法 | HTTP | 输入 |
|---|---|---|
| `submit(task,options?)` | POST /v1/operator-tests | JSON task |
| `get(taskId,options?)` | GET /v1/operator-tests/:id | 编码后的 ID |
| `events(taskId,options?)` | GET /v1/operator-tests/:id/events | 编码后的 ID |
| `cancel(taskId,options?)` | POST /v1/operator-tests/:id/cancel | JSON `{}` |

options 为 `{signal?,timeoutMs?}`。每次 timeoutMs 必须有限且大于 0、不超过 120000 ms；省略时采用工厂默认值。fetchImpl 必须遵守 Fetch 的 AbortSignal 契约，返回带 text()/ok/status 的 Response。

## Inputs / Outputs / Invariants

所有请求用独立 AbortController，并组合调用者 signal；已取消调用不发请求。计时器覆盖连接、响应头及完整 response.text() 正文读取，慢速持续发送数据不会重置 deadline。取消/超时会真正 abort Fetch，不是单独放弃等待 Promise。finally 移除调用者监听并清理计时器。

返回解析后的对象 envelope；不复制业务 DTO 校验。无自动重试；redirect=error 也禁止 307/308 隐式再次发送 POST。断线/超时不表示服务端任务未创建，上层应以既有任务 ID 查询真实状态，不能盲目重新 submit。

JSON 格式错误、空成功响应、null/数组/标量 envelope，或非字符串 error/code 字段报稳定错误。保留空 HTTP 错误正文的原状态与通用错误，以及合法 HTTP error/code 字符串。

## Dependencies / Side Effects

仅使用 Web Fetch/AbortController、单调计时与定时器；默认 URL 读取环境配置。副作用限 HTTP 和计时器，无 FS、state-store、Provider、测试执行或硬件依赖。fetchImpl 可注入本地探针，不要求外网。

## Error Contract

| code | status | 含义 |
|---|---|---|
| OPERATOR_TEST_SERVICE_TIMEOUT | 504 | 传输/正文超过 deadline |
| OPERATOR_TEST_SERVICE_ABORTED | 499 | 调用者取消 |
| OPERATOR_TEST_SERVICE_JSON_INVALID | 502 | JSON 或 envelope 非法 |
| OPERATOR_TEST_SERVICE_UNAVAILABLE | 502 | 网络/Fetch 失败或被禁止的重定向 |
| OPERATOR_TEST_SERVICE_ERROR / 服务端 code | 原 HTTP status | 合法或空 HTTP 错误响应 |

错误均 `retryable=false`，不自动触发重试。已尝试 POST 的错误标记 `effectUnknown=true`，保守提示上游核实；预取消与 GET 为 false。非法端口、timeoutMs、signal 为 TypeError。cause 保留诊断原因，不代表任务终态。

## Example / Verification

```js
const client = createTestServiceClient(baseUrl, { timeoutMs: 5000 });
const task = await client.get(taskId, { signal });
```

`node tests/test-service-client-test.mjs` 使用 127.0.0.1 短命 HTTP server，覆盖正文截止、取消、错误、单次 POST 和禁止重定向。

## Change Checklist / Known Limitations

变更 URL、参数、错误码或时钟边界需同步此契约、调用者与专属测试。deadline 不是服务端执行超时，也不能证明远端已取消任务；没有任务恢复或重试业务。自定义 fetchImpl 必须实际响应 abort。未新增响应字节上限，也不抢占同步 JSON.parse。
