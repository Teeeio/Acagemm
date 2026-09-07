import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyExperienceStore, experienceError, EXPERIENCE_LIMITS, validateExperienceStore } from './experience-contract.mjs';

// All factory instances share this queue. No cross-process lock is claimed.
const queues = new Map();
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const fail = (code, message, cause) => Object.assign(experienceError(code, message, 503), { cause });

export function createExperienceRepository({ rootDir, filesystem = nodeFs } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir) || rootDir.includes('\0')) throw experienceError('EXPERIENCE_STORAGE_PATH_INVALID', 'rootDir must be an explicit absolute storage directory');
  const root = path.resolve(rootDir);
  if (root === path.parse(root).root) throw experienceError('EXPERIENCE_STORAGE_PATH_INVALID', 'rootDir must not be a filesystem root');
  const filename = path.join(root, 'experiences.json');
  const queueKey = process.platform === 'win32' ? filename.toLowerCase() : filename;
  for (const method of ['lstat', 'mkdir', 'readFile', 'open', 'rename', 'unlink']) {
    if (typeof filesystem[method] !== 'function') throw new TypeError(`filesystem.${method} is required`);
  }
  const serialized = (action) => {
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const current = previous.then(action, action);
    const tail = current.then(() => undefined, () => undefined);
    queues.set(queueKey, tail);
    void tail.then(() => { if (queues.get(queueKey) === tail) queues.delete(queueKey); });
    return current;
  };
  const checkPath = async () => {
    const parsed = path.parse(root);
    let segment = parsed.root;
    for (const part of path.relative(parsed.root, root).split(path.sep).filter(Boolean)) {
      segment = path.join(segment, part);
      let stat;
      try { stat = await filesystem.lstat(segment); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw experienceError('EXPERIENCE_STORAGE_PATH_INVALID', 'Experience storage ancestors must be real directories');
    }
    let stat;
    try { stat = await filesystem.lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw experienceError('EXPERIENCE_STORAGE_PATH_INVALID', 'Experience store must be an unlinked regular file');
    if (stat.size > EXPERIENCE_LIMITS.storeBytes) throw fail('EXPERIENCE_STORE_CORRUPT', 'Experience store exceeds the byte limit');
  };
  const load = async () => {
    let raw;
    try {
      await checkPath();
      raw = await filesystem.readFile(filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyExperienceStore();
      if (String(error.code).startsWith('EXPERIENCE_')) throw error;
      throw fail('EXPERIENCE_STORE_READ_FAILED', 'Cannot read experience store', error);
    }
    try {
      if (Buffer.byteLength(raw) > EXPERIENCE_LIMITS.storeBytes) throw new Error('oversized store');
      return validateExperienceStore(JSON.parse(raw));
    } catch (error) {
      throw fail('EXPERIENCE_STORE_CORRUPT', 'Experience store is corrupt or unsupported; existing bytes were preserved', error);
    }
  };
  const persist = async (store) => {
    const temporary = path.join(root, `.experiences.${randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      await checkPath();
      await filesystem.mkdir(root, { recursive: true });
      await checkPath();
      const bytes = JSON.stringify(store) + '\n';
      if (Buffer.byteLength(bytes) > EXPERIENCE_LIMITS.storeBytes) throw experienceError('EXPERIENCE_CAPACITY', 'Experience store byte capacity reached', 409);
      handle = await filesystem.open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await checkPath();
      await filesystem.rename(temporary, filename);
      created = false;
    } catch (error) {
      if (String(error.code).startsWith('EXPERIENCE_')) throw error;
      throw fail('EXPERIENCE_STORE_WRITE_FAILED', 'Atomic experience store replacement failed', error);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) await filesystem.unlink(temporary).catch(() => {});
    }
  };
  return Object.freeze({
    path: filename,
    read: () => serialized(async () => clone(await load())),
    transact: (mutator) => serialized(async () => {
      if (typeof mutator !== 'function') throw new TypeError('transact requires a synchronous mutator');
      const current = await load();
      const draft = clone(current);
      const outcome = mutator(draft);
      if (outcome && typeof outcome.then === 'function') {
        void Promise.resolve(outcome).catch(() => {});
        throw new TypeError('mutator must return { changed, result } synchronously');
      }
      if (!outcome || typeof outcome !== 'object' || typeof outcome.changed !== 'boolean') throw new TypeError('mutator must return { changed, result } synchronously');
      if (!outcome.changed) {
        if (JSON.stringify(draft) !== JSON.stringify(current)) throw new TypeError('A no-op transaction must not mutate its draft');
        return clone(outcome.result);
      }
      draft.revision = current.revision + 1;
      validateExperienceStore(draft);
      if (draft.schemaVersion !== current.schemaVersion || draft.records.length <= current.records.length || JSON.stringify(draft.records.slice(0, current.records.length)) !== JSON.stringify(current.records)) {
        throw experienceError('EXPERIENCE_HISTORY_CONFLICT', 'A transaction must append revisions without rewriting existing history', 409);
      }
      const result = clone(outcome.result);
      await persist(draft);
      return result;
    }),
  });
}
