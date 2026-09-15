# Experience Contract

## Purpose

纯领域经验契约：保存人工建议与绑定执行凭据的观察，执行版本、适用范围和检索规则。经验不是 Profile、测试结果或发布授权。

## Responsibilities / Non-Responsibilities

- 负责输入白名单、规范化、追加版本、证据幂等、项目与 scope 过滤、冻结轮次 context。
- 不负责身份认证、证明输入凭据真实、读取凭据文件、运行测试/模型、Mission 工作流或 GPU 发布 Gate。

## Public API

| 导出 | 输入 / 输出 |
|---|---|
| `EXPERIENCE_SCHEMA_VERSION` / `EXPERIENCE_LIMITS` | schema 1 和冻结的大小上限 |
| `experienceError(code,message,status=400)` | 带 `code/status` 的 Error |
| `emptyExperienceStore()` | 新 `{schemaVersion,revision:0,records:[]}` |
| `validateExperienceStore(store)` | 校验规范值、连续历史与证据键；返回原引用 |
| `appendExperience(store,input,{id,now,source='human'})` | 修改传入草稿；返回 `{changed,result:{experience,created}}` |
| `updateExperience(store,id,patch,options,{now})` | 同上；追加版本，`created:false` |
| `readExperiences(store,id,options)` | 独立副本 `{repositoryRevision,experience}` 或 `{repositoryRevision,experiences}` |
| `retrieveExperienceContext(store,query,{now})` | 递归冻结的轮次快照（无 `query.selection` 时返回契约不变）；带 `query.selection` 时走方案 D 选择 |
| `retrieveExperienceSelection(store,query,{now})` | `{context,selection}`：同一次遍历产出的冻结 context 与审计选择清单 |
| `EXPERIENCE_SELECTION_SCHEMA_VERSION` / `EXPERIENCE_SELECTION_POLICY_VERSION` | 旧审计选择清单 schema 与策略版本常量 |
| [experience-selection.mjs](experience-selection.mjs) | 方案 D 纯选择器：`WIKI_SELECTION_POLICY_VERSION`、`normalizeSelectionMetadata`、`rankExperienceCandidates` |
| `validateExperienceContext(context,expected={})` | 校验绑定/来源/版本/摘要，原地递归冻结并返回同一对象 |
| `formatExperienceContext(context,{projectId,missionId,roundId})` | 校验后生成有界不可信 JSON 数据提示词片段 |

## Inputs

创建必填 `projectId/title/content/author`；可选 `visibility=project|shared`（默认 project）、`confidence=low|medium|high`（默认 low）、scope、字符串数组 evidenceRefs、expiresAt。人工仅 `source=human,kind=guidance`；执行仅 `source=execution,kind=observation`。不接受调用者指定 id/version/timestamps/verification。id 与 now 为工厂端口值。

人工 guidance 另可带**可选 `selectionMetadata`**（KernelWiki 出处/相关性元数据，形状与边界见 [experience-selection.md](experience-selection.md)）：缺省时该属性完全省略，历史记录与冻结 context **零迁移**；同一 ID 的更新可推进元数据版本。**执行记录永不接受该属性**（输入白名单与规范形状校验都会拒绝）。通用 HTTP 创建/更新必须拒绝该属性，唯一入口是显式导入 API（B 的 `kernel-wiki-import`）；原始 topics **绝不复制进 `scope.tags`**，元数据也不改变 scope 语义。

scope 为 `{operator?,tags?,hardware?,architecture?,dtype?,shape?}`；列表值及 operator 规范为小写。匹配要求 operator 一致、所有经验 tags 存在、shape 对象字段子集一致；hardware、architecture、dtype 是**相互独立的维度，跨维度取 AND**，仅在维度内部取 OR（交集）。厂商与架构绝不合并进同一个数组，否则查询 `nvidia-gpu`+`sm86` 会假命中 `nvidia-gpu`+`sm100`。数组精确比较，保留重复维度；某维度未声明表示该维度不构成约束。不解释 shape 范围或语言语法。

执行 evidence 必填 `missionId/candidateId/runId/patchDigest/packageDigest/environmentDigest/acceptanceDigest/hardware/executionMode/outcome`，可选 `architecture`、`operation='test'`、一致的 liveHardware。摘要为 SHA-256 十六进制，可带 `sha256:`；executionMode 为 cpu/gpu/simulation，outcome 为 passed/failed/cancelled。CPU 的 hardware 必须 cpu；执行 scope.hardware 必须只包含实际 hardware，省略时补入。执行 scope.architecture 同样只能由该次执行的 evidence.architecture 盖章；**证据未声明 architecture 时，调用方用 scope.architecture 声明会被明确拒绝 `EXPERIENCE_INVALID`**，不得用调用方 scope 补造证据从未确认的架构。历史记录（scope 与 evidence 均无 architecture）形状不变、零迁移可读，matching 时不因当前目标架构而补造或改写。

update options 必填 `{projectId,expectedVersion}`；人工可更新内容、标题、作者、scope、confidence、visibility、status、refs、expiresAt；执行仅可更新 status。status 为 active/archived/invalidated/conflicted。项目与来源不可改。

read options 必填 projectId，可选 allowedProjectIds/version。query 必填 projectId/missionId/roundId，可选 scope、allowedProjectIds、limit（最大 20；默认值：无 `selection` 的旧检索 8，带 `selection` 的方案 D 为 10 = 本地 ≤4 + Wiki ≤6，否则默认上限会先于配额把建议名额截断）、versions（id → 当前版本约束）、`selection`（方案 D，见下）。跨项目读取要求记录 shared 且其 projectId 在调用者显式白名单；共享不授予更新权。

`query.selection={policyVersion,features,target,preferredIds?,repeatedAttempts?}`（形状与规则见 [experience-selection.md](experience-selection.md)）。提供时必须匹配 `WIKI_SELECTION_POLICY_VERSION`，`target.hardware/architecture` 必须与规范 scope 一致（target 不能声明 scope 之外的目标来放宽准入）。选择流程：先对**全部**候选（不做「最近 N 条」预截断）校验授权、最新状态/过期/版本与 scope，再交给纯选择器排序，然后按 **ID+版本**取回并重新校验 scope/状态/版本后渲染。**排序不能授予访问权**；未授权记录只累计 `excludedUnauthorized` 计数，绝不在排除详情里泄露其 ID/版本/内容。默认配额：本地 ≤4、Wiki ≤6（其中症状 ≤2、手法 ≤3、兜底指导 ≤1），都是上限、不补齐；提供既往尝试时最多再引入一个未尝试过的手法。保留既有 20 项 / 64 KiB / 单条 8000 字符硬上限，`query.limit` 仍是进一步上限；软预算 **24 KiB** 按 formatter **实际 UTF-8 输出**计算（轮次必需事实在该预算之外）；超预算的可选记录跳过并继续考虑后续更小的候选。选择清单审计：策略版本、`features`、规范化 `target`、配额、实际 context/渲染字节、选中原因与有界排除原因、快照身份（`repositoryRevision` 加选中 Wiki 单元的 `sourceCommit/sourceDigest/unitDigest`）。快照身份按**每个选中记录**逐条列出：`sources[{recordId,version,pageId,sourceCommit,sourcePath,sourceDigest,unitDigest}]`，同一 `pageId` 的原始单元与 `reviewed-transfer` 单元各有自己的 ID/版本/`unitDigest`，不得按 `pageId` 合并而互相覆盖。**不得**把旧策略版本盖到 D 选择上。无 `selection` 时行为与旧版本完全一致。

## Outputs / Invariants

store 保留全部平铺版本。幂等键绑定项目、Mission、Candidate、run、operation；同键同规范内容不变更，不同摘要或内容报冲突。已归档观察重试返回当前版本，不重新激活。

所有 `verification.publishable=false`。人工为 unverified/human-guidance；CPU 为 observed/cpu-development；仿真为 unverified/simulation；GPU 仅 observed/hardware-observation，绝不代表正式验证。置信度不会提升证据等级。

context 含 schemaVersion/contextId/projectId/missionId/roundId/asOf/repositoryRevision/items，以及 scope、scopeDigest、allowedProjectIds、versions（id → version）。scopeDigest 和整个 contextId 使用本模块唯一的规范 JSON/SHA-256 算法；来源、版本、授权快照及 evidence 全在摘要内。人工 useAs=suggestion，CPU/仿真为 development-record，GPU 为 observation。只选最新 active、未过期、版本匹配且适用的记录；按更新时间降序、id 排序。旧 context 不随后续写入变化。

selection（无 `query.selection` 时为旧的 `operator-studio.experience-selection/v1` 审计旁路；带 `query.selection` 时为方案 D 清单，`policyVersion` 为 `operator-studio.optimization-hypothesis-selection/v1`）与冻结 context 由**同一次遍历**产出，因此选中集合、顺序、20 项/64 KiB 硬限完全一致；它不参与 context 校验，也不能替代 context。旧清单字段：`policyVersion`（如实标注当前策略：Mission scope 匹配 + 既有 updatedAt 降序/id 升序，**不是 Phase 3 动态选择器**）、`projectId/missionId/roundId`、`repositoryRevision`、`contextId`、`scopeDigest`、`scope`、`requestedLimit/itemLimit/byteLimit`、`contextBytes`（`Buffer.byteLength` UTF-8 实测）、`selected[{id,version,source,useAs,reason}]`、`excluded[{id,version,reason}]`、`excludedUnauthorized`（计数）、`excludedOmitted`（超过 50 条上限的计数）。排除原因是实际命中的 `inactive/expired/version-pinned/scope/limit/budget`；**未授权项目的记录只计入 `excludedUnauthorized`，绝不出现其 ID、版本或内容**。

validate 的 expected 可提供 projectId/missionId/roundId/scope/allowedProjectIds；检查记录的全部规范字段、版本、适用范围和冻结时授权，不允许用其他 Project/Mission/轮次的 context 替代。已有上下文缺少完整字段或摘要时明确失败，不静默重建。摘要用于一致性校验，不是签名或认证；调用者仍须提供可信权限。formatter 必须传三个身份，只输出 UNTRUSTED JSON，并声明不能覆盖 Profile、Gate、独立 oracle、预算或文件边界；其最大字节数为 context 上限加固定说明（小于 2 KiB）。

## Dependencies / Side Effects

仅依赖 `node:crypto` 计算摘要，以及纯模块 [experience-selection.mjs](experience-selection.mjs)（其自身无导入，方向为 contract → selection，不成环）；无 FS/HTTP/Provider/state-store 导入。now 必须显式传入，不读取系统时钟。append/update 仅修改调用者提供的内存草稿；无其他副作用。read 是可变副本，只有 context 递归冻结。

## Error Contract

`EXPERIENCE_INVALID`=400；`EXPERIENCE_NOT_FOUND`=404（包括无权访问）；版本、证据或 ID 冲突及容量限制为 409。`EXPERIENCE_CONTEXT_INVALID`=409，禁止启动依赖该 context 的 Agent。调用者应修正输入/重新读取版本，不覆盖冲突。摘要仅绑定声明，不能凭空验证真实性。

## Example / Verification

应用入口见 [experience-service.md](application/experience-service.md) 和 [轮次集成](application/round-experience-service.md)。运行 `node tests/experience-service-test.mjs`、`node tests/round-experience-service-test.mjs`、`node tests/experience-architecture-test.mjs`；覆盖规则、上下文篡改/恢复、architecture 跨维度 AND、执行盖章与历史零迁移，以及临时目录适配器，无硬件/模型。

## Change Checklist / Known Limitations

API/schema 变更同步此契约、`experience-selection.md`、应用契约、测试及调用者。最多 2048 条历史、8 MiB store、32 KiB 单记录（含可选 `selectionMetadata`）、8000 字符正文、64 KiB context；shape 深度 4、256 节点。达到上限明确失败，不自动删除历史。`selectionMetadata` 只描述出处与相关性，不提升证据等级、不改变 scope 语义、不授予访问或发布权。无向量检索、授权推断、签名验证或自动冲突合并；冻结 context 的每轮持有/复用由调用者负责，同一轮重试/恢复复用既有冻结选择，全新逻辑轮才重新选择。
