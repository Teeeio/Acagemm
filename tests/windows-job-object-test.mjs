import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  removeTreeEventually,
  spawnJobObjectProcess,
  terminateJobObject,
} from '../client-runtime/windows-job-object.mjs';

// The owner has to cold-start a Node child under whatever load the machine is
// already under. These assertions mean "the descendant is eventually recorded"
// and "the descendant was eventually released", not "within an idle-machine
// interval": a 3 s deadline expired on a saturated box and reported a
// scheduling delay as a Job Object defect.
const TREE_SETTLE_DEADLINE_MS = 30_000;

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
  // Wait for the start handshake instead of guessing with a fixed delay: the
  // Job Object only exists once the helper has returned its ready sidecar, so
  // a 200 ms sleep turned PowerShell cold start under load into
  // "OpenJobObject failed" rather than a measured contract violation.
  const started = await child.started;
  assert.equal(started.jobName, jobName);
  assert.ok(started.pid > 0);
  const terminated = await terminateJobObject(child.jobName);
  assert.equal(terminated.terminated, true);
  const result = await child.result;
  assert.equal(result.release, 'confirmed');
  await assert.doesNotReject(() => readFile(stdoutPath));
  assert.ok(await removeTreeEventually(root), 'test root should be removable after the helper closes');
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
  let cleanupOk = false;
  try {
    owner = await spawnJobObjectProcess({
      filePath: process.execPath,
      arguments: `--input-type=module -e ${JSON.stringify(script)}`,
      cwd: root, stdoutPath, stderrPath, tempRoot: root, jobName,
    });
    descendantPid = await (async () => {
      const deadline = Date.now() + TREE_SETTLE_DEADLINE_MS;
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
          const deadline = Date.now() + TREE_SETTLE_DEADLINE_MS;
          while (Date.now() < deadline) {
            try { process.kill(descendantPid, 0); } catch { return; }
            await delay(40);
          }
          throw new Error('Job Object termination did not release descendant PID ' + descendantPid);
        })();
      }
    }
    cleanupOk = await removeTreeEventually(root);
  }
  assert.ok(cleanupOk, 'test root should be removable once every Job Object in it has been released');
});

test('job object supervisor bridges stdin and tails JSONL before the receipt', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(process.cwd(), '.tmp-job-stream-test-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const stdinPath = join(root, 'stdin.txt');
  const readyPath = join(root, 'ready.json');
  const receiptPath = join(root, 'receipt.json');
  const script = [
    "let body = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => body += chunk);",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({type:'thread.started', text:body}) + '\\n');",
    "  setTimeout(() => { process.stdout.write(JSON.stringify({type:'turn.completed', usage:{input_tokens:7, output_tokens:2}}) + '\\n'); }, 80);",
    "});",
  ].join('');
  await writeFile(stdinPath, 'operator prompt\n', 'utf8');
  const lines = [];
  const errors = [];
  const jobName = `Local\\Acagemm-Stream-${process.pid}-${Date.now()}`;
  let cleanupOk = false;
  try {
    const supervisor = await spawnJobObjectProcess({
      filePath: process.execPath,
      arguments: `--input-type=module -e ${JSON.stringify(script)}`,
      cwd: root, stdoutPath, stderrPath, stdinPath, readyPath, receiptPath,
      tempRoot: root, jobName,
      onStdout: chunk => lines.push(chunk),
      onStderr: chunk => errors.push(chunk),
      pollMs: 15,
    });
    const started = await supervisor.started;
    assert.equal(started.jobName, jobName);
    assert.ok(started.pid > 0);
    const receipt = await supervisor.result;
    assert.equal(receipt.release, 'confirmed');
    assert.equal(receipt.releaseProof.confirmed, true);
    assert.equal(receipt.releaseProof.activeProcessCount, 0);
    assert.equal(receipt.releaseProof.ownerLost, false);
    const output = lines.join('');
    assert.match(output, /thread\.started/);
    assert.match(output, /operator prompt/);
    assert.match(output, /turn\.completed/);
    assert.equal(errors.join(''), '');
    assert.equal(JSON.parse((await readFile(readyPath, 'utf8')).replace(/^\uFEFF/, '')).jobName, jobName);
    assert.ok((await readFile(receiptPath, 'utf8')).includes('releaseProof'));
  } finally {
    cleanupOk = await removeTreeEventually(root);
  }
  assert.ok(cleanupOk, 'test root should be removable once the streamed Job Object is released');
});
