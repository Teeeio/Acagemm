import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceManager } from '../client-runtime/workspace-manager.mjs';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'operator-three-layer-'));
const manager = createWorkspaceManager();

try {
  const projectRoot = path.join(root, 'project');
  const repository = path.join(projectRoot, 'repository');
  const sources = path.join(projectRoot, 'sources');
  const upstream = path.join(sources, 'upstream');
  const template = path.join(root, 'template');
  await mkdir(repository, { recursive: true });
  await mkdir(upstream, { recursive: true });
  await mkdir(template, { recursive: true });
  await writeFile(path.join(repository, 'kernel.cu'), '// iteration baseline\n', 'utf8');
  await writeFile(path.join(upstream, 'reference.cu'), '// upstream reference\n', 'utf8');
  await writeFile(path.join(template, 'kernel.cu'), '// iteration baseline\n', 'utf8');
  for (const cwd of [repository, upstream]) {
    await execFileAsync('git', ['init'], { cwd });
    await execFileAsync('git', ['config', 'user.name', 'Three Layer Test'], { cwd });
    await execFileAsync('git', ['config', 'user.email', 'three-layer@local.invalid'], { cwd });
  }
  await execFileAsync('git', ['add', '-A'], { cwd: repository });
  await execFileAsync('git', ['commit', '-m', 'iteration baseline'], { cwd: repository });
  await execFileAsync('git', ['add', '-A'], { cwd: upstream });
  await execFileAsync('git', ['commit', '-m', 'upstream baseline'], { cwd: upstream });
  const upstreamCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
  await execFileAsync('git', ['remote', 'add', 'origin', 'https://example.invalid/upstream.git'], { cwd: upstream });
  const workspace = path.join(projectRoot, '.operator-studio', 'workspaces', 'MIS_THREE', 'repository');
  const snapshot = await manager.ensure({ missionId: 'MIS_THREE', target: workspace, repository, template, mode: 'snapshot' });
  assert.equal(snapshot.ready, true);

  await writeFile(path.join(upstream, 'reference.cu'), '// upstream changed outside iteration diff\n', 'utf8');
  const sourceReference = { repository: 'https://example.invalid/upstream.git', commit: upstreamCommit, path: 'reference.cu' };
  const cleanSource = await manager.inspectSources(sources, [sourceReference]);
  assert.equal(cleanSource.ready, false);
  assert.equal(cleanSource.errors[0].code, 'SOURCE_REPOSITORY_DIRTY');

  await execFileAsync('git', ['checkout', '--', 'reference.cu'], { cwd: upstream });
  const verifiedSource = await manager.inspectSources(sources, [sourceReference]);
  assert.equal(verifiedSource.ready, true, JSON.stringify(verifiedSource));
  assert.equal(verifiedSource.references[0].verified, true);
  const runtimeRoot = path.join(projectRoot, '.operator-studio');
  const registry = await manager.updateSourceRegistry({ sourceRoot: sources, runtimeRoot, missionId: 'MIS_THREE', references: [sourceReference] });
  assert.equal(registry.sources.length, 1);
  assert.equal(registry.sources[0].commit, upstreamCommit);
  assert.equal(registry.sources[0].lastUsedByMission, 'MIS_THREE');
  assert.deepEqual(registry.sources[0].referencedPaths, ['reference.cu']);
  // A repository-level reference is a first-class scope, not an empty path that happens to
  // be tolerated: it asserts "this repository at this commit" and resolves to the source
  // entry itself. It must verify without inventing a file, and the empty-path shorthand
  // must never be promoted to a file reference (or vice versa).
  const repositoryReference = { repository: 'https://example.invalid/upstream.git', commit: upstreamCommit, scope: 'repository' };
  const repositoryLevel = await manager.inspectSources(sources, [repositoryReference]);
  assert.equal(repositoryLevel.ready, true, JSON.stringify(repositoryLevel));
  assert.equal(repositoryLevel.references[0].verified, true, 'a repository-level reference verifies without a file path');
  assert.equal(repositoryLevel.references[0].scope, 'repository');
  assert.equal(repositoryLevel.references[0].sourceId, 'upstream', 'a repository-level reference resolves to the registered source');
  const shorthand = await manager.inspectSources(sources, [{ repository: 'https://example.invalid/upstream.git', commit: upstreamCommit, path: '' }]);
  assert.equal(shorthand.ready, true, 'the empty-path shorthand still means repository level');
  assert.equal(shorthand.references[0].scope, 'repository');
  const fileWithoutPath = await manager.inspectSources(sources, [{ repository: 'https://example.invalid/upstream.git', commit: upstreamCommit, scope: 'file', path: '' }]);
  assert.equal(fileWithoutPath.references[0].verified, false, 'an explicit file scope without a path is never silently promoted');
  assert.equal(fileWithoutPath.references[0].code, 'SOURCE_REFERENCE_PATH_INVALID');
  const unknownScope = await manager.inspectSources(sources, [{ repository: 'https://example.invalid/upstream.git', commit: upstreamCommit, scope: 'tree', path: 'reference.cu' }]);
  assert.equal(unknownScope.references[0].verified, false);
  assert.equal(unknownScope.references[0].code, 'SOURCE_REFERENCE_SCOPE_INVALID');
  const bothScopes = await manager.updateSourceRegistry({ sourceRoot: sources, runtimeRoot, missionId: 'MIS_THREE', references: [sourceReference, repositoryReference] });
  assert.equal(bothScopes.sources.length, 1);
  assert.equal(bothScopes.sources[0].referencedRepositoryLevel, true, 'the registry records a repository-level reference');
  assert.deepEqual(bothScopes.sources[0].referencedPaths, ['reference.cu'], 'a repository-level reference contributes no file path');
  const persistedRegistry = JSON.parse(await readFile(path.join(runtimeRoot, 'source-registry.json'), 'utf8'));
  assert.equal(persistedRegistry.sources[0].repository, 'https://example.invalid/upstream.git');
  assert.equal(persistedRegistry.sources[0].referencedRepositoryLevel, true, 'the repository-level marker survives a reload');
  await writeFile(path.join(workspace, 'kernel.cu'), '// actual iteration change\n', 'utf8');
  const diff = await manager.captureDiff(workspace);
  assert.deepEqual(diff.changedFiles, ['kernel.cu']);
  assert.doesNotMatch(diff.diff, /reference\.cu/);
  assert.doesNotMatch(diff.diff, /upstream changed/);
  assert.equal((await readFile(path.join(upstream, 'reference.cu'), 'utf8')).trim(), '// upstream reference');
  const patchPath = path.join(projectRoot, '.operator-studio', 'candidate.patch');
  await writeFile(patchPath, diff.diff, 'utf8');
  const adoption = await manager.adoptPatch({ repository, patchPath, candidateId: 'candidate-three-layer' });
  assert.notEqual(adoption.commit, adoption.previousHead);
  assert.equal((await readFile(path.join(repository, 'kernel.cu'), 'utf8')).trim(), '// actual iteration change');
  const adoptionSubject = (await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: repository })).stdout.trim();
  assert.equal(adoptionSubject, 'Operator Studio adopt candidate-three-layer');
  const reverted = await manager.revertAdoption({ repository, commit: adoption.commit });
  assert.notEqual(reverted.revertCommit, adoption.commit);
  assert.equal((await readFile(path.join(repository, 'kernel.cu'), 'utf8')).trim(), '// iteration baseline');
  console.log('[three-layer] source registry, iteration repository, and snapshot diff boundaries passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
