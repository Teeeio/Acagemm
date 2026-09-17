# NO_RESPONSE_OBSERVATION_AUDIT — init-only 取消调用的模型观测与终止边界

只读核查。核查对象：第 2 次独立 affine 调用（`n20-index.json` index=2，runRoot
`shared-gpu-nGBRDg`）中出现的一次 budget-cancelled、仅 `system/init` 的 Claude 模型调用
`claude_MTZ4S0GP_97CF866B`。目的：判断 `unknown` 观测与取消释放是否符合冻结契约，区分预期
`unknown` 与独立缺陷。**本审计未运行模型/GPU/网络，未改生产代码、验收基准或原件；无证据处不建
议改生产。**

- 契约权威：`docs/development/MODEL_OBSERVATION_ACCEPTANCE.md`
  （sha256 `4052ff1837a2be62f5a16931a8a2abfa93564c28136cf396ea2aff9325ee10b7`，与 acceptance_lock 一致）。
- 归档报告：`docs/development/evidence/live-regression-20260913/reports/final-root-assessment.json`
  （sha256 `aa72e7db284ee3dfe829e362c4698c181146d83e1a3bf81de8043f9b7e96cb66`，与 acceptance_lock 一致）。
- 原件只读路径：`F:/设计/快速项目/acagemm原型/.tmp-real-agent/shared-gpu-nGBRDg`
  （archive-manifest：21 roots / 34956 files / 630215307 bytes；zip sha256 `272467fc…c7cde54`）。
- 对照决定：`reports/n20-resume-decision.json`（"cancelled run only emitted init, model unknown is genuine"，
  `resumeAt:3, finishAt:20, codeOrBudgetChanges:false`）。

## 1. 结论摘要

| 核查点 | 结论 | 依据类型 |
| --- | --- | --- |
| 该调用的 `status=unknown`、`model=null`、`source=null` | **符合契约预期**，不是采集缺陷 | 原件原始流 + DTO 字段 + 代码分支 |
| 是否用 init/env/usage 回填响应模型 | **未回填**；init 标签仅留在 `configuredModels` | 原件 DTO + 契约规则 4 |
| 取消终态记录与收集器绑定 | **符合契约**；final record 权威、身份精确、仍留在分母 | summary/attempt 字段 + 收集器代码 |
| 取消释放/终止边界 | **符合契约**；Mission stop receipt confirmed，无 pending/quarantine | stop receipt 字段 + 停止复核代码 |
| 由该原件可证的独立缺陷 | **未发现** | — |

`unknown` 的后果被契约正确执行：`config.provider.model="unknown"` → 指纹 unknown field
`provider.model` → 该次调用 `comparable:false` → `strictN20Eligible:false`，且不把 workflow 的
`full_success` 改判为失败。这与 `MODEL_OBSERVATION_ACCEPTANCE.md` 第 8/29/34/44/46/60 行一致。

## 2. 观测事实（原件字段）

### 2.1 原始流只有 init 一行

`bridge/claude-runs/claude_MTZ4S0GP_97CF866B.jsonl`
（1026 bytes，sha256 `76450b6d9c6d255f991e6dbc9ff9261aa3a5107b40e08fea487671179c31e02a`）：
**仅 1 行**，`type=system`、`subtype=init`、`model="claude-opus-5[1m]"`、
`session_id="4b2f2357-de29-4612-826d-e2f1caa924fb"`、`claude_code_version="2.1.232"`、
`permissionMode="acceptEdits"`、`mcp_servers=[]`。**没有任何 `type=assistant` 行，也没有 `type=result` 行。**

注意：`system/subtype=thinking_tokens` 属于遥测事件，被
`isClaudeTelemetryEvent`（`client-runtime/claude-client.mjs:28-34`）过滤后不落 jsonl；因此 jsonl 的
1 行不等于流中只有 1 行，但**判断响应模型只看 `assistant.message.model`**，thinking 遥测即使存在
也不能作为观测（契约第 8/31 行 "Other event fields named model … are ignored"）。

### 2.2 终态 run 记录

`bridge/claude-runs/claude_MTZ4S0GP_97CF866B.json`：

- `status="cancelled"`，`error=null`，`threadId=sessionId="4b2f2357-…-e2f1caa924fb"`
  （session 由本流 init 学到并固定）。
- `activity.kind="thinking"`、`summary="正在分析任务，尚未调用新工具"`、`updatedAt=01:27:04.165Z`
  —— 该文案精确来自 `claude-client.mjs:87-89` 的 `system/thinking_tokens` 分支，说明取消前进程仍在
  分析且**只产生了遥测，没有 assistant 响应**。
- `modelObservation`：
  `status="unknown"`, `model=null`, `source=null`, `models=[]`, `observations=[]`,
  `configuredModels=["claude-opus-5[1m]"]`, `usageModels=[]`,
  `reasons=["no assistant response metadata in the run stream"]`。

`configuredModels` 恰好保留 init 标签而 `model` 仍为 `null`，是**"保留标签但不提升为观测"**的直接字段证据。

### 2.3 归档聚合与汇总

`summary.json`（原件）与 `final-root-assessment.json` index=2：

- `modelObservations[1]` = 上述 unknown DTO；`modelObservationRequiredRuns[1]` 携带完整身份
  `{provider:"claude-code", runId:"claude_MTZ4S0GP_97CF866B", missionId:"MIS_MTZ4PE94",
  sessionId:"4b2f2357-…"}`。
- `modelObservationSummary = {status:"unknown", model:null, modelSource:"unknown", models:["deepseek-v4-flash"],
  requiredRunCount:3, observedRunCount:2, reasons:["1 required run(s) have no valid observed response model"]}`
  —— 两个 observed run 提供 `deepseek-v4-flash` 仅用于展示，未回填给被取消 run。
- `modelObservationUnboundRuns=[]`：被取消 run 已成功绑定，未因缺观测被丢弃。
- `modelObservationSweep.discoveredFiles` 含 `claude_MTZ4S0GP_97CF866B.json`，`enumerationError=null`。
- `config.provider = {model:"unknown", modelSource:"unknown", modelObservationStatus:"unknown",
  modelObservationVersion:"operator-studio.model-observation/v1"}`；
  `fingerprintUnknownFields=["provider.model"]` → `comparable:false`（index=2，outcome 仍 `full_success`）。
- 归档快照 `affine-state.json` 的 `runHistory[0].modelObservation` 仍是同一 unknown DTO，
  `completedAt=null`：说明归档/复位保留绑定值、未继承、未改写（契约第 38 行）。

## 3. 代码路径核查（只读）

### 3.1 Claude metadata 收集 → cancel final record

- `claudeModelMetadataFromEvent`（`claude-client.mjs:39-54`）在遥测过滤前抽取安全元数据：
  assistant 事件只取 `{session_id, message.model}`（第 41-43 行），init 只取 `event.model`（第 44-46 行），
  result 只取 `modelUsage` 键（第 47-52 行）。thinking/text/tool 内容一概不复制。
- 流处理（第 436-439 行）先 `observationEvents.push(modelMetadata)`，再 `refreshModelObservation()`；
  含 **thinking-only 的 assistant 事件仍会贡献模型**，满足契约规则 1。本题原件没有 assistant 事件，
  所以该机制无输入可采。
- 未终止尾行在 `close` 中先取 `tailLine` 再刷新（第 464-477 行）；`cancel()`（第 504-512 行）标记
  `cancellationRequested` 并 `terminateProcessTree`；`close` 第 486 行按 `cancelled||signal` 落
  `status="cancelled"`，并 `persistRun` 固化最终 DTO。**取消不会跳过/清空观测收集**，满足契约规则 5。
- 纯函数判定：`observeClaudeModel` 在 `assistantCount===0` 时返回
  `unknown + reasons:['no assistant response metadata in the run stream']`
  （`model-observation.mjs:142-149`）；init 只进 `configuredModels`（第 100-103 行），usage 只进
  `usageModels`（第 104-107 行），二者都不进入 `observations`（第 108-118 行）。因此该 DTO 的
  `unknown` 是纯函数按输入推导出的、可复算的结果，而非硬编码。

### 3.2 collector 绑定

`scripts/shared-gpu-acceptance.mjs:575-773` `collectModelObservationEvidence`：

- 以 final 物理记录为唯一权威（第 746-757 行），DTO 自身字段不得提供期望身份（第 748-750 行）；
- 被取消 run 的身份最早由 driver 的 `observeStateModelRuns`（`e2e-shared-gpu-agent-iteration.mjs:119-134`）
  在 start/poll/stop 各状态独立观测；缺失 Mission/session 只能由本次 final record 补齐（第 713-744 行）；
- 校验 provider/runId/session 一致后 `bindModelObservation` 成功，unknown 是合法 DTO，进入
  `observations` 与 `requiredRuns`，`unboundRuns` 为空（与原件 `[]` 一致）。
  第 770-772 行仍把该 run 计入分母，最终 summary 严格 unknown。

对照 `MODEL_OBSERVATION_ACCEPTANCE.md` 第 42/70 行：final record 权威、不丢 run、DTO 不能自绑身份——
原件行为一致，且不能由配置声明或 env 把该 unknown 升级。

### 3.3 停止复核 / 终止边界

`evaluateMissionStopReceipt`（`shared-gpu-acceptance.mjs:785-861`）要求：精确 `activeMissionId`、
`missionPaused===true`、`iterationStats.loopStatus==='stopped'`、`workflowRecovery.resourceRelease` confirmed
且 resources 无 pending/quarantine/blocked、当前 Agent run 需同 Mission 明确释放、并检查既有
`resourceReleaseBarrier`。原件 `stopReceipts[0]`（affine / MIS_MTZ4PE94）：

- `statusCode:200, confirmed:true, reasons:[]`；
- `state.activeMissionId="MIS_MTZ4PE94"`，`missionPaused=true`，`iterationStats.loopStatus="stopped"`；
- `workflowRecovery.resourceRelease = {confirmed:true, status:"confirmed", blocked:false,
  quarantined:false, resources:[], nextAction:"All active execution resources have been released."}`；
- `state.agent = {runId:"claude_MTZ4W8IJ_4FD4A24B", missionId:"MIS_MTZ4PE94", status:"completed",
  resourceRelease:{confirmed:true, status:"confirmed"}}`；
- `writes` 仅 3 条且都在 start 前，`workflowWritesAfterStart=0`；teardown 的
  `/api/actions/stop-mission` 200 单独记在 `teardownWrites`，`teardownStop=null`（无未确认 teardown）。
- driver 侧 `stopMissionNow`（`e2e-shared-gpu-agent-iteration.mjs:330-363`）保留**原始** HTTP body 于
  `initialReceipt`，仅在只读观察证明释放后才 `confirmed`，且不再写 workflow——符合契约第 62-64 行。

被取消调用所在的 affine family 最终 `allTaskResourceReleaseConfirmed`/`allStopsConfirmed=true`
（`final-root-assessment.json`），即释放边界通过，且 unknown 未削弱释放判定（两者解耦）。

## 4. 预期 unknown 与独立缺陷的区分

**判定为预期 unknown（非缺陷）**：原始流只有 init、零 assistant 响应；契约规则 2/5 明确规定
"零 assistant 响应 ⇒ unknown"，规则 4 规定 init 标签不得充当响应观测。代码按此推导，归档按此保留
分母与不可比标记。`reasons` 精确、`observations` 为空、无 thinking/文本泄漏。此未知**不回填**是正确行为。

**未发现由该原件支持的独立缺陷。** 以下两点是**记录性观察**，不构成可证缺陷，故不建议据此改生产：

1. 取消是由 `mainAgentBudgetMs=180000` 触发的 run 级预算取消（`startedAt 01:23:59` →
   `lastActivityAt 01:27:04`，约 185s）。bridge run record 本身没有 `resourceRelease` 字段，run 级释放
   只能由 `status="cancelled"` + 进程树终结路径（`terminateProcessTree`/`cancel`）+ 后续 Mission stop
   confirmed 间接证明。契约的"释放证明"要求落在 Mission stop receipt 与当前 Agent run 上，并未要求每个
   中途预算取消都遗留独立 receipt，故这是**证据粒度边界**，不是违约；如需 per-run 释放收据，应由上游
   决定是否扩约定，不在本审计范围。
2. agent 生命周期事件把该预算取消投影为 `claude.run_completed`（`runtimeEvents[12]`, `eventCount:1`），
   而保留的 run 记录仍为 `status="cancelled"`（`runtimeEvents[11]` 同时有 `candidate.not_proposed`）。
   这是既有 budget-terminal 投影语义（超时/预算 → 投影 `completed`，`timedOut` 另记），N20 规则本就
   不以 budget_terminal 计 full_success；本次该 family 的 full_success 来自后续第 3 个 run 的真实候选。
   该语义不改变模型观测结果，也无证据表明它影响释放判定。

## 5. 边界与未做事项

- 未启动任何模型、GPU、网络或子 agent；未打印 thinking/正文；未读取宿主凭据；未改生产代码。
- 未修改 `MODEL_OBSERVATION_ACCEPTANCE.md` 或任何验收基准/原件；本文件为唯一新增。
- 未据本审计建议生产变更：`unknown` 与释放均符合现有冻结契约，无原件支持的独立缺陷。
- 归档入口与 20 次调用全貌见 `docs/development/evidence/live-regression-20260913/README.md`；
  本审计仅覆盖其中 index=2 的 init-only 取消调用这一条路径。

## 6. 只读复核命令（不产生写入）

```bash
# 契约与归档锁
sha256sum docs/development/MODEL_OBSERVATION_ACCEPTANCE.md \
  docs/development/evidence/live-regression-20260913/reports/final-root-assessment.json

# 原件原始流：应只有 1 行且 type=system/subtype=init，无 assistant
python -c "import json;print([json.loads(l)['type'] for l in open(r'F:/设计/快速项目/acagemm原型/.tmp-real-agent/shared-gpu-nGBRDg/bridge/claude-runs/claude_MTZ4S0GP_97CF866B.jsonl',encoding='utf-8') if l.strip()])"

# 原件 run 记录观测字段
python -c "import json;d=json.load(open(r'F:/设计/快速项目/acagemm原型/.tmp-real-agent/shared-gpu-nGBRDg/bridge/claude-runs/claude_MTZ4S0GP_97CF866B.json',encoding='utf-8'));print(d['status'],d['modelObservation']['status'],d['modelObservation']['configuredModels'],d['modelObservation']['reasons'])"

# 归档 stop receipt 与汇总
python -c "import json;s=json.load(open(r'F:/设计/快速项目/acagemm原型/.tmp-real-agent/shared-gpu-nGBRDg/summary.json',encoding='utf-8'));print(s['modelObservationSummary']);print(s['stopReceipts'][0]['confirmed'],s['stopReceipts'][0]['reasons'])"
```
