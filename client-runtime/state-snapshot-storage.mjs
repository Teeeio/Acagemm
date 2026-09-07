import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDir, legacyDataDir, legacyRuntimeDir, runtimeDir, usesManagedStorage } from './storage-paths.mjs';

export const statePath = path.join(dataDir, 'mock-db.json');
const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

export const readStateSnapshot = async () => JSON.parse(await readFile(statePath, 'utf8'));

export const createStateSnapshotWriter = ({ filePath = statePath, filesystem = { mkdir, writeFile, rename }, createId = randomUUID, wait = delay } = {}) => async (state) => {
  await filesystem.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${createId()}.tmp`;
  await filesystem.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try { await filesystem.rename(temporaryPath, filePath); break; }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      await wait(20 * (attempt + 1));
    }
  }
  return state;
};
export const writeStateSnapshot = createStateSnapshotWriter();

export const quarantineStateSnapshot = async (error) => {
  const corruptPath = error?.code === 'ENOENT' ? null : `${statePath}.corrupt-${Date.now()}`;
  if (corruptPath) await rename(statePath, corruptPath);
  return corruptPath;
};

// Factories and commits are ports; this adapter never imports the state facade.
export const createStorageInitializer = ({ createSeedState, createProductState, saveState, ensureMissionWorkspace }) => {
  async function ensureStorage({ ensureWorkspace = true } = {}) {
    if (usesManagedStorage) {
      await mkdir(path.dirname(dataDir), { recursive: true });
      if (!(await exists(statePath)) && await exists(path.join(legacyDataDir, 'mock-db.json'))) {
        await cp(legacyDataDir, dataDir, { recursive: true });
      }
      const migrationMarker = path.join(dataDir, 'storage-migration-v1.json');
      if (!(await exists(migrationMarker)) && await exists(legacyRuntimeDir)) {
        await mkdir(runtimeDir, { recursive: true });
        const retainedRuntimeEntries = ['agent-bridge', 'checkpoints', 'workspaces', 'operator-test-queue.jsonl'];
        for (const name of retainedRuntimeEntries) {
          const source = path.join(legacyRuntimeDir, name);
          const target = path.join(runtimeDir, name);
          if (await exists(source) && !(await exists(target))) {
            await cp(source, target, {
              recursive: true,
              filter: (entry) => path.basename(entry).toLowerCase() !== '.git',
            });
          }
        }
        await writeFile(migrationMarker, `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), retainedRuntimeEntries }, null, 2)}\n`, 'utf8');
      }
    }
    await mkdir(dataDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    let missionId = 'MIS_01JH7R';
    let repository = 'mla-kernels';
    if (!(await exists(statePath))) {
      const seed = process.env.OPERATOR_RUNTIME_MODE === 'reference-fixture' ? createSeedState() : createProductState();
      missionId = seed.activeMissionId;
      repository = seed.missions.find((mission) => mission.id === missionId)?.repository || repository;
      await saveState(seed);
    } else {
      try {
        const stored = JSON.parse(await readFile(statePath, 'utf8'));
        missionId = stored.activeMissionId || missionId;
        repository = stored.missions?.find((mission) => mission.id === missionId)?.repository || repository;
      } catch { /* loadState reports malformed JSON separately */ }
    }
    if (ensureWorkspace) await ensureMissionWorkspace(missionId, repository);
  }
  return Object.freeze({ ensureStorage });
};
