# Source Registry Integrity Service Contract

以 Source Registry 巡检为输入，判定来源根是否仍可作为固定引用。输入 `{ state, mission, sourceRoot }`，
输出 `{ valid, state, verdict, integrity }`。

- 巡检目标是 `sourceRoot`，缺省回退到 `mission.sourceRoot`。调用方**应当**显式传入采集路径实际用的
  那个根（`researchAgent.sourceRoot`）：两者可能不同，问错根等于没检查。
- 目标根缺失 ⇒ `{ valid: true, verdict: 'skipped' }`，不巡检、不发事件。
- `verdict === 'clean'` ⇒ `valid: true`，不改状态。
- 否则把 `state.iterationStats` 升级为 `loopStatus: 'needs_human'` + `loopStatusReason`（`source_root_modified`
  或 `source_root_unverifiable`），发持久事件 `source_registry.integrity_failed`，返回 `valid: false`。

停的是**自动流转**：`detectLoopGuard` 读到 `needs_human` 后返回该理由码，循环不再自行推进；
手动操作不受阻。这与 `baseline-source-inspection-service` 的既有处置一致（后者用 `baseline_source_unverified`）。

## Invariants

- **巡检调用一律传空引用清单** `inspectSources(sourceRoot, [])`。带上 Source Registry 里的历史引用
  会让 `SOURCE_REFERENCE_PATH_INVALID` 稳定出现（注册时写 `path: ''`），
  使每次巡检都升级成 `needs_human`——那不是检测，是把所有 mission 卡死。
- 判定完全交给 `../source-registry-integrity.mjs`，本服务不自己认错误码。
- 只改 `state.iterationStats`，不改 `mission.status`、不改 `missionPaused`：升级理由由循环守护统一读取。
- 事件是持久的（`appendRuntimeEvent`），不是日志。

## Non-Responsibilities

- 不做巡检（`workspace-manager.mjs` 的 `inspectSources`）。
- 不做判定（`source-registry-integrity.mjs`）。
- 不修来源根、不重置 pin、不触发重新采集：修复动作属于人。
- 不覆盖读侧：本服务不声称限制任何读路径。
