import assert from 'node:assert/strict';
import { resolveBaselineRunPlan } from '../client-runtime/baseline-resolver.mjs';
import { evaluateAcceptGate } from '../client-runtime/accept-gate.mjs';

const mission = {
  id: 'MIS_STRICT_ZERO',
  title: 'FlashInfer MLA Paged Attention',
  goal: '从零优化 FlashInfer MLA paged attention，相对 baseline 至少提升 20%',
  metric: 'latency p50',
  hardware: ['C500'],
  sourcePolicy: { mode: 'agent-research-only', strictZeroSource: true },
  objective: { mode: 'threshold', targetRelativeImprovement: 0.2 },
};
const matrix = { environments: ['C500'], stages: ['Correctness'], correctnessCases: 1 };

await assert.rejects(
  resolveBaselineRunPlan({ mission, matrix, body: {} }),
  (error) => error.code === 'BASELINE_SOURCE_REQUIRED',
);

const source = { authority: 'upstream', repository: 'https://github.com/flashinfer-ai/flashinfer', commit: 'agent-found-commit', path: 'include/flashinfer/attention/decode.cuh', operator: 'MLA paged attention', expandedSingleFile: false };
await assert.rejects(
  resolveBaselineRunPlan({ mission, matrix, body: { baselineSource: source } }),
  (error) => error.code === 'STRICT_ZERO_SOURCE_AGENT_MATERIALIZER_REQUIRED',
);

const flexibleMission = {
  ...mission,
  id: 'MIS_FLEXIBLE_SOURCE',
  sourcePolicy: { mode: 'agent-flexible', strictZeroSource: true, localFirst: true, allowDiscoveredSources: true, allowSemanticFallback: true },
};
const semanticSource = {
  authority: 'agent-semantic',
  kind: 'pytorch_reference',
  repository: 'mission-semantic-baseline',
  commit: 'agent-semantic-v1',
  path: 'generated/semantic-reference/run.py',
  operator: 'MLA paged attention',
  expandedSingleFile: false,
  semanticFallback: true,
  semanticSpec: { inputSemantics: ['paged KV cache'], correctnessInvariants: ['causal masking'] },
};
const semanticRunPy = [
  'def get_inputs():',
  '    import torch',
  '    return {"x": torch.ones((1,), device="cuda")}',
  '',
  'def run(inputs):',
  '    return inputs["x"]',
  '',
  'def reference(inputs):',
  '    return inputs["x"]',
  '',
].join('\n');
const semanticPlan = await resolveBaselineRunPlan({
  mission: flexibleMission,
  matrix,
  body: { baselineSource: semanticSource, materializerResult: { runPy: semanticRunPy, report: { summary: 'derived from Mission semantics' } } },
});
assert.equal(semanticPlan.runPySource, 'agent_assisted');
assert.equal(semanticPlan.baselineSource.semanticFallback, true);
assert.equal(semanticPlan.baselineSource.expandedSingleFile, true);

const state = { activeMissionId: mission.id, missions: [mission], testMatrix: matrix, currentBest: { candidateId: null, value: '--' } };
state.baseline = {
  required: true,
  kind: 'pytorch_reference',
  status: 'complete',
  sourcePolicy: { requireAuthority: true, requireSingleFileExpansion: true },
  source: { ...source, expandedSingleFile: true },
  evidence: { kind: 'pytorch_reference', environment: 'C500', value: 100, unit: 'us', shapeKey: JSON.stringify({ correctnessCases: 1 }), source: { ...source, expandedSingleFile: true } },
};
state.benchmark = { matrix, purpose: 'candidate' };

const resultFor = (value) => ({
  benchmark: [{ environment: 'C500', metric: 'latency p50', value, unit: 'us', correctness: { passed: true, total: 1 } }],
  tracer: { format: 'operator-trace/v1', status: 'completed', events: [], simulated: true },
  profiler: { format: 'operator-profile/v1', status: 'completed', metrics: {}, simulated: true },
  environment: { service: 'local-c500-adapter', source: 'simulation', liveHardware: false },
});

assert.equal(evaluateAcceptGate(state, resultFor(92)).result, 'reference');
assert.equal(evaluateAcceptGate(state, resultFor(84)).result, 'reference');
const passed = evaluateAcceptGate(state, resultFor(75));
assert.equal(passed.passed, true);
assert.equal(passed.publishable, false);
assert.match(passed.rules.find((rule) => rule.id === 'performance.target').expected, /80us/);

const semanticGateState = structuredClone(state);
semanticGateState.missions = [flexibleMission];
semanticGateState.activeMissionId = flexibleMission.id;
semanticGateState.baseline.sourcePolicy = { requireAuthority: false, requireSingleFileExpansion: true, allowAgentSemantic: true };
semanticGateState.baseline.source = { ...semanticSource, expandedSingleFile: true };
semanticGateState.baseline.evidence.source = { ...semanticSource, expandedSingleFile: true };
assert.equal(evaluateAcceptGate(semanticGateState, resultFor(75)).passed, true);

process.stdout.write('[strict-zero-source] strict authority, semantic fallback, and relative gate passed\n');
