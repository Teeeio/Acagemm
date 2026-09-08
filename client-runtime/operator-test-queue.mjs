import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkflowError, serializeWorkflowError } from './workflow-error.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = process.env.OPERATOR_RUNTIME_DIR ? path.resolve(process.env.OPERATOR_RUNTIME_DIR) : path.join(rootDir, 'runtime');
const defaultPath = process.env.OPERATOR_TEST_QUEUE_FILE ? path.resolve(process.env.OPERATOR_TEST_QUEUE_FILE) : path.join(runtimeDir, 'operator-test-queue.jsonl');
const lockTails = new Map();
const flights = new Map();
const deadlines = new Map();
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const terminal = (task) => terminalStatuses.has(task.status) && task.resourceRelease?.confirmed === true;
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const release = (confirmed, status, reason, deadline = null, nextAction = null) => ({ confirmed, status, reason, deadline, nextAction });
const errorFor = (code, message, details = {}) => Object.assign(new Error(message), { code, details, retryable: false });
const taskView = (task) => clone({
  ...task, queueId: task.taskId, result: task.result || null, error: task.error || null,
  remoteTaskId: task.remoteTaskId || null, remoteTaskIds: task.remoteTaskIds || null,
});
const assertSameRequest = (task, payload) => {
  if (payload && !isDeepStrictEqual(task.payload, clone(payload))) {
    throw Object.assign(errorFor('OPERATOR_TEST_REQUEST_CONFLICT', 'A request ID is bound to different execution content.',
      { taskId: task.taskId, requestId: payload.requestId, missionId: payload.missionId }), { status: 409 });
  }
};

const fileLock = async (filename, operation) => {
  await mkdir(path.dirname(filename), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await writeFile(filename, process.pid + ' ' + now() + '\n', { flag: 'wx' });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = await readFile(filename, 'utf8'); } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      const pid = Number(owner.trim().split(/\s+/)[0]);
      // A slow live owner must never lose its lock merely because time elapsed.
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) { await rm(filename, { force: true }); continue; }
      throw Object.assign(errorFor('OPERATOR_TEST_QUEUE_BUSY', 'Operator test queue is locked by another owner.', { ownerPid: pid }), { status: 409 });
    }
  }
  if (!acquired) throw errorFor('OPERATOR_TEST_QUEUE_BUSY', 'Cannot acquire operator test queue lock.');
  try { return await operation(); } finally { await rm(filename, { force: true }); }
};

export const createOperatorTestQueue = ({
  serviceClient, filePath = defaultPath, maxAttempts = 3, ioTimeoutMs = 5_000, taskTimeoutMs = 120_000,
} = {}) => {
  const filename = path.resolve(filePath);
  const ownerId = randomUUID();
  const ioLimit = Math.max(1, Number(ioTimeoutMs) || 5_000);
  const totalLimit = Math.max(1, Number(taskTimeoutMs) || 120_000);
  const retryLimit = Math.max(1, Number(maxAttempts) || 3);
  let disposed = false;
  const keyFor = (taskId) => filename + ':' + taskId;
  const load = async () => {
    try { return (await readFile(filename, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const persist = async (tasks) => {
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, tasks.map((task) => JSON.stringify(task)).join('\n') + '\n', 'utf8');
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  };
  const locked = (operation) => {
    const key = filename + '.lock';
    const previous = lockTails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => fileLock(key, operation));
    const tail = current.catch(() => {});
    lockTails.set(key, tail);
    return current.finally(() => { if (lockTails.get(key) === tail) lockTails.delete(key); });
  };
  const update = (taskId, change) => locked(async () => {
    const tasks = await load();
    const index = tasks.findIndex((task) => task.taskId === taskId);
    if (index < 0) throw Object.assign(errorFor('OPERATOR_TEST_QUEUE_NOT_FOUND', 'Operator test task not found.'), { status: 404 });
    const next = await change(tasks[index]);
    if (next !== tasks[index]) { tasks[index] = next; await persist(tasks); }
    return taskView(next);
  });
  const readTask = async (taskId) => {
    const task = (await load()).find((item) => item.taskId === taskId);
    if (!task) throw Object.assign(errorFor('OPERATOR_TEST_QUEUE_NOT_FOUND', 'Operator test task not found.'), { status: 404 });
    return taskView(task);
  };
  const logged = (task, message) => [...(task.logs || []), { sequence: (task.logs || []).length + 1, at: now(), progress: task.progress || 0, message }];
  const failureRecord = (error, lane) => ({
    ...serializeWorkflowError(normalizeWorkflowError(error, { code: error?.code || 'OPERATOR_TEST_IO_FAILED', phase: 'operator-test.' + lane, source: 'operator-test-queue' })),
    ...(error?.category ? { category: error.category } : {}),
    ...(error?.phase ? { phase: error.phase } : {}),
    ...(error?.role ? { role: error.role } : {}),
    details: error?.details || {}, observedAt: now(),
  });
  const quarantine = (task, error, lane) => {
    const failure = failureRecord(error, lane);
    const failures = { ...(task.failures || {}), [lane]: Number(task.failures?.[lane] || 0) + 1 };
    const exhausted = failures[lane] >= retryLimit;
    return {
      ...task, status: 'quarantined', failures, lastError: failure,
      error: { ...failure, retryable: !exhausted, terminal: false, stopPolicy: exhausted ? 'needs_human' : 'retry' },
      resourceRelease: release(false, 'quarantined', failure.message, task.deadlineAt,
        exhausted ? 'Inspect the backend by request ID and confirm resource release before resuming.' : 'Reconcile the existing request; do not submit another task.'),
      logs: logged(task, lane + ': ' + failure.message),
    };
  };

  const settle = async (taskId, claim, snapshot, error = null) => {
    if (disposed) return null;
    const result = await update(taskId, (task) => {
      if (terminal(task)) return task;
      const field = claim.lane === 'cancel' ? 'cancelClaim' : 'dispatchClaim';
      const current = task[field]?.id === claim.id;
      // Once cancellation has quarantined a task for missing release proof,
      // an older poll/reconcile response must not reopen it as running.
      if (task.status === 'quarantined' && task.cancelRequested === true
          && claim.lane !== 'cancel' && claim.lane !== 'submit') return task;
      // A late submit response remains useful for reconciliation. Other stale
      // nonterminal responses must not overwrite a newer claim or cancellation.
      if (!current && claim.lane !== 'submit' && !terminalStatuses.has(snapshot?.status)) return task;
      let next = { ...task, ...(current ? { [field]: null } : {}) };
      if (error) {
        if (!current) return task;
        const notStarted = claim.lane === 'submit' && !next.remoteTaskId
          && error.submission?.status === 'not_started' && error.submission?.confirmed === true
          && error.submission?.requestId === next.payload.requestId && error.resourceRelease?.confirmed === true;
        if (notStarted) {
          const failure = failureRecord(error, claim.lane);
          const retry = failure.retryable === true && Number(next.attempts.submit) < retryLimit;
          return {
            ...next, status: retry ? 'waiting' : 'failed', submissionStartedAt: null,
            submissionResolution: { ...clone(error.submission), observedAt: now() },
            completedAt: retry ? null : now(), lastError: { ...failure, retryable: retry },
            error: retry ? null : { ...failure, retryable: false, terminal: true, stopPolicy: 'needs_human' },
            resourceRelease: { ...release(true, 'confirmed', 'Backend proved this frozen request was not started.'), ...clone(error.resourceRelease) },
            logs: logged(next, retry ? 'Backend confirmed no acceptance; bounded submit retry remains pending.' : failure.message),
          };
        }
        return quarantine(next, error, claim.lane);
      }
      if (claim.lane === 'cancel') next.cancelAcknowledgedAt = now();
      if (snapshot?.taskId) {
        if (next.remoteTaskId && next.remoteTaskId !== snapshot.taskId) {
          return quarantine(next, errorFor('OPERATOR_TEST_REQUEST_AMBIGUOUS', 'One request resolved to different backend task IDs.'), claim.lane);
        }
        next.remoteTaskId = snapshot.taskId;
      }
      if (!snapshot || (!next.remoteTaskId && claim.lane !== 'cancel')) {
        return quarantine(next, errorFor('OPERATOR_TEST_SUBMIT_UNKNOWN', 'Backend task creation is not authoritatively resolved.'), claim.lane);
      }
      const status = snapshot.status || (claim.lane === 'submit' && snapshot.taskId ? 'queued' : null);
      if (!['waiting', 'queued', 'preparing', 'submitting', 'running', 'cancel_requested', 'quarantined', 'completed', 'failed', 'cancelled'].includes(status)) {
        return quarantine(next, errorFor('EXTERNAL_OUTCOME_INVALID', 'Backend returned an unsupported task status.'), claim.lane);
      }
      next = {
        ...next, remoteTaskIds: snapshot.remoteTaskIds || next.remoteTaskIds || null,
        progress: Math.max(Number(next.progress || 0), Number(snapshot.progress || 0)),
        durationMs: Number(snapshot.durationMs || next.durationMs || 0),
        logs: snapshot.logs?.length ? snapshot.logs : next.logs,
        lastError: null,
      };
      if (terminalStatuses.has(snapshot.status)) {
        if (snapshot.resourceRelease?.confirmed !== true) {
          return quarantine({ ...next, observedBackendStatus: snapshot.status },
            errorFor('OPERATOR_TEST_RELEASE_UNCONFIRMED', 'Backend reported a terminal status without confirmed resource release.'), claim.lane);
        }
        const deadlineFailure = next.cancelReason === 'task_deadline'
          && !(snapshot.status === 'completed' && Date.parse(snapshot.completedAt) <= Date.parse(next.deadlineAt));
        return {
          ...next, status: deadlineFailure ? 'failed' : snapshot.status, completedAt: snapshot.completedAt || now(),
          result: snapshot.result || null, error: deadlineFailure ? {
            code: 'OPERATOR_TEST_TASK_DEADLINE', category: 'timeout', phase: 'operator-test.execution', role: 'queue', retryable: false,
            message: 'Task exceeded its total deadline; backend resource release is confirmed.',
          } : snapshot.error || null,
          resourceRelease: { ...release(true, 'confirmed', 'Backend explicitly confirmed resource release.'), ...clone(snapshot.resourceRelease) }, dispatchClaim: null, cancelClaim: null,
        };
      }
      return {
        ...next, status: next.cancelRequested ? 'cancel_requested' : snapshot.status === 'quarantined' ? 'quarantined' : 'running',
        startedAt: next.startedAt || snapshot.startedAt || now(), error: snapshot.error || null,
        resourceRelease: snapshot.resourceRelease || release(false, next.cancelRequested ? 'pending' : 'active',
          next.cancelRequested ? 'Cancellation awaits backend exit confirmation.' : 'Backend task owns the execution slot.', next.deadlineAt,
          next.cancelRequested ? 'Await or reconcile cancellation.' : 'Advance the existing task.'),
      };
    });
    if (terminal(result)) {
      clearTimeout(deadlines.get(keyFor(taskId)));
      deadlines.delete(keyFor(taskId));
    }
    return result;
  };

  let dispatch;
  const startIO = (task, claim) => {
    const flightKey = keyFor(task.taskId) + ':' + claim.id;
    if (flights.has(flightKey)) return flights.get(flightKey);
    const controller = new AbortController();
    const raw = Promise.resolve().then(() => {
      const options = { signal: controller.signal, deadline: claim.deadline, reason: task.cancelReason || 'user' };
      if (claim.lane === 'submit') return serviceClient.submit(clone(task.payload), options);
      if (claim.lane === 'cancel') return serviceClient.cancel(task.remoteTaskId, options);
      if (claim.lane === 'reconcile') {
        if (typeof serviceClient.findByRequestId !== 'function') throw errorFor('OPERATOR_TEST_RECONCILIATION_UNAVAILABLE', 'Backend does not implement authoritative request-ID lookup.');
        return serviceClient.findByRequestId(task.payload.requestId, task.payload.missionId, clone(task.payload), options);
      }
      return claim.allowStart !== false && typeof serviceClient.advance === 'function'
        ? serviceClient.advance(task.remoteTaskId, options)
        : serviceClient.get(task.remoteTaskId, options);
    });
    let timedOut = false;
    let timer;
    const bounded = Promise.race([raw, new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(Object.assign(errorFor('OPERATOR_TEST_IO_DEADLINE', 'Backend ' + claim.lane + ' exceeded its I/O deadline.', { lane: claim.lane, deadline: claim.deadline }), { category: 'timeout' }));
      }, ioLimit);
    })]);
    const flight = bounded.then(
      (snapshot) => settle(task.taskId, claim, snapshot),
      (error) => settle(task.taskId, claim, null, error),
    ).finally(() => { clearTimeout(timer); flights.delete(flightKey); });
    flights.set(flightKey, flight);
    // A response lost to the deadline may still identify an already-created task.
    raw.then((snapshot) => timedOut ? settle(task.taskId, claim, snapshot) : null).catch(() => {});
    flight.then((snapshot) => {
      if (snapshot?.cancelRequested && !terminal(snapshot) && snapshot.remoteTaskId && claim.lane === 'submit') void dispatch().catch(() => {});
    }).catch(() => {});
    return flight;
  };

  const makeClaim = (lane) => ({ id: randomUUID(), ownerId, ownerPid: process.pid, lane, startedAt: now(), deadline: new Date(Date.now() + ioLimit).toISOString() });
  const claimBusy = (claim) => claim && alive(claim.ownerPid) && Date.parse(claim.deadline) > Date.now();
  const requestCancel = async (taskId, reason = 'user') => {
    if (disposed) throw errorFor('OPERATOR_TEST_QUEUE_CLOSED', 'Queue dispatcher is closed; cancellation must use the active owner.');
    const snapshot = await update(taskId, (task) => {
      if (terminal(task)) return task;
      if (task.status === 'waiting' && !task.submissionStartedAt) return {
        ...task, status: reason === 'task_deadline' ? 'failed' : 'cancelled', cancelRequested: true, cancelReason: reason, completedAt: now(),
        error: reason === 'task_deadline' ? { code: 'OPERATOR_TEST_TASK_DEADLINE', category: 'timeout', phase: 'operator-test.waiting', role: 'queue', retryable: false, message: 'Task deadline expired before backend submission.' } : null,
        resourceRelease: release(true, 'confirmed', 'Task cancelled before submission.'), logs: logged(task, 'Cancelled before backend submission.'),
      };
      return { ...task, cancelRequested: true, cancelAcknowledgedAt: null, cancelReason: task.cancelReason || reason, status: 'cancel_requested',
        resourceRelease: release(false, 'pending', 'Cancellation is persisted; backend exit is not confirmed.', task.deadlineAt, 'Reconcile and cancel the existing backend task.'),
        logs: task.cancelRequested ? task.logs : logged(task, 'Cancellation requested: ' + reason) };
    });
    if (!terminal(snapshot)) await dispatch();
    return readTask(taskId);
  };
  const armDeadline = (task) => {
    const key = keyFor(task.taskId);
    if (deadlines.has(key) || task.cancelRequested || terminal(task) || !Number.isFinite(Date.parse(task.deadlineAt))) return;
    const timer = setTimeout(() => {
      deadlines.delete(key);
      void requestCancel(task.taskId, 'task_deadline').catch(() => {});
    }, Math.max(1, Date.parse(task.deadlineAt) - Date.now()));
    timer.unref?.();
    deadlines.set(key, timer);
  };

  dispatch = async ({ allowStart = true } = {}) => {
    if (disposed) throw errorFor('OPERATOR_TEST_QUEUE_CLOSED', 'Queue dispatcher is closed; persisted claims remain owned.');
    const selected = await locked(async () => {
      const tasks = await load();
      const task = tasks.find((item) => item.status !== 'waiting' && !terminal(item))
        || (allowStart ? tasks.find((item) => item.status === 'waiting') : null);
      if (!task) return null;
      let next = { ...task };
      next.deadlineAt ||= new Date(Date.parse(task.submittedAt) + totalLimit).toISOString();
      if (Date.parse(next.deadlineAt) <= Date.now()) {
        next.cancelRequested = true;
        next.cancelReason ||= 'task_deadline';
        if (next.status === 'waiting' && !next.submissionStartedAt) {
          next.status = 'failed';
          next.completedAt = now();
          next.error = { code: 'OPERATOR_TEST_TASK_DEADLINE', category: 'timeout', phase: 'operator-test.waiting', role: 'queue', retryable: false, message: 'Task deadline expired before backend submission.' };
          next.resourceRelease = release(true, 'confirmed', 'Task deadline expired before submission.');
          tasks[tasks.indexOf(task)] = next;
          await persist(tasks);
          return { task: next };
        }
      }
      let lane;
      if (next.cancelRequested && next.remoteTaskId && typeof serviceClient.cancel === 'function'
          && !next.cancelAcknowledgedAt && !claimBusy(next.cancelClaim) && Number(next.failures?.cancel || 0) < retryLimit) lane = 'cancel';
      else if (claimBusy(next.dispatchClaim)) return { task };
      else if (next.status === 'waiting' && !next.submissionStartedAt) lane = 'submit';
      else if (!next.remoteTaskId) lane = 'reconcile';
      else lane = 'poll';
      if (lane === 'cancel' && claimBusy(next.cancelClaim)) return { task };
      if (Number(next.failures?.[lane] || 0) >= retryLimit) return { task };
      const claim = makeClaim(lane);
      claim.allowStart = allowStart;
      const field = lane === 'cancel' ? 'cancelClaim' : 'dispatchClaim';
      next[field] = claim;
      next.attempts = { ...next.attempts, [lane]: Number(next.attempts?.[lane] || 0) + 1 };
      if (lane === 'submit') {
        next.status = 'submitting';
        next.submissionStartedAt = now();
      }
      next.resourceRelease = release(false, next.cancelRequested ? 'pending' : 'active',
        'Execution slot is claimed; backend ' + lane + ' runs outside queue locks.', next.deadlineAt, 'Await bounded I/O or reconcile by request ID.');
      tasks[tasks.indexOf(task)] = next;
      await persist(tasks);
      return { task: next, claim };
    });
    if (!selected) return null;
    armDeadline(selected.task);
    if (selected.claim) startIO(selected.task, selected.claim);
    return taskView(selected.task);
  };

  const processQueue = async () => {
    const snapshot = await dispatch();
    if (!snapshot) return null;
    const claim = snapshot.cancelClaim || snapshot.dispatchClaim;
    if (claim) await flights.get(keyFor(snapshot.taskId) + ':' + claim.id);
    return readTask(snapshot.taskId);
  };
  return {
    path: filename, dispatch, process: processQueue, readTask,
    readTasks: async () => (await load()).map(taskView),
    findByRequestId: async (requestId, missionId, expectedPayload = null) => {
      const task = (await load()).find((item) => item.payload?.requestId === requestId && item.payload?.missionId === missionId);
      if (!task) return null;
      assertSameRequest(task, expectedPayload);
      return taskView(task);
    },
    submit: async (payload) => {
      if (!payload || typeof payload !== 'object' || !payload.operator || !payload.candidate?.digest
          || !Array.isArray(payload.matrix?.environments) || !payload.matrix.environments.length) {
        throw Object.assign(errorFor('OPERATOR_TEST_TASK_INVALID', 'Task requires operator, candidate.digest and matrix.environments.'), { status: 400 });
      }
      // Freeze before the first await, including generated idempotency identity.
      const frozen = clone(payload);
      frozen.requestId ||= 'operator_test_' + randomUUID();
      return locked(async () => {
        const tasks = await load();
        const existing = tasks.find((task) => task.payload?.requestId === frozen.requestId && task.payload?.missionId === frozen.missionId);
        if (existing) { assertSameRequest(existing, frozen); return taskView(existing); }
        const requestedMs = Number(frozen.limits?.timeoutSeconds) * 1000;
        const timeoutMs = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : totalLimit;
        const task = {
          schemaVersion: 2, taskId: 'queue_' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(),
          status: 'waiting', submittedAt: now(), deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
          progress: 0, payload: frozen, logs: [], result: null, error: null, lastError: null,
          attempts: { submit: 0, poll: 0, reconcile: 0, cancel: 0 }, failures: {},
          resourceRelease: release(true, 'not_started', 'Task has not been submitted.'),
        };
        await persist([...tasks, task]);
        return taskView(task);
      }).then((snapshot) => { armDeadline(snapshot); return snapshot; });
    },
    get: async (taskId) => {
      try { await processQueue(); } catch (error) { if (error.code !== 'OPERATOR_TEST_QUEUE_BUSY') throw error; }
      return readTask(taskId);
    },
    list: async () => {
      try { await processQueue(); } catch (error) { if (error.code !== 'OPERATOR_TEST_QUEUE_BUSY') throw error; }
      return (await load()).map(taskView);
    },
    cancel: (taskId, options = {}) => requestCancel(taskId, typeof options === 'string' ? options : options.reason || 'user'),
    // Stops process-local scheduling only; never claims that workers were released.
    dispose: async () => {
      disposed = true;
      for (const [key, timer] of deadlines) {
        if (key.startsWith(filename + ':')) { clearTimeout(timer); deadlines.delete(key); }
      }
      await Promise.allSettled([...flights].filter(([key]) => key.startsWith(filename + ':')).map(([, flight]) => flight));
      await locked(async () => {});
    },
  };
};
