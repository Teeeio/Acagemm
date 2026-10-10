# Research Policy Module Contract

模块归属：`client-runtime/` 根级纯策略叶子模块。不 import 任何运行时实现，供
`iteration-loop.mjs`、`agent-runtime.mjs` 与 `application/*` 服务共用。

## Purpose

研究工作只有一个裁决点：一个自动入口要不要研究、研究哪个阶段、预算多少、什么时候必须停下。
在此之前，固定 Profile、通用停滞升级、严格来源路径、候选 baseline 与 materializer 恢复分支各自
决定这些事，于是早期的研究开关只覆盖了其中一条，而通用停滞升级会回落到默认的
`acquire` 阶段去重新寻找/克隆 baseline 仓库。

## Public API

| 导出 | 输入 | 输出 |
|---|---|---|
| `resolveResearchConfig(mission)` | Mission（读 `sourcePolicy` / `researchPolicy`） | `{ automaticEnabled, manualEnabled, advisoryBudgetMs, acquisitionBudgetMs, sessionBudgetMs, synthesizeBudgetMs, requiresVerifiableSource, allowSemanticFallback }` |
| `resolveAutomaticResearch({ mission, trigger })` | Mission + 触发来源 | `{ allowed, phase, budgetMs, sessionBudgetMs, reasonCode, reason, config }` |
| `resolveManualResearch({ mission, phase })` | Mission + 显式阶段 | 同上（只看 `manualEnabled`，不看 `webResearchEnabled`） |
| `phaseForTrigger(trigger)` | 触发来源 | `'advisory' \| 'experience' \| 'acquire'` |
| `classifyResearchFaults({ failureRecords })` | 已有失败记录 | `{ faultClass, runtimeFaultOnly, evidence }` |
| `describeResearchRequest({ mission, trigger, direction, fault })` | 触发上下文 | 研究前的自证清单（问题 / 为何证据不足 / 支持哪项决策 / 最小产物 / 停止条件） |
| `sessionDeadlineFor` / `remainingSessionBudgetMs` | session 起止 | session 剩余预算 |

导出常量：`RESEARCH_PHASES`（`advisory` / `experience` / `acquire` / `synthesize`）、
`RESEARCH_TRIGGERS`、`RESEARCH_FAULT_CLASSES`、`RESEARCH_ADVISORY_BUDGET_MS`(90 s)、
`RESEARCH_ACQUISITION_BUDGET_MS`(10 min)、`RESEARCH_SESSION_BUDGET_MS`(12 min)、
`RESEARCH_SYNTHESIZE_BUDGET_MS`(5 min，无 session deadline 时的综合兜底)、
`RESEARCH_BUDGET_BOUNDS`(30 s – 30 min)。

## Invariants

- `automaticEnabled` **默认 false**：只有 `mission.sourcePolicy.webResearchEnabled === true` 才为真。
  缺省、`null`、无 `sourcePolicy` 一律按关闭处理。
- 读侧**只认** `sourcePolicy.webResearchEnabled`：不读旧名 `researchEnabled`，也不从
  `researchPolicy.enabled` 回退。硬改名，不留兼容通道——留任一条都会让「默认关闭」在新旧配置
  混用时失效。
- `automaticEnabled === false` 覆盖**全部自动入口**，不区分触发来源：不允许任何分支隐式开启采集或综合。
- 关闭联网研究**不放宽**任何来源门禁，也不启用 semantic fallback；缺必要来源时返回显式状态。
- 本地经验与已审查 Wiki 的检索不属于"联网研究"，`webResearchEnabled` 不作用于它。
- 显式手动研究只受 `manualEnabled` 约束，并遵守同一 session 总预算。
- 手动 `synthesize` 返回 `budgetMs: null`，由 Runtime 采用现有 session 的剩余预算且不重置 deadline；无 session 时采用 `synthesizeBudgetMs`（默认 5 min）。其它手动阶段继续返回各自的数值预算。
- 阶段由调用方显式选择，不存在默认阶段；缺失或未知阶段一律拒绝。
- 预算只做区间钳制，不是写死的通用上限：默认 60–120 s 量级的建议型预算是初始试验值。
- 故障分类只复用确定性信号（既有错误码与固定词表），不额外增加一次独立模型调用。
- **显式候选/正确性错误码优先于运行文本匹配**：`OPERATOR_CANDIDATE_EXCEPTION` 与
  `OPERATOR_CORRECTNESS_MISMATCH` 这两个显式码构成最高优先级的实现失败分支，先于运行故障码与
  运行故障词表判定。即使 `failure.message` 或 `decisionReason` 里顺带出现 `timeout`、`401`、
  `authentication` 等运行词，也不会被误判成 `runtime_fault`。
- 优先级分支只覆盖上述两个显式码：已知运行故障码（如 `RESEARCH_BUDGET_EXHAUSTED`）仍为
  `runtime_fault`，未知码或无码记录的运行文本回退行为不变；混合记录不得为 `runtimeFaultOnly=true`，
  空记录仍为 `knowledge_gap`，且仍只分类前五条记录。

## Non-Responsibilities

- 研究进程的启动、取消与状态投影（属于 `agent-runtime.mjs`）。
- 迭代决策本身（属于 `iteration-loop.mjs`）。
- 来源获取的效果实现（属于 `source-acquisition-service.mjs` + `agent-runtime.mjs`）。

## Verification

`npm run test:research-policy`、`npm run test:loop`、`npm run test:research-delivery`。
