import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExternalOutcome, WORKFLOW_OUTCOME } from './workflow-kernel.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = process.env.OPERATOR_RUNTIME_DIR ? path.resolve(process.env.OPERATOR_RUNTIME_DIR) : path.join(rootDir, 'runtime');
const queuePath = process.env.OPERATOR_TEST_QUEUE_FILE ? path.resolve(process.env.OPERATOR_TEST_QUEUE_FILE) : path.join(runtimeDir, 'operator-test-queue.jsonl');
const lockPath = `${queuePath}.lock`;

const now = () => new Date().toISOString();

const readTasks = async () => {
  try {
    const content = await readFile(queuePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const writeTasks = async (tasks) => {
  await mkdir(path.dirname(queuePath), { recursive: true });
  const temporaryPath = `${queuePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${tasks.map((task) => JSON.stringify(task)).join('\n')}\n`, 'utf8');
  await rename(temporaryPath, queuePath);
};

const withLock = async (operation) => {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await writeFile(lockPath, `${process.pid} ${now()}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const busy = new Error('算子测试队列正在被另一个 Runner 使用。');
      busy.code = 'OPERATOR_TEST_QUEUE_BUSY';
      busy.status = 409;
      throw busy;
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    try { await handle?.close(); } catch { /* the lock file is still removed below */ }
    await rm(lockPath, { force: true });
  }
};

const taskView = (task) => ({
  taskId: task.taskId,
  queueId: task.taskId,
  status: task.status,
  progress: task.progress || 0,
  submittedAt: task.submittedAt,
  startedAt: task.startedAt || null,
  completedAt: task.completedAt || null,
  durationMs: task.durationMs || 0,
  payload: task.payload,
  remoteTaskId: task.remoteTaskId || null,
  remoteTaskIds: task.remoteTaskIds || null,
  logs: task.logs || [],
  result: task.result || null,
  error: task.error || null,
  attempts: task.attempts || { submit: 0, poll: 0 },
  lastError: task.lastError || null,
  cancelRequested: task.cancelRequested === true,
});

const replaceTask = (tasks, next) => tasks.map((task) => task.taskId === next.taskId ? next : task);

export const createOperatorTestQueue = ({ serviceClient, filePath = queuePath, maxAttempts = 3 } = {}) => {
  const client = serviceClient;
  const pathOverride = filePath;
  const load = async () => {
    const original = queuePath;
    if (pathOverride === original) return readTasks();
    try {
      const content = await readFile(pathOverride, 'utf8');
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const persist = async (tasks) => {
    if (pathOverride === queuePath) return writeTasks(tasks);
    await mkdir(path.dirname(pathOverride), { recursive: true });
    const temporaryPath = `${pathOverride}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${tasks.map((task) => JSON.stringify(task)).join('\n')}\n`, 'utf8');
    await rename(temporaryPath, pathOverride);
  };
  const runWithLock = async (operation) => {
    if (pathOverride === queuePath) return withLock(operation);
    const localLock = `${pathOverride}.lock`;
    await mkdir(path.dirname(localLock), { recursive: true });
    let handle;
    try {
      handle = await writeFile(localLock, `${process.pid} ${now()}\n`, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        const busy = new Error('算子测试队列正在被另一个 Runner 使用。');
        busy.code = 'OPERATOR_TEST_QUEUE_BUSY';
        busy.status = 409;
        throw busy;
      }
      throw error;
    }
    try { return await operation(); } finally {
      try { await handle?.close(); } catch { /* cleanup below */ }
      await rm(localLock, { force: true });
    }
  };

  const applyFailure = (task, error, lane) => {
    const attempts = { submit: 0, poll: 0, ...(task.attempts || {}) };
    attempts[lane] += 1;
    const failure = { code: error.code || `${lane.toUpperCase()}_FAILED`, message: error.message, status: error.status || null, retryable: error.retryable === true };
    const outcome = normalizeExternalOutcome({ status: 'failed', error: failure });
    const retry = outcome.kind === WORKFLOW_OUTCOME.RETRYABLE_FAILURE && attempts[lane] < maxAttempts;
    const sequence = (task.logs || []).length + 1;
    return {
      ...task,
      status: retry ? (lane === 'submit' ? 'waiting' : 'running') : 'failed',
      completedAt: retry ? null : now(),
      attempts,
      lastError: { ...failure, retryable: retry, observedAt: now() },
      error: retry ? null : failure,
      logs: [...(task.logs || []), {
        sequence,
        progress: Number(task.progress || 0),
        message: retry
          ? `${lane} temporarily failed; retry ${attempts[lane]}/${maxAttempts - 1} is pending.`
          : failure.message,
      }],
    };
  };

  const processTask = async (tasks, task) => {
    if (task.status === 'waiting') {
      try {
        const submitted = await client.submit(task.payload);
        const next = {
          ...task,
          status: 'running',
          startedAt: now(),
          remoteTaskId: submitted.taskId,
          remoteTaskIds: submitted.remoteTaskIds || null,
          progress: Number(submitted.progress || 0),
          attempts: { submit: Number(task.attempts?.submit || 0) + 1, poll: Number(task.attempts?.poll || 0) },
          lastError: null,
          error: null,
          logs: [{ sequence: 1, progress: 0, message: '本地队列已获得 Runner 锁，测试任务已提交到服务端。' }],
        };
        return replaceTask(tasks, next);
      } catch (error) {
        return replaceTask(tasks, applyFailure(task, error, 'submit'));
      }
    }
    if (task.status !== 'running' && task.status !== 'cancel_requested') return tasks;
    if (!task.remoteTaskId) return replaceTask(tasks, { ...task, status: 'failed', completedAt: now(), error: { code: 'REMOTE_TASK_MISSING', message: '队列任务缺少远端测试任务标识。' } });
    try {
      const snapshot = await client.get(task.remoteTaskId);
      const outcome = normalizeExternalOutcome(snapshot);
      if (task.status === 'cancel_requested') {
        if (outcome.terminal) {
          return replaceTask(tasks, { ...task, status: snapshot.status, progress: snapshot.progress || task.progress, completedAt: snapshot.completedAt || now(), durationMs: snapshot.durationMs || 0, remoteTaskIds: snapshot.remoteTaskIds || task.remoteTaskIds || null, logs: snapshot.logs || task.logs, result: snapshot.result || null, error: snapshot.error || null });
        }
        return tasks;
      }
      if (outcome.kind === WORKFLOW_OUTCOME.RETRYABLE_FAILURE) {
        return replaceTask(tasks, applyFailure(task, { ...(outcome.error || {}), retryable: true }, 'poll'));
      }
      const nextStatus = outcome.kind === WORKFLOW_OUTCOME.COMPLETED
        ? 'completed'
        : outcome.kind === WORKFLOW_OUTCOME.CANCELLED
          ? 'cancelled'
          : outcome.kind === WORKFLOW_OUTCOME.TERMINAL_FAILURE
            ? 'failed'
            : 'running';
      const terminal = ['completed', 'failed', 'cancelled'].includes(nextStatus);
      const terminalError = nextStatus === 'failed' ? (snapshot.error || outcome.error) : snapshot.error || null;
      return replaceTask(tasks, { ...task, status: nextStatus, progress: Number(snapshot.progress || task.progress || 0), completedAt: snapshot.completedAt || (terminal ? now() : null), durationMs: Number(snapshot.durationMs || task.durationMs || 0), remoteTaskIds: snapshot.remoteTaskIds || task.remoteTaskIds || null, logs: snapshot.logs || task.logs, result: snapshot.result || null, error: terminalError, lastError: null, attempts: { submit: Number(task.attempts?.submit || 0), poll: Number(task.attempts?.poll || 0) + 1 } });
    } catch (error) {
      return replaceTask(tasks, applyFailure(task, error, 'poll'));
    }
  };

  const process = async () => runWithLock(async () => {
    let tasks = await load();
    const running = tasks.find((task) => ['running', 'cancel_requested'].includes(task.status));
    if (running) {
      tasks = await processTask(tasks, running);
      await persist(tasks);
      return taskView(tasks.find((task) => task.taskId === running.taskId));
    }
    const waiting = tasks.find((task) => task.status === 'waiting');
    if (!waiting) return null;
    tasks = await processTask(tasks, waiting);
    await persist(tasks);
    return taskView(tasks.find((task) => task.taskId === waiting.taskId));
  });

  return {
    path: pathOverride,
    submit: async (payload) => runWithLock(async () => {
      if (!payload || typeof payload !== 'object') {
        const error = new Error('算子测试任务必须是对象。');
        error.code = 'OPERATOR_TEST_TASK_INVALID';
        error.status = 400;
        throw error;
      }
      if (!payload.operator || !payload.candidate?.digest) {
        const error = new Error('算子测试任务必须包含 operator 和 candidate.digest。');
        error.code = 'OPERATOR_TEST_TASK_INVALID';
        error.status = 400;
        throw error;
      }
      if (!Array.isArray(payload.matrix?.environments) || !payload.matrix.environments.length) {
        const error = new Error('算子测试任务至少需要一个测试环境。');
        error.code = 'OPERATOR_TEST_TASK_INVALID';
        error.status = 400;
        throw error;
      }
      const tasks = await load();
      const existing = payload.requestId
        ? tasks.find((task) => task.payload?.requestId === payload.requestId && task.payload?.missionId === payload.missionId)
        : null;
      if (existing) return taskView(existing);
      const task = { schemaVersion: 1, taskId: `queue_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`, status: 'waiting', progress: 0, submittedAt: now(), payload: structuredClone(payload), logs: [], result: null, error: null, lastError: null, attempts: { submit: 0, poll: 0 } };
      await persist([...tasks, task]);
      return taskView(task);
    }),
    get: async (taskId) => {
      await process();
      const tasks = await load();
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task) {
        const error = new Error('本地队列中不存在该测试任务。');
        error.code = 'OPERATOR_TEST_QUEUE_NOT_FOUND';
        error.status = 404;
        throw error;
      }
      return taskView(task);
    },
    list: async () => {
      await process();
      return (await load()).map(taskView);
    },
    cancel: async (taskId) => runWithLock(async () => {
      let tasks = await load();
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task) {
        const error = new Error('本地队列中不存在该测试任务。');
        error.code = 'OPERATOR_TEST_QUEUE_NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return taskView(task);
      if (task.status === 'waiting') {
        const cancelled = { ...task, status: 'cancelled', cancelRequested: true, completedAt: now(), logs: [...(task.logs || []), { sequence: (task.logs || []).length + 1, progress: task.progress || 0, message: '测试尚未启动，已取消。' }] };
        tasks = replaceTask(tasks, cancelled);
      } else {
        if (typeof client.cancel === 'function' && task.remoteTaskId) {
          try { await client.cancel(task.remoteTaskId); } catch { /* the local cancellation record remains authoritative */ }
        }
        tasks = replaceTask(tasks, { ...task, status: 'cancel_requested', cancelRequested: true, logs: [...(task.logs || []), { sequence: (task.logs || []).length + 1, progress: task.progress || 0, message: '已提交取消请求，等待服务端确认。' }] });
      }
      await persist(tasks);
      return taskView(tasks.find((item) => item.taskId === taskId));
    }),
  };
};
