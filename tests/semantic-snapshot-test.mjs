import assert from 'node:assert/strict';
import {
  assertSemanticSnapshot,
  assertSemanticTaskBinding,
  canonicalSemanticJson,
  createSemanticSnapshot,
  createSemanticTaskBinding,
  freezeSemanticSnapshot,
  mergeSemanticField,
  resolveSemanticConflict,
  semanticSnapshotDigest,
  semanticSnapshotIssues,
} from '../client-runtime/semantic-snapshot.mjs';

const mission = {
  id: 'MIS_SEMANTIC_01',
  title: 'Paged decode attention',
  goal: '优化 paged decode attention',
  repository: 'mla-kernels',
  hardware: ['C500'],
  metric: 'latency p50',
  operatorProfile: {
    id: 'paged-decode',
    immutableRules: ['preserve output shape', 'preserve cache semantics'],
  },
  testMatrix: {
    environments: ['C500'],
    testSpec: {
      schemaVersion: 'operator-studio.test-spec/v1',
      correctness: { requestedCases: 4, requiredCategories: ['minimal', 'boundary'] },
      benchmark: { requiredProfiles: ['primary'], primaryProfile: 'primary' },
    },
  },
};

const draft = createSemanticSnapshot({
  mission,
  semanticDraft: {
    operator: 'paged_decode_attention',
    execution: { mode: 'decode' },
    inputs: [{ name: 'query', shape: ['B', 'H', 'D'], dtype: 'bf16' }],
    outputs: [{ name: 'output', shape: ['B', 'H', 'D'], dtype: 'bf16' }],
    invariants: ['seq_lens[b] bounds visible cache'],
  },
});

assert.equal(draft.schemaVersion, 'operator-studio.semantic-snapshot/v1');
assert.equal(draft.status, 'draft');
assert.match(draft.digest, /^sha256:[a-f0-9]{64}$/);
assert.equal(semanticSnapshotIssues(draft).length, 0);

const reordered = createSemanticSnapshot({
  mission: { ...mission, hardware: ['C500'] },
  semanticDraft: { execution: { mode: 'decode' }, operator: 'paged_decode_attention' },
});
const reorderedValue = { ...draft, semanticContract: { ...draft.semanticContract, inputs: draft.semanticContract.inputs } };
assert.equal(semanticSnapshotDigest(reordered), semanticSnapshotDigest(reordered), 'digest is stable for the same semantic value');
assert.equal(canonicalSemanticJson({ b: 1, a: 2 }), canonicalSemanticJson({ a: 2, b: 1 }));
assert.notEqual(draft.digest, reordered.digest, 'different semantic payloads must not collide');
void reorderedValue;

const withConflict = mergeSemanticField({ snapshot: draft, field: 'execution.layout', value: 'B,S,H,D', source: 'upstream' });
const conflictAgain = mergeSemanticField({ snapshot: withConflict, field: 'execution.layout', value: 'B,H,S,D', source: 'profile' });
assert.equal(conflictAgain.conflicts.length, 1);
assert.equal(conflictAgain.conflicts[0].field, 'execution.layout');
assert.equal(semanticSnapshotIssues(conflictAgain).some((item) => item.code === 'SEMANTIC_CONFLICTS_UNRESOLVED'), true);
assert.throws(() => freezeSemanticSnapshot(conflictAgain), (error) => error.code === 'SEMANTIC_FREEZE_BLOCKED');

const resolved = resolveSemanticConflict({ snapshot: conflictAgain, conflictIndex: 0, value: 'B,H,S,D', source: 'user', decision: 'adopt-profile' });
assert.equal(resolved.conflicts[0].resolved, true);
const frozen = freezeSemanticSnapshot(resolved, { now: '2026-08-30T00:00:00.000Z' });
assert.equal(frozen.status, 'frozen');
assert.match(frozen.digest, /^sha256:[a-f0-9]{64}$/);
assert.equal(Object.isFrozen(frozen), true);
assert.equal(Object.isFrozen(frozen.semanticContract), true);
assert.throws(() => { frozen.semanticContract.operator = 'mutated'; }, TypeError);
assert.equal(assertSemanticSnapshot(frozen, { requireFrozen: true }).digest, frozen.digest);

const binding = createSemanticTaskBinding(frozen, {
  testSpec: frozen.testSpec,
  oracleDigest: 'sha256:oracle',
  baselineDigest: 'sha256:baseline',
  taskId: 'task-1',
});
assert.equal(binding.semanticSnapshotId, frozen.snapshotId);
assertSemanticTaskBinding(binding, frozen, {
  testSpecDigest: binding.testSpecDigest,
  oracleDigest: 'sha256:oracle',
  baselineDigest: 'sha256:baseline',
});
assert.throws(() => assertSemanticTaskBinding({ ...binding, semanticDigest: 'sha256:wrong' }, frozen), (error) => error.code === 'SEMANTIC_SNAPSHOT_MISMATCH');
assert.throws(() => assertSemanticSnapshot({ ...frozen, digest: 'sha256:wrong' }, { requireFrozen: true }), (error) => error.code === 'SEMANTIC_DIGEST_INVALID');

const uncovered = createSemanticSnapshot({ mission, semanticDraft: { operator: 'paged_decode_attention' } });
uncovered.correctnessContract.uncovered = ['page-boundary'];
assert.equal(semanticSnapshotIssues(uncovered).some((item) => item.code === 'SEMANTIC_CORRECTNESS_UNCOVERED'), true);

console.log('[semantic-snapshot] canonicalization, conflict gates, freeze, and task binding passed');
