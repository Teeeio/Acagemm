import assert from 'node:assert/strict';
import { projectMissionState, decideNextLocalAction } from '../tools/local-c500-tester/workflow-entry.mjs';

const baseMission = {
  mission_id: 'local_test',
  status: 'running',
  stage: 'candidate',
  client_stage: 'validation',
  agent: { operator_id: 'vector_add', phase: 'candidate_round_1' },
  baseline: { status: 'complete', latency_p50_us: 100, source: 'explicit_smoke_fixture_reference' },
  candidateEvaluations: [{ candidate_id: 'candidate-001', status: 'running', candidate_digest: 'sha256:candidate-001' }],
  budget: { tokens_used: 12000, token_limit: 20000 },
  current_best: null,
  iterationStats: { round: 1, loopStatus: 'running' },
};

const projected = projectMissionState({ mission: baseMission, summary: { correctness: 'pass', latency_p50_us: 95 } });
assert.equal(projected.status, 'running');
assert.equal(projected.stage, 'validation');
assert.equal(projected.operator.id, 'vector_add');
assert.equal(projected.baseline.source, 'explicit_smoke_fixture_reference');
assert.equal(projected.currentCandidate.digest, 'sha256:candidate-001');
assert.equal(projected.budget.used, 12000);
assert.equal(projected.evidence.correctness, 'pass');

// Candidate benchmark preparation must preserve the fixed profile's matrix
// when the caller omits optional warmup/repeat/case overrides. Otherwise the
// baseline shape key changes from the published profile and every refresh
// loops on BASELINE_REQUIRED_BEFORE_CANDIDATE.
const serverSource = await (await import('node:fs/promises')).readFile(new URL('../client-runtime/local-server.mjs', import.meta.url), 'utf8');
assert.match(serverSource, /body\.correctnessCases \?\? matrix\.correctnessCases \?\? matrix\.testSpec\?\.correctness\?\.requestedCases/);
assert.equal(decideNextLocalAction(projected), 'poll_test');

const needsHuman = projectMissionState({
  mission: { ...baseMission, status: 'needs_human', stage: 'discovery', client_stage: 'diagnosis', agent: { reason: 'operator_identity_unresolved' }, candidateEvaluations: [] },
  summary: {},
});
assert.equal(needsHuman.needsHuman, true);
assert.equal(needsHuman.needsHumanReason, 'operator_identity_unresolved');
assert.equal(decideNextLocalAction(needsHuman), 'wait_human');

const baselinePending = projectMissionState({
  mission: { ...baseMission, stage: 'baseline', baseline: { status: 'running' }, candidateEvaluations: [] },
  summary: {},
});
assert.equal(decideNextLocalAction(baselinePending), 'poll_baseline');

process.stdout.write('[local-c500-workflow-parity] projection and action policy passed\n');
