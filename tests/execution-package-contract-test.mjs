import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, validateExecutionManifest, assertAdmissionBinding, assertPackagePath, EXECUTION_PACKAGE_FORMAT, EXECUTION_ADMISSION_FORMAT, EXECUTION_VALIDATOR_VERSION } from '../client-runtime/execution-package-contract.mjs';

const digest = (value) => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
const h = digest('test');
const file = (path) => ({ path, digest: h, size: 1, type: 'file' });
const make = (language = 'python', entrypoint = 'src/run.py') => ({
  format: EXECUTION_PACKAGE_FORMAT, schemaVersion: 1, language,
  adapter: { id: language + '-cpu', version: '1' },
  binding: { missionId: 'm1', workspaceId: 'w1', candidateId: 'c1', candidateDigest: h },
  environment: { id: 'locked-cpu', digest: h }, target: { platform: 'test-x64', device: 'cpu' },
  entrypoints: { candidate: entrypoint, acceptance: 'acceptance/oracle.dat' },
  layers: [
    { role: 'candidate', id: 'source', digest: h, files: [file(entrypoint)] },
    { role: 'dependency', id: 'deps', digest: h, files: [file('deps/lib.dat')] },
    { role: 'acceptance', id: 'suite', digest: h, files: [file('acceptance/oracle.dat')] },
  ],
  acceptance: { digest: h, testSpecDigest: h, semanticDigest: h }, build: {},
});
let checks = 0;
const rejects = (operation, code) => { assert.throws(operation, (error) => error.code === code); checks += 1; };
for (const [language, entry] of [['python', 'src/run.py'], ['cpp', 'src/operator.cc'], ['cuda', 'src/kernel.cu']]) {
  assert.equal(validateExecutionManifest(make(language, entry)).language, language); checks += 1;
}
assert.equal(canonicalJson({ z: 2, a: { b: 1 } }), '{"a":{"b":1},"z":2}'); checks += 1;
for (const unsafe of ['../secret', '/absolute', 'C:/secret', 'a\\b', 'a/../b', 'a//b', 'x:stream', 'CON.py', 'x.', 'x ', 'e\u0301.py']) {
  rejects(() => assertPackagePath(unsafe), 'PACKAGE_PATH_INVALID');
}
for (const invalid of [NaN, Infinity, undefined, new Date()]) rejects(() => canonicalJson(invalid), 'PACKAGE_JSON_INVALID');
const cyclic = {}; cyclic.self = cyclic;
rejects(() => canonicalJson(cyclic), 'PACKAGE_JSON_INVALID');
let manifest = make();
manifest.layers[1].files.push(file('SRC/run.py'));
rejects(() => validateExecutionManifest(manifest), 'PACKAGE_PATH_CONFLICT');
manifest = make(); manifest.layers[0].files[0].type = 'symlink';
rejects(() => validateExecutionManifest(manifest), 'PACKAGE_FILE_INVALID');
manifest = make(); manifest.entrypoints.acceptance = 'src/run.py';
rejects(() => validateExecutionManifest(manifest), 'PACKAGE_ORACLE_INVALID');
manifest = make(); manifest.acceptance.digest = digest('other');
rejects(() => validateExecutionManifest(manifest), 'PACKAGE_ORACLE_CONFLICT');
rejects(() => validateExecutionManifest(make(), { maxFiles: 1 }), 'PACKAGE_LIMIT_EXCEEDED');
manifest = make();
const nowMs = Date.parse('2026-09-07T00:00:00Z');
const admission = {
  format: EXECUTION_ADMISSION_FORMAT, status: 'ready', validatorVersion: EXECUTION_VALIDATOR_VERSION,
  packageDigest: digest(manifest), environmentDigest: h, acceptanceDigest: h,
  target: manifest.target, build: manifest.build, adapter: manifest.adapter,
  expiresAt: new Date(nowMs + 60000).toISOString(),
};
const request = {
  requestId: 'r1', purpose: 'candidate', missionId: 'm1', workspaceId: 'w1',
  candidate: { id: 'c1', digest: h }, packageDigest: admission.packageDigest,
  environmentDigest: h, acceptanceDigest: h, target: manifest.target,
  checks: ['correctness', 'benchmark'], deadline: admission.expiresAt,
  limits: { timeoutSeconds: 30 },
};
assert.equal(assertAdmissionBinding({ request, manifest, admission, nowMs }), true); checks += 1;
rejects(() => assertAdmissionBinding({ request, manifest, admission: { validated: true }, nowMs }), 'PACKAGE_NOT_ADMITTED');
for (const patch of [{ missionId: 'foreign' }, { workspaceId: 'foreign' }, { candidate: { id: 'other', digest: h } }, { environmentDigest: digest('other') }, { target: { platform: 'different', device: 'cpu' } }]) {
  rejects(() => assertAdmissionBinding({ request: { ...request, ...patch }, manifest, admission, nowMs }), 'PACKAGE_ADMISSION_CONFLICT');
}
rejects(() => assertAdmissionBinding({ request, manifest, admission, nowMs: nowMs + 60001 }), 'PACKAGE_ADMISSION_EXPIRED');
rejects(() => assertAdmissionBinding({ request: { ...request, checks: ['benchmark'] }, manifest, admission, nowMs }), 'TEST_CHECKS_INVALID');
rejects(() => assertAdmissionBinding({ request: { ...request, deadline: 'never' }, manifest, admission, nowMs }), 'TEST_DEADLINE_INVALID');
console.log('[execution-package-contract] ' + checks + ' language-neutral, path, binding and admission checks passed');
