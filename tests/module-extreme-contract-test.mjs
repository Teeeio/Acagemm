import assert from 'node:assert/strict';
import {
  emptyTokenUsage,
  normalizeTokenUsageLedger,
  recordRunTokenUsage,
} from '../client-runtime/token-usage.mjs';
import { normalizeProviderUsage } from '../client-runtime/agent-runtime/usage.mjs';
import {
  parseSourceMirrorPolicy,
  resolveSourceTransport,
  verifySourceTransportSnapshot,
} from '../client-runtime/source-mirror-policy.mjs';
import { createMissionTestSpec, normalizeMissionTestMatrix } from '../client-runtime/test-spec.mjs';
import {
  WORKFLOW_OUTCOME,
  collectWorkflowInvariantViolations,
  normalizeExternalOutcome,
  workflowEffectId,
} from '../client-runtime/workflow-kernel.mjs';

const huge = Number.MAX_SAFE_INTEGER;
const empty = emptyTokenUsage();
assert.equal(empty.totalTokens, 0);
assert.equal(normalizeTokenUsageLedger(null).completeness, 'unavailable');
const ledger = normalizeTokenUsageLedger({ runs: {
  exact: { completeness: 'exact', provider: 'codex-cli', inputTokens: huge, outputTokens: 2, totalTokens: huge + 2 },
  malformed: { provider: 'codex-cli', inputTokens: -10, outputTokens: 'NaN', totalTokens: 99 },
} });
assert.equal(ledger.runs.exact.inputTokens, huge);
assert.equal(ledger.runs.malformed.completeness, 'unavailable');
assert.equal(ledger.completeness, 'partial');
const state = { tokenUsage: ledger };
recordRunTokenUsage(state, { runId: 'malformed', provider: 'codex-cli', phase: 'test', events: [] });
assert.equal(state.tokenUsage.runs.malformed.completeness, 'unavailable');
const providerUsage = normalizeProviderUsage('codex-cli', {
  input_tokens: huge,
  output_tokens: huge,
  input_tokens_details: { cached_tokens: huge },
  total_tokens: 1,
});
assert.equal(providerUsage.uncachedInputTokens, 0);
assert.equal(providerUsage.completeness, 'inconsistent');

const commit = 'a'.repeat(40);
const tree = 'b'.repeat(64);
const canonical = 'https://github.com/org/repository.git';
const policy = parseSourceMirrorPolicy({
  schemaVersion: 1,
  requireMirror: true,
  mirrors: [{ canonical, transport: 'https://gitlab.com/mirror/repository.git', requiredCommit: commit, requiredTree: tree }],
});
const resolution = resolveSourceTransport(canonical, policy);
assert.equal(resolution.mode, 'mirror');
assert.throws(() => verifySourceTransportSnapshot({ resolution, commit, tree: 'c'.repeat(64) }), (error) => error.code === 'SOURCE_MIRROR_TREE_MISMATCH');
for (const malformed of [null, [], { schemaVersion: 1 }, { schemaVersion: 1, mirrors: [{ canonical, transport: 'http://unsafe.example/repo', requiredCommit: commit }] }]) {
  assert.throws(() => parseSourceMirrorPolicy(malformed));
}

for (const input of [{ correctnessCases: 0, warmup: -1, repeats: 'NaN' }, { correctnessCases: huge, warmup: huge, repeats: huge }]) {
  const spec = createMissionTestSpec(input);
  assert.ok(spec.correctness.requestedCases > 0);
  assert.ok(spec.benchmark.warmup > 0);
  assert.ok(spec.benchmark.repeats > 0);
  assert.equal(spec.generation.deterministic, true);
}
const normalized = normalizeMissionTestMatrix({ environments: [], stages: [], testSpec: { schemaVersion: 'operator-studio.test-spec/v1', correctness: { requestedCases: 3 }, benchmark: {} } });
assert.deepEqual(normalized.environments, ['C550']);
assert.equal(normalized.correctnessCases, 3);

for (const input of [
  { status: 'completed' },
  { status: 'running' },
  { status: 'failed', statusCode: 503 },
  { status: 'failed', code: 'VALIDATION_FAILED' },
  { status: 'cancelled' },
  {},
]) {
  const outcome = normalizeExternalOutcome(input);
  assert.ok(Object.values(WORKFLOW_OUTCOME).includes(outcome.kind));
  assert.equal(typeof outcome.terminal, 'boolean');
}
assert.equal(normalizeExternalOutcome({ status: 'failed', statusCode: 503 }).retryable, true);
assert.equal(normalizeExternalOutcome({ status: 'failed', code: 'VALIDATION_FAILED' }).kind, WORKFLOW_OUTCOME.TERMINAL_FAILURE);
assert.equal(workflowEffectId({ missionId: 'M', type: 'T', round: 1 }), workflowEffectId({ missionId: 'M', type: 'T', round: 1 }));
assert.notEqual(workflowEffectId({ missionId: 'M', type: 'T', round: 1 }), workflowEffectId({ missionId: 'M', type: 'T', round: 2 }));
const violations = collectWorkflowInvariantViolations({
  benchmark: { status: 'running', purpose: 'candidate', candidate: { id: 'candidate-2' } },
  baseline: { status: 'pending' },
  patchApplied: true,
  currentBest: { verified: true, evidenceSource: 'simulation' },
});
assert.deepEqual(violations.map((item) => item.code), [
  'WORKFLOW_BENCHMARK_ORPHANED',
  'WORKFLOW_BASELINE_REQUIRED',
  'WORKFLOW_APPLIED_CANDIDATE_MISSING',
  'WORKFLOW_SIMULATION_PUBLISH_FORBIDDEN',
]);

console.log('[module-extreme-contract] token, source, test-spec, and workflow boundary cases passed');
