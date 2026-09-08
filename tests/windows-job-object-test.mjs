import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnJobObjectProcess, terminateJobObject } from '../client-runtime/windows-job-object.mjs';

test('job object helper manages and terminates a child process tree', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(process.cwd(), '.tmp-job-test-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const child = await spawnJobObjectProcess({
    filePath: process.execPath,
    arguments: '-e "setTimeout(() => {}, 30000)"',
    cwd: root,
    stdoutPath,
    stderrPath,
    tempRoot: root,
    jobName: `Local\\Acagemm-Test-${process.pid}-${Date.now()}`
  });
  assert.ok(child.helperPid > 0);
  await delay(200);
  const terminated = await terminateJobObject(child.jobName);
  assert.equal(terminated.terminated, true);
  const result = await child.result;
  assert.equal(result.release, 'confirmed');
  await assert.doesNotReject(() => readFile(stdoutPath));
});
