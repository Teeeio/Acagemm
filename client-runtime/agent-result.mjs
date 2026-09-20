import { classifyParsedCandidateGeneration } from './candidate-generation/classification.mjs';

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

// ---------------------------------------------------------------------------
// 研究员结果定位（§4.1）
//
// 这里把「结果提取」与「schema/来源策略验证」拆开：本段只负责按消息角色与阶段 schema
// 定位研究员的正式结果，返回明确诊断；验证仍由调用方（agent-runtime 的来源采集与投影）
// 严格执行，不因为提取成功就放宽任何来源约束。
//
// 明确禁止的两件事：
//  1. 取「最后一条能 JSON.parse 的事件」——工具事件同样能 parse，会把工具输出当成研究员结论。
//  2. 从任意工具输出里捞长相相似的 JSON 冒充正式结果。
// 因此消息候选只来自 agent_message 角色事件（provider adapter 已归一化该角色），
// 且候选必须满足当前阶段声明的 schema。
// ---------------------------------------------------------------------------

export const RESEARCH_RESULT_REASONS = Object.freeze({
  NOT_FOUND: 'RESEARCH_RESULT_NOT_FOUND',
  JSON_EXTRACT_FAILED: 'RESEARCH_JSON_EXTRACT_FAILED',
  SCHEMA_MISMATCH: 'RESEARCH_SCHEMA_MISMATCH',
  AMBIGUOUS: 'RESEARCH_RESULT_AMBIGUOUS',
  RUN_MISMATCH: 'RESEARCH_RUN_MISMATCH',
});

// 工具/命令事件：绝不参与研究员正式结果的候选。provider adapter 把工具调用归一化为
// command_execution / function_call / tool_call 等，它们的输出可能恰好是 JSON。
const TOOL_EVENT_TYPES = new Set([
  'command_execution', 'function_call', 'tool_call', 'tool_result', 'local_shell_call',
  'file_change', 'patch', 'command', 'shell', 'mcp_tool_call', 'web_search_call',
]);

const isAgentMessageEvent = (event = {}) => {
  const itemType = typeof event?.item?.type === 'string' ? event.item.type.toLowerCase() : '';
  if (TOOL_EVENT_TYPES.has(itemType)) return false;
  if (itemType === 'agent_message') return true;
  const type = typeof event?.type === 'string' ? event.type.toLowerCase() : '';
  if (!type || TOOL_EVENT_TYPES.has(type)) return false;
  if (type === 'agent_message' || type === 'assistant_message') return true;
  return type.includes('message.completed') || type.includes('agent_message');
};

// 只读文本字段；不读 output/aggregated_output/command 等工具字段。
const agentMessageText = (event = {}) => String(
  event?.item?.text || event?.text || event?.message?.text || event?.item?.content || '',
).trim();

export const agentMessageTexts = (events = []) => (Array.isArray(events) ? events : [])
  .filter(isAgentMessageEvent)
  .map(agentMessageText)
  .filter(Boolean);

// 平衡花括号扫描：只返回顶层对象，正确跳过字符串与转义。
const objectSpans = (text) => {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth += 1; continue; }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { spans.push([start, index + 1]); start = -1; }
      else if (depth < 0) { depth = 0; start = -1; }
    }
  }
  return spans;
};

const isPlainObjectValue = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stableValue = (value) => JSON.stringify(value, (_key, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item
));

// 「仅修格式」的确定性修复（§4.2）：剥代码围栏、剥 JSON 前后的说明文字、取第一个完整对象。
// 不做语义补全、不重试搜索、不虚构 URL、不追加证据；最多一次，且计入同一研究预算（本地计算，无模型调用）。
export const repairResearchFormatting = (text) => {
  const raw = String(text || '');
  const repaired = [];
  const push = (value, source) => {
    const trimmed = String(value || '').trim();
    if (trimmed && !repaired.some((entry) => entry.text === trimmed)) repaired.push({ text: trimmed, source });
  };
  const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
  push(withoutFences, 'fence-stripped');
  for (const [start, end] of objectSpans(withoutFences)) push(withoutFences.slice(start, end), 'embedded-object');
  return repaired;
};

// 按阶段声明可接受的 schemaVersion 族与结构。阶段不匹配即拒绝，绝不猜测。
const NOTES_VERSION = /^operator-studio\.research-notes\//u;
const ACQUISITION_VERSION = /^operator-studio\.source-acquisition\//u;

const declaredVersionFailure = (value, accepted) => {
  const version = typeof value?.schemaVersion === 'string' ? value.schemaVersion : null;
  if (!version) return null;
  return accepted.test(version) ? null : `声明的 schemaVersion 不属于当前阶段：${version}`;
};

const notesShape = (value) => {
  const versionFailure = declaredVersionFailure(value, NOTES_VERSION);
  if (versionFailure) return { ok: false, reason: versionFailure };
  const hasSummary = typeof value?.summary === 'string' && value.summary.trim().length > 0;
  const hasList = Array.isArray(value?.findings) || Array.isArray(value?.suggestedDirections) || Array.isArray(value?.notes);
  const hasBaseline = Array.isArray(value?.baselineSources) || isPlainObjectValue(value?.semanticBaseline);
  const hasAdvisory = isPlainObjectValue(value?.advisory);
  const hasSources = Array.isArray(value?.sources);
  if (!hasSummary && !hasList && !hasBaseline && !hasAdvisory && !hasSources) {
    return { ok: false, reason: '缺少 research-notes 必需字段（summary/findings/suggestedDirections/advisory/sources/baselineSources）' };
  }
  return { ok: true };
};

const acquisitionShape = (value) => {
  const versionFailure = declaredVersionFailure(value, ACQUISITION_VERSION);
  if (versionFailure) return { ok: false, reason: versionFailure };
  const acquisition = value?.sourceAcquisition;
  if (!isPlainObjectValue(acquisition)) return { ok: false, reason: '缺少 sourceAcquisition 对象' };
  if (!Array.isArray(acquisition.repositories)) return { ok: false, reason: 'sourceAcquisition.repositories 必须是数组' };
  return { ok: true };
};

const SCHEMA_BY_PHASE = Object.freeze({
  advisory: notesShape,
  experience: notesShape,
  synthesize: notesShape,
  acquire: acquisitionShape,
  // 兼容默认：调用方未显式声明阶段时使用通用笔记 schema。生产路径必须传真实阶段，
  // 只有历史调用点与单测才会落到这里。
  notes: notesShape,
});

export const researchSchemaMatches = (phase, value) => {
  const shape = SCHEMA_BY_PHASE[phase];
  if (!shape) return { ok: false, reason: `未知研究阶段：${String(phase)}` };
  if (!isPlainObjectValue(value)) return { ok: false, reason: '结果不是 JSON 对象' };
  return shape(value);
};

// 脱敏截断摘要：日志需要可定位，但绝不泄露密钥或完整敏感输出。
export const redactExcerpt = (value, max = 400) => String(value || '')
  .replace(/\b(?:sk|ghp|gho|glpat|xox[baprs])-?[A-Za-z0-9_-]{12,}/gu, '[redacted-token]')
  .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/giu, 'Bearer [redacted]')
  .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, (match) => `${match.split(/[:=]/u)[0]}=[redacted]`)
  .slice(0, max);

// 从候选文本中提取所有可解析的顶层对象。
const extractObjects = (text) => {
  const found = [];
  const push = (value, source) => {
    if (!isPlainObjectValue(value)) return;
    const key = stableValue(value);
    if (!found.some((entry) => entry.key === key)) found.push({ key, value, source });
  };
  const trimmed = String(text || '').trim();
  if (!trimmed) return found;
  const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1]);
  for (const block of fencedBlocks) {
    try { push(JSON.parse(block.trim()), 'fenced'); } catch { /* 继续尝试其它形式 */ }
    for (const [start, end] of objectSpans(block)) {
      try { push(JSON.parse(block.slice(start, end)), 'fenced-embedded'); } catch { /* 继续 */ }
    }
  }
  try { push(JSON.parse(trimmed), 'bare'); } catch { /* 继续 */ }
  for (const [start, end] of objectSpans(trimmed)) {
    try { push(JSON.parse(trimmed.slice(start, end)), 'embedded'); } catch { /* 继续 */ }
  }
  for (const repaired of repairResearchFormatting(trimmed)) {
    try { push(JSON.parse(repaired.text), repaired.source); } catch { /* 继续 */ }
  }
  return found;
};

// 研究员正式结果定位。返回 { result, format, reasonCode, reason, diagnostics }，
// 绝不抛错——调用方按 reasonCode 决定如何降级或报错。
export function extractResearchResult(events = [], { phase = null, runId = null, schema = null } = {}) {
  if (!phase || !SCHEMA_BY_PHASE[phase]) {
    return {
      result: null, format: 'unavailable', reasonCode: RESEARCH_RESULT_REASONS.NOT_FOUND,
      reason: `提取研究员结果必须显式声明已支持的阶段，收到：${String(phase)}`,
      diagnostics: { phase: phase ?? null, messageCount: 0, candidateCount: 0, rejected: [] },
    };
  }
  const matches = typeof schema === 'function' ? schema : (value) => researchSchemaMatches(phase, value);
  const list = Array.isArray(events) ? events : [];
  const messages = list.filter(isAgentMessageEvent);
  const texts = messages.map(agentMessageText).filter(Boolean);
  const diagnostics = { phase, runId: runId ?? null, messageCount: messages.length, candidateCount: 0, rejected: [] };
  if (!texts.length) {
    return { result: null, format: 'unavailable', reasonCode: RESEARCH_RESULT_REASONS.NOT_FOUND, reason: '运行事件中没有研究员消息（agent_message）。', diagnostics };
  }
  let sawJson = false;
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index];
    const objects = extractObjects(text);
    if (objects.length) sawJson = true;
    const accepted = objects.filter((entry) => {
      const verdict = matches(entry.value);
      if (!verdict.ok) {
        diagnostics.rejected.push({ messageIndex: index, source: entry.source, reason: verdict.reason });
        return false;
      }
      if (runId && typeof entry.value.researchRunId === 'string' && entry.value.researchRunId !== runId) {
        diagnostics.rejected.push({ messageIndex: index, source: entry.source, reason: '结果声明的 researchRunId 不属于本次运行', runMismatch: true });
        return false;
      }
      return true;
    });
    if (!accepted.length) continue;
    if (accepted.length > 1) {
      return {
        result: null, format: 'ambiguous', reasonCode: RESEARCH_RESULT_REASONS.AMBIGUOUS,
        reason: `最新研究员消息中存在 ${accepted.length} 个互相冲突的候选结果，无法唯一确定正式结果。`,
        diagnostics: { ...diagnostics, candidateCount: accepted.length },
      };
    }
    return {
      result: accepted[0].value, format: 'structured-json', reasonCode: null, reason: null,
      diagnostics: { ...diagnostics, candidateCount: 1, matchedMessageIndex: index, matchedSource: accepted[0].source },
    };
  }
  const runMismatchOnly = sawJson
    && diagnostics.rejected.some((entry) => entry.runMismatch === true)
    && diagnostics.rejected.every((entry) => entry.runMismatch === true);
  const reasonCode = runMismatchOnly
    ? RESEARCH_RESULT_REASONS.RUN_MISMATCH
    : sawJson ? RESEARCH_RESULT_REASONS.SCHEMA_MISMATCH : RESEARCH_RESULT_REASONS.JSON_EXTRACT_FAILED;
  const reason = runMismatchOnly
    ? '研究员结果声明的 researchRunId 不属于本次研究运行。'
    : sawJson
      ? `研究员消息中包含 JSON，但没有一个满足 ${phase} 阶段声明的 schema。`
      : '研究员消息中没有可解析的 JSON 对象。';
  return { result: null, format: sawJson ? 'schema-mismatch' : 'text-fallback', reasonCode, reason, diagnostics };
}

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
    c550: Number.isFinite(candidate.c550) ? candidate.c550 : (Number.isFinite(candidate.c500) ? candidate.c500 : null),
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
  // 用 ?? 而不是 ||：显式声明的 null / 0 / '' 也是「声明过」，必须如实记录，不能
  // 悄悄回落到候选计划字段。类型不是数组时同样记录，不再静默地当成空数组——那正是
  // 「候选去哪了」这个问题的第一手证据。
  const declaredCandidates = parsed?.candidates ?? parsed?.candidatePlan?.candidates ?? null;
  const rawCandidatesType = Array.isArray(declaredCandidates) ? 'array' : declaredCandidates == null ? 'absent' : 'non-array';
  const rawCandidateCount = rawCandidatesType === 'array' ? declaredCandidates.length : null;
  const source = events.some((event) => event?.provider === 'claude-code') ? 'claude-agent' : 'codex-agent';
  const candidates = Array.isArray(declaredCandidates) ? declaredCandidates.map((candidate, index) => normalizeCandidate(candidate, index, source)).filter(Boolean) : [];
  // 类型不可映射时数量未知：记 null，不伪造成 0。
  const droppedCandidateCount = rawCandidateCount === null ? null : rawCandidateCount - candidates.length;
  const format = parsed ? 'structured-json' : 'text-fallback';
  const patch = typeof parsed?.patch === 'string' ? parsed.patch : (typeof parsed?.unifiedDiff === 'string' ? parsed.unifiedDiff : null);
  const hasPatch = typeof patch === 'string' && patch.length > 0;
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
    format,
    summary: parsed?.summary || parsed?.diagnosis?.summary || finalText || 'Agent 未返回最终摘要。',
    diagnosis: parsed?.diagnosis || null,
    candidates,
    recommendedCandidate: parsed?.recommendedCandidate || parsed?.recommended_candidate || null,
    nextAction,
    risks: Array.isArray(parsed?.risks) ? parsed.risks : [],
    sourceReferences: Array.isArray(parsed?.sourceReferences) ? parsed.sourceReferences : [],
    patch,
    // 候选生成证据：声明了什么、映射丢了多少、有没有 patch、属于哪一类。
    // 纯观测，不参与任何准入判定——准入权威永远是工作区 Git Diff。
    candidateGeneration: {
      schemaVersion: 'operator-studio.candidate-generation/v1',
      format,
      rawCandidatesType,
      rawCandidateCount,
      normalizedCandidateCount: candidates.length,
      droppedCandidateCount,
      hasPatch,
      classification: classifyParsedCandidateGeneration({ format, rawCandidatesType, normalizedCandidateCount: candidates.length, droppedCandidateCount, hasPatch }),
    },
    rawText: finalText.slice(0, 8_000),
  };
}

// 研究员与基线物化结果的解析保持原样：它们的产物结构必须永远避开 candidates，
// 这是「研究产物不得进入候选验证路径」的第一道闸。

// 研究员子 Agent 的结果解析：产出调研笔记（findings / suggestedDirections / sources），
// 结构必须避开 candidates 字段，确保研究产物永远不会进入候选验证路径。
//
// 提取与验证已分离：这里调用 extractResearchResult 定位正式结果（按消息角色 + 阶段 schema），
// 提取失败时返回明确 reasonCode，而不是把工具输出或最后一条侥幸可 parse 的 JSON 当成结论。
export function parseResearchResult(events = [], { phase = 'notes', runId = null } = {}) {
  const extraction = extractResearchResult(events, { phase, runId });
  const parsed = extraction.result;
  const texts = agentMessageTexts(events);
  const finalText = texts.at(-1) || '';
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
  const advisory = normalizeAdvisory(parsed?.advisory);
  // 结果状态与「有没有材料」是两件事：结构化成功不等于有可用建议，纯故障叙述也不算结论。
  const outcome = parsed
    ? 'structured'
    : extraction.reasonCode === RESEARCH_RESULT_REASONS.SCHEMA_MISMATCH ? 'schema_mismatch'
      : extraction.reasonCode === RESEARCH_RESULT_REASONS.AMBIGUOUS ? 'ambiguous'
        : extraction.reasonCode === RESEARCH_RESULT_REASONS.RUN_MISMATCH ? 'run_mismatch'
          : 'no_result';
  const failureOnly = outcome !== 'structured'
    || (isTransportFailureText([parsed?.summary, ...findings, ...suggestedDirections].join(' '))
      && !findings.length && !suggestedDirections.length && !sources.length && !advisory);
  const structured = Boolean(parsed) || notes.length || findings.length || suggestedDirections.length || sources.length || baselineSources.length;
  const declaredRunId = typeof parsed?.researchRunId === 'string' ? parsed.researchRunId.trim() : null;
  return {
    schemaVersion: parsed?.schemaVersion || 'operator-studio.research-notes/v1',
    format: structured ? 'structured-json' : 'text-fallback',
    outcome,
    reasonCode: extraction.reasonCode,
    reason: extraction.reason,
    extraction: extraction.diagnostics,
    failureOnly,
    researchRunId: declaredRunId,
    summary: parsed?.summary || finalText || '研究员未返回摘要。',
    findings,
    suggestedDirections,
    sources,
    baselineSources,
    advisory,
    notes: notes.map(String),
    rawText: redactExcerpt(finalText, 8_000),
  };
}

// 建议材料的紧凑规范形状（§5.3）。只复用现有 schema 并做最小扩展：全部字段可选，
// 缺失即缺省，不伪造。返回 null 表示研究员没有给出可行动的建议。
export const ADVISORY_KEYS = Object.freeze(['problem', 'scope', 'evidence', 'hypothesis', 'nextChange', 'verification', 'stopCondition']);
export function normalizeAdvisory(value) {
  if (!isPlainObjectValue(value)) return null;
  const text = (item) => (typeof item === 'string' ? item.trim().slice(0, 2_000) : '');
  const listOf = (item) => (Array.isArray(item) ? item.map(text).filter(Boolean).slice(0, 16) : []);
  const scope = isPlainObjectValue(value.scope) ? {
    hardware: listOf(value.scope.hardware), dtype: listOf(value.scope.dtype),
    shape: listOf(value.scope.shape), operator: text(value.scope.operator) || null,
  } : null;
  const advisory = {
    problem: text(value.problem),
    scope,
    evidence: listOf(value.evidence),
    hypothesis: text(value.hypothesis),
    nextChange: text(value.nextChange),
    verification: text(value.verification),
    stopCondition: text(value.stopCondition),
  };
  const empty = !advisory.problem && !advisory.hypothesis && !advisory.nextChange
    && !advisory.verification && !advisory.stopCondition && !advisory.evidence.length;
  return empty ? null : advisory;
}

// 纯传输/认证失败的确定性词表。只用于判断「这条材料是否只是失败叙述」，
// 不作任何价值排序依据。
const TRANSPORT_FAILURE_PATTERNS = [
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH/iu,
  /\b(?:401|403|407|429|502|503|504)\b/u,
  /network error|socket hang up|connection (?:refused|reset)|dns (?:failure|error)/iu,
  /unauthori[sz]ed|authentication failed|invalid (?:api )?key|not logged in|credential/iu,
  /连接(?:被)?拒绝|网络(?:不可用|错误|超时)|认证失败|未登录|无访问权限|超时(?:未|无法)完成/iu,
];
export const isTransportFailureText = (value) => {
  const text = String(value || '');
  if (!text.trim()) return false;
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
};

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
