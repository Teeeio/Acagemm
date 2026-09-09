import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { workflowEffectId } from './workflow-kernel.mjs';
import { serializeWorkflowError } from './workflow-error.mjs';

export const journalPathFor = (runtimeDir) => path.join(runtimeDir, 'command-journal.jsonl');
export const hashKey = (text) => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

const writeDurably = async (target, content, flags) => {
  const file = await open(target, flags);
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
};

export const createCommandJournal = ({ filePath } = {}) => {
  // Commands execute under the Runtime writer lock, but read-only GET/SSE
  // projections may inspect the same journal concurrently. Keep an in-process
  // marker so inspection distinguishes an effect that is still preparing from
  // an effect orphaned by a crashed process. The marker is deliberately not
  // persisted: a new process must still recover conservatively.
  const activeSequences = new Set();
  const markActive = (seq) => { activeSequences.add(Number(seq)); };
  const clearActive = (seq) => { activeSequences.delete(Number(seq)); };
  const isActive = (seq) => activeSequences.has(Number(seq));
  const readAll = async () => {
    if (!filePath) return [];
    let raw;
    try { raw = await readFile(filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    // A process may die while appending the last line. Other malformed records
    // are not safe to ignore: they may contain an unresolved external effect.
    const lines = raw.split(/\r?\n/);
    return lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; }
      catch (cause) {
        if (index === lines.length - 1 && !raw.endsWith('\n')) return [];
        throw Object.assign(new Error('Command journal contains a corrupt record.', { cause }), { code: 'COMMAND_JOURNAL_CORRUPT', retryable: false });
      }
    });
  };
  const nextSeq = async () => (await readAll()).reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1;
  const append = async (entry) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    // Rewrite atomically to avoid appending a valid record to a torn last line.
    const entries = await readAll();
    if (entries.some((item) => Number(item.seq) === Number(entry.seq))) throw new Error('Command journal sequence already exists.');
    await replace([...entries, entry]);
  };
  const replace = async (entries) => {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeDurably(temporary, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'wx');
      await rename(temporary, filePath);
    } finally { await rm(temporary, { force: true }); }
  };
  const patch = async (seq, fields) => {
    const entries = await readAll();
    const index = entries.findIndex((entry) => Number(entry.seq) === Number(seq));
    if (index === -1) throw Object.assign(new Error('Command journal record is missing.'), { code: 'COMMAND_JOURNAL_ENTRY_MISSING' });
    entries[index] = { ...entries[index], ...fields };
    await replace(entries);
  };
  const findByKey = async (key) => (await readAll()).findLast((entry) => entry.idempotencyKey === key) || null;
  const entriesAfter = async (seq) => (await readAll()).filter((entry) => Number(entry.seq) > Number(seq));
  const reset = async () => { if (filePath) await rm(filePath, { force: true }); };
  return { filePath, readAll, nextSeq, append, patch, findByKey, entriesAfter, reset, markActive, clearActive, isActive };
};

const recoveryError = (entry, code = 'COMMAND_EFFECT_OUTCOME_UNKNOWN', cause = null) => Object.assign(
  new Error(`Command ${entry.commandId} needs recovery before another effect can run.`, cause ? { cause } : undefined),
  { code, status: 409, retryable: false, details: { commandId: entry.commandId, effectId: entry.effectId, missionId: entry.missionId, type: entry.type, cause: cause?.code || cause?.message || null } },
);
const isPending = (entry) => ['preparing', 'prepared'].includes(entry.status)
  || (entry.status === 'failed' && entry.failurePhase === 'apply' && entry.effectStarted);
const contextFor = (entry, state, deps) => ({
  state, body: structuredClone(entry.body), intent: structuredClone(entry.intent),
  effectId: entry.effectId, deps,
});

const prepareEntry = async ({ command, entry, state, journal, deps }) => {
  const mark = async (fields) => { await journal.patch(entry.seq, fields); Object.assign(entry, fields); };
  const runEffect = async (operation) => {
    if (typeof operation !== 'function') throw new TypeError('runEffect requires an operation.');
    if (!entry.effectStarted) await mark({ effectStarted: true });
    return operation();
  };
  const recordIntent = async (intent) => {
    if (entry.effectStarted) throw recoveryError(entry, 'COMMAND_INTENT_ALREADY_STARTED');
    await mark({ intent: structuredClone(intent) });
  };
  let prepared;
  try {
    const context = { ...contextFor(entry, state, deps), runEffect, recordIntent };
    prepared = command.prepare
      ? await (command.tracksEffects === true ? command.prepare(context) : runEffect(() => command.prepare(context)))
      : null;
  } catch (error) {
    // Once an effect has started, neither a thrown error nor a lost response
    // proves that it did not happen. Keep its intent available for recovery.
    if (!entry.effectStarted) await mark({ status: 'failed', failurePhase: 'prepare' });
    throw error;
  }
  const fields = { status: 'prepared', payload: prepared?.payload ?? entry.body, result: prepared?.result ?? null };
  await mark(fields);
  return entry;
};

const recoverEntry = async ({ command, entry, state, journal, deps }) => {
  if (entry.status === 'prepared' || entry.status === 'applied') return entry;
  if (entry.status === 'failed') throw recoveryError(entry, 'COMMAND_APPLY_FAILED');
  if (!entry.effectStarted) return prepareEntry({ command, entry, state, journal, deps });
  if (typeof command.recover !== 'function') throw recoveryError(entry);
  let outcome;
  try { outcome = await command.recover(contextFor(entry, state, deps)); }
  catch (cause) { throw recoveryError(entry, 'COMMAND_RECOVERY_QUERY_FAILED', cause); }
  if (outcome?.status === 'not_started') {
    // The adapter has established absence. Keep the frozen intent and effect ID.
    await journal.patch(entry.seq, { effectStarted: false });
    entry.effectStarted = false;
    return prepareEntry({ command, entry, state, journal, deps });
  }
  if (outcome?.status !== 'prepared' || !outcome.prepared) throw recoveryError(entry);
  const fields = { status: 'prepared', payload: outcome.prepared.payload, result: outcome.prepared.result ?? null };
  await journal.patch(entry.seq, fields);
  return Object.assign(entry, fields);
};

const assertRecoveryState = (entry, state) => {
  if (entry.schemaVersion !== 2) return;
  if (entry.missionId !== state.activeMissionId) throw recoveryError(entry, 'COMMAND_RECOVERY_MISSION_MISMATCH');
  if (Number(entry.stateVersionBefore) !== Number(state.stateVersion || 0)) throw recoveryError(entry, 'COMMAND_RECOVERY_STATE_CHANGED');
};

const applyEntry = async (command, entry, state, journal) => {
  try { await command.apply(state, structuredClone(entry.payload)); }
  catch (error) {
    await journal.patch(entry.seq, { status: 'failed', failurePhase: 'apply' });
    throw error;
  }
  state.commandJournalSeq = Number(entry.seq);
};

// The caller owns the State Repository lock and reloads state after any failure.
export async function executeCommand({ journal, saveState, registry, state, type, body = {}, idempotencyKey, expectedVersion, deps }) {
  const command = registry[type];
  if (!command) throw Object.assign(new Error(`Unknown command: ${type}`), { status: 400, code: 'COMMAND_TYPE_UNKNOWN' });
  const key = idempotencyKey || (command.keyFor ? command.keyFor(state, body) : hashKey(`${type}:${JSON.stringify(body)}`));
  let existing = await journal.findByKey(key);
  if (existing && ['applied', 'prepared'].includes(existing.status)) {
    const stillApplied = command.isApplied
      ? command.isApplied(state, existing.payload ?? body)
      : Number(existing.seq) === Number(state.commandJournalSeq || 0);
    if (stillApplied && (existing.schemaVersion !== 2 || Number(state.commandJournalSeq || 0) >= Number(existing.seq))) {
      return { status: 'skipped_idempotent', state, entry: existing, result: existing.result, stateVersion: state.stateVersion };
    }
  }
  if (expectedVersion !== undefined && Number(state.stateVersion || 0) !== Number(expectedVersion)) {
    return { status: 'conflict', state, stateVersion: state.stateVersion, code: 'STATE_VERSION_CONFLICT', retryable: true };
  }
  const pending = (await journal.entriesAfter(Number(state.commandJournalSeq || 0)))
    .find((entry) => isPending(entry));
  if (pending && (!existing || Number(pending.seq) !== Number(existing.seq))) throw recoveryError(pending, 'COMMAND_PENDING_RECOVERY');

  let entry;
  let activeSeq = null;
  try {
    if (existing && isPending(existing)) {
      assertRecoveryState(existing, state);
      activeSeq = Number(existing.seq);
      journal.markActive?.(activeSeq);
      entry = await recoverEntry({ command, entry: existing, state, journal, deps });
    } else {
      const seq = await journal.nextSeq();
      activeSeq = Number(seq);
      journal.markActive?.(activeSeq);
      const effectId = workflowEffectId({ missionId: state.activeMissionId, type, round: state.iterationStats?.round || 0, subject: `${key}:${seq}` });
      const intent = command.plan ? await command.plan({ state, body, effectId, deps }) : null;
      entry = {
        schemaVersion: 2, seq, commandId: `cmd_${seq}_${type}`, effectId, idempotencyKey: key,
        type, missionId: state.activeMissionId, body: structuredClone(body), intent: structuredClone(intent),
        stateVersionBefore: Number(state.stateVersion || 0), stateVersionAfter: null,
        status: 'preparing', effectStarted: false, payload: null, result: null, appliedAt: null,
      };
      await journal.append(entry);
      entry = await prepareEntry({ command, entry, state, journal, deps });
    }
    await applyEntry(command, entry, state, journal);
    const saved = await saveState(state);
    const completed = { status: 'applied', stateVersionAfter: saved.stateVersion, appliedAt: new Date().toISOString() };
    await journal.patch(entry.seq, completed);
    return { status: 'applied', state: saved, entry: { ...entry, ...completed }, result: entry.result, stateVersion: saved.stateVersion };
  } finally {
    if (activeSeq != null) journal.clearActive?.(activeSeq);
  }
}

// Inspection must not acknowledge records, invoke recovery adapters, replay
// commands, or retry effects. Only an explicit advance may do those things.
export async function inspectCommandJournal(state, { journal, registry }) {
  if (!journal || !registry) return { state, replayed: [], blocked: [] };
  const pending = (await journal.entriesAfter(Number(state.commandJournalSeq || 0)))
    .filter((entry) => !journal.isActive?.(entry.seq) && (entry.status === 'applied' || isPending(entry)))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  for (const entry of pending) {
    const command = registry[entry.type];
    if (!command?.apply && entry.schemaVersion !== 2) continue;
    try {
      if (!command?.apply) throw recoveryError(entry, 'COMMAND_RECOVERY_HANDLER_MISSING');
      assertRecoveryState(entry, state);
      if (entry.status === 'failed') throw recoveryError(entry, 'COMMAND_APPLY_FAILED');
      if (entry.status === 'preparing' && entry.effectStarted && !command.recover) throw recoveryError(entry);
      throw recoveryError(entry, 'COMMAND_PENDING_RECOVERY');
    } catch (error) {
      return { state, replayed: [], blocked: [serializeWorkflowError(error, { phase: 'command.inspection', source: 'command-journal', retryable: false })] };
    }
  }
  return { state, replayed: [], blocked: [] };
}

export async function reconcileCommandJournal(state, { journal, registry }) {
  if (!journal || !registry) return { state, replayed: [], blocked: [] };
  // A previous state commit may have succeeded before its journal acknowledgement.
  for (const entry of await journal.entriesAfter(-1)) {
    if (entry.status === 'prepared' && Number(entry.seq) <= Number(state.commandJournalSeq || 0)) {
      await journal.patch(entry.seq, { status: 'applied', recoveredThroughVersion: state.stateVersion, appliedAt: new Date().toISOString() });
    }
  }
  const pending = (await journal.entriesAfter(Number(state.commandJournalSeq || 0)))
    .filter((entry) => !journal.isActive?.(entry.seq) && (entry.status === 'applied' || isPending(entry)))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const replayed = [];
  const blocked = [];
  for (const entry of pending) {
    const command = registry[entry.type];
    if (!command?.apply) {
      if (entry.schemaVersion !== 2) continue;
      blocked.push(serializeWorkflowError(recoveryError(entry, 'COMMAND_RECOVERY_HANDLER_MISSING')));
      break;
    }
    try {
      // A crash can occur after the command's state snapshot is persisted but
      // before commandJournalSeq is advanced. An `applied` journal entry whose
      // post-version is already present and whose idempotency predicate holds
      // is therefore safe to acknowledge without replaying its side effects.
      if (entry.status === 'applied' && Number(entry.seq) === Number(state.commandJournalSeq || 0) + 1
        && Number(entry.stateVersionAfter) <= Number(state.stateVersion || 0)
        && (!command.isApplied || command.isApplied(state, entry.payload))) {
        state.commandJournalSeq = Number(entry.seq);
        replayed.push(Number(entry.seq));
        continue;
      }
      assertRecoveryState(entry, state);
      const next = structuredClone(state);
      const prepared = await recoverEntry({ command, entry, state: next, journal });
      await applyEntry(command, prepared, next, journal);
      if (entry.schemaVersion === 2 && entry.stateVersionAfter != null) next.stateVersion = Number(entry.stateVersionAfter);
      state = next;
      replayed.push(Number(entry.seq));
    } catch (error) {
      blocked.push(serializeWorkflowError(error, { phase: 'command.recovery', source: 'command-journal', retryable: false }));
      break;
    }
  }
  return { state, replayed, blocked };
}
