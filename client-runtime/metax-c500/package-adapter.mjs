import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../execution-package-contract.mjs';
import { createSharedGpuPackageAdapter, readSharedGpuPreparedArtifact } from '../local-shared-gpu-package-adapter.mjs';
import { METAX_C500_PACKAGE_ADAPTER, METAX_C500_TARGET, METAX_C500_RUNNER, assertMetaxC500VersionPolicy } from './runtime.mjs';

const digest = (value) => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesDigest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 422, retryable: false, details });
const safeId = (id) => { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw fail('PACKAGE_PREPARATION_ID_INVALID', 'Unsafe preparation id.'); return id; };
const artifactPath = (root, id) => {
  if (!/^sha256:[a-f0-9]{64}$/.test(id || '')) throw fail('PACKAGE_DIGEST_INVALID', 'Expected SHA-256 artifact digest.');
  return path.join(root, 'c500-artifacts', id.slice(7) + '.json');
};
const ensureDirectory = async (directory) => {
  const resolved = path.resolve(directory);
  let cursor = path.parse(resolved).root;
  for (const segment of path.relative(cursor, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { await mkdir(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PACKAGE_STORAGE_UNSAFE', 'C500 storage ancestors must be real directories.');
  }
};
const assertEnvironment = (environment) => {
  if (canonicalJson(environment?.target || {}) !== canonicalJson(METAX_C500_TARGET)
    || environment?.id !== 'metax-c500' || environment?.observed?.vendor !== 'metax'
    || !/\bC500\b/i.test(environment?.observed?.deviceName || '')
    || environment?.observed?.timer?.validated !== true || environment?.observed?.timer?.kind !== 'maca-torch-event'
    || !environment?.observed?.pythonExecutable || !environment?.observed?.mxSmiExecutable) throw fail('PACKAGE_ENVIRONMENT_INVALID', 'Actual pinned C500 environment required.');
  assertMetaxC500VersionPolicy(environment.versionPolicy);
  for (const [key, expected] of Object.entries(environment.versionPolicy)) if (environment.observed.versions?.[key] !== expected) throw fail('PACKAGE_ENVIRONMENT_CHANGED', 'C500 environment and pins differ.', { key });
};
export const readMetaxC500PreparedArtifact = async ({ rootDir, preparedArtifactDigest }) => {
  const file = artifactPath(path.resolve(rootDir), preparedArtifactDigest);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw fail('PACKAGE_STORAGE_UNSAFE', 'Artifact receipt must be a regular file.');
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (digest(record.identity) !== preparedArtifactDigest) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'C500 receipt identity changed.');
  return record;
};

// The host owns process-tree supervision. This adapter never invents a release
// receipt from a subprocess callback, Promise completion or elapsed timeout.
export const createMetaxC500PackageAdapter = ({ rootDir, execFileImpl, prepareLoad } = {}) => {
  if (!rootDir || !path.isAbsolute(rootDir)) throw new TypeError('C500 adapter needs a private absolute root.');
  const root = path.resolve(rootDir);
  const materializedRoot = path.join(root, 'materialized');
  const materializer = createSharedGpuPackageAdapter({ rootDir: materializedRoot, ...(execFileImpl ? { execFileImpl } : {}) });
  const claimPath = (id) => path.join(root, 'c500-preparations', safeId(id) + '.json');
  const saveClaim = async (id, claim, exclusive = false) => {
    await ensureDirectory(path.dirname(claimPath(id)));
    const file = claimPath(id);
    if (exclusive) return writeFile(file, canonicalJson(claim) + '\n', { flag: 'wx' });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, canonicalJson(claim) + '\n', { flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  };
  const artifactFiles = async (buildLoad, preparedRoot) => {
    const files = [];
    for (const artifact of buildLoad.nativeBuild?.artifacts || []) {
      if (typeof artifact.path !== 'string' || !path.isAbsolute(artifact.path)) throw fail('METAX_C500_NATIVE_RECEIPT_INVALID', 'Native artifact must have an owned absolute path.');
      const file = await realpath(artifact.path);
      if (!file.startsWith(preparedRoot + path.sep)) throw fail('METAX_C500_NATIVE_RECEIPT_INVALID', 'Native artifact escaped prepared package.');
      const info = await lstat(artifact.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !/\.(so|pyd|dll)$/i.test(file)) throw fail('METAX_C500_NATIVE_RECEIPT_INVALID', 'Native output must be a regular extension.');
      const current = bytesDigest(await readFile(file));
      if (current !== artifact.digest) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'Loaded native artifact changed.');
      files.push({ path: file, digest: current, size: info.size });
    }
    return files;
  };
  return Object.freeze({
    ...METAX_C500_PACKAGE_ADAPTER, rootDir: root,
    async prepare(input) {
      if (typeof prepareLoad !== 'function') throw fail('METAX_C500_PREPARATION_PORT_REQUIRED', 'Bind the existing supervised execution port for C500 build/load before preparation.');
      const { manifest, environment, preparationId, signal, deadline, packageDigest } = input;
      assertEnvironment(environment);
      if (canonicalJson(manifest.adapter) !== canonicalJson(METAX_C500_PACKAGE_ADAPTER)) throw fail('PACKAGE_ADAPTER_UNAVAILABLE', 'Wrong adapter identity.');
      if (manifest.entrypoints.candidate === manifest.entrypoints.acceptance) throw fail('METAX_C500_ORACLE_INVALID', 'Candidate cannot be its own oracle.');
      const nativeSources = manifest.layers.filter(l => l.role === 'candidate').flatMap(l => l.files)
        .filter(f => /\.(cu|cpp)$/i.test(f.path)).map(f => f.path);
      if (nativeSources.length && !environment.versionPolicy.compiler) throw fail('METAX_C500_COMPILER_REQUIRED', 'Native preparation requires a pinned compiler.');
      // Durable claim precedes materialization/launch. A restart cannot turn an
      // existing materializer success into release of an unknown build worker.
      await saveClaim(preparationId, { preparationId, packageDigest, status: 'preparing', resourceRelease: { confirmed: false } }, true);
      let receipt = null, started = false;
      try {
        const staged = await materializer.prepare(input);
        const artifact = await readSharedGpuPreparedArtifact({ rootDir: materializedRoot, preparedArtifactDigest: staged.preparedArtifactDigest });
        if (signal?.aborted || Date.parse(deadline) <= Date.now()) throw fail('PACKAGE_PREPARATION_TIMEOUT', 'Original C500 preparation deadline expired before build/load.');
        started = true;
        receipt = await prepareLoad({
          preparationId, packageDigest, environmentDigest: manifest.environment.digest,
          target: manifest.target, root: artifact.root, manifest: structuredClone(manifest),
          environment: structuredClone(environment), signal, deadline,
          command: { executable: environment.observed.pythonExecutable, argv: [METAX_C500_RUNNER,
            '--stage', 'prepare-package', '--package-root', artifact.root,
            '--run-py', path.join(artifact.root, ...manifest.entrypoints.candidate.split('/')),
            '--oracle-py', path.join(artifact.root, ...manifest.entrypoints.acceptance.split('/')),
            '--versions-json', JSON.stringify(environment.versionPolicy),
            '--native-sources-json', JSON.stringify(nativeSources),
            '--mx-smi', environment.observed.mxSmiExecutable,
            ...(environment.observed.compilerExecutable ? ['--compiler', environment.observed.compilerExecutable] : [])] },
        });
        if (receipt?.resourceRelease?.confirmed !== true || typeof receipt.resourceRelease.evidenceRef !== 'string' || !receipt.resourceRelease.evidenceRef) throw fail('METAX_C500_PREPARATION_RELEASE_UNCONFIRMED', 'Build/load needs a bound original process-tree release receipt.');
        if (receipt.preparationId !== preparationId || receipt.packageDigest !== packageDigest || receipt.environmentDigest !== manifest.environment.digest) throw fail('METAX_C500_PREPARATION_BINDING_MISMATCH', 'Build/load receipt belongs to another preparation/package/environment.');
        const loaded = receipt.buildLoad;
        if (loaded?.status !== 'passed' || !loaded.candidateLoaded || !loaded.oracleLoaded || !loaded.independentOracle
          || loaded.targetProbe?.vendor !== 'metax' || !/\bC500\b/i.test(loaded.targetProbe?.deviceName || '')
          || loaded.targetProbe?.timer?.validated !== true) throw fail('METAX_C500_BUILD_LOAD_FAILED', 'Both frozen entries must load on actual C500.');
        for (const [key, expected] of Object.entries(environment.versionPolicy)) if (loaded.targetProbe.versions?.[key] !== expected) throw fail('PACKAGE_ENVIRONMENT_CHANGED', 'Runtime changed during C500 build/load.', { key });
        const descriptor = role => manifest.layers.find(l => l.role === role)?.files.find(f => f.path === manifest.entrypoints[role === 'candidate' ? 'candidate' : 'acceptance']);
        if (loaded.candidateRunPyDigest !== descriptor('candidate')?.digest || loaded.oracleDigest !== descriptor('acceptance')?.digest) throw fail('METAX_C500_PREPARATION_BINDING_MISMATCH', 'Loaded entrypoint bytes do not match the frozen layers.');
        const nativeFiles = await artifactFiles(loaded, artifact.root);
        if (nativeSources.length && (loaded.nativeBuild?.loadedExtension !== true || !nativeFiles.length)) throw fail('METAX_C500_NATIVE_BUILD_MISSING', 'Native source requires a loaded, content-bound compiled extension.');
        if (signal?.aborted || Date.parse(deadline) <= Date.now()) throw fail('PACKAGE_PREPARATION_TIMEOUT', 'Late build/load result is not admitted.');
        const identity = { format: 'operator-metax-c500-prepared/v1', packageDigest,
          environmentDigest: manifest.environment.digest, target: manifest.target,
          materializedArtifactDigest: staged.preparedArtifactDigest, buildLoad: loaded,
          resourceRelease: receipt.resourceRelease, nativeFiles };
        const preparedArtifactDigest = digest(identity);
        await ensureDirectory(path.join(root, 'c500-artifacts'));
        await writeFile(artifactPath(root, preparedArtifactDigest), canonicalJson({ identity, root: artifact.root }) + '\n', { flag: 'wx' });
        await saveClaim(preparationId, { preparationId, packageDigest, status: 'completed', preparedArtifactDigest, resourceRelease: receipt.resourceRelease });
        return { status: 'ready', packageDigest, environmentDigest: manifest.environment.digest, preparedArtifactDigest, resourceRelease: receipt.resourceRelease };
      } catch (error) {
        // A malformed/foreign release receipt cannot release this preparation.
        const bound = receipt?.preparationId === preparationId && receipt?.packageDigest === packageDigest && receipt?.environmentDigest === manifest.environment.digest;
        const release = started ? (bound && receipt?.resourceRelease?.confirmed === true && receipt.resourceRelease.evidenceRef ? receipt.resourceRelease : { confirmed: false })
          : (error.resourceRelease || { confirmed: true, reason: 'No C500 build/load worker was started.' });
        error.resourceRelease = release;
        await saveClaim(preparationId, { preparationId, packageDigest, status: release.confirmed ? 'failed' : 'unknown', resourceRelease: release });
        throw error;
      }
    },
    async verifyPreparedArtifact({ manifest, environment, preparedArtifactDigest }) {
      assertEnvironment(environment);
      const record = await readMetaxC500PreparedArtifact({ rootDir: root, preparedArtifactDigest });
      if (record.identity.packageDigest !== digest(manifest) || record.identity.environmentDigest !== environment.digest
        || canonicalJson(record.identity.target) !== canonicalJson(environment.target)) return { valid: false };
      const materialized = await materializer.verifyPreparedArtifact({ manifest, environment, preparedArtifactDigest: record.identity.materializedArtifactDigest });
      if (!materialized.valid || materialized.root !== record.root) return { valid: false };
      const files = await artifactFiles(record.identity.buildLoad, record.root);
      if (canonicalJson(files) !== canonicalJson(record.identity.nativeFiles)) return { valid: false };
      return { valid: true, preparedArtifactDigest, root: record.root, entrypoints: manifest.entrypoints, buildLoad: record.identity.buildLoad };
    },
    async inspectPreparation({ preparationId }) {
      try {
        const info = await lstat(claimPath(preparationId));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw fail('PACKAGE_STORAGE_UNSAFE', 'C500 preparation receipt must be regular.');
        const claim = JSON.parse(await readFile(claimPath(preparationId), 'utf8'));
        return { preparationId, status: claim.status, resourceRelease: claim.resourceRelease };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { preparationId, status: 'not_started', resourceRelease: { confirmed: true } };
      }
    },
  });
};
