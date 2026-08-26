import assert from 'node:assert/strict';
import { renderDashboardSnapshot } from '../tools/local-c500-tester/tui-state.mjs';
import { emptyTokenUsage, formatTokenCount, recordRunTokenUsage, tokenUsageFromEvents } from '../client-runtime/token-usage.mjs';

const events = [
  { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 } },
  { type: 'item.completed', usage: { input_tokens: 999 } },
];
assert.deepEqual(tokenUsageFromEvents(events), {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 0,
  totalTokens: 150,
});

const state = { tokenUsage: emptyTokenUsage() };
recordRunTokenUsage(state, { runId: 'research-1', phase: 'research.acquire', provider: 'claude-code', events });
recordRunTokenUsage(state, { runId: 'research-1', phase: 'research.acquire', provider: 'claude-code', events });
assert.equal(state.tokenUsage.totalTokens, 150, 'refreshing the same run must not double count usage');
recordRunTokenUsage(state, { runId: 'iteration-1', phase: 'iteration', provider: 'codex-cli', events: [{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }] });
assert.equal(state.tokenUsage.totalTokens, 165);
assert.equal(formatTokenCount(12500), '12.5k');

const snapshot = renderDashboardSnapshot({
  state: { ...state, iterationStats: {}, benchmark: {}, runtimeEvents: [] },
  mission: { id: 'MIS_TOKEN', title: 'Token test', implementation: { id: 'triton' }, testMatrix: { testSpec: { schemaVersion: 'operator-studio.test-spec/v1' } } },
  health: {},
  tasks: [],
});
assert.match(snapshot, /tokens\s+165/);
assert.match(snapshot, /language\s+Triton/);

console.log('[token-usage] normalized, idempotent accounting and TUI projection passed');
