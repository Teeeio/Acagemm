import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importExecutionPackage } from '../client-runtime/execution-package-import.mjs';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'operator-import-'));
const source = path.join(root, 'source');
await mkdir(path.join(source, 'deps'), { recursive: true });
await writeFile(path.join(source, 'run.py'), 'print("candidate")');
await writeFile(path.join(source, 'oracle.py'), 'print("oracle")');
await writeFile(path.join(source, 'deps', 'helper.py'), 'VALUE = 1');
const calls = [];
const store = { assemble: async (input) => { calls.push(input); return { packageDigest: 'sha256:' + 'a'.repeat(64), manifest: { entrypoints: { candidate: input.candidateEntrypoint, acceptance: input.acceptance.entrypoint } } }; } };
try {
  const imported = await importExecutionPackage({ store, sourcePath: source, language: 'python', adapter: { id: 'a', version: '1' }, environmentId: 'env', binding: { missionId: 'm', workspaceId: 'w', candidateId: 'c', candidateDigest: 'sha256:' + 'b'.repeat(64) }, candidateEntrypoint: 'run.py', acceptanceEntrypoint: 'oracle.py', testSpec: { cases: ['minimal'] }, semanticDigest: 'sha256:' + 'c'.repeat(64) });
  assert.equal(imported.source.type, 'directory');
  assert.deepEqual(Object.keys(calls[0].candidateFiles), ['run.py']);
  assert.deepEqual(Object.keys(calls[0].dependencyFiles), ['deps/helper.py']);
  assert.deepEqual(Object.keys(calls[0].acceptance.files), ['oracle.py']);
  const archive = path.join(root, 'source.tar');
  await exec('tar', ['-cf', archive, '-C', source, '.']);
  const fromArchive = await importExecutionPackage({ store, sourcePath: archive, language: 'python', adapter: { id: 'a', version: '1' }, environmentId: 'env', binding: { missionId: 'm', workspaceId: 'w', candidateId: 'c', candidateDigest: 'sha256:' + 'b'.repeat(64) }, candidateEntrypoint: 'run.py', acceptanceEntrypoint: 'oracle.py', testSpec: { cases: ['minimal'] }, semanticDigest: 'sha256:' + 'c'.repeat(64) });
  assert.equal(fromArchive.source.type, 'archive');
  assert.equal(fromArchive.source.fileCount, 3);
  await assert.rejects(() => importExecutionPackage({ store, sourcePath: source, candidateEntrypoint: 'missing.py', acceptanceEntrypoint: 'oracle.py' }), (error) => error.code === 'PACKAGE_ENTRYPOINT_INVALID');
  await assert.rejects(() => importExecutionPackage({ store, sourcePath: path.join(source, 'run.py'), candidateEntrypoint: 'run.py', acceptanceEntrypoint: 'oracle.py' }), (error) => error.code === 'PACKAGE_SOURCE_INVALID');
  console.log('[execution-package-import] directory/archive import, dependency closure and unsafe-link checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
