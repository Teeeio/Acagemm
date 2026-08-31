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
  id: 'MIS_EXTREME_SEMANTIC',
  title: 'Paged decode attention',
  goal: 'batch=1 decode with ragged KV cache',
  repository: 'operator-repo',
  hardware: ['C500'],
  metric: 'latency p50',
  operatorProfile: { id: 'paged-decode', immutableRules: ['preserve output shape'] },
  testMatrix: {
    environments: ['C500'],
    testSpec: {
      schemaVersion: 'operator-studio.test-spec/v1',
      correctness: { requestedCases: 24, requiredCategories: ['minimal', 'boundary', 'ragged'] },
      benchmark: { requiredProfiles: ['primary', 'boundary'], primaryProfile: 'primary' },
    },
  },
};

const pseudoRandom = (seed) => {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};

const randomValue = (next, depth = 0) => {
  if (depth >= 3) return [null, false, 0, -0, 1e-12, 1e12, '中文 operator', ''][Math.floor(next() * 8)];
  const kind = Math.floor(next() * 5);
  if (kind === 0) return randomValue(next, 3);
  if (kind === 1) return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth + 1));
  if (kind === 2) return Object.fromEntries(Array.from({ length: Math.floor(next() * 5) }, (_, index) => [`k${index}_${Math.floor(next() * 100)}`, randomValue(next, depth + 1)]));
  if (kind === 3) return next() > 0.5;
  return `value-${Math.floor(next() * 1e6)}`;
};

// Property: object key insertion order must not affect canonical semantic JSON.
for (let seed = 1; seed <= 10_000; seed += 1) {
  const next = pseudoRandom(seed);
  const value = randomValue(next);
  const reversed = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse())
    : value;
  assert.equal(canonicalSemanticJson(value), canonicalSemanticJson(reversed));
}

const base = createSemanticSnapshot({ mission, semanticDraft: {
  operator: 'paged_decode_attention',
  execution: { mode: 'decode', queryLength: 1 },
  inputs: [{ name: 'query', shape: ['B', 'H', 'D'], dtype: 'bf16' }],
  outputs: [{ name: 'output', shape: ['B', 'H', 'D'], dtype: 'bf16' }],
} });

// Runtime metadata is intentionally excluded from the semantic digest.
assert.equal(semanticSnapshotDigest({ ...base, status: 'frozen', createdAt: 'later', updatedAt: 'now' }), base.digest);
assert.notEqual(semanticSnapshotDigest({ ...base, semanticContract: { ...base.semanticContract, execution: { mode: 'prefill' } } }), base.digest);
assert.notEqual(semanticSnapshotDigest({ ...base, semanticContract: { ...base.semanticContract, inputs: [...base.semanticContract.inputs, { name: 'mask' }] } }), base.digest);

// Every field-level disagreement becomes an explicit blocking conflict.
const sourceA = mergeSemanticField({ snapshot: base, field: 'cache.layout', value: '[B,S,H,D]', source: 'upstream@commit-a' });
const sourceB = mergeSemanticField({ snapshot: sourceA, field: 'cache.layout', value: '[B,H,S,D]', source: 'profile:paged-decode' });
assert.equal(sourceB.conflicts.length, 1);
assert.equal(sourceB.fieldProvenance['cache.layout'].source, 'upstream@commit-a');
assert.equal(semanticSnapshotIssues(sourceB).some((item) => item.code === 'SEMANTIC_CONFLICTS_UNRESOLVED'), true);
assert.throws(() => assertSemanticSnapshot(sourceB, { requireReady: true }), (error) => error.code === 'SEMANTIC_CONFLICTS_UNRESOLVED');

const resolved = resolveSemanticConflict({ snapshot: sourceB, conflictIndex: 0, value: '[B,H,S,D]', source: 'user', decision: 'adopt-profile' });
assert.equal(resolved.semanticContract.cache.layout, '[B,H,S,D]');
assert.equal(resolved.fieldProvenance['cache.layout'].userConfirmed, true);
assert.equal(resolved.conflicts[0].status, 'resolved');

// Exhaustively vary blocker states. Only resolved/accepted non-blocking states may freeze.
for (const conflict of [
  { field: 'x', severity: 'blocking', resolved: false },
  { field: 'x', severity: 'warning', resolved: false },
  { field: 'x', severity: 'blocking', resolved: true },
]) {
  for (const unknown of [
    { field: 'y', blocking: true },
    { field: 'y', accepted: true, blocking: true },
    { field: 'y', blocking: false },
  ]) {
    const candidate = createSemanticSnapshot({ mission, semanticDraft: { operator: 'paged_decode_attention' } });
    candidate.conflicts = [conflict];
    candidate.unknowns = [unknown];
    candidate.digest = semanticSnapshotDigest(candidate);
    const blocked = semanticSnapshotIssues(candidate).length > 0;
    const shouldBlock = (conflict.severity === 'blocking' && !conflict.resolved) || (unknown.blocking !== false && !unknown.accepted);
    assert.equal(blocked, shouldBlock);
    if (shouldBlock) assert.throws(() => freezeSemanticSnapshot(candidate), (error) => error.code === 'SEMANTIC_FREEZE_BLOCKED');
    else assert.equal(freezeSemanticSnapshot(candidate).status, 'frozen');
  }
}

const frozen = freezeSemanticSnapshot(resolved, { now: '2026-08-30T00:00:00.000Z' });
const binding = createSemanticTaskBinding(frozen, { testSpec: frozen.testSpec, oracleDigest: 'sha256:oracle', baselineDigest: 'sha256:baseline' });
assertSemanticTaskBinding(binding, frozen, { testSpecDigest: binding.testSpecDigest, oracleDigest: binding.oracleDigest, baselineDigest: binding.baselineDigest });
for (const field of ['semanticSnapshotId', 'semanticDigest', 'testSpecDigest', 'oracleDigest', 'baselineDigest']) {
  assert.throws(() => assertSemanticTaskBinding({ ...binding, [field]: `${binding[field]}-tampered` }, frozen, { testSpecDigest: binding.testSpecDigest, oracleDigest: binding.oracleDigest, baselineDigest: binding.baselineDigest }), (error) => error.code === 'SEMANTIC_SNAPSHOT_MISMATCH');
}
assert.throws(() => assertSemanticSnapshot({ ...frozen, digest: 'sha256:tampered' }, { requireFrozen: true }), (error) => error.code === 'SEMANTIC_DIGEST_INVALID');

console.log('[semantic-snapshot-extreme] 10,000 canonicalization cases, blocker combinations, provenance conflicts, and digest tampering passed');
