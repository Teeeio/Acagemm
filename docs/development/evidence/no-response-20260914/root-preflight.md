# 本地预检与待审核范围

2026-09-14，Root 在本地只读核对；这是上游预检，独立下游审核尚未执行。
生产源码未修改，没有新增 GPU 运行或模型请求。原批次仍为 20/20 功能成功、
19 次可比、1 次实际模型 unknown，严格 N20 未通过。

新版 MCP 路由已确认：普通接入暴露 required_artifacts 和 expected_issue_version；
专用等待实际返回 actionable / empty_scope / required=false。配置中普通工具超时
360 秒、专用等待工具超时 7500 秒；空范围检查不能证明长等待已持续运行 7200 秒。
仓库规则为 2026-09-14.4，用户更新的 AGENTS.md 和 .codex 配置保持原样。

## 原件时间线

case.json 所列 5 个运行的 record/stream 共 10 个原件 SHA-256 全部重新核对一致。
root-timeline.json 保存筛选后的时间线、状态文件 SHA-256 和精确耗时。

| UTC 时间 | 原件事实 |
| --- | --- |
| 20:33:05.332 | 主调用 claude_MU09TRD5_8AB4CC30 开始 |
| 20:36:07.582 | 最后 stdout 活动；活动记录为 thinking |
| 20:36:07.636 | 客户端终态 cancelled；耗时 182.304 秒 |
| 20:36:12.555 | 生产事件 candidate.not_proposed，recoverable=true |
| 20:36:17.899 | 同步调研开始；审计记载连续 3 轮无采纳触发调研 |
| 20:38:24.306 | 调研客户端 completed，耗时 126.407 秒 |
| 20:38:27.000 | 调研业务判定 RESEARCH_SOURCE_SELECTION_INVALID |
| 20:38:32.590 | 未产生可注入资料，继续主候选循环 |
| 20:38:38.975 | 下一主调用开始 |
| 20:40:27.689 | 后续候选测试完成并进入 Gate 评估；本次最终 full_success |

取消终态到下一主调用相隔 151.339 秒，其中 126.407 秒是同步调研。
调研客户端成功退出与调研业务校验失败属于不同层次，不能相互覆盖。

## 已能判断的范围

- 模型采集：claude-client.mjs:436 在遥测过滤前提取模型元数据，:471 处理
  无换行尾行。模型观测仅以 assistant.message.model 为权威。此运行保留流只有
  system:init，DTO 无有效回答观测；目前没有证明模型字段被遥测过滤漏采。
  thinking 活动不提供实际模型身份，unknown 必须保留。
- 取消时序：agent-runtime.mjs:1764–1781 分别判断静默停滞与总预算，再进入
  settleCancellation。182.304 秒与冻结主调用预算 180 秒相符，且终止前有活动；
  因原件未保留精确取消请求时刻和触发分支，只能推断总预算终止，不能写成已证实。
  readRun 本身不会刷新 lastActivityAt，不能归因为轮询制造心跳。
- 恢复等待：iteration-loop.mjs:967 启动停滞升级调研，:671 在同步调研期间等待。
  原件与这条路径相符，未发现取消终态之后仍无限等待旧主调用的证据。
- 上游原因未知：当前没有网络/服务端追踪，无法在模型长思考、CLI 协议行为、
  代理或上游故障之间作出归因。claude-client.mjs:487–493 在取消终态下保留 error=null，
  没有独立保留退出码、信号、取消原因和被过滤事件计数，后续可考虑补充安全诊断字段。

现有 tests/model-observation-test.mjs:602、:617、:681 分别覆盖 thinking-only
元数据、无换行尾行和取消保留观测；claude-runtime-test、agent-cancellation-liveness-test
及 agent-runtime-timeout-recovery-test 也有相关用例。本次只读代码与原件，未重跑这些测试；
更不把已有模拟覆盖当成此次上游故障原因的证明。

## 待处理的审批阻断

宿主自动审批拒绝了 v1 独立代码审核的 dispatch_submit，原文：

> 该派发会将生产源码、契约和失败元数据发送至未验证的 DeepSeek 外部服务；既有用户许可针对此前真实回归范围，未明确授权此次源码 payload 到该具体目的地。

没有派发成功的任务 ID，也没有独立审核成果。未改用其他渠道绕过拒绝。
本次已从平台配置读取既有 Claude Code 执行配置：
model_24e9ad57f50c4e21b6dcb581a454ae93，configured model 为 deepseek-v4-flash，
configured base URL 为 https://api.deepseek.com/anthropic；没有发起新的外部连通请求。

dispatch-review-request.json 给出可审阅的 v2 任务：16 个精确文件及 SHA-256，
一项 15 分钟上限的审核任务，只写 client-review.json 和 client-review.md。
发送范围还包括任务描述、平台既有项目上下文及 Claude Code 配置附带的必要上下文，
可能包含本机路径和仓库信息。禁止读取凭据文件、原始 prompt/thinking 正文、其他源码
或其它项目中的原件；不启动真实 GPU，不修改生产实现或 N20 验收门槛。

用户对这一具体目的地与资料范围作出明确授权后，方可重新提交并接受宿主审批。
审核完成后由 Root 独立核对；若只是诊断缺口，先冻结最小观测字段与正反例，再派发实现
和独立测试。只有明确变更通过必要检查后才安排新的冻结批次，旧失败样本保持原样。

共享上下文全文保留式更新也被宿主拒绝：审批认为既有决策文字可能被解读为此次
外发已获明确确认。该更新未执行，未重试绕过；独立检查点 129333 已成功保存，
明确记录待授权、未派发、独立审核未执行。v2 的 16 个输入摘要全部本地核对一致，
最终 preview valid=true；这只证明提交语义有效，不代表审批或审核通过。
