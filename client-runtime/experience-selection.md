# Experience Selection

## Purpose

Phase 3 方案 D 的**确定性优化假设选择器**：把「能不能用」（作用域/适用性准入）与「这轮值不值得看」（相关性排序）分开。它只排序候选并给出选择/排除原因，不取内容、不授予访问、不渲染提示词、不代表证据或验证结论。选择元数据是出处与相关性线索，**永远不是证据**，也不是 `scope.tags` 的替代品。

## Responsibilities / Non-Responsibilities

- 负责：规范化可选 `selectionMetadata`；在全部候选上重做适用性过滤；按本地经验 → Wiki 的顺序做确定性排序、一跳展开、去重与降权。
- 不负责：访问控制、状态/过期/版本校验、配额与字节预算、上下文渲染（由 [experience-contract.md](experience-contract.md) 在同一次遍历中完成）；不调用模型、不判定瓶颈、不发布。
- 症状一律是**待验证假设**：没有数值置信度，不从时间/shape 推断已测得的瓶颈。

## Public API

| 导出 | 输入 / 输出 |
|---|---|
| `WIKI_SELECTION_POLICY_VERSION` | `'operator-studio.optimization-hypothesis-selection/v1'` |
| `normalizeSelectionMetadata(value)` | 校验并返回规范元数据（新对象，键序固定）；缺省属性不会被补造 |
| `rankExperienceCandidates(records, options)` | 纯函数；返回 `{ordered:[{id,version,reason,bucket}],excluded:[{id,version,reason}]}` |

模块无任何 `import`（因此不可能与 `experience-contract.mjs` 形成环），不读时钟、不读写存储、不发网络。

## Metadata

只允许 `source='kernel-wiki'`，且**只有这些键**：`sourceCommit`（40 位小写十六进制）、`sourcePath`（安全的相对 `wiki/*.md` 路径，允许嵌套目录）、`pageId`（安全标识符）、`sourceDigest`（整页原始 UTF-8 的 64 位小写十六进制）、`unitDigest`（注入内容的 64 位小写十六进制）、`type`（原始非空类型）、`topics`、`symptoms`、`candidateTechniques`、`architectures`、`applicability`。所有数组 ≤32 项、每项 ≤160 字符、去重。`applicability={mode,reviewId,hardware,architectures,requiredCapabilities,software}`，`mode` 为 `unreviewed|architecture-specific|reviewed-transfer`；`unreviewed` 时 `reviewId` 必须为 `null`，否则必须是非空有界标识符。`hardware/architectures/requiredCapabilities/software` 规范化为小写；`topics/symptoms/candidateTechniques/architectures` 保留原始大小写作为出处。

顶层 `architectures` 是原始出处，可以为空；`applicability.architectures` 是审查结论：两个经审查模式（`architecture-specific`、`reviewed-transfer`）在**规范化阶段就明确拒绝空列表**（`EXPERIENCE_SELECTION_INVALID`），而不是留到排序时兜底。空架构页面只能表示为 `unreviewed`，仍入库但永不自动注入。

## Applicability

- `unreviewed` **永不自动注入**（仍保留在 store 中）。
- `architecture-specific` 与 `reviewed-transfer` 都要求非空且显式经审查的 `architectures` 列表，空列表在规范化时即报错。
- 跨维度取 **AND**（硬件 ∧ 架构 ∧ 必需能力 ∧ 软件要求）；`hardware`/`architectures` 维度内部取 **OR**（交集非空）；`requiredCapabilities`/`software` 取 **子集**。
- 目标维度缺失即判不适用；**不从设备名或 sm80 推断 sm86**。

## Options

`{features,target,preferredIds?,repeatedAttempts?}`：

- `features` ≤8 个 `{kind,value,basis}`；`kind` 为 `structure|failure|symptom|technique`，每类 ≤2；`value` ≤160；`basis` 非空 ≤1000。特征只是相关性线索，**不是目标硬件声明**。
- `target={hardware,architecture,capabilities,software}` 字符串数组（规范化小写）。
- `preferredIds` ≤20；`repeatedAttempts` ≤20 个 `{id,version,attemptKey}`；`attemptKey` 绑定「修改+参数+适用条件」，不是方法名。

## Ranking

本地执行记录与当前项目 guidance 优先：**当前失败观察** → 显式 preferred（最佳/未解决）→ 命中特征 → 较近的本地 guidance（`updatedAt` 降序，随后 id 升序/version 降序）。「当前失败观察」= 与本轮 features 相关、或显式 preferred 的失败记录；**不相关的旧失败只算本地历史**，退回最后一组，不能恒定压过当前 preferred/相关失败。相关性取值保留 scope 全量与执行证据的实际条件（算子、dtype、shape、硬件/架构、operation、outcome）。**保留记录内容与 scope 全量**，排序结果只引用 ID/版本。

Wiki 顺序：failure 命中 → structure 命中 → 症状假设命中 → 手法命中；兜底指导仅限**被明确声明为指导的已审查单元**（项目审查产出的 `reviewed-transfer` 单元，或页面自身 `type=guidance`）。普通 `kernel/hardware/language/migration` 页面即使已审查，只要无主题命中就排除，不靠类型名填 ≤1 的兜底名额。主题命中只看内容线索（`topics`/`symptoms`/`candidateTechniques`/`architectures`），`type` 只决定 bucket、不作为内容参与匹配。

`bucket` 由类型决定：`symptom`/`pattern`→symptom（KernelWiki 的 `pattern` 页就是症状→手法页，占症状 ≤2 配额并参与一跳展开）、`technique`→technique、其它类型只能进入 `guidance`。命中/选中的症状页 `candidateTechniques` **只展开一跳**，且该引用是**精确边**：条目在 trim+小写后必须**恰好等于**目标的 `pageId` 或其 `topics` 之一；**禁止**分词/子串/主题相似度匹配（否则 `tech-hop` 与 `tech-deep` 会靠共享词 `tech` 连成一条边）。目标自身的 `candidateTechniques` 是出边、不是身份，**不参与**该匹配。展开后重新应用适用性；**展开目标必须自身是 technique 单元**，展开到另一个症状页再往下走就是间接递归，**绝不递归 `related`**。普通 features 的主题相关性排序仍沿用原有分词匹配，不受此精确边约束影响。

确定性：不使用当前时钟；同分排序为 **ID 升序、version 降序**（本地 guidance 先按记录内 `updatedAt` 降序）。按内容与 `unitDigest` 去重。只对**精确给出的 ID+version** 降权（`repeated-attempt`），不封禁整个手法类别；降权在**本地与 Wiki 都生效**（同一优先级组内，被重复的条目排到未重复的之后），不只是改写 `reason`。

`reason` 取值：本地 `local-failure-observation|preferred|feature-match|local-guidance`；Wiki `failure-match|structure-match|symptom-match|technique-match|technique-one-hop|guidance-fallback`，降权统一为 `repeated-attempt`。排除原因：`unreviewed`、`applicability-architecture-undeclared`、`applicability-target-architecture-missing`、`applicability-architecture`、`applicability-hardware`、`applicability-capabilities`、`applicability-software`、`no-topic-match`、`duplicate-unit`。同一条目不会同时出现在 `ordered` 与 `excluded`。

## Dependencies / Side Effects

无依赖、无副作用、纯函数；调用方负责访问控制、状态/过期/版本/作用域预过滤与最终配额、字节预算。排序**不能授予访问权**。

## Error Contract

`EXPERIENCE_SELECTION_INVALID`（status 400）：元数据、features、target、preferredIds、repeatedAttempts 或候选记录不合规范。经 `experience-contract.mjs` 调用时统一映射为 `EXPERIENCE_INVALID`。

## Example / Verification

```js
import { normalizeSelectionMetadata, rankExperienceCandidates } from './experience-selection.mjs';
const metadata = normalizeSelectionMetadata({ source: 'kernel-wiki', /* ... */ });
const { ordered, excluded } = rankExperienceCandidates(records, {
  features: [{ kind: 'symptom', value: 'bank conflicts', basis: 'shape 非 2 的幂，仅假设' }],
  target: { hardware: ['nvidia-gpu'], architecture: ['sm86'], capabilities: [], software: [] },
});
```

由 [experience-contract.md](experience-contract.md) 的 `retrieveExperienceContext`/`retrieveExperienceSelection`（`query.selection`）与 D 的独立测试覆盖；本模块自身只做语法与既有冻结输入检查。

## Change Checklist / Known Limitations

新增/修改键、reason、bucket、配额或排序规则必须同步本契约、`experience-contract.md`、应用层与测试。首版不引入向量库、不调用模型、不做数值评分或瓶颈诊断；不解释 `related` 或上游 `performance_claims`，`performance_claims` 只保留在原始页哈希中，不作为适用性或性能依据。
