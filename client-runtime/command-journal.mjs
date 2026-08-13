// 耐久命令日志：幂等去重、崩溃恢复游标、WAL 时序。
// 只依赖 node 内置模块；state-store 可安全 import（单向依赖）。
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const journalPathFor = (runtimeDir) => path.join(runtimeDir, 'command-journal.jsonl');

export const hashKey = (text) => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

const exists = async (target) => {
  try { await readFile(target); return true; } catch { return false; }
};

export const createCommandJournal = ({ filePath } = {}) => {
  const readAll = async () => {
    if (!filePath || !await exists(filePath)) return [];
    const raw = await readFile(filePath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  };
  const nextSeq = async () => (await readAll()).reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1;
  const append = async (entry) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  const patch = async (seq, fields) => {
    const entries = await readAll();
    const index = entries.findIndex((entry) => Number(entry.seq) === Number(seq));
    if (index === -1) return;
    entries[index] = { ...entries[index], ...fields };
    const temporary = `${filePath}.${process.pid}.${seq}.tmp`;
    await writeFile(temporary, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    await rename(temporary, filePath);
  };
  const findByKey = async (key) => (await readAll()).find((entry) => entry.idempotencyKey === key) || null;
  const entriesAfter = async (seq) => (await readAll()).filter((entry) => Number(entry.seq) > Number(seq));
  const reset = async () => { if (filePath) await rm(filePath, { force: true }); };
  return { filePath, readAll, nextSeq, append, patch, findByKey, entriesAfter, reset };
};

// 执行一个命令（WAL 时序）：去重 → 乐观锁 → prepare(外部副作用) → append journal →
// apply(纯状态) → 推进 commandJournalSeq → saveState → patch 补全。
// 返回 { status: 'applied'|'skipped_idempotent'|'conflict', state, result?, entry?, stateVersion?, code?, retryable? }
export async function executeCommand({ journal, saveState, registry, state, type, body, idempotencyKey, expectedVersion, deps }) {
  const command = registry[type];
  if (!command) {
    const error = new Error(`未知命令类型: ${type}`);
    error.status = 400;
    error.code = 'COMMAND_TYPE_UNKNOWN';
    throw error;
  }
  const key = idempotencyKey || (command.keyFor ? command.keyFor(state, body) : hashKey(`${type}:${JSON.stringify(body || {})}`));
  const existing = await journal.findByKey(key);
  if (existing && existing.status === 'applied') {
    const stillApplied = command.isApplied
      ? command.isApplied(state, existing.payload ?? body)
      : Number(existing.seq) === Number(state.commandJournalSeq || 0);
    if (stillApplied) {
      return { status: 'skipped_idempotent', state, entry: existing, result: existing.result, stateVersion: state.stateVersion };
    }
  }
  if (expectedVersion !== undefined && Number(state.stateVersion || 0) !== Number(expectedVersion)) {
    return { status: 'conflict', state, stateVersion: state.stateVersion, code: 'STATE_VERSION_CONFLICT', retryable: true };
  }
  const prepared = command.prepare ? await command.prepare({ state, body, deps }) : null;
  const payload = prepared?.payload ?? body;
  const result = prepared?.result ?? null;
  const seq = await journal.nextSeq();
  const entry = {
    seq,
    commandId: `cmd_${seq}_${type}`,
    idempotencyKey: key,
    type,
    missionId: state.activeMissionId,
    payload,
    stateVersionBefore: state.stateVersion,
    stateVersionAfter: null,
    status: 'applied',
    result: null,
    appliedAt: null,
  };
  await journal.append(entry);
  try {
    await command.apply(state, payload);
  } catch (error) {
    await journal.patch(seq, { status: 'failed' });
    throw error;
  }
  state.commandJournalSeq = seq;
  const saved = await saveState(state);
  await journal.patch(seq, { stateVersionAfter: saved.stateVersion, result, appliedAt: new Date().toISOString() });
  return { status: 'applied', state: saved, entry: { ...entry, stateVersionAfter: saved.stateVersion, result }, result, stateVersion: saved.stateVersion };
}

// 崩溃恢复：重放 journal 中 seq > state.commandJournalSeq 且 status==='applied' 的条目，
// 按 seq 升序调 apply 追平快照（apply 为纯状态变换，不重放外部副作用）。
export async function reconcileCommandJournal(state, { journal, registry }) {
  if (!journal || !registry) return { state, replayed: [] };
  const cursor = Number(state.commandJournalSeq || 0);
  const pending = (await journal.entriesAfter(cursor)).filter((entry) => entry.status === 'applied').sort((a, b) => Number(a.seq) - Number(b.seq));
  const replayed = [];
  for (const entry of pending) {
    const command = registry[entry.type];
    if (!command?.apply) continue;
    await command.apply(state, entry.payload ?? {});
    state.commandJournalSeq = Number(entry.seq);
    replayed.push(entry.seq);
  }
  return { state, replayed };
}
