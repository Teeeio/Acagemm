# Round Experience Service

## Purpose / Responsibilities

在既有轮次启动路径冻结可审计经验，并把经可信验证的执行观察追加到经验服务。不是第二条 workflow；不运行 Agent、测试、GPU 或网络，也不授予发布权限。

## Public API / Inputs

`createRoundExperienceService({experienceService,resolveAccess,verifyObservationEvidence,timers,timeoutMs=3000})` 返回冻结的 `{prepare,collect,record}`。

- experienceService：注入公开 retrieve/recordObservation API，不默认导入 repository。存在可选 `retrieveWithSelection` 时一次调用取得内容和审计清单；仅缺少该端口时用原 retrieve 并派生明确标记的清单。旧 retrieve-only 注入行为不变。
- resolveAccess({state,mission})：可信同步授权端口，返回 `{projectId,allowedProjectIds:[]}`；必须与 activeMissionId、mission.id/projectId 一致。组合根负责确认本地 Project 存在，不从正文推断权限。
- verifyObservationEvidence({state,mission,observation,signal})：只读可信验证，返回 `{verified:true,evidence,summary?}` 或 `{verified:false,code?}`。true 必须建立真实执行回执与完整凭据绑定；不能只是转发调用者 verified 字段。
- timers：显式 setTimeout/clearTimeout。timeoutMs 为正有限值，最大 120000 ms；方法可指定更短 deadline。

`prepare({state,mission,roundId,scope?,timeoutMs?})` 返回纯契约校验过的冻结 context。roundId 必须由 [轮预算](../round-budget-contract.mjs) 提供，已有预算时必须匹配；本模块绝不生成轮次。默认 scope 的 operator/tags 取自 Mission（保留既有严格作用域），hardware/architecture 消费同 Mission 的 `state.iterationStats.resolvedTarget`——它与执行记录同源（见 [operator-test-evidence](../operator-test-evidence.md)）；dtype/shape 需调用者显式提供，不从未知矩阵推断。没有已解析目标时才回退 Mission 明确 hardware，且 `local-shared-gpu`/`local-c500` 这类 backend 名不得冒充 hardware：命中即抛 `ROUND_EXPERIENCE_TARGET_INVALID`，不能悄悄退化成正常零命中。旧 `hardware:['cpu']` 声明仍兼容。显式 scope 也必须与已绑定目标一致，缺失的 hardware/architecture 由绑定目标补齐，冲突则拒绝，不能绕过硬件。

`record({state,mission,observation,timeoutMs?,signal?})` 接收 `{evidence,evidenceRefs?}`；evidence 沿用 [经验契约](../experience-contract.md) 完整字段。缺 Mission/Candidate/run 或四类摘要/硬件/模式/结果时返回 `{status:'skipped',code:'EXPERIENCE_BINDING_MISSING',missing}`，不调用验证器或写入。合法完整字段还必须经可信端口验证，且回执规范化后逐字段一致；内容仅由绑定结果与可信 summary 构造。写入 scope 只取 Mission 的 operator/tags 加上证据实际声明的 hardware/architecture，绝不用查询目标改写证据；实际执行目标与已绑定目标冲突时照常记录事实，并把可审计的 `resolvedTargetMismatch`（返回对象的 `targetMismatch` 与 `state.iterationStats`）暴露出来。目标状态只跟随既有 `iterationStats` 的 Mission 存储/切换，无顶层跨 Mission 泄漏。

`collect({state,mission,observations?,timeoutMs?})` 最多处理 20 个 observation。省略列表时仅检查终态 `state.benchmark.result.experienceEvidence`，refs 来自 experienceEvidenceRefs；旧 runner 不具备该字段或包摘要就显式 skipped，不改造/伪造旧结果。共享 GPU 组合根会重新验证执行包 admission、prepared artifact、Mission/Workspace/Candidate 绑定后才返回 verified；worker 自带的 verified 标志不具授权力。共享 GPU 经验始终 `publishable=false`。返回 `{status,recorded,existing,skipped,records}`。record 返回 recorded/existing 时含 experience/created；幂等由已绑定 evidence key 保证。

## Outputs / Invariants

Mission and explicit query hardware lists retain strict input validation: scalar,
non-string, oversized and empty-string entries are errors rather than silently
filtered conditions. An explicit architecture cannot fill an undeclared resolved
architecture. Omitted or empty explicit dimensions use the bound target. Actual
execution observations may report a mismatch, but cannot rewrite its provenance.

context 只存 `state.iterationStats.roundExperience`，利用既有 Mission 投影/恢复保留；无顶层 context。来源、versions、scopeDigest、contextId 均可核查。同轮已有 context 只校验/冻结/复用，不重新查询人工更新；不同轮才取得新快照。恢复对象也必须摘要有效，不能用当前最新经验悄悄替换。进程内同一 state 对象的并发准备共享 Promise。

同轮冻结的审计清单保存在 `state.iterationStats.roundExperienceSelection`（与 `roundExperience` 同 round 的 sidecar）：含选中/排除记录的 ID/version/source/reason、策略版本、repositoryRevision/contextId、`contextBytes` 与 `renderedBytes`（均按 UTF-8 `Buffer.byteLength` 实测）。内容和清单来自同一次仓库读取，严格核对 contextId/revision/scopeDigest、身份、选中记录的顺序/版本/来源；审计端口返回不一致时以 `ROUND_EXPERIENCE_SELECTION_CONFLICT` 阻止本轮准备，存储错误不吞掉。旧结构/旧 retrieve-only 注入仍可读，其清单标记 `auditSource:context-derived`、`exclusionReasonsRecorded:false`、原因 `frozen-context`，不编造排除原因。同轮恢复不重查、不刷新清单。

roundExperienceStatus 记录 preparing/ready/failed；experienceCollection 记录有界的计数、ID/version/evidenceKey 或 skipped 原因。迟到检索结果不写状态，也不替换别的 Mission。读取人工 advice 不会调用任何 Agent 端口。

CPU/仿真保持 development-record，所有写回观察必须 publishable=false。验证失败返回明确 skipped；摘要冲突、存储/超时错误不吞掉。batch deadline 传递到 record 和 verify 的组合 signal，截止后不再发起新写入；已经开始的存储写可能无法物理取消，超时保留 effectUnknown，后续以同证据键显式核实/幂等重试。

## Dependencies / Side Effects

仅导入 experience-contract 的公开纯 API；计时、授权、验证与经验存储均由端口提供。内存变更仅 iterationStats 的冻结 context、选择清单 sidecar 与两个状态记录。无 state-store、FS/HTTP/Provider 实现、发布 Gate 或硬件依赖。

## Error Contract

ROUND_EXPERIENCE_ACCESS_INVALID、CONTEXT_CONFLICT、EVIDENCE_CONFLICT、LIMIT_EXCEEDED、TARGET_INVALID 为 409；ROUND_EXPERIENCE_TIMEOUT 为 504，带 stage/effectUnknown。TARGET_INVALID 覆盖：未解析 hardware 位置出现 backend 名、显式 scope 与已绑定执行目标冲突、显式 scope 非普通对象。领域及存储错误原样传播。缺端口/非法时间为 TypeError。失败必须阻止依赖该步骤的新 Agent 启动，不回退为空上下文。

## Example / Verification

```js
await roundExperience.collect({ state, mission });
const context = await roundExperience.prepare({ state, mission, roundId });
// Existing Agent start receives experienceContext: context.
```

`node tests/round-experience-service-test.mjs`、`node tests/agent-round-service-test.mjs`、`node tests/experience-service-test.mjs`；纯内存/注入假端口，无真实 Agent。

## Change Checklist / Known Limitations

字段/端口变化同步此契约、AgentRound、经验纯契约及测试。context 64 KiB/20 项上限沿用领域。默认检索不猜 dtype/shape；未接完整包验证的旧结果不会自动成为观察。状态跨对象/进程的串行持久化由既有 Repository/command journal 负责；本服务不提供第二套事务恢复。
