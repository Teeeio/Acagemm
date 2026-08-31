import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'tools', 'local-c500-tester', 'cli.mjs');
const home = await mkdtemp(path.join(os.tmpdir(), 'operator-workflow-stop-'));
try {
  const missionDir = path.join(home, 'current');
  await mkdir(missionDir, { recursive: true });
  await writeFile(path.join(missionDir, 'mission.json'), JSON.stringify({
    mission_id: 'MIS_STOP_RECOVERY',
    status: 'published',
    stage: 'published',
    completed: false,
    budget: { tokens_used: 0, token_limit: null, time_limit_ms: null, round_limit: null },
    iterationStats: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, 'mission', 'loop', '--mission', 'current', '--json'], {
    cwd: rootDir,
    env: { ...process.env, LOCAL_C500_TESTER_HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `unexpected process failure: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'needs_human');
  assert.equal(output.stop_reason, 'workflow_error');
  assert.equal(output.failure.code, 'OPERATOR_PATH_REQUIRED');
  assert.equal(output.failure.phase, 'initializing');
  assert.equal(output.failure.retryable, false);

  const mission = JSON.parse(await readFile(path.join(missionDir, 'mission.json'), 'utf8'));
  assert.equal(mission.status, 'needs_human');
  assert.equal(mission.iterationStats.loopStatusReason, 'workflow_error');
  assert.equal(mission.workflowFailure.code, 'OPERATOR_PATH_REQUIRED');
  const workflow = JSON.parse(await readFile(path.join(missionDir, 'workflow_state.json'), 'utf8'));
  assert.equal(workflow.status, 'needs_human');
  assert.equal(workflow.stalled, true);
  assert.equal(workflow.stop_reason, 'workflow_error');
  assert.equal(workflow.failure.phase, 'initializing');
  assert.equal(workflow.recovery.required, true);
  assert.match(workflow.events.at(-1).type, /loop_interrupted/);
  const summary = JSON.parse(await readFile(path.join(missionDir, 'summary.json'), 'utf8'));
  assert.equal(summary.stop_reason, 'workflow_error');
  assert.equal(summary.failure.code, 'OPERATOR_PATH_REQUIRED');

  await writeFile(path.join(missionDir, 'mission.json'), JSON.stringify({
    mission_id: 'MIS_TOKEN_EXHAUSTED',
    status: 'published',
    stage: 'published',
    completed: false,
    workspace: { operator: path.join(rootDir, 'tools', 'local-c500-tester', 'fixtures', 'vector_add') },
    budget: { tokens_used: 0, token_limit: 0, time_limit_ms: null, round_limit: null },
    baseline: { status: 'complete', latency_p50_us: 100, measured_before_candidate: true, completed_before_first_candidate: true },
    iterationStats: {},
  }), 'utf8');
  const budgetResult = spawnSync(process.execPath, [cliPath, 'mission', 'loop', '--mission', 'current', '--mock', '--json'], {
    cwd: rootDir,
    env: { ...process.env, LOCAL_C500_TESTER_HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(budgetResult.status, 0, budgetResult.stderr);
  const budgetOutput = JSON.parse(budgetResult.stdout);
  assert.equal(budgetOutput.status, 'budget_exhausted');
  assert.equal(budgetOutput.summary.stop_reason, 'token_budget');
  assert.equal(budgetOutput.summary.iteration.loopStatus, 'budget_exhausted');

  await writeFile(path.join(missionDir, 'mission.json'), JSON.stringify({
    mission_id: 'MIS_NO_CANDIDATE',
    status: 'published',
    stage: 'published',
    completed: false,
    workspace: { operator: path.join(rootDir, 'tools', 'local-c500-tester', 'fixtures', 'vector_add') },
    budget: { tokens_used: 0, token_limit: null, time_limit_ms: null, round_limit: 5 },
    baseline: { status: 'complete', latency_p50_us: 100, measured_before_candidate: true, completed_before_first_candidate: true },
    iterationStats: {},
  }), 'utf8');
  const noCandidateResult = spawnSync(process.execPath, [cliPath, 'mission', 'loop', '--mission', 'current', '--mock', '--json'], {
    cwd: rootDir,
    env: { ...process.env, LOCAL_C500_TESTER_HOME: home, LOCAL_C500_TESTER_CODEX_COMMAND: 'definitely-missing-agent', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(noCandidateResult.status, 0, noCandidateResult.stderr);
  const noCandidateOutput = JSON.parse(noCandidateResult.stdout);
  assert.equal(noCandidateOutput.status, 'needs_human');
  assert.equal(noCandidateOutput.summary.stop_reason, 'no_candidate_reported');
  assert.equal(noCandidateOutput.summary.iteration.loopStatusReason, 'no_candidate_reported');
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('[workflow-stop-recovery] unexpected exceptions become explicit resumable needs_human stops');
