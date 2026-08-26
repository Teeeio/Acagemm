import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { Dashboard } from '../tools/local-c500-tester/components/Dashboard.mjs';
import { deriveDashboardLayout } from '../tools/local-c500-tester/tui-layout.mjs';

const clearTerminal = '\u001b[2J\u001b[3J\u001b[H';

const renderAt = async (rows, columns = 120, tasks = []) => {
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const writes = [];
  output.on('data', (chunk) => writes.push(chunk.toString()));
  const snapshot = {
    mission: { id: 'MIS_VIEWPORT', title: 'Viewport test', goal: 'optimize', status: 'running' },
    state: {
      stage: 'candidate',
      agent: { status: 'running', phase: 'generating run.py', progress: 45 },
      researchAgent: { status: 'completed', progress: 100 },
      baseline: { status: 'complete', source: { repository: 'repo', commit: 'commit', path: 'run.py' }, materializer: { status: 'completed' }, evidence: { value: 100 } },
      iterationStats: { loopStatus: 'running', round: 2 },
      runtimeEvents: [],
    },
    tasks,
  };
  const instance = render(React.createElement(Dashboard, { snapshot, viewport: { rows, columns } }), {
    stdout: output,
    stderr: output,
    stdin: input,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 420));
  const exitPromise = instance.waitUntilExit();
  instance.unmount();
  await exitPromise;
  return writes;
};

assert.equal(deriveDashboardLayout({ rows: 40 }).density, 'compact');
assert.equal(deriveDashboardLayout({ rows: 40 }).height, 38);
assert.equal(deriveDashboardLayout({ rows: 30 }).density, 'tight');

for (const rows of [40, 30, 24]) {
  const writes = await renderAt(rows);
  assert.ok(writes.length >= 2, `expected initial and activity writes at ${rows} rows`);
  assert.equal(writes.some((write) => write.includes(clearTerminal)), false, `render at ${rows} rows must not enter Ink's scrolling full-screen repaint path`);
}

const duplicateCandidateTasks = [
  { taskId: 'retry-1', submittedAt: '2026-08-26T01:00:00Z', status: 'failed', payload: { purpose: 'candidate', candidate: { id: 'candidate-02', digest: 'sha256:same' } } },
  { taskId: 'retry-2', submittedAt: '2026-08-26T01:01:00Z', status: 'completed', payload: { purpose: 'candidate', candidate: { id: 'candidate-02', digest: 'sha256:same' } }, result: { benchmark: [{ value: 84, unit: 'us' }] } },
];
const originalConsoleError = console.error;
const reactWarnings = [];
console.error = (...args) => reactWarnings.push(args.map(String).join(' '));
try {
  await renderAt(40, 120, duplicateCandidateTasks);
} finally {
  console.error = originalConsoleError;
}
assert.equal(reactWarnings.some((warning) => warning.includes('same key')), false, reactWarnings.join('\n'));

console.log('[local-c500-tui-viewport] bounded renders and retry candidates produce no terminal warnings');
