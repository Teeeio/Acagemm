import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-state-corrupt-'));
const dataDir = path.join(storageRoot, 'data');
const runtimeDir = path.join(storageRoot, 'runtime');
await mkdir(dataDir, { recursive: true });
await mkdir(runtimeDir, { recursive: true });
await writeFile(path.join(dataDir, 'mock-db.json'), '{ this is not valid JSON', 'utf8');

try {
  const script = "import { loadState } from './client-runtime/state-store.mjs'; const state = await loadState({ ensureWorkspace: false }); console.log(JSON.stringify({ schemaVersion: state.schemaVersion, loopStatus: state.iterationStats?.loopStatus, reason: state.iterationStats?.loopStatusReason, code: state.workflowFailure?.code, missionCode: state.missions?.find((m) => m.id === state.activeMissionId)?.workflowFailure?.code }));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: rootDir,
    env: { ...process.env, OPERATOR_DATA_DIR: dataDir, OPERATOR_RUNTIME_DIR: runtimeDir, OPERATOR_RUNTIME_MODE: 'unavailable' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.schemaVersion, 7);
  assert.equal(output.loopStatus, 'needs_human');
  assert.equal(output.reason, 'state_snapshot_corrupt');
  assert.equal(output.code, 'STATE_SNAPSHOT_CORRUPT');
  assert.equal(output.missionCode, 'STATE_SNAPSHOT_CORRUPT');
  const entries = await readdir(dataDir);
  assert.equal(entries.some((entry) => entry.startsWith('mock-db.json.corrupt-')), true);
  const recovered = JSON.parse(await readFile(path.join(dataDir, 'mock-db.json'), 'utf8'));
  assert.equal(recovered.workflowFailure.code, 'STATE_SNAPSHOT_CORRUPT');
  assert.equal(recovered.missions.find((mission) => mission.id === recovered.activeMissionId).workflowFailure.code, 'STATE_SNAPSHOT_CORRUPT');
} finally {
  await rm(storageRoot, { recursive: true, force: true });
}

console.log('[state-corruption-recovery] corrupt snapshots are preserved and recovered as explicit needs_human state');
