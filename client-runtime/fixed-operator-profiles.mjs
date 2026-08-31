const dtypeCases = (groups) => groups.flatMap(({ id, dtypes, ...parameters }) => dtypes.map((dtype) => ({ id: `${id}-${dtype}`, group: id, dtype, parameters })));

// Profile metadata is embedded in executable Python artifacts. JSON and Python
// differ for booleans/null, so serialize structured values as Python literals.
const pythonLiteral = (value) => {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`).join(', ')}}`;
  return 'None';
};

const profiles = [
  {
    id: 'paged-mqa-logits-triton',
    title: 'Paged MQA Logits / Triton',
    operator: 'paged_mqa_logits',
    implementationLanguage: 'triton',
    entrypoint: 'bf16_paged_mqa_logits',
    summary: 'Paged KV K-only lookup; per-head ReLU(Q dot K), head weighting, then head reduction. No softmax and no V.',
    immutableRules: ['invalid context positions are exactly zero', 'output is float32', 'schedule_metadata, clean_logits and logits_dtype do not change semantics'],
    correctness: dtypeCases([
      { id: 'P1', dtypes: ['float32', 'float16', 'bfloat16'], B: 4, next_n: 2, H: 64, D: 128, block_size: 64, num_blocks: 1024, max_ctx: 4096, length_min: 256, length_max: 4096 },
      { id: 'P2', dtypes: ['float16', 'bfloat16'], B: 8, next_n: 2, H: 128, D: 128, block_size: 64, num_blocks: 4096, max_ctx: 8192, length_min: 4096, length_max: 8192 },
      { id: 'P3', dtypes: ['bfloat16'], B: 16, next_n: 1, H: 32, D: 128, block_size: 32, num_blocks: 4096, max_ctx: 4096, length_min: 1024, length_max: 4096 },
    ]),
    benchmark: dtypeCases([
      { id: 'PB1', dtypes: ['bfloat16'], B: 32, next_n: 8, H: 128, D: 128, block_size: 64, num_blocks: 8192, max_ctx: 8192, length_min: 4096, length_max: 8192 },
      { id: 'PB2', dtypes: ['float16'], B: 32, next_n: 8, H: 128, D: 128, block_size: 64, num_blocks: 8192, max_ctx: 8192, length_min: 4096, length_max: 8192 },
    ]),
  },
  {
    id: 'flash-mla-decode-triton',
    title: 'Flash MLA Decode / Triton',
    operator: 'flash_mla_decode',
    implementationLanguage: 'triton',
    entrypoint: 'flash_mla_decode',
    summary: 'Latent paged decode: softmax((q_nope dot Vc + q_pe dot Kpe) / sqrt(d)) @ Vc.',
    immutableRules: ['scale is 1/sqrt(d), normally 1/sqrt(576)', 's_q greater than one has no query-dependent causal mask', 'output is float32'],
    correctness: dtypeCases([
      { id: 'M1', dtypes: ['float32', 'float16', 'bfloat16'], b: 8, s_q: 1, h_q: 128, d: 576, dv: 512, block_size: 64, num_blocks: 512, length_min: 512, length_max: 1024 },
      { id: 'M2', dtypes: ['float16', 'bfloat16'], b: 16, s_q: 2, h_q: 64, d: 576, dv: 512, block_size: 64, num_blocks: 2048, length_min: 2048, length_max: 4096 },
      { id: 'M3', dtypes: ['bfloat16'], b: 4, s_q: 1, h_q: 128, d: 192, dv: 128, block_size: 16, num_blocks: 512, length_min: 256, length_max: 512 },
    ]),
    benchmark: dtypeCases([
      { id: 'MB1', dtypes: ['bfloat16'], b: 128, s_q: 1, h_q: 128, d: 576, dv: 512, block_size: 64, num_blocks: 16384, length_min: 3072, length_max: 4096 },
      { id: 'MB2', dtypes: ['float16'], b: 128, s_q: 1, h_q: 128, d: 576, dv: 512, block_size: 64, num_blocks: 16384, length_min: 3072, length_max: 4096 },
    ]),
  },
  {
    id: 'paged-decode-attention-maca',
    title: 'FlashInfer Paged Decode',
    operator: 'paged_decode_attention',
    implementationLanguage: 'mxmaca-cpp-extension',
    entrypoint: 'paged_decode_attention',
    summary: 'FlashInfer-style standard paged MHA/GQA/MQA decode: softmax(QK^T/sqrt(D))V with query length one.',
    immutableRules: ['K and V are separate NHD page caches', 'kv_h = q_head // (Hq/Hkv)', 'physical pages are shuffled', 'output dtype equals q dtype'],
    correctness: dtypeCases([
      { id: 'D1', dtypes: ['float32', 'float16', 'bfloat16'], B: 4, Hq: 32, Hkv: 8, D: 128, page_size: 16, length_min: 256, length_max: 1024 },
      { id: 'D2', dtypes: ['float16', 'bfloat16'], B: 8, Hq: 64, Hkv: 8, D: 128, page_size: 16, length_min: 2048, length_max: 4096 },
      { id: 'D3', dtypes: ['bfloat16'], B: 16, Hq: 32, Hkv: 1, D: 128, page_size: 64, length_min: 1024, length_max: 4096 },
    ]),
    benchmark: dtypeCases([
      { id: 'DB1', dtypes: ['bfloat16'], B: 128, Hq: 32, Hkv: 8, D: 128, page_size: 16, length_min: 3072, length_max: 4096 },
      { id: 'DB2', dtypes: ['float16'], B: 128, Hq: 32, Hkv: 8, D: 128, page_size: 16, length_min: 3072, length_max: 4096 },
    ]),
  },
  {
    id: 'mla-paged-decode-attention-maca',
    title: 'FlashInfer MLA Paged Attention',
    operator: 'mla_paged_decode_attention',
    implementationLanguage: 'mxmaca-cpp-extension',
    entrypoint: 'mla_paged_decode_attention',
    summary: 'DeepSeek matrix-absorption MLA: softmax((q_nope dot CKV + q_pe dot KPE)/sqrt(192)) @ CKV.',
    immutableRules: ['q_nope/CKV dimension is 512 and q_pe/KPE is 64', 'scale is exactly 1/sqrt(192)', 'multi-token causal mask is bottom-right aligned', 'output dtype equals q_nope dtype'],
    correctness: dtypeCases([
      { id: 'F1', dtypes: ['float32', 'float16', 'bfloat16'], B: 4, Q: 1, H: 128, ckv_dim: 512, kpe_dim: 64, page_size: 64, causal: false, length_min: 512, length_max: 1024 },
      { id: 'F2', dtypes: ['float16', 'bfloat16'], B: 8, Q: 2, H: 64, ckv_dim: 512, kpe_dim: 64, page_size: 64, causal: true, length_min: 2048, length_max: 4096 },
      { id: 'F3', dtypes: ['bfloat16'], B: 16, Q: 1, H: 128, ckv_dim: 512, kpe_dim: 64, page_size: 16, causal: false, length_min: 1024, length_max: 4096 },
    ]),
    benchmark: dtypeCases([
      { id: 'FMB1', dtypes: ['bfloat16'], B: 128, Q: 1, H: 128, ckv_dim: 512, kpe_dim: 64, page_size: 64, causal: false, length_min: 3072, length_max: 4096 },
      { id: 'FMB2', dtypes: ['float16'], B: 128, Q: 1, H: 128, ckv_dim: 512, kpe_dim: 64, page_size: 64, causal: false, length_min: 3072, length_max: 4096 },
    ]),
  },
  {
    id: 'paged-mqa-logits-triton-v01',
    title: 'Paged MQA Logits / Triton v0.1',
    operator: 'paged_mqa_logits',
    implementationLanguage: 'triton',
    entrypoint: 'bf16_paged_mqa_logits',
    entrypoints: ['bf16_paged_mqa_logits'],
    summary: 'Independent paged MQA logits task: paged K lookup, per-head ReLU(Q dot K), float32 head weighting, and head reduction. No softmax and no V.',
    interfaceContract: [
      'def bf16_paged_mqa_logits(q, kv_cache, weights, context_lens, block_table, schedule_metadata, max_context_len, clean_logits=False, logits_dtype=torch.float32)',
      'q is [B,next_n,H,D] and kv_cache is [num_blocks,block_size,1,D], both with identical float32/float16/bfloat16 dtype',
      'weights is [B*next_n,H] float32; context_lens and block_table are int32',
      'output is [B*next_n,max_context_len] float32; schedule_metadata is an ignored compatibility argument',
    ],
    implementationRequirements: [
      'use Triton for the core paged lookup, dot products, ReLU, weighting, and reduction',
      'handle physical block lookup, tail blocks, zero-length contexts, and invalid-position masking without changing the Oracle',
      'choose grid, block sizes, num_warps, num_stages, and shape specialization autonomously',
    ],
    immutableRules: [
      'target runtime is the preconfigured MetaX C550 stack; the Agent must not probe, upgrade, repair, or downsize it',
      'the FlagGems bf16_paged_mqa_logits implementation and its paired tests are forbidden references',
      'positions at or beyond context_lens are exactly zero and output is float32',
      'all 24 fixed correctness cases and both fixed BF16 benchmark shapes are mandatory',
      'fixed shapes, lengths, dtypes, warmup=25, repeats=100, and median timing cannot be weakened or replaced after publication',
      'an out-of-memory, compile failure, or timeout is a failed fixed case and must never trigger automatic shape reduction',
    ],
    forbiddenReferences: ['FlagGems bf16_paged_mqa_logits implementation', 'FlagGems bf16_paged_mqa_logits paired tests'],
    evaluationProtocol: [
      'the fixed Oracle owns all 24 correctness inputs; report max absolute error, RMSE, cosine difference, and PASS/FAIL for every case',
      'all correctness cases must pass before a performance result is valid',
      'benchmark only the Triton call and PyTorch reference call with triton.testing.do_bench, warmup=25, rep=100, median in milliseconds',
      'freeze the initial correct Triton baseline, quantitative threshold, shapes, and test standard before three performance rounds',
    ],
    reportRequirements: ['implementation approach', 'all correctness results', 'both fixed benchmark results', 'initial Triton and PyTorch baselines', 'frozen quantitative threshold', 'three KEEP/DISCARD decisions', 'final best performance', 'threshold disposition', 'known limitations'],
    deliveryFiles: ['paged_mqa_logits.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
    candidateContract: {
      allowedFiles: ['run.py', 'paged_mqa_logits.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
      requiredWorkspaceFiles: ['run.py', 'paged_mqa_logits.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
      requiredChangedFiles: ['run.py'],
      requiredChangedAny: ['paged_mqa_logits.py'],
      contentFiles: ['run.py', 'paged_mqa_logits.py'],
    },
    iterationPolicy: {
      maxGenerationAttempts: 2,
      maxCorrectnessAttempts: 4,
      performanceRounds: 3,
      acceptFirstCorrectCandidate: true,
      requireStrictImprovement: true,
      requireAllProfilesNoRegression: true,
    },
    testConfig: { warmup: 25, repeats: 100 },
    correctness: dtypeCases([
      { id: 'mqa_s1', dtypes: ['float32', 'float16', 'bfloat16'], B: 2, next_n: 1, H: 1, D: 64, block_size: 16, max_context_len: 16, lengths: [3, 16] },
      { id: 'mqa_s2', dtypes: ['float32', 'float16', 'bfloat16'], B: 1, next_n: 2, H: 8, D: 128, block_size: 32, max_context_len: 33, lengths: [5, 33] },
      { id: 'mqa_s3', dtypes: ['float32', 'float16', 'bfloat16'], B: 3, next_n: 2, H: 4, D: 96, block_size: 64, max_context_len: 128, lengths: [1, 63, 64, 65, 127, 128] },
      { id: 'mqa_m1', dtypes: ['float32', 'float16', 'bfloat16'], B: 4, next_n: 2, H: 16, D: 256, block_size: 64, max_context_len: 512, lengths: [100, 200, 333, 500, 1, 64, 512, 299] },
      { id: 'mqa_m2', dtypes: ['float32', 'float16', 'bfloat16'], B: 2, next_n: 1, H: 32, D: 576, block_size: 64, max_context_len: 1001, lengths: [700, 1001] },
      { id: 'mqa_l1', dtypes: ['float32', 'float16', 'bfloat16'], B: 8, next_n: 2, H: 64, D: 128, block_size: 32, max_context_len: 2048, lengths: [2048, 2047, 2017, 1984, 1537, 1536, 1501, 1025, 1024, 993, 512, 511, 257, 256, 33, 32] },
      { id: 'mqa_l2', dtypes: ['float32', 'float16', 'bfloat16'], B: 16, next_n: 1, H: 16, D: 512, block_size: 128, max_context_len: 4096, lengths: [4096, 4095, 3969, 3840, 3073, 3072, 2049, 2048, 1025, 1024, 513, 512, 257, 256, 129, 128] },
      { id: 'mqa_zero', dtypes: ['float32', 'float16', 'bfloat16'], B: 2, next_n: 2, H: 16, D: 128, block_size: 32, max_context_len: 32, lengths: [0, 1, 0, 32] },
    ]),
    benchmark: dtypeCases([
      { id: 'MQA Medium', dtypes: ['bfloat16'], B: 4, next_n: 2, H: 32, D: 576, block_size: 64, max_context_len: 2048, lengths: [2048, 2017, 1984, 1537, 1536, 1281, 1025, 1024] },
      { id: 'MQA Large', dtypes: ['bfloat16'], B: 8, next_n: 2, H: 64, D: 576, block_size: 64, max_context_len: 4096, lengths: [4096, 4095, 4033, 3968, 3841, 3584, 3329, 3072, 3001, 2816, 2561, 2560, 2305, 2240, 2049, 2048] },
    ]),
  },
  {
    id: 'flash-mla-decode-triton-v01',
    title: 'Flash MLA Decode / Triton v0.1',
    operator: 'flash_mla_decode',
    implementationLanguage: 'triton',
    entrypoint: 'flash_mla_decode',
    entrypoints: ['flash_mla_decode'],
    summary: 'Independent latent paged MLA decode task: online softmax((q_nope dot V + q_pe dot K_pe) / sqrt(d)) @ V over every valid cached token.',
    interfaceContract: [
      'def flash_mla_decode(q, block_table, blocked_k, max_seqlen_pad, block_size, b, s_q, cache_seqlens, h_q, h_kv, d, dv, causal=True)',
      'q is [b,s_q,h_q,d], blocked_k is [num_blocks,block_size,1,d], block_table and cache_seqlens are int32, and h_kv is exactly one',
      'd equals dv+d_rope; q_nope and V use the first dv channels while q_pe and K_pe use the remaining channels',
      'output is [b,s_q,h_q,dv] float32 for float32/float16/bfloat16 inputs',
    ],
    implementationRequirements: [
      'use Triton for the core computation and use online softmax without writing the complete attention score matrix to device memory',
      'keep softmax state and output accumulation in float32',
      'handle physical block lookup, tail blocks, and invalid-token masking without changing the Oracle',
      'choose kernel structure, block sizes, num_warps, num_stages, and shape specialization autonomously',
    ],
    immutableRules: [
      'target runtime is the preconfigured MetaX C550 stack; the Agent must not probe, upgrade, repair, or downsize it',
      'the FlagGems flash_mla implementation and its paired tests are forbidden references',
      'h_kv is one, scale is exactly 1/sqrt(d), and output is float32',
      'the Triton kernel must use online softmax with float32 state and must not materialize the complete attention score matrix in device memory',
      'causal=True does not add a query-index-dependent mask; valid tokens are determined by cache_seqlens',
      'all 24 fixed correctness cases and both fixed BF16 benchmark shapes are mandatory',
      'fixed shapes, lengths, dtypes, warmup=25, repeats=100, and median timing cannot be weakened or replaced after publication',
      'an out-of-memory, compile failure, or timeout is a failed fixed case and must never trigger automatic shape reduction',
    ],
    forbiddenReferences: ['FlagGems flash_mla implementation', 'FlagGems flash_mla paired tests'],
    evaluationProtocol: [
      'the fixed Oracle owns all 24 correctness inputs; report max absolute error, RMSE, cosine difference, and PASS/FAIL for every case',
      'all correctness cases must pass before a performance result is valid',
      'benchmark only the Triton call and PyTorch reference call with triton.testing.do_bench, warmup=25, rep=100, median in milliseconds',
      'freeze the initial correct Triton baseline, quantitative threshold, shapes, and test standard before three performance rounds',
    ],
    reportRequirements: ['implementation approach', 'all correctness results', 'both fixed benchmark results', 'initial Triton and PyTorch baselines', 'frozen quantitative threshold', 'three KEEP/DISCARD decisions', 'final best performance', 'threshold disposition', 'known limitations'],
    deliveryFiles: ['flash_mla.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
    candidateContract: {
      allowedFiles: ['run.py', 'flash_mla.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
      requiredWorkspaceFiles: ['run.py', 'flash_mla.py', 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
      requiredChangedFiles: ['run.py'],
      requiredChangedAny: ['flash_mla.py'],
      contentFiles: ['run.py', 'flash_mla.py'],
    },
    iterationPolicy: {
      maxGenerationAttempts: 2,
      maxCorrectnessAttempts: 4,
      performanceRounds: 3,
      acceptFirstCorrectCandidate: true,
      requireStrictImprovement: true,
      requireAllProfilesNoRegression: true,
    },
    testConfig: { warmup: 25, repeats: 100 },
    correctness: dtypeCases([
      { id: 'mla_s1', dtypes: ['float32', 'float16', 'bfloat16'], b: 1, s_q: 1, h_q: 16, dv: 128, d_rope: 64, block_size: 32, lengths: [100], causal: true },
      { id: 'mla_s2', dtypes: ['float32', 'float16', 'bfloat16'], b: 2, s_q: 1, h_q: 8, dv: 64, d_rope: 32, block_size: 16, lengths: [7, 33], causal: true },
      { id: 'mla_norope', dtypes: ['float32', 'float16', 'bfloat16'], b: 1, s_q: 1, h_q: 8, dv: 128, d_rope: 0, block_size: 32, lengths: [70], causal: true },
      { id: 'mla_sq4', dtypes: ['float32', 'float16', 'bfloat16'], b: 1, s_q: 4, h_q: 8, dv: 128, d_rope: 64, block_size: 32, lengths: [256], causal: true },
      { id: 'mla_m1', dtypes: ['float32', 'float16', 'bfloat16'], b: 2, s_q: 1, h_q: 64, dv: 512, d_rope: 64, block_size: 64, lengths: [333, 1024], causal: true },
      { id: 'mla_m2', dtypes: ['float32', 'float16', 'bfloat16'], b: 1, s_q: 1, h_q: 32, dv: 256, d_rope: 64, block_size: 32, lengths: [2048], causal: true },
      { id: 'mla_l1', dtypes: ['float32', 'float16', 'bfloat16'], b: 4, s_q: 1, h_q: 64, dv: 512, d_rope: 64, block_size: 64, lengths: [4096, 3000, 129, 4095], causal: true },
      { id: 'mla_l2', dtypes: ['float32', 'float16', 'bfloat16'], b: 1, s_q: 1, h_q: 8, dv: 128, d_rope: 64, block_size: 64, lengths: [8192], causal: true },
    ]),
    benchmark: dtypeCases([
      { id: 'MLA Medium', dtypes: ['bfloat16'], b: 4, s_q: 1, h_q: 64, dv: 512, d_rope: 64, block_size: 64, lengths: [4096, 4096, 4096, 4096], causal: true },
      { id: 'MLA Large', dtypes: ['bfloat16'], b: 16, s_q: 1, h_q: 64, dv: 512, d_rope: 64, block_size: 64, lengths: Array(16).fill(16384), causal: true },
    ]),
  },
];

export const fixedOperatorProfiles = profiles.map((profile) => structuredClone(profile));

// Only profiles with a complete v0.1 delivery and three-round iteration
// contract are publishable from the production TUI. Other profiles remain
// available to internal fixtures until their contracts are completed.
export const tuiOperatorProfiles = profiles
  .filter((profile) => ['paged-mqa-logits-triton-v01', 'flash-mla-decode-triton-v01'].includes(profile.id))
  .map((profile) => structuredClone(profile));

export const isTuiOperatorProfile = (profileOrId) => {
  const id = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id;
  return tuiOperatorProfiles.some((profile) => profile.id === id);
};

export const getFixedOperatorProfile = (id) => {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw Object.assign(new Error(`Unsupported fixed operator profile: ${id}`), { code: 'FIXED_OPERATOR_PROFILE_UNSUPPORTED' });
  return structuredClone(profile);
};

export const isFixedOperatorMission = (mission = {}) => Boolean(mission.operatorProfile?.id && profiles.some((item) => item.id === mission.operatorProfile.id));

export const fixedOperatorTestMatrix = (profileOrId, hardwareName = 'C500') => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  const environment = String(hardwareName || 'C500').trim() || 'C500';
  const warmup = Number(profile.testConfig?.warmup || 20);
  const repeats = Number(profile.testConfig?.repeats || 100);
  return {
    environments: [environment],
    stages: ['Correctness', 'Full Benchmark'],
    warmup,
    repeats,
    correctnessCases: profile.correctness.length,
    testSpec: {
      schemaVersion: 'operator-studio.test-spec/v1',
      generation: { owner: 'fixed-operator-profile', source: profile.id, deterministic: true, seed: 20260827 },
      correctness: { requestedCases: profile.correctness.length, requiredCategories: ['fixed-profile'], atol: 1e-2, rtol: 1e-2, requireNamedCases: true, dtypeTolerance: { float32: { atol: 1e-4, rtol: 1e-4 }, float16: { atol: 1e-3, rtol: 1e-3 }, bfloat16: { atol: 1e-2, rtol: 1e-2 } }, requireCosDiffBelow: 1e-5 },
      benchmark: { requiredProfiles: profile.benchmark.map((item) => item.group), primaryProfile: profile.benchmark[0].group, warmup, repeats, metrics: ['p50_us', 'reference_p50_us', 'speedup'] },
    },
    profileId: profile.id,
  };
};

export const fixedOperatorPrompt = (profileOrId) => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  const entrypoints = profile.entrypoints || [profile.entrypoint];
  return [
    `Fixed operator profile: ${profile.title} (${profile.id}).`,
    `Entrypoints: ${entrypoints.join(', ')}. Backend: ${profile.implementationLanguage}.`,
    `Frozen semantics: ${profile.summary}`,
    profile.interfaceContract?.length ? `Frozen interface: ${profile.interfaceContract.join('; ')}.` : '',
    profile.implementationRequirements?.length ? `Implementation requirements: ${profile.implementationRequirements.join('; ')}.` : '',
    `Immutable rules: ${profile.immutableRules.join('; ')}.`,
    profile.forbiddenReferences?.length ? `Forbidden references: ${profile.forbiddenReferences.join('; ')}.` : '',
    `Correctness cases: ${JSON.stringify(profile.correctness)}.`,
    `Benchmark cases: ${JSON.stringify(profile.benchmark)}.`,
    profile.evaluationProtocol?.length ? `Evaluation protocol: ${profile.evaluationProtocol.join('; ')}.` : '',
    profile.deliveryFiles?.length ? `Required deliverables: ${profile.deliveryFiles.join(', ')}. Operator Studio also retains run.py as its internal fixed-runner bridge.` : '',
    profile.reportRequirements?.length ? `report.md must record: ${profile.reportRequirements.join('; ')}.` : '',
    profile.iterationPolicy ? `Iteration policy: ${JSON.stringify(profile.iterationPolicy)}.` : '',
    'This embedded profile is the task authority. External research may suggest optimization techniques but must never alter semantics, interfaces, cases, dtype rules, paging, scaling, masking, or output dtype.',
    profile.iterationPolicy
      ? 'Establish the first correctness-passing Triton version, then execute exactly three performance optimization rounds. Correctness regressions are DISCARD; only strict improvement without fixed-profile regression is KEEP.'
      : 'Exactly three candidate rounds are required. Optimize the candidate implementation only; preserve the reference and test factories.',
  ].filter(Boolean).join('\n');
};

const pythonPreamble = (profile) => `# Generated from immutable Operator Studio profile: ${profile.id}\nimport math\nimport torch\n\nPROFILE_ID = ${pythonLiteral(profile.id)}\nCORRECTNESS_CASES = ${pythonLiteral(profile.correctness)}\nBENCHMARK_CASES = ${pythonLiteral(profile.benchmark)}\n\ndef _dtype(name):\n    return getattr(torch, name)\n\ndef _device():\n    if not torch.cuda.is_available():\n        raise RuntimeError("C500 is unavailable through torch.cuda")\n    return torch.device("cuda")\n\ndef _item_seed(item):\n    return 20260827 + sum((index + 1) * ord(char) for index, char in enumerate(item["id"]))\n\ndef _seeded_inputs(item):\n    torch.manual_seed(_item_seed(item))\n    return _make_inputs(item)\n\ndef _lengths(count, low, high, device):\n    values = torch.randint(low, high, (count,), dtype=torch.int32, device=device)\n    if high - low > 1:\n        values[0] = high - 1\n    return values\n\ndef _pages(batch, max_len, page_size, device):\n    pages_per_batch = (max_len + page_size - 1) // page_size\n    total_pages = batch * pages_per_batch\n    perm = torch.randperm(total_pages, dtype=torch.int64, device=device).to(torch.int32)\n    indptr = torch.arange(0, total_pages + 1, pages_per_batch, dtype=torch.int32, device=device)\n    return indptr, perm, total_pages\n\ndef _case(item):\n    return {"name": item["id"], "category": "fixed-profile", "make_inputs": lambda item=item: _seeded_inputs(item)}\n\ndef get_test_cases():\n    return [_case(item) for item in CORRECTNESS_CASES]\n\ndef get_benchmark_inputs():\n    return [{"name": item["group"], "make_inputs": lambda item=item: _seeded_inputs(item)} for item in BENCHMARK_CASES]\n\ndef get_inputs():\n    return _seeded_inputs(CORRECTNESS_CASES[0])\n\n`;

const pagedMqaPython = `def _make_inputs(item):
    p, device, dtype = item["parameters"], _device(), _dtype(item["dtype"])
    q = torch.randn((p["B"], p["next_n"], p["H"], p["D"]), device=device, dtype=dtype)
    kv = torch.randn((p["num_blocks"], p["block_size"], 1, p["D"]), device=device, dtype=dtype)
    weights = torch.randn((p["B"] * p["next_n"], p["H"]), device=device, dtype=torch.float32)
    lengths = _lengths(p["B"] * p["next_n"], p["length_min"], p["length_max"], device).view(p["B"], p["next_n"])
    max_blocks = (p["max_ctx"] + p["block_size"] - 1) // p["block_size"]
    table = torch.randint(0, p["num_blocks"], (p["B"], max_blocks), device=device, dtype=torch.int32)
    return {"q": q, "kv_cache": kv, "weights": weights, "context_lens": lengths, "block_table": table, "max_context_len": p["max_ctx"]}

def reference(inputs):
    q, kv, weights = inputs["q"], inputs["kv_cache"], inputs["weights"]
    lengths, table, max_ctx = inputs["context_lens"], inputs["block_table"], inputs["max_context_len"]
    B, next_n, H, D = q.shape
    out = torch.zeros((B * next_n, max_ctx), device=q.device, dtype=torch.float32)
    block_size = kv.shape[1]
    for b in range(B):
        for n in range(next_n):
            row, length = b * next_n + n, int(lengths[b, n])
            pos = torch.arange(length, device=q.device)
            keys = kv[table[b, pos // block_size].long(), pos % block_size, 0].float()
            dots = torch.matmul(q[b, n].float(), keys.T)
            out[row, :length] = (torch.relu(dots) * weights[row].float()[:, None]).sum(0)
    return out

def run(inputs):
    return reference(inputs)
`;

const flashMlaPython = `def _make_inputs(item):
    p, device, dtype = item["parameters"], _device(), _dtype(item["dtype"])
    q = torch.randn((p["b"], p["s_q"], p["h_q"], p["d"]), device=device, dtype=dtype)
    cache = torch.randn((p["num_blocks"], p["block_size"], 1, p["d"]), device=device, dtype=dtype)
    lengths = _lengths(p["b"], p["length_min"], p["length_max"], device)
    max_blocks = (p["length_max"] + p["block_size"] - 1) // p["block_size"]
    table = torch.randint(0, p["num_blocks"], (p["b"], max_blocks), device=device, dtype=torch.int32)
    return {"q": q, "block_table": table, "blocked_k": cache, "cache_seqlens": lengths, "block_size": p["block_size"], "dv": p["dv"]}

def reference(inputs):
    q, table, cache = inputs["q"], inputs["block_table"], inputs["blocked_k"]
    lengths, block_size, dv = inputs["cache_seqlens"], inputs["block_size"], inputs["dv"]
    b, s_q, h_q, d = q.shape
    out = torch.empty((b, s_q, h_q, dv), device=q.device, dtype=torch.float32)
    for i in range(b):
        length = int(lengths[i]); pos = torch.arange(length, device=q.device)
        latent = cache[table[i, pos // block_size].long(), pos % block_size, 0].float()
        vc, kpe = latent[:, :dv], latent[:, dv:]
        for j in range(s_q):
            scores = torch.matmul(q[i, j, :, :dv].float(), vc.T) + torch.matmul(q[i, j, :, dv:].float(), kpe.T)
            probs = torch.softmax(scores * (d ** -0.5), dim=-1)
            out[i, j] = torch.matmul(probs, vc)
    return out

def run(inputs):
    return reference(inputs)
`;

const pagedMqaV01Python = `def _make_inputs(item):
    p, device, dtype = item["parameters"], _device(), _dtype(item["dtype"])
    lengths = torch.tensor(p["lengths"], dtype=torch.int32, device=device).view(p["B"], p["next_n"])
    max_blocks = max(1, (p["max_context_len"] + p["block_size"] - 1) // p["block_size"])
    num_blocks = p["B"] * max_blocks + 7
    q = torch.randn((p["B"], p["next_n"], p["H"], p["D"]), device=device, dtype=dtype)
    kv = torch.randn((num_blocks, p["block_size"], 1, p["D"]), device=device, dtype=dtype)
    weights = torch.randn((p["B"] * p["next_n"], p["H"]), device=device, dtype=torch.float32)
    table = torch.randperm(num_blocks, device=device, dtype=torch.int64)[:p["B"] * max_blocks].to(torch.int32).view(p["B"], max_blocks)
    return {"q": q, "kv_cache": kv, "weights": weights, "context_lens": lengths, "block_table": table, "max_context_len": p["max_context_len"]}

def reference(inputs):
    q, kv, weights = inputs["q"], inputs["kv_cache"], inputs["weights"]
    lengths, table, max_ctx = inputs["context_lens"], inputs["block_table"], inputs["max_context_len"]
    B, next_n, H, D = q.shape
    out = torch.zeros((B * next_n, max_ctx), device=q.device, dtype=torch.float32)
    block_size = kv.shape[1]
    for batch in range(B):
        for next_index in range(next_n):
            row, length = batch * next_n + next_index, int(lengths[batch, next_index])
            if length == 0:
                continue
            pos = torch.arange(length, device=q.device)
            keys = kv[table[batch, pos // block_size].long(), pos % block_size, 0].float()
            dots = torch.matmul(q[batch, next_index].float(), keys.T)
            out[row, :length] = (torch.relu(dots) * weights[row].float()[:, None]).sum(0)
    return out

def run(inputs):
    return reference(inputs)
`;

const flashMlaV01Python = `def _make_inputs(item):
    p, device, dtype = item["parameters"], _device(), _dtype(item["dtype"])
    lengths = torch.tensor(p["lengths"], dtype=torch.int32, device=device)
    d = p["dv"] + p["d_rope"]
    max_len = max(p["lengths"])
    max_blocks = max(1, (max_len + p["block_size"] - 1) // p["block_size"])
    num_blocks = p["b"] * max_blocks + 7
    q = torch.randn((p["b"], p["s_q"], p["h_q"], d), device=device, dtype=dtype)
    cache = torch.randn((num_blocks, p["block_size"], 1, d), device=device, dtype=dtype)
    table = torch.randperm(num_blocks, device=device, dtype=torch.int64)[:p["b"] * max_blocks].to(torch.int32).view(p["b"], max_blocks)
    return {"q": q, "block_table": table, "blocked_k": cache, "cache_seqlens": lengths, "block_size": p["block_size"], "dv": p["dv"], "causal": p.get("causal", True)}

def reference(inputs):
    q, table, cache = inputs["q"], inputs["block_table"], inputs["blocked_k"]
    lengths, block_size, dv = inputs["cache_seqlens"], inputs["block_size"], inputs["dv"]
    batch_size, s_q, h_q, d = q.shape
    out = torch.empty((batch_size, s_q, h_q, dv), device=q.device, dtype=torch.float32)
    for batch in range(batch_size):
        length = int(lengths[batch])
        pos = torch.arange(length, device=q.device)
        latent = cache[table[batch, pos // block_size].long(), pos % block_size, 0].float()
        values, rope_keys = latent[:, :dv], latent[:, dv:]
        for query_index in range(s_q):
            scores = torch.matmul(q[batch, query_index, :, :dv].float(), values.T)
            if d > dv:
                scores = scores + torch.matmul(q[batch, query_index, :, dv:].float(), rope_keys.T)
            probabilities = torch.softmax(scores * (d ** -0.5), dim=-1)
            out[batch, query_index] = torch.matmul(probabilities, values)
    return out

def run(inputs):
    return reference(inputs)
`;

const pagedDecodePython = `def _make_inputs(item):
    p, device, dtype = item["parameters"], _device(), _dtype(item["dtype"])
    lengths = _lengths(p["B"], p["length_min"], p["length_max"], device)
    indptr, indices, pages = _pages(p["B"], p["length_max"], p["page_size"], device)
    last = ((lengths - 1) % p["page_size"] + 1).to(torch.int32)
    q = torch.randn((p["B"], p["Hq"], p["D"]), device=device, dtype=dtype)
    k = torch.randn((pages, p["page_size"], p["Hkv"], p["D"]), device=device, dtype=dtype)
    v = torch.randn_like(k)
    return {"q": q, "paged_k_cache": k, "paged_v_cache": v, "kv_indptr": indptr, "kv_indices": indices, "kv_last_page_len": last, "kv_lengths": lengths, "page_size": p["page_size"]}

def reference(inputs):
    q, kc, vc = inputs["q"], inputs["paged_k_cache"], inputs["paged_v_cache"]
    indptr, indices, lengths, page_size = inputs["kv_indptr"], inputs["kv_indices"], inputs["kv_lengths"], inputs["page_size"]
    B, Hq, D = q.shape; Hkv = kc.shape[2]; group = Hq // Hkv
    out = torch.empty_like(q)
    for i in range(B):
        length = int(lengths[i]); pos = torch.arange(length, device=q.device)
        pages = indices[indptr[i].long() + pos // page_size].long(); offsets = pos % page_size
        k, v = kc[pages, offsets].float(), vc[pages, offsets].float()
        kv_head = torch.arange(Hq, device=q.device) // group
        kh, vh = k[:, kv_head].permute(1, 0, 2), v[:, kv_head].permute(1, 0, 2)
        scores = torch.einsum("hd,hld->hl", q[i].float(), kh) * (D ** -0.5)
        out[i] = torch.einsum("hl,hld->hd", torch.softmax(scores, -1), vh).to(q.dtype)
    return out

def run(inputs):
    return reference(inputs)
`;

const mlaPagedPython = `def _make_inputs(item):
    p, device, dtype = item["parameters"], _device(), _dtype(item["dtype"])
    lengths = _lengths(p["B"], p["length_min"], p["length_max"], device)
    qo = torch.arange(0, (p["B"] + 1) * p["Q"], p["Q"], dtype=torch.int32, device=device)
    indptr, indices, pages = _pages(p["B"], p["length_max"], p["page_size"], device)
    total_q = p["B"] * p["Q"]
    qn = torch.randn((total_q, p["H"], p["ckv_dim"]), device=device, dtype=dtype)
    qp = torch.randn((total_q, p["H"], p["kpe_dim"]), device=device, dtype=dtype)
    ckv = torch.randn((pages, p["page_size"], p["ckv_dim"]), device=device, dtype=dtype)
    kpe = torch.randn((pages, p["page_size"], p["kpe_dim"]), device=device, dtype=dtype)
    return {"q_nope": qn, "q_pe": qp, "ckv_cache": ckv, "kpe_cache": kpe, "qo_indptr": qo, "kv_indptr": indptr, "kv_indices": indices, "kv_len_arr": lengths, "page_size": p["page_size"], "causal": p["causal"]}

def reference(inputs):
    qn, qp, ckv, kpe = inputs["q_nope"], inputs["q_pe"], inputs["ckv_cache"], inputs["kpe_cache"]
    qo, ki, indices, lengths = inputs["qo_indptr"], inputs["kv_indptr"], inputs["kv_indices"], inputs["kv_len_arr"]
    page_size, causal = inputs["page_size"], inputs["causal"]
    out = torch.empty_like(qn)
    for i in range(len(lengths)):
        length = int(lengths[i]); q_begin, q_end = int(qo[i]), int(qo[i + 1]); Q = q_end - q_begin
        pos = torch.arange(length, device=qn.device); pages = indices[ki[i].long() + pos // page_size].long(); offsets = pos % page_size
        c, k = ckv[pages, offsets].float(), kpe[pages, offsets].float()
        for j in range(Q):
            qi = q_begin + j
            scores = (torch.matmul(qn[qi].float(), c.T) + torch.matmul(qp[qi].float(), k.T)) * (192 ** -0.5)
            if causal:
                scores[:, length - Q + j + 1:] = float("-inf")
            out[qi] = torch.matmul(torch.softmax(scores, -1), c).to(qn.dtype)
    return out

def run(inputs):
    return reference(inputs)
`;

export const buildFixedOperatorBaselineRunPy = (profileOrId) => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  const implementation = {
    'paged-mqa-logits-triton': pagedMqaPython,
    'flash-mla-decode-triton': flashMlaPython,
    'paged-decode-attention-maca': pagedDecodePython,
    'mla-paged-decode-attention-maca': mlaPagedPython,
    'paged-mqa-logits-triton-v01': pagedMqaV01Python,
    'flash-mla-decode-triton-v01': flashMlaV01Python,
  }[profile.id];
  return `${pythonPreamble(profile)}${implementation}`;
};

export const fixedOperatorBaselineSource = (profileOrId) => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  return { authority: 'embedded-operator-profile', repository: `operator-profile:${profile.id}`, commit: 'profile-v1', path: 'generated/reference.py', operator: profile.operator, kind: 'pytorch_reference', expandedSingleFile: true, profileId: profile.id };
};
