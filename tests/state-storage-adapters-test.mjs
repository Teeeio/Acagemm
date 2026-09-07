import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'operator-state-adapters-'));
const environment = { OPERATOR_DATA_DIR: path.join(scratch, 'data'), OPERATOR_RUNTIME_DIR: path.join(scratch, 'runtime'), OPERATOR_RUNTIME_MODE: 'unavailable' };
const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const exists = (target) => stat(target).then(() => true, () => false);
const fault = (code) => Object.assign(new Error(code), { code });

try {
  // Import-time configuration is isolated before loading either adapter.
  const storage = await import('../client-runtime/state-snapshot-storage.mjs');
  const workspace = await import('../client-runtime/state-workspace.mjs');
  assert.deepEqual(await readdir(scratch), [], 'adapter imports must not bootstrap storage');
  await assert.rejects(storage.readStateSnapshot(), (error) => error.code === 'ENOENT');
  assert.equal(await storage.quarantineStateSnapshot(fault('ENOENT')), null);
  assert.deepEqual(await readdir(scratch), []);

  const snapshot = { stateVersion: 41, value: { label: 'candidate' } };
  const before = structuredClone(snapshot);
  const filePath = path.join(scratch, 'virtual', 'mock-db.json');
  const expectedTemporary = filePath + '.' + process.pid + '.fixed-id.tmp';
  const harness = ({ renameErrors = [], writeError = null } = {}) => {
    const files = new Map([[filePath, 'previously committed bytes']]);
    const events = [];
    let attempts = 0;
    const write = storage.createStateSnapshotWriter({
      filePath,
      createId: () => 'fixed-id',
      wait: async (duration) => { events.push(['wait', duration]); },
      filesystem: {
        async mkdir(directory, options) { events.push(['mkdir', directory, options]); },
        async writeFile(target, content, encoding) {
          events.push(['write', target, encoding]);
          assert.equal(target, expectedTemporary);
          assert.equal(files.get(filePath), 'previously committed bytes');
          if (writeError) throw writeError;
          files.set(target, content);
        },
        async rename(source, target) {
          events.push(['rename', source, target]);
          assert.equal(files.get(filePath), 'previously committed bytes', 'final file must not change before rename succeeds');
          assert.equal(files.get(source), JSON.stringify(snapshot, null, 2) + '\n');
          const error = renameErrors[attempts++];
          if (error) throw error;
          files.set(target, files.get(source));
          files.delete(source);
        },
      },
    });
    return { write, files, events, attempts: () => attempts };
  };

  const success = harness();
  assert.equal(await success.write(snapshot), snapshot);
  assert.deepEqual(snapshot, before, 'adapter must not normalize or version state');
  assert.deepEqual(success.events.map((entry) => entry[0]), ['mkdir', 'write', 'rename']);
  assert.equal(success.files.get(filePath), JSON.stringify(snapshot, null, 2) + '\n');
  assert.equal(success.files.has(expectedTemporary), false);

  const retried = harness({ renameErrors: [fault('EPERM'), fault('EACCES')] });
  assert.equal(await retried.write(snapshot), snapshot);
  assert.equal(retried.attempts(), 3);
  assert.deepEqual(retried.events.filter(([kind]) => kind === 'wait').map(([, duration]) => duration), [20, 40]);

  for (const code of ['EPERM', 'EACCES']) {
    const exhaustedError = fault(code);
    const exhausted = harness({ renameErrors: Array(6).fill(exhaustedError) });
    await assert.rejects(exhausted.write(snapshot), (error) => error === exhaustedError);
    assert.equal(exhausted.attempts(), 6);
    assert.deepEqual(exhausted.events.filter(([kind]) => kind === 'wait').map(([, duration]) => duration), [20, 40, 60, 80, 100]);
    assert.equal(exhausted.files.get(filePath), 'previously committed bytes');
    assert.equal(exhausted.files.has(expectedTemporary), true, 'retain failed temporary snapshot for diagnosis');
  }

  const permanentError = fault('EIO');
  const permanent = harness({ renameErrors: [permanentError] });
  await assert.rejects(permanent.write(snapshot), (error) => error === permanentError);
  assert.equal(permanent.attempts(), 1);
  assert.equal(permanent.events.some(([kind]) => kind === 'wait'), false);
  assert.equal(permanent.files.get(filePath), 'previously committed bytes');
  const failedWrite = harness({ writeError: permanentError });
  await assert.rejects(failedWrite.write(snapshot), (error) => error === permanentError);
  assert.equal(failedWrite.attempts(), 0);
  assert.equal(failedWrite.files.get(filePath), 'previously committed bytes');

  await storage.writeStateSnapshot(snapshot);
  assert.deepEqual(await storage.readStateSnapshot(), snapshot);
  assert.deepEqual(await readdir(environment.OPERATOR_DATA_DIR), ['mock-db.json']);
  await writeFile(storage.statePath, '{invalid snapshot', 'utf8');
  await assert.rejects(storage.readStateSnapshot(), SyntaxError);
  assert.equal(await readFile(storage.statePath, 'utf8'), '{invalid snapshot');
  assert.deepEqual(await readdir(environment.OPERATOR_DATA_DIR), ['mock-db.json'], 'raw read must not quarantine or repair');
  const corruptPath = await storage.quarantineStateSnapshot(new SyntaxError('invalid JSON'));
  assert.equal(await readFile(corruptPath, 'utf8'), '{invalid snapshot');
  assert.equal(await exists(storage.statePath), false);

  const bootstrapCalls = [];
  const missionId = 'MIS_ADAPTER';
  const repository = path.join(scratch, 'repository');
  const seed = { activeMissionId: missionId, missions: [{ id: missionId, repository }] };
  const initializer = storage.createStorageInitializer({
    createSeedState: () => { throw new Error('fixture factory must not run in production mode'); },
    createProductState: () => { bootstrapCalls.push('product'); return structuredClone(seed); },
    saveState: async (state) => { bootstrapCalls.push('save'); return storage.writeStateSnapshot(state); },
    ensureMissionWorkspace: async (...args) => { bootstrapCalls.push(['workspace', ...args]); },
  });
  await initializer.ensureStorage({ ensureWorkspace: false });
  assert.deepEqual(bootstrapCalls, ['product', 'save']);
  await initializer.ensureStorage();
  assert.deepEqual(bootstrapCalls, ['product', 'save', ['workspace', missionId, repository]]);
  assert.deepEqual(await storage.readStateSnapshot(), seed);

  // Required initialization must complete before fixture/checkpoint effects.
  assert.throws(() => workspace.createStateWorkspace(), /initializeStorage port/);
  const initializationError = new Error('initialization blocked');
  let initializationCalls = 0;
  const blocked = workspace.createStateWorkspace({ initializeStorage: async () => { initializationCalls += 1; throw initializationError; } });
  await assert.rejects(blocked.applyCandidatePatch(missionId), (error) => error === initializationError);
  await assert.rejects(blocked.createWorkspaceCheckpoint(missionId), (error) => error === initializationError);
  assert.equal(initializationCalls, 2);
  assert.equal(await exists(workspace.workspaceDirForMission(missionId, repository)), false);

  const { workspaceManager } = await import('../client-runtime/workspace-manager.mjs');
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'source.txt'), 'stable baseline\n', 'utf8');
  await workspaceManager.git(['init'], repository);
  await workspaceManager.git(['config', 'user.name', 'Adapter Contract'], repository);
  await workspaceManager.git(['config', 'user.email', 'adapter-test@local.invalid'], repository);
  await workspaceManager.git(['add', '-A'], repository);
  await workspaceManager.git(['commit', '-m', 'isolated baseline'], repository);
  let initialized = false;
  const bound = workspace.createStateWorkspace({ initializeStorage: async () => { initialized = true; await initializer.ensureStorage({ ensureWorkspace: false }); } });
  const checkpoint = await bound.createWorkspaceCheckpoint(missionId, 'candidate', 'candidate-2');
  assert.equal(initialized, true);
  assert.equal(checkpoint.missionId, missionId);
  assert.equal(checkpoint.candidateId, 'candidate-2');
  assert.equal(typeof checkpoint.stableDigest, 'string');
  const target = workspace.workspaceDirForMission(missionId, repository);
  assert.equal(await exists(path.join(target, '.git')), true);
  assert.equal(await exists(path.join(checkpoint.path, '.git')), false);
  await writeFile(path.join(target, 'source.txt'), 'unaccepted candidate\n', 'utf8');
  await writeFile(path.join(target, 'new-candidate.txt'), 'candidate-only\n', 'utf8');
  await workspaceManager.captureDiff(target);

  await assert.rejects(workspace.restoreWorkspaceCheckpoint(null, missionId), (error) => error.code === 'WORKSPACE_CHECKPOINT_MISSING');
  await assert.rejects(workspace.restoreWorkspaceCheckpoint({ ...checkpoint, path: repository }, missionId), (error) => error.code === 'WORKSPACE_CHECKPOINT_INVALID');
  await assert.rejects(workspace.restoreWorkspaceCheckpoint(checkpoint, 'MIS_OTHER'), (error) => error.code === 'WORKSPACE_CHECKPOINT_MISSION_MISMATCH');
  assert.equal(await readFile(path.join(target, 'source.txt'), 'utf8'), 'unaccepted candidate\n', 'rejected restores must not alter workspace');
  await workspace.restoreWorkspaceCheckpoint(checkpoint, missionId);
  assert.equal(await readFile(path.join(target, 'source.txt'), 'utf8'), 'stable baseline\n');
  assert.equal(await exists(path.join(target, 'new-candidate.txt')), false);
  assert.equal(await exists(path.join(target, '.git')), true);
  assert.equal(await readFile(path.join(repository, 'source.txt'), 'utf8'), 'stable baseline\n', 'checkpoint restore must not mutate iteration repository');
  const restoredDiff = await workspaceManager.captureDiff(target);
  assert.deepEqual(restoredDiff.changedFiles, []);
  assert.equal(restoredDiff.digest, checkpoint.stableDigest, 'Git index and files must match the checkpoint');
  assert.equal(await readFile(path.join(checkpoint.path, 'source.txt'), 'utf8'), 'stable baseline\n');
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('operator-state-adapters-'));
  await rm(scratch, { recursive: true, force: true });
}
console.log('[state-storage-adapters] atomic writes, exact retries, read isolation, initialization ports, and checkpoint recovery passed');
