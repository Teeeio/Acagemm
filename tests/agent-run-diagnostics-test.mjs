#!/usr/bin/env node
// Independent, hardware-free acceptance for the frozen bounded-run-diagnostics
// contract in docs/development/RUN_DIAGNOSTICS_ACCEPTANCE.md (D1/D2/D3, matrix
// T1-T8).
//
// This test is written BEFORE the production implementation and derives every
// expectation from the frozen document, never from a candidate implementation:
//   * it drives the real `createClaudeClient` entry point with an injected fake
//     child process (no live Claude CLI, no model, no network, no GPU);
//   * it drives the real `createAgentRuntime({ mode: 'claude-code' })` entry
//     point with an injected provider port double that records the exact
//     `cancel(runId, context)` call it receives;
//   * it does not mirror production code to manufacture a pass and must not be
//     weakened to accept a partial implementation.
//
// T9 ("the existing tests keep their old invariants") is deliberately NOT
// re-asserted in this file. Pinning source/test digests or spawning the existing
// suites here would lock unrelated later edits and duplicate the release gate;
// that invariance stays owned by the platform acceptance_inputs and the Root
// combination gate, which runs the unchanged existing tests. tests/README.md
// records that ownership.
//
// Negative cases are written so the targeted branch is actually reached: each
// scenario gets its own isolated client/runtime instance, its own run identity
// and its own temporary root, every wait is a bounded condition wait (no exact-
// millisecond timing assertions) and no assertion depends on an earlier
// scenario succeeding. Persistence ordering follows the frozen contract exactly:
// D2 requires new stderr activity and the first cancellation to be observable
// before close, while D1 only requires the final record to be durable at close,
// so stdout counters are asserted after a controlled close, never live.
//
// The author phase only runs `node --check` on this file. The producers
// (client diagnostics, runtime cancellation context) are not part of this
// snapshot, so every diagnostics check is expected to stay red until the
// combined candidate lands; the final combination command executes this test.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClaudeClient } from '../client-runtime/claude-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAGNOSTICS_SCHEMA = 'operator-studio.agent-run-diagnostics/v1';
const CANCELLATION_SCHEMA = 'operator-studio.cancellation-context/v1';
const DIAGNOSTICS_KEYS = ['schemaVersion', 'provider', 'runId', 'missionId', 'stdout', 'stderr', 'events', 'firstModelObservedAt', 'cancellation', 'close'];
const STREAM_KEYS = ['chunks', 'bytes', 'firstAt', 'lastAt'];
const EVENT_KEYS = ['systemInit', 'thinkingTokens', 'assistant', 'result', 'other', 'invalidJson'];
const CANCELLATION_WRAPPER_KEYS = ['context', 'requestedAt'];
const CANCELLATION_CONTEXT_KEYS = ['schemaVersion', 'runId', 'missionId', 'role', 'trigger', 'triggeredAt', 'budgetMs', 'elapsedMs', 'stallTimeoutMs', 'idleMs'];
const CLOSE_KEYS = ['at', 'exitCode', 'signal'];
const ROLE_ENUM = ['main', 'research', 'materializer'];
const TRIGGER_ENUM = ['explicit_cancel', 'budget_exceeded', 'stall_timeout', 'budget_and_stall', 'logical_completion', 'prior_cancel_requested', 'terminal_unreleased', 'release_pending'];

const failures = [];
let passCount = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passCount += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.stack || error?.message || String(error) });
    console.log(`not ok - ${name}`);
    console.log(`  ${String(error?.message || error).split('\n').join('\n  ')}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isIso = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && value.endsWith('Z') && !Number.isNaN(Date.parse(value));
const isNonNegInt = (value) => Number.isSafeInteger(value) && value >= 0;
const isNonNegFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isPositiveFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

const assertExactKeys = (value, keys, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object, got ${JSON.stringify(value)}`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must expose exactly the frozen keys`);
};

// Bounded condition wait: never asserts a fixed millisecond boundary, only that
// the condition becomes true inside the window.
const waitForValue = async (predicate, { timeoutMs = 5_000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`bounded wait timed out after ${timeoutMs}ms for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
    }
    await delay(10);
  }
};

const tempRoots = [];
const cleanupRoots = async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
};

// A real, empty Git repository. T8's convergence projection reaches the existing
// workspace Diff authority, so it needs a real workspace boundary instead of the
// project root or a non-repository temporary directory.
const createEmptyGitWorkspace = async (label) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-run-diag-git-${label}-`));
  tempRoots.push(root);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Run Diagnostics Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'diagnostics@test.invalid'], { cwd: root });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'baseline'], { cwd: root });
  return root;
};

// ---------------------------------------------------------------------------
// Real Claude client entry point with an injected child process
// ---------------------------------------------------------------------------

// Chunks are spaced by a real event-loop turn so each one is observed as a
// separate data chunk instead of a coalesced buffer: the exact chunk counters
// are contract output, never an artifact of stream buffering.
const writeTo = async (control, stream, ...chunks) => {
  for (const chunk of chunks) {
    if (stream === 'stderr') control.stderr(chunk); else control.stdout(chunk);
    await delay(2);
  }
};

const line = (value) => `${JSON.stringify(value)}\n`;
const evInit = (session, model = 'claude-init-label') => line({ type: 'system', subtype: 'init', session_id: session, model });
const evThinkingTokens = (session, secret) => line({ type: 'system', subtype: 'thinking_tokens', session_id: session, estimated_tokens: 5, estimated_delta: 5, text: secret });
const evAssistantThinking = (session, model, secret) => line({ type: 'assistant', session_id: session, message: { model, content: [{ type: 'thinking', thinking: secret }] } });
const evAssistantText = (session, model, text = 'ok') => line({ type: 'assistant', session_id: session, message: { model, content: [{ type: 'text', text }] } });
const evResult = (session, modelUsage = {}) => line({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'ok', modelUsage });

const createClientHarness = async (label, { terminate } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-run-diag-${label}-`));
  tempRoots.push(root);
  const controls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 6_000 + controls.length;
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setTimeout(() => child.emit('close', null, 'SIGTERM'), 5);
    };
    child.stdin.on('data', () => {});
    const control = {
      child,
      closed: false,
      stdout: (text) => { child.stdout.write(text); },
      stderr: (text) => { child.stderr.write(text); },
      finish: (code = 0, signal = null) => {
        if (control.closed) return;
        control.closed = true;
        child.stdout.end();
        child.stderr.end();
        setTimeout(() => child.emit('close', code, signal), 10);
      },
    };
    controls.push(control);
    return child;
  };
  const claude = createClaudeClient({
    command: 'claude-diag-test',
    bridgeDir: path.join(root, 'bridge'),
    spawnImpl,
    terminateProcessTreeImpl: terminate || (async (child) => { if (child) child.kill(); }),
  });
  return {
    root,
    claude,
    controls,
    start: async ({ runId, missionId = 'MIS_DIAG', goal = runId, resumeThreadId = null, environment = {} }) => {
      await claude.start({
        runId,
        missionId,
        goal,
        workspace: root,
        resumeThreadId,
        environment: { OPERATOR_AGENT_ROLE: 'iteration', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }), ...environment },
      });
      return claude.readRun(runId);
    },
    readRun: (runId) => claude.readRun(runId),
    jsonPath: (runId) => path.join(root, 'bridge', 'claude-runs', `${runId}.json`),
  };
};

// A missing diagnostics object is reported as a locatable failure instead of a
// TypeError deep inside a fixture.
const diagnosticsOf = (record, label) => {
  if (!record || typeof record !== 'object' || !record.diagnostics || typeof record.diagnostics !== 'object') {
    throw new Error(`RUN_DIAGNOSTICS_MISSING: run ${label} has no persisted diagnostics object (record keys: ${record && typeof record === 'object' ? Object.keys(record).join(',') : String(record)})`);
  }
  return record.diagnostics;
};

const assertDefaultDiagnostics = (diagnostics, { runId, missionId }) => {
  assertExactKeys(diagnostics, DIAGNOSTICS_KEYS, 'D1 diagnostics');
  assert.equal(diagnostics.schemaVersion, DIAGNOSTICS_SCHEMA);
  assert.equal(diagnostics.provider, 'claude-code');
  assert.equal(diagnostics.runId, runId);
  assert.equal(diagnostics.missionId, missionId);
  assert.deepEqual(diagnostics.stdout, { chunks: 0, bytes: 0, firstAt: null, lastAt: null });
  assert.deepEqual(diagnostics.stderr, { chunks: 0, bytes: 0, firstAt: null, lastAt: null });
  assert.deepEqual(diagnostics.events, { systemInit: 0, thinkingTokens: 0, assistant: 0, result: 0, other: 0, invalidJson: 0 });
  assert.equal(diagnostics.firstModelObservedAt, null);
  assert.equal(diagnostics.cancellation, null);
  assert.equal(diagnostics.close, null);
};

const waitForClose = (harness, runId, label) => waitForValue(async () => {
  const record = await harness.readRun(runId);
  return record.diagnostics?.close ? record : null;
}, { label });

// ---------------------------------------------------------------------------
// Real agent-runtime entry point with an injected provider port double
// ---------------------------------------------------------------------------

const createRuntimeHarness = ({ cancellationTimeoutMs, mainAgentStallMs, mainAgentBudgetMs, cancelImpl } = {}) => {
  const cancelCalls = [];
  const runs = new Map();
  const events = new Map();
  const client = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'run-diagnostics-double' }),
    preflight: async ({ workspace }) => ({ ready: true, code: 'CLAUDE_READY', workspace }),
    start: async () => { throw new Error('the run diagnostics acceptance must not start a provider'); },
    readRun: async (runId) => structuredClone(runs.get(runId)),
    readEvents: async (runId) => structuredClone(events.get(runId) || []),
    cancel: async (runId, context) => {
      cancelCalls.push({ runId, context: context === undefined ? null : structuredClone(context) });
      return cancelImpl ? cancelImpl(runId, context) : { status: 'cancel_requested', resourceRelease: { confirmed: false, status: 'pending' } };
    },
    eventText: (event) => event?.item?.text || event?.error?.message || '',
  };
  const runtime = createAgentRuntime({
    mode: 'claude-code',
    claudeClient: client,
    bridgeDir: path.join(os.tmpdir(), 'agent-run-diag-runtime-bridge'),
    codexWorkspace: projectRoot,
    ...(cancellationTimeoutMs ? { cancellationTimeoutMs } : {}),
    ...(mainAgentStallMs ? { mainAgentStallMs } : {}),
    ...(mainAgentBudgetMs ? { mainAgentBudgetMs } : {}),
  });
  return { runtime, cancelCalls, runs, events, client };
};

const runRecord = ({ runId, missionId = 'MIS_RT', status = 'running', lastActivityAt = Date.now(), resourceRelease, workspace = projectRoot } = {}) => ({
  runId,
  missionId,
  provider: 'claude-code',
  status,
  threadId: 'sess-rt',
  workspace,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  lastActivityAt: new Date(lastActivityAt).toISOString(),
  completedAt: null,
  error: null,
  activity: null,
  ...(resourceRelease ? { resourceRelease } : {}),
});

const baseState = (missionId = 'MIS_RT') => ({
  activeMissionId: missionId,
  missions: [{ id: missionId, title: 'Run diagnostics', repository: projectRoot, hardware: ['CPU'], metric: 'latency p50' }],
  runtimeEvents: [],
  stage: 'diagnosis',
  patchApplied: false,
  candidateEvaluations: [],
  runHistory: [],
  tokenUsage: { runs: {} },
});

const mainState = ({ runId, missionId = 'MIS_RT', status = 'running', startedAtMs = 1_000, budgetMs = null, lastEventAt = Date.now(), eventCount = 0 } = {}) => ({
  ...baseState(missionId),
  agent: {
    status,
    runtimeKind: 'claude-code',
    runId,
    missionId,
    goal: 'diagnose',
    startedAt: new Date(Date.now() - startedAtMs).toISOString(),
    eventCount,
    lastEventAt,
    messages: [],
    toolCalls: [],
    artifacts: [],
    ...(budgetMs === null ? {} : { budgetMs }),
  },
});

const researchState = ({ runId, missionId = 'MIS_RT', status = 'running', startedAtMs = 1_000, budgetMs = 1_000, lastEventAt = Date.now(), eventCount = 0, runPhase = 'acquire' } = {}) => ({
  ...baseState(missionId),
  researchAgent: {
    status,
    runtimeKind: 'claude-code',
    runId,
    missionId,
    runPhase,
    direction: 'diagnose',
    researchDir: projectRoot,
    startedAt: new Date(Date.now() - startedAtMs).toISOString(),
    eventCount,
    lastEventAt,
    budgetMs,
    notes: [],
    messages: [],
    artifacts: [],
  },
});

const materializerState = ({ runId, missionId = 'MIS_RT', status = 'running', startedAtMs = 1_000, budgetMs = 1_000, lastEventAt = Date.now(), eventCount = 0 } = {}) => ({
  ...baseState(missionId),
  baseline: {
    kind: 'pytorch_reference',
    status: 'missing',
    materializer: {
      status,
      runtimeKind: 'claude-code',
      runId,
      missionId,
      phase: 'diagnose',
      startedAt: new Date(Date.now() - startedAtMs).toISOString(),
      eventCount,
      lastEventAt,
      budgetMs,
      source: null,
      matrix: {},
      messages: [],
      artifacts: [],
    },
  },
});

const assertCancellationContext = (context, { runId, missionId, role, trigger }, label) => {
  assertExactKeys(context, CANCELLATION_CONTEXT_KEYS, `${label} context`);
  assert.equal(context.schemaVersion, CANCELLATION_SCHEMA);
  assert.equal(context.runId, runId);
  assert.equal(context.missionId, missionId);
  assert.ok(ROLE_ENUM.includes(context.role), `${label} role must be one of the frozen roles, got ${JSON.stringify(context.role)}`);
  assert.equal(context.role, role);
  assert.ok(TRIGGER_ENUM.includes(context.trigger), `${label} trigger must be one of the frozen triggers, got ${JSON.stringify(context.trigger)}`);
  assert.equal(context.trigger, trigger);
  assert.ok(isIso(context.triggeredAt), `${label} triggeredAt must be an ISO timestamp, got ${JSON.stringify(context.triggeredAt)}`);
  for (const key of ['budgetMs', 'elapsedMs', 'idleMs']) {
    assert.ok(context[key] === null || isNonNegFinite(context[key]), `${label} ${key} must be a finite nonnegative number or null, got ${JSON.stringify(context[key])}`);
  }
  assert.ok(context.stallTimeoutMs === null || isPositiveFinite(context.stallTimeoutMs), `${label} stallTimeoutMs must be a finite positive number or null, got ${JSON.stringify(context.stallTimeoutMs)}`);
};
const assertExplicitCancellationContext = (context, identity, label) => {
  assertCancellationContext(context, { ...identity, trigger: 'explicit_cancel' }, label);
};
const cancelCallCount = (harness) => harness.cancelCalls.length;
const singletonCancelCall = (harness, label) => {
  assert.equal(cancelCallCount(harness), 1, `${label} must reach the provider cancel port exactly once`);
  return harness.cancelCalls[0];
};

try {
  // =========================================================================
  // T1 - defaults, exact identities and simultaneous-run isolation
  // =========================================================================
  await check('T1 new runs carry exact defaults and two simultaneous runs keep separate identities/counts', async () => {
    const harness = await createClientHarness('t1');
    const first = { runId: 'claude_DIAG_T1_A', missionId: 'MIS_T1_A' };
    const second = { runId: 'claude_DIAG_T1_B', missionId: 'MIS_T1_B' };
    await harness.start({ ...first, goal: 't1-a' });
    await harness.start({ ...second, goal: 't1-b' });

    // Defaults are readable before any stream activity and keep separate identities.
    assertDefaultDiagnostics(diagnosticsOf(await harness.readRun(first.runId), first.runId), first);
    assertDefaultDiagnostics(diagnosticsOf(await harness.readRun(second.runId), second.runId), second);

    const initLine = evInit('sess-t1-a');
    const resultLine = evResult('sess-t1-b');
    const brokenLine = 'not a json line\n';
    await writeTo(harness.controls[0], 'stdout', initLine);
    await writeTo(harness.controls[1], 'stdout', resultLine, brokenLine);

    // Deliberately no live count assertion: D1 only requires the record to be
    // final and durable at close, while D2 guarantees before-close observability
    // for stderr and cancellation alone. An invalid stdout tail line must not be
    // required to reach disk on its own schedule. Only `close` may never be
    // invented early, so that is the single pre-close assertion here.
    assert.equal(diagnosticsOf(await harness.readRun(first.runId), first.runId).close, null, 'close stays null until the real child close callback');
    assert.equal(diagnosticsOf(await harness.readRun(second.runId), second.runId).close, null);

    // Controlled close, then every final count is asserted per run and
    // independently, never through a combined "both runs advanced" predicate.
    harness.controls[0].finish(0, null);
    harness.controls[1].finish(7, null);
    const closedA = await waitForClose(harness, first.runId, 'first close receipt');
    const closedB = await waitForClose(harness, second.runId, 'second close receipt');

    const diagnosticsA = diagnosticsOf(closedA, first.runId);
    const diagnosticsB = diagnosticsOf(closedB, second.runId);
    assert.equal(diagnosticsA.stdout.chunks, 1);
    assert.equal(diagnosticsA.stdout.bytes, Buffer.byteLength(initLine));
    assert.equal(diagnosticsA.stderr.chunks, 0);
    assert.equal(diagnosticsA.events.systemInit, 1);
    assert.equal(diagnosticsA.events.result, 0);
    assert.equal(diagnosticsA.events.invalidJson, 0);
    assert.equal(diagnosticsA.events.other, 0);
    assert.equal(diagnosticsB.stdout.chunks, 2);
    assert.equal(diagnosticsB.stdout.bytes, Buffer.byteLength(resultLine) + Buffer.byteLength(brokenLine));
    assert.equal(diagnosticsB.stderr.chunks, 0);
    assert.equal(diagnosticsB.events.result, 1);
    assert.equal(diagnosticsB.events.invalidJson, 1);
    assert.equal(diagnosticsB.events.systemInit, 0);
    assert.equal(diagnosticsB.events.other, 0);

    assert.notEqual(diagnosticsA.runId, diagnosticsB.runId, 'simultaneous runs must keep separate run identities');
    assert.equal(diagnosticsA.runId, first.runId);
    assert.equal(diagnosticsB.runId, second.runId);
    assert.equal(diagnosticsA.missionId, first.missionId);
    assert.equal(diagnosticsB.missionId, second.missionId);

    assertExactKeys(diagnosticsA.close, CLOSE_KEYS, 'D1 close');
    assert.equal(diagnosticsA.close.exitCode, 0);
    assert.equal(diagnosticsA.close.signal, null);
    assert.ok(isIso(diagnosticsA.close.at));
    assertExactKeys(diagnosticsB.close, CLOSE_KEYS, 'D1 close');
    assert.equal(diagnosticsB.close.exitCode, 7);
    assert.equal(diagnosticsB.close.signal, null);
    assert.ok(isIso(diagnosticsB.close.at));
  });

  // =========================================================================
  // T2 - unknown model, telemetry survives filtering, no body leakage
  // =========================================================================
  await check('T2 init + thinking telemetry then cancel with no assistant stays unknown without leaking body bytes', async () => {
    const harness = await createClientHarness('t2');
    const runId = 'claude_DIAG_T2';
    const secret = 'PRIVATE_T2_PAYLOAD_MUST_NOT_PERSIST';
    await harness.start({ runId, goal: 't2' });
    harness.controls[0].stdout(evInit('sess-t2', 'claude-opus-5[1m]'));
    harness.controls[0].stdout(evThinkingTokens('sess-t2', secret));

    const live = await waitForValue(async () => {
      const record = await harness.readRun(runId);
      return record.diagnostics?.events?.thinkingTokens === 1 ? record : null;
    }, { label: 'telemetry counted before filtering' });
    const liveDiagnostics = diagnosticsOf(live, runId);
    assert.equal(liveDiagnostics.events.systemInit, 1);
    assert.equal(liveDiagnostics.events.thinkingTokens, 1, 'telemetry counts survive the existing event filter');
    assert.equal(liveDiagnostics.events.assistant, 0);
    assert.equal(liveDiagnostics.firstModelObservedAt, null, 'init/configured/telemetry labels never set firstModelObservedAt');
    assert.ok(!JSON.stringify(liveDiagnostics).includes(secret), 'diagnostics must never contain thinking/body bytes');

    const eventBytes = await readFile(live.eventPath, 'utf8');
    assert.ok(!eventBytes.includes('thinking_tokens'), 'telemetry stays filtered from the raw event log');
    assert.ok(!eventBytes.includes(secret));

    await harness.claude.cancel(runId);
    const settled = await waitForValue(async () => {
      const record = await harness.readRun(runId);
      return record.status === 'cancelled' ? record : null;
    }, { label: 'cancelled run settles' });
    assert.equal(settled.modelObservation.status, 'unknown');
    assert.equal(settled.modelObservation.model, null);
    assert.equal(diagnosticsOf(settled, runId).firstModelObservedAt, null, 'no assistant response means the model stays unknown');
    assert.ok(!JSON.stringify(settled).includes(secret));
  });

  // =========================================================================
  // T3 - thinking-only assistant and unterminated tail observe once
  // =========================================================================
  await check('T3 thinking-only assistant and unterminated tail observe once; init/usage alone never observe', async () => {
    const harness = await createClientHarness('t3');
    const secret = 'PRIVATE_T3_THINKING_PAYLOAD';

    // (a) thinking-only assistant sets the historical first observation time and
    // a later conflicting response never erases it.
    const conflictRun = 'claude_DIAG_T3_CONFLICT';
    await harness.start({ runId: conflictRun, goal: 't3-conflict' });
    harness.controls[0].stdout(evInit('sess-t3', 'claude-init-label'));
    harness.controls[0].stdout(evAssistantThinking('sess-t3', 'model-first', secret));
    const observed = await waitForValue(async () => {
      const record = await harness.readRun(conflictRun);
      return record.diagnostics?.firstModelObservedAt ? record : null;
    }, { label: 'thinking-only assistant sets firstModelObservedAt' });
    const firstObservedAt = diagnosticsOf(observed, conflictRun).firstModelObservedAt;
    assert.ok(isIso(firstObservedAt), `firstModelObservedAt must be an ISO timestamp, got ${JSON.stringify(firstObservedAt)}`);
    assert.equal(diagnosticsOf(observed, conflictRun).events.assistant, 1);
    assert.equal(observed.modelObservation.status, 'observed');
    assert.equal(observed.modelObservation.model, 'model-first');
    assert.ok(!JSON.stringify(diagnosticsOf(observed, conflictRun)).includes(secret));

    harness.controls[0].stdout(evAssistantText('sess-t3', 'model-second', 'text response'));
    const conflicted = await waitForValue(async () => {
      const record = await harness.readRun(conflictRun);
      return record.modelObservation?.status === 'conflict' ? record : null;
    }, { label: 'later conflicting response is classified as conflict' });
    assert.equal(diagnosticsOf(conflicted, conflictRun).firstModelObservedAt, firstObservedAt, 'a later conflict must not erase the historical first observation time');
    assert.equal(diagnosticsOf(conflicted, conflictRun).events.assistant, 2);
    harness.controls[0].finish(0, null);
    const conflictClosed = await waitForClose(harness, conflictRun, 'conflict run closes');
    assert.equal(diagnosticsOf(conflictClosed, conflictRun).firstModelObservedAt, firstObservedAt);

    // (b) an unterminated final assistant line is counted once at close and is
    // observed through the existing authority.
    const tailRun = 'claude_DIAG_T3_TAIL';
    await harness.start({ runId: tailRun, goal: 't3-tail' });
    harness.controls[1].stdout(evInit('sess-tail'));
    harness.controls[1].stdout(evAssistantText('sess-tail', 'model-tail', 'unterminated final line').replace(/\n$/, ''));
    harness.controls[1].finish(0, null);
    const tailClosed = await waitForClose(harness, tailRun, 'unterminated tail closes');
    const tailDiagnostics = diagnosticsOf(tailClosed, tailRun);
    assert.equal(tailDiagnostics.events.assistant, 1, 'the unterminated final line must be counted exactly once at close');
    assert.ok(isIso(tailDiagnostics.firstModelObservedAt), 'the unterminated tail must reach the existing observation authority');
    assert.equal(tailClosed.modelObservation.status, 'observed');
    assert.equal(tailClosed.modelObservation.model, 'model-tail');

    // (c) init + result usage alone never observe a response model.
    const usageRun = 'claude_DIAG_T3_USAGE';
    await harness.start({ runId: usageRun, goal: 't3-usage' });
    harness.controls[2].stdout(evInit('sess-usage', 'claude-init-label'));
    harness.controls[2].stdout(evResult('sess-usage', { 'claude-init-label': 1 }));
    harness.controls[2].finish(0, null);
    const usageClosed = await waitForClose(harness, usageRun, 'usage-only run closes');
    const usageDiagnostics = diagnosticsOf(usageClosed, usageRun);
    assert.equal(usageDiagnostics.firstModelObservedAt, null, 'init/usage/configured labels alone never set firstModelObservedAt');
    assert.equal(usageClosed.modelObservation.status, 'unknown');
    assert.equal(usageDiagnostics.events.systemInit, 1);
    assert.equal(usageDiagnostics.events.result, 1);
    assert.equal(usageDiagnostics.events.assistant, 0);
    assert.ok(isIso(usageDiagnostics.close.at));
  });

  // =========================================================================
  // T4 - stream counters, event classes, fixed keys, durable reload
  // =========================================================================
  await check('T4 byte/time counters, blank/invalid/primitive/unknown classes, fixed keys and durable JSON reload', async () => {
    const harness = await createClientHarness('t4');
    const runId = 'claude_DIAG_T4';
    await harness.start({ runId, goal: 't4' });
    const secretBody = 'PRIVATE_T4_ASSISTANT_BODY';
    const secretStderr = 'PRIVATE_T4_STDERR_TEXT';
    const stdoutChunks = [
      evInit('sess-t4'),
      '\n',
      '   \n',
      'not json\n',
      '123\n',
      '[1,2]\n',
      'null\n',
      `${JSON.stringify({ type: 'custom.event', note: 'unknown type' })}\n`,
      evAssistantText('sess-t4', 'model-t4', secretBody),
    ];
    await writeTo(harness.controls[0], 'stdout', ...stdoutChunks);
    const stderrChunks = [`warn ${secretStderr} 1\n`, 'warn 2\n'];
    await writeTo(harness.controls[0], 'stderr', ...stderrChunks);
    const expectedStderrBytes = stderrChunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);

    // The unterminated final telemetry line is counted exactly once at close.
    const tailLine = JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: 'sess-t4', estimated_tokens: 3 });
    harness.controls[0].stdout(tailLine);
    const expectedStdoutBytes = stdoutChunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), Buffer.byteLength(tailLine));
    harness.controls[0].finish(3, null);

    const closed = await waitForClose(harness, runId, 'run with final unterminated line closes');
    const diagnostics = diagnosticsOf(closed, runId);
    assertExactKeys(diagnostics, DIAGNOSTICS_KEYS, 'D1 diagnostics');
    assertExactKeys(diagnostics.stdout, STREAM_KEYS, 'D1 stdout');
    assertExactKeys(diagnostics.stderr, STREAM_KEYS, 'D1 stderr');
    assertExactKeys(diagnostics.events, EVENT_KEYS, 'D1 events');
    assert.equal(diagnostics.stdout.chunks, stdoutChunks.length + 1);
    assert.equal(diagnostics.stdout.bytes, expectedStdoutBytes);
    assert.equal(diagnostics.stderr.chunks, 2);
    assert.equal(diagnostics.stderr.bytes, expectedStderrBytes);
    assert.ok(isIso(diagnostics.stdout.firstAt) && isIso(diagnostics.stdout.lastAt));
    assert.ok(isIso(diagnostics.stderr.firstAt) && isIso(diagnostics.stderr.lastAt));
    assert.ok(Date.parse(diagnostics.stdout.firstAt) <= Date.parse(diagnostics.stdout.lastAt), 'per-stream first/last times must be ordered');
    assert.ok(Date.parse(diagnostics.stdout.lastAt) <= Date.parse(diagnostics.close.at) + 5, 'stream times cannot follow the close fact');
    assert.equal(diagnostics.events.systemInit, 1);
    assert.equal(diagnostics.events.thinkingTokens, 1, 'the unterminated final line is counted exactly once');
    assert.equal(diagnostics.events.assistant, 1);
    assert.equal(diagnostics.events.result, 0);
    assert.equal(diagnostics.events.invalidJson, 1, 'invalid nonblank JSON increments invalidJson');
    assert.equal(diagnostics.events.other, 4, 'valid primitives (number, array, null) and unknown types are other');
    for (const [key, value] of Object.entries(diagnostics.events)) {
      assert.ok(isNonNegInt(value), `events.${key} must be a nonnegative safe integer, got ${JSON.stringify(value)}`);
    }
    for (const key of ['chunks', 'bytes']) {
      assert.ok(isNonNegInt(diagnostics.stdout[key]) && isNonNegInt(diagnostics.stderr[key]), `${key} counters must be nonnegative safe integers`);
    }
    assert.ok(!JSON.stringify(diagnostics).includes(secretBody), 'assistant body bytes must never enter diagnostics');
    assert.ok(!JSON.stringify(diagnostics).includes(secretStderr), 'stderr text must never enter diagnostics');
    assertExactKeys(diagnostics.close, CLOSE_KEYS, 'D1 close');
    assert.equal(diagnostics.close.exitCode, 3);
    assert.equal(diagnostics.close.signal, null);
    assert.ok(isIso(diagnostics.close.at));

    // `other` is a diagnostics bucket over the raw JSONL lines, counted before the
    // existing filter/normalization: the provider-neutral readEvents log must not
    // fabricate an entry for a valid primitive, array, null or unknown type.
    const normalizedEvents = await harness.claude.readEvents(runId);
    assert.ok(normalizedEvents.every((event) => event && typeof event === 'object' && !Array.isArray(event) && typeof event.type === 'string'),
      `readEvents must stay a provider-neutral event log, got ${JSON.stringify(normalizedEvents)}`);
    assert.ok(!normalizedEvents.some((event) => event.type === 'custom.event' || event.type === 'null' || event.type === 'number' || event.type === 'array'),
      'the existing normalized log never turns an other-classed line into an event');
    assert.equal(normalizedEvents.filter((event) => event.type === 'item.completed' && event.item?.text === secretBody).length, 1, 'the assistant text still reaches the normalized log');

    // Durable final JSON: a fresh reload of the run file equals the live record.
    const reloaded = JSON.parse(await readFile(harness.jsonPath(runId), 'utf8'));
    assert.deepEqual(reloaded.diagnostics, diagnostics, 'all diagnostic fields must be durably final at close after earlier queued writes');
    assert.deepEqual(JSON.parse(JSON.stringify(closed)), closed, 'the record must survive a JSON round trip');
    assert.ok(Date.parse(closed.lastActivityAt) >= Date.parse(closed.startedAt), 'existing lastActivityAt semantics remain intact');

    // Fresh run: stderr-only activity must become observable before close, with
    // no stdout write queued ahead of it that could trigger the flush instead.
    const stderrRun = 'claude_DIAG_T4_STDERR';
    const stderrOnlyChunk = 'warn PRIVATE_T4_STDERR_ONLY\n';
    await harness.start({ runId: stderrRun, goal: 't4-stderr' });
    harness.controls[1].stderr(stderrOnlyChunk);
    const stderrLive = await waitForValue(async () => {
      const record = await harness.readRun(stderrRun);
      return record.diagnostics?.stderr?.chunks === 1 ? record : null;
    }, { timeoutMs: 8_000, label: 'stderr-only activity becomes observable before close' });
    const stderrLiveDiagnostics = diagnosticsOf(stderrLive, stderrRun);
    assert.equal(stderrLiveDiagnostics.close, null, 'stderr activity must be observable while close is still null');
    assert.equal(stderrLiveDiagnostics.stdout.chunks, 0, 'no stdout was written, so the stderr proof cannot ride on a queued stdout write');
    assert.equal(stderrLiveDiagnostics.stdout.bytes, 0);
    assert.equal(stderrLiveDiagnostics.stderr.bytes, Buffer.byteLength(stderrOnlyChunk));
    assert.ok(isIso(stderrLiveDiagnostics.stderr.firstAt), 'stderr firstAt is stamped at the client boundary');
    assert.ok(!JSON.stringify(stderrLiveDiagnostics).includes('PRIVATE_T4_STDERR_ONLY'), 'stderr text must never enter diagnostics');
    harness.controls[1].finish(0, null);

    // Fresh run: a valid JSON `null` as the unterminated tail line is counted once
    // as `other`, never as invalid JSON.
    const nullTailRun = 'claude_DIAG_T4_NULL_TAIL';
    await harness.start({ runId: nullTailRun, goal: 't4-null-tail' });
    harness.controls[2].stdout('null');
    harness.controls[2].finish(0, null);
    const nullTailClosed = await waitForClose(harness, nullTailRun, 'null tail line closes');
    const nullTailDiagnostics = diagnosticsOf(nullTailClosed, nullTailRun);
    assert.equal(nullTailDiagnostics.stdout.chunks, 1);
    assert.equal(nullTailDiagnostics.stdout.bytes, Buffer.byteLength('null'));
    assert.equal(nullTailDiagnostics.events.other, 1, 'the unterminated final line is a valid JSON null and counts once as other');
    assert.equal(nullTailDiagnostics.events.invalidJson, 0, 'a valid JSON null is never invalid JSON');
    assert.equal(nullTailDiagnostics.close.exitCode, 0);

    // A non-conventional signal name must never be reported as a real signal.
    const signalRun = 'claude_DIAG_T4_SIGNAL';
    await harness.start({ runId: signalRun, goal: 't4-signal' });
    harness.controls[3].finish(null, 'NOT_A_CONVENTIONAL_SIGNAL');
    const signalClosed = await waitForClose(harness, signalRun, 'non-conventional signal closes');
    const signalClose = diagnosticsOf(signalClosed, signalRun).close;
    assertExactKeys(signalClose, CLOSE_KEYS, 'D1 close');
    assert.equal(signalClose.exitCode, null, 'a null callback exit code is preserved, never invented');
    assert.equal(signalClose.signal, null, 'a non-conventional signal name must not be reported');
  });

  // =========================================================================
  // T5 - durable first cancellation context and truthful null behaviour
  // =========================================================================
  await check('T5 first cancellation is durable while termination is pending; repeat/invalid/foreign contexts never replace it', async () => {
    const pendingTerminations = [];
    const releaseTerminations = () => { pendingTerminations.splice(0).forEach((resolve) => resolve()); };
    const harness = await createClientHarness('t5', {
      terminate: () => new Promise((resolve) => { pendingTerminations.push(resolve); }),
    });
    const runId = 'claude_DIAG_T5';
    const missionId = 'MIS_T5';
    await harness.start({ runId, missionId, goal: 't5' });
    harness.controls[0].stdout(evInit('sess-t5'));
    await waitForValue(async () => {
      const record = await harness.readRun(runId);
      return record.diagnostics?.events?.systemInit === 1 ? record : null;
    }, { label: 'init count is durable while the run is live' });

    const validContext = {
      schemaVersion: CANCELLATION_SCHEMA,
      runId,
      missionId,
      role: 'main',
      trigger: 'budget_exceeded',
      triggeredAt: new Date().toISOString(),
      budgetMs: 600_000,
      elapsedMs: 600_500,
      stallTimeoutMs: 120_000,
      idleMs: 42,
    };
    const firstCancel = harness.claude.cancel(runId, {
      ...validContext,
      prompt: 'PRIVATE_T5_PROMPT',
      stderr: 'PRIVATE_T5_STDERR',
      apiKey: 'sk-ant-PRIVATE_T5_CREDENTIAL',
    }).catch(() => {});

    const durable = await waitForValue(async () => {
      const record = await harness.readRun(runId);
      return record.diagnostics?.cancellation ? record : null;
    }, { label: 'cancellation becomes durable while termination is pending' });
    const durableDiagnostics = diagnosticsOf(durable, runId);
    assert.equal(durableDiagnostics.close, null, 'termination is still pending, so close must remain null');
    assertExactKeys(durableDiagnostics.cancellation, CANCELLATION_WRAPPER_KEYS, 'D2 cancellation');
    assert.ok(isIso(durableDiagnostics.cancellation.requestedAt));
    assertExactKeys(durableDiagnostics.cancellation.context, CANCELLATION_CONTEXT_KEYS, 'D2 cancellation context');
    assert.deepEqual(durableDiagnostics.cancellation.context, validContext, 'only the listed context keys are copied, extras are dropped');
    assert.ok(!JSON.stringify(durableDiagnostics).includes('PRIVATE_T5'), 'prompt/stderr/credential text must never enter diagnostics');
    const firstRequestedAt = durableDiagnostics.cancellation.requestedAt;

    // Repeats with a different context, a foreign identity, an invalid schema
    // and no context at all must not overwrite the first request.
    harness.claude.cancel(runId, { ...validContext, trigger: 'stall_timeout', triggeredAt: new Date(Date.now() + 1_000).toISOString(), runId: 'claude_FOREIGN', missionId: 'MIS_FOREIGN' }).catch(() => {});
    harness.claude.cancel(runId, { schemaVersion: 'operator-studio.cancellation-context/v0' }).catch(() => {});
    harness.claude.cancel(runId).catch(() => {});
    await delay(80);
    const afterRepeats = diagnosticsOf(await harness.readRun(runId), runId).cancellation;
    assert.equal(afterRepeats.requestedAt, firstRequestedAt, 'repeat calls must not overwrite the first requestedAt');
    assert.deepEqual(afterRepeats.context, validContext, 'repeat/invalid/foreign calls must not replace the first context');

    // Releasing the held termination produces the real close receipt.
    releaseTerminations();
    await firstCancel;
    harness.controls[0].finish(null, 'SIGTERM');
    const closed = await waitForClose(harness, runId, 'held termination released');
    const closedDiagnostics = diagnosticsOf(closed, runId);
    assertExactKeys(closedDiagnostics.close, CLOSE_KEYS, 'D1 close');
    assert.equal(closedDiagnostics.close.exitCode, null);
    assert.equal(closedDiagnostics.close.signal, 'SIGTERM');
    assert.ok(isIso(closedDiagnostics.close.at));
    assert.deepEqual(closedDiagnostics.cancellation, durableDiagnostics.cancellation, 'close keeps the first durable cancellation');

    // Cancelling after the child is gone does not fabricate a request.
    await harness.claude.cancel(runId, validContext).catch(() => {});
    const afterClose = diagnosticsOf(await harness.readRun(runId), runId);
    assert.deepEqual(afterClose.cancellation, durableDiagnostics.cancellation);
    assert.equal(afterClose.close.exitCode, null);

    // A run that never receives a cancel keeps cancellation null, including
    // after a post-close cancel call.
    const plainRun = 'claude_DIAG_T5_PLAIN';
    await harness.start({ runId: plainRun, missionId, goal: 't5-plain' });
    harness.controls[1].stdout(evInit('sess-t5-plain'));
    harness.controls[1].finish(0, null);
    const plainClosed = await waitForClose(harness, plainRun, 'plain run closes without cancellation');
    assert.equal(diagnosticsOf(plainClosed, plainRun).cancellation, null);
    const afterPlainCancel = await harness.claude.cancel(plainRun);
    assert.equal(afterPlainCancel.diagnostics.cancellation, null, 'a post-close legacy cancel must not fabricate a request');
    assert.equal(diagnosticsOf(await harness.readRun(plainRun), plainRun).cancellation, null);

    // A legacy context-less cancel(runId) on a live child is still the first real
    // request: it must record requestedAt and keep the context truthfully null.
    const legacyRun = 'claude_DIAG_T5_LEGACY';
    await harness.start({ runId: legacyRun, missionId, goal: 't5-legacy' });
    const legacyCancel = harness.claude.cancel(legacyRun).catch(() => {});
    const legacyDurable = await waitForValue(async () => {
      const record = await harness.readRun(legacyRun);
      return record.diagnostics?.cancellation ? record : null;
    }, { label: 'context-less first cancellation is durable' });
    const legacyDiagnostics = diagnosticsOf(legacyDurable, legacyRun);
    assert.equal(legacyDiagnostics.close, null);
    assertExactKeys(legacyDiagnostics.cancellation, CANCELLATION_WRAPPER_KEYS, 'D2 cancellation');
    assert.ok(isIso(legacyDiagnostics.cancellation.requestedAt), 'a legacy cancel still records the real request time');
    assert.equal(legacyDiagnostics.cancellation.context, null, 'a direct legacy cancel(runId) legitimately produces context=null');
    releaseTerminations();
    await legacyCancel;

    // Every invalid-context family is driven as its own fresh run so the first
    // request of that run is the invalid one and exactly one invalid field is
    // exercised at a time; all other fields stay legal. A schema/role/trigger/
    // time/numeric/identity rejection therefore cannot hide behind the first
    // failing branch of a fully corrupted context.
    const invalidCases = [
      // A real sibling run of this same client: the identity must still match the
      // record of the run being cancelled, so a live foreign run ID stays invalid.
      { label: 'foreign run identity', patch: { runId: legacyRun } },
      { label: 'foreign Mission identity', patch: { missionId: 'MIS_FOREIGN' } },
      { label: 'invalid role', patch: { role: 'bogus-role' } },
      { label: 'invalid trigger', patch: { trigger: 'bogus-trigger' } },
      { label: 'invalid triggeredAt', patch: { triggeredAt: 'not-a-timestamp' } },
      { label: 'invalid budgetMs', patch: { budgetMs: -1 } },
      { label: 'invalid elapsedMs', patch: { elapsedMs: Number.NaN } },
      { label: 'invalid stallTimeoutMs', patch: { stallTimeoutMs: 0 } },
      { label: 'invalid idleMs', patch: { idleMs: -5 } },
    ];
    for (const [index, invalidCase] of invalidCases.entries()) {
      const invalidRun = `claude_DIAG_T5_INVALID_${index}`;
      await harness.start({ runId: invalidRun, missionId, goal: `t5-invalid-${index}` });
      const invalidContext = { ...validContext, runId: invalidRun, ...invalidCase.patch };
      const invalidCancel = harness.claude.cancel(invalidRun, invalidContext).catch(() => {});
      const invalidDurable = await waitForValue(async () => {
        const record = await harness.readRun(invalidRun);
        return record.diagnostics?.cancellation ? record : null;
      }, { label: `invalid first context (${invalidCase.label}) still registers the actual cancellation` });
      const invalidDiagnostics = diagnosticsOf(invalidDurable, invalidRun);
      assert.equal(invalidDiagnostics.close, null, `${invalidCase.label}: cancellation must not wait for close`);
      assertExactKeys(invalidDiagnostics.cancellation, CANCELLATION_WRAPPER_KEYS, `D2 cancellation (${invalidCase.label})`);
      assert.ok(isIso(invalidDiagnostics.cancellation.requestedAt), `${invalidCase.label}: invalid context must not prevent cancellation`);
      assert.equal(invalidDiagnostics.cancellation.context, null, `${invalidCase.label}: invalid context data yields context=null`);
      releaseTerminations();
      await invalidCancel;
      await delay(10);
    }
  });

  // =========================================================================
  // T6 - real runtime producers for main budget/stall/both
  // =========================================================================
  await check('T6a main automatic budget expiry delivers budget_exceeded scalars without premature release', async () => {
    const harness = createRuntimeHarness({ mainAgentStallMs: 900_000, mainAgentBudgetMs: 600_000 });
    const runId = 'claude_RT_BUDGET';
    harness.runs.set(runId, runRecord({ runId }));
    harness.events.set(runId, []);
    const state = mainState({ runId, startedAtMs: 601_000, budgetMs: 600_000, lastEventAt: Date.now() });
    await harness.runtime.projectState(state);

    const call = singletonCancelCall(harness, 'main budget expiry');
    assert.equal(call.runId, runId);
    assertCancellationContext(call.context, { runId, missionId: 'MIS_RT', role: 'main', trigger: 'budget_exceeded' }, 'main budget expiry');
    assert.equal(call.context.budgetMs, 600_000, 'the effective main budget must be the branch value, never a recomputed fallback');
    assert.ok(call.context.elapsedMs >= 600_000, `elapsedMs must reflect the actual elapsed time, got ${call.context.elapsedMs}`);
    assert.equal(call.context.stallTimeoutMs, 900_000, 'the effective main stall timeout must be carried');
    assert.ok(isNonNegFinite(call.context.idleMs), 'measured idle must be a finite nonnegative number');
    assert.equal(state.agent.status, 'cancel_requested');
    assert.equal(state.agent.resourceRelease.confirmed, false, 'no premature release');
    assert.equal(state.candidateEvaluations.length, 0, 'no candidate admission during cancellation');
    assert.equal(state.stage, 'diagnosis');
  });

  await check('T6b main stall-only expiry delivers stall_timeout without premature release', async () => {
    const harness = createRuntimeHarness({ mainAgentStallMs: 2_000, mainAgentBudgetMs: 3_600_000 });
    const runId = 'claude_RT_STALL';
    const staleActivity = Date.now() - 5_000;
    harness.runs.set(runId, runRecord({ runId, lastActivityAt: staleActivity }));
    harness.events.set(runId, []);
    const state = mainState({ runId, startedAtMs: 1_000, budgetMs: 3_600_000, lastEventAt: staleActivity, eventCount: 0 });
    await harness.runtime.projectState(state);

    const call = singletonCancelCall(harness, 'main stall expiry');
    assertCancellationContext(call.context, { runId, missionId: 'MIS_RT', role: 'main', trigger: 'stall_timeout' }, 'main stall expiry');
    assert.equal(call.context.stallTimeoutMs, 2_000);
    assert.ok(call.context.idleMs >= 2_000, `idleMs must reflect the measured idle window, got ${call.context.idleMs}`);
    assert.equal(call.context.budgetMs, 3_600_000);
    assert.equal(state.agent.resourceRelease.confirmed, false);
    assert.equal(state.candidateEvaluations.length, 0);
  });

  await check('T6c main budget-and-stall expiry delivers budget_and_stall', async () => {
    const harness = createRuntimeHarness({ mainAgentStallMs: 2_000, mainAgentBudgetMs: 1_000 });
    const runId = 'claude_RT_BOTH';
    const staleActivity = Date.now() - 5_000;
    harness.runs.set(runId, runRecord({ runId, lastActivityAt: staleActivity }));
    harness.events.set(runId, []);
    const state = mainState({ runId, startedAtMs: 5_000, budgetMs: 1_000, lastEventAt: staleActivity, eventCount: 0 });
    await harness.runtime.projectState(state);

    const call = singletonCancelCall(harness, 'main budget and stall expiry');
    assertCancellationContext(call.context, { runId, missionId: 'MIS_RT', role: 'main', trigger: 'budget_and_stall' }, 'main budget and stall expiry');
    assert.equal(call.context.budgetMs, 1_000);
    assert.equal(call.context.stallTimeoutMs, 2_000);
    assert.equal(state.agent.resourceRelease.confirmed, false);
    assert.equal(state.candidateEvaluations.length, 0);
  });

  await check('T6d research automatic budget expiry delivers the research role with null stall values', async () => {
    const harness = createRuntimeHarness({ mainAgentStallMs: 900_000, mainAgentBudgetMs: 600_000 });
    const runId = 'claude_RT_RESEARCH_BUDGET';
    harness.runs.set(runId, runRecord({ runId }));
    harness.events.set(runId, []);
    const state = researchState({ runId, startedAtMs: 601_000, budgetMs: 600_000 });
    await harness.runtime.projectState(state);

    const call = singletonCancelCall(harness, 'research budget expiry');
    assertCancellationContext(call.context, { runId, missionId: 'MIS_RT', role: 'research', trigger: 'budget_exceeded' }, 'research budget expiry');
    assert.equal(call.context.budgetMs, 600_000, 'research must use its own effective budget');
    assert.ok(call.context.elapsedMs >= 600_000);
    assert.equal(call.context.stallTimeoutMs, null, 'research stall values stay null');
    assert.equal(call.context.idleMs, null, 'research stall values stay null');
    assert.equal(state.researchAgent.status, 'cancel_requested');
    assert.equal(state.researchAgent.resourceRelease.confirmed, false);
    assert.equal(state.candidateEvaluations.length, 0);
  });

  await check('T6e materializer automatic budget expiry delivers the materializer role with null stall values', async () => {
    const harness = createRuntimeHarness({ mainAgentStallMs: 900_000, mainAgentBudgetMs: 600_000 });
    const runId = 'claude_RT_MATERIALIZER_BUDGET';
    harness.runs.set(runId, runRecord({ runId }));
    harness.events.set(runId, []);
    const state = materializerState({ runId, startedAtMs: 481_000, budgetMs: 480_000 });
    await harness.runtime.projectState(state);

    const call = singletonCancelCall(harness, 'materializer budget expiry');
    assertCancellationContext(call.context, { runId, missionId: 'MIS_RT', role: 'materializer', trigger: 'budget_exceeded' }, 'materializer budget expiry');
    assert.equal(call.context.budgetMs, 480_000, 'materializer must use its own effective budget');
    assert.ok(call.context.elapsedMs >= 480_000);
    assert.equal(call.context.stallTimeoutMs, null);
    assert.equal(call.context.idleMs, null);
    assert.equal(state.baseline.materializer.status, 'cancel_requested');
    assert.equal(state.baseline.materializer.resourceRelease.confirmed, false);
  });

  // =========================================================================
  // T7 - explicit cancelRun per role
  // =========================================================================
  await check('T7 explicit cancelRun records explicit_cancel with the selected role identity', async () => {
    const scenarios = [
      { role: 'main', runId: 'claude_RT_CANCEL_MAIN', build: (runId) => mainState({ runId }), select: (state) => state.agent },
      { role: 'research', runId: 'claude_RT_CANCEL_RESEARCH', build: (runId) => researchState({ runId }), select: (state) => state.researchAgent },
      { role: 'materializer', runId: 'claude_RT_CANCEL_MATERIALIZER', build: (runId) => materializerState({ runId }), select: (state) => state.baseline.materializer },
    ];
    for (const scenario of scenarios) {
      const harness = createRuntimeHarness();
      const state = scenario.build(scenario.runId);
      await harness.runtime.cancelRun({ state, runId: scenario.runId });
      const call = singletonCancelCall(harness, `explicit ${scenario.role} cancel`);
      assert.equal(call.runId, scenario.runId);
      assertExplicitCancellationContext(call.context, { runId: scenario.runId, missionId: 'MIS_RT', role: scenario.role }, `explicit ${scenario.role} cancel`);
      assert.equal(scenario.select(state).status, 'cancel_requested', `${scenario.role} explicit cancellation must be projected as a request`);
      assert.equal(scenario.select(state).resourceRelease.confirmed, false);
    }
  });

  // =========================================================================
  // T8 - held provider cancel, single-flight, retry exhaustion, convergence
  // =========================================================================
  await check('T8 held cancel crosses the caller deadline, is reused, exhausts retries blocked and converges on release', async () => {
    const workspace = await createEmptyGitWorkspace('t8');
    let releaseProviderCancel = null;
    const harness = createRuntimeHarness({
      cancellationTimeoutMs: 60,
      mainAgentStallMs: 900_000,
      mainAgentBudgetMs: 600_000,
      cancelImpl: () => new Promise((resolve) => { releaseProviderCancel = resolve; }),
    });
    const runId = 'claude_RT_HELD';
    harness.runs.set(runId, runRecord({ runId, workspace }));
    harness.events.set(runId, []);
    const state = mainState({ runId, startedAtMs: 601_000, budgetMs: 600_000, lastEventAt: Date.now() });

    const startedAt = Date.now();
    await harness.runtime.projectState(state);
    const firstElapsed = Date.now() - startedAt;
    assert.ok(firstElapsed >= 50, `the held port must cross the caller deadline before resolving (elapsed ${firstElapsed}ms)`);
    assert.ok(firstElapsed < 5_000, `the held port must stay bounded by the cancellation deadline (elapsed ${firstElapsed}ms)`);
    assert.equal(state.agent.status, 'cancel_requested', 'a timed-out port is never treated as cancelled');
    assert.equal(state.agent.resourceRelease.confirmed, false);
    assert.ok(['pending', 'unconfirmed', 'quarantined', 'blocked'].includes(state.agent.resourceRelease.status), `timed-out release must stay unresolved, got ${state.agent.resourceRelease.status}`);
    assert.ok(typeof state.agent.resourceRelease.code === 'string' && state.agent.resourceRelease.code.length > 0, 'the bounded deadline reason stays explicit');
    singletonCancelCall(harness, 'held cancel');

    // Repeated projections must reuse the single in-flight provider call.
    await harness.runtime.projectState(state);
    await harness.runtime.projectState(state);
    assert.equal(cancelCallCount(harness), 1, 'repeated projectState must reuse the same provider cancellation call');

    // A late provider result must not mutate an already-returned snapshot.
    const snapshotBeforeLateRelease = structuredClone(state);
    releaseProviderCancel({ status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } });
    await delay(40);
    assert.deepEqual(state, snapshotBeforeLateRelease, 'a late provider completion must not mutate an earlier snapshot');
    assert.equal(cancelCallCount(harness), 1, 'a late completion must not create a replacement request');

    // Finite retry exhaustion stays blocked and quarantined.
    await harness.runtime.projectState(state);
    assert.equal(state.agent.status, 'needs_human', 'retry exhaustion must stay blocked, never confirmed');
    assert.equal(state.agent.resourceRelease.blocked, true);
    assert.equal(state.agent.resourceRelease.quarantined, true);
    assert.equal(state.agent.resourceRelease.confirmed, false);
    assert.equal(cancelCallCount(harness), 1, 'retry exhaustion must not spawn extra provider calls beyond the frozen limit');
    assert.equal(state.candidateEvaluations.length, 0, 'a blocked cancellation never admits candidates');
    assert.equal(state.stage, 'diagnosis');

    // A subsequent projection of the really released run converges without a new
    // cancellation. This preserves the existing timeout-recovery contract: a run
    // that expired and is now released converges to the retryable terminal
    // projection (`completed` with `timedOut`), not to a bare `cancelled`.
    harness.runs.set(runId, runRecord({ runId, workspace, status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } }));
    await harness.runtime.projectState(state);
    assert.equal(state.agent.resourceRelease.confirmed, true, 'a confirmed release must clear the blocked projection');
    assert.notEqual(state.agent.resourceRelease.blocked, true, 'the confirmed release must not stay blocked');
    assert.notEqual(state.agent.resourceRelease.quarantined, true, 'the confirmed release must not stay quarantined');
    assert.equal(state.agent.status, 'completed', 'the released timeout converges to the existing recovery terminal state');
    assert.equal(state.agent.timedOut, true, 'the recovered run keeps its timedOut terminal fact');
    assert.equal(cancelCallCount(harness), 1, 'a released run must not be cancelled again');
    assert.equal(state.candidateEvaluations.length, 0);
    assert.equal(state.stage, 'diagnosis');
  });
} finally {
  await cleanupRoots();
}

if (failures.length) {
  console.error(`\n[agent-run-diagnostics] ${passCount} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`\n--- ${failure.name} ---\n${failure.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n[agent-run-diagnostics] hardware-free: no live Claude CLI, model, network or GPU process was started.`);
  console.log(`[agent-run-diagnostics] ${passCount} passed, 0 failed`);
}
