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
];

export const fixedOperatorProfiles = profiles.map((profile) => structuredClone(profile));

export const getFixedOperatorProfile = (id) => {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw Object.assign(new Error(`Unsupported fixed operator profile: ${id}`), { code: 'FIXED_OPERATOR_PROFILE_UNSUPPORTED' });
  return structuredClone(profile);
};

export const isFixedOperatorMission = (mission = {}) => Boolean(mission.operatorProfile?.id && profiles.some((item) => item.id === mission.operatorProfile.id));

export const fixedOperatorTestMatrix = (profileOrId, hardwareName = 'C500') => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  const environment = String(hardwareName || 'C500').trim() || 'C500';
  return {
    environments: [environment],
    stages: ['Correctness', 'Full Benchmark'],
    warmup: 20,
    repeats: 100,
    correctnessCases: profile.correctness.length,
    testSpec: {
      schemaVersion: 'operator-studio.test-spec/v1',
      generation: { owner: 'fixed-operator-profile', source: profile.id, deterministic: true, seed: 20260827 },
      correctness: { requestedCases: profile.correctness.length, requiredCategories: ['fixed-profile'], atol: 1e-2, rtol: 1e-2, requireNamedCases: true, dtypeTolerance: { float32: { atol: 1e-4, rtol: 1e-4 }, float16: { atol: 1e-3, rtol: 1e-3 }, bfloat16: { atol: 1e-2, rtol: 1e-2 } }, requireCosDiffBelow: 1e-5 },
      benchmark: { requiredProfiles: profile.benchmark.map((item) => item.group), primaryProfile: profile.benchmark[0].group, warmup: 20, repeats: 100, metrics: ['p50_us', 'reference_p50_us', 'speedup'] },
    },
    profileId: profile.id,
  };
};

export const fixedOperatorPrompt = (profileOrId) => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  return [
    `Fixed operator profile: ${profile.title} (${profile.id}).`,
    `Entrypoint: ${profile.entrypoint}. Backend: ${profile.implementationLanguage}.`,
    `Frozen semantics: ${profile.summary}`,
    `Immutable rules: ${profile.immutableRules.join('; ')}.`,
    `Correctness cases: ${JSON.stringify(profile.correctness)}.`,
    `Benchmark cases: ${JSON.stringify(profile.benchmark)}.`,
    'This embedded profile is the task authority. External research may suggest optimization techniques but must never alter semantics, interfaces, cases, dtype rules, paging, scaling, masking, or output dtype.',
    'Exactly three candidate rounds are required. Optimize the candidate implementation only; preserve the reference and test factories.',
  ].join('\n');
};

const pythonPreamble = (profile) => `# Generated from immutable Operator Studio profile: ${profile.id}\nimport math\nimport torch\n\nPROFILE_ID = ${pythonLiteral(profile.id)}\nCORRECTNESS_CASES = ${pythonLiteral(profile.correctness)}\nBENCHMARK_CASES = ${pythonLiteral(profile.benchmark)}\n\ndef _dtype(name):\n    return getattr(torch, name)\n\ndef _device():\n    if not torch.cuda.is_available():\n        raise RuntimeError("C500 is unavailable through torch.cuda")\n    return torch.device("cuda")\n\ndef _lengths(count, low, high, device):\n    values = torch.randint(low, high, (count,), dtype=torch.int32, device=device)\n    if high - low > 1:\n        values[0] = high - 1\n    return values\n\ndef _pages(batch, max_len, page_size, device):\n    pages_per_batch = (max_len + page_size - 1) // page_size\n    total_pages = batch * pages_per_batch\n    perm = torch.randperm(total_pages, dtype=torch.int64, device=device).to(torch.int32)\n    indptr = torch.arange(0, total_pages + 1, pages_per_batch, dtype=torch.int32, device=device)\n    return indptr, perm, total_pages\n\ndef _case(item):\n    return {"name": item["id"], "category": "fixed-profile", "make_inputs": lambda item=item: _make_inputs(item)}\n\ndef get_test_cases():\n    return [_case(item) for item in CORRECTNESS_CASES]\n\ndef get_benchmark_inputs():\n    return [{"name": item["group"], "make_inputs": lambda item=item: _make_inputs(item)} for item in BENCHMARK_CASES]\n\ndef get_inputs():\n    return _make_inputs(CORRECTNESS_CASES[0])\n\n`;

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
  }[profile.id];
  return `${pythonPreamble(profile)}${implementation}`;
};

export const fixedOperatorBaselineSource = (profileOrId) => {
  const profile = typeof profileOrId === 'string' ? getFixedOperatorProfile(profileOrId) : profileOrId;
  return { authority: 'embedded-operator-profile', repository: `operator-profile:${profile.id}`, commit: 'profile-v1', path: 'generated/reference.py', operator: profile.operator, kind: 'pytorch_reference', expandedSingleFile: true, profileId: profile.id };
};
