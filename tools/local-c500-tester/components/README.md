# TUI Components Module Contract

OperationDetails receives title, diagnostic lines, scroll offset and viewport;
it renders only Ink elements. physicalDetailLines wraps all original characters
by CJK display width after terminal-control removal; detailCapacity reserves the
header, line range and Esc footer. App owns keyboard paging and return mode.
The component performs no I/O, never retries or changes execution state.

Dashboard/CurrentStep distinguish a completed generation with no new candidate
from the previous candidate Gate, and show recorded generation versus measured
candidate counts. A quarantined release blocker takes priority over pause text.
Paused work states that original clocks continue and in-flight work is not
cancelled. H opens full resource nextAction/identity and action-blocking reasons;
these are read-only DTO projections, not a new resource lifecycle or verdict.

模块归属：TUI Presentation。完整的客户端分层和建议主责角色见
[`docs/development/MODULE_OWNERSHIP.md`](../../../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

These Ink components render production Runtime snapshots. They are presentation-only components and must remain safe for empty, partial, loading, failed, and narrow-terminal states.

MissionSourcePicker row keys bind both role (source removal, included, excluded,
system generated or browse) and path. An excluded run.py and the system-generated
run.py are separate rows; selecting an excluded row cannot reuse its generated
counterpart's React identity. Import eligibility and explicit opt-in stay unchanged.

Dashboard prioritizes the frozen acceptanceSummary label in the compact overview:
primary-only / rollback protection disabled, explicit protected policy, or unknown.
Required measurement profiles are never presented as protected profiles. Form
save/start review and primary-shape hints reflect the selected legacy/protected
configuration without changing the draft or enabling a policy.

## Inputs

- `MissionSourcePicker` is a terminal-only browser with a shared `sourcePickerRows` projection for rendering and keyboard handling. `purpose:baseline` selects one .py file with Enter; a new material selection first opens final source review before binding; normal mode stages multiple files or a folder for visible confirmation. `sourcePickerActions` defines focusable browse/folder/review/locations/apply/cancel buttons; `actionIndex=-1` focuses rows. Review supports removing a selected source, and baseline review lists imported eligible files. No native dialog or editable path is rendered. App owns reads and draft updates; cancellation never applies staged changes.

- `MissionHistory` receives the canonical evaluation export, section/scroll state,
  viewport and message. It renders five bounded sections with visible snapshot
  identity and paging keys. Missing cost, timings, performance and memory remain
  unknown. It performs no I/O, does not calculate Gate decisions, and never reads
  the dashboard's truncated recent-history window as complete history.

- Preparation records in `state.missionDrafts` appear as `kind:draft` / 待配置.
  App opens their versioned form through Production API without Mission selection.
  Managed generic forms offer Ctrl+S to save incomplete preparation; Enter retains
  complete-contract validation. Components still perform no I/O.
- New forms expose cosine tolerance and only output-dtype override rows. Layout
  choices are validated against rank; ms goals display their converted us value.

- Read-only snapshot DTOs from `tui-state.mjs`.
- Viewport dimensions from Ink.
- Local form/message/busy state.
- `MissionEntry` renders `home` or `missions` from read-only snapshots plus local `choice`, `selectedId`, `loaded`, `message`, `busy` and `viewport`. `missionEntryRows` projects Mission metadata and shares `deriveTuiViewModel` status semantics with the workspace, preserving terminal Mission status; `focusedMission` resolves focus by ID, then active ID, then first row. Lists page around focus, tolerate empty/loading/failed state, and never select or start a Mission themselves.
- `CreateMissionForm` renders the view from `mission-configuration.mjs`. The generic overview groups task/materials, tensors/semantics, tests/performance and confirmation. Tensors and benchmark shapes occupy one summary row each; Enter opens an item editor with its original field validation, visible Done/Copy/Delete and (for shapes) Set Primary actions. Copies use unique names and preserve values without inheriting primary status. Esc returns to the overview and preserves draft edits; Ctrl+S persists through the existing API. PgUp/PgDn changes overview groups or pages within an editor. Ordinary Enter advances; only the review's Confirm action submits. Validation failures open the relevant item at its invalid field. The read-only review includes semantics, tensors, concrete shapes, correctness/tolerances, measurement, baseline and execution; it shows the fixed primary success target, protected profiles and maximum regression when acceptancePolicy is enabled; legacy tasks still state their primary-only policy. Each editor keeps the footer in 12/16/24-row viewports. Semantic strings remain internal serialization, never raw editors. `mission-form.mjs` still owns the existing rank/layout rules, measurement presets, category/constraint toggles, boundary controls, tolerance scope and frozen DTO. The transient `editor` prop is not persisted. Fixed examples and spec-file mode retain their existing interaction.

- `Dashboard` labels the product independently of hardware and separates the configured test backend from the Mission target. Experience selection is a read-only Runtime projection. Every content region is a titled `Panel`. The 工作流 panel spans the full width at the bottom, just above the key bar, with the accent border (the visual anchor); above it a main column of 当前步骤 / 最近候选 / 活动 / 最近事件 (from `state.auditEvents`, only when present), and, when inner width ≥ 100 columns, a proportional sidebar (≈32%, 36–54 columns) of 任务 / 当前最优 / 证据 / 语义 / 用量. Below 100 columns a 概况 panel replaces the sidebar. Rows whose value is only a placeholder (`--`, `—`, `unknown`, …) or carries no information (idle 0% benchmark, `0/0` coverage, round 0) are omitted; a sidebar panel is shown only if it fits whole. The main column is budgeted by the height left above the workflow panel: all minimums, and round frames only if minimums plus 2 lines per panel fit (otherwise 1-line titled rules); spare lines then grow the current step, candidates, activity and finally the events panel. Leftover height stays blank rather than stretching a frame. Values and banners are shown in Chinese via `displayValue`/`displayBannerText`; the loop status is not shown while paused or needing a human, so it cannot contradict the banner.
- `WorkflowTopology.mjs` holds pure content builders used by the Dashboard (no borders, no timers): `workflowChains` (preparation/iteration chains + focus node), `flowStage` + `FlowLines` (stage bar `① 准备（一次性） ━━ ② 迭代优化（循环）`, current stage highlighted and marked 已暂停 / 需要人工 / 已结束; once iteration starts preparation collapses to a green `✓ 准备完成` and only the iteration steps are listed, ending in `↺ 下一轮`; finished or absent Missions highlight no step), `Chain`, `CurrentStep` (paused / needs-human / no-Mission / waiting / normal card; a progress bar only when progress is meaningful; a warning when the baseline is missing) and `CandidateLines`. The only animated element is `WorkflowActivityIndicator`, whose labels are Chinese (流程运行中 / 已暂停 / 需要操作 / 已完成 / 空闲, plus 第 N 轮 only when a round exists). Queue rows render the structured `purpose/identity/progress/cache/note` fields that `queueEntries` adds next to its unchanged `line` text.
- `chrome.mjs` holds the shared theme (accent `#fab283`, secondary, muted, ok/warn/error) and primitives (`Brand`, `HeaderLine`, `Rule`, `Panel`, `panelContentWidth`, `KeyBar`, `hotkeyChip`) plus CJK-aware `displayWidth`/`padDisplay`/`clipDisplay`. `Panel` draws `╭─ 标题 note ─╮` over a round border without top edge (2 lines of chrome) or, unframed, a `── 标题 ──` rule with an indented body (1 line). All screens use these instead of ad-hoc colors or borders. `renderDashboardSnapshot` in `tui-state.mjs` (text snapshot) is unaffected by this styling and keeps its English banner text.

## Outputs

Tensor shape and per-axis rows expose size-binding hints: repeated symbols require equal extents, shared symbols bind across inputs/outputs, and different letter case denotes different symbols. These are informational, not a ban on square tensors. Invalid numeric/name text remains visible with validation feedback; it is never silently filtered into a different valid value. Dimension symbols are user-defined ASCII identifiers and do not name physical layout axes.

- Ink React element trees only.

## Invariants

- Components do not call HTTP, spawn processes, read files, or mutate Runtime state.
- Workflow labels come from `ui-labels.mjs`.
- Dashboard layout derives from `tui-layout.mjs`; entry/list paging and grouped form paging derive from their read-only viewport dimensions. All must stay within supported viewports.
- Dynamic activity indicators must clean up timers on unmount.

## Verification

```bash
npm run test:local-c500-tui-logic
npm run test:local-c500-tui-spinner
npm run test:local-c500-tui-viewport
npm run test:semantic-tui-extreme
npm run test:generic-tui-form
```
