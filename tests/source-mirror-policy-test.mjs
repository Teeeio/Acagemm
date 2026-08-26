import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { acquireSelectedSources } from '../client-runtime/agent-runtime.mjs';
import {
  normalizeRepositoryIdentity,
  parseSourceMirrorPolicy,
  resolveSourceTransport,
  verifySourceTransportSnapshot,
} from '../client-runtime/source-mirror-policy.mjs';
import { createWorkspaceManager } from '../client-runtime/workspace-manager.mjs';

const execFileAsync = promisify(execFile);
const canonical = 'https://github.com/flashinfer-ai/flashinfer.git';
const transport = 'https://gitee.com/operator-mirrors/flashinfer.git';
const commit = '1'.repeat(40);
const tree = '2'.repeat(40);

assert.equal(normalizeRepositoryIdentity(`${canonical}/`), 'https://github.com/flashinfer-ai/flashinfer');
const policy = parseSourceMirrorPolicy({
  schemaVersion: 1,
  requireMirror: true,
  mirrors: [{ canonical, transport, requiredCommit: commit, requiredTree: tree }],
}, { configPath: '/admin/source-mirrors.json' });
const resolution = resolveSourceTransport('https://github.com/FLASHINFER-AI/flashinfer', policy);
assert.equal(resolution.mode, 'mirror');
assert.equal(resolution.transport, transport);
assert.equal(verifySourceTransportSnapshot({ resolution, commit, tree }).mirrorVerified, true);

assert.throws(
  () => parseSourceMirrorPolicy({ schemaVersion: 1, mirrors: [{ canonical, transport, requiredCommit: 'short' }] }),
  (error) => error.code === 'SOURCE_MIRROR_COMMIT_REQUIRED',
);
assert.throws(
  () => parseSourceMirrorPolicy({ schemaVersion: 1, mirrors: [
    { canonical, transport, requiredCommit: commit },
    { canonical: canonical.replace(/\.git$/, ''), transport: 'https://gitee.com/other/repo.git', requiredCommit: commit },
  ] }),
  (error) => error.code === 'SOURCE_MIRROR_CONFIG_DUPLICATE',
);
for (const unsafe of [
  'http://github.com/flashinfer-ai/flashinfer',
  'https://token@github.com/flashinfer-ai/flashinfer',
  'https://github.com:8443/flashinfer-ai/flashinfer',
  'https://github.com/flashinfer-ai/flashinfer?ref=main',
  'https://gitee.com/flashinfer-ai/flashinfer',
]) {
  assert.throws(() => resolveSourceTransport(unsafe, policy));
}
assert.throws(
  () => resolveSourceTransport('https://github.com/other/repository', policy),
  (error) => error.code === 'SOURCE_MIRROR_REQUIRED',
);
assert.throws(
  () => verifySourceTransportSnapshot({ resolution, commit: '3'.repeat(40), tree }),
  (error) => error.code === 'SOURCE_MIRROR_COMMIT_MISMATCH',
);
assert.throws(
  () => verifySourceTransportSnapshot({ resolution, commit, tree: '4'.repeat(40) }),
  (error) => error.code === 'SOURCE_MIRROR_TREE_MISMATCH',
);
const direct = resolveSourceTransport(canonical, { configured: false, requireMirror: false, mirrors: [] });
assert.equal(direct.mode, 'canonical');
assert.equal(direct.transport, canonical);

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-source-mirror-'));
const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
try {
  const upstream = path.join(root, 'upstream');
  const sourceRoot = path.join(root, 'registry');
  const researchDir = path.join(root, 'research');
  const evidencePath = 'include/flashinfer/attention/mla.cuh';
  await mkdir(path.join(upstream, path.dirname(evidencePath)), { recursive: true });
  await mkdir(researchDir, { recursive: true });
  await writeFile(path.join(upstream, evidencePath), '// MLA paged attention KV cache semantics\n', 'utf8');
  await execFileAsync('git', ['init'], { cwd: upstream });
  await execFileAsync('git', ['config', 'user.name', 'Mirror Test'], { cwd: upstream });
  await execFileAsync('git', ['config', 'user.email', 'mirror@test.invalid'], { cwd: upstream });
  await execFileAsync('git', ['add', '-A'], { cwd: upstream });
  await execFileAsync('git', ['commit', '-m', 'source snapshot'], { cwd: upstream });
  const actualCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
  const actualTree = (await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: upstream })).stdout.trim();

  const rewriteConfig = path.join(root, 'gitconfig');
  const upstreamUrl = pathToFileURL(upstream).href.replaceAll('%5C', '/');
  await writeFile(rewriteConfig, `[url "${upstreamUrl}"]\n\tinsteadOf = ${transport}\n`, 'utf8');
  process.env.GIT_CONFIG_GLOBAL = rewriteConfig;

  const integrationPolicy = parseSourceMirrorPolicy({
    schemaVersion: 1,
    requireMirror: true,
    mirrors: [{ canonical, transport, requiredCommit: actualCommit, requiredTree: actualTree }],
  }, { configPath: path.join(root, 'policy.json') });
  const events = [{
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify({
      schemaVersion: 'operator-studio.source-acquisition/v1',
      sourceAcquisition: { repositories: [{ name: 'flashinfer', url: canonical, evidencePaths: [evidencePath], reason: 'official upstream' }] },
    }) },
  }];
  const acquired = await acquireSelectedSources({ events, sourceRoot, researchDir, mirrorPolicy: integrationPolicy });
  assert.equal(acquired.length, 1);
  assert.equal(acquired[0].repository, canonical);
  assert.equal(acquired[0].transportRepository, transport);
  assert.equal(acquired[0].commit, actualCommit);
  assert.equal(acquired[0].tree, actualTree);
  assert.equal(acquired[0].mirrorVerified, true);

  const registeredSource = path.join(sourceRoot, 'flashinfer');
  await execFileAsync('git', ['remote', 'set-url', 'origin', transport], { cwd: registeredSource });
  await execFileAsync('git', ['config', 'operatorStudio.transportRepository', transport], { cwd: registeredSource });
  const manager = createWorkspaceManager();
  const reference = { repository: canonical, commit: actualCommit, path: evidencePath };
  const inspection = await manager.inspectSources(sourceRoot, [reference]);
  assert.equal(inspection.ready, true, JSON.stringify(inspection.errors));
  assert.equal(inspection.sources[0].canonicalRepository, canonical);
  assert.equal(inspection.sources[0].transportRepository, transport);
  assert.equal(inspection.sources[0].tree, actualTree);
  assert.equal(inspection.references[0].mirrorVerified, true);

  const transportReference = await manager.inspectSources(sourceRoot, [{ ...reference, repository: transport }]);
  assert.equal(transportReference.ready, false, 'transport URL must not become authoritative identity');
  const shortReference = await manager.inspectSources(sourceRoot, [{ ...reference, commit: actualCommit.slice(0, 12) }]);
  assert.equal(shortReference.ready, false, 'mirrored references require a full commit id');

  const manifest = JSON.parse(await readFile(path.join(researchDir, 'acquisition-result.json'), 'utf8'));
  assert.equal(manifest.acquired[0].canonicalRepository, canonical);
  assert.equal(manifest.acquired[0].transportRepository, transport);
  assert.equal(manifest.acquired[0].evidence[0].path, evidencePath);
} finally {
  if (previousGlobalConfig == null) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('[source-mirror-policy] canonical identity, pinned transport, and registry verification passed\n');
