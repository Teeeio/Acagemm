# 第13样本无响应/取消恢复：独立代码审核（client-review）

范围：83b91d6 正式 N20 第 13 次原始尝试 `claude_MU09TRD5_8AB4CC30`（invocation 13，来源任务
`task_44338a002ba04dc4b366153587a55704` / run `run_76cc2f681aa74985a1113187b36728dc`）。
本报告只读、只审核，未修改任何生产源码，未启动业务 E2E、GPU 或额外 CLI/网络请求，未重放或替换样本。
平台审核 worker 本身是经 Claude Code 调用外部模型的执行，故本报告不声称"零外部模型调用"。
结论与 `client-review.json` 的 22 条 finding 一致（编号 FR-01..FR-22）。
本版为第三版：按第二轮独立审核反馈修正取消覆盖误读——明确 projection 取消用例经真实 `createAgentRuntime`
进入 `requestCancellation`/`settleCancellation` 的**正常成功路径**，只有 single-flight 复用、deadline 实际到期、
重试耗尽/`needs_human` 这些**性质**未在可读测试中断言；并收紧 stall 阈值与 `cancelled`/`signal` 变量来源表述。
严格区分**原件事实 / 代码行为 / 推断 / unknown**。

## 0. 审核输入

严格限定为 acceptance_inputs 的 16 个路径（含各自 acceptance_locks SHA-256 声明值，
本工作区未重算）：

| 路径 | 用途 |
|---|---|
| `docs/development/evidence/no-response-20260914/README.md` | 冻结诊断路线与输出约束 |
| `docs/development/evidence/no-response-20260914/case.json` | 5 条运行记录元数据、budgets、knownConclusion |
| `client-runtime/claude-client.mjs` | stdout 分行、过滤前模型采集、尾行、关闭/取消、持久化顺序 |
| `client-runtime/model-observation.mjs` | unknown/observed/conflict 判定与绑定权威 |
| `client-runtime/model-observation.md` | 观测契约语义 |
| `client-runtime/agent-runtime.mjs` | 主 Agent 预算、释放屏障、投影与恢复路径 |
| `client-runtime/agent-runtime.md` | 生命周期契约 |
| `client-runtime/cancellation-contract.mjs` / `.md` | 释放真相与 barrier |
| `client-runtime/iteration-loop.mjs` / `.md` | 等待/恢复编排 |
| `tests/agent-runtime-timeout-recovery-test.mjs` | 超时/已释放 run 的收敛用例（假 client 无 cancel，run 预置 cancelled） |
| `tests/model-observation-test.mjs` | 34 项观测检查（含适配器层取消用例与真实 runtime 的 projection 取消结算用例） |
| `AGENTS.md`、`docs/development/ARCHITECTURE.md`、`client-runtime/README.md` | 契约/边界 |

同目录 `root-preflight.md`、`root-timeline.json`、`dispatch-review-request.json` 不在 16 路径内，
未读取（有意不把 Root 预检结论当作审核前提）。

## 1. unknown 是否采集遗漏？

**结论：在本次可读代码路径内，没有发现"元数据被采集后又在判定阶段遗漏"的缺口——
该 unknown 是零 assistant 元数据时的正常判定。但"provider 确实没产出 assistant 行"只是推断，
不能由当前证据排除字节在被强杀前未被读入。**

- FR-01（fact）目标 run：`case.json records[2]`，status `cancelled`，error `null`，
  startedAt `20:33:05.332Z`，lastActivityAt `20:36:07.582Z`，completedAt `20:36:07.636Z`，
  activityKind `thinking`，`retainedEventTypes {"system:init":1}`，modelObservation
  `status:unknown / model:null / source:null / models:[] / observations:[]`，
  reasons `["no assistant response metadata in the run stream"]`，
  configuredModels `["claude-opus-5[1m]"]`，usageModels `[]`，sessionId 非空。
- FR-02（fact）该理由串只出自 `model-observation.mjs:142-149` 的 `assistantCount === 0` 分支：
  DTO sessionId 非空说明通过了 `:188` 的身份校验（identityComplete 为真），
  因此不会走 `:132-141` 的身份不全分支；缺 session / 外部 session / 无有效 model 标签分别走
  `:150-159`，reason 文本不同。故本次**不是**"有 assistant 事件但元数据缺失/被过滤"。
- FR-03（fact）采集在过滤之前：`claude-client.mjs:36-54` 投影安全元数据，
  `:436-437` 先入 `observationEvents`，`:445` 才按 `isClaudeTelemetryEvent`（`:28-34`）决定是否落原始行；
  `:461-477` 关闭时处理未换行尾行（先取局部 `tailLine` 再清缓冲）。
- FR-04（**inference**）事实部分：同 case 其余运行观测条数确实大于保留 assistant 行数
  ——records[0] 6 vs 3、records[1] 8 vs 5、records[3] 36 vs 26、records[4] 6 vs 3；target 0 vs 0。
  但"差额即全部为被过滤的 thinking-only"只是与过滤路径一致的推断：observations 只统计元数据有效的
  assistant 事件（`model-observation.mjs:109-117`，无效元数据会压低差额），而 appendFile 失败被
  `.catch(()=>{})` 吞掉（`claude-client.mjs:431`、`:445`，保留行丢失会抬高差额）。
- FR-05（inference）结论如上；反证边界：`claude-client.mjs:417-454` 只处理已读入字节，
  `:466-476` 只处理仍在 `eventBuffer` 的尾行。append 吞错只影响 `.jsonl`，不影响内存 DTO，
  所以既不能解释本次 unknown，也削弱了任何用保留行数反推采集行为的论证。
- FR-08（unknown）强杀（`:251-260` taskkill `/T /F`，15s 只是上限）与未 flush 输出之间的竞争，
  在 init-only 保留流下无法事后区分。

## 2. 取消是否有界？

**结论：调用时延与尝试次数有界；进程真正退出与释放确认无时间上界。
本次取消的触发分支未被保留，182.304s ≈ 180s 预算只是与证据一致的解释，不是证明。**

- FR-07（inference）`case.json` 时长 182.304s 与 `budgets.mainAgentMs=180000` 差约 2.3s，
  与 `agent-runtime.mjs:1765`（budgetExceeded）、`:1781`（expired 传入 settleCancellation）、
  `:887` + `:500-503`（budgetMs 来自配置，`:449` 默认 10 分钟）一致；取消前 54ms 仍有 thinking 心跳，
  而 stalled 需超过实际生效的 `mainAgentStallMs` 阈值无活动（`:1764`）。该阈值按
  `options.mainAgentStallMs → OPERATOR_MAIN_AGENT_STALL_MS → defaultMainAgentStallMs` 的空值回退顺序选值；
  选中值不是有限正数时使用 `defaultMainAgentStallMs`，后者为 runtime 定义的默认值或全局 fallback
  （`:495-499`），`:468` 的 120000 只是全局 fallback，**case.json 未锁实际阈值，故不按 120s 定量**；
  `lastEventAt` 取 `run.lastActivityAt` 心跳（`:518-522`），故 stalled 在本样本上缺乏支持。
  但 case 不含取消请求时刻与触发来源，**operator/平台侧取消无法排除**；`elapsed` 起点
  （`state.agent.startedAt`，`:1763`）与 `run.startedAt` 不是同一时间源，~2.3s 差值也不能归因到节拍
  （tick 不在锁定输入内）。`error` 为 null **不能**用来排除 provider 报错（见 FR-18）。
- FR-10（fact）`agent-runtime.mjs:1240-1249` single-flight（按 runId 复用同一 operation）；
  `:1242` deadline 默认 5000ms（下限 20ms）；`:1252-1260` 超时/报错都收敛为
  `cancel_requested + unconfirmed`（`AGENT_CANCEL_DEADLINE_EXCEEDED`），迟到结果不改 Mission 快照
  （`:1250-1251`）。该 deadline **只截断调用方的等待**，不终止底层 provider 取消动作。
- FR-11（fact）`MAX_CANCELLATION_RETRIES = 3`（`:448`，`:1281-1301`）；用尽且释放仍 pending 时
  `needs_human + blocked/quarantined`（`:1301-1315`）。该计数是 `settleCancellation` 的尝试计数，
  因 single-flight 复用（`:1243-1249`），物理 provider cancel 调用可能少于 3 次。
- FR-12（inference）`claude-client.mjs:504-512` 不等待 `close`；若取消端口在 5s deadline 内未落定，
  调用方**先**记 unconfirmed，`quarantined` 需重试耗尽（>=3）才出现，不是一次超时的必然结果；
  `:255` taskkill 的 15s 只是 execFile 上限，实际耗时未保留。属设计取舍（`cancellation-contract.md:24-31`）。
  **覆盖表述修正**：可读的 `model-observation-test.mjs:798-815` 用**真实** `createAgentRuntime`（`:711-716`）
  与立即返回 confirmed 的 `projectionClient.cancel`（`:708`），以 `cancel_requested` 状态驱动
  `projectState`，经 `agent-runtime.mjs:1781 → :1285（未释放，因 run 仍 running 且无 resourceRelease）
  → :1286 cancelling → :1296-1299 requestCancellation → :1245-1246 invoke('cancel')`，
  因此**正常成功取消结算路径有用例覆盖**；未被断言的只是 single-flight 并发复用（`:1244-1248`）、
  deadline 实际到期（`:1252-1256`）、provider 取消报错（`:1258-1260`）与重试耗尽/`needs_human`
  （`:1301-1315`）这些**性质**（FR-21 第 2 项）。`tests/model-observation-test.mjs:691` 的适配器层
  `claude.cancel` 是另一条独立覆盖。
- FR-13（fact）释放无上界：`cancellation-contract.mjs:3-4`（终态且 `confirmed !== false` 才算释放）、
  `:28-52`（后续快照可把已确认退出的资源投影为 confirmed，即 **owner 终态证据也能解除 barrier**）、
  `:65-83`、`:85-90`（409 barrier）；`agent-runtime.mjs:716 / :1145` 入口强制，
  `iteration-loop.mjs:471-509` 返回 `resource_release_pending` 或隔离为 `needs_human`。
  人工确认只是 quarantined 情况下的显式出口之一，不是唯一解除方式。

## 3. 恢复等待来自何处？

**结论：来自三类显式状态闸门，均为每 tick 重新求值的状态判断；恢复路径上没有 sleep/轮询等待循环。**

- FR-14（fact）① 释放闸门：`agent-runtime.mjs:716 / :1145`、`iteration-loop.mjs:471-509`；
  ② 主 Agent 占用：`agent-runtime.mjs:822-827`、`iteration-loop.mjs:794-797 → wait_main`
  （`AGENT_ACTIVE_STATUS` 含 `cancel_requested`，`:24`）；
  ③ 同步研究员串行：`agent-runtime.mjs:813-818 / :1160-1165`（`RESEARCH_SERIAL_BUSY`）、
  `iteration-loop.mjs:671 / :745 → wait_research`；另有 `:751-754 → wait_baseline`。
  `agent-runtime.mjs:717-727` 的 120s 守卫是**启动去重锁的失效计时器**（`:718-723` 拒绝重复启动，
  `:726` timer.unref() 清理），不是等待。模块内 setTimeout 仅 4 处（`:120` audit rename 重试、
  `:274` clone 退避、`:726` 去重守卫、`:1253` 取消 deadline），均不在恢复等待路径上。
- FR-15（inference）本案 recover 间隔：target 完成 `20:36:07.636Z` → 研究员启动 `20:36:17.899Z`（10.263s）；
  研究员完成 `20:38:24.306Z` → 主 run 启动 `20:38:38.975Z`（14.669s）。与"释放确认 + tick 重算"一致；
  tick 间隔不在锁定输入内，不能反推节拍参数。
- FR-16（unknown）研究员 run 的触发者（停滞升级 / 隧道视野 / 操作员 / 经验调研）不可归属：
  `case.json records[3]` 无 runPhase/trigger；`iteration-loop.mjs:950-973`（`:961-967` 调 deps.startResearch）
  与 **`agent-runtime.mjs:1144-1238`** 的 startResearch runPhase 分支都会产生同类 runId
  （注意：startResearch 定义在 agent-runtime，不在 iteration-loop）。

## 4. 上游原因可证明到什么程度？

**结论：可证的是"客户端在取消路径上把该 run 记为 cancelled、error 置 null，且保留流未包含任何
assistant 事件"。取消触发分支与 provider 侧根因都不可证明，必须保持 unknown，且不得用任何标签回填。**

- FR-06（inference）终止前 ~54ms 仍在解析 thinking 遥测（`claude-client.mjs:87-89`、`:441-444`），
  且 `status=cancelled`、`completedAt`、`error=null` 三者只在 close 分支（`:486-493`）写出，
  persistRun 为 tmp+rename 原子写（`:267-281`）：若最终写失败，盘上会停留在仍为 `running` 的旧版，
  与 case 元数据不符，故该次写盘成立。**但不能延伸为"任何写失败/采集遗漏均已排除"**——
  persistRun 失败被 `.catch(()=>{})` 吞掉（`:404/:423/:431/:444/:445/:459/:493`），
  且本结论依赖 case.json 抽取忠实（本工作区无法复核原始 record）。
- FR-09 / FR-17（unknown / inference）保留流 init-only、无 error/result、无网络 trace、无请求体
  （`case.json limitations[2]`）；`claude-client.mjs:207-235` 的失败分类链因 run.error 与事件文本皆空而不产生上游码。
  不采信替代证据：`model-observation.md:9-17` 与 `model-observation.mjs:100-107`、`:202-209`
  规定 init 的 configuredModels 与 result.modelUsage 只作诊断标签。
- FR-07 修正（见 §2）：不能写成"只能证明按 180s 预算切断"；可证的只是 cancelled 终态与时长相关性。
- FR-18（fact，观测缺口）cancelled/signal 会把 `run.error` 置 null（`claude-client.mjs:486-491`），
  使 run 记录层面的 error 字段在取消后不再承载上游诊断。**范围限定**：该分支不删除已 append 的事件行；
  运行期若已有 result 事件，`:446-452` 会先写 completed/failed。本 case retainedEventTypes 仅
  `{"system:init":1}`，没有 error/result 事件可参考，故原因仍未知——不能泛化为"所有上游终局诊断必然消失"。
- FR-19（fact，观测缺口）DTO 无结构化计数（`model-observation.mjs:17-20`），
  "零 assistant"与"assistant 缺元数据"只能靠 reasons 文本区分（`:142-159`）。
- FR-22（inference）**未发现**能解释本次 unknown 的明确实现缺陷（≠ 证明不存在）；
  已识别的是可观测性缺口与设计上使上游原因不可证的部分。
  禁止以改配置补 model、替换/追加样本或扩大预算来通过门槛（`case.json knownConclusion`、
  `model-observation.md:9-17`、`client-runtime/README.md:209-212`）。

## 5. 既有测试符号与覆盖缺口

**可读的测试符号（FR-20；仅 16 个输入内的两个测试文件）**

- `tests/model-observation-test.mjs`（`check(name, fn)` 壳见 `:47`），共 34 项
  （与 `client-runtime/model-observation.md:129` 一致）：
  - pure 17 项：`:136` 单一 assistant model 被观测/init+usage 标签隔离、`:157` 零 assistant 与 init-only 保持 unknown、
    `:172` 缺失/空/<synthetic> 标签不观测、`:187` 两个具体 model 为 conflict、`:200` 缺 session 或外部 session 使完整性失效、
    `:223` session 字节精确且 run/mission 必须非空、`:255` 有效响应不能掩盖同流中的缺失、`:272` thinking-only 元数据被观测且不泄漏正文、
    `:285` 无关 model 字段与散文被忽略、`:298` DTO JSON 往返、`:312` bind 拒绝四种身份替换、`:337` bind 拒绝畸形/自相矛盾 DTO、
    `:370` bind 拒绝 observed 带 reason/未列证据/重复 eventIndex、`:402` 空 required 集为 unknown、`:413` 全部 required 同 model 才 observed、
    `:441` 外部/非观测/畸形/重复证据 fail-closed、`:463` 仅键序不同的重复证据计一次。
  - adapter 7 项：`:543` 假子进程流落盘观测、`:569` resume 提示不是观测（init-only/空流 unknown）、
    `:602` thinking-only 元数据被观测且不落推理正文、`:617` 未终止尾行在物理关闭时仍被观测、`:630` 混合/外部/合成元数据 fail-closed、
    `:661` 有效响应后跟不完整元数据仍 unknown、**`:681-695` 取消保留已观测元数据（`:691` 实际
    `await claude.cancel(runId)`，经 `:505` createClaudeClient 的假子进程驱动真实 claude-client）**。
  - projection 7 项：`:738` 精确绑定且仅元数据变化置 changed、`:771` 缺失/外部/错误绑定清除陈旧值、
    **`:798-815` 取消结算保留观测且不削弱释放（经真实 `createAgentRuntime` 进入
    `requestCancellation` 正常成功路径）**、`:817` 外部 mission 的 DTO 不投影、
    `:834` 与记录 session 不一致的取消 run 被拒（`:845-851` 基线同样走正常取消结算）、
    `:864` 声称其它 provider 的记录不投影、`:878` readRun 失败清除已投影观测。
  - archive 3 项：`:913` reset 保留并分离归档、`:925` 外部绑定被拒不入档、`:941` 新 run 不继承归档观测。
- `tests/agent-runtime-timeout-recovery-test.mjs`：覆盖**已终结/已释放 run 的计时恢复**，不是取消请求路径。
  `:16-30` 注入的 claudeClient 只有 describe/readRun/readEvents/eventText，**没有 cancel**；
  `:20-26` readRun 直接返回预置 cancelled 记录（无 `resourceRelease`，故 `agent-runtime.mjs:1285`
  `isExecutionReleased` 为真、直接早退，不会调用 `requestCancellation`）；`:39-47` 以 `status:'completed'`、
  `timedOut:true`、301s 无活动驱动投影；`:53-61` 断言超时投影收敛为可重试终态、不产生无主 running loop。
  即：**agent-runtime 的取消路径覆盖来自 model-observation 的 projection 取消用例（正常成功路径）**，
  本文件覆盖的是另一条（已释放收敛）路径。
- 文档引用但不在 acceptance_inputs、本次未阅读：`tests/agent-cancellation-liveness-test.mjs`、
  `tests/prompt-audit-test.mjs`、`tests/codex-runtime-test.mjs`、`tests/research-test.mjs`、
  `tests/baseline-materializer-agent-test.mjs`、`tests/round-feedback-integration-test.mjs`、
  `tests/model-observation-acceptance-test.mjs`（`agent-runtime.md:137-144`、`cancellation-contract.md:34`、`model-observation.md:131`）。
  因此以下缺口只声明"可读输入内无覆盖"，**不代表全仓范围无测试**。

**覆盖缺口（FR-21，仅就可读文件）**

1. 没有"system:init + system:thinking_tokens 后被强杀、且此前无 assistant 元数据"的采集场景（= 本案精确形态）；
   最接近的 `:569` 只覆盖 init-only/空流，`:681-695` 的取消用例要求观测**已存在**。
2. 取消的**正常成功结算路径已有覆盖**（`:798-815` 经真实 runtime 进入 `requestCancellation`；
   timeout-recovery 覆盖已释放 run 的收敛），可读输入内**没有针对以下性质**的断言：
   `agent-runtime.mjs:1244-1248` single-flight 并发复用同一 operation、`:1252-1256` deadline 实际到期
   （`:798` 用例的 fake cancel 立即 resolve、定时器被清除）、`:1258-1260` provider 取消报错→unconfirmed、
   `:1301-1315` 重试计数耗尽→`needs_human`/`quarantined`。
3. 没有断言取消/信号终态清空 `error`（`claude-client.mjs:486-491`）。
4. 没有断言 `claudeActivityFromEvent` 对 `system:thinking_tokens` 产出 `kind:'thinking'`（`:87-89`），
   而 case 的 `activityKind` 正依赖该分支。
5. `persistRun` 失败被 `.catch(()=>{})` 吞掉（`:404/:423/:431/:444/:445/:459/:493`），无可见性测试。

## 6. 判定

- **是否存在明确实现缺陷：未发现**能解释本次 unknown 的明确实现缺陷（这是"未发现"，不是"证明不存在"）。
  unknown 是零 assistant 元数据时的正确判定；其余 4 次运行的观测条数差异与过滤前采集路径一致（属推断）。
- **已识别的缺口**：取消清空 run.error（FR-18）、DTO 缺结构化采集计数（FR-19）、
  上述覆盖缺口（FR-21），以及 cancelled run 的取消触发来源/resourceRelease/退出码未进入 case 投影。
- **必须保持 unknown**：provider 是否曾产出 assistant 字节、是否曾开始生成、传输是否停滞、
  本次取消的触发分支；不得用 `configuredModels` / `usageModels` / 相邻 run / 配置补齐 actual model。
- **未做**：未修改生产源码、未改预算、未新增依赖/Agent/GPU/网络调用、未运行全量回归或业务 CLI、
  未重放或替换 N20 样本。N20 严格结论不变：第 13 次维持 genuine unknown，strictN20Passed=false。

## 7. 验收自检记录

见 `client-review.json` 的 `verification`：

1. `report-json-shape`（冻结配方原样执行一次）：exit 0。
2. `no-production-source-modified`（`git status --porcelain`）：只列出本任务两个报告文件与本工作区的
   `.dispatch-result.json`；`client-runtime/`、`tests/`、`AGENTS.md`、`docs/development/ARCHITECTURE.md` 均无改动。
