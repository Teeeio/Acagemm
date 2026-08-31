import assert from 'node:assert/strict';
import { deriveSemanticAlignment, renderDashboardSnapshot } from '../tools/local-c500-tester/tui-state.mjs';

const mission = {
  id: 'MIS_TUI_SEMANTIC',
  title: 'Paged decode',
  semanticSnapshot: {
    status: 'ready_to_freeze',
    snapshotId: 'SEM_01',
    digest: `sha256:${'a'.repeat(64)}`,
    semanticContract: { operator: 'paged_decode_attention' },
    correctnessContract: { uncovered: ['page-boundary'] },
    testSpec: {
      correctness: { requestedCases: 12, requiredCategories: ['minimal', 'boundary', 'ragged'] },
      benchmark: { requiredProfiles: ['primary', 'long-context'], primaryProfile: 'primary' },
    },
    conflicts: [{ field: 'cache.layout', severity: 'blocking', resolved: false }],
    unknowns: [],
  },
};

const alignment = deriveSemanticAlignment({ mission, state: {} });
assert.equal(alignment.statusLabel, 'ALIGNMENT REQUIRED');
assert.equal(alignment.operator, 'paged_decode_attention');
assert.equal(alignment.correctnessCases, 12);
assert.deepEqual(alignment.correctnessCategories, ['minimal', 'boundary', 'ragged']);
assert.equal(alignment.primaryProfile, 'primary');
assert.deepEqual(alignment.blockers, ['conflict:cache.layout', 'uncovered:page-boundary']);

const frozen = deriveSemanticAlignment({
  mission: { ...mission, semanticSnapshot: { ...mission.semanticSnapshot, status: 'frozen', correctnessContract: { uncovered: [] }, conflicts: [] } },
  state: {},
});
assert.equal(frozen.statusLabel, 'FROZEN');
assert.equal(frozen.blockers.length, 0);

const rendered = renderDashboardSnapshot({ state: {}, mission, health: {}, tasks: [] });
assert.match(rendered, /semantics\s+ALIGNMENT REQUIRED/);
assert.match(rendered, /digest aaaaaaaaaaaa/);
assert.match(rendered, /blockers\s+conflict:cache\.layout/);

console.log('[semantic-tui] alignment status, blockers, and snapshot rendering passed');
