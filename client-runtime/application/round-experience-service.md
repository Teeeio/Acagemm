# Round Experience Service

## Purpose / Responsibilities

在既有轮次启动路径冻结可审计经验，并把经可信验证的执行观察追加到经验服务。不是第二条 workflow；不运行 Agent、测试、GPU 或网络，也不授予发布权限。

## Public API / Inputs

`createRoundExperienceService({experienceService,resolveAccess,verifyObservationEvidence,timers,timeoutMs=3000,experienceCondition?})` 返回冻结的 `{prepare,collect,record}`。

- experienceService：注入公开 retrieve/recordObservation API，不默认导入 repository。存在可选 `retrieveWithSelection` 时一次调用取得内容和审计清单；仅缺少该端口时用原 retrieve 并派生明确标记的清单。旧 retrieve-only 注入行为不变。
- experienceCondition（可选，构造期）：受控经验条件，只能是 [经验契约](../experience-contract.md) 的冻结枚举 `EXPERIENCE_CONDITIONS` 之一（`facts-only`/`local-only`/`local-and-wiki`）。**省略即当前行为**，不新增任何查询键。显式给出时构造期同步校验：未知/`null`/空串/非字符串值、或注入的 experienceService 没有 `retrieveWithSelection`（旧 retrieve-only 注入无法表达条件），都在任何有副作用操作之前以 `TypeError`+`EXPERIENCE_INVALID` 失败，绝不静默退回未过滤的经验。显式条件在每**新**轮作为 `query.selection.experienceCondition` 原样下发，绝不改 rank/配额/预算。
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

同轮冻结的审计清单保存在 `state.iterationStats.roundExperienceSelection`（与 `roundExperience` 同 round 的 sidecar）：含选中/排除记录的 ID/version/source/reason、策略版本、repositoryRevision/contextId、`contextBytes` 与 `renderedBytes`（均按 UTF-8 `Buffer.byteLength` 实测）。内容和清单来自同一次仓库读取，严格核对 contextId/revision/scopeDigest、身份、选中记录的顺序/版本/来源；审计端口返回不一致时以 `ROUND_EXPERIENCE_SELECTION_CONFLICT` 阻止本轮准备，存储错误不吞掉。旧结构/旧 retrieve-only 注入仍可读，其清单标记 `auditSource:context-derived`、`exclusionReasonsRecorded:false`、原因 `frozen-context`，不编造排除原因。同轮恢复不重查、不刷新清单。显式条件时清单按检索端口原样保留 `experienceCondition`；省略模式不写该字段（旧清单零迁移）。全新轮的检索同样受条件冻结约束：返回审计里的条件必须**严格等于**构造期配置，清单漏条件或条件不同都在写回 ready/冻结 context 之前按 `ROUND_EXPERIENCE_SELECTION_CONFLICT` 拒绝，绝不落盘一份与配置不符、看起来正常的冻结上下文；省略模式（`undefined`）保持兼容——清单本来就不带该字段时严格相等成立，不要求补写新字段。

同轮冻结同时冻结条件：以同一 roundId 复用既有冻结 context 时，配置的 `experienceCondition` 必须与冻结清单记录的条件**完全一致**；冻结清单缺该条件（旧清单、`context-derived` 清单或被换掉的清单）与条件不同一样按 `ROUND_EXPERIENCE_CONTEXT_CONFLICT` 拒绝——绝不重新选择、不给旧清单补写它从未使用过的条件、也不改标签。只有全新逻辑轮才按配置条件选择。校验发生在写回任何状态之前。进程内同一 state 对象的并发准备共享 Promise（模块级 pending），但去重只对**同一冻结条件**成立：claim 携带构造期条件，复用前严格比对，不同条件的实例并发准备同一轮按 `ROUND_EXPERIENCE_CONTEXT_CONFLICT` 拒绝，绝不把先到条件的 context 当成本轮结果；同条件仍照旧去重。

存在真实 `retrieveWithSelection` 端口时，prepare 传 `query.selection={policyVersion,features,target,preferredIds?,repeatedAttempts?}`（方案 D 选择）：策略版本静态取自 [experience-selection](../experience-selection.md) 的冻结导出 `WIKI_SELECTION_POLICY_VERSION`，模块缺失即加载失败并阻止依赖该轮知识的新 Agent 启动，不静默退回无知识。

`features` 至多 8 条、每类（structure/failure/symptom/technique）至多 2 条，0 条合法。来源只有两类：Mission 显式字段与已提交事实。structure 仅取 Mission 显式声明的算子身份；symptom/technique 由 Mission goal/title 原文经固定词表映射为可匹配 wiki topic 的假设；failure 与"上一轮已尝试的改动"由已提交同 Mission 事实映射。**候选文件名/产物路径不是结构证据，指标名与耗时数值不是症状**——它们只是测量名，不能当作已观测瓶颈，因此不进入特征。失败特征先判定 infrastructure/provider 分类并整条排除，只保留正确性/编译/算子失败。每条特征都带非空 basis（≤1000），不产生硬件能力、不猜根因、不带数值置信度。

事实只来自已提交、已归档且绑定同一 Mission 与 Project 的轮次事实：归档 `runHistory.roundFacts` 与 `iterationStats.roundFacts` 合并后按各自 `recordedAt` 排序，**旧快照不得遮蔽更新的归档事实**。归属必须双向已知且一致——`previous.missionId` 与 `target.missionId` 都必须等于本 Mission，`previous.projectId` 与 `target.projectId` 都必须存在且都等于本 Mission 的 Project；Mission 没有已知 projectId、owner 缺失或两个归属字段互相矛盾时整条排除，不互补、不取其一、不拿别 Project 事实凑数。缺 run 身份、别 Mission、别 Project 的条目一律不参与。未提交对象与别 Mission 的 benchmark 不能造出任何事实。

`target` 的 hardware/architecture 与规范 scope 一致；capabilities/software 只在 `resolvedTarget` 显式为同一 Mission 提供时读取，未知维度保持空数组（不从 goal、tags、backend 名或硬件字符串反推）。

`preferredIds` 只绑定能由既有证据指认候选的经验 ID：候选身份以已提交事实的真实字段 `candidate.id` 为先，`previous.candidateId` 只是历史兼容字段、仅在其缺失时回退（previous 未必是候选身份）；当前最佳取 `state.currentBest.candidateId`。冻结 context 中的执行记录必须同时满足 `evidence.missionId` 等于本 Mission、`projectId` 等于本 Mission 的 Project，且 `evidence.candidateId` 等于上一失败候选、当前最佳或本轮执行候选之一；绑定不上就整体省略，不给全部收集记录套同一个偏好。

`repeatedAttempts` 的尝试身份 = 修改内容（patch/package 摘要）+ 参数与环境（environment 摘要）+ 验收条件（acceptance 摘要）+ 实际执行条件（hardware/architecture/executionMode/operation），用递归键排序的 SHA-256 得到有界 `attempt_<64hex>` 身份。**刻意不含 candidateId/runId**：同一修改在全新 candidate 身份下重提仍可判定为重复；但完整来源身份（`evidence.missionId`/`runId`/`candidateId` 三者都非空）是声明重复的前提，缺任一必需摘要、执行条件或来源身份即不声明（保留 unknown）。当前尝试与其归档对照都必须来自**终态** benchmark（沿用既有生产状态集合 `complete`/`failed`/`cancelled`）：running/idle/queued 的执行可能已缓存 `experienceEvidence` 但尚未结算，不得据此声明重复；归档条目还必须在已给出的 `roundFacts` 项目归属与 Mission 矛盾时排除。重复成立后，只有冻结 context 中能逐条重算、确认同一身份**且** `evidence.missionId` 等于本 Mission、`projectId` 等于本 Mission 的 Project 的执行记录才被降权（精确 id/version）；别 Mission/别 Project 的同 digest 记录不得降权，只有 id/version 的收集摘要不足以判定即不声明——绝不把同一 key 套给所有收集记录，也不因一次重复封禁整类技术。旧 retrieve-only 注入不传任何新增参数。审计 sidecar 保留检索端口实际使用的策略版本，不用旧 retrieve-only 版本号覆盖 D 选择。

roundExperienceStatus 记录 preparing/ready/failed；experienceCollection 记录有界的计数、ID/version/evidenceKey 或 skipped 原因。迟到检索结果不写状态，也不替换别的 Mission。读取人工 advice 不会调用任何 Agent 端口。

CPU/仿真保持 development-record，所有写回观察必须 publishable=false。验证失败返回明确 skipped；摘要冲突、存储/超时错误不吞掉。batch deadline 传递到 record 和 verify 的组合 signal，截止后不再发起新写入；已经开始的存储写可能无法物理取消，超时保留 effectUnknown，后续以同证据键显式核实/幂等重试。

## Dependencies / Side Effects

仅导入 experience-contract 的公开纯 API、operator-test-evidence 的失败分类/backend 判定、静态导入的纯选择策略模块与 `node:crypto`（尝试身份摘要）；没有动态加载器或域应用的旁路。计时、授权、验证与经验存储均由端口提供。内存变更仅 iterationStats 的冻结 context、选择清单 sidecar 与两个状态记录。无 state-store、FS/HTTP/Provider 实现、发布 Gate 或硬件依赖。

## Error Contract

ROUND_EXPERIENCE_ACCESS_INVALID、CONTEXT_CONFLICT、EVIDENCE_CONFLICT、LIMIT_EXCEEDED、TARGET_INVALID 为 409；ROUND_EXPERIENCE_TIMEOUT 为 504，带 stage/effectUnknown。TARGET_INVALID 覆盖：未解析 hardware 位置出现 backend 名、显式 scope 与已绑定执行目标冲突、显式 scope 非普通对象。领域及存储错误原样传播。缺端口/非法时间为 TypeError；非法 `experienceCondition`、或显式条件缺少 `retrieveWithSelection` 端口，为构造期 `TypeError` + `EXPERIENCE_INVALID`（400），在任何副作用之前同步失败。失败必须阻止依赖该步骤的新 Agent 启动，不回退为空上下文。

## Example / Verification

```js
await roundExperience.collect({ state, mission });
const context = await roundExperience.prepare({ state, mission, roundId });
// Existing Agent start receives experienceContext: context.
```

`node tests/round-experience-service-test.mjs`、`node tests/agent-round-service-test.mjs`、`node tests/experience-service-test.mjs`；纯内存/注入假端口，无真实 Agent。

## Change Checklist / Known Limitations

字段/端口变化同步此契约、AgentRound、经验纯契约及测试。`experienceCondition` 是冻结的可选构造参数：默认省略，仅在受控实验里显式给出；显式条件与冻结清单的一致性检查不得放宽，也不得把条件写进冻结 context、轮次必需事实或任何 Agent/GPU 端口。context 64 KiB/20 项上限沿用领域。默认检索不猜 dtype/shape；未接完整包验证的旧结果不会自动成为观察。状态跨对象/进程的串行持久化由既有 Repository/command journal 负责；本服务不提供第二套事务恢复。
