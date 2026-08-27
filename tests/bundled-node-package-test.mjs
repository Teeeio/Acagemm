import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.19.0';
const archiveName = `node-v${version}-linux-x64.tar.xz`;
const expectedSha256 = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';
const archive = await readFile(path.join(root, 'vendor', 'node', archiveName));
const dependencyArchive = await readFile(path.join(root, 'vendor', 'node', 'node-modules-linux-x64.tar.gz'));
const dependencyArchivePath = path.join(root, 'vendor', 'node', 'node-modules-linux-x64.tar.gz');
const officialSums = await readFile(path.join(root, 'vendor', 'node', 'SHASUMS256.txt'), 'utf8');
const installer = await readFile(path.join(root, 'scripts', 'install-bundled-node.sh'), 'utf8');
const wrapper = await readFile(path.join(root, 'scripts', 'with-bundled-node.sh'), 'utf8');
const launcher = await readFile(path.join(root, 'tools', 'local-c500-tester', 'launcher.cjs'), 'utf8');

assert.ok(archive.length > 30_000_000, 'bundled Node archive is unexpectedly small');
assert.equal(archive.subarray(0, 6).toString('hex'), 'fd377a585a00', 'archive must have an XZ header');
assert.equal(createHash('sha256').update(archive).digest('hex'), expectedSha256);
assert.ok(dependencyArchive.length > 10_000_000, 'bundled Linux dependencies are unexpectedly small');
assert.equal(createHash('sha256').update(dependencyArchive).digest('hex'), '04ebed39d8752ffb614e0659360037f0455a1704bfe208d4617d99709a380e3d');
const archiveListing = spawnSync('tar', ['-tzf', dependencyArchivePath], { encoding: 'utf8', windowsHide: true });
assert.equal(archiveListing.status, 0, archiveListing.stderr || 'unable to inspect bundled dependencies');
for (const required of ['node_modules/ink/package.json', 'node_modules/react/package.json', 'node_modules/yoga-layout/package.json', 'node_modules/@esbuild/linux-x64/bin/esbuild']) {
  assert.match(archiveListing.stdout, new RegExp(`^${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\r?$`, 'm'));
}
assert.match(officialSums, new RegExp(`^${expectedSha256}  ${archiveName.replaceAll('.', '\\.')}\\r?$`, 'm'));
assert.match(installer, /NODE_VERSION='24\.19\.0'/);
assert.match(installer, new RegExp(`EXPECTED_SHA256='${expectedSha256}'`));
assert.match(installer, /uname -m/);
assert.match(installer, /sha256sum/);
assert.match(installer, /bin\/node.*npm-cli\.js/);
assert.match(wrapper, /NODE_VERSION='24\.19\.0'/);
assert.match(wrapper, /exec "\$@"/);
assert.doesNotMatch(launcher, /\?\.|\?\?/);
assert.doesNotMatch(launcher, /require\(['"]node:/);
assert.match(launcher, /currentMajor >= 20/);
assert.match(launcher, /bundled Node v/);
assert.match(launcher, /node-modules-linux-x64\.tar\.gz/);
assert.match(launcher, /installing locked dependencies|extracting bundled Linux dependencies/);
assert.match(launcher, /OPERATOR_RUNTIME_MODE:\s*'claude-code'/);
assert.match(launcher, /OPERATOR_LOCAL_C500_MOCK:\s*'0'/);
assert.match(launcher, /delete launchEnvironment\.LOCAL_C500_API_URL/);
assert.match(launcher, /delete launchEnvironment\.OPERATOR_LOCAL_C500_COMMAND/);
assert.match(launcher, /delete launchEnvironment\.OPERATOR_MUXI_DEVICE/);
assert.doesNotMatch(launcher, /process\.env\.OPERATOR_BUNDLED_NODE_HOME/);

process.stdout.write('[bundled-node-package] official archive, checksum, installer, and wrapper passed\n');
