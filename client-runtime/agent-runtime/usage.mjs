import { runtimeRegistry } from './registry.mjs';

const finite = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const first = (...values) => values.find((value) => value != null);

const rawFields = (raw = {}) => ({
  input: finite(first(raw.input_tokens, raw.inputTokens, raw.input, raw.tokens?.input)),
  output: finite(first(raw.output_tokens, raw.outputTokens, raw.output, raw.tokens?.output)),
  reasoning: finite(first(raw.reasoning_tokens, raw.reasoningTokens, raw.reasoning, raw.tokens?.reasoning)),
  cacheRead: finite(first(
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
    raw.cached_input_tokens,
    raw.input_tokens_details?.cached_tokens,
    raw.cache?.read,
    raw.tokens?.cache?.read,
  )),
  cacheWrite: finite(first(
    raw.cache_creation_input_tokens,
    raw.cacheWriteInputTokens,
    raw.cache_write_input_tokens,
    raw.cache?.write,
    raw.tokens?.cache?.write,
  )),
  total: finite(first(raw.total_tokens, raw.totalTokens, raw.total, raw.tokens?.total)),
});

const providerFamily = (provider = '') => {
  const declared = runtimeRegistry.get(provider)?.usageSemantics;
  if (declared) return declared;
  const value = String(provider).toLowerCase();
  if (value.includes('claude')) return 'anthropic';
  if (value.includes('opencode')) return 'opencode';
  if (value.includes('codex') || value.includes('openai')) return 'codex';
  return 'unknown';
};

export const emptyCanonicalUsage = (completeness = 'unavailable') => ({
  uncachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  providerReportedTotal: null,
  completeness,
  consistent: true,
});

export const normalizeProviderUsage = (provider, raw = null) => {
  if (!raw || typeof raw !== 'object') return { ...emptyCanonicalUsage(), provider: provider || 'unknown', raw: raw || null };
  const family = providerFamily(provider);
  const fields = rawFields(raw);
  let uncachedInputTokens = fields.input;
  let inputTokens = fields.input;
  let outputTokens = fields.output;

  if (family === 'anthropic') {
    inputTokens = fields.input + fields.cacheRead + fields.cacheWrite;
  } else if (family === 'opencode') {
    inputTokens = fields.input + fields.cacheRead + fields.cacheWrite;
    outputTokens = fields.output + fields.reasoning;
  } else {
    // Codex/OpenAI reports cached input as a subset of input_tokens.
    uncachedInputTokens = Math.max(0, fields.input - fields.cacheRead - fields.cacheWrite);
  }

  const calculatedTotal = inputTokens + outputTokens;
  const providerReportedTotal = fields.total > 0 ? fields.total : null;
  const consistent = providerReportedTotal == null || providerReportedTotal === calculatedTotal;
  return {
    provider: provider || 'unknown',
    uncachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens: fields.reasoning,
    cacheReadTokens: fields.cacheRead,
    cacheWriteTokens: fields.cacheWrite,
    totalTokens: calculatedTotal,
    providerReportedTotal,
    completeness: consistent ? 'exact' : 'inconsistent',
    consistent,
    raw: structuredClone(raw),
  };
};

const usageEventKey = (event, index) => event.usageId
  || event.eventId
  || event.id
  || event.item?.id
  || `${event.type || 'usage'}:${index}:${JSON.stringify(event.usage || {})}`;

const isTerminalUsageEvent = (event) => /^(?:turn|response|message|run)\.(?:completed|failed|cancelled)$/i.test(String(event?.type || ''));

export const usageSnapshotFromEvents = (events = [], provider = null) => {
  const seen = new Set();
  const usage = [];
  events.forEach((event, index) => {
    if (!event?.usage || !isTerminalUsageEvent(event)) return;
    const key = usageEventKey(event, index);
    if (seen.has(key)) return;
    seen.add(key);
    usage.push(normalizeProviderUsage(provider || event.provider, event.usage));
  });
  if (!usage.length) return { ...emptyCanonicalUsage(), provider: provider || 'unknown', raw: [] };
  const total = usage.reduce((sum, item) => {
    for (const key of ['uncachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
      sum[key] += finite(item[key]);
    }
    if (item.completeness === 'inconsistent') sum.completeness = 'inconsistent';
    sum.consistent &&= item.consistent;
    return sum;
  }, { ...emptyCanonicalUsage('exact'), provider: provider || usage[0].provider, raw: usage.map((item) => item.raw) });
  total.providerReportedTotal = usage.every((item) => item.providerReportedTotal != null)
    ? usage.reduce((sum, item) => sum + item.providerReportedTotal, 0)
    : null;
  return total;
};
