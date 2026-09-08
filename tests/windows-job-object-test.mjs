import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnJobObjectProcess, terminateJobObject } from '../client-runtime/windows-job-object.mjs';

test('job object helper manages and terminates a child process tree', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(process.cwd(), '.tmp-job-test-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const jobName = `Local\\Acagemm-Test-${process.pid}-${Date.now()}`;
  const child = await spawnJobObjectProcess({
    filePath: process.execPath,
    arguments: '-e "setTimeout(() => {}, 30000)"',
    cwd: root, stdoutPath, stderrPath, tempRoot: root, jobName,
  });
  assert.ok(child.helperPid > 0);
  await delay(200);
  const terminated = await terminateJobObject(child.jobName);
  assert.equal(terminated.terminated, true);
  const result = await child.result;
  assert.equal(result.release, 'confirmed');
  await assert.doesNotReject(() => readFile(stdoutPath));
  await rm(root, { recursive: true, force: true });
});

test('job object termination releases descendants and helper failures fail closed', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(process.cwd(), '.tmp-job-tree-test-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const pidPath = join(root, 'child.pid');
  const script = [
    "import { spawn } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });",
    `await writeFile(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 30000);",
  ].join('');
  const jobName = `Local\\Acagemm-Tree-${process.pid}-${Date.now()}`;
  let owner;
  let descendantPid = null;
  try {
    owner = await spawnJobObjectProcess({
      filePath: process.execPath,
      arguments: `--input-type=module -e ${JSON.stringify(script)}`,
      cwd: root, stdoutPath, stderrPath, tempRoot: root, jobName,
    });
    descendantPid = await (async () => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try { return Number((await readFile(pidPath, 'utf8')).trim()); } catch { await delay(40); }
      }
      throw new Error('descendant PID was not recorded');
    })();
    assert.ok(descendantPid > 0);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    const duplicate = await spawnJobObjectProcess({ filePath: process.execPath,
      arguments: '-e "setTimeout(() => {}, 30000)"', cwd: root,
      stdoutPath: join(root, 'duplicate.stdout'), stderrPath: join(root, 'duplicate.stderr'), tempRoot: root, jobName });
    await assert.rejects(duplicate.result, 'duplicate Job names must not join another task');
  } finally {
    if (owner) {
      const bad = await spawnJobObjectProcess({ filePath: 'C:\\path\\that\\does-not-exist.exe', arguments: '', cwd: root,
        stdoutPath: join(root, 'bad.stdout'), stderrPath: join(root, 'bad.stderr'), tempRoot: root, jobName: `${jobName}-bad` });
      await assert.rejects(
        bad.result,
        'invalid executable must reject the helper result rather than report a release success',
      );
      await terminateJobObject(owner.jobName);
      const result = await owner.result;
      assert.equal(result.release, 'confirmed');
      if (descendantPid) {
        await (async () => {
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline) {
            try { process.kill(descendantPid, 0); } catch { return; }
            await delay(40);
          }
          throw new Error('Job Object termination did not release descendant PID ' + descendantPid);
        })();
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
