import assert from 'node:assert/strict';
import { renderDashboardSnapshot } from '../tools/local-c500-tester/tui-state.mjs';

const baselineTask = {
  taskId: 'baseline-panel',
  status: 'completed',
  payload: { purpose: 'baseline', candidate: { id: 'baseline' } },
  result: { benchmark: [{ value: 1000, unit: 'us' }], environment: { source: 'simulation', liveHardware: false } },
};
const candidateTask = {
  taskId: 'candidate-panel',
  status: 'completed',
  payload: { purpose: 'candidate', candidate: { id: 'candidate-01', digest: 'sha256:panel' } },
  result: { benchmark: [{ value: 250, unit: 'us' }], environment: { source: 'simulation', liveHardware: false } },
};
const mission = {
  id: 'MIS_PANEL',
  title: 'Flash MLA Decode v0.1',
  status: 'published',
  hardware: ['C550'],
  metric: 'latency p50',
};
const state = {
  stage: 'published',
  baseline: {
    status: 'complete',
    kind: 'pytorch_reference',
    evidence: { value: 1000, unit: 'us' },
    source: { repository: 'operator-profile:flash-mla-decode-triton-v01', commit: 'profile-v1', path: 'generated/reference.py' },
  },
  benchmark: { status: 'completed', progress: 100, result: candidateTask.result },
  currentBest: { candidateId: 'candidate-01', value: '250 us', improvement: '75%' },
  iterationStats: { loopStatus: 'completed', round: 1 },
};

const output = renderDashboardSnapshot({
  state,
  mission,
  tasks: [baselineTask, candidateTask],
  health: { testBackend: { kind: 'local-c500', mock: true } },
});
assert.match(output, /BASELINE TEST.*1000 us/);
assert.match(output, /candidate-01.*250 us.*\+75%/);
assert.match(output, /candidate\s+candidate-01/);
assert.match(output, /improvement 75%/);
assert.match(output, /live C500\s+simulation/);

console.log('[mission-panel] current TUI baseline, improvement, and simulation evidence projection passed');
