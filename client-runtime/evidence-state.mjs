export const createDecisionReviewState = (status = 'idle') => ({
  policy: {
    id: 'policy.decision.conditional-review',
    label: '条件式人工复核',
    version: 'v1.0',
    rule: '证据完整且无风险信号时按策略继续；人工意见或风险信号出现时阻塞。',
  },
  status,
  recommendation: status === 'auto_ready' || status === 'resolved' ? 'adopt' : null,
  requiresApproval: status === 'awaiting_review',
  signals: [
    { id: 'evidence-conflict', label: '证据冲突', value: '未发现', triggered: false },
    { id: 'cross-platform-regression', label: '跨平台回归', value: '0 个平台', triggered: false },
    { id: 'scope-expansion', label: '影响范围扩大', value: '否', triggered: false },
  ],
  request: null,
  resolution: status === 'resolved' ? { outcome: 'adopt', source: 'policy' } : null,
  requestedAt: null,
  resolvedAt: status === 'resolved' ? new Date().toISOString() : null,
});

export const normalizeBaselineKind = (kind = 'pytorch_reference') => (String(kind || '').trim() === 'naive_v0' ? 'naive_v0' : 'pytorch_reference');

export const createBaselineSourcePolicy = (kind = 'pytorch_reference', overrides = {}) => {
  const baselineKind = normalizeBaselineKind(kind);
  const defaults = baselineKind === 'naive_v0'
    ? { requireAuthority: false, requireSingleFileExpansion: true, allowGeneratedV0: true }
    : { requireAuthority: true, requireSingleFileExpansion: true, allowGeneratedV0: false };
  return { ...defaults, ...(overrides || {}) };
};

export const createBaselineResolutionState = (overrides = {}, kind = 'pytorch_reference') => {
  const baselineKind = normalizeBaselineKind(kind);
  return {
    status: overrides.status || (overrides.resolvedAt || overrides.source || overrides.evidence ? 'resolved' : 'unresolved'),
    strategy: overrides.strategy || 'authoritative_first',
    kind: normalizeBaselineKind(overrides.kind || baselineKind),
    attemptedAuthority: overrides.attemptedAuthority === true,
    reused: overrides.reused === true,
    reason: overrides.reason || (baselineKind === 'naive_v0' ? '权威算子库 baseline 不可用，使用基于 v0 的 naive baseline。' : '等待解析权威算子库 baseline。'),
    resolvedAt: overrides.resolvedAt || null,
    previousEvidenceRunId: overrides.previousEvidenceRunId || null,
  };
};

export const createBaselineRequirementState = (overrides = {}) => ({
  required: overrides.required ?? true,
  kind: normalizeBaselineKind(overrides.kind || 'pytorch_reference'),
  status: overrides.status || 'missing',
  description: overrides.description || '优化候选采用前，必须先在同一 runner、同一输入 shape 下运行当前有效 baseline；权威 reference 优先，找不到时允许基于 v0 的 naive 单文件 baseline。',
  sourcePolicy: createBaselineSourcePolicy(overrides.kind || 'pytorch_reference', overrides.sourcePolicy),
  resolution: createBaselineResolutionState(overrides.resolution || {}, overrides.kind || 'pytorch_reference'),
  source: overrides.source || null,
  evidence: overrides.evidence || null,
  materializer: overrides.materializer || null,
  oracleRunPy: overrides.oracleRunPy || overrides.materializer?.result?.runPy || null,
});
