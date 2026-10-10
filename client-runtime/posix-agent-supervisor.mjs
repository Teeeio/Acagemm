import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectLinuxIdentity, inspectLinuxGroup, readLinuxProcessIdentity } from './posix-process-identity.mjs';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const atomic = async (file, value) => { const temp = file + '.' + process.pid + '.tmp'; await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); };
const json = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.platform !== 'linux') throw new Error('POSIX Agent supervision requires Linux /proc.');
const supervisor = await readLinuxProcessIdentity(process.pid);
const handles = await Promise.all([open(request.stdinPath, 'r'), open(request.stdoutPath, 'a', 0o600), open(request.stderrPath, 'a', 0o600)]);
let worker, closed = false, code = null, signal = null, workerIdentity = null;
let ownerLost = false, cancelled = false, failure = null;
try {
  if ((await inspectLinuxIdentity(request.owner)).state !== 'active') throw new Error('Original owner is no longer active.');
  worker = spawn(process.execPath, [fileURLToPath(new URL('./posix-agent-worker.mjs', import.meta.url)), process.argv[2]], {
    cwd: request.cwd, detached: true, stdio: handles.map(handle => handle.fd), env: process.env,
  });
  worker.on('error', error => { failure = { code: error.code || 'POSIX_AGENT_SPAWN_FAILED', message: error.message }; });
  worker.on('close', (exitCode, exitSignal) => { closed = true; code = exitCode; signal = exitSignal; });
  const startDeadline = Date.now() + request.startTimeoutMs;
  while (!closed && Date.now() < startDeadline) {
    const ready = await json(request.workerReadyPath);
    if (ready) {
      if (ready.token !== request.token || ready.identity?.pid !== worker.pid || ready.identity.groupId !== worker.pid || ready.identity.sessionId !== worker.pid
        || (await inspectLinuxIdentity(ready.identity)).state !== 'active') throw new Error('Group startup identity conflict.');
      workerIdentity = ready.identity;
      await atomic(request.readyPath, { schemaVersion: request.schemaVersion, token: request.token, runId: request.runId, missionId: request.missionId,
        owner: request.owner, supervisor, worker: workerIdentity, startedAt: new Date().toISOString() });
      break;
    }
    await pause(25);
  }
  if (!workerIdentity) throw new Error('Group startup identity unavailable.');
  while (!closed) {
    ownerLost = (await inspectLinuxIdentity(request.owner)).state !== 'active';
    cancelled = (await json(request.cancelPath))?.token === request.token;
    if (ownerLost || cancelled) break;
    await pause(50);
  }
} catch (error) { failure ||= { code: error.code || 'POSIX_AGENT_SUPERVISION_FAILED', message: error.message }; }
// Only the original broker signals its own group. Recovery clients write a
// token-bound request. New-session/daemon escape requires a host boundary.
let observation = workerIdentity ? await inspectLinuxGroup(workerIdentity.groupId) : { confirmed: !worker, state: 'not_started', activeProcessCount: 0 };
if (worker && !observation.confirmed) {
  const groupId = workerIdentity?.groupId || worker.pid;
  try { process.kill(-groupId, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') failure ||= { code: error.code, message: error.message }; }
  const softDeadline = Date.now() + request.cancelStepMs;
  while (Date.now() < softDeadline && !observation.confirmed) { await pause(25); observation = await inspectLinuxGroup(groupId); }
  if (!observation.confirmed) { try { process.kill(-groupId, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ||= { code: error.code, message: error.message }; } }
  const hardDeadline = Date.now() + request.cancelTimeoutMs;
  while (Date.now() < hardDeadline && (!closed || !observation.confirmed)) { await pause(25); observation = await inspectLinuxGroup(groupId); }
}
await Promise.all(handles.map(handle => handle.close()));
const providerExit = await json(request.providerExitPath);
const confirmed = Boolean(workerIdentity && closed && observation.confirmed);
await atomic(request.receiptPath, { schemaVersion: request.schemaVersion, token: request.token, runId: request.runId, missionId: request.missionId,
  owner: request.owner, supervisor, worker: workerIdentity, exitCode: Number.isInteger(code) ? code : null, signal,
  providerExit: providerExit?.token === request.token ? providerExit : null, failure, completedAt: new Date().toISOString(),
  release: confirmed ? 'confirmed' : 'unconfirmed', releaseProof: { ...observation, confirmed, ownerLost, cancelled, checkedAt: new Date().toISOString() } });
process.exit(confirmed ? 0 : 1);
