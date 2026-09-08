// Integration/robustness: real short-lived Node CPU workers, no GPU or Agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-local-recovery-'));
const taskRoot = path.join(root, 'tasks');
const fixture = path.join(root, 'owned-worker.mjs');
const backendUrl = new URL('../client-runtime/local-c500-service-client.mjs', import.meta.url);
const worker = [
  "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
  "import { spawn } from 'node:child_process';",
  "import path from 'node:path';",
  'const dir = process.env.OPERATOR_LOCAL_C500_TASK_DIR;',
  "const task = JSON.parse(await readFile(path.join(dir, 'task.json'), 'utf8'));",
  "await appendFile(path.join(dir, 'launches.log'), process.pid + '\\n', 'utf8');",
  'const mode = task.payload.fixtureMode;',
  'const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  "const result = { benchmark: [{ environment: 'CPU', value: 1, unit: 'us', correctness: { passed: true, total: 1 } }], environment: { source: 'cpu-e2e', liveHardware: false } };",
  "if (mode === 'tree') {",
  "  const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });",
  "  await writeFile(path.join(dir, 'owned-pids.json'), JSON.stringify([process.pid, leaf.pid]));",
  '  setInterval(() => {}, 1000);',
  '  await new Promise(() => {});',
  '}',
  "if (mode === 'structured-error') {",
  "  result.status = 'failed'; result.benchmark = [];",
  "  result.error = { code: 'CPU_CANDIDATE_EXCEPTION', category: 'validation', phase: 'correctness', role: 'candidate', retryable: false, message: 'ValueError: network timeout inside a Python kernel', details: { exceptionType: 'ValueError' } };",
  '  result.correctness = { passed: false, total: 1, executedCases: 1, failure: result.error };',
  '  process.exitCode = 1;',
  '}',
  "if (mode !== 'early-result') await delay(mode === 'slow' ? 650 : 80);",
  "await writeFile(process.env.OPERATOR_LOCAL_C500_RESULT_JSON, JSON.stringify(result), 'utf8');",
  "if (mode === 'early-result') await delay(350);",
].join('\n');
await writeFile(fixture, worker, 'utf8');
process.env.OPERATOR_LOCAL_C500_DIR = taskRoot;
process.env.OPERATOR_RUNTIME_DIR = root;
process.env.OPERATOR_LOCAL_C500_COMMAND = '"' + process.execPath + '" "' + fixture + '"';
process.env.OPERATOR_HARDWARE_DISABLED = '1';
process.env.OPERATOR_LOCAL_CPU = '1';
delete process.env.OPERATOR_LOCAL_C500_MOCK;
delete process.env.OPERATOR_LOCAL_C500_MOCK_SCENARIO;
const { createLocalC500ServiceClient } = await import(backendUrl.href);
const client = createLocalC500ServiceClient({ cancelStepMs: 250, cancelTimeoutMs: 2_500 });
const tasks = [];
const queues = [];
const payload = (requestId, fixtureMode = 'normal') => ({
  requestId, missionId: 'MIS_LOCAL_RECOVERY', operator: 'identity', fixtureMode,
  candidate: { digest: 'sha256:' + 'b'.repeat(64) }, matrix: { environments: ['CPU'] },
  hardware: ['CPU'], limits: { timeoutSeconds: 5 }, runPy: 'def run(inputs): return inputs\n',
});
const submit = async (input) => { const task = await client.submit(input); tasks.push(task.taskId); return task; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (filename) => { try { return JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const observe = async (read, predicate, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await wait(30); }
  throw new Error('observation deadline: ' + JSON.stringify(value));
};
const ended = (snapshot) => ['completed', 'cancelled', 'failed'].includes(snapshot.status) && snapshot.resourceRelease?.confirmed;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// Managed Codex runners may deny WMI/CIM process inspection. In that mode the
// production contract is quarantine (never a false cancellation); skip only
// tests that require proving descendant termination, while retaining all
// durable-claim and timeout assertions.
const processTreeControlAvailable = process.platform !== 'win32'
  || spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object -First 1'], { windowsHide: true, stdio: 'ignore' }).status === 0;
const launches = async (taskId) => (await readFile(path.join(taskRoot, taskId, 'launches.log'), 'utf8')).trim().split(/\r?\n/).length;

test('local durable execution ownership', { timeout: 30_000 }, async (t) => {
  try {
    await t.test('submit is content-bound and idempotent before and after adapter restart', async () => {
      const input = payload('idempotent');
      const submitted = await Promise.all(Array.from({ length: 6 }, () => client.submit(input)));
      const task = submitted[0];
      tasks.push(task.taskId);
      assert.ok(submitted.every((item) => item.taskId === task.taskId));
      assert.equal((await client.get(task.taskId)).status, 'waiting');
      const before = await readFile(path.join(taskRoot, task.taskId, 'task.json'), 'utf8');
      assert.equal((await client.findByRequestId(input.requestId, input.missionId, input)).taskId, task.taskId);
      await client.events(task.taskId);
      assert.equal(await readFile(path.join(taskRoot, task.taskId, 'task.json'), 'utf8'), before);
      await assert.rejects(client.submit({ ...input, runPy: 'def run(inputs): return 99\n' }), (error) => error.code === 'OPERATOR_TEST_REQUEST_CONFLICT');
      await assert.rejects(client.submit({ ...payload('reserved-oracle'), implementationFiles: { 'oracle.py': 'tampered' } }), (error) => error.code === 'LOCAL_C500_ARTIFACT_PATH_INVALID');
      const restarted = (await import(backendUrl.href + '?idempotent-restart')).createLocalC500ServiceClient();
      assert.equal((await restarted.submit(input)).taskId, task.taskId);
      await client.advance(task.taskId);
      const result = await observe(() => restarted.advance(task.taskId), ended);
      assert.equal(result.status, 'completed');
      assert.equal(await launches(task.taskId), 1);
    });

    await t.test('result written before process exit is not terminal evidence', async () => {
      const task = await submit(payload('early-result', 'early-result'));
      await client.advance(task.taskId);
      await observe(() => readJson(path.join(taskRoot, task.taskId, 'result.json')), Boolean);
      const running = await client.advance(task.taskId);
      assert.equal(running.status, 'running');
      assert.equal(running.resourceRelease.confirmed, false);
      const complete = await observe(() => client.advance(task.taskId), ended);
      assert.equal(complete.status, 'completed');
    });

    await t.test('actual parent process restart cannot spawn a claimed task twice', async () => {
      const input = payload('process-restart', 'slow');
      const source = 'const { createLocalC500ServiceClient } = await import(' + JSON.stringify(backendUrl.href) + ');'
        + 'const c = createLocalC500ServiceClient(); const task = await c.submit(' + JSON.stringify(input) + ');'
        + 'await c.advance(task.taskId); console.log(JSON.stringify(task)); process.exit(0);';
      const launcher = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: process.env, cwd: root, encoding: 'utf8', timeout: 4_000, windowsHide: true, maxBuffer: 128 * 1024,
      });
      assert.equal(launcher.error, undefined, launcher.error?.message);
      assert.equal(launcher.status, 0, launcher.stderr);
      const task = JSON.parse(launcher.stdout.trim());
      tasks.push(task.taskId);
      const lookup = await client.findByRequestId(input.requestId, input.missionId, input);
      assert.equal(lookup.taskId, task.taskId);
      const resumed = await client.advance(task.taskId);
      assert.ok(['quarantined', 'completed'].includes(resumed.status));
      const completed = await observe(() => client.advance(task.taskId), ended);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.resourceRelease.confirmed, true);
      assert.equal(await launches(task.taskId), 1);
    });

    await t.test('lost submit response is recovered across queue recreation and executes once', async () => {
      let submitCalls = 0;
      const backend = {
        submit: async (input) => {
          submitCalls += 1;
          const accepted = await client.submit(input);
          tasks.push(accepted.taskId);
          throw Object.assign(new Error('response lost after durable acceptance'), { code: 'ECONNRESET' });
        },
        findByRequestId: client.findByRequestId, advance: client.advance, get: client.get, cancel: client.cancel,
      };
      const filename = path.join(root, 'lost-queue.jsonl');
      const first = createOperatorTestQueue({ serviceClient: backend, filePath: filename, ioTimeoutMs: 1_000 });
      queues.push(first);
      const queued = await first.submit(payload('lost-after-accept'));
      assert.equal((await first.process()).status, 'quarantined');
      await first.dispose();
      const recreated = createOperatorTestQueue({ serviceClient: backend, filePath: filename, ioTimeoutMs: 1_000 });
      queues.push(recreated);
      await recreated.process();
      const complete = await observe(async () => { await recreated.process(); return recreated.readTask(queued.taskId); }, ended);
      assert.equal(complete.status, 'completed');
      assert.equal(submitCalls, 1);
      assert.equal(await launches(complete.remoteTaskId), 1);
    });

    await t.test('unknown orphan is quarantined and cannot relaunch, even with result bytes', async () => {
      const task = await submit(payload('unknown-orphan'));
      const directory = path.join(taskRoot, task.taskId);
      const record = await readJson(path.join(directory, 'task.json'));
      const claim = { ownerId: 'gone-owner', ownerPid: 999999, pid: 999998, supervisorPid: 999997, claimedAt: new Date().toISOString() };
      await writeFile(path.join(directory, 'execution-claim.json'), JSON.stringify(claim));
      await writeFile(path.join(directory, 'task.json'), JSON.stringify({ ...record, status: 'running', executionClaim: claim }));
      await writeFile(path.join(directory, 'result.json'), JSON.stringify({ benchmark: [], environment: { source: 'fixture', liveHardware: false } }));
      const unknown = await client.advance(task.taskId);
      assert.equal(unknown.status, 'quarantined');
      assert.equal(unknown.resourceRelease.confirmed, false);
      assert.equal(unknown.error.code, 'LOCAL_C500_EXECUTION_OWNER_UNKNOWN');
      const bounded = createLocalC500ServiceClient({ cancelTimeoutMs: 80 });
      const started = performance.now();
      assert.equal((await bounded.cancel(task.taskId)).status, 'quarantined');
      assert.ok(performance.now() - started < 500);
      assert.equal(await readJson(path.join(directory, 'owned-pids.json')), null);
      // This fixture has no real worker. A matching explicit exit receipt permits recovery.
      await writeFile(path.join(directory, 'execution-exit.json'), JSON.stringify({
        ownerId: claim.ownerId, exitCode: 0, completedAt: new Date().toISOString(),
        resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Fixture has no worker.', deadline: null, nextAction: null },
      }));
      assert.equal((await client.advance(task.taskId)).status, 'completed');
    });

    await t.test('cancel kills and confirms a real descendant tree before terminal status', { skip: !processTreeControlAvailable }, async () => {
      const task = await submit(payload('owned-tree', 'tree'));
      await client.advance(task.taskId);
      const pids = await observe(() => readJson(path.join(taskRoot, task.taskId, 'owned-pids.json')), Boolean);
      assert.ok(pids.every(alive));
      const started = performance.now();
      const cancelled = await client.cancel(task.taskId);
      assert.ok(performance.now() - started < 3_000);
      assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
      assert.equal(cancelled.resourceRelease.confirmed, true);
      await observe(() => Promise.resolve(pids.map(alive)), (values) => values.every((value) => !value), 1_000);
      const before = await readFile(path.join(taskRoot, task.taskId, 'task.json'), 'utf8');
      assert.equal((await client.advance(task.taskId)).status, 'cancelled');
      assert.equal(await readFile(path.join(taskRoot, task.taskId, 'task.json'), 'utf8'), before);
      assert.equal(await launches(task.taskId), 1);
    });

    await t.test('supervisor enforces total deadline independently of Runtime polling', { skip: !processTreeControlAvailable }, async () => {
      const task = await submit({ ...payload('worker-deadline', 'tree'), limits: { timeoutSeconds: 0.3 } });
      await client.advance(task.taskId);
      const result = await observe(() => client.get(task.taskId), ended);
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.equal(result.error.code, 'LOCAL_C500_TASK_DEADLINE');
      assert.equal(result.resourceRelease.confirmed, true);
      const pids = await readJson(path.join(taskRoot, task.taskId, 'owned-pids.json'));
      if (pids) assert.ok(pids.every((pid) => !alive(pid)));
    });

    await t.test('structured CPU correctness errors retain category, phase and role', async () => {
      const task = await submit(payload('kernel-error', 'structured-error'));
      await client.advance(task.taskId);
      const result = await observe(() => client.advance(task.taskId), ended);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'CPU_CANDIDATE_EXCEPTION');
      assert.equal(result.error.category, 'validation');
      assert.equal(result.error.phase, 'correctness');
      assert.equal(result.error.role, 'candidate');
      assert.equal(result.error.details.exceptionType, 'ValueError');
      assert.equal(result.error.correctness.passed, false);
      assert.equal(result.result.environment.liveHardware, false);
    });

    await t.test('cancel racing completion has one irreversible atomic terminal record', async () => {
      const task = await submit(payload('terminal-race', 'early-result'));
      await client.advance(task.taskId);
      await observe(() => readJson(path.join(taskRoot, task.taskId, 'result.json')), Boolean);
      await Promise.all([client.cancel(task.taskId), client.advance(task.taskId)]);
      const terminal = await observe(() => client.advance(task.taskId), ended);
      assert.ok(['cancelled', 'completed'].includes(terminal.status));
      const bytes = await readFile(path.join(taskRoot, task.taskId, 'task.json'), 'utf8');
      await Promise.all([client.cancel(task.taskId), client.advance(task.taskId), client.get(task.taskId)]);
      assert.equal(await readFile(path.join(taskRoot, task.taskId, 'task.json'), 'utf8'), bytes);
      assert.equal(await launches(task.taskId), 1);
    });
  } finally {
    await Promise.all(queues.map((queue) => queue.dispose()));
    const cleanup = await Promise.all(tasks.map(async (taskId) => {
      try { return await client.cancel(taskId); }
      catch (error) { return { taskId, resourceRelease: { confirmed: false }, error: error.message }; }
    }));
    const unconfirmed = cleanup.filter((task) => task.resourceRelease?.confirmed !== true);
    if (unconfirmed.length) throw new Error('Cleanup could not confirm worker exit; task artifacts preserved at ' + root + ': ' + JSON.stringify(unconfirmed));
    await wait(100);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
