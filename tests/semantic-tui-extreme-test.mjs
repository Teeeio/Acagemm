import assert from 'node:assert/strict';
import { deriveSemanticAlignment, renderDashboardSnapshot } from '../tools/local-c500-tester/tui-state.mjs';
import { deriveTuiViewModel } from '../tools/local-c500-tester/tui-state.mjs';
import { deriveDashboardLayout } from '../tools/local-c500-tester/tui-layout.mjs';

const digest = `sha256:${'b'.repeat(64)}`;
const long = 'x'.repeat(5000);
const mission = {
  id: 'MIS_TUI_EXTREME',
  title: long,
  goal: long,
  semanticSnapshot: {
    status: 'frozen',
    snapshotId: 'SEM_EXTREME',
    digest,
    semanticContract: { operator: 'paged_decode_attention' },
    correctnessContract: { uncovered: [] },
    testSpec: {
      correctness: { requestedCases: 999999, requiredCategories: ['minimal', 'boundary', 'randomized'] },
      benchmark: { requiredProfiles: ['primary', 'long-context'], primaryProfile: 'primary' },
    },
    conflicts: [],
    unknowns: [],
  },
};

for (const [columns, rows, expectedDensity] of [
  [0, 0, 'compact'],
  [-1, -1, 'compact'],
  ['not-a-number', undefined, 'compact'],
  [80, 27, 'tight'],
  [160, 34, 'compact'],
  [240, 48, 'full'],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'full'],
]) {
  const layout = deriveDashboardLayout({ columns, rows });
  assert.equal(layout.density, expectedDensity);
  assert.ok(layout.height >= 1);
  assert.ok(layout.candidateLimit >= 1);
}

const tasks = Array.from({ length: 1000 }, (_, index) => ({
  id: `task-${index}`,
  taskId: `task-${index}`,
  status: index % 11 === 0 ? 'running' : 'completed',
  progress: index % 101,
  submittedAt: new Date(1700000000000 + index).toISOString(),
  payload: { missionId: mission.id, purpose: 'candidate', candidate: { id: `candidate-${index}`, digest: `${'d'.repeat(60)}${index}` } },
}));

const alignment = deriveSemanticAlignment({ mission, state: {} });
assert.equal(alignment.statusLabel, 'FROZEN');
assert.equal(alignment.correctnessCases, 999999);
assert.deepEqual(alignment.correctnessCategories, ['minimal', 'boundary', 'randomized']);
assert.equal(alignment.blockers.length, 0);

for (const viewport of [{ columns: 40, rows: 20 }, { columns: 120, rows: 40 }, { columns: 240, rows: 60 }]) {
  const rendered = renderDashboardSnapshot({
    state: { tokenUsage: { totalTokens: Number.MAX_SAFE_INTEGER, coverage: '1000/1000 runs exact' } },
    mission,
    health: { testBackend: { kind: 'local', device: 'C550' } },
    tasks,
    viewport,
  });
  assert.equal(typeof rendered, 'string');
  assert.match(rendered, /semantics\s+FROZEN/);
  assert.match(rendered, /digest bbbbbbbbbbbb/);
  assert.ok(rendered.length < 30000, `dashboard output grew unexpectedly: ${rendered.length}`);
  assert.ok(!rendered.includes('undefined'));
}

const missing = deriveSemanticAlignment({ state: {}, mission: null });
assert.equal(missing.statusLabel, 'NO SNAPSHOT');
assert.equal(missing.operator, '--');
assert.deepEqual(missing.blockers, []);

const interruptedView = deriveTuiViewModel({
  mission: { ...mission, status: 'needs_human' },
  state: {
    iterationStats: { loopStatus: 'needs_human', loopStatusReason: 'workflow_error' },
    workflowFailure: { code: 'OPERATOR_PATH_REQUIRED', message: 'operator path is required' },
  },
});
assert.equal(interruptedView.statusLabel, 'needs_human');
assert.match(interruptedView.banner, /workflow_error.*OPERATOR_PATH_REQUIRED/);
assert.equal(interruptedView.failure.code, 'OPERATOR_PATH_REQUIRED');

console.log('[semantic-tui-extreme] viewport, long-field, queue, numeric-boundary, and missing-state cases passed');
