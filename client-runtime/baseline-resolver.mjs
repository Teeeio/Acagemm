import { runnerMatches } from './runner-aliases.mjs';
import { materializeBaselineSource } from './baseline-materializer.mjs';

export const normalizeBaselineKind = (kind = 'pytorch_reference') => (
  String(kind || '').trim() === 'naive_v0' ? 'naive_v0' : 'pytorch_reference'
);

export const isStrictZeroSourceMission = (mission = {}, body = {}) => (
  body.strictZeroSource === true
  || mission.sourcePolicy?.mode === 'agent-research-only'
  || mission.sourcePolicy?.strictZeroSource === true
);

const stableShapeValue = (value) => {
  if (Array.isArray(value)) return value.map(stableShapeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableShapeValue(value[key])]));
  }
  return value;
};

export const normalizeShapeKey = (shapeKeyOrValue) => {
  if (typeof shapeKeyOrValue === 'string') {
    try { return JSON.stringify(stableShapeValue(JSON.parse(shapeKeyOrValue))); } catch { return shapeKeyOrValue; }
  }
  return JSON.stringify(stableShapeValue(shapeKeyOrValue || {}));
};

export const missionShapeKeyFor = (mission = {}, matrix = {}) => normalizeShapeKey(mission.upstream?.case || matrix?.shape || {
  correctnessCases: matrix?.correctnessCases || 24,
});

export const baselineKindForSource = (source = null) => {
  if (!source || typeof source !== 'object') return 'pytorch_reference';
  return source.authority === 'generated' || source.type === 'naive_v0' || source.kind === 'naive_v0'
    ? 'naive_v0'
    : 'pytorch_reference';
};

export const selectResearchBaselineSource = (researchNotes = [], mission = {}, body = {}) => {
  const requestedOperator = String(body.operator || mission.operator || mission.title || mission.goal || '').trim().toLowerCase();
  const excludedSources = new Set((body.excludedSources || mission.baseline?.rejectedSources || []).map((source) => [source.repository, source.commit, source.path].filter(Boolean).join('@')));
  const candidates = (Array.isArray(researchNotes) ? researchNotes : [])
    .flatMap((note) => (Array.isArray(note?.baselineSources) ? note.baselineSources : []).map((source) => ({ ...source, noteId: note.id, runId: note.runId })))
    .filter((source) => source && source.repository && source.commit && source.path)
    .filter((source) => !excludedSources.has([source.repository, source.commit, source.path].join('@')))
    .filter((source) => source.authority !== 'generated' && source.type !== 'naive_v0' && source.kind !== 'naive_v0');
  if (!candidates.length) return null;
  const score = (source) => {
    const confidence = String(source.confidence || '').toLowerCase();
    const operator = String(source.operator || source.path || '').toLowerCase();
    return (confidence === 'high' ? 30 : confidence === 'medium' ? 20 : 10)
      + (requestedOperator && operator.includes(requestedOperator) ? 20 : 0)
      + (source.expandedSingleFile === true ? 5 : 0);
  };
  return candidates.sort((left, right) => score(right) - score(left))[0] || null;
};

export const inferAuthoritativeBaselineSource = (mission = {}, body = {}) => {
  const text = [
    mission.title,
    mission.goal,
    mission.metric,
    mission.operator,
    body.operator,
    body.goal,
    body.reason,
    body.summary,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!/flashinfer/.test(text)) return null;
  const common = {
    authority: 'upstream',
    kind: 'pytorch_reference',
    repository: 'https://github.com/flashinfer-ai/flashinfer',
    // 固定到本项目 Source Registry 中已存在并验证过的 FlashInfer 快照；不是生成来源。
    commit: 'f479fe2817e2f927e2778d8b1c6033beed8477c1',
    license: null,
    expandedSingleFile: false,
    confidence: 'medium',
  };
  if (/prefill/.test(text)) {
    return {
      ...common,
      path: 'include/flashinfer/attention/prefill.cuh',
      operator: 'BatchPrefillWithPagedKVCache',
      reason: 'Mission 指向 FlashInfer paged prefill；使用 FlashInfer 上游 attention/prefill.cuh 作为权威语义来源，再由 materializer 展开为单文件 PyTorch reference。',
    };
  }
  if (/paged[_\s-]*(decode|attention)|batchdecode|decode/.test(text)) {
    return {
      ...common,
      path: 'include/flashinfer/attention/decode.cuh',
      operator: 'BatchDecodeWithPagedKVCache',
      reason: 'Mission 指向 FlashInfer paged attention/decode；使用 FlashInfer 上游 attention/decode.cuh 作为权威语义来源，再由 materializer 展开为单文件 PyTorch reference。',
    };
  }
  return null;
};

export const normalizeBaselineSource = (input = {}, body = {}) => {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const baselineKind = normalizeBaselineKind(body.baselineKind || body.kind || source.kind);
  const repository = String(source.repository || source.repo || source.url || '').trim();
  const commit = String(source.commit || source.revision || source.ref || '').trim();
  const sourcePath = String(source.path || source.file || source.entry || '').trim();
  const operator = String(source.operator || body.operator || '').trim();
  const authority = String(source.authority || source.type || 'upstream').trim();
  const expandedSingleFile = source.expandedSingleFile === true
    || source.singleFileExpanded === true
    || body.expandedSingleFile === true
    || body.singleFileExpanded === true
    || Boolean(body.runPy || body.operatorScript);

  if (baselineKind === 'naive_v0') {
    return {
      authority: 'generated',
      kind: 'naive_v0',
      type: 'naive_v0',
      repository: repository || String(body.repository || body.missionRepository || '').trim() || 'mission-workspace',
      commit: commit || 'v0',
      path: sourcePath.replaceAll('\\', '/') || `generated/${operator || 'operator'}/naive_v0/run.py`,
      operator: operator || null,
      license: source.license || null,
      expandedSingleFile: true,
      basedOn: String(source.basedOn || source.basis || body.baselineBasis || 'v0').trim() || 'v0',
    };
  }

  if (!repository || !commit || !sourcePath) return null;
  return {
    authority,
    kind: baselineKind,
    repository,
    commit,
    path: sourcePath.replaceAll('\\', '/'),
    operator: operator || null,
    license: source.license || null,
    expandedSingleFile,
  };
};

export const requireTrustedBaselineSource = (body = {}, mission = {}) => {
  const sourceHint = body.baselineSource
    || body.source
    || body.upstreamBaseline
    || mission.baseline?.source
    || mission.upstream?.baselineSource
    || mission.upstream?.reference
    || null;
  const source = normalizeBaselineSource(sourceHint, body);
  if (!source) {
    const error = new Error('Baseline 来源缺失，无法生成 baseline 元数据。');
    error.status = 400;
    error.code = 'BASELINE_SOURCE_REQUIRED';
    throw error;
  }

  const baselineKind = normalizeBaselineKind(body.baselineKind || body.kind || source.kind);
  if (baselineKind === 'naive_v0') {
    if (source.authority !== 'generated' || source.basedOn !== 'v0' || source.expandedSingleFile !== true) {
      const error = new Error('naive_v0 baseline 必须显式标注为 generated，并声明基于 v0 的单文件展开版本。');
      error.status = 400;
      error.code = 'BASELINE_NAIVE_SOURCE_REQUIRED';
      throw error;
    }
    return source;
  }

  if (source.authority === 'generated' || source.authority === 'synthetic') {
    const error = new Error('Baseline 来源不能是自动生成脚本，必须来自权威算子库或固定上游引用。');
    error.status = 400;
    error.code = 'BASELINE_SOURCE_NOT_AUTHORITATIVE';
    throw error;
  }
  if (source.expandedSingleFile !== true && body.allowUnmaterializedSource !== true) {
    const error = new Error('Baseline run.py 必须是权威上游 reference 的单文件展开版本。');
    error.status = 400;
    error.code = 'BASELINE_SINGLE_FILE_EXPANSION_REQUIRED';
    throw error;
  }
  return source;
};

export const baselineSourceTrusted = (baseline = {}, baselineEvidence = {}) => {
  if (baseline.required === false) return true;
  const policy = baseline.sourcePolicy || { requireAuthority: true, requireSingleFileExpansion: true };
  const source = baselineEvidence.source || baseline.source || null;
  if (!source) return policy.requireAuthority === false && policy.requireSingleFileExpansion === false;

  const singleFileExpanded = source.expandedSingleFile === true;
  const baselineKind = normalizeBaselineKind(baselineEvidence.kind || baseline.kind);
  if (baselineKind === 'naive_v0' || source.kind === 'naive_v0' || source.type === 'naive_v0' || source.authority === 'generated' || source.authority === 'synthetic') {
    const basis = String(source.basedOn || source.basis || source.version || source.commit || '').trim().toLowerCase();
    const generatedMarker = Boolean(source.authority === 'generated' || source.type === 'naive_v0' || source.kind === 'naive_v0');
    const basisMatch = ['v0', 'naive_v0', 'baseline-v0'].includes(basis);
    return generatedMarker && basisMatch && (policy.requireSingleFileExpansion === false || singleFileExpanded);
  }

  const hasAuthority = Boolean(source.repository && source.commit && source.path)
    && source.authority !== 'generated'
    && source.authority !== 'synthetic'
    && source.type !== 'generated';
  return (policy.requireAuthority === false || hasAuthority)
    && (policy.requireSingleFileExpansion === false || singleFileExpanded);
};

export const baselineMatchesMatrix = (baseline = {}, mission = {}, matrix = {}) => {
  if (baseline.required === false) return true;
  const evidence = baseline.evidence || null;
  const baselineKind = normalizeBaselineKind(baseline.kind || evidence?.kind || 'pytorch_reference');
  if (baseline.status !== 'complete' || !evidence || evidence.kind !== baselineKind) return false;
  if (!baselineSourceTrusted(baseline, evidence)) return false;
  if (normalizeShapeKey(evidence.shapeKey) !== missionShapeKeyFor(mission, matrix)) return false;
  const requestedEnvironments = Array.isArray(matrix.environments) && matrix.environments.length
    ? matrix.environments
    : (Array.isArray(mission.hardware) ? mission.hardware : []);
  return requestedEnvironments.some((environment) => runnerMatches(evidence.environment, environment));
};

export const buildNaiveBaselineRunPy = (mission = {}, body = {}) => {
  const operator = String(body.operator || mission.operator || mission.title || 'operator').trim();
  const comment = JSON.stringify({
    mission: mission.id || null,
    operator,
    mode: 'naive_v0',
    note: 'Generated fallback baseline derived from v0 when authoritative upstream reference is unavailable.',
  }, null, 2);
  return [
    '# Auto-generated naive_v0 baseline',
    `# ${comment.split('\n').join('\n# ')}`,
    '',
    'def get_inputs():',
    '    import torch',
    '    if not torch.cuda.is_available():',
    '        raise RuntimeError("The accelerator is not available through torch.cuda")',
    '    device = torch.device("cuda")',
    '    element_count = 1_024',
    '    return {',
    '        "left": torch.arange(element_count, dtype=torch.float32, device=device),',
    '        "right": torch.ones(element_count, dtype=torch.float32, device=device),',
    '    }',
    '',
    'def run(inputs):',
    '    return inputs["left"] + inputs["right"]',
    '',
    'def reference(inputs):',
    '    return inputs["left"] + inputs["right"]',
    '',
  ].join('\n');
};

export async function resolveBaselineRunPlan({ state = {}, mission = {}, body = {}, matrix = {}, readMissionRunPy } = {}) {
  const strictZeroSource = isStrictZeroSourceMission(mission, body);
  const materializerResult = body.materializerResult
    || body.baselineMaterialization
    || state.baseline?.materializer?.result
    || null;
  const sourceHint = body.baselineSource
    || body.source
    || body.upstreamBaseline
    || materializerResult?.source
    || state.baseline?.materializer?.source
    || state.baseline?.source
    || mission.baseline?.source
    || mission.upstream?.baselineSource
    || mission.upstream?.reference
    || selectResearchBaselineSource(state.researchNotes, mission, body)
    || (strictZeroSource ? null : inferAuthoritativeBaselineSource(mission, body))
    || null;
  const inferredBaselineKind = baselineKindForSource(sourceHint);
  const baselineKind = normalizeBaselineKind(body.baselineKind || body.testBaselineKind || inferredBaselineKind);
  const requestRunPy = body.runPy || body.operatorScript || null;
  if (strictZeroSource && baselineKind === 'naive_v0') {
    const error = new Error('Strict zero-source Mission 禁止 naive_v0 baseline；必须由 Research Agent 和 Baseline Materializer Agent 从零建立权威 baseline。');
    error.status = 409;
    error.code = 'STRICT_ZERO_SOURCE_NAIVE_BASELINE_FORBIDDEN';
    throw error;
  }
  if (strictZeroSource && requestRunPy) {
    const error = new Error('Strict zero-source Mission 禁止直接注入 baseline run.py；必须使用 Baseline Materializer Agent 的结果。');
    error.status = 409;
    error.code = 'STRICT_ZERO_SOURCE_BASELINE_INJECTION_FORBIDDEN';
    throw error;
  }
  let baselineSource;
  let missionRunPy;
  let materializationReport = null;
  if (baselineKind === 'naive_v0') {
    baselineSource = requireTrustedBaselineSource({ ...body, baselineKind, baselineSource: sourceHint }, mission);
    const generatedNaiveRunPy = !requestRunPy ? buildNaiveBaselineRunPy(mission, body) : null;
    missionRunPy = requestRunPy
      ? { content: requestRunPy, source: body.runPy ? 'request.runPy' : 'request.operatorScript' }
      : { content: generatedNaiveRunPy, source: 'generated.naive_v0' };
  } else {
    const sourceCandidate = requireTrustedBaselineSource({ ...body, baselineKind, baselineSource: sourceHint, allowUnmaterializedSource: true }, mission);
    const materialized = materializeBaselineSource({ mission, source: sourceCandidate, matrix, body: { ...body, materializerResult, strictZeroSource } });
    baselineSource = requireTrustedBaselineSource({ ...body, baselineKind, baselineSource: materialized.source, runPy: materialized.runPy }, mission);
    missionRunPy = { content: materialized.runPy, source: materialized.runPySource };
    materializationReport = materialized.report;
  }
  if (!missionRunPy?.content) {
    const error = new Error('Baseline materializer 未生成单文件 run.py。');
    error.status = 422;
    error.code = 'BASELINE_MATERIALIZER_EMPTY';
    throw error;
  }

  return {
    baselineKind,
    baselineSource,
    candidateId: body.candidate || (baselineKind === 'naive_v0' ? 'baseline-naive-v0' : 'baseline-pytorch-reference'),
    digestSeed: body.runPy || body.operatorScript || (baselineKind === 'naive_v0' ? 'generated-naive-v0' : ''),
    runPy: missionRunPy?.content || null,
    runPySource: missionRunPy?.source || null,
    materializationReport,
    resolution: {
      status: 'running',
      strategy: baselineKind === 'naive_v0' ? 'fallback_naive_v0' : 'authoritative_first',
      kind: baselineKind,
      attemptedAuthority: baselineKind !== 'naive_v0',
      reused: false,
      reason: baselineKind === 'naive_v0' ? '权威 baseline 不可用，使用 v0 fallback。' : '正在执行权威 baseline。',
      resolvedAt: null,
      previousEvidenceRunId: null,
    },
    matrixShapeKey: missionShapeKeyFor(mission, matrix),
  };
}
