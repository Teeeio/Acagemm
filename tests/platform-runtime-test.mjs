import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platformPythonLayout, quoteCommandArgument, resolveCanonicalStorageRoot, resolvePythonExecutable } from '../client-runtime/platform-runtime.mjs';

// Use a native absolute root so the same contract test can simulate both
// platform layouts without asking POSIX path.resolve() to interpret a
// Windows drive-letter path (or vice versa).
const root = path.resolve('operator-studio');
const existing = new Set([
  path.join(root, '.gpu-venv', 'bin', 'python'),
  path.join(root, '.gpu-venv', 'Scripts', 'python.exe'),
]);
const exists = (candidate) => existing.has(candidate);

assert.equal(resolvePythonExecutable({ rootDir: root, platform: 'linux', env: {}, exists }), path.join(root, '.gpu-venv', 'bin', 'python'));
assert.equal(resolvePythonExecutable({ rootDir: root, platform: 'win32', env: {}, exists }), path.join(root, '.gpu-venv', 'Scripts', 'python.exe'));
assert.equal(resolvePythonExecutable({ rootDir: root, platform: 'linux', env: { OPERATOR_GPU_PYTHON: '/opt/cuda/bin/python' }, exists }), '/opt/cuda/bin/python');
assert.equal(resolvePythonExecutable({ rootDir: root, platform: 'linux', env: { PYTHON: '/opt/python/bin/python' }, exists }), '/opt/python/bin/python');
assert.equal(resolvePythonExecutable({ rootDir: root, platform: 'linux', env: {}, exists: () => false }), 'python3');
assert.equal(resolvePythonExecutable({ rootDir: root, platform: 'win32', env: {}, exists: () => false }), 'python');
assert.deepEqual(platformPythonLayout('linux'), { virtualEnvironmentBin: 'bin', executable: 'python', fallback: 'python3' });
assert.deepEqual(platformPythonLayout('win32'), { virtualEnvironmentBin: 'Scripts', executable: 'python.exe', fallback: 'python' });
assert.equal(quoteCommandArgument('/opt/operator studio/.gpu-venv/bin/python', 'linux'), "'/opt/operator studio/.gpu-venv/bin/python'");
assert.equal(quoteCommandArgument('C:\\Operator Studio\\python.exe', 'win32'), '"C:\\Operator Studio\\python.exe"');
console.log('[platform-runtime] cross-platform Python resolution and shell quoting passed');

// The resolver port exercises failures without changing host ACLs or filesystem
// settings. Only ENOENT may remove one uncreated suffix component at a time.
const selected = path.join(root, 'selected');
const requested = path.join(selected, 'missing 中文', '~draft', 'build~3');
const canonical = path.join(root, 'Canonical selected');
const calls = [];
assert.equal(resolveCanonicalStorageRoot(requested, {
  platform: 'win32',
  realpath: (candidate) => {
    calls.push(candidate);
    if (candidate === selected) return canonical;
    throw Object.assign(new Error('not created'), { code: 'ENOENT' });
  },
}), path.join(canonical, 'missing 中文', '~draft', 'build~3'));
assert.deepEqual(calls, [
  requested, path.dirname(requested), path.dirname(path.dirname(requested)), selected,
]);
for (const code of ['EACCES', 'EIO', 'ENOTDIR', 'EPERM', 'ELOOP', undefined]) {
  const failure = Object.assign(new Error('filesystem failure'), { code });
  const attempts = [];
  assert.throws(() => resolveCanonicalStorageRoot(requested, {
    platform: 'win32',
    realpath: (candidate) => { attempts.push(candidate); throw failure; },
  }), (error) => error === failure);
  assert.deepEqual(attempts, [requested], 'non-ENOENT must not fall back to a parent');
  attempts.length = 0;
  assert.throws(() => resolveCanonicalStorageRoot(requested, {
    platform: 'win32',
    realpath: (candidate) => {
      attempts.push(candidate);
      if (candidate === requested) throw Object.assign(new Error('missing leaf'), { code: 'ENOENT' });
      throw failure;
    },
  }), (error) => error === failure);
  assert.deepEqual(attempts, [requested, path.dirname(requested)], 'parent failure must also propagate');
}
const absentRoot = Object.assign(new Error('missing volume'), { code: 'ENOENT' });
let rootCalls = 0;
assert.throws(() => resolveCanonicalStorageRoot(path.parse(root).root, {
  platform: 'win32', realpath: () => { rootCalls++; throw absentRoot; },
}), (error) => error === absentRoot);
assert.equal(rootCalls, 1, 'root absence must terminate traversal');
for (const platform of ['linux', 'darwin']) {
  const input = path.join('chosen 中文', 'build~3', 'folder:stream', 'trailing. ');
  assert.equal(resolveCanonicalStorageRoot(input, {
    platform, realpath: () => { throw new Error('non-Windows must not probe the filesystem'); },
  }), path.resolve(input));
}

for (const input of [
  '\\\\?\\C:\\selected', '\\\\.\\C:\\selected', '\\??\\C:\\selected',
  '//?/UNC/server/share/selected', '//./pipe/selected',
  'C:\\selected:stream', 'C:\\selected\\file::$DATA', 'selected:stream',
  'C:\\selected.\\child', 'C:\\selected \\child', 'C:\\selected\\child.',
  'C:\\selected\\child ', 'C:\\selected.\\..\\otherwise-valid',
  'C:\\selected\\NUL', 'C:\\selected\\con.txt', 'C:\\selected\\LPT1',
  'C:\\selected\\COM¹.log', 'C:\\selected\\CONOUT$',
  'C:\\selected\\bad?name', 'C:\\selected\\bad\u0000name',
]) {
  assert.throws(() => resolveCanonicalStorageRoot(input, {
    platform: 'win32', realpath: () => { throw new Error('invalid raw spelling reached realpath'); },
  }), { code: 'PLATFORM_STORAGE_ROOT_INVALID' }, input);
}
for (const leaf of ['普通中文', 'ordinary spaces', '~draft', 'build~3']) {
  const input = path.join(selected, leaf);
  assert.equal(resolveCanonicalStorageRoot(input, {
    platform: 'win32', realpath: (candidate) => { assert.equal(candidate, input); return candidate; },
  }), input);
}
console.log('[platform-runtime] missing-prefix traversal, filesystem failure and raw Windows input contracts passed');

// Real native filesystem coverage: no guessed 8.3 mappings, permissions or host
// setting changes. A volume without short names reports that limitation.
if (process.platform === 'win32') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'operator storage path 中文-'));
  try {
    const longPath = fs.realpathSync.native(temporary);
    const shortPath = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $fs = New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder($env:OPERATOR_TEST_STORAGE_PATH).ShortPath',
    ], {
      env: { ...process.env, OPERATOR_TEST_STORAGE_PATH: longPath },
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    }).trim();
    assert.ok(shortPath, 'Windows must return the actual path spelling');
    assert.equal(fs.realpathSync.native(shortPath), longPath);
    const longIdentity = fs.statSync(longPath, { bigint: true });
    const shortIdentity = fs.statSync(shortPath, { bigint: true });
    assert.equal(shortIdentity.dev, longIdentity.dev);
    assert.equal(shortIdentity.ino, longIdentity.ino, 'short and long paths identify the same directory');
    assert.equal(resolveCanonicalStorageRoot(shortPath), longPath);
    assert.equal(resolveCanonicalStorageRoot(longPath), longPath);
    const suffix = path.join('尚未创建 with spaces', '~draft', 'build~3');
    assert.equal(resolveCanonicalStorageRoot(path.join(shortPath, suffix)), path.join(longPath, suffix));
    assert.equal(resolveCanonicalStorageRoot(path.join(longPath, suffix)), path.join(longPath, suffix));
    assert.equal(fs.existsSync(path.join(longPath, suffix)), false, 'resolution must not create the suffix');
    for (const leaf of ['普通中文', 'ordinary spaces', '~draft', 'build~3']) {
      const actual = path.join(longPath, leaf);
      fs.mkdirSync(actual);
      assert.equal(resolveCanonicalStorageRoot(path.join(shortPath, leaf)), actual, 'literal names must survive native resolution');
    }
    console.log(shortPath.toLowerCase() !== longPath.toLowerCase()
      ? '[platform-runtime] real Windows short/long identity, missing suffix and literal tilde names passed'
      : '[platform-runtime] real Windows paths passed; distinct 8.3 alias unavailable on this volume');
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  console.log('[platform-runtime] real Windows filesystem cases skipped on this platform');
}
