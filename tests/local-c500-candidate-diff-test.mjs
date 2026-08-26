import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureWorkspaceDiff, createWorkspaceCheckpoint } from '../tools/local-c500-tester/candidate-admission.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-candidate-diff-'));
const workspace = path.join(tempDir, 'workspace');
const checkpoint = path.join(tempDir, 'checkpoint');

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'run.py'), 'def run():\n    return 1\n', 'utf8');
  await createWorkspaceCheckpoint({ workspaceRoot: workspace, checkpointRoot: checkpoint });

  const clean = await captureWorkspaceDiff({ workspaceRoot: workspace, checkpointRoot: checkpoint });
  assert.equal(clean.dirty, false);
  assert.deepEqual(clean.changedFiles, []);
  assert.equal(clean.digest, null);

  await writeFile(path.join(workspace, 'run.py'), 'def run():\n    return 2\n', 'utf8');
  await writeFile(path.join(workspace, 'manifest.json'), '{"candidate":true}\n', 'utf8');
  const changed = await captureWorkspaceDiff({ workspaceRoot: workspace, checkpointRoot: checkpoint });
  assert.equal(changed.dirty, true);
  assert.deepEqual(changed.changedFiles, ['manifest.json', 'run.py']);
  assert.match(changed.digest, /^sha256:/);
  assert.match(changed.diff, /run\.py/);

  const repeated = await captureWorkspaceDiff({ workspaceRoot: workspace, checkpointRoot: checkpoint });
  assert.equal(repeated.digest, changed.digest);
  assert.deepEqual(repeated.changedFiles, changed.changedFiles);
  assert.equal(await readFile(path.join(workspace, 'manifest.json'), 'utf8'), '{"candidate":true}\n');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-candidate-diff] workspace admission passed\n');
