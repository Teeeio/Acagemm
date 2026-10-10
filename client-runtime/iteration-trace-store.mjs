import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TRACE_SCHEMA, TRACE_KINDS, projectTraceRecords } from './iteration-trace.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = (code, message, cause, status = 503) => Object.assign(new Error(message, { cause }), { code, status });
const invalid = () => failure('TRACE_QUERY_INVALID', 'Invalid trace query or cursor.', undefined, 400);
const corrupt = (cause) => failure('TRACE_CORRUPT', 'Committed iteration trace is missing or corrupt; history was not replaced.', cause);

// The snapshot head is the commit marker. A prepared blob without a reachable
// head is an orphan, never a committed observation. State Repository serializes
// writes; this adapter is neither a second workflow nor a cross-process lock.
export function createIterationTraceStore({ directory, filesystem = { mkdir, readFile, writeFile, rename } } = {}) {
  if (!directory) throw new TypeError('Trace storage requires a directory.');
  const fileFor = (hash) => {
    if (!validDigest(hash)) throw corrupt();
    return path.join(directory, `${hash}.json`);
  };
  const readBatch = async (hash) => {
    try {
      const bytes = await filesystem.readFile(fileFor(hash), 'utf8');
      if (digest(bytes) !== hash) throw corrupt();
      const batch = JSON.parse(bytes);
      if (batch.schema !== TRACE_SCHEMA || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1
        || (batch.previous !== null && !validDigest(batch.previous)) || !Array.isArray(batch.records)
        || batch.records.some((record) => !TRACE_KINDS.includes(record.kind)
          || typeof record.missionId !== 'string' || !record.id
          || record.key !== JSON.stringify([record.kind, record.missionId, record.id]))) throw corrupt();
      return batch;
    } catch (cause) { throw cause.code === 'TRACE_CORRUPT' ? cause : corrupt(cause); }
  };
  const validatePointer = (trace) => {
    if (!trace) return;
    if (trace.schema !== TRACE_SCHEMA || !validDigest(trace.head) || !Number.isSafeInteger(trace.sequence)
      || trace.sequence < 1 || !trace.observed || typeof trace.observed !== 'object') throw corrupt();
  };
  const prepare = async (state) => {
    const previous = state.iterationTrace;
    validatePointer(previous);
    if (previous && (await readBatch(previous.head)).sequence !== previous.sequence) throw corrupt();
    const projected = [...(state.tracePending || []), ...projectTraceRecords(state)];
    const latest = new Map(projected.map((record) => [record.key, record]));
    const observed = {};
    const records = [];
    for (const [key, raw] of latest) {
      // Use the exact JSON representation that survives a process restart.
      const bytes = JSON.stringify(raw);
      observed[key] = digest(bytes);
      if (previous?.observed?.[key] !== observed[key]) records.push(JSON.parse(bytes));
    }
    const next = { ...state };
    delete next.tracePending;
    if (previous && records.length === 0) {
      next.iterationTrace = { ...previous, observed };
      return next;
    }
    const batch = {
      schema: TRACE_SCHEMA, previous: previous?.head || null,
      sequence: (previous?.sequence || 0) + 1, stateVersion: state.stateVersion,
      recordedAt: state.updatedAt || new Date().toISOString(), records,
    };
    const bytes = JSON.stringify(batch) + '\n';
    const hash = digest(bytes);
    const destination = fileFor(hash);
    try {
      await filesystem.mkdir(directory, { recursive: true });
      // Reusing a prior prepared batch is allowed only if its bytes verify.
      let present = false;
      try { await filesystem.readFile(destination, 'utf8'); present = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present) await readBatch(hash);
      else {
        const temporary = path.join(directory, `${hash}.${randomUUID()}.tmp`);
        await filesystem.writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
        await filesystem.rename(temporary, destination);
      }
    } catch (cause) {
      if (cause.code === 'TRACE_CORRUPT') throw cause;
      throw failure('TRACE_WRITE_FAILED', 'Iteration trace could not be saved; state was not committed.', cause);
    }
    next.iterationTrace = {
      schema: TRACE_SCHEMA, head: hash, sequence: batch.sequence, observed,
      startedAt: previous?.startedAt || batch.recordedAt,
      priorHistory: 'available-snapshot-only',
    };
    return next;
  };
  const query = async (trace, { missionId, kind = null, view = 'latest', limit = 100, cursor = null } = {}) => {
    if (typeof missionId !== 'string' || !missionId || (kind !== null && !TRACE_KINDS.includes(kind))
      || !['latest', 'revisions'].includes(view) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid();
    validatePointer(trace);
    let pinned = null;
    if (cursor) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw invalid();
        pinned = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!validDigest(pinned.head) || !Number.isSafeInteger(pinned.offset) || pinned.offset < 0
          || pinned.missionId !== missionId || pinned.kind !== kind || pinned.view !== view) throw invalid();
      } catch { throw invalid(); }
    }
    if (!trace) {
      if (pinned) throw invalid();
      return { missionId, records: [], nextCursor: null, coverage: { status: 'not_started', priorHistory: 'unknown' } };
    }
    let hash = trace.head;
    let expected = trace.sequence;
    let accepting = !pinned;
    let offset = 0;
    const skip = pinned?.offset || 0;
    const records = [];
    const seen = new Set();
    while (hash) {
      const batch = await readBatch(hash);
      if (batch.sequence !== expected || (expected === 1) !== (batch.previous === null)) throw corrupt();
      if (pinned?.head === hash) accepting = true;
      if (accepting) {
        for (const record of [...batch.records].reverse()) {
          if (record.missionId !== missionId || (kind && record.kind !== kind)) continue;
          if (view === 'latest' && seen.has(record.key)) continue;
          seen.add(record.key);
          if (offset++ < skip) continue;
          records.push({ ...record, revision: hash, stateVersion: batch.stateVersion, recordedAt: batch.recordedAt });
          if (records.length > limit) break;
        }
        if (records.length > limit) break;
      }
      hash = batch.previous;
      expected -= 1;
    }
    if (!accepting) throw invalid(); // Cursor cannot expose a prepared orphan.
    const more = records.length > limit;
    return {
      missionId, records: records.slice(0, limit),
      nextCursor: more ? Buffer.from(JSON.stringify({ head: pinned?.head || trace.head, offset: skip + limit, missionId, kind, view })).toString('base64url') : null,
      coverage: { status: 'recording', startedAt: trace.startedAt, priorHistory: trace.priorHistory },
    };
  };
  return Object.freeze({ prepare, query });
}

export const createTraceStateWriter = ({ traceStore, writeSnapshot }) => async (state) => writeSnapshot(await traceStore.prepare(state));
