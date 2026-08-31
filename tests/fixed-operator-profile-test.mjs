import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFixedOperatorBaselineRunPy, fixedOperatorPrompt, fixedOperatorTestMatrix, fixedOperatorProfiles, getFixedOperatorProfile, isTuiOperatorProfile, tuiOperatorProfiles } from '../client-runtime/fixed-operator-profiles.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'fixed-operator-profile-'));
try {
  const source = buildFixedOperatorBaselineRunPy(getFixedOperatorProfile('mla-paged-decode-attention-maca'));
  assert.match(source, /causal": False/);
  assert.doesNotMatch(source, /causal": false/);
  const file = path.join(root, 'run.py');
  await writeFile(file, source, 'utf8');
  const result = spawnSync(process.env.PYTHON || 'python', ['-m', 'py_compile', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const mqa = getFixedOperatorProfile('paged-mqa-logits-triton-v01');
  const mla = getFixedOperatorProfile('flash-mla-decode-triton-v01');
  assert.equal(fixedOperatorProfiles.length, 6);
  assert.deepEqual(tuiOperatorProfiles.map((profile) => profile.id), ['paged-mqa-logits-triton-v01', 'flash-mla-decode-triton-v01']);
  assert.equal(isTuiOperatorProfile('paged-mqa-logits-triton-v01'), true);
  assert.equal(isTuiOperatorProfile('paged-mqa-logits-triton'), false);
  assert.equal(fixedOperatorProfiles.some((profile) => profile.id === 'triton-paged-mqa-flash-mla-v01'), false, 'the two tasks must not share a combined Mission profile');
  assert.deepEqual(mqa.entrypoints, ['bf16_paged_mqa_logits']);
  assert.deepEqual(mla.entrypoints, ['flash_mla_decode']);
  assert.equal(mqa.correctness.length, 24);
  assert.equal(mla.correctness.length, 24);
  assert.equal(mqa.benchmark.length, 2);
  assert.equal(mla.benchmark.length, 2);
  for (const profile of [mqa, mla]) {
    for (const group of new Set(profile.correctness.map((item) => item.group))) {
      assert.deepEqual(profile.correctness.filter((item) => item.group === group).map((item) => item.dtype), ['float32', 'float16', 'bfloat16'], `${group} must run all three dtypes`);
    }
    const matrix = fixedOperatorTestMatrix(profile, 'C550');
    assert.equal(matrix.correctnessCases, 24);
    assert.equal(matrix.warmup, 25);
    assert.equal(matrix.repeats, 100);
    assert.equal(matrix.testSpec.benchmark.warmup, 25);
    assert.equal(matrix.testSpec.benchmark.repeats, 100);
    assert.match(fixedOperatorPrompt(profile), /FlagGems.*forbidden|Forbidden references: FlagGems/i);
    assert.match(fixedOperatorPrompt(profile), /cannot be weakened|cannot be weakened or replaced/i);
  }
  assert.deepEqual(mqa.deliveryFiles, ['paged_mqa_logits.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md']);
  assert.deepEqual(mla.deliveryFiles, ['flash_mla.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md']);
  assert.match(fixedOperatorPrompt(mqa), /def bf16_paged_mqa_logits\(q, kv_cache, weights, context_lens, block_table, schedule_metadata, max_context_len/);
  assert.match(fixedOperatorPrompt(mla), /def flash_mla_decode\(q, block_table, blocked_k, max_seqlen_pad, block_size, b, s_q, cache_seqlens, h_q, h_kv, d, dv, causal=True\)/);
  assert.match(fixedOperatorPrompt(mla), /online softmax without writing the complete attention score matrix/);
  assert.match(fixedOperatorPrompt(mqa), /warmup=25, rep=100, median/);
  assert.doesNotMatch(fixedOperatorPrompt(mqa), /MLA Medium|mla_s1/);
  assert.doesNotMatch(fixedOperatorPrompt(mla), /MQA Medium|mqa_s1/);
  assert.deepEqual(fixedOperatorTestMatrix(mqa, 'C550').testSpec.benchmark.requiredProfiles, ['MQA Medium', 'MQA Large']);
  assert.deepEqual(fixedOperatorTestMatrix(mla, 'C550').testSpec.benchmark.requiredProfiles, ['MLA Medium', 'MLA Large']);

  const parameters = (profile, group) => profile.correctness.find((item) => item.group === group)?.parameters;
  assert.deepEqual(parameters(mqa, 'mqa_s3'), { B: 3, next_n: 2, H: 4, D: 96, block_size: 64, max_context_len: 128, lengths: [1, 63, 64, 65, 127, 128] });
  assert.deepEqual(parameters(mqa, 'mqa_l1').lengths, [2048, 2047, 2017, 1984, 1537, 1536, 1501, 1025, 1024, 993, 512, 511, 257, 256, 33, 32]);
  assert.deepEqual(parameters(mqa, 'mqa_l2').lengths, [4096, 4095, 3969, 3840, 3073, 3072, 2049, 2048, 1025, 1024, 513, 512, 257, 256, 129, 128]);
  assert.deepEqual(parameters(mqa, 'mqa_zero').lengths, [0, 1, 0, 32]);
  assert.deepEqual(parameters(mla, 'mla_m1'), { b: 2, s_q: 1, h_q: 64, dv: 512, d_rope: 64, block_size: 64, lengths: [333, 1024], causal: true });
  assert.deepEqual(parameters(mla, 'mla_l1').lengths, [4096, 3000, 129, 4095]);
  assert.deepEqual(parameters(mla, 'mla_l2').lengths, [8192]);
  assert.deepEqual(mqa.benchmark.find((item) => item.group === 'MQA Large')?.parameters.lengths, [4096, 4095, 4033, 3968, 3841, 3584, 3329, 3072, 3001, 2816, 2561, 2560, 2305, 2240, 2049, 2048]);
  assert.deepEqual(mla.benchmark.find((item) => item.group === 'MLA Large')?.parameters.lengths, Array(16).fill(16384));

  for (const [profile, filename, ownCase, foreignCase] of [
    [mqa, 'mqa-v01-run.py', 'mqa_zero-bfloat16', 'mla_s1-float32'],
    [mla, 'mla-v01-run.py', 'mla_l2-bfloat16', 'mqa_s1-float32'],
  ]) {
    const profileSource = buildFixedOperatorBaselineRunPy(profile);
    assert.match(profileSource, new RegExp(ownCase));
    assert.doesNotMatch(profileSource, new RegExp(foreignCase));
    const profileFile = path.join(root, filename);
    await writeFile(profileFile, profileSource, 'utf8');
    const profileCompile = spawnSync(process.env.PYTHON || 'python', ['-m', 'py_compile', profileFile], { encoding: 'utf8', windowsHide: true });
    assert.equal(profileCompile.status, 0, profileCompile.stderr || profileCompile.stdout);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('[fixed-operator-profile] generated Python metadata is syntax-valid');
