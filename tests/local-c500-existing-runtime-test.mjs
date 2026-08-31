import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promptExistingRuntime } from '../tools/local-c500-tester/existing-runtime-prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'local-c500-existing-runtime-'));
const runtimeDir = path.join(home, 'runtime');
const dataDir = path.join(home, 'data');
const taskDir = path.join(home, 'tasks');
const productionApiUrl = pathToFileURL(path.join(root, 'tools/local-c500-tester/production-api.mjs')).href;

const availablePort = async () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;

const promptChoice = async (answer, canReuse = true) => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const pending = promptExistingRuntime({ ownerPid: 101, runtimePid: 202, executionMode: 'real-c550', mode: 'claude-code', canReuse }, { input, output });
  setImmediate(() => input.write(`${answer}\n`));
  return { choice: await pending, rendered };
};

const defaultPrompt = await promptChoice('');
assert.equal(defaultPrompt.choice, 'reuse');
assert.match(defaultPrompt.rendered, /连接旧实例/);
assert.match(defaultPrompt.rendered, /停止旧实例/);
assert.equal((await promptChoice('2')).choice, 'replace');
assert.equal(await promptExistingRuntime({}, { input: new PassThrough(), output: new PassThrough() }), 'cancel');

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const waitForExit = async (child, timeoutMs = 10000) => {
  if (child.exitCode != null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
};
const health = async () => {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
};
const waitForHealth = async (predicate = Boolean, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await health();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for runtime health state');
};

const baseEnvironment = {
  ...process.env,
  LOCAL_C500_TESTER_HOME: home,
  LOCAL_C500_API_PORT: String(port),
  OPERATOR_RUNTIME_MODE: 'reference-fixture',
  OPERATOR_TEST_BACKEND: 'local-c500',
  OPERATOR_LOCAL_C500_MOCK: '1',
  OPERATOR_LOCAL_C500_SIMULATION: '1',
  OPERATOR_LOCAL_C500_MOCK_SCENARIO: 'mla-three-round',
  OPERATOR_HARDWARE_DISABLED: '1',
  OPERATOR_AUTO_TICK: '1',
  OPERATOR_AUTO_TICK_INTERVAL_MS: '1000',
};

const runPolicy = async (policy) => {
  const source = `
    const { ensureProductionRuntime } = await import(${JSON.stringify(productionApiUrl)});
    try {
      const result = await ensureProductionRuntime({ existingRuntimePolicy: ${JSON.stringify(policy)} });
      console.log('__RESULT__' + JSON.stringify({ pid: result.__bridge.pid, ownerPid: result.__bridge.ownerPid }));
    } catch (error) {
      console.log('__ERROR__' + JSON.stringify({ code: error.code, message: error.message }));
      process.exitCode = 2;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: baseEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = await waitForExit(child, 20000);
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('__RESULT__'));
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('__ERROR__'));
  return {
    childPid: child.pid,
    exit,
    result: resultLine ? JSON.parse(resultLine.slice('__RESULT__'.length)) : null,
    error: errorLine ? JSON.parse(errorLine.slice('__ERROR__'.length)) : null,
    stdout,
    stderr,
  };
};

let owner = null;
let runtime = null;
let fakeServer = null;
try {
  owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fakeServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ service: 'unrecognized-service', __bridge: { pid: process.pid, ownerPid: owner.pid, port } }));
  });
  await new Promise((resolve, reject) => {
    fakeServer.once('error', reject);
    fakeServer.listen(port, '127.0.0.1', resolve);
  });
  const unsafeReplace = await runPolicy('replace');
  assert.equal(unsafeReplace.exit.code, 2, unsafeReplace.stderr);
  assert.equal(unsafeReplace.error?.code, 'LOCAL_C500_UNRECOGNIZED_RUNTIME');
  assert.equal(isAlive(owner.pid), true);
  await new Promise((resolve, reject) => fakeServer.close((error) => error ? reject(error) : resolve()));
  fakeServer = null;

  runtime = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
    cwd: root,
    env: {
      ...baseEnvironment,
      API_PORT: String(port),
      SERVE_WEB: 'false',
      OPERATOR_RUNTIME_OWNER_PID: String(owner.pid),
      OPERATOR_DATA_DIR: dataDir,
      OPERATOR_RUNTIME_DIR: runtimeDir,
      OPERATOR_LOCAL_C500_DIR: taskDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const original = await waitForHealth((value) => value?.__bridge?.ownerPid === owner.pid);

  const cancelled = await runPolicy('cancel');
  assert.equal(cancelled.exit.code, 2, cancelled.stderr);
  assert.equal(cancelled.error?.code, 'LOCAL_C500_RUNTIME_CONFLICT');
  assert.equal(isAlive(owner.pid), true);
  assert.equal((await health())?.__bridge?.pid, original.__bridge.pid);

  const reused = await runPolicy('reuse');
  assert.equal(reused.exit.code, 0, reused.stderr);
  assert.equal(reused.result?.pid, original.__bridge.pid);
  assert.equal(reused.result?.ownerPid, owner.pid);
  assert.equal(isAlive(owner.pid), true);
  assert.equal((await health())?.__bridge?.pid, original.__bridge.pid);

  const replaced = await runPolicy('replace');
  assert.equal(replaced.exit.code, 0, replaced.stderr);
  assert.notEqual(replaced.result?.pid, original.__bridge.pid);
  assert.equal(replaced.result?.ownerPid, replaced.childPid);
  await waitForExit(owner);
  await waitForHealth((value) => value == null);

  console.log('[local-c500-existing-runtime] cancel, reuse, and replace ownership paths passed');
} finally {
  if (fakeServer?.listening) await new Promise((resolve) => fakeServer.close(resolve));
  if (owner && isAlive(owner.pid)) owner.kill('SIGTERM');
  if (runtime && isAlive(runtime.pid)) runtime.kill('SIGTERM');
  const current = await health();
  const currentPid = Number(current?.__bridge?.pid || 0);
  if (isAlive(currentPid)) process.kill(currentPid, 'SIGTERM');
  await rm(home, { recursive: true, force: true });
}
