import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperScript = fileURLToPath(new URL('./windows-job-object-helper.ps1', import.meta.url));

const runPowerShell = (args, options = {}) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { windowsHide: true, timeout: options.timeoutMs || 15_000, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr });
    });
});

export const jobObjectSupported = (platform = process.platform) => platform === 'win32';

export const createJobName = (ownerId = 'task') => `Local\\Acagemm-${String(ownerId).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${process.pid}-${Date.now()}`;

/**
 * Start a process in a KILL_ON_JOB_CLOSE Job Object.  The returned helper
 * process owns the Job handle and waits for the target. Killing the helper
 * therefore closes the handle and tears down the complete process tree.
 */
export async function spawnJobObjectProcess({ filePath, arguments: args = '', cwd, stdoutPath, stderrPath, jobName = createJobName(), tempRoot } = {}) {
  if (!jobObjectSupported()) throw new Error('Windows Job Objects are only available on win32.');
  if (!filePath || !cwd || !stdoutPath || !stderrPath) throw new TypeError('filePath, cwd, stdoutPath and stderrPath are required.');
  const configDir = await mkdtemp(join(tempRoot || tmpdir(), 'acagemm-job-'));
  const configPath = join(configDir, 'config.txt');
  const values = { filePath, arguments: String(args), cwd, jobName, stdoutPath, stderrPath };
  const encode = value => Buffer.from(String(value), 'utf8').toString('base64');
  await writeFile(configPath, Object.keys(values).map(key => `${key}=${encode(values[key])}`).join('\n'), 'utf8');
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScript, '-Action', 'start', '-Config', configPath], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = ''; let err = '';
  helper.stdout.setEncoding('utf8'); helper.stderr.setEncoding('utf8');
  helper.stdout.on('data', chunk => { out += chunk; });
  helper.stderr.on('data', chunk => { err += chunk; });
  const result = new Promise((resolve, reject) => {
    // Spawn failures emit 'error' before 'close'. Keep them in the result
    // protocol so a missing/denied PowerShell executable cannot crash the
    // supervisor and lose its durable fail-closed receipt.
    helper.once('error', (error) => reject(Object.assign(new Error('Job helper could not start: ' + error.message), { code: error.code, cause: error })));
    helper.once('close', async (code, signal) => {
    try { await rm(configDir, { recursive: true, force: true }); } catch {}
    if (code !== 0) { reject(Object.assign(new Error(err.trim() || `Job helper exited with ${code}`), { code, signal, stderr: err, stdout: out })); return; }
    try {
      const receipt = JSON.parse(out.trim());
      if (receipt.release !== 'confirmed' || !Number.isInteger(receipt.exitCode) || receipt.jobName !== jobName) throw new Error('Job helper receipt identity or release status is invalid.');
      resolve({ ...receipt, helperPid: helper.pid, jobName });
    }
    catch (error) { reject(Object.assign(new Error('Job helper returned malformed JSON.'), { cause: error, stdout: out, stderr: err })); }
    });
  });
  return { helper, helperPid: helper.pid, jobName, result };
}

export async function terminateJobObject(jobName, { timeoutMs = 15_000 } = {}) {
  if (!jobObjectSupported()) throw new Error('Windows Job Objects are only available on win32.');
  if (!jobName) throw new TypeError('jobName is required.');
  const { stdout } = await runPowerShell(['-File', helperScript, '-Action', 'terminate', '-JobName', jobName], { timeoutMs });
  return JSON.parse(stdout.trim());
}
