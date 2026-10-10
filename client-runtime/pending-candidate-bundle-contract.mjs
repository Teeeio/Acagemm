// Pure integrity contract shared by storage, export and offline replay.
// Digest integrity never grants execution or publication authority.
import { canonicalJson, contentDigest, assertPackagePath } from './execution-package-contract.mjs';
import { assertKnownOperatorLanguage, normalizeOperatorLanguage } from './operator-language.mjs';
import { assertSemanticSnapshot, semanticSnapshotDigest, semanticTestSpecDigest } from './semantic-snapshot.mjs';
import { inspectRoundBudget } from './round-budget-contract.mjs';

export const PENDING_CANDIDATE_SCHEMA = 'operator-studio.pending-candidate/v1';
export const PENDING_CANDIDATE_BUNDLE_SCHEMA = 'operator-studio.pending-candidate-bundle/v1';
export const PENDING_CANDIDATE_LIMITS = Object.freeze({
  maxFiles: 256, maxSourceBytes: 4 * 1024 * 1024, maxPatchBytes: 2 * 1024 * 1024,
  maxMetadataBytes: 512 * 1024, maxBundleBytes: 8 * 1024 * 1024,
});
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
const exactKeys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) throw fail('CORRUPT', 'Unexpected bundle or reference fields.');
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
const decodeFile = (file) => {
  exactKeys(file, ['path', 'digest', 'size', 'encoding', 'content']);
  sourcePath(file.path);
  checkLimit(file.size, PENDING_CANDIDATE_LIMITS.maxSourceBytes, 'Source bytes');
  if (file.encoding !== 'base64' || typeof file.content !== 'string'
    || file.content.length !== 4 * Math.ceil(file.size / 3) || !digestPattern.test(file.digest)) throw fail('CORRUPT', 'Malformed encoded file.');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size || bytes.toString('base64') !== file.content || contentDigest(bytes) !== file.digest) {
    throw fail('CORRUPT', 'Frozen file bytes do not match their digest or length.');
  }
  return bytes;
};
const reviewedSourceBoundary = manifest => {
  const review = manifest.mission.sourcePolicy?.intakeReview;
  if (!review) return null;
  // Intake previews use bare hex; immutable domain identities use sha256:hex.
  // Normalize representation while preserving the same 256-bit review identity.
  const reviewDigest = typeof review.reviewDigest === 'string' && /^[0-9a-f]{64}$/.test(review.reviewDigest)
    ? `sha256:${review.reviewDigest}` : review.reviewDigest;
  if (!digestPattern.test(reviewDigest) || !Array.isArray(review.files) || !review.files.length) {
    throw fail('IDENTITY_INVALID', 'A reviewed intake must retain its input identity and explicit files.');
  }
  const inputs = review.files.map(file => sourcePath(typeof file === 'string' ? file : file?.path));
  const declarations = (manifest.mission.sourcePolicy.sourceFiles || []).map(file => sourcePath(typeof file === 'string' ? file : file?.path));
  if (new Set(inputs).size !== inputs.length || canonicalJson([...inputs].sort()) !== canonicalJson([...declarations].sort())) {
    throw fail('IDENTITY_INVALID', 'The approved intake paths and declared inputs must be identical.');
  }
  const outputs = languagePaths(manifest);
  if (declaredPaths(manifest).some(name => !inputs.includes(name) && !outputs.includes(name))) {
    throw fail('IDENTITY_INVALID', 'A reviewed intake cannot add undeclared dependency paths.');
  }
  return { reviewDigest, inputPaths: [...inputs].sort(),
    generatedOutputPaths: outputs.filter(name => !inputs.includes(name)).sort() };
};

export const reviewedPendingSourceBoundary = reviewedSourceBoundary;
export const assertPendingCandidateManifest = (manifest) => {
  if (manifest.schemaVersion !== PENDING_CANDIDATE_SCHEMA || manifest.status !== 'awaiting_backend') throw fail('CORRUPT', 'Unsupported pending-candidate manifest.');
  for (const field of ['missionId', 'candidateId', 'sourceRunId', 'roundId']) requiredText(manifest[field], field);
  if (manifest.mission?.id !== manifest.missionId || manifest.candidate?.id !== manifest.candidateId
    || manifest.candidate?.sourceRunId !== manifest.sourceRunId || manifest.candidate?.patchDigest !== manifest.patchDigest
    || (manifest.candidate.missionId != null && manifest.candidate.missionId !== manifest.missionId)
    || (manifest.candidate.roundId != null && manifest.candidate.roundId !== manifest.roundId)
    || manifest.roundBudget?.roundId !== manifest.roundId) throw fail('IDENTITY_INVALID', 'Candidate, source run, Mission or round identity conflicts.');
  const budget = inspectRoundBudget({ activeMissionId: manifest.missionId, iterationStats: { roundBudget: manifest.roundBudget } }, { nowMs: 0 });
  if (!budget.tracked || budget.status === 'invalid') throw fail('IDENTITY_INVALID', 'An existing valid round budget must be preserved.');
  if (typeof manifest.diff?.diff !== 'string' || !manifest.diff.diff || manifest.diff.dirty !== true
    || !Array.isArray(manifest.diff.changedFiles) || !manifest.diff.changedFiles.length
    || manifest.diff.digest !== manifest.patchDigest || contentDigest(manifest.diff.diff) !== manifest.patchDigest) {
    throw fail('IDENTITY_INVALID', 'A complete matching authoritative Workspace diff is required.');
  }
  checkLimit(Buffer.byteLength(manifest.diff.diff), PENDING_CANDIDATE_LIMITS.maxPatchBytes, 'Patch bytes');
  if (typeof manifest.workspace !== 'string' || !(/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(manifest.workspace))
    || /[\x00-\x1f]/.test(manifest.workspace) || manifest.diff.workspace !== manifest.workspace) {
    throw fail('IDENTITY_INVALID', 'Diff and source Workspace disagree.');
  }
  checkFilePaths(manifest.diff.changedFiles.map((name) => ({ path: name })));
  sourcePath(manifest.entrypoint);
  if (!['run.py', 'operator/run.py'].includes(manifest.entrypoint)) throw fail('INVALID', 'Unsupported candidate bridge entrypoint.');
  try { assertSemanticSnapshot(manifest.semanticSnapshot, { requireFrozen: true }); }
  catch { throw fail('SEMANTIC_INVALID', 'A complete frozen Semantic Snapshot is required.'); }
  if (manifest.semanticSnapshot.missionId !== manifest.missionId
    || !digestPattern.test(manifest.semanticDigest)
    || semanticSnapshotDigest(manifest.semanticSnapshot) !== manifest.semanticDigest
    || manifest.semanticSnapshot.digest !== manifest.semanticDigest) throw fail('SEMANTIC_INVALID', 'Semantic identity or digest mismatch.');
  if (!manifest.testSpec || typeof manifest.testSpec !== 'object' || Array.isArray(manifest.testSpec)
    || !digestPattern.test(manifest.testSpecDigest)
    || semanticTestSpecDigest(manifest.testSpec) !== manifest.testSpecDigest
    || semanticTestSpecDigest(manifest.testMatrix?.testSpec) !== manifest.testSpecDigest
    || semanticTestSpecDigest(manifest.semanticSnapshot.testSpec) !== manifest.testSpecDigest) throw fail('SEMANTIC_INVALID', 'Frozen test contracts disagree.');
  languagePaths(manifest);
  declaredPaths(manifest);
  const boundary = reviewedSourceBoundary(manifest);
  if (boundary && canonicalJson(manifest.sourceBoundary) !== canonicalJson(boundary)) {
    throw fail('IDENTITY_INVALID', 'Frozen source boundary must retain the approved inputs and explicit language outputs.');
  }
  const metadata = { ...manifest, diff: { ...manifest.diff, diff: '' } };
  checkLimit(Buffer.byteLength(canonicalJson(metadata)), PENDING_CANDIDATE_LIMITS.maxMetadataBytes, 'Metadata bytes');
};
const payloadFor = (bundle) => ({ manifest: bundle.manifest, files: bundle.files, baseline: bundle.baseline });
export const assertPendingCandidateBundle = (bundle) => {
  exactKeys(bundle, ['schemaVersion', 'manifestDigest', 'createdAt', 'bundleDigest', 'manifest', 'files', 'baseline']);
  if (bundle.schemaVersion !== PENDING_CANDIDATE_BUNDLE_SCHEMA || !digestPattern.test(bundle.manifestDigest)
    || typeof bundle.createdAt !== 'string' || !Number.isFinite(Date.parse(bundle.createdAt))) throw fail('CORRUPT', 'Invalid frozen bundle metadata.');
  assertPendingCandidateManifest(bundle.manifest);
  if (!Array.isArray(bundle.files) || !bundle.files.length) throw fail('CORRUPT', 'The bundle must contain source files.');
  checkLimit(bundle.files.length, PENDING_CANDIDATE_LIMITS.maxFiles, 'Source file count');
  checkFilePaths(bundle.files);
  let total = decodeFile(bundle.baseline).length;
  for (const file of bundle.files) total += decodeFile(file).length;
  checkLimit(total, PENDING_CANDIDATE_LIMITS.maxSourceBytes, 'All sources including baseline');
  if (bundle.baseline.path !== 'oracle.py' || bundle.baseline.digest !== bundle.manifest.baselineDigest
    || canonicalJson(descriptor(bundle.baseline)) !== canonicalJson(bundle.manifest.baseline.file)
    || !['baseline.oracleRunPy', 'baseline.materializer.result.runPy'].includes(bundle.manifest.baseline.source)
    || canonicalJson(bundle.files.map(descriptor)) !== canonicalJson(bundle.manifest.files)
    || !bundle.files.some((file) => file.path === bundle.manifest.entrypoint)
    || declaredPaths(bundle.manifest).some((name) => !bundle.files.some((file) => file.path === name))) throw fail('CORRUPT', 'Source or independent baseline manifest mismatch.');
  if (bundle.manifest.sourceBoundary && bundle.files.some(file =>
    !bundle.manifest.sourceBoundary.inputPaths.includes(file.path)
    && !bundle.manifest.sourceBoundary.generatedOutputPaths.includes(file.path))) {
    throw fail('CORRUPT', 'Frozen bytes exceed the approved intake and language output boundary.');
  }
  if (hashJson(payloadFor(bundle)) !== bundle.manifestDigest) throw fail('CORRUPT', 'Manifest content digest mismatch.');
  const { bundleDigest, ...envelope } = bundle;
  if (!digestPattern.test(bundleDigest) || hashJson(envelope) !== bundleDigest) throw fail('CORRUPT', 'Bundle envelope digest mismatch.');
  return bundle;
};
