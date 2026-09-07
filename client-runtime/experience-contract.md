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
| `retrieveExperienceContext(store,query,{now})` | 递归冻结的轮次快照 |
| `validateExperienceContext(context,expected={})` | 校验绑定/来源/版本/摘要，原地递归冻结并返回同一对象 |
| `formatExperienceContext(context,{projectId,missionId,roundId})` | 校验后生成有界不可信 JSON 数据提示词片段 |

## Inputs

创建必填 `projectId/title/content/author`；可选 `visibility=project|shared`（默认 project）、`confidence=low|medium|high`（默认 low）、scope、字符串数组 evidenceRefs、expiresAt。人工仅 `source=human,kind=guidance`；执行仅 `source=execution,kind=observation`。不接受调用者指定 id/version/timestamps/verification。id 与 now 为工厂端口值。

scope 为 `{operator?,tags?,hardware?,dtype?,shape?}`；前三类列表值及 operator 规范为小写。匹配要求 operator 一致、所有经验 tags 存在、hardware/dtype 有交集、shape 对象字段子集一致；数组精确比较，保留重复维度。不解释 shape 范围或语言语法。

执行 evidence 必填 `missionId/candidateId/runId/patchDigest/packageDigest/environmentDigest/acceptanceDigest/hardware/executionMode/outcome`，可选 `operation='test'`、一致的 liveHardware。摘要为 SHA-256 十六进制，可带 `sha256:`；executionMode 为 cpu/gpu/simulation，outcome 为 passed/failed/cancelled。CPU 的 hardware 必须 cpu；执行 scope.hardware 必须只包含实际 hardware，省略时补入。

update options 必填 `{projectId,expectedVersion}`；人工可更新内容、标题、作者、scope、confidence、visibility、status、refs、expiresAt；执行仅可更新 status。status 为 active/archived/invalidated/conflicted。项目与来源不可改。

read options 必填 projectId，可选 allowedProjectIds/version。query 必填 projectId/missionId/roundId，可选 scope、allowedProjectIds、limit（默认 8，最大 20）、versions（id → 当前版本约束）。跨项目读取要求记录 shared 且其 projectId 在调用者显式白名单；共享不授予更新权。

## Outputs / Invariants

store 保留全部平铺版本。幂等键绑定项目、Mission、Candidate、run、operation；同键同规范内容不变更，不同摘要或内容报冲突。已归档观察重试返回当前版本，不重新激活。

所有 `verification.publishable=false`。人工为 unverified/human-guidance；CPU 为 observed/cpu-development；仿真为 unverified/simulation；GPU 仅 observed/hardware-observation，绝不代表正式验证。置信度不会提升证据等级。

context 含 schemaVersion/contextId/projectId/missionId/roundId/asOf/repositoryRevision/items，以及 scope、scopeDigest、allowedProjectIds、versions（id → version）。scopeDigest 和整个 contextId 使用本模块唯一的规范 JSON/SHA-256 算法；来源、版本、授权快照及 evidence 全在摘要内。人工 useAs=suggestion，CPU/仿真为 development-record，GPU 为 observation。只选最新 active、未过期、版本匹配且适用的记录；按更新时间降序、id 排序。旧 context 不随后续写入变化。

validate 的 expected 可提供 projectId/missionId/roundId/scope/allowedProjectIds；检查记录的全部规范字段、版本、适用范围和冻结时授权，不允许用其他 Project/Mission/轮次的 context 替代。已有上下文缺少完整字段或摘要时明确失败，不静默重建。摘要用于一致性校验，不是签名或认证；调用者仍须提供可信权限。formatter 必须传三个身份，只输出 UNTRUSTED JSON，并声明不能覆盖 Profile、Gate、独立 oracle、预算或文件边界；其最大字节数为 context 上限加固定说明（小于 2 KiB）。

## Dependencies / Side Effects

仅依赖 `node:crypto` 计算摘要；无 FS/HTTP/Provider/state-store 导入。now 必须显式传入，不读取系统时钟。append/update 仅修改调用者提供的内存草稿；无其他副作用。read 是可变副本，只有 context 递归冻结。

## Error Contract

`EXPERIENCE_INVALID`=400；`EXPERIENCE_NOT_FOUND`=404（包括无权访问）；版本、证据或 ID 冲突及容量限制为 409。`EXPERIENCE_CONTEXT_INVALID`=409，禁止启动依赖该 context 的 Agent。调用者应修正输入/重新读取版本，不覆盖冲突。摘要仅绑定声明，不能凭空验证真实性。

## Example / Verification

应用入口见 [experience-service.md](application/experience-service.md) 和 [轮次集成](application/round-experience-service.md)。运行 `node tests/experience-service-test.mjs`、`node tests/round-experience-service-test.mjs`；覆盖规则、上下文篡改/恢复和临时目录适配器，无硬件/模型。

## Change Checklist / Known Limitations

API/schema 变更同步此契约、应用契约、测试及调用者。最多 2048 条历史、8 MiB store、32 KiB 单记录、8000 字符正文、64 KiB context；shape 深度 4、256 节点。达到上限明确失败，不自动删除历史。无向量检索、授权推断、签名验证或自动冲突合并；冻结 context 的每轮持有/复用由调用者负责。
