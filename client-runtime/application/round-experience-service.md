# Round Experience Service

## Purpose / Responsibilities

在既有轮次启动路径冻结可审计经验，并把经可信验证的执行观察追加到经验服务。不是第二条 workflow；不运行 Agent、测试、GPU 或网络，也不授予发布权限。

## Public API / Inputs

`createRoundExperienceService({experienceService,resolveAccess,verifyObservationEvidence,timers,timeoutMs=3000})` 返回冻结的 `{prepare,collect,record}`。

- experienceService：注入公开 retrieve/recordObservation API，不默认导入 repository。
- resolveAccess({state,mission})：可信同步授权端口，返回 `{projectId,allowedProjectIds:[]}`；必须与 activeMissionId、mission.id/projectId 一致。组合根负责确认本地 Project 存在，不从正文推断权限。
- verifyObservationEvidence({state,mission,observation,signal})：只读可信验证，返回 `{verified:true,evidence,summary?}` 或 `{verified:false,code?}`。true 必须建立真实执行回执与完整凭据绑定；不能只是转发调用者 verified 字段。
- timers：显式 setTimeout/clearTimeout。timeoutMs 为正有限值，最大 120000 ms；方法可指定更短 deadline。

`prepare({state,mission,roundId,scope?,timeoutMs?})` 返回纯契约校验过的冻结 context。roundId 必须由 [轮预算](../round-budget-contract.mjs) 提供，已有预算时必须匹配；本模块绝不生成轮次。默认 scope 只取 Mission 明确的 operator/hardware/tags；dtype/shape 需调用者显式提供，不从未知矩阵推断。

`record({state,mission,observation,timeoutMs?,signal?})` 接收 `{evidence,evidenceRefs?}`；evidence 沿用 [经验契约](../experience-contract.md) 完整字段。缺 Mission/Candidate/run 或四类摘要/硬件/模式/结果时返回 `{status:'skipped',code:'EXPERIENCE_BINDING_MISSING',missing}`，不调用验证器或写入。合法完整字段还必须经可信端口验证，且回执规范化后逐字段一致；内容仅由绑定结果与可信 summary 构造。

`collect({state,mission,observations?,timeoutMs?})` 最多处理 20 个 observation。省略列表时仅检查终态 `state.benchmark.result.experienceEvidence`，refs 来自 experienceEvidenceRefs；旧 runner 不具备该字段或包摘要就显式 skipped，不改造/伪造旧结果。返回 `{status,recorded,existing,skipped,records}`。record 返回 recorded/existing 时含 experience/created；幂等由已绑定 evidence key 保证。

## Outputs / Invariants

context 只存 `state.iterationStats.roundExperience`，利用既有 Mission 投影/恢复保留；无顶层 context。来源、versions、scopeDigest、contextId 均可核查。同轮已有 context 只校验/冻结/复用，不重新查询人工更新；不同轮才取得新快照。恢复对象也必须摘要有效，不能用当前最新经验悄悄替换。进程内同一 state 对象的并发准备共享 Promise。

roundExperienceStatus 记录 preparing/ready/failed；experienceCollection 记录有界的计数、ID/version/evidenceKey 或 skipped 原因。迟到检索结果不写状态，也不替换别的 Mission。读取人工 advice 不会调用任何 Agent 端口。

CPU/仿真保持 development-record，所有写回观察必须 publishable=false。验证失败返回明确 skipped；摘要冲突、存储/超时错误不吞掉。batch deadline 传递到 record 和 verify 的组合 signal，截止后不再发起新写入；已经开始的存储写可能无法物理取消，超时保留 effectUnknown，后续以同证据键显式核实/幂等重试。

## Dependencies / Side Effects

仅导入 experience-contract 的公开纯 API；计时、授权、验证与经验存储均由端口提供。内存变更仅 iterationStats 两个状态记录和冻结 context。无 state-store、FS/HTTP/Provider 实现、发布 Gate 或硬件依赖。

## Error Contract

ROUND_EXPERIENCE_ACCESS_INVALID、CONTEXT_CONFLICT、EVIDENCE_CONFLICT、LIMIT_EXCEEDED 为 409；ROUND_EXPERIENCE_TIMEOUT 为 504，带 stage/effectUnknown。领域及存储错误原样传播。缺端口/非法时间为 TypeError。失败必须阻止依赖该步骤的新 Agent 启动，不回退为空上下文。

## Example / Verification

```js
await roundExperience.collect({ state, mission });
const context = await roundExperience.prepare({ state, mission, roundId });
// Existing Agent start receives experienceContext: context.
```

`node tests/round-experience-service-test.mjs`、`node tests/agent-round-service-test.mjs`、`node tests/experience-service-test.mjs`；纯内存/注入假端口，无真实 Agent。

## Change Checklist / Known Limitations

字段/端口变化同步此契约、AgentRound、经验纯契约及测试。context 64 KiB/20 项上限沿用领域。默认检索不猜 dtype/shape；未接完整包验证的旧结果不会自动成为观察。状态跨对象/进程的串行持久化由既有 Repository/command journal 负责；本服务不提供第二套事务恢复。
