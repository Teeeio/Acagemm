# Ink Local C500 TUI Design

## Goal

Replace the current readline-based local C500 tester panel with an Ink component TUI that behaves like a small testing console: create missions, monitor background runners, inspect current results, add notes, run doctor checks, and export reports without leaving the interface.

## Current Problem

The current TUI uses manual `readline`, `cursorTo`, and full-screen redraws. It has no durable UI mode state. A timer redraw can overwrite a form, doctor view, or prompt and return the user to the dashboard. The layout is also a single text dump, which makes it hard to distinguish mission list, detail, environment, round result, and event log.

## Approach

Use Ink with React components for the interactive TUI. Keep the existing CLI commands and local runner/report model. The TUI will consume and mutate the same JSON state files under `.local-c500-tester/`, so backend mission execution remains isolated from the UI implementation.

## Components

- `tui.mjs`: Ink entrypoint and app-level state.
- `state.mjs`: filesystem-backed mission state helpers shared by CLI and TUI.
- `runner.mjs`: background runner creation and mission execution helpers shared by CLI and TUI.
- `components/Layout.mjs`: app shell, status bar, shortcuts.
- `components/MissionList.mjs`: mission list and selection.
- `components/MissionDetail.mjs`: selected mission summary, budget, best candidate, latest round.
- `components/CreateMissionForm.mjs`: multi-field form for mission creation.
- `components/EventLog.mjs`: recent events.
- `components/DoctorPanel.mjs`: environment/tool checks.

## Interaction

Default entry remains:

```bash
npm run tester:c500
```

Normal TUI shortcuts:

- `C`: open create mission form.
- `D`: show doctor panel.
- `N`: add note form.
- `P`: pause selected/latest mission.
- `R`: resume selected/latest mission.
- `S`: stop selected/latest mission.
- `E`: export selected/latest mission.
- `Q`: quit.

The refresh loop updates mission data only. It must not reset the current screen, current form field, selected mission, or typed input.

## Mission Creation

The create form asks for only user-facing fields:

- mission name
- operator name
- operator path
- backend, default `triton`
- time budget, empty means unlimited
- token budget, empty means unlimited

Mock mode is not shown in the normal TUI. It remains available only as a CLI/debug flag.

Submitting the form creates the mission and starts the background runner. The TUI immediately returns to the dashboard and keeps refreshing the selected mission.

## Testing

Automated tests should verify:

- `npm run tester:c500` points to the Ink TUI entrypoint.
- `panel --once` still provides a non-interactive snapshot for scripts.
- `panel --create ... --json` still creates a background mission for deterministic tests.
- Rendering the Ink app in test mode shows component sections and shortcuts.
- Refreshing state does not reset the active mode or form draft.
- Local tester tests and the existing Vite build pass.
