import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, assertPackagePath, assertContentDigest, validateExecutionManifest, assertAdmissionBinding, EXECUTION_PACKAGE_FORMAT, EXECUTION_ADMISSION_FORMAT, EXECUTION_VALIDATOR_VERSION } from './execution-package-contract.mjs';

export const contentDigest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const jsonDigest = (value) => contentDigest(canonicalJson(value));
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 422, retryable: false, details });
const locks = new Map();
const exclusive = (key, operation) => {
  key = process.platform === 'win32' ? key.toLowerCase() : key;
  const result = (locks.get(key) || Promise.resolve()).then(operation, operation);
  const tail = result.catch(() => {});
  locks.set(key, tail);
  return result.finally(() => { if (locks.get(key) === tail) locks.delete(key); });
};
const ensureDirectoryTree = async (directory, { create = false } = {}) => {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current); } catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PACKAGE_STORAGE_UNSAFE', 'Package storage ancestors must be real directories, never symlinks or junctions.');
  }
};
const readRegular = async (file) => {
  await ensureDirectoryTree(path.dirname(file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw fail('PACKAGE_STORAGE_UNSAFE', 'Package storage must contain regular files only.');
  return readFile(file);
};
const atomicJson = async (file, value) => {
  await ensureDirectoryTree(path.dirname(file), { create: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, canonicalJson(value) + '\n', { flag: 'wx' });
    await ensureDirectoryTree(path.dirname(file));
    try { await readRegular(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
};
const parse = async (file) => JSON.parse(await readRegular(file));

const inspectWithin = async (query, timeoutMs = 5000) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail('PACKAGE_INSPECTION_TIMEOUT', 'Inspection deadline has expired.');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => query({ signal: controller.signal, deadline: new Date(Date.now() + timeoutMs).toISOString() })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = fail('PACKAGE_INSPECTION_TIMEOUT', 'Read-only adapter inspection exceeded its deadline.');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
};

const decode = (value) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value?.encoding === 'utf8' && typeof value.content === 'string') return Buffer.from(value.content, 'utf8');
  if (value?.encoding === 'base64' && typeof value.content === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content)) return Buffer.from(value.content, 'base64');
  throw fail('PACKAGE_FILE_ENCODING_INVALID', 'Files require UTF-8 text or canonical base64 bytes.');
};

// Trusted adapter boundary. Environment.resolve must inspect the actual locked
// runtime/layers, not return the caller's environment declaration.
export const createExecutionPackageStore = ({ rootDir, environments, adapters, now = () => new Date(), admissionTtlMs = 60 * 60 * 1000 } = {}) => {
  if (!rootDir || typeof environments?.resolve !== 'function' || !adapters) throw new TypeError('Package store requires rootDir, trusted environments and language adapters.');
  if (!path.isAbsolute(rootDir) || path.resolve(rootDir) === path.parse(path.resolve(rootDir)).root) throw new TypeError('Package store requires a specific absolute private directory.');
  if (!Number.isSafeInteger(admissionTtlMs) || admissionTtlMs <= 0 || admissionTtlMs > 86400000) throw new TypeError('Admission TTL must be a positive integer no longer than one day.');
  const root = path.resolve(rootDir);
  const named = (kind, digest) => path.join(root, kind, assertContentDigest(digest).slice(7) + '.json');
  const blobPath = (digest) => path.join(root, 'blobs', assertContentDigest(digest).slice(7));
  const readBlob = async (digest) => {
    const bytes = await readRegular(blobPath(digest));
    if (contentDigest(bytes) !== digest) throw fail('PACKAGE_CONTENT_CHANGED', 'Stored package bytes do not match their digest.', { digest });
    return bytes;
  };
  const storeBlob = async (bytes) => {
    const digest = contentDigest(bytes);
    await ensureDirectoryTree(path.join(root, 'blobs'), { create: true });
    try { await writeFile(blobPath(digest), bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await readBlob(digest); }
    return digest;
  };
  const resolveEnvironment = async (manifest) => {
    const environment = await inspectWithin((options) => environments.resolve(manifest.environment.id, options));
    if (!environment || environment.digest !== manifest.environment.digest) throw fail('PACKAGE_ENVIRONMENT_CHANGED', 'Locked runtime/dependency environment changed; validate a new package.');
    if (canonicalJson(environment.target) !== canonicalJson(manifest.target)) throw fail('PACKAGE_TARGET_UNSUPPORTED', 'Package target does not match the locked environment.');
    return environment;
  };
  const validate = async (packageDigest) => {
    const manifest = validateExecutionManifest(await parse(named('manifests', packageDigest)));
    if (jsonDigest(manifest) !== packageDigest) throw fail('PACKAGE_MANIFEST_CHANGED', 'Manifest content does not match package identity.');
    for (const layer of manifest.layers) {
      if (jsonDigest({ role: layer.role, files: layer.files }) !== layer.digest) throw fail('PACKAGE_LAYER_CHANGED', 'Layer content does not match its identity.');
      for (const file of layer.files) {
        const bytes = await readBlob(file.digest);
        if (bytes.length !== file.size) throw fail('PACKAGE_FILE_SIZE_CHANGED', 'File byte count changed.', { path: file.path });
      }
    }
    const specification = JSON.parse(await readBlob(manifest.acceptance.testSpecDigest));
    if (jsonDigest(specification) !== manifest.acceptance.testSpecDigest) throw fail('PACKAGE_TEST_SPEC_CHANGED', 'Frozen test specification changed.');
    const environment = await resolveEnvironment(manifest);
    return { manifest, environment, testSpec: specification };
  };
  const assemble = async (input) => {
    const environment = await inspectWithin((options) => environments.resolve(input.environmentId, options));
    if (!environment?.digest || !environment.target) throw fail('PACKAGE_ENVIRONMENT_UNKNOWN', 'Choose a registered locked environment.');
    const layers = [];
    const contents = [];
    for (const [role, files] of [['candidate', input.candidateFiles], ['dependency', input.dependencyFiles || {}], ['acceptance', input.acceptance?.files]]) {
      if (!files || typeof files !== 'object' || Array.isArray(files)) throw fail('PACKAGE_FILES_INVALID', 'Each layer requires an explicit path-to-content map.');
      const descriptors = [];
      for (const name of Object.keys(files).sort()) {
        assertPackagePath(name);
        const bytes = decode(files[name]);
        const digest = contentDigest(bytes);
        descriptors.push({ path: name, type: 'file', size: bytes.length, digest });
        contents.push(bytes);
      }
      layers.push({ role, id: role, digest: jsonDigest({ role, files: descriptors }), files: descriptors });
    }
    const specBytes = Buffer.from(canonicalJson(input.acceptance?.testSpec), 'utf8');
    const manifest = validateExecutionManifest({
      format: EXECUTION_PACKAGE_FORMAT, schemaVersion: 1, language: input.language,
      adapter: input.adapter, binding: input.binding,
      environment: { id: input.environmentId, digest: environment.digest },
      target: environment.target, build: input.build || {},
      entrypoints: { candidate: input.candidateEntrypoint, acceptance: input.acceptance?.entrypoint },
      layers, acceptance: { digest: layers[2].digest, testSpecDigest: contentDigest(specBytes), semanticDigest: input.acceptance?.semanticDigest },
    });
    const packageDigest = jsonDigest(manifest);
    for (const bytes of [...contents, specBytes]) await storeBlob(bytes);
    await exclusive(named('manifests', packageDigest), async () => {
      try {
        if (canonicalJson(await parse(named('manifests', packageDigest))) !== canonicalJson(manifest)) throw fail('PACKAGE_MANIFEST_CHANGED', 'Existing package record is corrupt.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicJson(named('manifests', packageDigest), manifest);
      }
    });
    return { packageDigest, manifest };
  };
  const adapterFor = (manifest) => {
    const adapter = adapters[manifest.adapter.id];
    if (!adapter || adapter.version !== manifest.adapter.version || !adapter.languages?.includes(manifest.language)
      || typeof adapter.prepare !== 'function' || typeof adapter.verifyPreparedArtifact !== 'function') throw fail('PACKAGE_ADAPTER_UNSUPPORTED', 'No matching language/adapter and prepared-artifact verifier is registered.');
    return adapter;
  };
  const recordPreparation = (file, preparationId, record) => exclusive(file, async () => {
    const current = await parse(file);
    if (current.preparationId !== preparationId) return false;
    await atomicJson(file, record);
    return true;
  });
  const prepare = async (packageDigest, { timeoutMs = 30000 } = {}) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw fail('PACKAGE_PREPARE_LIMIT_INVALID', 'Preparation needs a positive deadline no longer than 120 seconds.');
    const { manifest, environment, testSpec } = await validate(packageDigest);
    const adapter = adapterFor(manifest);
    if (environment.isolation?.enforced !== true || !['container', 'namespace', 'appcontainer', 'windows-sandbox'].includes(environment.isolation.kind)) {
      throw fail('EXECUTION_ISOLATION_UNAVAILABLE', 'Target lacks enforced OS-level package isolation. Configure an admitted local environment; ordinary Python is not a sandbox.');
    }
    const recordPath = named('preparations', packageDigest);
    const startedAt = now().toISOString();
    const preparationId = 'prepare_' + randomUUID();
    const deadline = new Date(Date.parse(startedAt) + timeoutMs).toISOString();
    await exclusive(recordPath, async () => {
      let previous;
      try { previous = await parse(recordPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous && (previous.packageDigest !== packageDigest || !previous.preparationId
        || !['ready', 'rejected'].includes(previous.status) || previous.resourceRelease?.confirmed !== true)) throw fail('PACKAGE_PREPARATION_UNCONFIRMED', 'Prior preparation is invalid or has not confirmed resource release; reconcile it before retry.', { preparationId: previous.preparationId || null, deadline: previous.deadline || null });
      await atomicJson(recordPath, { status: 'preparing', packageDigest, preparationId, startedAt, deadline });
    });
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    let releaseConfirmed = false;
    const execution = Promise.resolve().then(() => adapter.prepare({ preparationId, packageDigest, manifest, environment, testSpec, readBlob, signal: controller.signal, deadline }));
    const deadlinePromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(fail('PACKAGE_PREPARE_TIMEOUT', 'Preparation deadline exceeded.'));
        reject(fail('PACKAGE_PREPARE_TIMEOUT', 'Preparation did not finish before its deadline; resources remain quarantined until the adapter settles.', { preparationId, deadline, resourceRelease: { confirmed: false } }));
      }, timeoutMs);
    });
    // This race does not release the claim. Unknown side effects remain durable
    // and block retries, including after runtime restart.
    try {
      const result = await Promise.race([execution, deadlinePromise]);
      clearTimeout(timer);
      releaseConfirmed = result?.resourceRelease?.confirmed === true;
      if (controller.signal.aborted || now().getTime() >= Date.parse(deadline)) throw fail('PACKAGE_PREPARE_TIMEOUT', 'Late preparation cannot authorize submission.');
      if (result?.status !== 'ready' || result.resourceRelease?.confirmed !== true
        || result.packageDigest !== packageDigest || result.environmentDigest !== manifest.environment.digest) throw fail('PACKAGE_PREPARE_INVALID', 'Adapter did not return a matching, released, ready preparation.');
      assertContentDigest(result.preparedArtifactDigest, 'preparedArtifactDigest');
      await validate(packageDigest);
      if (now().getTime() >= Date.parse(deadline)) throw fail('PACKAGE_PREPARE_TIMEOUT', 'Preparation deadline expired during content revalidation.');
      const verifiedArtifact = await inspectWithin((options) => adapter.verifyPreparedArtifact({ manifest, environment, preparedArtifactDigest: result.preparedArtifactDigest, ...options }), Math.min(5000, Date.parse(deadline) - now().getTime()));
      if (verifiedArtifact?.valid !== true) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'Target preparation artifact is absent or changed.');
      if (controller.signal.aborted || now().getTime() >= Date.parse(deadline)) throw fail('PACKAGE_PREPARE_TIMEOUT', 'Admission cannot be issued after preparation deadline.');
      const issuedAt = now().toISOString();
      const admission = {
        format: EXECUTION_ADMISSION_FORMAT, validatorVersion: EXECUTION_VALIDATOR_VERSION,
        status: 'ready', packageDigest, environmentDigest: manifest.environment.digest,
        acceptanceDigest: manifest.acceptance.digest, adapter: manifest.adapter,
        target: manifest.target, build: manifest.build, preparationId,
        preparedArtifactDigest: result.preparedArtifactDigest, issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + admissionTtlMs).toISOString(),
      };
      const admissionId = jsonDigest(admission);
      await atomicJson(named('admissions', admissionId), admission);
      await recordPreparation(recordPath, preparationId, { status: 'ready', preparationId, packageDigest, admissionId, startedAt, deadline, resourceRelease: { confirmed: true } });
      if (now().getTime() >= Date.parse(deadline)) throw fail('PACKAGE_PREPARE_TIMEOUT', 'Late admission was discarded.');
      return { admissionId, ...admission };
    } catch (error) {
      await recordPreparation(recordPath, preparationId, { status: releaseConfirmed || error.resourceRelease?.confirmed === true ? 'rejected' : 'quarantined', preparationId, packageDigest, startedAt, deadline, error: { code: error.code || 'PACKAGE_PREPARE_FAILED', message: error.message }, resourceRelease: { confirmed: releaseConfirmed || error.resourceRelease?.confirmed === true } });
      throw error;
    } finally {
      clearTimeout(timer);
      if (timedOut) execution.then(
        (result) => result?.resourceRelease?.confirmed === true
          ? recordPreparation(recordPath, preparationId, { status: 'rejected', preparationId, packageDigest, startedAt, deadline, error: { code: 'PACKAGE_PREPARE_LATE', message: 'Late preparation was discarded; prepare again.' }, resourceRelease: { confirmed: true } })
          : null,
        (error) => error?.resourceRelease?.confirmed === true
          ? recordPreparation(recordPath, preparationId, { status: 'rejected', preparationId, packageDigest, startedAt, deadline, error: { code: error.code || 'PACKAGE_PREPARE_FAILED', message: error.message }, resourceRelease: { confirmed: true } })
          : null
      ).catch(() => {});
    }
  };

  const reconcilePreparation = async (packageDigest, { timeoutMs = 5000 } = {}) => {
    const recordPath = named('preparations', packageDigest);
    const record = await parse(recordPath);
    if (record.packageDigest !== packageDigest || typeof record.preparationId !== 'string'
      || !['preparing', 'quarantined', 'ready', 'rejected'].includes(record.status)) throw fail('PACKAGE_PREPARATION_INVALID', 'Preparation record is corrupt; do not assume resources are released.');
    if (['ready', 'rejected'].includes(record.status) && record.resourceRelease?.confirmed === true) return record;
    const manifest = validateExecutionManifest(await parse(named('manifests', packageDigest)));
    if (jsonDigest(manifest) !== packageDigest) throw fail('PACKAGE_MANIFEST_CHANGED', 'Manifest changed during recovery.');
    const adapter = adapterFor(manifest);
    if (typeof adapter.inspectPreparation !== 'function') throw fail('PACKAGE_PREPARATION_UNCONFIRMED', 'The owning adapter cannot authoritatively inspect preparation; keep the resource claim.', { preparationId: record.preparationId });
    const snapshot = await inspectWithin((options) => adapter.inspectPreparation({ preparationId: record.preparationId, packageDigest, ...options }), timeoutMs);
    if (snapshot?.preparationId !== record.preparationId || snapshot.resourceRelease?.confirmed !== true
      || !['not_started', 'completed', 'failed', 'cancelled'].includes(snapshot.status)) return { ...record, nextAction: 'Owning adapter must confirm that preparation resources have stopped.' };
    await recordPreparation(recordPath, record.preparationId, {
      ...record, status: 'rejected', resourceRelease: { confirmed: true },
      reconciledAt: now().toISOString(), error: { code: 'PACKAGE_PREPARATION_RECOVERED', message: 'Prior preparation was reconciled; validate and prepare again before submission.' },
    });
    return parse(recordPath);
  };

  const verifyAdmission = async (request) => {
    const { manifest, environment, testSpec } = await validate(request.packageDigest);
    let admission;
    try { admission = await parse(named('admissions', request.admissionId)); }
    catch (error) { if (error.code === 'ENOENT') throw fail('PACKAGE_NOT_ADMITTED', 'No trusted admission exists.'); throw error; }
    if (jsonDigest(admission) !== request.admissionId) throw fail('PACKAGE_ADMISSION_CHANGED', 'Trusted admission record changed.');
    assertAdmissionBinding({ request, manifest, admission, nowMs: now().getTime() });
    const preparation = await parse(named('preparations', request.packageDigest));
    if (preparation.status !== 'ready' || preparation.preparationId !== admission.preparationId
      || preparation.admissionId !== request.admissionId || preparation.resourceRelease?.confirmed !== true) throw fail('PACKAGE_NOT_ADMITTED', 'Admission preparation was superseded or is no longer ready.');
    const adapter = adapterFor(manifest);
    if (environment.isolation?.enforced !== true || !['container', 'namespace', 'appcontainer', 'windows-sandbox'].includes(environment.isolation.kind)) throw fail('EXECUTION_ISOLATION_UNAVAILABLE', 'Target OS isolation is no longer enforced.');
    const artifact = await inspectWithin((options) => adapter.verifyPreparedArtifact({ manifest, environment, preparedArtifactDigest: admission.preparedArtifactDigest, ...options }), Math.min(5000, Date.parse(request.deadline) - now().getTime()));
    if (artifact?.valid !== true) throw fail('PACKAGE_PREPARED_ARTIFACT_CHANGED', 'Admitted preparation artifact changed.');
    assertAdmissionBinding({ request, manifest, admission, nowMs: now().getTime() });
    const latest = await parse(named('preparations', request.packageDigest));
    if (latest.status !== 'ready' || latest.admissionId !== request.admissionId) throw fail('PACKAGE_NOT_ADMITTED', 'Preparation changed during admission inspection.');
    return { manifest, environment, testSpec, admission };
  };
  return Object.freeze({ assemble, validate, prepare, reconcilePreparation, verifyAdmission, readBlob });
};
