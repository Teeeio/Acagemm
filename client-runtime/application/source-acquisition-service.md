# Source Acquisition Service 模块契约

模块归属：`client-runtime/application/`。领域规则与效果实现均由组合根注入。

## Purpose

把「研究员选定来源后的受控获取（clone / fetch / 快照校验）」从状态投影路径中移出，
放到迭代推进路径执行。状态查询与正常迭代决策因此不再被可能重试数分钟的获取流程拖住（§7.3）。

## Public API

| 方法 | 输入 | 输出 |
|---|---|---|
| `acquireSources` | `{ mission, runId, researchDir, sourceRoot, allowDiscoveredSources, allowSemanticFallback }` | `{ sources, failures, reasonCode, elapsedMs, newDirectoryCount }` |

工厂依赖（全部注入，模块自身不 import 具体效果实现）：

- `agentRuntime.readRunEvents(runId)`：只读事件端口，用于定位研究员在 acquire 阶段的正式结果。
- `acquireSelectedSources`：受控获取与来源验证实现（`agent-runtime.mjs` 导出）。
- `sourceMirrorPolicy()`：来源镜像策略加载器。
- `readdir`（可选）：用于区分「本次运行新建的目录」与 Source Registry 历史目录。

## Invariants

- 本模块不修改任何持久化状态；记账由调用方（迭代循环）完成。
- 提取与验证分离：结果定位失败返回 `reasonCode`，来源策略拒绝仍由 `acquireSelectedSources` 抛出。
- 来源数量统计只覆盖本次运行实际获取并验证的来源，绝不把 Source Registry 的历史目录数当作本次成果。
- 失败以 `{ code, detail }` 形式返回，不抛出到调用方，保证迭代推进可以按显式状态收敛。

## Non-Responsibilities

- 研究阶段选择与预算裁决（属于 `research-policy.mjs`）。
- 状态投影、Mission 持久化、HTTP 路由。
- 候选生成、Accept Gate、证据发布。

## Side Effects

clone / fetch 写入 `mission.sourceRoot`（Source Registry），并写入研究目录下的
`acquisition-result.json` 清单。失败的临时目录会被清理。

## Composition-root requirement

`acquireSources` is the port the iteration loop calls to settle an `acquire` run's harvest. Any
composition root that runs two-phase research must inject it; `tests/loop-test.mjs` and
`scripts/verify-researcher-source.mjs` (production parity) show the wiring, which reads the run events
through `agentRuntime.readRunEvents` and delegates to the injected `acquireSelectedSources`. A root that
omits the port is reported through `research.acquisition_port_missing` rather than being indistinguishable
from "no sources were found".
