import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'tools', 'local-c500-tester', 'cli.mjs');

const runCli = (home, args) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      LOCAL_C500_TESTER_HOME: home,
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `command failed: node ${path.relative(rootDir, cliPath)} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
};

const readJson = async (...parts) => JSON.parse(await readFile(path.join(...parts), 'utf8'));
const tempHome = await mkdtemp(path.join(os.tmpdir(), 'local-c500-no-fallback-'));

try {
  const unsupported = runCli(tempHome, [
    'panel',
    '--publish',
    '--goal',
    'optimize flashinfer paged_attention on local C500',
    '--repository',
    'flashinfer-upstream',
    '--mock',
    '--json',
  ]);
  assert.equal(unsupported.status, 'needs_human');
  assert.equal(unsupported.background, false);

  const unsupportedMission = await readJson(tempHome, 'current', 'mission.json');
  assert.equal(unsupportedMission.status, 'needs_human');
  assert.equal(unsupportedMission.stage, 'discovery');
  assert.equal(unsupportedMission.agent.operator_id, null);
  assert.equal(unsupportedMission.agent.reason, 'operator_identity_unresolved');
  assert.equal(existsSync(path.join(tempHome, 'current', 'baseline.json')), false);
  assert.equal(existsSync(path.join(tempHome, 'current', 'candidate.json')), false);
  assert.equal(existsSync(path.join(tempHome, 'current', 'runner')), false);

  const smokeWithoutExplicitMode = runCli(tempHome, [
    'panel',
    '--publish',
    '--goal',
    'validate vector_add on local C500',
    '--repository',
    'local-c500-demo',
    '--mock',
    '--json',
  ]);
  assert.equal(smokeWithoutExplicitMode.status, 'needs_human');
  const smokeMission = await readJson(tempHome, 'current', 'mission.json');
  assert.equal(smokeMission.agent.operator_id, 'vector_add');
  assert.equal(smokeMission.agent.reason, 'smoke_mode_required');
  assert.equal(existsSync(path.join(tempHome, 'current', 'baseline.json')), false);
  assert.equal(existsSync(path.join(tempHome, 'current', 'candidate.json')), false);

  const ambiguous = runCli(tempHome, [
    'panel',
    '--publish',
    '--goal',
    'improve performance on local C500',
    '--repository',
    'unknown-project',
    '--mock',
    '--json',
  ]);
  assert.equal(ambiguous.status, 'needs_human');
  const ambiguousMission = await readJson(tempHome, 'current', 'mission.json');
  assert.equal(ambiguousMission.status, 'needs_human');
  assert.equal(ambiguousMission.agent.reason, 'operator_identity_unresolved');
  assert.equal(existsSync(path.join(tempHome, 'current', 'baseline.json')), false);
  assert.equal(existsSync(path.join(tempHome, 'current', 'candidate.json')), false);
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

process.stdout.write('[local-c500-no-fallback] unresolved missions stop before baseline/candidate loop\n');
