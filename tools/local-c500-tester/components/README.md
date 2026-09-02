# TUI Components Module Contract

## Purpose

These Ink components render production Runtime snapshots. They are presentation-only components and must remain safe for empty, partial, loading, failed, and narrow-terminal states.

## Inputs

- Read-only snapshot DTOs from `tui-state.mjs`.
- Viewport dimensions from Ink.
- Local form/message/busy state.

## Outputs

- Ink React element trees only.

## Invariants

- Components do not call HTTP, spawn processes, read files, or mutate Runtime state.
- Workflow labels come from `ui-labels.mjs`.
- Layout derives from `tui-layout.mjs` and must not overflow supported viewports.
- Dynamic activity indicators must clean up timers on unmount.

## Verification

```bash
npm run test:local-c500-tui-logic
npm run test:local-c500-tui-spinner
npm run test:local-c500-tui-viewport
npm run test:semantic-tui-extreme
```
