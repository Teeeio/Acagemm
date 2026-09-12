import assert from 'node:assert/strict';
import { renderWorkflowSummary } from '../tools/local-c500-tester/workflow-summary.mjs';
import { evaluateAcceptGate } from '../client-runtime/accept-gate.mjs';

// The summary is a read-only projection of the versioned evidence decision. The
// fixtures below bind the real production decision value produced by
// evaluateAcceptGate; the test never hand-fills publishable/live booleans.

const MISSION = 'MIS_SUMMARY';
const CANDIDATE = 'candidate-03';
const RUN = 'run-summary-1';
const DIGEST = 'sha256:summary-digest';
const SOURCE_RUN = 'source-run-summary';

const tasks = [100, 92, 84, 75].map((value, index) => ({
  status: 'completed',
  payload: {
    purpose: index === 0 ? 'baseline' : 'candidate',
    candidate: { id: index === 0 ? 'baseline' : `candidate-0${index}`, digest: `sha256:${index}` },
  },
  result: { benchmark: [{ value }] },
}));

const resultFor = (environment) => ({
  benchmark: [{ profile: 'primary', environment: 'MetaX C550', value: 41.8, unit: 'us', correctness: { passed: true, total: 24 } }],
  environment,
  tracer: { format: 'operator-trace/v1', status: 'completed', events: [] },
  profiler: { format: 'operator-profile/v1', status: 'completed', metrics: { kernelDurationUs: 12.5 } },
});

const stateFor = () => ({
  stage: 'published',
  activeMissionId: MISSION,
  appliedCandidateId: CANDIDATE,
  missions: [{ id: MISSION, title: 'FlashInfer MLA Paged Attention', goal: '将 latency p50 控制在 45 us 以下', metric: 'latency p50', hardware: ['MetaX C550'] }],
  baseline: { required: false },
  benchmark: { runId: RUN, candidate: { id: CANDIDATE, digest: DIGEST, sourceRunId: SOURCE_RUN }, matrix: { correctnessCases: 24 } },
  candidateEvaluations: [{ id: CANDIDATE, patchDigest: DIGEST, sourceRunId: SOURCE_RUN }],
  currentBest: { candidateId: CANDIDATE, candidateDigest: DIGEST, evidenceRunId: RUN, value: '41.8 us' },
  runtimeEvents: [],
  researchAgent: {},
  iterationStats: { loopStatus: 'completed' },
});

// --- simulation decision: adoption allowed, publication blocked ---------------
{
  const state = stateFor();
  const gate = evaluateAcceptGate(state, resultFor({ source: 'simulation', service: 'simulation-runner', executionMode: 'full-simulation', liveHardware: false }));
  assert.equal(gate.decision.execution.kind, 'simulation');
  assert.equal(gate.decision.adoption.status, 'allowed');
  assert.equal(gate.decision.publication.status, 'blocked');
  assert.deepEqual(gate.decision.publication.reasons, ['publication.execution_not_live']);
  state.benchmark.evidenceDecision = gate.decision;
  state.currentBest.evidenceDecision = gate.decision;
  state.runtimeEvents.push({ type: 'decision.auto_adopted', payload: { candidate: CANDIDATE, gate: { passed: true, decision: gate.decision } } });

  const report = renderWorkflowSummary({ state, tasks, initialization: { codeFiles: 0, sourceEntries: 0 } });
  // Overall wording is read from the bound decision, not from a boolean.
  assert.match(report, /Result: PASS（采用 allowed \/ 发布 blocked）/);
  assert.doesNotMatch(report, /PASS \(simulation only\)/);
  // The six decision items are all rendered from the same bound decision value.
  assert.match(report, /- decision    operator-studio\.evidence-decision\/v1 · policy operator-studio\.evidence-policy\/2026-09-12/);
  assert.match(report, new RegExp(`- binding     candidate=${CANDIDATE} run=${RUN}`));
  assert.match(report, /- execution   simulation\(仿真执行\) · liveHardware=false · source=simulation/);
  assert.match(report, /- correctness passed=true/);
  assert.match(report, /- benchmark   valid=true/);
  assert.match(report, /- adoption    allowed · reasons=无/);
  assert.match(report, /- publication blocked · reasons=publication\.execution_not_live/);
  // The blocking reason is surfaced in the closing note as well.
  assert.match(report, /本次结果不可发布（publication blocked: publication\.execution_not_live）/);
  // Candidate rows carry the per-task adoption from the same decision family.
  assert.match(report, /\| 完成 \|/);
  console.log('[workflow-summary] simulation decision renders adoption/publication and blocking reasons');
}

// --- shared-GPU development decision: development evidence, not simulation ----
{
  const state = stateFor();
  const gate = evaluateAcceptGate(state, resultFor({ source: 'local-shared-gpu', service: 'local-shared-gpu-adapter', executionMode: 'gpu', liveHardware: true }));
  assert.equal(gate.decision.execution.kind, 'live');
  assert.equal(gate.decision.adoption.status, 'allowed');
  assert.deepEqual(gate.decision.publication.reasons, ['publication.restricted_environment']);
  state.benchmark.evidenceDecision = gate.decision;
  state.currentBest.evidenceDecision = gate.decision;
  state.runtimeEvents.push({ type: 'decision.auto_adopted', payload: { candidate: CANDIDATE, gate: { passed: true, decision: gate.decision } } });

  const report = renderWorkflowSummary({ state, tasks, initialization: { codeFiles: 0, sourceEntries: 0 } });
  assert.match(report, /- execution   live\(真实执行\) · liveHardware=true · source=local-shared-gpu/);
  assert.match(report, /- publication blocked · reasons=publication\.restricted_environment/);
  assert.match(report, /Result: PASS（采用 allowed \/ 发布 blocked）/);
  console.log('[workflow-summary] shared-GPU development decision stays nonpublishable with its reason');
}

// --- legacy record without a versioned decision -------------------------------
{
  const state = stateFor();
  state.benchmark = { runId: RUN, candidate: { id: CANDIDATE, digest: DIGEST }, matrix: { correctnessCases: 24 } };
  state.runtimeEvents.push({ type: 'decision.auto_adopted', payload: { candidate: CANDIDATE, gate: { passed: true, publishable: true } } });
  const report = renderWorkflowSummary({ state, tasks, initialization: { codeFiles: 0, sourceEntries: 0 } });

  // A legacy flat Gate with publishable:true must never be read as a decision.
  assert.match(report, /PASS（历史记录缺少版本化决策，发布状态 unknown，不可发布）/);
  assert.match(report, /- decision    unknown\(历史记录缺少版本化决策；不得据此发布\)/);
  assert.match(report, /- publication unknown\(不可发布：缺少版本化决策\)/);
  assert.match(report, /- reasons     evidence\.decision\.missing/);
  assert.match(report, /历史报告缺少版本化决策，发布状态 unknown，不得视为可发布/);
  assert.doesNotMatch(report, /PASS（采用/);
  console.log('[workflow-summary] legacy record without decision stays explicitly unknown and nonpublishable');
}
