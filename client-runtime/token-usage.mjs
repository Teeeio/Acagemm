const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const emptyTokenUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  runs: {},
});

const normalizeUsageObject = (usage = {}) => {
  const inputTokens = number(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = number(usage.output_tokens ?? usage.outputTokens);
  const cacheReadTokens = number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.input_tokens_details?.cached_tokens);
  const cacheWriteTokens = number(usage.cache_creation_input_tokens ?? usage.cacheWriteInputTokens);
  const explicitTotal = number(usage.total_tokens ?? usage.totalTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
};

export const tokenUsageFromEvents = (events = []) => events.reduce((total, event) => {
  if (!event?.usage || event.type !== 'turn.completed') return total;
  const usage = normalizeUsageObject(event.usage);
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) total[key] += usage[key];
  return total;
}, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

export const recordRunTokenUsage = (state, { runId, phase, provider, events = [] } = {}) => {
  if (!runId) return state.tokenUsage || emptyTokenUsage();
  const usage = tokenUsageFromEvents(events);
  const current = state.tokenUsage && typeof state.tokenUsage === 'object' ? state.tokenUsage : emptyTokenUsage();
  const runs = { ...(current.runs || {}), [runId]: { runId, phase, provider, ...usage } };
  const totals = Object.values(runs).reduce((sum, item) => {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) sum[key] += number(item[key]);
    return sum;
  }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
  state.tokenUsage = { ...totals, runs };
  return state.tokenUsage;
};

export const formatTokenCount = (value) => {
  const count = number(value);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(count));
};
