import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'tools', 'local-c500-tester', 'cli.mjs');
const fixturePath = path.join(rootDir, 'tools', 'local-c500-tester', 'fixtures', 'vector_add');
const packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));

const runCli = (home, args, options = {}) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      LOCAL_C500_TESTER_HOME: home,
      FORCE_COLOR: '0',
      ...(options.env || {}),
    },
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
  });
  if (options.expectFailure) return result;
  assert.equal(
    result.status,
    0,
    `command failed: node ${path.relative(rootDir, cliPath)} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
};

const runNpm = (home, args) => {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmBin, ['run', 'tester:c500', '--', ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      LOCAL_C500_TESTER_HOME: home,
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `npm command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
};

const readJson = async (...parts) => JSON.parse(await readFile(path.join(...parts), 'utf8'));

const waitFor = async (check, timeoutMs = 10_000) => {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  throw new Error(`condition not met within ${timeoutMs}ms`);
};

const tempHome = await mkdtemp(path.join(os.tmpdir(), 'local-c500-tester-'));

try {
  assert.equal(packageJson.scripts['tester:c500'], 'node tools/local-c500-tester/launcher.cjs');
  assert.equal(packageJson.scripts['test:local-c500-tester'], 'node tests/local-c500-tester-test.mjs');
  assert.ok(packageJson.dependencies.ink);

  const doctor = runCli(tempHome, ['doctor', '--mock', '--json']);
  const doctorBody = JSON.parse(doctor.stdout);
  assert.equal(doctorBody.status, 'ready');
  assert.equal(doctorBody.environment.expected.triton, '3.7.1');
  assert.equal(doctorBody.environment.expected.torch, '2.8.0+metax3.3.0.2');
  assert.equal(doctorBody.environment.expected.python, '3.12.11');
  assert.equal(doctorBody.environment.expected.vllm, '0.13.0');
  assert.equal(doctorBody.environment.expected.vllm_metax, '0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8');
  assert.equal(doctorBody.environment.expected.maca, '3.3.0.15');
  assert.equal(doctorBody.environment.tools.mctracer.status, 'ok');
  assert.equal(doctorBody.environment.tools.mcProfiler.status, 'ok');

  const npmDoctor = runNpm(tempHome, ['doctor', '--mock', '--json']);
  assert.match(npmDoctor.stdout, /"status": "ready"/);

  const npmPanelSnapshot = runNpm(tempHome, ['panel', '--once']);
  assert.match(npmPanelSnapshot.stdout, /Current Mission Console/);
  assert.match(npmPanelSnapshot.stdout, /Current Mission/);
  assert.match(npmPanelSnapshot.stdout, /Latest Round/);
  assert.match(npmPanelSnapshot.stdout, /\[P\] Publish/);
  assert.match(npmPanelSnapshot.stdout, /Repository/);
  assert.match(npmPanelSnapshot.stdout, /Agent/);
  assert.doesNotMatch(npmPanelSnapshot.stdout, /Operator path/);
  assert.doesNotMatch(npmPanelSnapshot.stdout, /Operator/);
  assert.doesNotMatch(npmPanelSnapshot.stdout, /^Missions$/m);

  const inkCreateSnapshot = spawnSync(process.execPath, [
    path.join(rootDir, 'tools', 'local-c500-tester', 'tui.mjs'),
    '--snapshot',
    '--mode',
    'publish',
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      LOCAL_C500_TESTER_HOME: tempHome,
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(inkCreateSnapshot.status, 0, inkCreateSnapshot.stderr);
  assert.match(inkCreateSnapshot.stdout, /Publish Mission/);
  assert.match(inkCreateSnapshot.stdout, /draft is preserved during refresh/);
  assert.match(inkCreateSnapshot.stdout, /Repository/);
  assert.doesNotMatch(inkCreateSnapshot.stdout, /Operator path/);
  assert.doesNotMatch(inkCreateSnapshot.stdout, /Operator/);

  const npmCreated = runNpm(tempHome, [
    'mission',
    'create',
    '--name',
    'npm_publish_mission',
    '--operator',
    'paged_attention',
    '--operator-path',
    fixturePath,
    '--token-budget',
    '1',
    '--mock',
    '--json',
  ]);
  assert.match(npmCreated.stdout, /"status": "budget_exhausted"/);
  assert.match(npmCreated.stdout, /"stop_reason": "token_budget"/);

  const foldedCreated = runCli(tempHome, [
    'mission',
    'create',
    'folded_publish_mission',
    'paged_attention',
    fixturePath,
    '1',
    '--mock',
    '--json',
  ]);
  assert.equal(JSON.parse(foldedCreated.stdout).status, 'budget_exhausted');

  const created = runCli(tempHome, [
    'mission',
    'create',
    '--name',
    'paged_attention_local',
    '--operator',
    'paged_attention',
    '--backend',
    'triton',
    '--time-budget',
    '5h',
    '--token-budget',
    '200000',
    '--mock',
    '--json',
  ]);
  const createBody = JSON.parse(created.stdout);
  assert.match(createBody.mission_id, /^local_/);
  assert.equal(createBody.status, 'created');

  const missionDir = path.join(tempHome, 'missions', createBody.mission_id);
  const mission = await readJson(missionDir, 'mission.json');
  assert.equal(mission.name, 'paged_attention_local');
  assert.equal(mission.operator, 'paged_attention');
  assert.equal(mission.backend, 'triton');
  assert.equal(mission.platform, 'local-c500');
  assert.equal(mission.budget.time_limit_ms, 18_000_000);
  assert.equal(mission.budget.token_limit, 200_000);
  assert.equal(mission.budget.tokens_used, 0);
  assert.equal(mission.environment.expected.triton, '3.7.1');

  runCli(tempHome, ['mission', 'note', '--mission', createBody.mission_id, '--text', '优先验证 seq_len=128', '--json']);
  const notes = await readFile(path.join(missionDir, 'human_notes.jsonl'), 'utf8');
  assert.match(notes, /优先验证 seq_len=128/);

  const run = runCli(tempHome, [
    'mission',
    'run',
    '--mission',
    createBody.mission_id,
    '--operator-path',
    fixturePath,
    '--mock',
    '--json',
  ]);
  const runBody = JSON.parse(run.stdout);
  assert.equal(runBody.status, 'completed');
  assert.equal(runBody.summary.correctness, 'pass');
  assert.equal(runBody.summary.backend, 'triton');
  assert.equal(runBody.summary.latency_p50_us > 0, true);
  assert.equal(runBody.summary.speedup > 0, true);
  assert.equal(runBody.summary.context_policy, 'summary_only');

  const summary = await readJson(missionDir, 'summary.json');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.mission_completed, true);
  assert.equal(summary.tokens_used > 0, true);
  assert.equal(summary.current_best.candidate_id, 'candidate-001');
  assert.equal(summary.current_best.speedup > 0, true);
  assert.ok(summary.report_dir);
  assert.equal(summary.agent_context.allowed_files.length, 1);
  assert.equal(summary.agent_context.allowed_files[0], 'summary.json');

  const rounds = await readFile(path.join(missionDir, 'rounds.jsonl'), 'utf8');
  assert.match(rounds, /"round":1/);
  assert.match(rounds, /"tokens_used":/);
  assert.match(rounds, /"mctracer":"generated"/);
  assert.match(rounds, /"mcProfiler":"generated"/);

  const testCases = await readJson(missionDir, 'test_cases.json');
  assert.equal(testCases.generated_by, 'local-c500-tester');
  assert.equal(testCases.cases.length > 0, true);

  assert.equal(existsSync(path.join(missionDir, 'operator_snapshot', 'run.py')), true);

  const panel = runCli(tempHome, ['panel', '--once']);
  assert.match(panel.stdout, /C500 Local Tester/);
  assert.match(panel.stdout, /Current Mission/);
  assert.match(panel.stdout, /Current Best/);
  assert.doesNotMatch(panel.stdout, /Operator/);
  assert.match(panel.stdout, /mctracer/);
  assert.match(panel.stdout, /mcProfiler/);
  assert.match(panel.stdout, /\[P\] Publish/);

  const exported = runCli(tempHome, ['mission', 'export', '--mission', createBody.mission_id, '--json']);
  const exportBody = JSON.parse(exported.stdout);
  assert.equal(exportBody.status, 'exported');
  assert.equal(existsSync(exportBody.export_dir), true);
  assert.equal(existsSync(path.join(exportBody.export_dir, 'summary.json')), true);

  const autoCreated = runCli(tempHome, [
    'mission',
    'create',
    '--name',
    'auto_publish_mission',
    '--operator',
    'paged_attention',
    '--operator-path',
    fixturePath,
    '--mock',
    '--json',
  ]);
  const autoBody = JSON.parse(autoCreated.stdout);
  assert.equal(autoBody.status, 'completed');
  assert.equal(autoBody.summary.mission_completed, true);
  assert.equal(autoBody.summary.context_policy, 'summary_only');

  const budgetLimited = runCli(tempHome, [
    'mission',
    'create',
    '--name',
    'budget_limited_mission',
    '--operator',
    'paged_attention',
    '--operator-path',
    fixturePath,
    '--token-budget',
    '1',
    '--mock',
    '--json',
  ]);
  const budgetBody = JSON.parse(budgetLimited.stdout);
  assert.equal(budgetBody.status, 'budget_exhausted');
  assert.equal(budgetBody.summary.mission_completed, false);
  assert.equal(budgetBody.summary.stop_reason, 'token_budget');
  assert.equal(budgetBody.summary.budget.tokens_used > budgetBody.summary.budget.token_limit, true);

  const paused = runCli(tempHome, ['mission', 'pause', '--mission', createBody.mission_id, '--json']);
  assert.equal(JSON.parse(paused.stdout).status, 'paused');
  let pausedSummary = await readJson(missionDir, 'summary.json');
  assert.equal(pausedSummary.status, 'paused');
  assert.equal(pausedSummary.stop_reason, 'paused_by_user');

  const resumed = runCli(tempHome, ['mission', 'resume', '--mission', createBody.mission_id, '--json']);
  assert.equal(JSON.parse(resumed.stdout).status, 'running');
  pausedSummary = await readJson(missionDir, 'summary.json');
  assert.equal(pausedSummary.status, 'running');

  const stopped = runCli(tempHome, ['mission', 'stop', '--mission', createBody.mission_id, '--json']);
  assert.equal(JSON.parse(stopped.stdout).status, 'stopped');
  pausedSummary = await readJson(missionDir, 'summary.json');
  assert.equal(pausedSummary.status, 'stopped');
  assert.equal(pausedSummary.stop_reason, 'stopped_by_user');

  const actionPanel = runCli(tempHome, ['panel', '--once']);
  assert.match(actionPanel.stdout, /\[P\] Publish/);
  assert.match(actionPanel.stdout, /\[N\] Note/);
  assert.match(actionPanel.stdout, /\[S\] Stop/);

  const fakeToolDir = path.join(tempHome, 'fake-tools');
  await mkdir(fakeToolDir, { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(path.join(fakeToolDir, 'mctracer.cmd'), '@echo off\r\necho fake mctracer %*\r\nexit /b 0\r\n', 'utf8');
    await writeFile(path.join(fakeToolDir, 'mcProfiler.cmd'), '@echo off\r\necho fake mcProfiler %*\r\nexit /b 0\r\n', 'utf8');
  } else {
    await writeFile(path.join(fakeToolDir, 'mctracer'), '#!/usr/bin/env sh\necho fake mctracer "$@"\n', 'utf8');
    await writeFile(path.join(fakeToolDir, 'mcProfiler'), '#!/usr/bin/env sh\necho fake mcProfiler "$@"\n', 'utf8');
    await chmod(path.join(fakeToolDir, 'mctracer'), 0o755);
    await chmod(path.join(fakeToolDir, 'mcProfiler'), 0o755);
  }

  const realCreated = runCli(tempHome, [
    'mission',
    'create',
    '--name',
    'real_tool_mission',
    '--operator',
    'vector_add',
    '--operator-path',
    fixturePath,
    '--json',
  ], {
    env: { PATH: `${fakeToolDir}${path.delimiter}${process.env.PATH}` },
  });
  const realBody = JSON.parse(realCreated.stdout);
  assert.equal(realBody.status, 'completed');
  assert.equal(realBody.summary.test_tools.mctracer.status, 'completed');
  assert.equal(realBody.summary.test_tools.mcProfiler.status, 'completed');
  assert.ok(realBody.summary.analysis_artifacts.mctracer.stdout_file);
  assert.ok(realBody.summary.analysis_artifacts.mcProfiler.stdout_file);
  assert.equal(existsSync(realBody.summary.analysis_artifacts.mctracer.stdout_file), true);
  assert.equal(existsSync(realBody.summary.analysis_artifacts.mcProfiler.stdout_file), true);
  assert.match(await readFile(realBody.summary.analysis_artifacts.mctracer.stdout_file, 'utf8'), /fake mctracer/);
  assert.match(await readFile(realBody.summary.analysis_artifacts.mcProfiler.stdout_file, 'utf8'), /fake mcProfiler/);

  const tuiPublished = runCli(tempHome, [
    'panel',
    '--publish',
    '--title',
    'tui_published_mission',
    '--goal',
    'validate vector_add local publish flow',
    '--repository',
    'local-c500-demo',
    '--round-budget',
    '3',
    '--research-rounds',
    '3',
    '--smoke',
    '--mock',
    '--json',
  ]);
  const tuiBody = JSON.parse(tuiPublished.stdout);
  assert.equal(tuiBody.status, 'running');
  assert.equal(tuiBody.background, true);
  assert.equal(Number.isFinite(tuiBody.runner.pid), true);
  const tuiMissionDir = path.join(tempHome, 'current');
  assert.equal(existsSync(path.join(tuiMissionDir, 'workspace', 'operator', 'run.py')), true);
  assert.equal(existsSync(path.join(tuiMissionDir, 'workspace', 'repository')), true);
  assert.equal(existsSync(path.join(tuiMissionDir, 'agent_discovery.json')), true);
  assert.equal(existsSync(path.join(tuiMissionDir, 'baseline.json')), true);
  assert.equal(existsSync(path.join(tuiMissionDir, 'candidate.json')), true);
  const tuiMission = await readJson(tuiMissionDir, 'mission.json');
  assert.equal(tuiMission.title, 'tui_published_mission');
  assert.equal(tuiMission.goal, 'validate vector_add local publish flow');
  assert.equal(tuiMission.repository, 'local-c500-demo');
  assert.deepEqual(tuiMission.hardware, ['C500']);
  assert.ok(['running', 'completed', 'budget_exhausted'].includes(tuiMission.status));
  assert.equal(tuiMission.client_stage, 'diagnosis');
  assert.equal(tuiMission.agent.resolved_by, 'local-agent-discovery');
  assert.equal(tuiMission.workspace.isolation, 'current-mission-managed');
  assert.equal(tuiMission.testMatrix.platforms[0], 'local-c500');
  assert.equal(tuiMission.candidateEvaluations.length, 1);
  assert.equal(tuiMission.iterationStats.researchRounds, 3);
  assert.equal(tuiMission.iterationStats.researchExhausted, true);
  assert.equal(tuiMission.iterationStats.loopStatus, 'running');
  assert.equal(tuiMission.workflowRecovery.can_resume, true);
  assert.equal(tuiMission.operator_source, undefined);
  assert.equal(tuiMission.operator_path, undefined);
  const discovery = await readJson(tuiMissionDir, 'agent_discovery.json');
  assert.equal(discovery.resolved_by, 'local-agent-discovery');
  assert.equal(discovery.user_visible_source_path, false);
  const baseline = await readJson(tuiMissionDir, 'baseline.json');
  assert.equal(baseline.measured_before_candidate, true);
  assert.match(baseline.source, /authoritative|naive_v0|smoke_fixture|registered_local_material/);
  assert.equal(baseline.status, 'missing');
  let tuiSummary = await readJson(tuiMissionDir, 'summary.json');
  assert.equal(tuiSummary.status, 'running');
  assert.equal(tuiSummary.stage, 'runner_started');
  tuiSummary = await waitFor(async () => {
    const current = await readJson(tuiMissionDir, 'summary.json');
    return ['completed', 'budget_exhausted', 'needs_human', 'failed'].includes(current.status) ? current : null;
  });
  assert.equal(tuiSummary.repository, 'local-c500-demo');
  assert.equal(tuiSummary.status, 'budget_exhausted');
  assert.equal(tuiSummary.stop_reason, 'round_budget');
  assert.equal(tuiSummary.baseline.status, 'complete');
  assert.equal(tuiSummary.baseline.measured_before_candidate, true);
  assert.equal(Number.isFinite(tuiSummary.baseline.latency_p50_us), true);
  assert.equal(tuiSummary.baseline.completed_before_first_candidate, true);
  assert.equal(tuiSummary.candidate_evaluations.length, 3);
  assert.equal(tuiSummary.iteration.round, 3);
  assert.equal(tuiSummary.iteration.researchExhausted, true);
  assert.equal(tuiSummary.iteration.maxResearchStopsMainLoop, false);
  assert.equal(tuiSummary.current_best.candidate_id, 'candidate-003');
  assert.equal(tuiSummary.current_best.speedup > 0, true);
  assert.equal(tuiSummary.backend, 'triton');
  const baselineResult = await readJson(tuiMissionDir, 'baseline_result.json');
  assert.equal(baselineResult.status, 'completed');
  assert.equal(Number.isFinite(baselineResult.latency_p50_us), true);
  const workflowBridge = await readJson(tuiMissionDir, 'workflow_state.json');
  assert.equal(workflowBridge.status, 'budget_exhausted');
  assert.equal(workflowBridge.stalled, false);
  assert.equal(workflowBridge.baseline.status, 'complete');
  assert.equal(workflowBridge.iteration.round, 3);
  assert.equal(workflowBridge.iteration.researchExhausted, true);
  assert.equal(workflowBridge.iteration.maxResearchStopsMainLoop, false);
  assert.deepEqual(
    workflowBridge.events.slice(0, 4).map((event) => event.type),
    ['baseline_started', 'baseline_completed', 'candidate_round_started', 'candidate_round_completed'],
  );
  assert.equal(workflowBridge.events.filter((event) => event.type === 'candidate_round_completed').length, 3);
  const tuiRounds = (await readFile(path.join(tuiMissionDir, 'rounds.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(tuiRounds.map((round) => round.round), [1, 2, 3]);
  assert.equal(tuiRounds.every((round) => round.baseline?.status === 'complete' && round.baseline?.measured_before_candidate), true);
  const tuiPanel = runNpm(tempHome, ['panel', '--once']);
  assert.match(tuiPanel.stdout, /tui_published_mission/);
  assert.match(tuiPanel.stdout, /Current Mission Console/);
  assert.match(tuiPanel.stdout, /local-c500-demo/);
  assert.doesNotMatch(tuiPanel.stdout, /Operator/);
  assert.doesNotMatch(tuiPanel.stdout, /^Missions$/m);

  const secondPublish = runCli(tempHome, [
    'panel',
    '--publish',
    '--title',
    'second_current_mission',
    '--goal',
    'validate archive current flow',
    '--repository',
    'local-c500-demo',
    '--smoke',
    '--mock',
    '--json',
  ]);
  const secondBody = JSON.parse(secondPublish.stdout);
  assert.equal(secondBody.status, 'running');
  assert.equal(existsSync(path.join(tempHome, 'archive', tuiBody.mission_id, 'mission.json')), true);
  const currentMission = await readJson(tempHome, 'current', 'mission.json');
  assert.equal(currentMission.title, 'second_current_mission');
} finally {
  await rm(tempHome, { recursive: true, force: true });
}
