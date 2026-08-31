import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'tools', 'local-c500-tester', 'cli.mjs');
const home = await mkdtemp(path.join(os.tmpdir(), 'operator-legacy-run-stop-'));
try {
  const missionDir = path.join(home, 'current');
  await mkdir(missionDir, { recursive: true });
  await writeFile(path.join(missionDir, 'mission.json'), JSON.stringify({
    mission_id: 'MIS_LEGACY_RUN_STOP',
    status: 'published',
    stage: 'published',
    completed: false,
    budget: { tokens_used: 0, token_limit: null, time_limit_ms: null, round_limit: null },
    iterationStats: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [
    cliPath,
    'mission',
    'run',
    '--mission',
    'current',
    '--operator-path',
    path.join(home, 'missing-operator'),
    '--json',
  ], {
    cwd: rootDir,
    env: { ...process.env, LOCAL_C500_TESTER_HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `unexpected process failure: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'needs_human');
  assert.equal(output.stop_reason, 'workflow_error');
  assert.equal(output.failure.code, 'OPERATOR_SOURCE_UNAVAILABLE');
  assert.equal(output.failure.phase, 'copy_operator');
  assert.equal(output.failure.retryable, false);

  const mission = JSON.parse(await readFile(path.join(missionDir, 'mission.json'), 'utf8'));
  assert.equal(mission.status, 'needs_human');
  assert.equal(mission.workflowFailure.code, 'OPERATOR_SOURCE_UNAVAILABLE');
  assert.equal(mission.stopDetail.phase, 'copy_operator');

  const workflow = JSON.parse(await readFile(path.join(missionDir, 'workflow_state.json'), 'utf8'));
  assert.equal(workflow.status, 'needs_human');
  assert.equal(workflow.stalled, true);
  assert.equal(workflow.failure.code, 'OPERATOR_SOURCE_UNAVAILABLE');
  assert.equal(workflow.recovery.command, 'mission loop --mission MIS_LEGACY_RUN_STOP');
  assert.equal(workflow.events.at(-1).type, 'loop_interrupted');

  const summary = JSON.parse(await readFile(path.join(missionDir, 'summary.json'), 'utf8'));
  assert.equal(summary.stop_reason, 'workflow_error');
  assert.equal(summary.failure.phase, 'copy_operator');
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('[legacy-run-stop-recovery] one-shot failures become explicit resumable needs_human stops');
