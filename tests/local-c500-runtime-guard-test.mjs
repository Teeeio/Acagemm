import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4398;
const home = await mkdtemp(path.join(os.tmpdir(), 'local-c500-runtime-guard-'));
const environment = {
  ...process.env,
  API_PORT: String(port),
  SERVE_WEB: 'false',
  OPERATOR_RUNTIME_MODE: 'reference-fixture',
  OPERATOR_TEST_BACKEND: 'local-c500',
  OPERATOR_LOCAL_C500_MOCK: '1',
  OPERATOR_LOCAL_C500_SIMULATION: '1',
  OPERATOR_AUTO_TICK: '1',
  OPERATOR_AUTO_TICK_INTERVAL_MS: '1000',
  OPERATOR_RUNTIME_OWNER_PID: String(process.pid),
  OPERATOR_DATA_DIR: path.join(home, 'data'),
  OPERATOR_RUNTIME_DIR: path.join(home, 'runtime'),
  OPERATOR_LOCAL_C500_DIR: path.join(home, 'tasks'),
};

const startRuntime = () => spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: root,
  env: environment,
  stdio: ['ignore', 'ignore', 'pipe'],
});
const waitForHealth = async (child, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`runtime exited before health: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('runtime did not become healthy');
};
const waitForExit = (child, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('runtime did not exit')), timeoutMs);
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

let first = null;
let duplicate = null;
try {
  first = startRuntime();
  const health = await waitForHealth(first);
  const pidPath = path.join(home, 'runtime', 'operator-studio.pid');
  const pidBefore = (await readFile(pidPath, 'ascii')).trim();

  duplicate = startRuntime();
  const duplicateExit = await waitForExit(duplicate);
  const pidAfter = (await readFile(pidPath, 'ascii')).trim();

  assert.equal(duplicateExit.code, 98);
  assert.equal(pidAfter, pidBefore);
  assert.equal(health.__bridge?.pid, Number(pidBefore));
  console.log('[local-c500-runtime-guard] duplicate runtime exits without PID overwrite');
} finally {
  if (duplicate && duplicate.exitCode == null) duplicate.kill();
  if (first && first.exitCode == null) {
    first.kill('SIGTERM');
    await new Promise((resolve) => first.once('exit', resolve));
  }
  await rm(home, { recursive: true, force: true });
}
