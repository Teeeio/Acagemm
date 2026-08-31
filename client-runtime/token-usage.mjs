import { emptyCanonicalUsage, usageSnapshotFromEvents } from './agent-runtime/usage.mjs';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const totalKeys = ['uncachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const TOKEN_USAGE_SCHEMA = 'operator-studio.token-usage/v2';

export const emptyTokenUsage = () => ({
  schemaVersion: TOKEN_USAGE_SCHEMA,
  uncachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  trackedRuns: 0,
  exactRuns: 0,
  coverage: '0/0 runs exact',
  completeness: 'unavailable',
  runs: {},
});

const aggregateRuns = (runs = {}) => {
  const totals = Object.values(runs).reduce((sum, item) => {
    for (const key of totalKeys) sum[key] += number(item[key]);
    return sum;
  }, Object.fromEntries(totalKeys.map((key) => [key, 0])));
  const entries = Object.values(runs);
  const exactRuns = entries.filter((item) => item.completeness === 'exact').length;
  const inconsistentRuns = entries.filter((item) => item.completeness === 'inconsistent').length;
  const trackedRuns = entries.length;
  return {
    schemaVersion: TOKEN_USAGE_SCHEMA,
    ...totals,
    trackedRuns,
    exactRuns,
    coverage: `${exactRuns}/${trackedRuns} runs exact`,
    completeness: trackedRuns === 0
      ? 'unavailable'
      : inconsistentRuns > 0
        ? 'inconsistent'
        : exactRuns === trackedRuns ? 'exact' : 'partial',
    runs,
  };
};

export const normalizeTokenUsageLedger = (ledger = null) => {
  if (!ledger || typeof ledger !== 'object') return emptyTokenUsage();
  const runs = Object.fromEntries(Object.entries(ledger.runs || {}).map(([runId, run]) => {
    const hasCanonicalEvidence = ['exact', 'inconsistent', 'unavailable'].includes(run?.completeness);
    if (hasCanonicalEvidence) {
      return [runId, {
        ...emptyCanonicalUsage(),
        ...run,
        runId,
        ...Object.fromEntries(totalKeys.map((key) => [key, number(run[key])])),
      }];
    }
    return [runId, {
      ...emptyCanonicalUsage(),
      runId,
      phase: run?.phase || null,
      provider: run?.provider || 'unknown',
      completeness: 'unavailable',
      consistent: false,
      raw: null,
      legacyUsage: structuredClone(run || {}),
      observedAt: run?.observedAt || null,
    }];
  }));
  return aggregateRuns(runs);
};

export const tokenUsageFromEvents = (events = [], provider = null) => usageSnapshotFromEvents(events, provider);

export const recordRunTokenUsage = (state, { runId, phase, provider, events = [] } = {}) => {
  if (!runId) return state.tokenUsage || emptyTokenUsage();
  const usage = tokenUsageFromEvents(events, provider);
  const current = normalizeTokenUsageLedger(state.tokenUsage);
  const previous = current.runs?.[runId];
  const nextUsage = usage.completeness === 'unavailable' && previous?.completeness !== 'unavailable'
    ? previous
    : usage;
  const comparable = (item = {}) => JSON.stringify({
    provider: item.provider,
    completeness: item.completeness,
    consistent: item.consistent,
    providerReportedTotal: item.providerReportedTotal,
    raw: item.raw,
    ...Object.fromEntries(totalKeys.map((key) => [key, number(item[key])])),
  });
  const unchanged = previous && comparable(previous) === comparable({ ...nextUsage, provider });
  const runs = {
    ...(current.runs || {}),
    [runId]: {
      ...emptyCanonicalUsage(),
      ...previous,
      ...nextUsage,
      runId,
      phase,
      provider,
      observedAt: unchanged ? previous.observedAt : new Date().toISOString(),
    },
  };
  state.tokenUsage = aggregateRuns(runs);
  return state.tokenUsage;
};

export const formatTokenCount = (value) => {
  const count = number(value);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(count));
};

export const formatExactTokenCount = (value) => Math.round(number(value)).toLocaleString('en-US');
