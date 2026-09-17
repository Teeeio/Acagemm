// Hardware-free acceptance for the real shared-GPU observer/ledger contracts
// (`scripts/shared-gpu-acceptance.mjs`, `scripts/summarize-gpu-agent-runs.mjs`).
//
// This is a pure contract/robustness test. It never starts a Runtime, Agent,
// provider, GPU test or N=20 batch; it imports the public helpers and passes
// synthetic or already-archived objects. The archived P1 originals are read
// read-only as a second layer and the test still passes when they are absent.
//
// Authority: docs/development/P2_EVIDENCE_ACCEPTANCE.md "Deferred evidence",
// docs/development/REAL_GPU_REGRESSION.md, scripts/shared-gpu-acceptance.md.
// A passing run here proves observer/ledger classification only: it is never
// evidence of N=20 stability, a live publication or a real hardware sample.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_ATTEMPT_SCHEMA_VERSION, GPU_SUMMARY_SCHEMA_VERSION, ROUND_FACTS_SCHEMA_VERSION,
  budgetTerminalEvidence, buildConfigFingerprint, combineAttemptOutcome,
  evaluateFamilyOutcome, isRealGpuCompletedCandidate, verifyContinuationAudit,
} from '../scripts/shared-gpu-acceptance.mjs';
import {
  classifyAcceptanceRecord, readRunRecord, summarizeAcceptanceRuns,
} from '../scripts/summarize-gpu-agent-runs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');

// Frozen model-observation contract (docs/development/MODEL_OBSERVATION_ACCEPTANCE.md):
// only provider-reported assistant.message.model metadata may identify the responding
// model, and a comparable fingerprint requires that response to be explicitly observed
// with the frozen status/schema. The literals are used here because the pure production
// module is not part of this test's import graph; the independent driver/ledger matrix
// lives in tests/model-observation-acceptance-test.mjs.
const MODEL_OBSERVATION_SCHEMA_VERSION = 'operator-studio.model-observation/v1';
const OBSERVED_RESPONSE_MODEL = 'claude-sonnet-5';
const OBSERVED_RESPONSE_MISSION = 'MIS_MODEL_PROOF';
const OBSERVED_RESPONSE_RUN = 'run_model_proof';
const OBSERVED_RESPONSE_SESSION = 'sess_model_proof';

// ---------------------------------------------------------------------------
// Part A — continuation audit (P1 §14.5 observation retained)
// ---------------------------------------------------------------------------

const AUDIT_MISSION = 'MIS_GPU_AUDIT';
const AUDIT_PROJECT = 'PRJ_GPU_AUDIT';
const AUDIT_DIGEST = 'a'.repeat(64);
const AUDIT_QUEUE_REQUEST = 'run_AUDIT_QUEUE_1';
const AUDIT_SOURCE_RUN = 'run_audit_source';
const AUDIT_CONTINUATION_RUN = 'run_audit_continuation';
// A same-round recovery attempt is attributed to the candidate's persisted
// sourceRunId, which must not be silently replaced by the round's first run id.
const AUDIT_CANDIDATE_SOURCE_RUN = 'run_audit_recovery';
const AUDIT_SOURCE_ROUND = `${AUDIT_MISSION}:round:1`;
const AUDIT_TARGET_ROUND = `${AUDIT_MISSION}:round:2`;
const AUDIT_EXPERIENCE_ID = 'exp-audit-1';
const AUDIT_EXPERIENCE_VERSION = 3;
// Non-ASCII content proves the byte-length recomputation is a real UTF-8 count.
const AUDIT_EXPERIENCE_CONTENT = '消除冗余 copy：完整内容 ✓';
const AUDIT_CONTEXT_ID = `EXPCTX_${'1'.repeat(64)}`;

const promptSection = (label, value) => `----- BEGIN ${label} -----\n${JSON.stringify(value)}\n----- END ${label} -----`;

const auditRoundFacts = () => ({
  schemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  recordedAt: '2026-09-12T00:00:00.000Z',
  target: { missionId: AUDIT_MISSION, projectId: AUDIT_PROJECT, roundId: AUDIT_TARGET_ROUND },
  previous: {
    missionId: AUDIT_MISSION,
    projectId: AUDIT_PROJECT,
    runId: AUDIT_SOURCE_RUN,
    roundId: AUDIT_SOURCE_ROUND,
    candidateId: 'candidate-01',
    candidateDigest: `sha256:${AUDIT_DIGEST}`,
    queueRequestId: AUDIT_QUEUE_REQUEST,
    candidateSourceRunId: AUDIT_CANDIDATE_SOURCE_RUN,
  },
  candidate: { candidateId: 'candidate-01', digest: `sha256:${AUDIT_DIGEST}` },
  correctness: { passed: true, cases: 4 },
  failure: null,
  gate: { result: 'reference' },
  decision: { status: 'allowed' },
  rollback: { performed: true, origin: AUDIT_SOURCE_ROUND },
  currentBest: { candidateId: null, status: 'reference' },
});

const buildAuditedPrompt = ({
  facts,
  items = [{ id: AUDIT_EXPERIENCE_ID, version: AUDIT_EXPERIENCE_VERSION, content: AUDIT_EXPERIENCE_CONTENT }],
  versions = { [AUDIT_EXPERIENCE_ID]: AUDIT_EXPERIENCE_VERSION },
  contextId = AUDIT_CONTEXT_ID,
} = {}) => [
  '优化 GPU 算子；以下是预发送审计输入。',
  promptSection('UNTRUSTED EXPERIENCE DATA', { contextId, versions, items }),
  '只使用冻结事实，不要重新推导。',
  promptSection('MISSION ITERATION CONTEXT', facts),
  '只修改 run.py。',
].join('\n');

const auditScenario = () => {
  const roundFacts = auditRoundFacts();
  const prompt = buildAuditedPrompt({ facts: roundFacts });
  return {
    missionId: AUDIT_MISSION,
    projectId: AUDIT_PROJECT,
    audit: {
      schemaVersion: 'operator-studio.prompt-audit/v1',
      deliveryStage: 'prepared-before-send',
      missionId: AUDIT_MISSION,
      projectId: AUDIT_PROJECT,
      roundId: AUDIT_TARGET_ROUND,
      runId: AUDIT_CONTINUATION_RUN,
      prompt,
      promptDigest: `sha256:${sha256(prompt)}`,
      promptBytes: utf8Bytes(prompt),
      roundFacts,
      selection: {
        contextId: AUDIT_CONTEXT_ID,
        selected: [{ id: AUDIT_EXPERIENCE_ID, version: AUDIT_EXPERIENCE_VERSION, source: 'execution' }],
      },
    },
    sourceRound: {
      roundId: AUDIT_SOURCE_ROUND,
      runId: AUDIT_SOURCE_RUN,
      candidateId: 'candidate-01',
      candidateDigest: `sha256:${AUDIT_DIGEST}`,
      queueRequestId: AUDIT_QUEUE_REQUEST,
      candidateSourceRunId: AUDIT_CANDIDATE_SOURCE_RUN,
      decisionReview: { resolution: { outcome: 'reference' } },
      roundFacts,
    },
    experiences: [{
      id: AUDIT_EXPERIENCE_ID,
      version: AUDIT_EXPERIENCE_VERSION,
      source: 'execution',
      content: AUDIT_EXPERIENCE_CONTENT,
      evidence: {
        missionId: AUDIT_MISSION,
        candidateId: 'candidate-01',
        patchDigest: `sha256:${AUDIT_DIGEST}`,
        runId: AUDIT_QUEUE_REQUEST,
      },
    }],
  };
};

const setPrompt = (scenario, prompt) => {
  scenario.audit.prompt = prompt;
  // Recompute the sidecar so a prompt-vs-facts assertion is what actually fails.
  scenario.audit.promptDigest = `sha256:${sha256(prompt)}`;
  scenario.audit.promptBytes = utf8Bytes(prompt);
};

const expectAuditRejected = (label, mutate) => {
  const scenario = auditScenario();
  mutate(scenario);
  assert.throws(() => verifyContinuationAudit(scenario), label);
};

{
  const scenario = auditScenario();
  const summary = verifyContinuationAudit(scenario);
  assert.equal(summary.roundId, AUDIT_TARGET_ROUND);
  assert.equal(summary.runId, AUDIT_CONTINUATION_RUN);
  assert.equal(summary.promptDigest, `sha256:${sha256(scenario.audit.prompt)}`);
  assert.equal(summary.promptBytes, utf8Bytes(scenario.audit.prompt));
  assert.notEqual(summary.promptBytes, scenario.audit.prompt.length,
    'the audit must recompute UTF-8 bytes, not a character count');
  assert.equal(summary.selectedExperience.id, AUDIT_EXPERIENCE_ID);
  assert.equal(summary.selectedExperience.version, AUDIT_EXPERIENCE_VERSION);
  assert.equal(summary.selectedExperience.evidenceRunId, AUDIT_QUEUE_REQUEST);
  assert.equal(summary.selectedExperience.evidencePatchDigest, `sha256:${AUDIT_DIGEST}`);
  assert.equal(summary.facts.previousQueueRequestId, AUDIT_QUEUE_REQUEST);
  assert.equal(summary.facts.gateResult, 'reference');
  assert.ok(summary.assertions.length > 0, 'the retained P1 assertion list must be reported');
}

// Exact frozen round selection: round 1's verified candidate, round 2's pre-send audit.
expectAuditRejected('audit round must not be the source round itself', (s) => { s.audit.roundId = AUDIT_SOURCE_ROUND; });
expectAuditRejected('a third-round audit must not satisfy the frozen target round', (s) => { s.audit.roundId = `${AUDIT_MISSION}:round:3`; });
expectAuditRejected('audit facts target round must match the audit round', (s) => { s.audit.roundFacts.target.roundId = `${AUDIT_MISSION}:round:3`; });
expectAuditRejected('a same-round recovery run must not count as the continuation run', (s) => { s.audit.runId = AUDIT_SOURCE_RUN; });
expectAuditRejected('source archive without a frozen target round must fail', (s) => {
  s.sourceRound.roundFacts = { ...s.sourceRound.roundFacts, target: { ...s.sourceRound.roundFacts.target, roundId: undefined } };
});
expectAuditRejected('audit without frozen facts must fail', (s) => { s.audit.roundFacts = null; });
expectAuditRejected('missing prepared-before-send stage must fail', (s) => { s.audit.deliveryStage = 'sent'; });
expectAuditRejected('foreign audit mission binding must fail', (s) => { s.audit.missionId = 'MIS_OTHER'; });
expectAuditRejected('audit facts target mission must bind to the expected mission', (s) => { s.audit.roundFacts.target.missionId = 'MIS_OTHER'; });
expectAuditRejected('parent-round facts must deep-equal the frozen source archive', (s) => {
  s.sourceRound.roundFacts = { ...s.sourceRound.roundFacts, gate: { result: 'reject' } };
});
expectAuditRejected('the source archive outcome must match the frozen gate fact', (s) => {
  s.sourceRound.decisionReview.resolution.outcome = 'reject';
});

// Independently recomputed identity of the audited prompt.
expectAuditRejected('tampered prompt digest must fail', (s) => { s.audit.promptDigest = `sha256:${'0'.repeat(64)}`; });
expectAuditRejected('tampered UTF-8 byte length must fail', (s) => { s.audit.promptBytes = s.audit.prompt.length; });

// Candidate / durable queue binding frozen in the facts.
expectAuditRejected('frozen candidate digest mismatch must fail', (s) => { s.audit.roundFacts.previous.candidateDigest = `sha256:${'b'.repeat(64)}`; });
expectAuditRejected('frozen queue request id mismatch must fail', (s) => { s.audit.roundFacts.previous.queueRequestId = 'run_OTHER'; });
expectAuditRejected('frozen previous round id mismatch must fail', (s) => { s.audit.roundFacts.previous.roundId = `${AUDIT_MISSION}:round:0`; });
expectAuditRejected('candidate source run must not be re-attributed', (s) => { s.audit.roundFacts.previous.candidateSourceRunId = 'run_OTHER_RECOVERY'; });

// Experience identity/content and the candidate/queue-bound selection.
expectAuditRejected('a non-execution experience can never bind', (s) => { s.experiences[0].source = 'baseline'; });
expectAuditRejected('an experience bound to another mission can never bind', (s) => { s.experiences[0].evidence.missionId = 'MIS_OTHER'; });
expectAuditRejected('an experience bound to another candidate can never bind', (s) => { s.experiences[0].evidence.candidateId = 'candidate-99'; });
expectAuditRejected('an experience with a mismatched patch digest can never bind', (s) => { s.experiences[0].evidence.patchDigest = `sha256:${'c'.repeat(64)}`; });
expectAuditRejected('an experience bound to another queue run can never bind', (s) => { s.experiences[0].evidence.runId = 'run_OTHER'; });
expectAuditRejected('a missing source-round experience must fail', (s) => { s.experiences = []; });
expectAuditRejected('two experiences matching one candidate/queue binding must fail', (s) => {
  s.experiences.push({ ...structuredClone(s.experiences[0]), id: 'exp-duplicate' });
});
expectAuditRejected('selection omitting the bound experience must fail', (s) => { s.audit.selection.selected = []; });
expectAuditRejected('selection version mismatch must fail', (s) => { s.audit.selection.selected[0].version = AUDIT_EXPERIENCE_VERSION + 1; });
expectAuditRejected('prompt omitting the bound experience must fail', (s) => {
  setPrompt(s, buildAuditedPrompt({ facts: s.audit.roundFacts, items: [{ id: 'exp-other', version: 1, content: 'x' }] }));
});
expectAuditRejected('prompt experience version mismatch must fail', (s) => {
  setPrompt(s, buildAuditedPrompt({ facts: s.audit.roundFacts, items: [{ id: AUDIT_EXPERIENCE_ID, version: AUDIT_EXPERIENCE_VERSION + 1, content: AUDIT_EXPERIENCE_CONTENT }] }));
});
expectAuditRejected('prompt truncating the experience content must fail', (s) => {
  setPrompt(s, buildAuditedPrompt({ facts: s.audit.roundFacts, items: [{ id: AUDIT_EXPERIENCE_ID, version: AUDIT_EXPERIENCE_VERSION, content: '消除冗余 copy' }] }));
});
expectAuditRejected('prompt carrying the bound experience twice must fail', (s) => {
  setPrompt(s, buildAuditedPrompt({
    facts: s.audit.roundFacts,
    items: [
      { id: AUDIT_EXPERIENCE_ID, version: AUDIT_EXPERIENCE_VERSION, content: AUDIT_EXPERIENCE_CONTENT },
      { id: AUDIT_EXPERIENCE_ID, version: AUDIT_EXPERIENCE_VERSION, content: AUDIT_EXPERIENCE_CONTENT },
    ],
  }));
});
expectAuditRejected('prompt context id must match the audited selection', (s) => {
  setPrompt(s, buildAuditedPrompt({ facts: s.audit.roundFacts, contextId: 'EXPCTX_other' }));
});
expectAuditRejected('prompt version map must agree with the bound version', (s) => {
  setPrompt(s, buildAuditedPrompt({ facts: s.audit.roundFacts, versions: { [AUDIT_EXPERIENCE_ID]: AUDIT_EXPERIENCE_VERSION + 1 } }));
});
expectAuditRejected('prompt facts disagreeing with the sidecar must fail', (s) => {
  const wrong = structuredClone(s.audit.roundFacts);
  wrong.gate.result = 'reject';
  setPrompt(s, buildAuditedPrompt({ facts: wrong }));
});
expectAuditRejected('prompt facts with a wrong target round must fail', (s) => {
  const wrong = structuredClone(s.audit.roundFacts);
  wrong.target.roundId = `${AUDIT_MISSION}:round:9`;
  setPrompt(s, buildAuditedPrompt({ facts: wrong }));
});

// Second layer (optional, read-only): replay the archived P1 originals. The
// gate must not depend on these files; when present they must verify unchanged.
const p1Root = path.join(root, 'docs/development/evidence/p1-feedback-20260912');
const p1AuditPath = path.join(p1Root, 'bridge/prompt-audits/claude_MTY3D3AA_C95A6106.json');
const p1ExperiencesPath = path.join(p1Root, 'runtime/experiences/experiences.json');
if (existsSync(p1AuditPath) && existsSync(p1ExperiencesPath)) {
  const archivedAudit = JSON.parse(await readFile(p1AuditPath, 'utf8'));
  const archivedExperiences = JSON.parse(await readFile(p1ExperiencesPath, 'utf8')).records;
  const archivedFacts = archivedAudit.roundFacts;
  const archivedSourceRound = {
    roundId: archivedFacts.previous.roundId,
    runId: archivedFacts.previous.runId,
    candidateId: archivedFacts.previous.candidateId,
    candidateDigest: archivedFacts.previous.candidateDigest,
    queueRequestId: archivedFacts.previous.queueRequestId,
    candidateSourceRunId: archivedFacts.previous.candidateSourceRunId,
    decisionReview: { resolution: { outcome: archivedFacts.gate.result } },
    roundFacts: archivedFacts,
  };
  const replayed = verifyContinuationAudit({
    audit: archivedAudit,
    sourceRound: archivedSourceRound,
    experiences: archivedExperiences,
    missionId: archivedAudit.missionId,
    projectId: archivedAudit.projectId,
  });
  assert.equal(replayed.promptDigest, `sha256:${sha256(archivedAudit.prompt)}`);
  assert.equal(replayed.promptBytes, utf8Bytes(archivedAudit.prompt));
  assert.equal(replayed.facts.previousQueueRequestId, archivedFacts.previous.queueRequestId);

  const digestTampered = structuredClone(archivedAudit);
  digestTampered.promptDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyContinuationAudit({
    audit: digestTampered, sourceRound: archivedSourceRound, experiences: archivedExperiences,
    missionId: archivedAudit.missionId, projectId: archivedAudit.projectId,
  }), 'archived prompt digest tampering must fail');

  const boundExperience = archivedExperiences.find((item) => item.id === archivedAudit.selection.selected[0].id);
  const contentTampered = structuredClone(archivedAudit);
  contentTampered.prompt = contentTampered.prompt.replace('Bound execution test: passed', 'Bound execution test: FAILED');
  contentTampered.promptDigest = `sha256:${sha256(contentTampered.prompt)}`;
  contentTampered.promptBytes = utf8Bytes(contentTampered.prompt);
  assert.notEqual(contentTampered.prompt, archivedAudit.prompt);
  assert.ok(boundExperience, 'archived selection must point at a retained experience record');
  assert.throws(() => verifyContinuationAudit({
    audit: contentTampered, sourceRound: archivedSourceRound, experiences: archivedExperiences,
    missionId: archivedAudit.missionId, projectId: archivedAudit.projectId,
  }), 'archived prompt content tampering must fail');

  console.log('[shared-gpu-acceptance] archived P1 audit replayed read-only');
} else {
  console.log('[shared-gpu-acceptance] archived P1 audit absent; read-only replay layer skipped');
}

// ---------------------------------------------------------------------------
// Part B — safe budget terminal and family outcome
// ---------------------------------------------------------------------------

const MISSION = 'MIS_BUDGET';
const RUN = 'run_budget_1';

const confirmedRelease = (overrides = {}) => ({
  confirmed: true, status: 'released', missionId: MISSION, runId: RUN, ...overrides,
});

const budgetState = ({
  loopStatus = 'needs_human', reason = 'round_budget', agentStatus = null,
  resourceRelease = confirmedRelease(), missionRelease, runtimeEvents = [],
  activeMissionId = MISSION, agentRunId = RUN,
} = {}) => ({
  activeMissionId,
  agent: { runId: agentRunId, ...(agentStatus ? { status: agentStatus } : {}), resourceRelease },
  ...(missionRelease === undefined ? {} : { workflowRecovery: { resourceRelease: missionRelease } }),
  iterationStats: { ...(loopStatus ? { loopStatus } : {}), ...(reason ? { loopStatusReason: reason } : {}) },
  runtimeEvents,
});

{
  const evidence = budgetTerminalEvidence(budgetState(), { missionId: MISSION, runId: RUN });
  assert.equal(evidence.safe, true);
  assert.equal(evidence.terminal, true);
  assert.equal(evidence.budgetReasonRecorded, true);
  assert.equal(evidence.resourceReleaseConfirmed, true);
  assert.deepEqual(evidence.issues, []);
  assert.deepEqual(evidence.budgetEvents, []);
}

{
  // A terminal Agent status is never release proof, and a non-budget current
  // reason is authoritative over any historical budget event.
  const cases = [
    ['missing release projection', budgetState({ resourceRelease: null }), 'resource_release_not_confirmed'],
    ['unconfirmed release', budgetState({ resourceRelease: confirmedRelease({ confirmed: false }) }), 'resource_release_not_confirmed'],
    ['pending release', budgetState({ resourceRelease: confirmedRelease({ status: 'pending' }) }), 'resource_release_not_confirmed'],
    ['quarantined release', budgetState({ resourceRelease: confirmedRelease({ status: 'quarantined' }) }), 'resource_release_not_confirmed'],
    ['blocked release', budgetState({ resourceRelease: confirmedRelease({ status: 'blocked' }) }), 'resource_release_not_confirmed'],
    ['foreign-bound release', budgetState({ resourceRelease: confirmedRelease({ missionId: 'MIS_OTHER' }) }), 'resource_release_not_confirmed'],
    ['mission projection pending', budgetState({ missionRelease: { confirmed: true, status: 'pending', missionId: MISSION, runId: RUN } }), 'resource_release_not_confirmed'],
    ['bare needs_human without a budget reason', budgetState({ reason: null }), 'budget_reason_not_recorded'],
    ['agent-only needs_human is not budget proof', budgetState({ loopStatus: null, reason: null, agentStatus: 'needs_human' }), 'budget_reason_not_recorded'],
    ['non-budget reason wins over a current budget event', budgetState({
      reason: 'generation_failure',
      runtimeEvents: [{ type: 'loop.round_budget_exceeded', payload: { missionId: MISSION, runId: RUN } }],
    }), 'current_reason_not_budget'],
    ['round_budget_invalid is not a bounded-budget reason', budgetState({ reason: 'round_budget_invalid' }), 'current_reason_not_budget'],
    ['historical other-run budget event', budgetState({
      reason: null,
      runtimeEvents: [{ type: 'loop.round_budget_exceeded', payload: { missionId: MISSION, runId: 'run_other' } }],
    }), 'budget_reason_not_recorded'],
    ['unbound historical budget event', budgetState({
      reason: null,
      runtimeEvents: [{ type: 'loop.round_budget_exceeded', payload: {} }],
    }), 'budget_reason_not_recorded'],
  ];
  for (const [label, state, issue] of cases) {
    const evidence = budgetTerminalEvidence(state, { missionId: MISSION, runId: RUN });
    assert.equal(evidence.safe, false, `${label} must not be a safe budget terminal`);
    assert.ok(evidence.issues.includes(issue), `${label} must report ${issue} (got ${evidence.issues.join(',')})`);
  }

  // The underlying release projection reports the exact blocking reason.
  const pendingRelease = budgetTerminalEvidence(
    budgetState({ resourceRelease: confirmedRelease({ status: 'pending' }) }), { missionId: MISSION, runId: RUN });
  assert.ok(pendingRelease.resourceRelease.issues.includes('agent_release_pending'));
  const blockedByMission = budgetTerminalEvidence(
    budgetState({ missionRelease: { confirmed: true, status: 'pending', missionId: MISSION, runId: RUN } }), { missionId: MISSION, runId: RUN });
  assert.ok(blockedByMission.resourceRelease.issues.includes('mission_release_pending'));
  const foreignRelease = budgetTerminalEvidence(
    budgetState({ resourceRelease: confirmedRelease({ missionId: 'MIS_OTHER' }) }), { missionId: MISSION, runId: RUN });
  assert.ok(foreignRelease.resourceRelease.issues.includes('resource_release_binding_unconfirmed'));
  const noRelease = budgetTerminalEvidence(budgetState({ resourceRelease: null }), { missionId: MISSION, runId: RUN });
  assert.ok(noRelease.resourceRelease.issues.includes('explicit_release_confirmation_missing'));

  const foreignEvent = budgetTerminalEvidence(budgetState({
    reason: null,
    runtimeEvents: [{ type: 'loop.round_budget_exceeded', payload: { missionId: MISSION, runId: 'run_other' } }],
  }), { missionId: MISSION, runId: RUN });
  assert.deepEqual(foreignEvent.budgetEvents, [], 'budget events bound to another run are historical');

  const unboundEvent = budgetTerminalEvidence(budgetState({
    reason: null,
    runtimeEvents: [{ type: 'loop.round_budget_exceeded', payload: {} }],
  }), { missionId: MISSION, runId: RUN });
  assert.deepEqual(unboundEvent.budgetEvents, [], 'unbound events are never current-run evidence');

  const mismatchedBinding = budgetTerminalEvidence(budgetState(), { missionId: 'MIS_OTHER', runId: RUN });
  assert.equal(mismatchedBinding.safe, false, 'release must belong to the current Mission');
  const mismatchedRun = budgetTerminalEvidence(budgetState(), { missionId: MISSION, runId: 'run_other' });
  assert.equal(mismatchedRun.safe, false, 'release must belong to the current Agent run');
}

{
  // Unresolved quarantine fails closed; the current confirmed projection or a
  // later matching resolution event resolves it, historical quarantine does not poison.
  const quarantinedAt = '2026-09-12T00:00:00.000Z';
  const quarantine = { type: 'loop.resource_release_quarantined', payload: { missionId: MISSION, runId: RUN, at: quarantinedAt } };
  const unresolved = budgetTerminalEvidence(budgetState({ resourceRelease: null, runtimeEvents: [quarantine] }), { missionId: MISSION, runId: RUN });
  assert.equal(unresolved.safe, false);
  assert.equal(unresolved.resourceRelease.quarantined, true);
  assert.ok(unresolved.resourceRelease.issues.includes('resource_release_quarantined'));

  const resolved = budgetTerminalEvidence(budgetState({
    resourceRelease: null,
    runtimeEvents: [quarantine, { type: 'loop.resource_release_resolved', payload: { missionId: MISSION, runId: RUN, at: '2026-09-12T00:10:00.000Z' } }],
  }), { missionId: MISSION, runId: RUN });
  assert.equal(resolved.resourceRelease.quarantined, false, 'a later matching resolution event clears the quarantine');
  assert.equal(resolved.safe, false, 'clearing quarantine is not release confirmation');

  const foreignQuarantine = budgetTerminalEvidence(budgetState({
    runtimeEvents: [{ type: 'loop.resource_release_quarantined', payload: { missionId: 'MIS_OTHER', runId: 'run_other', at: quarantinedAt } }],
  }), { missionId: MISSION, runId: RUN });
  assert.equal(foreignQuarantine.safe, true, 'historical foreign quarantine never poisons the current mission');
  assert.equal(foreignQuarantine.resourceRelease.quarantined, false);

  const projectionResolved = budgetTerminalEvidence(budgetState({ runtimeEvents: [quarantine] }), { missionId: MISSION, runId: RUN });
  assert.equal(projectionResolved.safe, true, 'the current confirmed projection resolves a current quarantine');
}

{
  // Positive variants: total_budget, budget_exhausted status and a current-bound
  // runtime event with no reason all reach a safe terminal with a real release.
  const totalBudget = budgetTerminalEvidence(budgetState({ reason: 'total_budget' }), { missionId: MISSION, runId: RUN });
  assert.equal(totalBudget.safe, true);
  const exhausted = budgetTerminalEvidence(budgetState({ loopStatus: 'budget_exhausted', reason: null }), { missionId: MISSION, runId: RUN });
  assert.equal(exhausted.safe, true);
  const eventOnly = budgetTerminalEvidence(budgetState({
    reason: null,
    runtimeEvents: [{ type: 'loop.round_budget_exceeded', payload: { missionId: MISSION, runId: RUN } }],
  }), { missionId: MISSION, runId: RUN });
  assert.equal(eventOnly.safe, true);
  assert.deepEqual(eventOnly.budgetEvents, ['loop.round_budget_exceeded']);
}

// --- family outcome -------------------------------------------------------

const realGpuTask = (digest, index) => ({
  status: 'completed',
  payload: {
    purpose: 'candidate',
    requestId: `run_REQ_${index}`,
    missionId: MISSION,
    candidate: { id: `candidate-0${index}`, digest: `sha256:${digest}` },
  },
  result: {
    environment: {
      source: 'local-shared-gpu', executionMode: 'gpu', liveHardware: true,
      simulated: false, mock: false, publishable: false,
      candidateDigest: `sha256:${digest}`, runId: `run_REQ_${index}`,
    },
  },
});

const DIGEST_ONE = '1'.repeat(64);
const DIGEST_TWO = '2'.repeat(64);
const cleanRollback = [{ payload: { workspaceClean: true } }];

{
  const positive = evaluateFamilyOutcome({
    desiredTasks: 2,
    completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)],
    budgetTerminal: null,
    continuationAudit: { runId: 'run_continuation' },
    rollbackEvents: cleanRollback,
  });
  assert.equal(positive.outcome, 'full_success');
  assert.equal(positive.fullSuccess, true);
  assert.deepEqual(positive.reasons, []);
}

{
  const failures = [
    ['fewer than two rounds requested', { desiredTasks: 1, completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)], continuationAudit: {}, rollbackEvents: cleanRollback }, 'full_two_round_success_required'],
    ['only one completed candidate', { desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1)], continuationAudit: {}, rollbackEvents: cleanRollback }, 'fewer_than_two_completed_candidates'],
    ['two candidates sharing one digest', { desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_ONE, 2)], continuationAudit: {}, rollbackEvents: cleanRollback }, 'completed_candidates_not_distinct'],
    ['missing continuation audit', { desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)], continuationAudit: null, rollbackEvents: cleanRollback }, 'continuation_audit_missing'],
    ['missing rollback evidence', { desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)], continuationAudit: {}, rollbackEvents: [] }, 'rollback_evidence_missing'],
    ['unclean rollback workspace', { desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)], continuationAudit: {}, rollbackEvents: [{ payload: { workspaceClean: false } }] }, 'rollback_workspace_not_clean'],
  ];
  for (const [label, input, reason] of failures) {
    const result = evaluateFamilyOutcome(input);
    assert.equal(result.outcome, 'failure', `${label} must fail`);
    assert.ok(result.reasons.includes(reason), `${label} must report ${reason} (got ${result.reasons.join(',')})`);
  }

  const withExistingFailure = evaluateFamilyOutcome({
    desiredTasks: 2,
    completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)],
    continuationAudit: {},
    rollbackEvents: cleanRollback,
    reasons: ['operator_test_failed'],
  });
  assert.equal(withExistingFailure.outcome, 'failure');
  assert.ok(withExistingFailure.reasons.includes('operator_test_failed'), 'existing failures are never hidden');

  const withInvalidCandidate = evaluateFamilyOutcome({
    desiredTasks: 2,
    completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2), { status: 'failed' }],
    continuationAudit: {},
    rollbackEvents: cleanRollback,
  });
  assert.equal(withInvalidCandidate.outcome, 'failure');
  assert.ok(withInvalidCandidate.reasons.includes('candidate_not_completed_real_gpu'));
}

{
  // Every field of the real backend task binding is required.
  const mutations = [
    ['non-completed status', (t) => { t.status = 'failed'; }],
    ['wrong task purpose', (t) => { t.payload.purpose = 'baseline'; }],
    ['missing durable request id', (t) => { delete t.payload.requestId; }],
    ['missing candidate id', (t) => { delete t.payload.candidate.id; }],
    ['non-GPU source', (t) => { t.result.environment.source = 'cpu'; }],
    ['non-GPU execution mode', (t) => { t.result.environment.executionMode = 'cpu'; }],
    ['missing live hardware', (t) => { t.result.environment.liveHardware = false; }],
    ['simulated environment', (t) => { t.result.environment.simulated = true; }],
    ['mocked environment', (t) => { t.result.environment.mock = true; }],
    ['mismatched environment digest', (t) => { t.result.environment.candidateDigest = `sha256:${'9'.repeat(64)}`; }],
    ['mismatched payload digest', (t) => { t.payload.candidate.digest = `sha256:${'9'.repeat(64)}`; }],
    ['environment run id does not match the request id', (t) => { t.result.environment.runId = 'run_OTHER'; }],
    ['missing environment', (t) => { delete t.result.environment; }],
  ];
  for (const [label, mutate] of mutations) {
    const task = realGpuTask(DIGEST_ONE, 1);
    mutate(task);
    assert.equal(isRealGpuCompletedCandidate(task), false, `${label} must not be a real GPU completed candidate`);
  }
  assert.equal(isRealGpuCompletedCandidate(realGpuTask(DIGEST_ONE, 1)), true);
}

{
  const safeEvidence = budgetTerminalEvidence(budgetState(), { missionId: MISSION, runId: RUN });
  const budgetOutcome = evaluateFamilyOutcome({
    desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1)], budgetTerminal: safeEvidence,
  });
  assert.equal(budgetOutcome.outcome, 'budget_terminal');
  assert.equal(budgetOutcome.fullSuccess, false);
  assert.deepEqual(budgetOutcome.reasons, ['bounded_budget_terminal']);

  const hiddenFailure = evaluateFamilyOutcome({
    desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1)], budgetTerminal: safeEvidence, reasons: ['generation_failure'],
  });
  assert.equal(hiddenFailure.outcome, 'failure', 'a contradictory stop is a failure, never a safe terminal');
  assert.ok(hiddenFailure.reasons.includes('generation_failure'));

  const bareFlag = evaluateFamilyOutcome({
    desiredTasks: 2,
    completedTasks: [realGpuTask(DIGEST_ONE, 1), realGpuTask(DIGEST_TWO, 2)],
    budgetTerminal: true,
    continuationAudit: {},
    rollbackEvents: cleanRollback,
  });
  assert.equal(bareFlag.outcome, 'failure', 'a bare truthy budget flag is never accepted');
  assert.ok(bareFlag.reasons.includes('budget_terminal_evidence_not_safe'));

  const unsafeEvidence = evaluateFamilyOutcome({
    desiredTasks: 2, completedTasks: [realGpuTask(DIGEST_ONE, 1)],
    budgetTerminal: { ...safeEvidence, issues: ['resource_release_not_confirmed'] },
  });
  assert.equal(unsafeEvidence.outcome, 'failure');
  assert.ok(unsafeEvidence.reasons.includes('budget_terminal_evidence_not_safe'));
}

{
  assert.equal(combineAttemptOutcome({ familyOutcomes: ['full_success', 'full_success'] }), 'full_success');
  assert.equal(combineAttemptOutcome({ familyOutcomes: ['full_success', 'budget_terminal'] }), 'budget_terminal');
  assert.equal(combineAttemptOutcome({ familyOutcomes: ['budget_terminal', 'budget_terminal'] }), 'budget_terminal');
  assert.equal(combineAttemptOutcome({ familyOutcomes: ['full_success', 'failure'] }), 'failure');
  assert.equal(combineAttemptOutcome({ familyOutcomes: [] }), 'failure');
  assert.equal(combineAttemptOutcome({ failure: { message: 'x' }, familyOutcomes: ['full_success'] }), 'failure');
  assert.equal(combineAttemptOutcome({ failure: { message: 'x' }, timedOut: true, familyOutcomes: ['full_success'] }), 'timeout');
}

// ---------------------------------------------------------------------------
// Part C — run ledger and configuration fingerprint
// ---------------------------------------------------------------------------

const baseAcceptanceConfig = () => ({
  provider: {
    runtime: 'claude-code', cliVersion: '1.2.3', cliVersionSource: 'runtime-descriptor',
    model: OBSERVED_RESPONSE_MODEL, modelSource: 'observed',
    // Explicit actual-response observation proof: the provider-reported
    // assistant.message.model response, observed under the frozen schema/status.
    modelObservationStatus: 'observed', modelObservationVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
  },
  backend: { kind: 'local-shared-gpu', executionMode: 'gpu', publishable: false },
  hardware: ['nvidia-gpu'],
  architecture: ['sm86'],
  device: 'NVIDIA GeForce RTX 3060 Laptop GPU',
  driverVersion: '555.99',
  families: ['affine'],
  candidateTasks: 2,
  matrix: { environments: ['local-shared-gpu'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 4, warmup: 3, repeats: 10 },
  promptPolicy: { experienceSelectionPolicyVersion: 'operator-studio.experience-selection/v1', roundFactsSchemaVersion: ROUND_FACTS_SCHEMA_VERSION },
  budgets: { missionBudgetMs: 720_000, mainAgentBudgetMs: 180_000 },
  code: { commit: 'a'.repeat(40), dirty: false, contentDigest: `sha256:${'b'.repeat(64)}` },
});

// Explicit per-required-run response observation evidence. The provider labels in
// `config.provider` are derived from this summary; the per-run DTOs and required-run
// list stay at the attempt/summary top level, outside the config hash.
const observedResponseProof = () => ({
  modelObservations: [{
    schemaVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
    provider: 'claude-code',
    runId: OBSERVED_RESPONSE_RUN,
    missionId: OBSERVED_RESPONSE_MISSION,
    sessionId: OBSERVED_RESPONSE_SESSION,
    status: 'observed',
    model: OBSERVED_RESPONSE_MODEL,
    source: 'assistant.message.model',
    models: [OBSERVED_RESPONSE_MODEL],
    configuredModels: ['claude-opus-5[1m]'],
    usageModels: ['claude-opus-5[1m]'],
    observations: [{ eventIndex: 1, sessionId: OBSERVED_RESPONSE_SESSION, model: OBSERVED_RESPONSE_MODEL }],
    reasons: [],
  }],
  modelObservationRequiredRuns: [{
    provider: 'claude-code', runId: OBSERVED_RESPONSE_RUN,
    missionId: OBSERVED_RESPONSE_MISSION, sessionId: OBSERVED_RESPONSE_SESSION,
  }],
  modelObservationSummary: {
    schemaVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
    status: 'observed',
    model: OBSERVED_RESPONSE_MODEL,
    modelSource: 'observed',
    models: [OBSERVED_RESPONSE_MODEL],
    requiredRunCount: 1,
    observedRunCount: 1,
    reasons: [],
  },
});

const fullSuccessRecord = (index, { config = baseAcceptanceConfig(), runDir = null, attemptId = null } = {}) => {
  const id = attemptId || `attempt-${index}`;
  const dir = runDir || `C:/retained/gpu-run-${index}`;
  const fingerprint = buildConfigFingerprint(config, { code: config.code }).fingerprint;
  const familyOutcome = { family: 'affine', outcome: 'full_success', fullSuccess: true };
  const proof = observedResponseProof();
  return {
    runDir: dir,
    attempt: {
      schemaVersion: GPU_ATTEMPT_SCHEMA_VERSION, attemptId: id, runRoot: dir,
      phase: 'terminal', status: 'terminal', outcome: 'full_success', fullSuccess: true,
      config, code: config.code, configFingerprint: fingerprint,
      families: ['affine'], candidateTasks: 2, familyOutcomes: [{ ...familyOutcome }],
      ...proof,
    },
    summary: {
      schemaVersion: GPU_SUMMARY_SCHEMA_VERSION, status: 'passed', outcome: 'full_success', fullSuccess: true,
      config, code: config.code, configFingerprint: fingerprint, families: ['affine'],
      summaries: [{ ...familyOutcome }],
      ...proof,
    },
  };
};

const terminalRecord = (index, { outcome, status, familyOutcome, config = baseAcceptanceConfig() } = {}) => {
  const record = fullSuccessRecord(index, { config });
  record.attempt.outcome = outcome;
  record.attempt.fullSuccess = false;
  record.summary.outcome = outcome;
  record.summary.fullSuccess = false;
  record.summary.status = status;
  record.attempt.familyOutcomes = [{ ...familyOutcome }];
  record.summary.summaries = [{ ...familyOutcome }];
  return record;
};

// Fingerprint normalization: per-run identifiers never split or pool a group.
{
  const withRunIds = (suffix) => ({
    ...baseAcceptanceConfig(),
    runId: `run-${suffix}`, missionId: `mission-${suffix}`, sourceRunId: `source-${suffix}`,
    observedTargets: [{ family: 'affine', runId: `observed-${suffix}` }],
    startedAt: `2026-09-12T0${suffix}:00:00.000Z`,
  });
  const configA = withRunIds('1');
  const configB = withRunIds('2');
  const fingerprintA = buildConfigFingerprint(configA, { code: configA.code });
  const fingerprintB = buildConfigFingerprint(configB, { code: configB.code });
  assert.equal(fingerprintA.fingerprint, fingerprintB.fingerprint, 'per-run identifiers must be stripped before hashing');
  assert.deepEqual(fingerprintA.unknownFields, []);
  assert.equal(fingerprintA.comparable, true);

  const ledger = summarizeAcceptanceRuns([
    fullSuccessRecord(1, { config: configA }),
    fullSuccessRecord(2, { config: configB }),
  ]);
  assert.equal(ledger.groups.length, 1, 'the same configuration observed in two runs is one group');
  assert.equal(ledger.groups[0].counts.runs, 2);

  const changedCode = baseAcceptanceConfig();
  changedCode.code = { ...changedCode.code, contentDigest: `sha256:${'c'.repeat(64)}` };
  assert.notEqual(buildConfigFingerprint(changedCode, { code: changedCode.code }).fingerprint, fingerprintA.fingerprint,
    'a changed source content digest must change the fingerprint');
  const changedCommit = baseAcceptanceConfig();
  changedCommit.code = { ...changedCommit.code, commit: 'd'.repeat(40) };
  assert.notEqual(buildConfigFingerprint(changedCommit, { code: changedCommit.code }).fingerprint, fingerprintA.fingerprint,
    'a changed commit must change the fingerprint');
}

// Nested / unobserved / declared fields keep a group non-comparable.
{
  const nestedUnknown = baseAcceptanceConfig();
  nestedUnknown.matrix = { ...nestedUnknown.matrix, note: null };
  const emptyContainer = baseAcceptanceConfig();
  emptyContainer.matrix = {};
  const declaredModel = baseAcceptanceConfig();
  declaredModel.provider = { ...declaredModel.provider, modelSource: 'declared' };
  const envCli = baseAcceptanceConfig();
  envCli.provider = { ...envCli.provider, cliVersionSource: 'env' };
  const unknownModel = baseAcceptanceConfig();
  unknownModel.provider = { ...unknownModel.provider, model: 'unknown' };
  const missingBudget = baseAcceptanceConfig();
  missingBudget.budgets = { missionBudgetMs: 720_000, mainAgentBudgetMs: null };

  const cases = [
    ['nested null inside the matrix', nestedUnknown, 'matrix'],
    ['empty matrix container', emptyContainer, 'matrix'],
    ['declared (env/configured) model', declaredModel, 'provider.model:declared'],
    ['declared (env) CLI version', envCli, 'provider.cliVersion:env'],
    ['unobservable model', unknownModel, 'provider.model'],
    ['missing budget field', missingBudget, 'budgets.mainAgentBudgetMs'],
  ];
  for (const [label, config, path] of cases) {
    const built = buildConfigFingerprint(config, { code: config.code });
    assert.ok(built.unknownFields.includes(path), `${label} must report unknown field ${path} (got ${built.unknownFields.join(',')})`);
    assert.equal(built.comparable, false, `${label} must stay non-comparable`);
    const ledger = summarizeAcceptanceRuns([fullSuccessRecord(1, { config })]);
    assert.equal(ledger.groups[0].comparable, false);
    assert.equal(ledger.groups[0].n20.eligible, false);
  }
  // The former "probe model is comparable" claim is migrated to the frozen
  // contract: the positive case is now an explicitly observed
  // assistant.message.model response carrying status/schema proof, and it stays
  // comparable. `probe` is no longer accepted as model provenance.
  const observedWithProof = baseAcceptanceConfig();
  const observedBuilt = buildConfigFingerprint(observedWithProof, { code: observedWithProof.code });
  assert.deepEqual(observedBuilt.unknownFields, [],
    'an observed response model with explicit status/schema proof has no unknown field');
  assert.equal(observedBuilt.comparable, true, 'an observed response model with proof is comparable');
  assert.equal(observedWithProof.provider.modelSource, 'observed');
  assert.equal(observedWithProof.provider.modelObservationStatus, 'observed');
  assert.equal(observedWithProof.provider.modelObservationVersion, MODEL_OBSERVATION_SCHEMA_VERSION);
}

// Mixing provider/CLI/model/matrix/budget/code must never merge groups.
{
  const mutators = [
    ['provider runtime', (c) => { c.provider = { ...c.provider, runtime: 'codex-cli' }; }],
    ['CLI version', (c) => { c.provider = { ...c.provider, cliVersion: '9.9.9' }; }],
    ['model', (c) => { c.provider = { ...c.provider, model: 'gpt-5.6-sol' }; }],
    ['backend', (c) => { c.backend = { ...c.backend, kind: 'local-cpu' }; }],
    ['hardware', (c) => { c.hardware = ['amd-gpu']; }],
    ['architecture', (c) => { c.architecture = ['sm100']; }],
    ['device', (c) => { c.device = 'Other GPU'; }],
    ['driver version', (c) => { c.driverVersion = '111.11'; }],
    ['family set', (c) => { c.families = ['affine', 'reduction']; }],
    ['candidate task count', (c) => { c.candidateTasks = 3; }],
    ['test matrix', (c) => { c.matrix = { ...c.matrix, correctnessCases: 8 }; }],
    ['prompt/selection policy', (c) => { c.promptPolicy = { ...c.promptPolicy, experienceSelectionPolicyVersion: 'other/v2' }; }],
    ['budgets', (c) => { c.budgets = { ...c.budgets, missionBudgetMs: 60_000 }; }],
    ['code content digest', (c) => { c.code = { ...c.code, contentDigest: `sha256:${'e'.repeat(64)}` }; }],
    ['code commit', (c) => { c.code = { ...c.code, commit: 'f'.repeat(40) }; }],
  ];
  for (const [label, mutate] of mutators) {
    const changed = baseAcceptanceConfig();
    mutate(changed);
    const ledger = summarizeAcceptanceRuns([
      fullSuccessRecord(1),
      fullSuccessRecord(2, { config: changed }),
    ]);
    assert.equal(ledger.groups.length, 2, `${label} differences must not be pooled into one group`);
    assert.ok(ledger.groups.every((group) => group.counts.runs === 1), `${label} groups must stay separate`);
  }
}

// A contradiction is a failure and can never be upgraded.
{
  const contradictory = fullSuccessRecord(1);
  contradictory.attempt.outcome = 'failure';
  contradictory.attempt.fullSuccess = false;
  const classified = classifyAcceptanceRecord(contradictory);
  assert.equal(classified.outcome, 'failure', 'a failing attempt with a passing summary is a failure');
  assert.ok(classified.issues.includes('attempt_summary_outcome_mismatch'));

  const unevidenced = fullSuccessRecord(9);
  unevidenced.attempt.phase = 'running';
  unevidenced.summary.status = 'passed';
  const unevidencedClassified = classifyAcceptanceRecord(unevidenced);
  assert.equal(unevidencedClassified.outcome, 'failure');
  assert.ok(unevidencedClassified.issues.includes('full_success_not_evidenced'),
    'a claimed full success without a valid terminal attempt is never silently accepted');

  const flagMismatch = fullSuccessRecord(2);
  flagMismatch.summary.fullSuccess = false;
  const flagClassified = classifyAcceptanceRecord(flagMismatch);
  assert.equal(flagClassified.outcome, 'failure');
  assert.ok(flagClassified.issues.includes('full_success_flag_mismatch'));

  const running = fullSuccessRecord(3);
  running.attempt.phase = 'running';
  running.attempt.status = 'running';
  const runningClassified = classifyAcceptanceRecord(running);
  assert.equal(runningClassified.outcome, 'failure');
  assert.ok(runningClassified.issues.includes('attempt_not_terminal'));

  const missingAttempt = fullSuccessRecord(4);
  missingAttempt.attempt = null;
  const missingClassified = classifyAcceptanceRecord(missingAttempt);
  assert.equal(missingClassified.outcome, 'failure');
  assert.ok(missingClassified.issues.includes('attempt_missing'));

  const badAttemptSchema = fullSuccessRecord(5);
  badAttemptSchema.attempt.schemaVersion = 'operator-studio.gpu-acceptance-attempt/v0';
  assert.equal(classifyAcceptanceRecord(badAttemptSchema).outcome, 'failure');
  assert.ok(classifyAcceptanceRecord(badAttemptSchema).issues.includes('attempt_schema_invalid'));

  const badSummarySchema = fullSuccessRecord(6);
  badSummarySchema.summary.schemaVersion = 'operator-studio.gpu-acceptance-summary/v0';
  assert.equal(classifyAcceptanceRecord(badSummarySchema).outcome, 'failure');
  assert.ok(classifyAcceptanceRecord(badSummarySchema).issues.includes('summary_schema_invalid'));

  const emptyCoverage = fullSuccessRecord(7);
  emptyCoverage.attempt.familyOutcomes = [];
  emptyCoverage.summary.summaries = [];
  const emptyClassified = classifyAcceptanceRecord(emptyCoverage);
  assert.equal(emptyClassified.outcome, 'failure', 'explicit, complete family coverage cannot be empty');
  assert.ok(emptyClassified.issues.includes('family_coverage_incomplete'));

  const partialCoverage = fullSuccessRecord(8);
  partialCoverage.attempt.config = { ...partialCoverage.attempt.config, families: ['affine', 'reduction'] };
  partialCoverage.summary.config = partialCoverage.attempt.config;
  const partialClassified = classifyAcceptanceRecord(partialCoverage);
  assert.equal(partialClassified.outcome, 'failure', 'one family cannot cover a two-family configuration');
  assert.ok(partialClassified.issues.includes('family_coverage_incomplete'));
}

// Budget terminal is counted separately and never promoted to full success.
{
  const budgetRecord = fullSuccessRecord(1, { config: { ...baseAcceptanceConfig(), families: ['affine'] } });
  budgetRecord.attempt.outcome = 'budget_terminal';
  budgetRecord.attempt.fullSuccess = false;
  budgetRecord.attempt.familyOutcomes = [{ family: 'affine', outcome: 'budget_terminal', fullSuccess: false }];
  budgetRecord.summary.outcome = 'budget_terminal';
  budgetRecord.summary.fullSuccess = false;
  budgetRecord.summary.status = 'budget_terminal';
  budgetRecord.summary.summaries = [{
    family: 'affine', outcome: 'budget_terminal', fullSuccess: false,
    budgetTerminalEvidence: { safe: true, terminal: true, budgetReasonRecorded: true, resourceReleaseConfirmed: true, issues: [] },
  }];
  assert.equal(classifyAcceptanceRecord(budgetRecord).outcome, 'budget_terminal');
  const ledger = summarizeAcceptanceRuns([budgetRecord]);
  assert.equal(ledger.totals.budget_terminal, 1);
  assert.equal(ledger.totals.full_success, 0);

  const unsafeBudget = structuredClone(budgetRecord);
  unsafeBudget.summary.summaries[0].budgetTerminalEvidence = { safe: true, terminal: true, budgetReasonRecorded: true, resourceReleaseConfirmed: false, issues: ['resource_release_not_confirmed'] };
  assert.equal(classifyAcceptanceRecord(unsafeBudget).outcome, 'failure', 'an unsafe budget proof is never a budget terminal');
}

// Missing summaries, timeouts and failures all stay in the denominator.
{
  const records = [
    fullSuccessRecord(1),
    terminalRecord(2, { outcome: 'timeout', status: 'timeout', familyOutcome: { family: 'affine', outcome: 'failure', fullSuccess: false } }),
    terminalRecord(3, { outcome: 'failure', status: 'failed', familyOutcome: { family: 'affine', outcome: 'failure', fullSuccess: false } }),
    (() => { const missing = fullSuccessRecord(4); missing.summary = null; return missing; })(),
  ];
  const ledger = summarizeAcceptanceRuns(records);
  assert.equal(ledger.totals.runs, 4);
  assert.equal(ledger.totals.summariesMissing, 1);
  assert.equal(ledger.groups.length, 1);
  assert.equal(ledger.groups[0].stabilityDenominator, 4, 'nothing is dropped from the stability denominator');
  assert.deepEqual(ledger.groups[0].counts, {
    runs: 4, full_success: 1, budget_terminal: 0, failure: 1, timeout: 1, missing_summary: 1,
  });
  assert.equal(ledger.groups[0].n20.eligible, false);
}

// Duplicate identities can never accumulate toward an N.
{
  const duplicated = summarizeAcceptanceRuns(Array.from({ length: 20 }, () => fullSuccessRecord(1)));
  assert.equal(duplicated.totals.receivedRecords, 20);
  assert.equal(duplicated.totals.runs, 1, 'a repeated run directory/attempt id counts once');
  assert.equal(duplicated.totals.duplicateRuns, 19);
  assert.equal(duplicated.n20.eligibleGroupCount, 0);
  assert.ok(duplicated.duplicates.every((entry) => entry.conflict === false));

  const sameAttemptId = summarizeAcceptanceRuns([
    fullSuccessRecord(1, { runDir: 'C:/retained/a' }),
    fullSuccessRecord(1, { runDir: 'C:/retained/b' }),
  ]);
  assert.equal(sameAttemptId.totals.runs, 1, 'an alternate path for the same attempt id must not increase N');
  assert.equal(sameAttemptId.totals.duplicateRuns, 1);

  const sameRunDir = summarizeAcceptanceRuns([
    fullSuccessRecord(1, { runDir: 'C:/retained/same', attemptId: 'attempt-a' }),
    fullSuccessRecord(2, { runDir: 'C:/retained/same', attemptId: 'attempt-b' }),
  ]);
  assert.equal(sameRunDir.totals.runs, 1, 'an alternate attempt id for the same run directory must not increase N');
  assert.equal(sameRunDir.totals.duplicateRuns, 1);

  const conflict = summarizeAcceptanceRuns([
    fullSuccessRecord(1, { runDir: 'C:/retained/conflict' }),
    (() => {
      const changed = baseAcceptanceConfig();
      changed.provider = { ...changed.provider, runtime: 'codex-cli' };
      return fullSuccessRecord(1, { runDir: 'C:/retained/conflict', config: changed });
    })(),
  ]);
  assert.equal(conflict.totals.runs, 1);
  assert.equal(conflict.duplicates[0].conflict, true, 'a contradictory duplicate is recorded as a conflict');
  assert.equal(conflict.groups[0].runs[0].outcome, 'failure', 'a contradictory duplicate counts as failure');
  assert.equal(conflict.groups[0].comparable, false);
}

// A known first record cannot carry a later fingerprint mismatch through.
{
  const good = fullSuccessRecord(1);
  const bad = fullSuccessRecord(2);
  bad.attempt.configFingerprint = `sha256:${'f'.repeat(64)}`;
  bad.summary.configFingerprint = bad.attempt.configFingerprint;
  const ledger = summarizeAcceptanceRuns([good, bad]);
  assert.equal(ledger.groups.length, 1, 'the recomputed fingerprints still group together');
  assert.equal(ledger.groups[0].comparable, false, 'one declared mismatch makes the whole group non-comparable');
  assert.equal(ledger.groups[0].n20.eligible, false);
  assert.ok(ledger.groups[0].comparabilityIssues.includes('declared_fingerprint_mismatch'));
  assert.equal(ledger.groups[0].runs[0].comparable, true, 'the first record is still individually valid');
  assert.equal(ledger.groups[0].runs[1].comparable, false);

  const mismatchedConfig = fullSuccessRecord(3);
  mismatchedConfig.summary.config = { ...mismatchedConfig.attempt.config, budgets: { missionBudgetMs: 1, mainAgentBudgetMs: 2 } };
  const configLedger = summarizeAcceptanceRuns([mismatchedConfig]);
  assert.equal(configLedger.groups[0].comparable, false);
  assert.ok(configLedger.groups[0].comparabilityIssues.includes('attempt_summary_config_mismatch'));
}

// 20 same-fingerprint controlled positives only establish statistical eligibility.
{
  const ledger = summarizeAcceptanceRuns(Array.from({ length: 20 }, (_, index) => fullSuccessRecord(index + 1)));
  assert.equal(ledger.totals.full_success, 20);
  assert.equal(ledger.groups.length, 1);
  const [group] = ledger.groups;
  assert.equal(group.comparable, true);
  assert.equal(group.counts.runs, 20);
  assert.equal(group.stabilityDenominator, 20);
  assert.equal(group.n20.eligible, true);
  assert.equal(ledger.n20.eligibleGroupCount, 1);
  assert.match(ledger.n20.note, /may be pooled/u,
    'ledger eligibility only reports which groups may enter a denominator');
  assert.match(group.n20.reason, /comparable group reached 20 retained attempts/u);

  // One non-terminal record among 20 removes eligibility even though the count is met.
  const running = fullSuccessRecord(21);
  running.attempt.phase = 'running';
  const blocked = summarizeAcceptanceRuns([...Array.from({ length: 19 }, (_, index) => fullSuccessRecord(index + 1)), running]);
  assert.equal(blocked.groups[0].counts.runs, 20);
  assert.equal(blocked.groups[0].comparable, false);
  assert.equal(blocked.groups[0].n20.eligible, false, 'a group with any run lacking a valid terminal attempt is not N=20 eligible');
}

// --- readRunRecord and the read-only ledger CLI ---------------------------

await mkdir(path.join(root, '.operator-studio-local'), { recursive: true });
const tempRoot = await mkdtemp(path.join(root, '.operator-studio-local', 'gpu-acceptance-'));
try {
  const runDir = path.join(tempRoot, 'run-1');
  await mkdir(runDir);
  const missing = await readRunRecord(runDir);
  assert.equal(missing.attempt, null);
  assert.equal(missing.summary, null);
  assert.equal(missing.errors.length, 2);
  assert.ok(missing.errors.every((error) => error.includes('missing')));
  const missingClassified = classifyAcceptanceRecord(missing);
  assert.ok(missingClassified.issues.includes('attempt_missing'));
  assert.ok(missingClassified.issues.includes('summary_missing'));
  assert.equal(missingClassified.outcome, 'missing_summary');

  const record = fullSuccessRecord(1, { runDir });
  await writeFile(path.join(runDir, 'attempt.json'), JSON.stringify(record.attempt, null, 2));
  await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(record.summary, null, 2));
  const loaded = await readRunRecord(runDir);
  assert.ok(loaded.attempt && loaded.summary, 'retained artifacts must be parsed');
  assert.deepEqual(loaded.errors, []);
  assert.equal(summarizeAcceptanceRuns([loaded]).totals.full_success, 1);

  const before = (await readdir(runDir)).sort();
  const cli = spawnSync(process.execPath, ['scripts/summarize-gpu-agent-runs.mjs', '--json', runDir], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.totals.full_success, 1);
  assert.equal(parsed.groups[0].comparable, true);
  assert.equal(parsed.n20.eligibleGroupCount, 0, 'a single retained run is comparable but nowhere near an N=20 claim');
  assert.deepEqual((await readdir(runDir)).sort(), before, 'the ledger CLI must be read-only');

  const emptyDir = path.join(tempRoot, 'run-empty');
  await mkdir(emptyDir);
  const cliMissing = spawnSync(process.execPath, ['scripts/summarize-gpu-agent-runs.mjs', '--json', emptyDir], { cwd: root, encoding: 'utf8' });
  assert.equal(cliMissing.status, 0, cliMissing.stderr);
  assert.equal(JSON.parse(cliMissing.stdout).totals.missing_summary, 1);

  const cliNoArgs = spawnSync(process.execPath, ['scripts/summarize-gpu-agent-runs.mjs'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(cliNoArgs.status, 0, 'the ledger requires explicit run directories and never launches a run');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('[shared-gpu-acceptance] continuation audit, safe budget terminal, family outcome, config fingerprint and run ledger contracts passed without GPU or Agent');
