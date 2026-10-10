import { mkdir, mkdtemp, writeFile, rm, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolveAppContainerPlan, assertAppContainerEvidence } from './appcontainer-execution.mjs';

const helperScript = fileURLToPath(new URL('./windows-job-object-helper.ps1', import.meta.url));

/**
 * Liveness bound for a single helper invocation: the start handshake
 * (CreateProcess + assign + resume + ready sidecar) and the terminate request
 * are both dominated by PowerShell cold start. This is a scheduling-delay
 * tolerance, not a release deadline: when it expires the run still fails
 * closed through the same quarantine path, only later.
 *
 * Measured on the development machine (Node v22.23.2, Windows PowerShell
 * cold start included): 1.3-1.9 s idle, 5.2-9.4 s under 16-way CPU load, and
 * over 15 s when the supervisor runs inside an already saturated test suite.
 * The previous 15 s default sat below 2x the observed loaded latency and
 * turned pure scheduling delay into CODEX_JOB_START_TIMEOUT, which the caller
 * records as an unconfirmed release and a quarantined workspace.
 */
export const DEFAULT_JOB_HELPER_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const encode = value => Buffer.from(String(value ?? ''), 'utf8').toString('base64');

/** Windows keeps a directory handle busy for a short window after the owning
 *  process exits. Every teardown in this area must tolerate that window
 *  instead of surfacing EPERM/ENOTEMPTY as a test or runtime failure. */
export const RETRYABLE_CLEANUP_CODES = ['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES'];

/**
 * Delete a directory tree with a bounded, load-tolerant retry budget.
 * Returns true when the tree is gone, false when it is still held after the
 * budget is exhausted. It never throws: cleanup is best effort by design, and
 * callers that must not leak should assert on the return value.
 */
export const removeTreeEventually = async (target, { attempts = 10, baseDelayMs = 100 } = {}) => {
  const total = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!RETRYABLE_CLEANUP_CODES.includes(error?.code) || attempt === total - 1) return false;
      await sleep(Math.max(1, Number(baseDelayMs) || 1) * (attempt + 1));
    }
  }
  return false;
};

const runPowerShell = (args, options = {}) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { windowsHide: true, timeout: options.timeoutMs || DEFAULT_JOB_HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr });
    });
});

export const jobObjectSupported = (platform = process.platform) => platform === 'win32';

export const createJobName = (ownerId = 'task') => `Local\\Acagemm-${String(ownerId).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${process.pid}-${Date.now()}`;

const decodeJson = (value, label) => {
  try { return JSON.parse(String(value || '').replace(/^\uFEFF/, '').trim()); }
  catch (cause) { throw Object.assign(new Error(`${label} returned malformed JSON.`), { code: 'CODEX_JOB_PROTOCOL_INVALID', cause }); }
};

const quoteConfig = (values) => Object.keys(values)
  .map(key => `${key}=${encode(values[key])}`)
  .join('\n');

const readSidecar = async (filePath) => {
  if (!filePath) return null;
  try { return decodeJson(await readFile(filePath, 'utf8'), filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const tailFile = async (filePath, decoder, state, onChunk) => {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    while (state.offset < info.size) {
      const length = Math.min(64 * 1024, info.size - state.offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, state.offset);
      if (!result.bytesRead) break;
      state.offset += result.bytesRead;
      const text = decoder.write(buffer.subarray(0, result.bytesRead));
      if (text) onChunk?.(text);
    }
  } catch (error) {
    if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error?.code)) state.error ||= error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
};

/**
 * Start a process in a KILL_ON_JOB_CLOSE Job Object.  The returned helper
 * process owns the Job handle and waits for the target. Killing the helper
 * therefore closes the handle and tears down the complete process tree.
 * The original call shape is retained for local C500; optional sidecars and
 * callbacks provide the Codex supervisor contract. `started` means
 * CreateProcess + AssignProcessToJobObject + ResumeThread have succeeded.
 * `result` is authoritative for release and is resolved only after the final
 * stdout/stderr tail drain and after the helper's temporary config tree has
 * been removed, so callers may delete their own directory once it settles.
 */
export async function spawnJobObjectProcess({
  filePath, arguments: args = '', argv, cwd, stdoutPath, stderrPath,
  stdinPath = null, readyPath = null, receiptPath = null,
  jobName = createJobName(), tempRoot, env,
  ownerPid = process.pid,
  onStdout, onStderr, pollMs = 30, startTimeoutMs = DEFAULT_JOB_HELPER_TIMEOUT_MS,
} = {}) {
  if (!jobObjectSupported()) throw new Error('Windows Job Objects are only available on win32.');
  if (!filePath || !cwd || !stdoutPath || !stderrPath) throw new TypeError('filePath, cwd, stdoutPath and stderrPath are required.');
  const appcontainerPlan = await resolveAppContainerPlan({ environment: env, cwd, filePath, argv });
  const configDir = await mkdtemp(join(tempRoot || tmpdir(), 'acagemm-job-'));
  const configPath = join(configDir, 'config.txt');
  const effectiveReadyPath = readyPath || join(configDir, 'ready.json');
  const effectiveReceiptPath = receiptPath || join(configDir, 'receipt.json');
  const supervisorReadyPath = effectiveReadyPath + '.supervisor.json';
  const supervisorScript = fileURLToPath(new URL('./windows-job-object-supervisor.mjs', import.meta.url));
  const requireIndependent = (env?.OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR ?? process.env.OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR) === '1';
  const values = {
    filePath, arguments: String(args), cwd, jobName, stdoutPath, stderrPath,
    stdinPath: stdinPath || '', readyPath: effectiveReadyPath,
    receiptPath: effectiveReceiptPath, ownerPid: Number(ownerPid) || 0, ownerRequestedAt: new Date().toISOString(),
    supervisorExecutable: process.execPath,
    supervisorArguments: windowsCommandLine([supervisorScript, configPath]), supervisorReadyPath,
    ...(appcontainerPlan ? { appcontainerPlan: JSON.stringify(appcontainerPlan), argv: JSON.stringify(argv) } : {}),
  };
  await writeFile(configPath, quoteConfig(values), 'utf8');
  const helper = spawn(requireIndependent ? 'powershell.exe' : process.execPath,
    requireIndependent ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helperScript, '-Action', 'launch-supervisor', '-Config', configPath] : [supervisorScript, configPath], {
    cwd, detached: !requireIndependent, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined,
  });
  let out = ''; let err = '';
  helper.stdout.setEncoding('utf8'); helper.stderr.setEncoding('utf8');
  helper.stdout.on('data', chunk => { out += chunk; });
  helper.stderr.on('data', chunk => { err += chunk; });
  const stdoutState = { offset: 0, error: null };
  const stderrState = { offset: 0, error: null };
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let polling = true;
  const poll = async () => {
    while (polling) {
      await Promise.all([
        tailFile(stdoutPath, stdoutDecoder, stdoutState, onStdout),
        tailFile(stderrPath, stderrDecoder, stderrState, onStderr),
      ]);
      if (polling) await sleep(Math.max(5, Number(pollMs) || 30));
    }
    // Drain bytes written immediately before the helper closed its handles.
    await Promise.all([
      tailFile(stdoutPath, stdoutDecoder, stdoutState, onStdout),
      tailFile(stderrPath, stderrDecoder, stderrState, onStderr),
    ]);
    const stdoutTail = stdoutDecoder.end();
    const stderrTail = stderrDecoder.end();
    if (stdoutTail) onStdout?.(stdoutTail);
    if (stderrTail) onStderr?.(stderrTail);
  };
  const pollingTask = poll().catch(error => { stdoutState.error ||= error; });
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  let startedSettled = false;
  let observedReady = null;
  const supervisorIdentity = async () => {
    if (!requireIndependent) return null;
    const proof = await readSidecar(supervisorReadyPath);
    if (proof?.schemaVersion !== 'operator-studio.supervisor-lifetime/v1' || proof.jobName !== jobName
      || !Number.isInteger(proof.pid) || proof.pid <= 0 || !Number.isFinite(Date.parse(proof.processCreatedAt))
      || proof.outsideInheritedJobs !== true || proof.checkedBeforeResume !== true) {
      throw Object.assign(new Error('Independent supervisor lifetime was not verified before startup.'), { code: 'PROCESS_BOUNDARY_SUPERVISOR_LIFETIME_UNAVAILABLE' });
    }
    return proof;
  };
  const startedTimer = setTimeout(() => {
    if (startedSettled) return;
    startedSettled = true;
    rejectStarted(Object.assign(new Error('Job Object target did not acknowledge startup before the deadline.'), { code: 'CODEX_JOB_START_TIMEOUT' }));
    // A caller that only retained `result` must not leave an unacknowledged
    // helper and target running.  The terminate request is best effort; the
    // receipt still decides whether release was actually confirmed.
    void terminateJobObject(jobName, { timeoutMs: Math.max(1_000, Number(startTimeoutMs) || DEFAULT_JOB_HELPER_TIMEOUT_MS) }).catch(() => {});
  }, Math.max(100, Number(startTimeoutMs) || DEFAULT_JOB_HELPER_TIMEOUT_MS));
  const watchReady = (async () => {
    while (!startedSettled) {
      const ready = await readSidecar(effectiveReadyPath).catch(error => {
        if (error.code === 'CODEX_JOB_PROTOCOL_INVALID') throw error;
        return null;
      });
      if (ready) {
        startedSettled = true;
        clearTimeout(startedTimer);
        try {
          if (ready.jobName !== jobName || !Number.isInteger(ready.pid) || ready.pid <= 0) {
            throw Object.assign(new Error('Job Object startup receipt identity is invalid.'), { code: 'CODEX_JOB_PROTOCOL_INVALID', receipt: ready });
          }
          if (appcontainerPlan) assertAppContainerEvidence(ready.executionBoundary, appcontainerPlan, ready.pid);
          observedReady = ready;
          const supervision = await supervisorIdentity();
          resolveStarted({ ...ready, helperPid: supervision?.pid || helper.pid, jobName, ...(supervision ? { supervision } : {}) });
        } catch (error) {
          rejectStarted(error);
          if (appcontainerPlan) void terminateJobObject(jobName).catch(() => {});
        }
        return;
      }
      if (helper.exitCode !== null || helper.signalCode) return;
      await sleep(Math.max(5, Number(pollMs) || 30));
    }
  })().catch(error => {
    if (!startedSettled) { startedSettled = true; clearTimeout(startedTimer); rejectStarted(error); }
  });
  const result = new Promise((resolve, reject) => {
    // Spawn failures emit 'error' before 'close'. Keep them in the result
    // protocol so a missing/denied PowerShell executable cannot crash the
    // supervisor and lose its durable fail-closed receipt. The error is
    // recorded rather than rejected here: settling only in the 'close'
    // handler keeps the ordering guarantee below intact.
    let helperError = null;
    helper.once('error', (error) => { helperError = error; });
    helper.once('close', async (code, signal) => {
    polling = false;
    await pollingTask.catch(() => {});
    if (helperError) {
      // 'close' always follows 'error' for a failed spawn, so the startup
      // handshake is settled here rather than on the error event.
      if (!startedSettled) {
        startedSettled = true;
        clearTimeout(startedTimer);
        rejectStarted(Object.assign(new Error('Job helper could not start: ' + helperError.message), {
          code: helperError.code, cause: helperError, stderr: err,
        }));
      }
      await removeTreeEventually(configDir);
      reject(Object.assign(new Error('Job helper could not start: ' + helperError.message), { code: helperError.code, cause: helperError }));
      return;
    }
    // A short native target can finish between two ready polls. Its durable
    // handshake remains authoritative even after the helper has exited.
    if (appcontainerPlan && !startedSettled) {
      try {
        const ready = await readSidecar(effectiveReadyPath);
        if (ready?.jobName === jobName && Number.isInteger(ready.pid) && ready.pid > 0) {
          assertAppContainerEvidence(ready.executionBoundary, appcontainerPlan, ready.pid);
          observedReady = ready;
          startedSettled = true;
          clearTimeout(startedTimer);
          const supervision = await supervisorIdentity();
          resolveStarted({ ...ready, helperPid: supervision?.pid || helper.pid, jobName, ...(supervision ? { supervision } : {}) });
        }
      } catch { /* Unverified startup remains fail-closed below. */ }
    }
    if (!startedSettled) {
      startedSettled = true;
      clearTimeout(startedTimer);
      rejectStarted(Object.assign(new Error(err.trim() || `Job helper exited before startup (${code})`), { code: 'CODEX_JOB_START_FAILED', helperCode: code, signal, stderr: err }));
    }
    let settlement;
    try {
      const receipt = await readSidecar(effectiveReceiptPath) || decodeJson(out, 'Job helper');
      if (receipt.release !== 'confirmed' || !Number.isInteger(receipt.exitCode) || receipt.jobName !== jobName) {
        throw Object.assign(new Error('Job helper receipt identity or release status is invalid.'), { code: 'CODEX_JOB_RELEASE_UNCONFIRMED', receipt });
      }
      if (appcontainerPlan) {
        assertAppContainerEvidence(receipt.executionBoundary, appcontainerPlan, receipt.pid);
        if (!observedReady || receipt.pid !== observedReady.pid || receipt.processCreatedAt !== observedReady.processCreatedAt
          || JSON.stringify(receipt.executionBoundary) !== JSON.stringify(observedReady.executionBoundary)
          || receipt.releaseProof?.confirmed !== true || receipt.releaseProof?.activeProcessCount !== 0) {
          throw Object.assign(new Error('AppContainer terminal receipt does not match its startup or whole-tree proof.'), { code: 'APPCONTAINER_EVIDENCE_INVALID' });
        }
      }
      const supervision = await supervisorIdentity();
      settlement = { ok: true, value: { ...receipt, helperPid: supervision?.pid || helper.pid, jobName, ...(supervision ? { supervision } : {}), stdoutPath, stderrPath, stdoutError: stdoutState.error?.message || null } };
    } catch (error) {
      settlement = { ok: false, error: Object.assign(new Error(error.message || 'Job helper returned malformed JSON.'), {
        code: error.code || 'CODEX_JOB_RELEASE_UNCONFIRMED', cause: error, stdout: out, stderr: err,
      }) };
    }
    // Cleanup must finish before `result` settles. Callers delete their own
    // parent directory as soon as this promise settles, and a concurrent
    // retry-delete of the same tree is what turned a slow-but-successful
    // Windows teardown into EPERM/ENOTEMPTY failures under load.
    await removeTreeEventually(configDir);
    if (settlement.ok) resolve(settlement.value); else reject(settlement.error);
    });
  });
  const terminate = ({ timeoutMs = DEFAULT_JOB_HELPER_TIMEOUT_MS } = {}) => terminateJobObject(jobName, { timeoutMs });
  // Keep the watcher referenced so Node does not garbage-collect the promise;
  // its result is intentionally observable through `started`.
  void watchReady;
  // Callers may only need the legacy `result` promise.  Attach an internal
  // rejection observer so a helper that fails before startup never becomes an
  // unhandled rejection while the caller is deciding how to recover.
  started.catch(() => {});
  return { helper, helperPid: helper.pid, jobName, stdoutPath, stderrPath, started, result, terminate };
}

/** CPU-only admission. This is a lifetime observation, never provider, GPU,
 * workflow or historical release evidence. Strict mode cannot fall back. */
export async function preflightIndependentSupervisor({ environment = {}, tempRoot, platform = process.platform } = {}) {
  const required = (environment.OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR ?? process.env.OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR) === '1';
  if (!required) return { ready: true, supervisionRequired: false };
  if (!jobObjectSupported(platform)) return { ready: false, code: 'PROCESS_BOUNDARY_SUPERVISOR_LIFETIME_UNAVAILABLE', detail: 'Independent Windows supervision is unavailable on this platform.' };
  const parent = tempRoot || tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'supervisor-preflight-'));
  let child;
  try {
    child = await spawnJobObjectProcess({ filePath: process.execPath, arguments: windowsCommandLine(['-e', '']),
      cwd: root, tempRoot: root, stdoutPath: join(root, 'stdout.log'), stderrPath: join(root, 'stderr.log'),
      readyPath: join(root, 'ready.json'), receiptPath: join(root, 'receipt.json'),
      env: { ...environment, OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR: '1' }, startTimeoutMs: 15000 });
    const ready = await child.started;
    const receipt = await child.result;
    if (ready.supervision?.outsideInheritedJobs !== true || receipt.releaseProof?.confirmed !== true
      || receipt.releaseProof.activeProcessCount !== 0) throw new Error('CPU supervision proof is incomplete.');
    return { ready: true, supervisionRequired: true, supervision: ready.supervision, receiptPath: join(root, 'receipt.json') };
  } catch (error) {
    await child?.result.catch(() => {});
    return { ready: false, code: 'PROCESS_BOUNDARY_SUPERVISOR_LIFETIME_UNAVAILABLE', supervisionRequired: true,
      detail: 'The supervisor cannot prove independence from enclosing process Jobs; use an operator-owned stable runtime. No provider was started.',
      diagnostics: { code: error.code || null, message: error.message }, evidenceRoot: root };
  }
}

export async function terminateJobObject(jobName, { timeoutMs = DEFAULT_JOB_HELPER_TIMEOUT_MS } = {}) {
  if (!jobObjectSupported()) throw new Error('Windows Job Objects are only available on win32.');
  if (!jobName) throw new TypeError('jobName is required.');
  const { stdout } = await runPowerShell(['-File', helperScript, '-Action', 'terminate', '-JobName', jobName], { timeoutMs });
  return JSON.parse(stdout.trim());
}

const quoteWindowsArgument = (value) => {
  const argument = String(value ?? '');
  if (argument && !/[\s"]/u.test(argument)) return argument;
  let result = '"';
  let slashes = 0;
  for (const character of argument) {
    if (character === '\\') { slashes += 1; continue; }
    if (character === '"') {
      result += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    result += '\\'.repeat(slashes) + character;
    slashes = 0;
  }
  return result + '\\'.repeat(slashes * 2) + '"';
};

export const windowsCommandLine = (args = []) => args.map(quoteWindowsArgument).join(' ');

export async function inspectJobObjectProcess({ jobName, pid, processCreatedAt, timeoutMs = DEFAULT_JOB_HELPER_TIMEOUT_MS } = {}) {
  if (!jobObjectSupported()) throw new Error('Windows Job Objects are only available on win32.');
  if (!jobName || !Number.isInteger(pid) || pid <= 0 || !processCreatedAt) throw new TypeError('Bound Job name, PID and creation time are required.');
  const { stdout } = await runPowerShell(['-File', helperScript, '-Action', 'inspect', '-JobName', jobName,
    '-ExpectedPid', String(pid), '-ExpectedCreatedAt', processCreatedAt], { timeoutMs });
  return decodeJson(stdout, 'Job inspection');
}
