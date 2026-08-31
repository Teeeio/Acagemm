import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'tools', 'local-c500-tester', 'cli.mjs');
const home = await mkdtemp(path.join(os.tmpdir(), 'operator-process-recovery-'));
const missionDir = path.join(home, 'current');
try {
  await mkdir(missionDir, { recursive: true });
  await writeFile(path.join(missionDir, 'mission.json'), JSON.stringify({
    mission_id: 'MIS_PROCESS_RECOVERY',
    status: 'running',
    stage: 'candidate',
    completed: false,
    workspace: { operator: path.join(rootDir, 'tools', 'local-c500-tester', 'fixtures', 'vector_add') },
    budget: { tokens_used: 0, token_limit: 0, time_limit_ms: null, round_limit: null },
    baseline: { status: 'complete', latency_p50_us: 100 },
    iterationStats: { loopStatus: 'running' },
  }), 'utf8');
  await writeFile(path.join(missionDir, 'workflow_state.json'), JSON.stringify({
    mission_id: 'MIS_PROCESS_RECOVERY',
    status: 'running',
    stalled: false,
    runner_pid: 99999999,
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    events: [{ sequence: 1, type: 'candidate_round_started', payload: { round: 2 } }],
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, 'mission', 'loop', '--mission', 'current', '--mock', '--json'], {
    cwd: rootDir,
    env: { ...process.env, LOCAL_C500_TESTER_HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.stop_reason, 'token_budget');
  const workflow = JSON.parse(await readFile(path.join(missionDir, 'workflow_state.json'), 'utf8'));
  assert.equal(workflow.stalled, false);
  assert.equal(workflow.status, 'budget_exhausted');
  assert.equal(workflow.events.some((event) => event.type === 'workflow_recovered'), true);
  assert.equal(workflow.events.some((event) => event.type === 'loop_stopped'), true);
  const mission = JSON.parse(await readFile(path.join(missionDir, 'mission.json'), 'utf8'));
  assert.equal(mission.recent_events.some((event) => /Recovered interrupted workflow/.test(event.message)), true);
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('[workflow-process-recovery] dead runner snapshots are detected and recovery is recorded before resume');
