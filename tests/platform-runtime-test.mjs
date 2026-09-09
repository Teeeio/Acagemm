import assert from 'node:assert/strict';
import path from 'node:path';
import { platformPythonLayout, quoteCommandArgument, resolvePythonExecutable } from '../client-runtime/platform-runtime.mjs';

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
