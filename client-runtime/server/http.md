# HTTP Helpers: Local Request Trust and Body Liveness

`createLocalHttpRequestValidator({port,serveWeb,webPort,runtimeInstance?})` also
checks an optional `x-operator-runtime-instance` connection precondition.
Supplied identity must exactly equal the composition root's current
`pid|ownerPid|startedAt`; duplicate, foreign or unsupported headers return 409
before effects. Absence preserves the existing API. The identity is public
bootstrap metadata and does not authenticate a user or broaden local trust.

## Purpose / Responsibilities

`http.mjs` 负责 JSON/SSE/static transport，本文记录本地请求信任边界、请求体解析与连接生命周期。JSON envelope、SSE 和静态资源行为仍由同目录 README 描述；不新增 workflow/state 规则。

## Public API

`createLocalHttpRequestValidator({port,serveWeb=true,webPort=5173})` 返回同步的
`validate(request) -> URL`。组合根在捕获错误的 `try` 内调用它，并在正文解析、路由和
state mutation lock **之前**拒绝不可信请求。失败抛出下表稳定 code/status；请求暂停，
经 JSON responder 发完错误后关闭连接，未发送完的正文也不延迟拒绝。

- Runtime 仍只绑定 `127.0.0.1`。Host 必须唯一、语法有效，并匹配监听端口上的
  `127.0.0.1`、`localhost` 或 `[::1]`；这些是明确的本机别名，不做 DNS 查询，
  不接受任意 `*.localhost`、短写 IP、尾点域名、用户信息或转发头。
- `serveWeb=false` 的 API-only 开发模式还接受同样本机地址上的
  `webPort..min(webPort+19,65535)`。这与 `client-runtime/dev.mjs` 的已有选端口规则一致：
  默认 `5173..5192`，环境变量 `WEB_PORT` 可指定起点。现有 Vite `/api` 代理保留
  Web Host/Origin，API proxy target 只确定连接目的地，不授予额外来源信任。
  `serveWeb=true` 的内置 Web 模式只接受自身监听端口。
- Origin 如出现，必须唯一且精确匹配上述 HTTP origins（无尾斜杠、路径、`null`、
  多来源、HTTPS 或通配符）。不依据请求反射 CORS，不信任 `Forwarded`/`X-Forwarded-*`。
- API 写请求（非 GET/HEAD/OPTIONS）携 Origin 时须 `Content-Type: application/json`
  （允许 charset）；`Sec-Fetch-Site: cross-site` 拒绝，携此浏览器元数据但缺 Origin
  的写请求也拒绝。无 Origin、无 Sec-Fetch-Site 的本地 TUI/CLI 保留既有 JSON 正文协议，
  不强加 Content-Type；Node fetch 自带的 Sec-Fetch-Mode 不作为浏览器身份判断。
- 请求目标只接受以单个 `/` 开始的 origin-form path；拒绝绝对 URL、`//` authority、
  空白、反斜杠和 fragment。URL 构造始终位于捕获范围内，错误上下文不解引用未构造的 URL。
- 受信 GET、OPTIONS、SSE 无新增正文／Content-Type 要求，仍走原只读路径。
  这是本地浏览器请求防护，不是云端认证，也不阻止本机进程主动伪造请求头。

`readJson(request,{maxBytes=1_000_000,timeoutMs=5000}={})` 返回解析 Promise。request 是 Node 可读请求流；maxBytes 为正安全整数，timeoutMs 必须有限、大于 0、最大 120000 ms。

同一 request 用 WeakMap 缓存唯一 Promise：包括进行中、成功和失败；后续调用返回相同 Promise，首调用选定大小/时间限制，后续不同选项不重读、不重新计时。组合根可在 state mutation lock 外 `await readJson(request)`，route 再读缓存。解析结果保留普通可变 JSON 值，不深冻结。

`createJsonResponder(bridge)` 仍返回 `(response,status,payload)`，保留 Content-Type、no-store、bridge 头与 `__bridge` envelope。新增：识别 response.req 对应的已停止正文，为其设置 Connection: close 并在响应完成刷出后关闭 socket。

`sendSse` / `createStaticFileHandler` 的公开参数和行为不变。

## Inputs / Outputs / Invariants

- 按 UTF-8 实际字节计数，默认最多 1,000,000 bytes；空正文返回 `{}`。合法 JSON 的 null/标量/数组保留，由应用服务自行验证业务形状。
- deadline 从首次解析开始，独立于数据流动，不是每块续期的 inactivity timeout。
- 超时/超限立即释放累计 chunks、移除解析监听并 pause 输入。无 socket 的内存流直接 destroy。
- 真实 HTTP 请求先暂停输入，保留写侧以便发出 408/413；JSON responder 等响应 finish 后 destroySoon，socket close 后显式 destroy IncomingMessage，避免遗留暂停流。
- 若调用者不响应，最多额外 1000 ms 的关闭兜底销毁 socket；不是仅 Promise.race 后遗忘流。正常响应刷出无需等待兜底。
- 成功、坏 JSON、关闭和错误都会清除解析 deadline 与监听；失败 Promise 保留用于后续一致错误。

## Dependencies / Side Effects

依赖 Node 可读流/HTTP Response、定时器，以及既有静态资源 FS/path adapter。新增副作用仅 pause/destroy 请求流、连接关闭和 WeakMap 内存缓存；不导入 state-store、应用规则、Provider 或硬件。默认使用有限墙钟定时，不读取 Mission 预算。

## Error Contract

| code | status | 行为 |
|---|---|---|
| REQUEST_HOST_INVALID | 400 | Host 缺失、重复、语法／端口非法；回包后关闭连接 |
| REQUEST_HOST_UNTRUSTED | 403 | Host 不在显式本地地址与端口集合内 |
| REQUEST_URL_INVALID | 400 | 请求目标非法或 URL 构造失败 |
| REQUEST_ORIGIN_UNTRUSTED | 403 | Origin 不受信、重复，或浏览器跨站写入 |
| REQUEST_ORIGIN_REQUIRED | 403 | 浏览器写请求有 Sec-Fetch-Site 但缺 Origin |
| REQUEST_CONTENT_TYPE_UNSUPPORTED | 415 | 携 Origin 的 API 写请求不是单一 application/json 类型 |
| REQUEST_BODY_TIMEOUT | 408 | 停止输入，允许发响应后关连接 |
| REQUEST_BODY_TOO_LARGE | 413 | 保留既有错误码，同样终止未结束输入 |
| REQUEST_JSON_INVALID | 400 | 保留既有坏 JSON 错误；正常完整正文无需关闭连接 |
| REQUEST_BODY_ABORTED | 400 | 不完整流出错/提前关闭，进入终止清理 |

非法流或选项为 Promise rejection TypeError。调用者捕获后通过 createJsonResponder 响应；如果不用该 responder，须自行及时发关闭响应，兜底仍会终止连接。

## Example

```js
try {
  await readJson(request); // composition root, before mutation lock
  await route({ request, response }); // route reads the cached Promise
} catch (error) {
  json(response, error.status || 500, { error: error.message, code: error.code });
}
```

## Verification

`node tests/http-request-liveness-test.mjs`：内存流与 127.0.0.1 短命 server，包含真实默认 5 秒、慢流、never body、408 完整到达后连接关闭与请求销毁、缓存、1 MB。`node tests/server-routes-test.mjs` 验证原 envelope/解析/route 兼容，未修改旧测试。

`node tests/local-http-trust-test.mjs`：隔离数据、工作区、bridge 的真实 Runtime，关闭 auto tick，
使用 fixture provider 与禁用硬件的后端。覆盖 TUI、同源 Web、真实 Vite proxy、自定义／顺延
开发端口、只读 API/SSE；对跨站正文、坏 Host、重复头、URL 和转发头伪装断言稳定错误、
目录未创建、状态字节不变、同一进程继续服务、拒绝后合法写入成功。临时资源在 finally 回收，
输出各组与总耗时。测试门禁和共享 README 的登记交由主助手，不在本次限定写范围内。

## Change Checklist / Known Limitations

修改大小、deadline、缓存或连接终止语义时同步本契约与专属测试。共享 README/组合根由其维护者更新。首读必须由可信 transport 选择限制；不会重构外部 mutation lock，也不处理首读之前已被其他消费者拿走的正文。同步 JSON.parse 不可被定时器抢占，但输入已有 1 MB 上限。
