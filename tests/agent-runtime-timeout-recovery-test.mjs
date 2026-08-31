import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-timeout-recovery-'));
const execFileAsync = promisify(execFile);
await execFileAsync('git', ['init'], { cwd: workspace });
await execFileAsync('git', ['config', 'user.name', 'Timeout Test'], { cwd: workspace });
await execFileAsync('git', ['config', 'user.email', 'timeout@test.invalid'], { cwd: workspace });
await execFileAsync('git', ['commit', '--allow-empty', '-m', 'baseline'], { cwd: workspace });

const runtime = createAgentRuntime({
  mode: 'claude-code',
  claudeClient: {
    describe: async () => ({ installed: true, loggedIn: true, version: 'test' }),
    readRun: async () => ({
      runId: 'claude_TIMEOUT',
      status: 'cancelled',
      workspace,
      threadId: 'thread-timeout',
      lastActivityAt: new Date().toISOString(),
    }),
    readEvents: async () => [{ type: 'thread.started', thread_id: 'thread-timeout', provider: 'claude-code' }],
    eventText: () => '',
  },
});

const state = {
  activeMissionId: 'MIS_TIMEOUT',
  missions: [{ id: 'MIS_TIMEOUT', title: 'Timeout recovery', status: 'running' }],
  stage: 'diagnosis',
  runtimeEvents: [],
  candidateEvaluations: [],
  tokenUsage: { runs: {} },
  agent: {
    status: 'completed',
    phase: 'Claude Code 单轮停滞，已收敛为无候选',
    runId: 'claude_TIMEOUT',
    runtimeKind: 'claude-code',
    startedAt: new Date(Date.now() - 301_000).toISOString(),
    eventCount: 1,
    lastEventAt: Date.now() - 301_000,
    timedOut: true,
    messages: [],
    artifacts: [],
  },
};

try {
  const projection = await runtime.projectState(state);
  assert.equal(projection.state.agent.status, 'completed');
  assert.equal(projection.state.agent.timedOut, true);
  assert.equal(projection.state.stage, 'diagnosis');
  assert.equal(projection.state.candidateEvaluations.length, 0);
  assert.ok(projection.state.runtimeEvents.some((event) => event.type === 'candidate.not_proposed' && event.payload?.recoverable === true));
  assert.notEqual(projection.state.iterationStats?.loopStatus, 'running', 'runtime projection must not create an unowned running loop');
  console.log('[agent-runtime-timeout-recovery] timeout-triggered cancellation converges to a retryable terminal projection');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
