const REQUIRED_FUNCTIONS = ['get_inputs', 'run', 'reference'];

const hasFunction = (runPy, name) => new RegExp(`(^|\\n)def\\s+${name}\\s*\\(`).test(String(runPy || ''));

export function validateBaselineRunPy(runPy, { allowExternalImports = false } = {}) {
  const text = String(runPy || '');
  const missing = REQUIRED_FUNCTIONS.filter((name) => !hasFunction(text, name));
  const banned = [];
  if (/^\s*import\s+flashinfer\b|^\s*from\s+flashinfer\b/m.test(text)) banned.push('flashinfer');
  if (/optimized_candidate|candidate_patch|apply_candidate/i.test(text)) banned.push('candidate');
  if (!allowExternalImports && /^\s*(?:from|import)\s+(?!torch\b|math\b|typing\b|itertools\b|functools\b|operator\b|collections\b)/m.test(text)) banned.push('undeclared-import');
  return {
    ok: missing.length === 0 && banned.length === 0,
    missing,
    banned,
  };
}

const normalizeMaterializedSource = (source = {}) => ({
  ...source,
  authority: source.authority || 'upstream',
  kind: 'pytorch_reference',
  expandedSingleFile: true,
});

const buildPagedAttentionReferenceRunPy = ({ mission = {}, source = {}, matrix = {} }) => {
  const shape = matrix.shape || mission.upstream?.case || {};
  const batch = Number(shape.batch || shape.batch_size || 2);
  const numHeads = Number(shape.num_heads || shape.heads || 4);
  const seqLen = Number(shape.seq_len || shape.sequenceLength || 128);
  const headDim = Number(shape.head_dim || shape.headDim || 64);
  const dtypeExpr = /bf16|bfloat16/i.test(`${mission.goal || ''} ${mission.metric || ''} ${source.operator || ''}`) ? 'torch.bfloat16' : 'torch.float16';
  const sourceMeta = JSON.stringify({
    repository: source.repository,
    commit: source.commit,
    path: source.path,
    operator: source.operator || mission.operator || mission.title || 'paged_attention',
  }, null, 2).split('\n').map((line) => `# ${line}`).join('\n');
  return [
    '# Materialized authoritative PyTorch reference baseline',
    '# Source provenance:',
    sourceMeta,
    '',
    'def get_inputs():',
    '    import torch',
    '    if not torch.cuda.is_available():',
    '        raise RuntimeError("The accelerator is not available through torch.cuda")',
    '    device = torch.device("cuda")',
    `    batch = ${batch}`,
    `    num_heads = ${numHeads}`,
    `    seq_len = ${seqLen}`,
    `    head_dim = ${headDim}`,
    `    dtype = ${dtypeExpr}`,
    '    torch.manual_seed(20260821)',
    '    query = torch.randn((batch, num_heads, head_dim), device=device, dtype=dtype)',
    '    key_cache = torch.randn((batch, seq_len, num_heads, head_dim), device=device, dtype=dtype)',
    '    value_cache = torch.randn((batch, seq_len, num_heads, head_dim), device=device, dtype=dtype)',
    '    seq_lens = torch.full((batch,), seq_len, device=device, dtype=torch.int32)',
    '    return {"query": query, "key_cache": key_cache, "value_cache": value_cache, "seq_lens": seq_lens}',
    '',
    'def _torch_paged_attention(inputs):',
    '    import torch',
    '    query = inputs["query"]',
    '    key_cache = inputs["key_cache"]',
    '    value_cache = inputs["value_cache"]',
    '    seq_lens = inputs["seq_lens"]',
    '    batch, num_heads, head_dim = query.shape',
    '    outputs = []',
    '    scale = head_dim ** -0.5',
    '    for batch_index in range(batch):',
    '        valid_len = int(seq_lens[batch_index].item())',
    '        q = query[batch_index].to(torch.float32)',
    '        k = key_cache[batch_index, :valid_len].permute(1, 0, 2).to(torch.float32)',
    '        v = value_cache[batch_index, :valid_len].permute(1, 0, 2).to(torch.float32)',
    '        scores = torch.einsum("hd,hld->hl", q, k) * scale',
    '        probs = torch.softmax(scores, dim=-1)',
    '        out = torch.einsum("hl,hld->hd", probs, v)',
    '        outputs.append(out.to(query.dtype))',
    '    return torch.stack(outputs, dim=0)',
    '',
    'def run(inputs):',
    '    return _torch_paged_attention(inputs)',
    '',
    'def reference(inputs):',
    '    return _torch_paged_attention(inputs)',
    '',
  ].join('\n');
};

export function materializeBaselineSource({ mission = {}, source = {}, matrix = {}, body = {} } = {}) {
  const strictZeroSource = body.strictZeroSource === true
    || mission.sourcePolicy?.mode === 'agent-research-only'
    || mission.sourcePolicy?.strictZeroSource === true;
  const agentResult = body.materializerResult || body.baselineMaterialization || null;
  const agentRunPy = typeof agentResult?.runPy === 'string' ? agentResult.runPy : null;
  if (agentResult && !agentRunPy?.trim()) {
    const error = new Error('Baseline materializer 返回了空 run.py。');
    error.status = 422;
    error.code = 'BASELINE_MATERIALIZER_EMPTY';
    error.details = agentResult.report || null;
    throw error;
  }
  const requestRunPy = body.runPy || body.operatorScript || agentRunPy || null;
  if (strictZeroSource && !agentRunPy?.trim()) {
    const error = new Error('Strict zero-source Mission 只接受 Baseline Materializer Agent 生成的 run.py。');
    error.status = 409;
    error.code = 'STRICT_ZERO_SOURCE_AGENT_MATERIALIZER_REQUIRED';
    throw error;
  }
  const mode = agentRunPy ? 'agent_assisted' : requestRunPy ? 'request_run_py' : 'template_flashinfer_paged_attention';
  const sourceText = `${source.repository || ''} ${source.path || ''} ${source.operator || ''} ${mission.title || ''} ${mission.goal || ''}`.toLowerCase();
  const generatedRunPy = requestRunPy || (/flashinfer|paged_attention|paged decode|paged_decode/.test(sourceText)
    ? buildPagedAttentionReferenceRunPy({ mission, source, matrix })
    : null);
  if (!generatedRunPy) {
    const error = new Error('当前 materializer 还不能自动展开该 authoritative source。');
    error.status = 422;
    error.code = 'BASELINE_MATERIALIZER_UNSUPPORTED';
    throw error;
  }
  const validation = validateBaselineRunPy(generatedRunPy, { allowExternalImports: false });
  if (!validation.ok) {
    const error = new Error(`Materialized baseline run.py 未通过结构校验：missing=${validation.missing.join(',') || '-'} banned=${validation.banned.join(',') || '-'}`);
    error.status = 422;
    error.code = 'BASELINE_MATERIALIZER_VALIDATION_FAILED';
    error.details = validation;
    throw error;
  }
  return {
    kind: 'pytorch_reference',
    runPy: generatedRunPy,
    runPySource: mode,
    source: normalizeMaterializedSource(source),
    report: {
      schemaVersion: 'operator-studio.baseline-materialization/v1',
      materializer: 'baseline-materializer/v1',
      mode,
      source: normalizeMaterializedSource(source),
      validation,
      assumptions: mode === 'template_flashinfer_paged_attention'
        ? ['使用 PyTorch eager attention 表达 upstream paged_attention 的语义基线；不依赖 flashinfer 运行时扩展。']
        : ['使用外部受约束生成结果，并重新执行结构校验。'],
      createdAt: new Date().toISOString(),
    },
  };
}
