import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionPackageStore } from '../client-runtime/execution-package-store.mjs';
import { contentDigest } from '../client-runtime/execution-package-store.mjs';
import { createSharedGpuPackageAdapter, SHARED_GPU_PACKAGE_ADAPTER } from '../client-runtime/local-shared-gpu-package-adapter.mjs';
import { canonicalJson } from '../client-runtime/execution-package-contract.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'shared-gpu-package-'));
const target = { platform: 'nvidia-cuda', device: 'gpu' };
const environment = {
  id: 'local-shared-gpu', digest: contentDigest('test-shared-gpu-environment'), target,
  isolation: { kind: 'shared-host-gpu', enforced: false },
  policy: { allowSharedHostGpu: true, packageBoundary: 'adapter-enforced' },
};
const adapter = createSharedGpuPackageAdapter({ rootDir: path.join(root, 'adapter') });
const store = createExecutionPackageStore({ rootDir: path.join(root, 'store'), environments: { resolve: async () => environment }, adapters: { [SHARED_GPU_PACKAGE_ADAPTER.id]: adapter } });
const spec = { schemaVersion: 'operator-studio.test-spec/v1', correctness: { requestedCases: 1 }, benchmark: { repeats: 1 } };
const pkg = await store.assemble({
  language: 'python', adapter: SHARED_GPU_PACKAGE_ADAPTER, environmentId: environment.id,
  binding: { missionId: 'mission-1', workspaceId: 'workspace-1', candidateId: 'candidate-1', candidateDigest: contentDigest('candidate') },
  candidateEntrypoint: 'run.py', candidateFiles: { 'run.py': 'def run(x): return x\n' },
  dependencyFiles: { 'lib/helper.py': 'VALUE = 1\n' },
  acceptance: { entrypoint: 'oracle.py', files: { 'oracle.py': 'def run(x): return x\n' }, semanticDigest: contentDigest(canonicalJson(spec)), testSpec: spec },
  build: {},
});
const prepared = await store.prepare(pkg.packageDigest);
const verified = await store.verifyAdmission({
  requestId: 'request-1', missionId: 'mission-1', workspaceId: 'workspace-1', packageDigest: pkg.packageDigest,
  candidate: { id: 'candidate-1', digest: contentDigest('candidate') }, environmentDigest: environment.digest,
  acceptanceDigest: pkg.manifest.acceptance.digest, target, build: {}, adapter: SHARED_GPU_PACKAGE_ADAPTER,
  admissionId: prepared.admissionId, purpose: 'candidate', checks: ['correctness', 'benchmark'],
  deadline: new Date(Date.now() + 60_000).toISOString(), limits: { timeoutSeconds: 10 },
});
assert.equal(verified.admission.preparedArtifactDigest, prepared.preparedArtifactDigest);
const artifact = await adapter.verifyPreparedArtifact({ manifest: pkg.manifest, environment, preparedArtifactDigest: prepared.preparedArtifactDigest });
assert.equal(artifact.valid, true);
assert.match(await readFile(path.join(artifact.root, 'run.py'), 'utf8'), /def run/);
assert.match(await readFile(path.join(artifact.root, 'lib', 'helper.py'), 'utf8'), /VALUE/);
await rm(root, { recursive: true, force: true });
console.log('[shared-gpu-package-adapter] package-only materialization and admission verification passed');
