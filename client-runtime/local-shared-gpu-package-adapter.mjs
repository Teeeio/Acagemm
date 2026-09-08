import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson } from './execution-package-contract.mjs';
import { SHARED_GPU_ENVIRONMENT_ID, SHARED_GPU_TARGET, probeSharedGpuRuntime } from './shared-gpu-runtime.mjs';

export const SHARED_GPU_PACKAGE_ADAPTER = Object.freeze({ id: 'python-shared-gpu', version: '1', languages: ['python'] });

const digest = (value) => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesDigest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 422, retryable: false, details });
const execFileAsync = promisify(execFile);
const checkAbort = (signal, deadline) => {
  if (signal?.aborted) throw Object.assign(new Error('Package preparation was cancelled.'), { code: 'PACKAGE_PREPARE_CANCELLED', resourceRelease: { confirmed: true } });
  if (deadline && Date.parse(deadline) <= Date.now()) throw Object.assign(new Error('Package preparation deadline expired.'), { code: 'PACKAGE_PREPARE_TIMEOUT', resourceRelease: { confirmed: true } });
};

const safeJoin = (root, relative) => {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...relative.split('/'));
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) throw fail('PACKAGE_PATH_INVALID', 'Prepared package path escaped its private root.', { path: relative });
  return target;
};
const regular = async (file) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw fail('PACKAGE_STORAGE_UNSAFE', 'Prepared package contains a non-regular file.');
  return info;
};
const ensureSafeDirectory = async (directory) => {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PACKAGE_STORAGE_UNSAFE', 'Adapter storage ancestors must be real directories.');
  }
};
const validatePythonSources = async (stage, files, deadline) => {
  const python = process.env.OPERATOR_GPU_PYTHON || process.env.PYTHON || 'python';
  const sources = files.filter((file) => file.path.toLowerCase().endsWith('.py')).map((file) => path.join(stage, ...file.path.split('/')));
  if (!sources.length) throw fail('PACKAGE_LANGUAGE_INVALID', 'Python execution packages require at least one .py source file.');
  const script = 'import ast,sys\nfor p in sys.argv[1:]:\n ast.parse(open(p,encoding="utf-8").read(), filename=p)';
  const remaining = Math.max(100, Date.parse(deadline) - Date.now());
  try { await execFileAsync(python, ['-I', '-c', script, ...sources], { cwd: stage, windowsHide: true, timeout: remaining, maxBuffer: 1024 * 1024 }); }
  catch (error) { throw fail(error.killed ? 'PACKAGE_VALIDATION_TIMEOUT' : 'PACKAGE_SOURCE_INVALID', 'Python package source failed syntax validation.', { cause: error.message }); }
};

// Returns the trusted runtime resolver used by the local shared-GPU package
// store. The probe is read-only; its result is the environment identity bound
// into a package manifest and is never inferred from task content.
export const createSharedGpuEnvironmentResolver = ({ probe = probeSharedGpuRuntime, probeOptions = {} } = {}) => {
  return Object.freeze({
    async resolve(environmentId) {
      if (environmentId !== SHARED_GPU_ENVIRONMENT_ID) throw fail('PACKAGE_ENVIRONMENT_UNKNOWN', 'Only the registered local shared-GPU environment is available.', { environmentId });
      const result = await probe(probeOptions);
      if (!result?.environment || result.environment.id !== SHARED_GPU_ENVIRONMENT_ID) throw fail('PACKAGE_ENVIRONMENT_INVALID', 'Shared-GPU probe returned an invalid environment.');
      return structuredClone(result.environment);
    },
    clear() {},
  });
};

const artifactRootFor = (rootDir, packageDigest) => path.join(rootDir, 'prepared', packageDigest.slice(7));
const artifactFileFor = (rootDir, preparedArtifactDigest) => path.join(rootDir, 'artifacts', preparedArtifactDigest.slice(7) + '.json');
const preparationFileFor = (rootDir, preparationId) => path.join(rootDir, 'preparations', preparationId + '.json');

export const readSharedGpuPreparedArtifact = async ({ rootDir, preparedArtifactDigest }) => {
  if (typeof preparedArtifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(preparedArtifactDigest)) throw fail('PACKAGE_DIGEST_INVALID', 'preparedArtifactDigest must be a SHA-256 digest.');
  const recordPath = artifactFileFor(rootDir, preparedArtifactDigest);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (digest(record.identity) !== preparedArtifactDigest) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'Prepared artifact identity changed.');
  return record;
};

export const createSharedGpuPackageAdapter = ({ rootDir } = {}) => {
  if (!rootDir || !path.isAbsolute(rootDir) || path.resolve(rootDir) === path.parse(path.resolve(rootDir)).root) throw new TypeError('Shared-GPU package adapter requires a private absolute root directory.');
  const root = path.resolve(rootDir);
  const assertPreparedRoot = (candidate) => {
    const preparedRoot = path.resolve(root, 'prepared');
    const resolved = path.resolve(candidate || '');
    if (!resolved.startsWith(preparedRoot + path.sep)) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'Prepared artifact root escaped the adapter-owned directory.');
    return resolved;
  };
  const adapter = {
    ...SHARED_GPU_PACKAGE_ADAPTER,
    async prepare({ preparationId, packageDigest, manifest, readBlob, signal, deadline }) {
      checkAbort(signal, deadline);
      const stage = artifactRootFor(root, packageDigest) + '-' + preparationId;
      const files = [];
      try {
        await ensureSafeDirectory(stage);
        for (const layer of manifest.layers) {
          for (const descriptor of layer.files) {
            checkAbort(signal, deadline);
            const bytes = await readBlob(descriptor.digest);
            if (bytes.length !== descriptor.size || bytesDigest(bytes) !== descriptor.digest) throw fail('PACKAGE_CONTENT_CHANGED', 'Package blob does not match its descriptor.', { path: descriptor.path });
            const target = safeJoin(stage, descriptor.path);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes, { flag: 'wx' });
            files.push({ path: descriptor.path, role: layer.role, digest: descriptor.digest, size: descriptor.size });
          }
        }
        checkAbort(signal, deadline);
        await validatePythonSources(stage, files, deadline);
        const identity = { format: 'operator-prepared-artifact/v1', packageDigest, adapter: manifest.adapter, environmentDigest: manifest.environment.digest, target: manifest.target, entrypoints: manifest.entrypoints, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
        const preparedArtifactDigest = digest(identity);
        await ensureSafeDirectory(path.join(root, 'artifacts'));
        const artifactPath = artifactFileFor(root, preparedArtifactDigest);
        try { await writeFile(artifactPath, JSON.stringify({ identity, root: stage }) + '\n', { flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = await readSharedGpuPreparedArtifact({ rootDir: root, preparedArtifactDigest });
          if (canonicalJson(existing.identity) !== canonicalJson(identity)) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'Prepared artifact identity collision.');
          await rm(stage, { recursive: true, force: true });
        }
        await ensureSafeDirectory(path.join(root, 'preparations'));
        await writeFile(preparationFileFor(root, preparationId), JSON.stringify({ preparationId, packageDigest, preparedArtifactDigest, root: stage, status: 'completed', resourceRelease: { confirmed: true } }) + '\n', { flag: 'wx' });
        return { status: 'ready', packageDigest, environmentDigest: manifest.environment.digest, preparedArtifactDigest, resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Package files materialized inside the adapter-owned private root.' } };
      } catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => {});
        if (error.resourceRelease?.confirmed !== true) error.resourceRelease = { confirmed: true };
        throw error;
      }
    },
    async verifyPreparedArtifact({ manifest, environment, preparedArtifactDigest }) {
      const record = await readSharedGpuPreparedArtifact({ rootDir: root, preparedArtifactDigest });
      assertPreparedRoot(record.root);
      if (record.identity.packageDigest !== digest(manifest) || canonicalJson(record.identity.adapter) !== canonicalJson(manifest.adapter)
        || record.identity.environmentDigest !== manifest.environment.digest || canonicalJson(record.identity.target) !== canonicalJson(environment.target)
        || canonicalJson(record.identity.entrypoints) !== canonicalJson(manifest.entrypoints)) return { valid: false };
      const expectedFiles = manifest.layers.flatMap((layer) => layer.files.map((file) => ({ path: file.path, role: layer.role, digest: file.digest, size: file.size }))).sort((a, b) => a.path.localeCompare(b.path));
      if (canonicalJson(record.identity.files) !== canonicalJson(expectedFiles)) return { valid: false };
      for (const file of record.identity.files) {
        const full = safeJoin(record.root, file.path);
        const info = await regular(full);
        if (info.size !== file.size || bytesDigest(await readFile(full)) !== file.digest) return { valid: false };
      }
      return { valid: true, preparedArtifactDigest, root: record.root, entrypoints: record.identity.entrypoints };
    },
    async inspectPreparation({ preparationId }) {
      try {
      const record = JSON.parse(await readFile(preparationFileFor(root, preparationId), 'utf8'));
        return { preparationId, status: record.status || 'completed', resourceRelease: { confirmed: record.resourceRelease?.confirmed === true } };
      } catch (error) {
        if (error.code === 'ENOENT') return { preparationId, status: 'not_started', resourceRelease: { confirmed: true } };
        throw error;
      }
    },
    rootDir: root,
  };
  return Object.freeze(adapter);
};

export const sharedGpuEnvironment = Object.freeze({ id: SHARED_GPU_ENVIRONMENT_ID, target: SHARED_GPU_TARGET });
