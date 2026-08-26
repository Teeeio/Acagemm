const eventText = (event = {}) => event?.text
  || event?.message
  || event?.item?.text
  || event?.item?.aggregated_output
  || event?.item?.output
  || event?.item?.content
  || '';

const agentMessages = (events = []) => events
  .filter((event) => event?.item?.type === 'agent_message' || /agent_message|message.completed/i.test(event?.type || ''))
  .map(eventText)
  .filter(Boolean);

const tryParseJson = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidates = [text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.unshift(fenced[1]);
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* Plain-text Agent output is a supported fallback. */ }
  }
  return null;
};

const normalizeCandidate = (candidate, index, source = 'codex-agent') => {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = String(candidate.id || `agent-candidate-${String(index + 1).padStart(2, '0')}`);
  return {
    id,
    version: candidate.version || `agent.${index + 1}`,
    label: candidate.label || candidate.title || `Agent Candidate ${index + 1}`,
    title: candidate.title || candidate.label || `Agent Candidate ${index + 1}`,
    hypothesis: candidate.hypothesis || candidate.summary || candidate.rationale || 'Agent 已提出候选优化方向。',
    change: candidate.change || candidate.patch || candidate.proposedChange || '待生成受控 Patch。',
    files: Array.isArray(candidate.files) ? candidate.files.join(', ') : (candidate.files || '待识别'),
    status: candidate.status || '待验证',
    classification: candidate.classification || 'weak_candidate',
    acceptGate: candidate.acceptGate || { passed: false, result: 'pending', checks: [] },
    c500: Number.isFinite(candidate.c500) ? candidate.c500 : null,
    cuda: Number.isFinite(candidate.cuda) ? candidate.cuda : null,
    correctness: candidate.correctness || 'pending',
    decision: candidate.decision || 'pending',
    decisionReason: candidate.decisionReason || candidate.reason || '',
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
    knowledge: candidate.knowledge || null,
    sourceReferences: Array.isArray(candidate.sourceReferences) ? candidate.sourceReferences.map((reference) => ({
      repository: String(reference.repository || reference.url || '').trim(),
      commit: String(reference.commit || reference.revision || '').trim(),
      path: String(reference.path || '').trim(),
    })).filter((reference) => reference.repository || reference.path) : [],
    tone: candidate.tone || (candidate.classification === 'accepted' ? 'green' : 'blue'),
    source,
  };
};

export function parseAgentResult(events = []) {
  const messages = agentMessages(events);
  const finalText = messages.at(-1) || '';
  const parsed = tryParseJson(finalText);
  const rawCandidates = parsed?.candidates || parsed?.candidatePlan?.candidates || [];
  const source = events.some((event) => event?.provider === 'claude-code') ? 'claude-agent' : 'codex-agent';
  const candidates = Array.isArray(rawCandidates) ? rawCandidates.map((candidate, index) => normalizeCandidate(candidate, index, source)).filter(Boolean) : [];
  const proposedNextAction = parsed?.nextAction || parsed?.next_action || (candidates.length ? {
    type: 'candidate.plan',
    title: '执行 Candidate Plan',
    reason: 'Agent 已返回结构化候选，可在隔离 Mission 工作区继续生成 Patch。',
    expectedOutput: `${candidates.length} 个候选 · Accept Gate · 受控 Patch`,
    risk: 'medium',
    approvalRequired: false,
  } : null);
  const nextAction = proposedNextAction ? {
    ...proposedNextAction,
    approvalRequired: false,
    approvalPolicy: 'client-controlled',
  } : null;
  return {
    schemaVersion: parsed?.schemaVersion || parsed?.schema_version || 'operator-studio.agent-result/v1',
    format: parsed ? 'structured-json' : 'text-fallback',
    summary: parsed?.summary || parsed?.diagnosis?.summary || finalText || 'Agent 未返回最终摘要。',
    diagnosis: parsed?.diagnosis || null,
    candidates,
    recommendedCandidate: parsed?.recommendedCandidate || parsed?.recommended_candidate || null,
    nextAction,
    risks: Array.isArray(parsed?.risks) ? parsed.risks : [],
    sourceReferences: Array.isArray(parsed?.sourceReferences) ? parsed.sourceReferences : [],
    rawText: finalText.slice(0, 8_000),
  };
}

// 研究员子 Agent 的结果解析：产出调研笔记（findings / suggestedDirections / sources），
// 结构必须避开 candidates 字段，确保研究产物永远不会进入候选验证路径。
export function parseResearchResult(events = []) {
  const messages = agentMessages(events);
  const finalText = messages.at(-1) || '';
  const parsed = tryParseJson(finalText);
  const notes = parsed?.notes || parsed?.researchNotes || [];
  const findings = Array.isArray(parsed?.findings) ? parsed.findings.map(String) : [];
  const suggestedDirections = Array.isArray(parsed?.suggestedDirections) ? parsed.suggestedDirections.map(String) : [];
  const sources = Array.isArray(parsed?.sources) ? parsed.sources.map((source) => ({
    title: String(source?.title || source?.name || '').trim(),
    url: String(source?.url || source?.link || source?.repository || '').trim(),
    type: String(source?.type || 'reference').trim(),
  })).filter((source) => source.title || source.url) : [];
  const baselineSources = Array.isArray(parsed?.baselineSources) ? parsed.baselineSources.map((source) => ({
    authority: String(source?.authority || source?.type || 'upstream').trim(),
    repository: String(source?.repository || source?.repo || source?.url || '').trim(),
    commit: String(source?.commit || source?.revision || source?.ref || '').trim(),
    path: String(source?.path || source?.file || source?.entry || '').trim(),
    operator: String(source?.operator || '').trim(),
    license: source?.license || null,
    expandedSingleFile: source?.expandedSingleFile === true || source?.singleFileExpanded === true,
    confidence: String(source?.confidence || '').trim(),
    reason: String(source?.reason || source?.rationale || '').trim(),
    semanticFallback: source?.semanticFallback === true,
    semanticSpec: source?.semanticSpec || null,
  })).filter((source) => source.repository && source.commit && source.path) : [];
  const semanticSpec = parsed?.semanticBaseline && typeof parsed.semanticBaseline === 'object' && !Array.isArray(parsed.semanticBaseline)
    ? parsed.semanticBaseline
    : null;
  if (!baselineSources.length && semanticSpec) {
    baselineSources.push({
      authority: 'agent-semantic',
      kind: 'pytorch_reference',
      repository: 'mission-semantic-baseline',
      commit: 'agent-semantic-v1',
      path: 'generated/semantic-reference/run.py',
      operator: String(semanticSpec.operator || '').trim(),
      license: null,
      expandedSingleFile: false,
      confidence: 'low',
      reason: String(semanticSpec.reason || 'No usable local or remote source was available; derive a baseline from Mission semantics.').trim(),
      semanticFallback: true,
      semanticSpec,
    });
  }
  const structured = parsed || notes.length || findings.length || suggestedDirections.length || sources.length || baselineSources.length;
  return {
    schemaVersion: parsed?.schemaVersion || 'operator-studio.research-notes/v1',
    format: structured ? 'structured-json' : 'text-fallback',
    summary: parsed?.summary || finalText || '研究员未返回摘要。',
    findings,
    suggestedDirections,
    sources,
    baselineSources,
    notes: notes.map(String),
    rawText: finalText.slice(0, 8_000),
  };
}

export function parseBaselineMaterializerResult(events = []) {
  const messages = agentMessages(events);
  const finalText = messages.at(-1) || '';
  const parsed = tryParseJson(finalText);
  const report = parsed && typeof parsed.report === 'object' && !Array.isArray(parsed.report) ? parsed.report : null;
  const runPy = typeof parsed?.runPy === 'string' ? parsed.runPy : '';
  return {
    schemaVersion: parsed?.schemaVersion || parsed?.schema_version || 'operator-studio.baseline-materializer-result/v1',
    format: parsed ? 'structured-json' : 'text-fallback',
    summary: parsed?.summary || report?.summary || finalText || 'Baseline materializer 未返回摘要。',
    runPy,
    report,
    rawText: finalText.slice(0, 8_000),
  };
}
