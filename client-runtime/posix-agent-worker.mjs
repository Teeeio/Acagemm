import { spawn } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { readLinuxProcessIdentity } from './posix-process-identity.mjs';
// The detached group leader waits until its durable identity is acknowledged.
// The provider has not executed at that point.
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const atomic = async (file, value) => { const temp = file + '.' + process.pid + '.tmp'; await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = await readLinuxProcessIdentity(process.pid);
await atomic(request.workerReadyPath, { token: request.token, identity });
const deadline = Date.now() + request.startTimeoutMs;
let resumed = false;
while (Date.now() < deadline) {
  try { const resume = JSON.parse(await readFile(request.resumePath, 'utf8')); if (resume.token === request.token) { resumed = true; break; } }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await pause(25);
}
if (!resumed) process.exit(124);
const child = spawn(request.command, request.args, { cwd: request.cwd, stdio: 'inherit', env: process.env, detached: false });
let spawnError = null;
child.on('error', error => { spawnError = { code: error.code || null, message: error.message }; });
child.on('close', async (code, signal) => {
  await atomic(request.providerExitPath, { token: request.token, code, signal, error: spawnError, completedAt: new Date().toISOString() });
  process.exit(Number.isInteger(code) ? code : 1);
});
