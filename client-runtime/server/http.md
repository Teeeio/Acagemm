# HTTP Helpers: Body Liveness

## Purpose / Responsibilities

`http.mjs` 负责 JSON/SSE/static transport，本文记录请求体解析与连接生命周期。JSON envelope、SSE 和静态资源行为仍由同目录 README 描述；不新增 workflow/state 规则。

## Public API

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

## Change Checklist / Known Limitations

修改大小、deadline、缓存或连接终止语义时同步本契约与专属测试。共享 README/组合根由其维护者更新。首读必须由可信 transport 选择限制；不会重构外部 mutation lock，也不处理首读之前已被其他消费者拿走的正文。同步 JSON.parse 不可被定时器抢占，但输入已有 1 MB 上限。
