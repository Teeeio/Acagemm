# Experience Service

## Purpose

把经验领域规则接到注入的 repository、时钟和 ID 端口，供既有应用流程记录/查询经验。它不是第二条 workflow，也不会触发 Agent 或测试。

## Responsibilities / Non-Responsibilities

- 负责 read/create/update/recordObservation/retrieve 的应用 API 与事务边界。
- 不负责创建默认 adapter、加载 runtime state、生成执行凭据、认证用户、修改 Knowledge 发布状态或运行任务。

## Public API

`createExperienceService({repository,now,createId})` 返回冻结的服务对象。三个端口必须显式注入，无默认 FS、状态或时钟实现。

| 方法 | 输入 | Promise 输出 |
|---|---|---|
| `read(id=null,options)` | options: projectId、allowedProjectIds?、version? | `{repositoryRevision,experience}` 或 `{repositoryRevision,experiences}` |
| `create(input)` | 人工经验字段 | `{experience,created:true}` |
| `update(id,patch,options)` | options: projectId、expectedVersion | `{experience,created:false}`，追加版本 |
| `recordObservation(input)` | 执行经验与绑定 evidence | `{experience,created}`；同证据重试 false |
| `retrieve(query)` | projectId、missionId、roundId、scope?、limit?、versions?、allowedProjectIds? | 递归冻结 context |

## Inputs

字段白名单与完整约束见 [experience-contract.md](../experience-contract.md)。`repository` 提供异步 read()/transact(mutator)，后者接受同步领域草稿变更；`now()` 返回 ISO 时间字符串，`createId()` 返回不含路径的安全标识符。写操作在事务队列内取时间/ID；幂等重试仍可能调用 ID/时间端口，但不产生存储变化。retrieve 在读取完成后获取 asOf。

调用者必须提供可信 projectId 与 allowedProjectIds；用户输入不能自授跨项目白名单。共享记录仍仅在授权项目范围可见，更新严格属于当前项目。read(null) 返回可见最新记录（包含非 active，便于治理）；read(id,{version}) 可查历史，但不能绕过当前头版本的共享权限。

recordObservation 的包、环境、验收和 Candidate 摘要必须来自上游已绑定执行结果。本模块仅验证字段一致性，不证明这些值真实。人工与执行分别固定 guidance/observation；人工内容不接收 verification，执行内容只允许追加状态修订。

## Outputs / Invariants

read 和写返回独立可变副本；retrieve 返回不可变、带版本/来源/凭据的 context。旧 context 不受随后 update 影响；调用者应每轮取得一次并持有该对象，重启恢复时自行持久化该 context。本服务不缓存 roundId，相同轮次再次调用可能取得新 repositoryRevision。

人工始终 unverified 建议；CPU/仿真只供开发记录；GPU 观察仍 `publishable:false`。任何来源都不授予正式发布权。retrieve 只选最新有效且匹配 scope 的记录，不复活归档/冲突/失效或旧 pin 版本。外部建议正文应作为带来源的数据注入，而非可信系统指令。

## Dependencies / Side Effects

仅导入公开 experience-contract API。禁止 state-store、文件适配器默认导入、HTTP、Provider 和固定 Profile 实现。副作用仅通过 repository/now/createId 端口；不写 Mission、Candidate、Knowledge，不启动模型、进程、测试或硬件。

## Error Contract

缺端口为 TypeError；领域与 repository 稳定错误原样传播（见相应契约）。调用者区分 400 输入、404 无记录/无权限、409 版本或证据冲突、503 存储故障；不可把写失败当成功记录或把损坏当空库。

## Example

```js
const service = createExperienceService({ repository, now, createId });
await service.create({ projectId, author: 'reviewer', title: 'Bounds',
  content: 'Check the tail before attempting vectorization.', scope: { operator } });
const context = await service.retrieve({ projectId, missionId, roundId,
  scope: { operator, hardware: ['cpu'] } });
```

## Verification

`node tests/experience-service-test.mjs`；覆盖纯规则、真实临时文件 adapter 以及故障注入，无外部网络、真实模型或硬件。公共命令、归属索引及既有流程集成由组合根维护者配置。

## Change Checklist / Known Limitations

API/端口/错误/schema 变化同步领域和 repository 契约、调用者及测试。不提供租户认证、向量排序、语义冲突检测、跨文件事务或 Agent 提示词拼装；状态与版本冲突是显式字段/乐观锁规则。所有语言、工具链和 GPU 发布验收仍由原有执行包与 Gate 约束。
