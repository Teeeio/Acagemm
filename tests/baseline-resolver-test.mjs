import assert from 'node:assert/strict';
import {
  baselineMatchesMatrix,
  inferAuthoritativeBaselineSource,
  normalizeBaselineKind,
  resolveBaselineRunPlan,
  selectResearchBaselineSource,
} from '../client-runtime/baseline-resolver.mjs';

const mission = {
  id: 'MIS_BASELINE',
  title: 'flashinfer paged_attention',
  hardware: ['gpu-iluvatar-mainstream'],
  metric: 'latency p50',
};

const matrix = { environments: ['天数 Iluvatar'], correctnessCases: 24 };

const upstreamSource = {
  authority: 'upstream',
  repository: 'https://github.com/flashinfer-ai/flashinfer.git',
  commit: 'ee3fda10',
  path: 'flashinfer/decode.py',
  operator: 'paged_attention',
  expandedSingleFile: true,
};

const alternateSource = { ...upstreamSource, path: 'include/flashinfer/attention/mla.cuh', operator: 'BatchMLAPagedAttention' };
const selectedAfterRejection = selectResearchBaselineSource([
  { baselineSources: [{ ...upstreamSource, confidence: 'high' }] },
  { baselineSources: [{ ...alternateSource, confidence: 'medium' }] },
], mission, { excludedSources: [upstreamSource] });
assert.equal(selectedAfterRejection.path, alternateSource.path, 'recovery must not select a source already rejected by the materializer');

assert.equal(normalizeBaselineKind('naive_v0'), 'naive_v0');
assert.equal(normalizeBaselineKind('anything-else'), 'pytorch_reference');

const inferredSource = inferAuthoritativeBaselineSource({
  title: 'FlashInfer Paged Attention / 天数 Runner E2E',
  goal: '迁移 flashinfer paged_attention 到 gpu-iluvatar-mainstream',
});
assert.equal(inferredSource.repository, 'https://github.com/flashinfer-ai/flashinfer');
assert.equal(inferredSource.path, 'include/flashinfer/attention/decode.cuh');
assert.equal(inferredSource.expandedSingleFile, false);

const upstreamPlan = await resolveBaselineRunPlan({
  state: { activeMissionId: mission.id },
  mission,
  matrix,
  body: {
    purpose: 'baseline',
    runPy: 'def get_inputs(): pass\n\ndef run(inputs): pass\n\ndef reference(inputs): pass\n',
    baselineSource: upstreamSource,
  },
});
assert.equal(upstreamPlan.baselineKind, 'pytorch_reference');
assert.equal(upstreamPlan.baselineSource.repository, upstreamSource.repository);
assert.equal(upstreamPlan.resolution.strategy, 'authoritative_first');
assert.equal(upstreamPlan.runPySource, 'request_run_py');

const researchBackedPlan = await resolveBaselineRunPlan({
  state: {
    activeMissionId: mission.id,
    researchNotes: [{
      id: 'note-research',
      baselineSources: [{ ...upstreamSource, expandedSingleFile: false, confidence: 'high' }],
    }],
  },
  mission,
  matrix,
  body: { purpose: 'baseline' },
});
assert.equal(researchBackedPlan.baselineKind, 'pytorch_reference');
assert.equal(researchBackedPlan.baselineSource.repository, upstreamSource.repository);
assert.equal(researchBackedPlan.baselineSource.expandedSingleFile, true, 'materialized run.py marks the research source as single-file expanded');
assert.equal(researchBackedPlan.runPySource, 'template_flashinfer_paged_attention');
assert.match(researchBackedPlan.runPy, /def _torch_paged_attention/);
assert.equal(researchBackedPlan.materializationReport.mode, 'template_flashinfer_paged_attention');

const naivePlan = await resolveBaselineRunPlan({
  state: { activeMissionId: mission.id },
  mission,
  matrix,
  body: { purpose: 'baseline', baselineKind: 'naive_v0', operator: 'paged_attention' },
});
assert.equal(naivePlan.baselineKind, 'naive_v0');
assert.equal(naivePlan.baselineSource.authority, 'generated');
assert.equal(naivePlan.baselineSource.basedOn, 'v0');
assert.equal(naivePlan.resolution.strategy, 'fallback_naive_v0');
assert.match(naivePlan.runPy, /Auto-generated naive_v0 baseline/);
assert.equal(naivePlan.runPySource, 'generated.naive_v0');

const reusableBaseline = {
  required: true,
  kind: 'naive_v0',
  status: 'complete',
  sourcePolicy: { requireAuthority: false, requireSingleFileExpansion: true, allowGeneratedV0: true },
  evidence: {
    kind: 'naive_v0',
    environment: 'gpu-iluvatar-mainstream',
    shapeKey: JSON.stringify({ correctnessCases: 24 }),
    source: naivePlan.baselineSource,
  },
};
assert.equal(baselineMatchesMatrix(reusableBaseline, mission, matrix), true, 'runner alias and shape should allow baseline reuse');

const orderedShapeMatrix = { environments: ['gpu-iluvatar-mainstream'], shape: { seq_len: 128, num_heads: 2, head_dim: 64, batch: 1 } };
const legacyOrderedEvidence = {
  ...reusableBaseline,
  kind: 'pytorch_reference',
  sourcePolicy: { requireAuthority: true, requireSingleFileExpansion: true },
  evidence: {
    kind: 'pytorch_reference',
    environment: 'gpu-iluvatar-mainstream',
    shapeKey: JSON.stringify({ seq_len: 128, head_dim: 64, num_heads: 2, batch: 1 }),
    source: upstreamSource,
  },
};
assert.equal(baselineMatchesMatrix(legacyOrderedEvidence, mission, orderedShapeMatrix), true, 'shape key comparison must ignore object key order');

const staleBaseline = {
  ...reusableBaseline,
  evidence: { ...reusableBaseline.evidence, shapeKey: JSON.stringify({ correctnessCases: 12 }) },
};
assert.equal(baselineMatchesMatrix(staleBaseline, mission, matrix), false, 'shape change invalidates baseline reuse');

console.log('[baseline-resolver] authoritative, naive_v0 fallback, and reuse checks passed');
