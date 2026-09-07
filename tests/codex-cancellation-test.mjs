import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'codex-cancel-proof-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
const mockSpawn = () => {
  const child = new EventEmitter();
  child.pid = 432100 + children.length;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  children.push(child);
  return child;
};
const bridgeDir = path.join(root, 'bridge');
const testClient = (options = {}) => createCodexClient({
  command: 'codex-mock', bridgeDir, spawnImpl: mockSpawn, cancelGraceMs: 20, cancelForceMs: 20, logicalCleanupMs: 500,
  terminateProcessTree: async ({ child, force }) => { if (force) child.emit('close', null, 'SIGKILL'); return true; },
  ...options,
});
const waitUntil = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail(message);
};
let helper;
let descendantPid;
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
try {
  const signals = [];
  const client = testClient({ terminateProcessTree: async ({ child, force }) => {
    signals.push(force); if (force) child.emit('close', null, 'SIGKILL'); return true;
  } });
  await client.start({ runId: 'mock_cancel', missionId: 'MIS_CANCEL', workspace: root, goal: 'mock only' });
  const cancelled = await client.cancel('mock_cancel');
  assert.deepEqual(signals, [false, true], 'grace expiry escalates to actual process-tree termination');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.resourceRelease.confirmed, true);
  assert.ok(cancelled.process.exitedAt);

  const stubborn = testClient({ terminateProcessTree: async () => false });
  await stubborn.start({ runId: 'mock_stubborn', workspace: root });
  const unconfirmed = await stubborn.cancel('mock_stubborn');
  assert.equal(unconfirmed.status, 'cancel_requested');
  assert.equal(unconfirmed.resourceRelease.status, 'unconfirmed');
  assert.equal(unconfirmed.resourceRelease.confirmed, false);
  const bytes = await readFile(path.join(bridgeDir, 'codex-runs', 'mock_stubborn.json'), 'utf8');
  const recovered = testClient();
  assert.equal((await recovered.readRun('mock_stubborn')).resourceRelease.code, 'CODEX_EXECUTION_OWNER_UNAVAILABLE');
  assert.equal(await readFile(path.join(bridgeDir, 'codex-runs', 'mock_stubborn.json'), 'utf8'), bytes, 'recovery inspection is read-only');

  const completedClient = testClient();
  await completedClient.start({ runId: 'mock_logical', workspace: root });
  const logicalChild = children.at(-1);
  logicalChild.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  await delay(20);
  assert.notEqual((await completedClient.readRun('mock_logical')).status, 'completed', 'turn event alone cannot release the process');
  logicalChild.emit('close', 0, null);
  await waitUntil(async () => (await completedClient.readRun('mock_logical')).status === 'completed', 'logical completion must settle after close');
  assert.equal((await completedClient.readRun('mock_logical')).resourceRelease.confirmed, true);

  // A short-lived Node process tree exercises the real OS termination path.
  // No Codex executable, provider, Python, hardware, or network is invoked.
  const code = "const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify({type:'helper.spawned',pid:c.pid}));setInterval(()=>{},1000)";
  const actual = createCodexClient({
    command: process.execPath, bridgeDir: path.join(root, 'actual'), cancelGraceMs: 100, cancelForceMs: 1000,
    spawnImpl: (_command, _args, options) => { helper = spawn(process.execPath, ['-e', code], options); return helper; },
  });
  const run = await actual.start({ runId: 'actual_process_tree', workspace: root });
  await waitUntil(async () => {
    descendantPid = (await actual.readEvents(run.runId)).find(event => event.type === 'helper.spawned')?.pid;
    return Boolean(descendantPid);
  }, 'helper must create its child');
  const result = await actual.cancel(run.runId);
  assert.equal(result.resourceRelease.confirmed, true, JSON.stringify(result));
  assert.equal(result.status, 'cancelled');
  await waitUntil(() => !alive(helper.pid) && !alive(descendantPid), 'both test-owned processes must exit');
  console.log('[codex-cancellation] force escalation, true exit, orphan isolation, read-only recovery and real process-tree cleanup passed');
} finally {
  if (process.platform === 'win32') {
    for (const pid of [helper?.pid, descendantPid].filter(pid => pid && alive(pid))) {
      await promisify(execFile)('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 2000 }).catch(() => {});
    }
  } else if (helper?.pid) {
    // The parent may already be gone while a test-owned descendant remains.
    try { process.kill(-helper.pid, 'SIGKILL'); } catch {}
  }
  for (const child of children) child.emit('close', 0, null);
  await delay(100);
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'codex-cancel-proof-')));
  await rm(root, { recursive: true, force: true });
}
