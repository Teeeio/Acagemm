import assert from 'node:assert/strict';
import { materializeBaselineSource, validateBaselineRunPy } from '../client-runtime/baseline-materializer.mjs';

const source = {
  authority: 'upstream',
  repository: 'https://github.com/flashinfer-ai/flashinfer.git',
  commit: 'ee3fda10',
  path: 'flashinfer/decode.py',
  operator: 'paged_attention',
};

const materialized = materializeBaselineSource({
  mission: { id: 'MIS_MAT', title: 'FlashInfer paged_attention', hardware: ['gpu-iluvatar-mainstream'] },
  source,
  matrix: { shape: { batch: 1, num_heads: 2, seq_len: 16, head_dim: 32 } },
});

assert.equal(materialized.kind, 'pytorch_reference');
assert.equal(materialized.source.expandedSingleFile, true);
assert.equal(materialized.report.mode, 'template_flashinfer_paged_attention');
assert.match(materialized.runPy, /def get_inputs\(\):/);
assert.match(materialized.runPy, /def run\(inputs\):/);
assert.match(materialized.runPy, /def reference\(inputs\):/);
assert.doesNotMatch(materialized.runPy, /import flashinfer/);
assert.equal(validateBaselineRunPy(materialized.runPy).ok, true);

const invalid = validateBaselineRunPy('import flashinfer\n\ndef run(inputs): pass\n');
assert.equal(invalid.ok, false);
assert.ok(invalid.missing.includes('get_inputs'));
assert.ok(invalid.banned.includes('flashinfer'));

assert.throws(
  () => materializeBaselineSource({ mission: { title: 'unknown op' }, source: { ...source, repository: 'https://example.invalid/repo.git', path: 'unknown/op.py', operator: 'unknown' } }),
  (error) => error.code === 'BASELINE_MATERIALIZER_UNSUPPORTED',
);

assert.throws(
  () => materializeBaselineSource({ mission: { title: 'FlashInfer paged_attention' }, source, body: { materializerResult: { runPy: '', report: { summary: 'unsupported' } } } }),
  (error) => error.code === 'BASELINE_MATERIALIZER_EMPTY',
);

console.log('[baseline-materializer] template materialization and validation passed');
