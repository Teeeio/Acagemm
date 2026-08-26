import assert from 'node:assert/strict';
import { createLatestRefreshGate, reconcileTuiSnapshot } from '../tools/local-c500-tester/tui-refresh.mjs';

const current = {
  state: { stateVersion: 7, stage: 'candidate' },
  mission: { id: 'MIS_REFRESH' },
  health: { status: 'ok', time: '2026-08-26T10:00:00.000Z' },
  tasks: [{ taskId: 'candidate-01', status: 'running', progress: 40 }],
};
const healthOnlyRefresh = structuredClone(current);
healthOnlyRefresh.health.time = '2026-08-26T10:00:01.500Z';
assert.equal(reconcileTuiSnapshot(current, healthOnlyRefresh), current, 'health clock must not redraw the dashboard');

const progressed = structuredClone(healthOnlyRefresh);
progressed.tasks[0].progress = 55;
assert.equal(reconcileTuiSnapshot(current, progressed), progressed, 'visible progress must update the dashboard');

const gate = createLatestRefreshGate();
const slowRequest = gate.begin();
const fastRequest = gate.begin();
assert.equal(gate.isLatest(slowRequest), false, 'a late stale response must not replace newer state');
assert.equal(gate.isLatest(fastRequest), true);

console.log('[local-c500-tui-refresh] no-op refresh suppression and response ordering passed');
