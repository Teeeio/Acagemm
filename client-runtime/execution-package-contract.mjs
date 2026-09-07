// Pure, language-neutral execution package rules. No filesystem or runner imports.
export const EXECUTION_PACKAGE_FORMAT = 'operator-execution-package/v1';
export const EXECUTION_ADMISSION_FORMAT = 'operator-execution-admission/v1';
export const EXECUTION_VALIDATOR_VERSION = 'package-policy/1';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const roles = new Set(['candidate', 'dependency', 'acceptance']);
const fail = (code, message, details = {}) => {
  throw Object.assign(new Error(message), { code, status: 422, retryable: false, details });
};
export const assertContentDigest = (value, field = 'digest') => {
  if (typeof value !== 'string' || !digestPattern.test(value)) fail('PACKAGE_DIGEST_INVALID', field + ' must be a SHA-256 content digest.', { field });
  return value;
};
export const canonicalJson = (value) => {
  const seen = new Set();
  const encode = (item) => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || seen.has(item)) fail('PACKAGE_JSON_INVALID', 'Package metadata must be finite, acyclic JSON.');
    seen.add(item);
    let result;
    if (Array.isArray(item)) result = '[' + item.map(encode).join(',') + ']';
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('PACKAGE_JSON_INVALID', 'Package metadata requires plain objects.');
      result = '{' + Object.keys(item).sort().map((key) => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    }
    seen.delete(item);
    return result;
  };
  return encode(value);
};
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail('PACKAGE_FIELD_INVALID', field + ' is required.', { field });
  return value;
};
export const assertPackagePath = (value) => {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== value.normalize('NFC')
    || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.endsWith('/')) {
    fail('PACKAGE_PATH_INVALID', 'Package paths must be normalized relative POSIX paths.', { path: value });
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      fail('PACKAGE_PATH_INVALID', 'Package path is unsafe or non-portable.', { path: value });
    }
  }
  return value;
};
export const validateExecutionManifest = (input, { maxFiles = 4096, maxBytes = 256 * 1024 * 1024 } = {}) => {
  canonicalJson(input);
  if (input?.format !== EXECUTION_PACKAGE_FORMAT || input.schemaVersion !== 1) fail('PACKAGE_SCHEMA_UNSUPPORTED', 'Unsupported execution package schema.');
  text(input.language, 'language');
  text(input.adapter?.id, 'adapter.id');
  text(input.adapter?.version, 'adapter.version');
  const binding = input.binding || {};
  for (const field of ['missionId', 'workspaceId', 'candidateId']) text(binding[field], 'binding.' + field);
  assertContentDigest(binding.candidateDigest, 'binding.candidateDigest');
  assertContentDigest(input.environment?.digest, 'environment.digest');
  text(input.environment?.id, 'environment.id');
  text(input.target?.platform, 'target.platform');
  text(input.target?.device, 'target.device');
  if (!Array.isArray(input.layers) || !input.layers.length) fail('PACKAGE_LAYERS_REQUIRED', 'Candidate, dependency and acceptance layers must be declared.');
  const paths = new Map();
  const layerIds = new Set();
  let totalBytes = 0;
  let count = 0;
  for (const layer of input.layers) {
    if (!roles.has(layer.role)) fail('PACKAGE_LAYER_ROLE_INVALID', 'Unknown layer role.');
    text(layer.id, 'layer.id');
    if (layerIds.has(layer.id)) fail('PACKAGE_LAYER_ID_CONFLICT', 'Layer identities must be unique.');
    layerIds.add(layer.id);
    assertContentDigest(layer.digest, 'layer.digest');
    if (!Array.isArray(layer.files)) fail('PACKAGE_FILES_INVALID', 'Layer files must be an explicit list.');
    for (const file of layer.files) {
      assertPackagePath(file.path);
      const key = file.path.toLowerCase();
      if (paths.has(key)) fail('PACKAGE_PATH_CONFLICT', 'Package paths collide across layers or case variants.', { path: file.path });
      if ([...paths.keys()].some((existing) => existing.startsWith(key + '/') || key.startsWith(existing + '/'))) fail('PACKAGE_PATH_CONFLICT', 'A package file cannot also be an ancestor directory.', { path: file.path });
      paths.set(key, { ...file, role: layer.role });
      assertContentDigest(file.digest, 'file.digest');
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.type !== 'file') fail('PACKAGE_FILE_INVALID', 'Only size-checked regular files are allowed.');
      count += 1;
      totalBytes += file.size;
    }
  }
  if (count > maxFiles || totalBytes > maxBytes) fail('PACKAGE_LIMIT_EXCEEDED', 'Package exceeds file or byte limits.', { count, totalBytes, maxFiles, maxBytes });
  const source = assertPackagePath(input.entrypoints?.candidate);
  const oracle = assertPackagePath(input.entrypoints?.acceptance);
  if (paths.get(source.toLowerCase())?.role !== 'candidate' || paths.get(source.toLowerCase())?.path !== source) fail('PACKAGE_ENTRYPOINT_INVALID', 'Candidate entrypoint must identify an exact candidate-layer file.');
  if (paths.get(oracle.toLowerCase())?.role !== 'acceptance' || paths.get(oracle.toLowerCase())?.path !== oracle) fail('PACKAGE_ORACLE_INVALID', 'An independent acceptance-layer entrypoint is required.');
  const acceptance = input.layers.filter((layer) => layer.role === 'acceptance');
  if (acceptance.length !== 1) fail('PACKAGE_ORACLE_INVALID', 'Exactly one frozen acceptance layer is required.');
  assertContentDigest(input.acceptance?.digest, 'acceptance.digest');
  assertContentDigest(input.acceptance?.testSpecDigest, 'acceptance.testSpecDigest');
  assertContentDigest(input.acceptance?.semanticDigest, 'acceptance.semanticDigest');
  if (acceptance[0].digest !== input.acceptance.digest) fail('PACKAGE_ORACLE_CONFLICT', 'Acceptance identity must match its frozen layer.');
  if (!input.build || Array.isArray(input.build) || typeof input.build !== 'object') fail('PACKAGE_BUILD_INVALID', 'Build settings must be an explicit object, including when empty.');
  return structuredClone(input);
};
export const assertAdmissionBinding = ({ request, manifest, admission, nowMs = Date.now() }) => {
  validateExecutionManifest(manifest);
  if (admission?.format !== EXECUTION_ADMISSION_FORMAT || admission.status !== 'ready'
    || admission.validatorVersion !== EXECUTION_VALIDATOR_VERSION) fail('PACKAGE_NOT_ADMITTED', 'A trusted current-policy admission is required.');
  assertContentDigest(request.packageDigest, 'request.packageDigest');
  const mismatch = (field, actual, expected) => {
    if (canonicalJson(actual ?? null) !== canonicalJson(expected ?? null)) fail('PACKAGE_ADMISSION_CONFLICT', 'Submission does not match its admission: ' + field, { field });
  };
  mismatch('packageDigest', request.packageDigest, admission.packageDigest);
  mismatch('environmentDigest', manifest.environment.digest, admission.environmentDigest);
  mismatch('acceptanceDigest', manifest.acceptance.digest, admission.acceptanceDigest);
  mismatch('target', manifest.target, admission.target);
  mismatch('build', manifest.build, admission.build);
  mismatch('adapter', manifest.adapter, admission.adapter);
  mismatch('missionId', request.missionId, manifest.binding.missionId);
  mismatch('workspaceId', request.workspaceId, manifest.binding.workspaceId);
  mismatch('candidate.id', request.candidate?.id, manifest.binding.candidateId);
  mismatch('candidate.digest', request.candidate?.digest, manifest.binding.candidateDigest);
  mismatch('environmentDigest', request.environmentDigest, admission.environmentDigest);
  mismatch('acceptanceDigest', request.acceptanceDigest, admission.acceptanceDigest);
  mismatch('target', request.target, admission.target);
  if (!Number.isFinite(Date.parse(admission.expiresAt)) || Date.parse(admission.expiresAt) <= nowMs) fail('PACKAGE_ADMISSION_EXPIRED', 'Package admission expired; prepare again.');
  if (!['baseline', 'candidate'].includes(request.purpose)) fail('TEST_PURPOSE_INVALID', 'Test purpose must be baseline or candidate.');
  if (!Array.isArray(request.checks) || request.checks.length !== 2 || request.checks[0] !== 'correctness' || request.checks[1] !== 'benchmark') fail('TEST_CHECKS_INVALID', 'Correctness must precede Benchmark; required checks cannot be weakened.');
  text(request.requestId, 'requestId');
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(deadline) || deadline <= nowMs) fail('TEST_DEADLINE_INVALID', 'Submission requires a finite future deadline.');
  if (!Number.isFinite(request.limits?.timeoutSeconds) || request.limits.timeoutSeconds <= 0) fail('TEST_LIMITS_INVALID', 'Test timeout must be positive and finite.');
  return true;
};
