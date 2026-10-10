import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutionPackageStore } from '../../client-runtime/execution-package-store.mjs';
import { contentDigest, canonicalJson } from '../../client-runtime/execution-package-contract.mjs';
import { METAX_C500_PACKAGE_ADAPTER as ID, METAX_C500_TARGET as TARGET, probeMetaxC500Runtime,
  createMetaxC500EnvironmentResolver } from '../../client-runtime/metax-c500/runtime.mjs';
import { createMetaxC500PackageAdapter } from '../../client-runtime/metax-c500/package-adapter.mjs';

import { resolvePythonExecutable } from '../../client-runtime/platform-runtime.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.join(project, 'tools', 'metax-c500');
const cpuPython = process.env.OPERATOR_C500_TEST_PYTHON || resolvePythonExecutable({ rootDir: project });
const policy = { python: 'cpu-fixture-python', torch: 'cpu-fixture+metax', maca: 'cpu-fixture-maca', driver: 'cpu-fixture-driver' };
const observed = { vendor: 'metax', deviceName: 'MetaX C500', deviceIndex: 0, versions: policy,
  timer: { kind: 'maca-torch-event', validated: true }, pythonExecutable: cpuPython,
  mxSmiExecutable: '/cpu-fixture/mx-smi', compilerExecutable: null, testDouble: true };
const probeResult = (rawMxSmi = 'CPU fixture only') => ({ status: 'ready', observed: { ...observed, rawMxSmi } });
const cpuProbe = async () => probeMetaxC500Runtime({ versionPolicy: policy, run: async () => ({ stdout: JSON.stringify(probeResult()) }) });
const parser = (command, args, options, callback) => execFile(cpuPython, args, options, callback);
const buildReceipt = input => ({
  preparationId: input.preparationId, packageDigest: input.packageDigest, environmentDigest: input.environmentDigest,
  resourceRelease: { confirmed: true, evidenceRef: 'cpu-contract-fixture:close-only-no-hardware-claim' },
  buildLoad: { status: 'passed', candidateLoaded: true, oracleLoaded: true, independentOracle: true,
    targetProbe: structuredClone(input.environment.observed), nativeBuild: { required: false, loadedExtension: false, artifacts: [] },
    candidateRunPyDigest: input.manifest.layers.find(l => l.role === 'candidate').files.find(f => f.path === input.manifest.entrypoints.candidate).digest,
    oracleDigest: input.manifest.layers.find(l => l.role === 'acceptance').files.find(f => f.path === input.manifest.entrypoints.acceptance).digest },
});
const withRoot = async work => {
  const root = await mkdtemp(path.join(parent, 'cpu-contract-'));
  try { return await work(root); }
  finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(parent) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
};
const fixture = async (root, load = async input => buildReceipt(input)) => {
  const { environment } = await cpuProbe();
  const adapter = createMetaxC500PackageAdapter({ rootDir: path.join(root, 'adapter'), execFileImpl: parser, prepareLoad: load });
  const store = createExecutionPackageStore({ rootDir: path.join(root, 'store'), environments: { resolve: async () => environment }, adapters: { [ID.id]: adapter } });
  const spec = { schemaVersion: 'operator-studio.test-spec/v1', correctness: { requestedCases: 24 }, benchmark: { repeats: 7, requiredProfiles: ['large', 'small'], primaryProfile: 'large' } };
  const assemble = (extra = {}) => store.assemble({ language: 'python', adapter: ID, environmentId: environment.id,
    binding: { missionId: 'cpu-mission', workspaceId: 'cpu-workspace', candidateId: 'cpu-candidate', candidateDigest: contentDigest('cpu-candidate') },
    candidateEntrypoint: 'run.py', candidateFiles: { 'run.py': 'def run(x): return x\n' },
    acceptance: { entrypoint: 'oracle.py', files: { 'oracle.py': 'def run(x): return x\nreference = run\ndef get_test_cases(): return []\ndef get_benchmark_inputs(): return []\n' },
      semanticDigest: contentDigest(canonicalJson(spec)), testSpec: spec },
    build: {}, ...extra });
  return { environment, adapter, store, assemble };
};

test('missing version pins start no probe; wrong vendor/device/timer are rejected', async () => {
  let starts = 0;
  await assert.rejects(probeMetaxC500Runtime({ run: async () => { starts++; } }), { code: 'METAX_C500_VERSION_POLICY_REQUIRED' });
  assert.equal(starts, 0);
  for (const change of [{ vendor: 'moore-threads' }, { deviceName: 'C550' }, { deviceName: 'C5000' }, { timer: { validated: false } }]) {
    await assert.rejects(probeMetaxC500Runtime({ versionPolicy: policy, run: async () => ({ stdout: JSON.stringify({ status: 'ready', observed: { ...observed, ...change } }) }) }),
      { code: 'METAX_C500_PROBE_INVALID' });
  }
});

test('locked environment excludes changing SMI utilization but binds versions', async () => {
  const query = raw => probeMetaxC500Runtime({ versionPolicy: policy, run: async () => ({ stdout: JSON.stringify(probeResult(raw)) }) });
  assert.equal((await query('load 0%')).environment.digest, (await query('load 90%')).environment.digest);
  await assert.rejects(probeMetaxC500Runtime({ versionPolicy: { ...policy, maca: 'changed' }, run: async () => ({ stdout: JSON.stringify(probeResult()) }) }), { code: 'METAX_C500_VERSION_MISMATCH' });
});

test('resolver does not substitute NVIDIA/MUSA and failed refresh cannot use old cache', async () => {
  let starts = 0;
  const resolver = createMetaxC500EnvironmentResolver({ probe: async () => { starts++; if (starts === 2) throw Error('CPU refresh fixture fault'); return cpuProbe(); } });
  await assert.rejects(resolver.resolve('musa-mtt'), { code: 'PACKAGE_ENVIRONMENT_UNKNOWN' });
  assert.equal(starts, 0);
  const initial = await resolver.resolve('metax-c500');
  assert.deepEqual(initial.target, TARGET);
  await assert.rejects(resolver.resolve('metax-c500', { refresh: true }), /fixture fault/);
  await resolver.resolve('metax-c500');
  assert.equal(starts, 3);
});

test('actual immutable store admits only bound build/load and rechecks staged bytes', () => withRoot(async root => {
  const { adapter, store, assemble, environment } = await fixture(root);
  const pkg = await assemble();
  const prepared = await store.prepare(pkg.packageDigest);
  const artifact = await adapter.verifyPreparedArtifact({ manifest: pkg.manifest, environment, preparedArtifactDigest: prepared.preparedArtifactDigest });
  assert.equal(artifact.valid, true);
  const admission = await store.verifyAdmission({ requestId: 'cpu-request', missionId: 'cpu-mission', workspaceId: 'cpu-workspace',
    packageDigest: pkg.packageDigest, candidate: { id: 'cpu-candidate', digest: contentDigest('cpu-candidate') },
    environmentDigest: environment.digest, acceptanceDigest: pkg.manifest.acceptance.digest, target: TARGET, build: {}, adapter: ID,
    admissionId: prepared.admissionId, purpose: 'candidate', checks: ['correctness', 'benchmark'],
    deadline: new Date(Date.now()+60000).toISOString(), limits: { timeoutSeconds: 10 } });
  assert.equal(admission.admission.preparedArtifactDigest, prepared.preparedArtifactDigest);
  await writeFile(path.join(artifact.root, 'oracle.py'), 'changed oracle', 'utf8');
  assert.equal((await adapter.verifyPreparedArtifact({ manifest: pkg.manifest, environment, preparedArtifactDigest: prepared.preparedArtifactDigest })).valid, false);
}));

test('no supervised prepare port is an explicit failure before source execution', () => withRoot(async root => {
  const { store, assemble } = await fixture(root, null);
  const pkg = await assemble();
  await assert.rejects(store.prepare(pkg.packageDigest), { code: 'METAX_C500_PREPARATION_PORT_REQUIRED' });
}));

test('missing release or foreign receipts remain quarantined, not released', async () => {
  for (const mode of ['missing-release', 'foreign', 'throw']) await withRoot(async root => {
    const { adapter, store, assemble } = await fixture(root, async input => {
      if (mode === 'throw') throw Error('unknown worker fixture fault');
      const result = buildReceipt(input);
      if (mode === 'foreign') result.preparationId = 'another-preparation';
      if (mode === 'missing-release') result.resourceRelease = { confirmed: false };
      return result;
    });
    const pkg = await assemble();
    await assert.rejects(store.prepare(pkg.packageDigest));
    const claim = JSON.parse(await readFile(path.join(root, 'store/preparations', pkg.packageDigest.slice(7)+'.json'), 'utf8'));
    const inspected = await adapter.inspectPreparation({ preparationId: claim.preparationId });
    assert.equal(inspected.resourceRelease.confirmed, false);
  });
});

test('changed loaded oracle and native fallback never produce admission', async () => {
  for (const mode of ['oracle', 'native']) await withRoot(async root => {
    const { store, assemble, environment } = await fixture(root, async input => {
      const result = buildReceipt(input);
      if (mode === 'oracle') result.buildLoad.oracleDigest = contentDigest('foreign oracle');
      return result;
    });
    if (mode === 'native') {
      environment.versionPolicy.compiler = 'cpu-compiler-pin';
      environment.observed.compilerExecutable = '/fixture/compiler';
      environment.observed.versions.compiler = 'cpu-compiler-pin';
    }
    const pkg = await assemble(mode === 'native' ? { candidateFiles: { 'run.py': 'def run(x): return x\n', 'operator.cu': 'CPU fixture only' } } : {});
    await assert.rejects(store.prepare(pkg.packageDigest), { code: mode === 'oracle' ? 'METAX_C500_PREPARATION_BINDING_MISMATCH' : 'METAX_C500_NATIVE_BUILD_MISSING' });
  });
});
