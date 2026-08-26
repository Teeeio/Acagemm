import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.19.0';
const archiveName = `node-v${version}-linux-x64.tar.xz`;
const expectedSha256 = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';
const archive = await readFile(path.join(root, 'vendor', 'node', archiveName));
const officialSums = await readFile(path.join(root, 'vendor', 'node', 'SHASUMS256.txt'), 'utf8');
const installer = await readFile(path.join(root, 'scripts', 'install-bundled-node.sh'), 'utf8');
const wrapper = await readFile(path.join(root, 'scripts', 'with-bundled-node.sh'), 'utf8');
const launcher = await readFile(path.join(root, 'tools', 'local-c500-tester', 'launcher.cjs'), 'utf8');

assert.ok(archive.length > 30_000_000, 'bundled Node archive is unexpectedly small');
assert.equal(archive.subarray(0, 6).toString('hex'), 'fd377a585a00', 'archive must have an XZ header');
assert.equal(createHash('sha256').update(archive).digest('hex'), expectedSha256);
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

process.stdout.write('[bundled-node-package] official archive, checksum, installer, and wrapper passed\n');
