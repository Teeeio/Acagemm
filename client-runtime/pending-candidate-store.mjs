import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, contentDigest, assertPackagePath } from './execution-package-contract.mjs';
import { assertKnownOperatorLanguage, normalizeOperatorLanguage } from './operator-language.mjs';
import { semanticTestSpecDigest } from './semantic-snapshot.mjs';
import { normalizeMissionTargetProfile } from './mission-target-profile.mjs';
import { PENDING_CANDIDATE_SCHEMA, PENDING_CANDIDATE_BUNDLE_SCHEMA, PENDING_CANDIDATE_LIMITS,
  reviewedPendingSourceBoundary, assertPendingCandidateManifest as validateIdentity, assertPendingCandidateBundle as validateBundle } from './pending-candidate-bundle-contract.mjs';
export { PENDING_CANDIDATE_SCHEMA, PENDING_CANDIDATE_BUNDLE_SCHEMA, PENDING_CANDIDATE_LIMITS,
  assertPendingCandidateBundle } from './pending-candidate-bundle-contract.mjs';

const fail = (code, message, details = {}) => Object.assign(new Error(message), {
  code: `PENDING_CANDIDATE_${code}`, status: code === 'LIMIT_EXCEEDED' ? 413 : 409, retryable: false, details,
});
const hashJson = (value) => contentDigest(canonicalJson(value));
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    throw fail('IDENTITY_INVALID', `${field} must be a nonempty bounded string.`, { field });
  }
  return value;
};
const jsonClone = (value) => {
  try { return JSON.parse(canonicalJson(value)); }
  catch { throw fail('INVALID', 'Frozen metadata must be finite, acyclic plain JSON.'); }
};
const checkLimit = (size, limit, label) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw fail('LIMIT_EXCEEDED', `${label} exceeds its limit.`, { size, limit });
};
const sourcePath = (value) => {
  try { assertPackagePath(value); } catch { throw fail('PATH_INVALID', 'Source paths must be portable relative paths.', { path: value }); }
  if (/[<>"|?*]/.test(value) || value.split('/').some((part) => ['.git', '.operator-studio'].includes(part.toLowerCase()))) {
    throw fail('PATH_INVALID', 'Reserved or ambiguous source path.', { path: value });
  }
  return value;
};
const absolutePath = (value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw fail('PATH_INVALID', 'An absolute local path is required.');
  return path.resolve(value);
};
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const ensureDirectories = async (directory, create = false) => {
  const absolute = absolutePath(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('STORAGE_UNSAFE', 'Directory links, junctions and non-directories are refused.');
  }
};
const regular = (info) => {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw fail('STORAGE_UNSAFE', 'Only single-link regular files are allowed.');
};
const sameVersion = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const readRegular = async (file, maxBytes) => {
  await ensureDirectories(path.dirname(file));
  const before = await lstat(file);
  regular(before);
  checkLimit(before.size, maxBytes, 'File bytes');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    regular(opened);
    if (!sameVersion(before, opened)) throw fail('SOURCE_CHANGED', 'File changed before it could be read.');
    const chunks = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      checkLimit(size, maxBytes, 'File bytes');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await ensureDirectories(path.dirname(file));
    const after = await lstat(file);
    regular(after);
    if (!sameVersion(before, after) || !sameVersion(before, await handle.stat())) throw fail('SOURCE_CHANGED', 'File changed while being read.');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
};
const checkFilePaths = (files) => {
  const names = new Map();
  const prefixes = new Map();
  for (const file of files) {
    sourcePath(file.path);
    const key = file.path.toLowerCase();
    if (names.has(key) || [...names.keys()].some((name) => name.startsWith(`${key}/`) || key.startsWith(`${name}/`))) {
      throw fail('PATH_INVALID', 'Source file paths collide.');
    }
    names.set(key, true);
    const parts = file.path.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      const prefix = parts.slice(0, length).join('/');
      if (prefixes.has(prefix.toLowerCase()) && prefixes.get(prefix.toLowerCase()) !== prefix) throw fail('PATH_INVALID', 'Source directory casing collides.');
      prefixes.set(prefix.toLowerCase(), prefix);
    }
  }
};
const declaredPaths = (manifest) => {
  const declarations = [manifest.mission.sourceFiles, manifest.mission.sourcePolicy?.sourceFiles,
    manifest.mission.implementation?.sourceFiles, manifest.candidate.sourceFiles];
  const names = [];
  for (const items of declarations) {
    if (items == null) continue;
    if (!Array.isArray(items)) throw fail('INVALID', 'sourceFiles must be an array.');
    for (const item of items) names.push(sourcePath(typeof item === 'string' ? item : item?.path));
  }
  return [...new Set(names)];
};
const languagePaths = (manifest) => {
  try { assertKnownOperatorLanguage(manifest.mission.implementation); }
  catch { throw fail('LANGUAGE_UNSUPPORTED', 'Unknown or conflicting implementation language.'); }
  const language = normalizeOperatorLanguage(manifest.mission.implementation);
  const files = manifest.mission.operatorProfile?.candidateContract?.allowedFiles || language.allowedFiles;
  if (!Array.isArray(files)) throw fail('INVALID', 'The language file contract must be an explicit list.');
  return files.map(sourcePath);
};
const descriptor = ({ path: name, digest, size }) => ({ path: name, digest, size });
const encodedFile = (name, bytes) => ({ path: name, digest: contentDigest(bytes), size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
const payloadFor = (bundle) => ({ manifest: bundle.manifest, files: bundle.files, baseline: bundle.baseline });
const dtoFor = (bundle, artifactPath) => {
  const manifest = bundle.manifest;
  return {
    schemaVersion: PENDING_CANDIDATE_SCHEMA, status: 'awaiting_backend', missionId: manifest.missionId,
    candidateId: manifest.candidateId, sourceRunId: manifest.sourceRunId, roundId: manifest.roundId,
    patchDigest: manifest.patchDigest, manifestDigest: bundle.manifestDigest, artifactPath,
    createdAt: bundle.createdAt, files: manifest.files, baselineDigest: manifest.baselineDigest,
    semanticDigest: manifest.semanticDigest, testSpecDigest: manifest.testSpecDigest,
  };
};
const locks = new Map();
const exclusive = async (file, action) => {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const result = (locks.get(key) || Promise.resolve()).then(action, action);
  const tail = result.catch(() => {});
  locks.set(key, tail);
  try { return await result; } finally { if (locks.get(key) === tail) locks.delete(key); }
};
const boundary = (operation) => async (...args) => {
  try { return await operation(...args); }
  catch (error) {
    if (error.code?.startsWith?.('PENDING_CANDIDATE_')) throw error;
    if (error.code === 'ENOENT') throw fail('NOT_FOUND', 'A required source or frozen bundle is missing.');
    throw fail('INVALID', 'Unable to validate or store the pending candidate.', { causeCode: error.code || null });
  }
};

export const createPendingCandidateStore = ({ artifactDirForMission, now = () => new Date() } = {}) => {
  if (typeof artifactDirForMission !== 'function' || typeof now !== 'function') throw new TypeError('Pending candidate store requires an authoritative Mission artifact-directory port and clock.');
  // The port must resolve a trusted Mission id without taking paths from a DTO.
  const directoryFor = async (missionId) => absolutePath(await artifactDirForMission(requiredText(missionId, 'missionId')));
  const filenameFor = (directory, digest) => {
    if (!digestPattern.test(digest)) throw fail('IDENTITY_INVALID', 'Invalid manifest digest.');
    return path.join(directory, `pending-candidate-${digest.slice(7)}.json`);
  };
  const load = async (file) => {
    const bytes = await readRegular(file, PENDING_CANDIDATE_LIMITS.maxBundleBytes);
    let bundle;
    try { bundle = JSON.parse(bytes.toString('utf8')); } catch { throw fail('CORRUPT', 'Frozen bundle is not valid JSON.'); }
    validateBundle(bundle);
    if (!bytes.equals(Buffer.from(canonicalJson(bundle) + '\n'))) throw fail('CORRUPT', 'Frozen bundle bytes are not canonical.');
    return bundle;
  };
  const read = boundary(async (pendingValidation) => {
    const pending = jsonClone(pendingValidation);
    const directory = await directoryFor(pending.missionId);
    const file = filenameFor(directory, pending.manifestDigest);
    if (pending.artifactPath !== file) throw fail('PATH_INVALID', 'The artifact must be the expected digest file in this Mission artifact directory.');
    const bundle = await load(file);
    if (canonicalJson(dtoFor(bundle, file)) !== canonicalJson(pending)) throw fail('IDENTITY_INVALID', 'Persisted pending-validation identity does not match the frozen bundle.');
    return bundle;
  });
  const freeze = boundary(async ({ state, mission, candidate, workspace, diff } = {}) => {
    const missionId = requiredText(mission?.id, 'missionId');
    if (state?.activeMissionId !== missionId) throw fail('IDENTITY_INVALID', 'Only the active Mission Workspace can be frozen.');
    const workspaceRoot = absolutePath(workspace);
    const oracle = state.baseline?.oracleRunPy || state.baseline?.materializer?.result?.runPy;
    if (typeof oracle !== 'string' || !oracle.trim()) throw fail('BASELINE_REQUIRED', 'Independent baseline bytes are required; candidate sources cannot substitute.');
    checkLimit(Buffer.byteLength(oracle), PENDING_CANDIDATE_LIMITS.maxSourceBytes, 'Baseline bytes');
    const baseline = encodedFile('oracle.py', Buffer.from(oracle));
    const sourceRunId = requiredText(candidate?.sourceRunId || state.agent?.runId, 'sourceRunId');
    if (candidate?.patchDigest != null && candidate.patchDigest !== diff?.digest) throw fail('IDENTITY_INVALID', 'Candidate patch digest conflicts with the captured diff.');
    const manifest = jsonClone({
      schemaVersion: PENDING_CANDIDATE_SCHEMA, status: 'awaiting_backend', missionId,
      candidateId: requiredText(candidate?.id, 'candidateId'), sourceRunId,
      roundId: state.iterationStats?.roundBudget?.roundId ?? null,
      patchDigest: diff?.digest ?? null, baselineDigest: baseline.digest,
      semanticDigest: mission.semanticSnapshot?.digest ?? null,
      testSpecDigest: semanticTestSpecDigest((state.testMatrix || mission.testMatrix)?.testSpec),
      workspace: workspaceRoot, entrypoint: 'run.py',
      mission: {
        id: missionId, repository: mission.repository ?? null, projectRoot: mission.projectRoot ?? null,
        ...(mission.targetProfile != null ? { targetProfile: normalizeMissionTargetProfile(mission.targetProfile, mission.hardware) } : {}),
        hardware: mission.hardware ?? null, objective: mission.objective ?? null, metric: mission.metric ?? null,
        implementation: mission.implementation ?? null, operatorProfile: mission.operatorProfile ?? null,
        sourcePolicy: mission.sourcePolicy ?? null, sourceFiles: mission.sourceFiles ?? null,
        operator: mission.operator ?? null, title: mission.title ?? null, goal: mission.goal ?? null,
        upstream: mission.upstream ?? null, workspaceId: mission.workspaceId ?? null,
      },
      candidate: { ...candidate, sourceRunId, patchDigest: diff?.digest ?? null }, diff,
      roundBudget: state.iterationStats?.roundBudget ?? null,
      semanticSnapshot: mission.semanticSnapshot ?? null, testMatrix: state.testMatrix || mission.testMatrix || null,
      testSpec: (state.testMatrix || mission.testMatrix)?.testSpec ?? null,
      files: [], baseline: {
        source: state.baseline.oracleRunPy ? 'baseline.oracleRunPy' : 'baseline.materializer.result.runPy', file: descriptor(baseline),
        // Provenance is frozen along with bytes. Never borrow a later baseline's
        // authority or materializer result when submitting this candidate.
        metadata: {
          kind: state.baseline.kind ?? null, source: state.baseline.source ?? null,
          sourcePolicy: state.baseline.sourcePolicy ?? null,
          materializer: state.baseline.materializer?.result ? {
            source: state.baseline.materializer.source ?? null,
            result: Object.fromEntries(Object.entries(state.baseline.materializer.result).filter(([key]) => key !== 'runPy')),
            runPyDigest: typeof state.baseline.materializer.result.runPy === 'string'
              ? contentDigest(Buffer.from(state.baseline.materializer.result.runPy)) : null,
          } : null,
        },
      },
    });
    const sourceBoundary = reviewedPendingSourceBoundary(manifest);
    if (sourceBoundary) manifest.sourceBoundary = sourceBoundary;
    validateIdentity(manifest);
    const directory = await directoryFor(missionId);
    if (contains(workspaceRoot, directory) || contains(directory, workspaceRoot)) throw fail('STORAGE_UNSAFE', 'Frozen artifacts and mutable Workspace must not overlap.');
    await ensureDirectories(workspaceRoot);
    const collect = async () => {
      let entrypoint;
      for (const name of ['run.py', 'operator/run.py']) {
        try { await readRegular(path.join(workspaceRoot, name), PENDING_CANDIDATE_LIMITS.maxSourceBytes); entrypoint = name; break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!entrypoint) throw fail('NOT_FOUND', 'Candidate run.py is required.');
      const declared = declaredPaths(manifest);
      const optional = languagePaths(manifest);
      const names = [...new Set([entrypoint, ...optional, ...declared])].sort();
      checkLimit(names.length, PENDING_CANDIDATE_LIMITS.maxFiles, 'Source file count');
      checkFilePaths(names.map((name) => ({ path: name })));
      const files = [];
      let total = baseline.size;
      for (const name of names) {
        let bytes;
        try { bytes = await readRegular(path.join(workspaceRoot, name), PENDING_CANDIDATE_LIMITS.maxSourceBytes - total); }
        catch (error) { if (error.code === 'ENOENT' && name !== entrypoint && !declared.includes(name)) continue; throw error; }
        total += bytes.length;
        files.push(encodedFile(name, bytes));
      }
      return { entrypoint, files };
    };
    const captured = await collect();
    const checked = await collect();
    if (canonicalJson(captured) !== canonicalJson(checked)) throw fail('SOURCE_CHANGED', 'Workspace sources changed while being frozen.');
    manifest.entrypoint = captured.entrypoint;
    manifest.files = captured.files.map(descriptor);
    const payload = { manifest, files: captured.files, baseline };
    const manifestDigest = hashJson(payload);
    const file = filenameFor(directory, manifestDigest);
    return exclusive(file, async () => {
      await ensureDirectories(directory, true);
      let existing;
      try { existing = await load(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        if (existing.manifestDigest !== manifestDigest || canonicalJson(payloadFor(existing)) !== canonicalJson(payload)) throw fail('CONFLICT', 'An existing immutable bundle has different bytes.');
        return dtoFor(existing, file);
      }
      const timestamp = new Date(now());
      if (!Number.isFinite(timestamp.getTime())) throw fail('INVALID', 'Invalid creation clock.');
      const envelope = { schemaVersion: PENDING_CANDIDATE_BUNDLE_SCHEMA, manifestDigest, createdAt: timestamp.toISOString(), ...payload };
      const bundle = { ...envelope, bundleDigest: hashJson(envelope) };
      validateBundle(bundle);
      const bytes = Buffer.from(canonicalJson(bundle) + '\n');
      checkLimit(bytes.length, PENDING_CANDIDATE_LIMITS.maxBundleBytes, 'Bundle bytes');
      await ensureDirectories(directory);
      let handle;
      try { handle = await open(file, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        existing = await load(file);
        if (canonicalJson(payloadFor(existing)) !== canonicalJson(payload)) throw fail('CONFLICT', 'An existing immutable bundle has different bytes.');
        return dtoFor(existing, file);
      }
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // A partial/crashed write remains fail-closed. Never overwrite or delete an
      // unknown artifact, and never turn it into a prepared/executed package.
      const stored = await load(file);
      if (stored.manifestDigest !== manifestDigest) throw fail('CONFLICT', 'Stored bundle changed before commit.');
      return dtoFor(stored, file);
    });
  });
  const verifyWorkspace = async (pending, { workspace, diff }) => {
    const bundle = await read(pending);
    const manifest = bundle.manifest;
    if (absolutePath(workspace) !== manifest.workspace || absolutePath(diff.workspace) !== manifest.workspace
      || diff.digest !== manifest.patchDigest || diff.diff !== manifest.diff.diff
      || canonicalJson([...diff.changedFiles].sort()) !== canonicalJson([...manifest.diff.changedFiles].sort())
      || diff.untrackedFiles?.length) {
      throw fail('WORKSPACE_CHANGED', '工作区已不同于受测副本；保留测试结果和当前文件，请先处理修改。');
    }
    // Also bind unchanged dependencies: a matching patch alone says nothing
    // about files that were already in HEAD when generation began.
    const names = [...new Set([...bundle.files.map(file => file.path), ...languagePaths(manifest), ...declaredPaths(manifest)])];
    const inspect = async () => {
      let total = 0;
      const actual = [];
      for (const name of names) {
        let bytes;
        try { bytes = await readRegular(path.join(workspace, name), PENDING_CANDIDATE_LIMITS.maxSourceBytes - total); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        total += bytes.length;
        actual.push(descriptor(encodedFile(name, bytes)));
      }
      if (canonicalJson(actual.sort((a, b) => a.path.localeCompare(b.path)))
        !== canonicalJson([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)))) {
        throw fail('WORKSPACE_CHANGED', '工作区的入口或依赖文件已变更；旧测试不能评价当前文件。');
      }
    };
    await inspect();
    await inspect();
    return { missionId: pending.missionId, manifestDigest: pending.manifestDigest,
      candidateId: pending.candidateId, patchDigest: pending.patchDigest,
      files: structuredClone(manifest.files), verifiedAt: new Date(now()).toISOString() };
  };
  return Object.freeze({ freeze, read, verifyWorkspace });
};
