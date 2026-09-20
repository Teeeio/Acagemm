// A Mission Agent must read its own workspace's conventions, not this machine's. Codex draws
// its global instruction documents from $CODEX_HOME, and `--ignore-user-config` does not cover
// them, so the adapter pins a home it owns. This test asserts that contract without a model:
// the host home here is a fixture, so no real credential is read or copied.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexClient } from '../client-runtime/codex-client.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-codex-home-'));
const bridgeDir = path.join(root, 'bridge');
const hostHome = path.join(root, 'host-codex-home');
await mkdir(hostHome, { recursive: true });
// The host home carries exactly the two things that matter here: the machine-wide instruction
// document that must not reach a Mission Agent, and the credential that must still work.
const hostPolicy = 'HOST_POLICY_MARKER\n';
const hostCredential = '{"auth_mode":"chatgpt","tokens":{"access_token":"fixture"}}\n';
await writeFile(path.join(hostHome, 'AGENTS.md'), hostPolicy, 'utf8');
await writeFile(path.join(hostHome, 'auth.json'), hostCredential, 'utf8');

const exists = async (target) => Boolean(await stat(target).catch(() => null));
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};
const readRecord = async (runId) => JSON.parse(await readFile(path.join(bridgeDir, 'codex-runs', `${runId}.json`), 'utf8'));

const spawnCalls = [];
const execFileImpl = (command, args, options, callback) => callback(new Error(`unexpected probe: ${args.join(' ')}`), '', '');
const spawnImpl = (command, args, options) => {
  spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 2468;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
  child.stdin.on('finish', async () => {
    child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-iso' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } }) + '\n');
    child.stdout.end();
    // Long enough to inspect the home while the run is still live.
    setTimeout(() => child.emit('close', 0, null), 250);
  });
  return child;
};

const buildClient = (extra = {}) => createCodexClient({
  command: 'codex-test', bridgeDir, hostCodexHome: hostHome, execFileImpl, spawnImpl, ...extra,
});
const lastHome = () => spawnCalls.at(-1).env.CODEX_HOME;

let cleanupOk = false;
try {
  // 1. Default: the run gets a home the adapter owns, holding the credential and nothing else.
  const isolatedHome = path.join(bridgeDir, 'codex-home', 'MIS_ISO');
  const client = buildClient();
  const run = await client.start({ missionId: 'MIS_ISO', goal: 'isolate me', workspace: root });
  assert.equal(lastHome(), isolatedHome, 'the child must be pointed at the adapter-owned home');
  assert.deepEqual((await readdir(isolatedHome)).sort(), ['auth.json'],
    'only the credential may be carried over; a host AGENTS.md here would re-enter every run');
  assert.equal(await readFile(path.join(isolatedHome, 'auth.json'), 'utf8'), hostCredential);
  const liveRecord = await readRecord(run.runId);
  assert.equal(liveRecord.codexHomeIsolated, true);
  assert.equal(liveRecord.codexHome, isolatedHome);
  assert.deepEqual(liveRecord.codexHomeSeededCredentials, ['auth.json'],
    'what was seeded is recorded so "did this run inherit host credentials" stays auditable');

  // 2. The seeded credential does not outlive the run; the home does, because a home's session
  // rollouts are the record of what instructions a run actually received.
  assert.ok(await waitFor(async () => !(await exists(path.join(isolatedHome, 'auth.json')))), 'seeded credential must be removed when the run settles');
  assert.equal(await exists(isolatedHome), true);
  assert.equal((await client.readRun(run.runId)).status, 'completed');

  // 3. A resumed thread is looked up in the home that created it, so the scope is the Mission.
  const second = buildClient();
  await second.start({ missionId: 'MIS_ISO', goal: 'same mission again', workspace: root });
  assert.equal(lastHome(), isolatedHome, 'the same Mission must reuse its home or resume breaks');
  assert.equal(await exists(path.join(isolatedHome, 'auth.json')), true, 'a later run re-seeds the credential it needs');
  await waitFor(async () => !(await exists(path.join(isolatedHome, 'auth.json'))));
  const otherHome = path.join(bridgeDir, 'codex-home', 'MIS_OTHER');
  await buildClient().start({ missionId: 'MIS_OTHER', goal: 'a different mission', workspace: root });
  assert.equal(lastHome(), otherHome);
  assert.notEqual(otherHome, isolatedHome);
  await waitFor(async () => !(await exists(path.join(otherHome, 'auth.json'))));

  // 4. Opt out: the host home is used exactly as the environment provides it.
  const inherited = process.env.CODEX_HOME;
  const optedOut = await buildClient({ isolateCodexHome: false }).start({ missionId: 'MIS_HOST', goal: 'no isolation', workspace: root });
  assert.equal(lastHome(), inherited, 'isolation off must leave $CODEX_HOME untouched');
  assert.equal(await exists(path.join(bridgeDir, 'codex-home', 'MIS_HOST')), false, 'isolation off must not create a home');
  const optedOutRecord = await readRecord(optedOut.runId);
  assert.equal(optedOutRecord.codexHomeIsolated, false);
  assert.equal(optedOutRecord.codexHome, inherited ?? null);

  // 5. Per-run escape hatch: an explicit CODEX_HOME belongs to the operator, and is not ours to
  // seed or clean.
  const operatorHome = path.join(root, 'operator-home');
  await mkdir(operatorHome, { recursive: true });
  const escaped = await buildClient().start({
    missionId: 'MIS_OPERATOR', goal: 'operator home', workspace: root, environment: { CODEX_HOME: operatorHome },
  });
  assert.equal(lastHome(), operatorHome);
  assert.equal(await exists(path.join(bridgeDir, 'codex-home', 'MIS_OPERATOR')), false);
  const escapedRecord = await readRecord(escaped.runId);
  assert.equal(escapedRecord.codexHomeIsolated, false);
  assert.equal(escapedRecord.codexHome, operatorHome);

  cleanupOk = true;
  console.log('codex home isolation: ok');
} finally {
  if (!cleanupOk) process.exitCode = 1;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
