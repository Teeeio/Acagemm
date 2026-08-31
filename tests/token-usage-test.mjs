import assert from 'node:assert/strict';
import { renderDashboardSnapshot } from '../tools/local-c500-tester/tui-state.mjs';
import { emptyTokenUsage, formatExactTokenCount, formatTokenCount, normalizeTokenUsageLedger, recordRunTokenUsage, tokenUsageFromEvents } from '../client-runtime/token-usage.mjs';

const claudeEvents = [
  {
    type: 'turn.completed',
    usageId: 'claude-turn-1',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
  },
  { type: 'item.completed', usage: { input_tokens: 999 } },
];
const claudeUsage = tokenUsageFromEvents(claudeEvents, 'claude-code');
assert.equal(claudeUsage.uncachedInputTokens, 100);
assert.equal(claudeUsage.inputTokens, 140, 'Claude cache reads and writes are additional input tokens');
assert.equal(claudeUsage.outputTokens, 20);
assert.equal(claudeUsage.totalTokens, 160);
assert.equal(claudeUsage.completeness, 'exact');

const codexUsage = tokenUsageFromEvents([{
  type: 'turn.completed',
  usageId: 'codex-turn-1',
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 }, total_tokens: 120 },
}], 'codex-cli');
assert.equal(codexUsage.uncachedInputTokens, 70, 'Codex cached input is a subset of input_tokens');
assert.equal(codexUsage.inputTokens, 100);
assert.equal(codexUsage.cacheReadTokens, 30);
assert.equal(codexUsage.totalTokens, 120, 'cached input must not be counted twice');
assert.equal(codexUsage.completeness, 'exact');

const openCodeUsage = tokenUsageFromEvents([{
  type: 'turn.completed',
  usageId: 'opencode-message-1',
  usage: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 }, total: 165 },
}], 'opencode-server');
assert.equal(openCodeUsage.inputTokens, 140);
assert.equal(openCodeUsage.outputTokens, 25, 'OpenCode reports reasoning outside output');
assert.equal(openCodeUsage.reasoningTokens, 5);
assert.equal(openCodeUsage.totalTokens, 165);
assert.equal(openCodeUsage.completeness, 'exact');

const inconsistentUsage = tokenUsageFromEvents([{
  type: 'turn.completed',
  usageId: 'bad-total',
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 999 },
}], 'codex-cli');
assert.equal(inconsistentUsage.totalTokens, 15);
assert.equal(inconsistentUsage.providerReportedTotal, 999);
assert.equal(inconsistentUsage.completeness, 'inconsistent');

const migratedLegacy = normalizeTokenUsageLedger({
  totalTokens: 150,
  runs: { legacy: { runId: 'legacy', provider: 'codex-cli', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, totalTokens: 150 } },
});
assert.equal(migratedLegacy.totalTokens, 0, 'legacy totals without raw evidence cannot be claimed as exact');
assert.equal(migratedLegacy.coverage, '0/1 runs exact');
assert.equal(migratedLegacy.runs.legacy.legacyUsage.totalTokens, 150, 'legacy evidence remains available for audit');

const state = { tokenUsage: emptyTokenUsage() };
recordRunTokenUsage(state, { runId: 'research-1', phase: 'research.acquire', provider: 'claude-code', events: claudeEvents });
const firstSnapshot = JSON.stringify(state.tokenUsage);
recordRunTokenUsage(state, { runId: 'research-1', phase: 'research.acquire', provider: 'claude-code', events: claudeEvents });
assert.equal(JSON.stringify(state.tokenUsage), firstSnapshot, 'refreshing the same run must not double count or churn the snapshot');

recordRunTokenUsage(state, {
  runId: 'iteration-1',
  phase: 'iteration',
  provider: 'codex-cli',
  events: [{ type: 'turn.failed', usageId: 'failed-turn', usage: { input_tokens: 10, output_tokens: 5 } }],
});
assert.equal(state.tokenUsage.totalTokens, 175, 'failed turns still consume tokens');
assert.equal(state.tokenUsage.coverage, '2/2 runs exact');

recordRunTokenUsage(state, { runId: 'cancelled-1', phase: 'iteration', provider: 'claude-code', events: [] });
assert.equal(state.tokenUsage.completeness, 'partial');
assert.equal(state.tokenUsage.coverage, '2/3 runs exact');
recordRunTokenUsage(state, {
  runId: 'cancelled-1',
  phase: 'iteration',
  provider: 'claude-code',
  events: [{ type: 'turn.failed', usageId: 'cancelled-usage', usage: { input_tokens: 4, output_tokens: 1 } }],
});
assert.equal(state.tokenUsage.totalTokens, 180, 'late terminal usage replaces the unavailable run snapshot');
assert.equal(state.tokenUsage.completeness, 'exact');
assert.equal(state.tokenUsage.coverage, '3/3 runs exact');
assert.equal(formatTokenCount(12500), '12.5k');
assert.equal(formatExactTokenCount(12500), '12,500');

const snapshot = renderDashboardSnapshot({
  state: { ...state, iterationStats: {}, benchmark: {}, runtimeEvents: [] },
  mission: { id: 'MIS_TOKEN', title: 'Token test', implementation: { id: 'triton' }, testMatrix: { testSpec: { schemaVersion: 'operator-studio.test-spec/v1' } } },
  health: {},
  tasks: [],
});
assert.match(snapshot, /tokens\s+180\s+·\s+3\/3 runs exact/);
assert.match(snapshot, /language\s+Triton/);

console.log('[token-usage] provider semantics, failure accounting, idempotence, coverage and exact TUI projection passed');
