// Pure, I/O-free acceptance contracts for the real shared-GPU Agent E2E driver and
// the run ledger. Nothing in this module starts a Runtime, provider, GPU test or
// scheduler; it only classifies artifacts that production already produced.
//
// Two consumers share it:
//   - scripts/e2e-shared-gpu-agent-iteration.mjs (live driver observation)
//   - scripts/summarize-gpu-agent-runs.mjs (read-only ledger over retained run dirs)
//
// Contract documentation: scripts/shared-gpu-acceptance.md
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resourceReleaseBarrier } from '../client-runtime/cancellation-contract.mjs';
import {
  MODEL_OBSERVATION_SCHEMA_VERSION, bindModelObservation, summarizeModelObservations,
} from '../client-runtime/model-observation.mjs';

const isNonBlankText = (value) => typeof value === 'string' && value.trim().length > 0;

export const GPU_ATTEMPT_SCHEMA_VERSION = 'operator-studio.gpu-acceptance-attempt/v1';
export const GPU_SUMMARY_SCHEMA_VERSION = 'operator-studio.gpu-acceptance-summary/v1';
export const GPU_LEDGER_SCHEMA_VERSION = 'operator-studio.gpu-acceptance-ledger/v1';
export const ROUND_FACTS_SCHEMA_VERSION = 'operator-studio.round-facts/v1';

// A family outcome is one of these. "full_success" is reserved for the complete
// two-round production path; "budget_terminal" is a safe, evidence-backed stop.
export const FAMILY_OUTCOMES = Object.freeze(['full_success', 'budget_terminal', 'failure']);

// Recorded loop-guard reasons that mean "bounded budget ran out", not "the
// operator must diagnose an infrastructure/operator failure". needs_human alone
// is NOT evidence of budget exhaustion and must never be accepted as such.
export const BUDGET_TERMINAL_REASONS = Object.freeze(['round_budget', 'total_budget']);
export const RESOURCE_RELEASE_PENDING_STATUSES = Object.freeze(['pending', 'unconfirmed', 'quarantined', 'blocked']);

// Provenance labels. A value the driver only read from its own environment or
// from a configured default is "declared": it identifies an intended
// configuration but does not prove what actually ran. Only a value the driver
// observed from the live Runtime/CLI counts as "observed", and only observed
// values may enter a comparable N-pooling fingerprint.
export const DECLARED_PROVENANCE = Object.freeze(['declared', 'env', 'configured-default', 'config']);
export const OBSERVED_PROVENANCE = Object.freeze(['observed', 'probe', 'runtime-descriptor']);
// A responding model is comparable only when the provider-reported
// `assistant.message.model` was actually observed under the frozen schema/status.
// `probe`/`init`/`env`/`declared` labels describe an intended configuration, never
// the model that answered, so they can never make a group N-comparable.
export const MODEL_OBSERVED_PROVENANCE = Object.freeze(['observed']);
export const MODEL_OBSERVATION_STATUS_OBSERVED = 'observed';

export const CONTINUATION_AUDIT_ASSERTIONS = Object.freeze([
  'pre-send audit file present for the actual round following the verified candidate source round',
  'audited prompt SHA-256 (UTF-8) recomputed independently and matched',
  'audited prompt UTF-8 byte length recomputed independently and matched',
  'audited prompt contains the source-round candidate execution experience ID, version and full content',
  'audited selection bound by missionId/candidateId/patchDigest/queueRequestId (no baseline or human fallback)',
  'audited roundFacts equal the frozen source archive and retain candidate, correctness, gate, rollback and currentBest facts',
  'this observation reads the prepared-before-send artifact only; it does not observe the live provider',
]);

// The condition-independent half of the continuation observation. Every mode of
// the controlled experience study runs these exact checks; the study module only
// adds the condition-specific selection assertions on top. Both the default strict
// verifier and the study verifier call this, so a facts-only candidate can never
// pass with lost or tampered mandatory facts.
export const ROUND_FACTS_AUDIT_ASSERTIONS = Object.freeze([
  'pre-send audit file present for the actual round following the verified candidate source round',
  'audited prompt SHA-256 (UTF-8) recomputed independently and matched',
  'audited prompt UTF-8 byte length recomputed independently and matched',
  'audited roundFacts equal the frozen source archive and retain candidate, correctness, gate, rollback and currentBest facts',
  'audited MISSION ITERATION CONTEXT parsed out of the actual prompt equals the audit sidecar',
  'audited selection bound by missionId/candidateId/patchDigest/queueRequestId (no baseline or human fallback)',
  'this observation reads the prepared-before-send artifact only; it does not observe the live provider',
]);

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const utf8 = (value) => Buffer.byteLength(value, 'utf8');

// Normalize a digest for binding comparisons. Accepts "sha256:<hex>" or bare hex;
// returns lowercase hex or null. Never invents a digest for a missing value.
export const hexDigest = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^sha256:/u, '');
  return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
export const canonicalJson = (value) => JSON.stringify(canonical(value));
export const digestJson = (value) => `sha256:${sha256(canonicalJson(value))}`;

const roundOrdinal = (roundId) => {
  const match = /:round:(\d+)$/u.exec(typeof roundId === 'string' ? roundId : '');
  return match ? Number(match[1]) : null;
};

// A value is missing when it is absent, blank, literally "unknown", a non-finite
// number, or a container that is empty OR contains any missing value. Recursion
// into objects matters: a nested null/unknown must not be treated as a known
// configuration value.
const missingFingerprintValue = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '' || value.trim().toLowerCase() === 'unknown';
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.length === 0 || value.some(missingFingerprintValue);
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return true;
    return keys.some((key) => missingFingerprintValue(value[key]));
  }
  return false;
};
export const hasMissingFingerprintValue = missingFingerprintValue;

const readPath = (source, dotted) => dotted.split('.').reduce((current, key) => (
  current && typeof current === 'object' ? current[key] : undefined
), source);

// A run may only be pooled with another run when every field that can change the
// measured result is observed and identical. Unknown provider/CLI/model/matrix/
// policy/budget fields make the group explicitly non-comparable. Device and
// driver version are claimed hardware identity, so their absence is also unknown.
export const REQUIRED_FINGERPRINT_PATHS = Object.freeze([
  'provider.runtime',
  'provider.cliVersion',
  'provider.model',
  'backend.kind',
  'hardware',
  'architecture',
  'device',
  'driverVersion',
  'families',
  'candidateTasks',
  'matrix',
  'promptPolicy.experienceSelectionPolicyVersion',
  'budgets.missionBudgetMs',
  'budgets.mainAgentBudgetMs',
  'code.commit',
  'code.contentDigest',
]);

// Values that only count when directly observed. The paired provenance path
// records where the driver got the value; env/configured labels are declared and
// keep the group out of any N=20 denominator.
export const OBSERVED_FINGERPRINT_FIELDS = Object.freeze([
  { path: 'provider.cliVersion', provenancePath: 'provider.cliVersionSource' },
  { path: 'provider.model', provenancePath: 'provider.modelSource' },
]);

// Identifier-bearing or per-run volatile keys never enter the stable
// configuration fingerprint: sourceRunId changes on every observation, and
// run/mission/path/time identifiers describe a sample, not a configuration.
// Two runs of the same configuration must hash identically regardless of ids.
export const VOLATILE_FINGERPRINT_KEYS = Object.freeze([
  'observedTargets', 'sourceRunId', 'runId', 'runRoot', 'runDir', 'attemptId',
  'missionId', 'projectId', 'sessionId', 'threadId', 'startedAt', 'endedAt',
  'createdAt', 'updatedAt', 'at', 'timestamp', 'evidence', 'paths',
  'attemptPath', 'summaryPath', 'promptAuditDir', 'runtimeLog', 'stateFiles',
  'artifactsRoot',
]);

const stripVolatile = (value) => {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value)) {
    if (VOLATILE_FINGERPRINT_KEYS.includes(key)) continue;
    result[key] = stripVolatile(value[key]);
  }
  return result;
};

export const normalizeConfigForFingerprint = (config) => stripVolatile(config ?? null);

const fingerprintUnknownFields = (config) => {
  const unknown = REQUIRED_FINGERPRINT_PATHS.filter((dotted) => missingFingerprintValue(readPath(config, dotted)));
  for (const { path: valuePath, provenancePath } of OBSERVED_FINGERPRINT_FIELDS) {
    if (missingFingerprintValue(readPath(config, valuePath))) continue;
    const provenance = readPath(config, provenancePath);
    // CLI version keeps the existing real-probe rules; the model additionally
    // requires a provider-reported response observation, never a probe/init/env
    // label or a bare `observed` claim without retained status/schema proof.
    const allowed = valuePath === 'provider.model' ? MODEL_OBSERVED_PROVENANCE : OBSERVED_PROVENANCE;
    if (!allowed.includes(provenance)) unknown.push(`${valuePath}:${provenance ?? 'unobserved'}`);
  }
  if (!missingFingerprintValue(readPath(config, 'provider.model'))) {
    const status = readPath(config, 'provider.modelObservationStatus');
    if (status !== MODEL_OBSERVATION_STATUS_OBSERVED) {
      unknown.push(`provider.modelObservationStatus:${status ?? 'missing'}`);
    }
    const version = readPath(config, 'provider.modelObservationVersion');
    if (version !== MODEL_OBSERVATION_SCHEMA_VERSION) {
      unknown.push(`provider.modelObservationVersion:${version ?? 'missing'}`);
    }
  }
  return [...new Set(unknown)];
};

// `code` may be supplied either inside the config (`config.code`) or separately;
// either way the commit and the actual content digest of the participating source
// tree are part of the fingerprint, so a code change can never be pooled with an
// unchanged configuration. Run identifiers are stripped before hashing.
export const buildConfigFingerprint = (config, { code = undefined } = {}) => {
  const base = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
  const codeManifest = code ?? base.code ?? null;
  if (codeManifest) base.code = codeManifest;
  const normalized = normalizeConfigForFingerprint(base);
  const unknownFields = fingerprintUnknownFields(base);
  return {
    fingerprint: digestJson(normalized),
    normalized,
    unknownFields,
    comparable: unknownFields.length === 0,
    requiredFields: [...REQUIRED_FINGERPRINT_PATHS],
  };
};

// ---------------------------------------------------------------------------
// Continuation audit (P1 §14.4/§14.5 observation)
// ---------------------------------------------------------------------------

// Parse one `----- BEGIN <label> -----` JSON block out of an audited prompt. A
// missing, unterminated or non-JSON block throws: the actual prompt is the only
// authority for what the round was prepared with, never a sidecar claim.
export const promptSection = (prompt, label) => {
  const begin = `----- BEGIN ${label} -----\n`;
  const end = `\n----- END ${label} -----`;
  const start = prompt.indexOf(begin);
  const stop = prompt.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, `audited prompt is missing ${label}`);
  return JSON.parse(prompt.slice(start + begin.length, stop));
};

// The single authority for "which execution experience records are the verified
// source-round candidate's own". Bound by mission, candidate id, patch digest and
// the durable queue request id, so a baseline observation, a human note or another
// candidate can never satisfy it. Returns the matches; callers decide whether they
// require exactly one.
export const bindSourceRoundExecutionExperience = ({ experiences, sourceRound, missionId } = {}) => {
  assert.ok(sourceRound && typeof sourceRound === 'object' && !Array.isArray(sourceRound),
    'sourceRound archive is required');
  const expectedCandidateDigest = hexDigest(sourceRound.candidateDigest);
  assert.ok(expectedCandidateDigest && sourceRound.candidateId && sourceRound.queueRequestId,
    'archived source round is missing its candidate/queue binding');
  return (Array.isArray(experiences) ? experiences : []).filter((item) => item.source === 'execution'
    && item.evidence?.missionId === missionId
    && item.evidence?.candidateId === sourceRound.candidateId
    && hexDigest(item.evidence?.patchDigest) === expectedCandidateDigest
    && item.evidence?.runId === sourceRound.queueRequestId);
};

// Verify the condition-independent facts of the prepared-before-send audit
// artifact that the production Runtime wrote for the round following the verified
// candidate's own archived round. The caller must have selected `audit` by the
// frozen `sourceRound.roundFacts.target.roundId` (never by "the latest
// agent.runId"): a third round or a same-round recovery attempt must not be
// compared against the first round's facts.
//
// `sourceRound` is the runHistory archive matched by the first verified candidate
// task's candidate digest AND queue request id (payload.requestId). Its
// `runId`/`candidateSourceRunId` are the actual producing run, so same-round
// recovery attribution does not fall back to a fixed first Agent ID.
//
// Everything here is shared by the strict continuation verifier and by every
// condition of the controlled study: digest/bytes recomputation, frozen round
// facts equality, the prompt's own MISSION ITERATION CONTEXT parse and the
// candidate/queue-bound identity. Missing evidence throws; nothing is synthesized.
export const verifyRoundFactsAudit = ({ audit, sourceRound, missionId, projectId } = {}) => {
  assert.ok(audit && typeof audit === 'object' && !Array.isArray(audit), 'continuation audit artifact is required');
  assert.ok(sourceRound && typeof sourceRound === 'object' && !Array.isArray(sourceRound), 'sourceRound archive is required');
  assert.equal(audit.deliveryStage, 'prepared-before-send');
  assert.equal(audit.missionId, missionId);
  assert.equal(audit.projectId, projectId);
  assert.ok(typeof audit.prompt === 'string' && audit.prompt.length > 0, 'audited prompt text is required');
  assert.ok(typeof audit.runId === 'string' && audit.runId, 'audit must carry the continuation run id');

  const facts = audit.roundFacts;
  assert.ok(facts && facts.schemaVersion === ROUND_FACTS_SCHEMA_VERSION, 'audited round facts are missing');

  const sourceRoundId = sourceRound.roundId;
  const targetRoundId = sourceRound.roundFacts?.target?.roundId;
  assert.ok(typeof sourceRoundId === 'string' && sourceRoundId, 'source round archive has no roundId');
  assert.ok(typeof targetRoundId === 'string' && targetRoundId, 'source round archive has no frozen target roundId');
  // The audit must be the actual pre-send artifact of the round that follows the
  // verified candidate's own round, not the newest retained audit.
  assert.equal(audit.roundId, targetRoundId,
    `continuation audit round ${audit.roundId} is not the frozen next round ${targetRoundId} of the verified candidate`);
  const sourceOrdinal = roundOrdinal(sourceRoundId);
  const targetOrdinal = roundOrdinal(targetRoundId);
  assert.ok(targetOrdinal !== null && sourceOrdinal !== null && targetOrdinal > sourceOrdinal,
    `continuation round ${targetRoundId} is not a later round than ${sourceRoundId}`);
  assert.notEqual(audit.runId, sourceRound.runId, 'audit run must be a continuation run, not the source round run');
  assert.equal(facts.target?.roundId, audit.roundId);
  assert.equal(facts.target?.missionId, missionId);
  assert.equal(facts.target?.projectId, projectId);
  assert.equal(facts.target?.missionId, audit.missionId);
  assert.equal(facts.target?.projectId, audit.projectId);

  // Independently recompute the audited string; the sidecar digest/bytes are not trusted.
  assert.equal(audit.promptDigest, `sha256:${sha256(audit.prompt)}`);
  assert.equal(audit.promptBytes, utf8(audit.prompt));

  // The facts in the continuation prompt must be the frozen source archive, not a
  // re-derived or hand-filled snapshot.
  assert.deepEqual(facts, sourceRound.roundFacts, 'audited facts must equal the frozen source archive');

  const expectedCandidateDigest = hexDigest(sourceRound.candidateDigest);
  assert.ok(expectedCandidateDigest && sourceRound.candidateId && sourceRound.queueRequestId,
    'archived source round is missing its candidate/queue binding');
  assert.equal(facts.previous?.runId, sourceRound.runId);
  assert.equal(facts.previous?.roundId, sourceRound.roundId);
  assert.equal(facts.previous?.candidateId, sourceRound.candidateId);
  assert.equal(hexDigest(facts.previous?.candidateDigest), expectedCandidateDigest);
  assert.equal(facts.previous?.queueRequestId, sourceRound.queueRequestId);
  if (sourceRound.candidateSourceRunId) {
    assert.equal(facts.previous?.candidateSourceRunId, sourceRound.candidateSourceRunId,
      'frozen facts must retain the actual candidate source run (recovery attempts are not re-attributed)');
  }

  // The actual prompt is the authority for the facts the round was prepared with.
  assert.deepEqual(promptSection(audit.prompt, 'MISSION ITERATION CONTEXT'), facts,
    'actual prompt facts must equal the audit sidecar');

  const sourceOutcome = sourceRound.decisionReview?.resolution?.outcome;
  assert.ok(['reference', 'reject'].includes(sourceOutcome),
    `source round unexpectedly resolved as ${sourceOutcome}`);
  assert.ok(facts.candidate, 'audited facts must retain the previous candidate summary');
  assert.ok(facts.correctness, 'audited facts must retain previous-round correctness');
  assert.ok(facts.gate, 'audited facts must retain the previous Accept Gate result');
  assert.equal(facts.gate.result, sourceOutcome);
  assert.ok(facts.rollback, 'audited facts must retain the previous rollback origin');
  assert.ok(facts.currentBest, 'audited facts must retain the currentBest asset status');

  return {
    runId: audit.runId,
    roundId: audit.roundId,
    promptDigest: audit.promptDigest,
    promptBytes: audit.promptBytes,
    sourceRound: {
      roundId: sourceRoundId,
      runId: sourceRound.runId,
      candidateId: sourceRound.candidateId,
      candidateDigest: expectedCandidateDigest,
      queueRequestId: sourceRound.queueRequestId,
    },
    facts: {
      previousRunId: facts.previous?.runId,
      previousRoundId: facts.previous?.roundId,
      previousCandidateId: facts.previous?.candidateId,
      previousQueueRequestId: facts.previous?.queueRequestId,
      gateResult: facts.gate?.result,
      rollbackPerformed: facts.rollback?.performed ?? null,
      currentBestCandidateId: facts.currentBest?.candidateId ?? null,
    },
    assertions: [...ROUND_FACTS_AUDIT_ASSERTIONS],
  };
};

// Verify the prepared-before-send audit artifact that the production Runtime wrote
// before sending the round that FOLLOWS the verified candidate's own archived
// round. The caller must have selected `audit` by the frozen
// `sourceRound.roundFacts.target.roundId` (never by "the latest agent.runId"):
// a third round or a same-round recovery attempt must not be compared against the
// first round's facts.
//
// `sourceRound` is the runHistory archive matched by the first verified candidate
// task's candidate digest AND queue request id (payload.requestId). Its
// `runId`/`candidateSourceRunId` are the actual producing run, so same-round
// recovery attribution does not fall back to a fixed first Agent ID.
//
// All P1 assertions are retained: digest/bytes recomputation, id/version/full
// content, frozen round facts equality and the candidate/queue-bound experience
// selection (no baseline or human fallback). Missing evidence throws; nothing is
// synthesized.
export const verifyContinuationAudit = ({ audit, sourceRound, experiences, missionId, projectId } = {}) => {
  const receipt = verifyRoundFactsAudit({ audit, sourceRound, missionId, projectId });

  // Exact evidence binding: only the source round's own execution experience may
  // satisfy this. A baseline observation, a human note or another candidate fails.
  const boundExperiences = bindSourceRoundExecutionExperience({ experiences, sourceRound, missionId });
  assert.equal(boundExperiences.length, 1,
    `source-round candidate execution experience not uniquely bound (found ${boundExperiences.length})`);
  const continuationExperience = boundExperiences[0];
  const selected = (audit.selection?.selected || []).find((item) => item.id === continuationExperience.id
    && item.version === continuationExperience.version);
  assert.ok(selected, 'audited selection must contain the source-round candidate execution experience');
  assert.equal(selected.source, 'execution');

  const promptExperience = promptSection(audit.prompt, 'UNTRUSTED EXPERIENCE DATA');
  const promptItems = promptExperience.items.filter((item) => item.id === continuationExperience.id
    && item.version === continuationExperience.version);
  assert.equal(promptItems.length, 1, 'actual prompt must contain the bound experience ID and version exactly once');
  assert.equal(promptItems[0].content, continuationExperience.content,
    'actual prompt must carry the complete, unchanged experience content');
  assert.equal(promptExperience.versions[continuationExperience.id], continuationExperience.version);
  assert.equal(promptExperience.contextId, audit.selection.contextId);

  return {
    runId: receipt.runId,
    roundId: receipt.roundId,
    promptDigest: receipt.promptDigest,
    promptBytes: receipt.promptBytes,
    selectedExperience: {
      id: continuationExperience.id,
      version: continuationExperience.version,
      source: continuationExperience.source,
      evidenceCandidateId: continuationExperience.evidence.candidateId,
      evidencePatchDigest: continuationExperience.evidence.patchDigest,
      evidenceRunId: continuationExperience.evidence.runId,
    },
    facts: receipt.facts,
    assertions: [...CONTINUATION_AUDIT_ASSERTIONS],
  };
};

// ---------------------------------------------------------------------------
// Budget-safe terminal classification
// ---------------------------------------------------------------------------

const releasePending = (release) => Boolean(release) && (
  release.confirmed === false
  || RESOURCE_RELEASE_PENDING_STATUSES.includes(release.status)
  || release.quarantined === true
  || release.blocked === true);

const eventMissionId = (event) => event?.payload?.missionId ?? event?.missionId ?? null;
const eventRunId = (event) => event?.payload?.runId ?? event?.runId ?? null;
const eventTime = (event) => Date.parse(event?.payload?.at || event?.payload?.timestamp || event?.at || event?.timestamp || '') || 0;

// An event belongs to the current mission/run unless it is explicitly bound to a
// different one. Unbound events are read as part of the current single-mission
// state snapshot; events bound elsewhere are historical and never poison (or
// rescue) the current mission.
const matchesBinding = (event, { missionId = null, runId = null } = {}) => {
  const boundMission = eventMissionId(event);
  const boundRun = eventRunId(event);
  if (missionId && boundMission && boundMission !== missionId) return false;
  if (runId && boundRun && boundRun !== runId) return false;
  return true;
};

export const RELEASE_RESOLUTION_EVENT_TYPES = Object.freeze([
  'loop.resource_release_resolved', 'loop.resource_release_confirmed',
]);

// Resource release is confirmed only by an explicit `confirmed: true` release
// projection for the current mission/run — a terminal Agent status is NOT proof
// that the execution resource was released. Pending/unconfirmed/quarantined/
// blocked projections fail closed. A current quarantine is resolved by the
// current confirmed projection or by a later matching resolution event; a
// quarantine bound to another mission/run is historical and never poisons.
export const resourceReleaseEvidence = (state = {}, { missionId = null, runId = null } = {}) => {
  missionId ??= state.activeMissionId ?? null;
  runId ??= state.agent?.runId ?? null;
  const agentRelease = state?.agent?.resourceRelease || null;
  const missionRelease = state?.workflowRecovery?.resourceRelease || null;
  const agentPending = releasePending(agentRelease);
  const missionPending = releasePending(missionRelease);
  const currentIdentity = Boolean(missionId && runId && state.activeMissionId === missionId && state.agent?.runId === runId);
  const releaseIdentityMatches = matchesBinding(agentRelease, { missionId, runId });
  const explicitConfirmed = currentIdentity && releaseIdentityMatches && agentRelease?.confirmed === true;
  const resolvedByProjection = explicitConfirmed && !agentPending && !missionPending;
  const quarantineEvents = (state?.runtimeEvents || [])
    .filter((event) => event?.type === 'loop.resource_release_quarantined' && matchesBinding(event, { missionId, runId }));
  const resolutionEvents = (state?.runtimeEvents || [])
    .filter((event) => RELEASE_RESOLUTION_EVENT_TYPES.includes(event?.type) && matchesBinding(event, { missionId, runId }));
  const unresolvedQuarantine = quarantineEvents.some((quarantine) => {
    if (resolvedByProjection) return false;
    const quarantinedAt = eventTime(quarantine);
    if (!quarantinedAt) return true;
    return !resolutionEvents.some((event) => eventTime(event) >= quarantinedAt);
  });
  const issues = [];
  if (!explicitConfirmed) issues.push('explicit_release_confirmation_missing');
  if (!currentIdentity || !releaseIdentityMatches) issues.push('resource_release_binding_unconfirmed');
  if (agentPending) issues.push('agent_release_pending');
  if (missionPending) issues.push('mission_release_pending');
  if (unresolvedQuarantine) issues.push('resource_release_quarantined');
  return {
    confirmed: explicitConfirmed && !agentPending && !missionPending && !unresolvedQuarantine,
    explicitConfirmed,
    quarantined: unresolvedQuarantine,
    agentRelease: agentRelease ? { confirmed: agentRelease.confirmed ?? null, status: agentRelease.status ?? null } : null,
    missionRelease: missionRelease ? { confirmed: missionRelease.confirmed ?? null, status: missionRelease.status ?? null } : null,
    issues,
  };
};

const isBudgetRuntimeEvent = (event) => event?.type === 'loop.round_budget_exceeded'
  || event?.type === 'loop.budget_completed'
  || (event?.type === 'loop.needs_human' && BUDGET_TERMINAL_REASONS.includes(event?.payload?.reason));

// A needs_human stop counts as budget-safe only when the CURRENT loop recorded a
// bounded-budget reason (or a current-bound budget runtime event, with no
// contradicting current reason), the reason is not a non-budget failure, AND the
// execution resource has an explicit confirmed release. Historical budget events
// never override a current non-budget failure such as generation_failure.
export const budgetTerminalEvidence = (state = {}, binding = {}) => {
  const missionId = binding?.missionId ?? state.activeMissionId ?? null;
  const runId = binding?.runId ?? state.agent?.runId ?? null;
  const stats = state?.iterationStats || {};
  const loopStatus = typeof stats.loopStatus === 'string' ? stats.loopStatus : null;
  const agentStatus = typeof state?.agent?.status === 'string' ? state.agent.status : null;
  const reason = typeof stats.loopStatusReason === 'string' && stats.loopStatusReason ? stats.loopStatusReason : null;
  const terminal = loopStatus === 'needs_human' || loopStatus === 'budget_exhausted' || agentStatus === 'needs_human';

  const statusIsBudget = loopStatus === 'budget_exhausted';
  const reasonIsBudget = reason !== null && BUDGET_TERMINAL_REASONS.includes(reason);
  const reasonIsNonBudget = reason !== null && !reasonIsBudget;

  const budgetEvents = (state?.runtimeEvents || [])
    .filter((event) => isBudgetRuntimeEvent(event) && missionId && runId
      && eventMissionId(event) === missionId && eventRunId(event) === runId);

  // A current non-budget reason is authoritative; budget events cannot rescue it.
  const budgetReasonRecorded = reasonIsNonBudget
    ? false
    : (statusIsBudget || reasonIsBudget || (reason === null && budgetEvents.length > 0));

  const release = resourceReleaseEvidence(state, { missionId, runId });
  const issues = [];
  if (!terminal) issues.push('not_terminal_needs_human');
  if (!budgetReasonRecorded) issues.push(reasonIsNonBudget ? 'current_reason_not_budget' : 'budget_reason_not_recorded');
  if (!release.confirmed) issues.push('resource_release_not_confirmed');
  return {
    safe: issues.length === 0,
    terminal,
    budgetReasonRecorded,
    resourceReleaseConfirmed: release.confirmed,
    reason,
    budgetEvents: budgetEvents.map((event) => event?.type || null),
    resourceRelease: release,
    issues,
  };
};

// A completed real Candidate task: the queue task actually completed AND its
// candidate payload is bound to a real shared-GPU execution result with the same
// digest. Anything else (other status, non-GPU/mock source, mismatched binding)
// is not admissible evidence for a full two-round success.
export const isRealGpuCompletedCandidate = (task) => {
  if (!task || task.status !== 'completed') return false;
  const environment = task.result?.environment;
  if (!environment || environment.source !== 'local-shared-gpu') return false;
  if (environment.executionMode !== 'gpu' || environment.liveHardware !== true
    || environment.simulated === true || environment.mock === true || task.result?.simulated === true) return false;
  if (task.payload?.purpose !== 'candidate' || !task.payload?.requestId || !task.payload?.candidate?.id) return false;
  if (environment.runId && environment.runId !== task.payload.requestId) return false;
  const payloadDigest = hexDigest(task.payload?.candidate?.digest);
  const resultDigest = hexDigest(environment.candidateDigest);
  return Boolean(payloadDigest && resultDigest && payloadDigest === resultDigest);
};

// Family-level outcome. "full_success" requires the complete two-round path: at
// least two DISTINCT completed real-GPU candidates (validated by
// `isRealGpuCompletedCandidate`, so two tasks with one digest never pass), a
// verified continuation audit and a clean automatic rollback.
//
// `budgetTerminal` must be the evidence object returned by
// `budgetTerminalEvidence`; a bare truthy flag can never promote a stop to a safe
// terminal, and any existing failure reason is preserved rather than hidden.
export const evaluateFamilyOutcome = ({
  desiredTasks, completedTasks = [], budgetTerminal = null, continuationAudit = null, rollbackEvents = [], reasons = [],
} = {}) => {
  const failures = [...reasons];
  const realTasks = [];
  for (const task of completedTasks) {
    if (isRealGpuCompletedCandidate(task)) realTasks.push(task);
    else failures.push('candidate_not_completed_real_gpu');
  }
  const distinct = new Set(realTasks.map((task) => hexDigest(task.payload.candidate.digest)));

  const budgetSafe = Boolean(budgetTerminal) && typeof budgetTerminal === 'object' && budgetTerminal.safe === true
    && budgetTerminal.terminal === true && budgetTerminal.budgetReasonRecorded === true
    && budgetTerminal.resourceReleaseConfirmed === true && budgetTerminal.issues?.length === 0;
  if (budgetTerminal && !budgetSafe) failures.push('budget_terminal_evidence_not_safe');
  if (budgetSafe) {
    // A safe bounded stop is a terminal, but never a full success. Existing
    // failures still win: a contradictory stop is a failure, not a safe terminal.
    return failures.length
      ? { outcome: 'failure', fullSuccess: false, reasons: failures }
      : { outcome: 'budget_terminal', fullSuccess: false, reasons: ['bounded_budget_terminal'] };
  }

  const requiredTasks = Math.max(2, Number(desiredTasks) || 0);
  if (!(desiredTasks >= 2)) failures.push('full_two_round_success_required');
  if (realTasks.length < requiredTasks) failures.push('fewer_than_two_completed_candidates');
  if (distinct.size < 2) failures.push('completed_candidates_not_distinct');
  if (!continuationAudit) failures.push('continuation_audit_missing');
  if (!rollbackEvents.length) failures.push('rollback_evidence_missing');
  else if (!rollbackEvents.every((event) => event?.payload?.workspaceClean === true)) failures.push('rollback_workspace_not_clean');
  return failures.length
    ? { outcome: 'failure', fullSuccess: false, reasons: failures }
    : { outcome: 'full_success', fullSuccess: true, reasons: [] };
};

// ---------------------------------------------------------------------------
// Frozen consumer helpers (docs/development/MODEL_OBSERVATION_ACCEPTANCE.md
// §"Frozen consumer helper acceptance")
// ---------------------------------------------------------------------------
//
// These are I/O-free. The live driver is responsible for reading the current
// attempt's own runRoot bridge files and the live state projection; these helpers
// only turn that in-memory evidence into frozen per-run proof. No file, provider,
// time or environment access happens here.

// A safe run file is a single basename ending `.json`, starting with an
// alphanumeric character and containing no separator.
const RUN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
const isSafeRunFileName = (name) => typeof name === 'string' && name.length > 0
  && name === name.split(/[\\/]/u).pop()
  && RUN_FILE_NAME.test(name);
const runIdFromFileName = (name) => name.slice(0, -'.json'.length);

// An unresolved Mission/session is retained as an explicit, deliberately
// non-bindable placeholder. It keeps a started (or newly discovered) run in the
// frozen denominator so it can never silently disappear, without inventing a
// real Mission/session the attempt never observed. `bindModelObservation`
// requires an exact identity match, so a placeholder can never produce an
// observation.
export const UNRESOLVED_RUN_MISSION = '<unresolved-mission>';
export const UNRESOLVED_RUN_SESSION = '<unresolved-session>';
const requiredIdentity = ({ provider: entryProvider, runId, missionId, sessionId }) => ({
  provider: isNonBlankText(entryProvider) ? entryProvider : '',
  runId: typeof runId === 'string' ? runId : '',
  missionId: isNonBlankText(missionId) ? missionId : UNRESOLVED_RUN_MISSION,
  sessionId: isNonBlankText(sessionId) ? sessionId : UNRESOLVED_RUN_SESSION,
});

const emptyModelObservationSummary = () => summarizeModelObservations([], { requiredRuns: [] });

/**
 * Build the frozen per-run response-model evidence for the current attempt.
 *
 * `knownRuns` are independently observed start identities
 * `{provider, runId, missionId?, sessionId?}`. `records` are the FINAL filesystem
 * read results `{fileName, record, error}`. Final records are the observation
 * authority: an earlier snapshot DTO is never a fallback, no ranking may prefer an
 * observed snapshot over a later unknown/conflict/missing state, and a DTO's own
 * fields never supply an expected Mission/session identity.
 */
export const collectModelObservationEvidence = ({ provider, missionIds = [], knownRuns = [], records = [] } = {}) => {
  const providerKey = isNonBlankText(provider) ? provider : '';
  const missionSet = new Set((Array.isArray(missionIds) ? missionIds : []).filter(isNonBlankText));
  const observations = [];
  const unboundRuns = [];
  // Required identities that do not come from a started run: an unreadable,
  // identity-less or conflicting new safe file, or an unusable start identity.
  const extraRequired = [];

  const pushUnbound = (entry, reason, fileName = null) => {
    unboundRuns.push({
      provider: entry.provider || null,
      runId: entry.runId || null,
      missionId: entry.missionId || null,
      sessionId: entry.sessionId || null,
      ...(fileName ? { fileName } : {}),
      reason,
    });
  };
  const requireExtra = ({ provider: entryProvider, runId, missionId = '', sessionId = '' }) => {
    extraRequired.push(requiredIdentity({ provider: entryProvider || providerKey, runId, missionId, sessionId }));
  };
  const startKey = (entryProvider, runId) => `${entryProvider} ${runId}`;

  // Known starts dedupe by provider/run identity (not success). Every distinct
  // started run stays required even when its final record is absent/malformed or
  // its real session/Mission was never learned; a blank start identity can never
  // be observed but must still fail the summary closed. Two *concrete* but
  // contradictory Missions/sessions on one run identity never resolve
  // first-wins: the run is retained once and can never produce an observation.
  const starts = new Map();
  const startOrder = [];
  for (const raw of Array.isArray(knownRuns) ? knownRuns : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const startProvider = isNonBlankText(raw.provider) ? raw.provider : providerKey;
    const runId = typeof raw.runId === 'string' ? raw.runId : '';
    const missionId = isNonBlankText(raw.missionId) ? raw.missionId : '';
    const sessionId = isNonBlankText(raw.sessionId) ? raw.sessionId : '';
    if (!isNonBlankText(runId)) {
      const marker = { provider: startProvider, runId, missionId, sessionId };
      requireExtra(marker);
      pushUnbound(marker, 'known run start has no nonblank run identity');
      continue;
    }
    const key = startKey(startProvider, runId);
    const existing = starts.get(key);
    if (existing) {
      if (missionId && existing.missionId && missionId !== existing.missionId) {
        existing.invalid ||= 'conflicting concrete Missions for one started run identity';
      } else if (!existing.missionId && missionId) existing.missionId = missionId;
      if (sessionId && existing.sessionId && sessionId !== existing.sessionId) {
        existing.invalid ||= 'conflicting concrete sessions for one started run identity';
      } else if (!existing.sessionId && sessionId) existing.sessionId = sessionId;
      continue;
    }
    const entry = { provider: startProvider, runId, missionId, sessionId, resolved: false, bound: false, invalid: null };
    starts.set(key, entry);
    startOrder.push(entry);
  }

  // Reads are grouped by filename: the FINAL read content is the authority. Reads
  // that are semantically identical (same error, same record content, JSON key
  // order irrelevant) are one duplicate; conflicting reads for one file fail
  // closed in either order instead of letting the last write win.
  const readsByFile = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const fileName = typeof raw.fileName === 'string' ? raw.fileName : '';
    if (!isSafeRunFileName(fileName)) continue;
    const list = readsByFile.get(fileName);
    if (list) list.push(raw); else readsByFile.set(fileName, [raw]);
  }

  for (const [fileName, reads] of readsByFile) {
    const runId = runIdFromFileName(fileName);
    const known = starts.get(startKey(providerKey, runId)) || null;
    const normalized = reads.map((read) => ({
      error: isNonBlankText(read.error) ? read.error.trim() : null,
      record: read.record && typeof read.record === 'object' && !Array.isArray(read.record) ? read.record : null,
    }));
    const forms = new Set(normalized.map((item) => canonicalJson(item)));
    if (forms.size > 1) {
      const reason = 'conflicting final reads for one run file';
      if (known) { known.resolved = true; known.invalid ||= reason; pushUnbound(known, reason, fileName); }
      else {
        const marker = { provider: providerKey, runId, missionId: '', sessionId: '' };
        requireExtra(marker);
        pushUnbound(marker, reason, fileName);
      }
      continue;
    }
    const { error, record } = normalized[0];
    if (error || !record) {
      const reason = error
        ? `final run record is unreadable or invalid: ${error}`
        : 'final run record is not a parsed object';
      if (known) { known.resolved = true; pushUnbound(known, reason, fileName); }
      else {
        const marker = { provider: providerKey, runId, missionId: '', sessionId: '' };
        requireExtra(marker);
        pushUnbound(marker, reason, fileName);
      }
      continue;
    }

    const recordProvider = isNonBlankText(record.provider) ? record.provider : '';
    const recordRunId = typeof record.runId === 'string' ? record.runId : '';
    const recordMissionId = isNonBlankText(record.missionId) ? record.missionId : '';
    const recordSession = isNonBlankText(record.sessionId) ? record.sessionId : '';
    const recordThread = isNonBlankText(record.threadId) ? record.threadId : '';
    const recordSessionId = recordSession || recordThread;
    const ours = Boolean(known) || (recordMissionId !== '' && missionSet.has(recordMissionId));
    if (!ours) {
      // A *concrete* unrelated foreign-Mission file that no known start references
      // is not this attempt's evidence. A file without any Mission identity is NOT
      // proof of foreignness: it stays required/unbound instead of disappearing.
      if (!recordMissionId) {
        const marker = { provider: providerKey, runId, missionId: '', sessionId: recordSessionId };
        requireExtra(marker);
        pushUnbound(marker, 'final run file has no Mission identity and belongs to no started run', fileName);
      }
      continue;
    }
    // From here the file belongs to this attempt. Every rejection below keeps the
    // run in the denominator as an unbound required identity; none may drop it.
    const rejectOurs = (reason) => {
      if (known) { known.resolved = true; pushUnbound(known, reason, fileName); return; }
      const marker = { provider: providerKey, runId, missionId: recordMissionId, sessionId: recordSessionId };
      requireExtra(marker);
      pushUnbound(marker, reason, fileName);
    };
    if (recordProvider !== providerKey) { rejectOurs('final record provider does not match the expected provider'); continue; }
    if (recordSession && recordThread && recordSession !== recordThread) {
      rejectOurs('final record session and thread disagree'); continue;
    }
    if (recordRunId !== runId) { rejectOurs('final record runId does not match its filename'); continue; }

    let entry = known;
    if (entry) {
      if (entry.invalid) { entry.resolved = true; pushUnbound(entry, entry.invalid, fileName); continue; }
      // Only the attempt's expected Mission set is admissible, whether the start
      // already names a Mission or must complete it from this record.
      if (!missionSet.has(entry.missionId || recordMissionId)) {
        entry.resolved = true; pushUnbound(entry, 'final record Mission is not in the expected Mission set', fileName); continue;
      }
      // The known start's concrete Mission/session may only be completed from this
      // current-attempt record, never overwritten by a conflicting concrete value.
      if (entry.missionId && recordMissionId && entry.missionId !== recordMissionId) {
        entry.resolved = true; pushUnbound(entry, 'final record Mission conflicts with the started run Mission', fileName); continue;
      }
      if (entry.missionId && !recordMissionId) {
        entry.resolved = true; pushUnbound(entry, 'final record has no Mission identity', fileName); continue;
      }
      if (!entry.missionId) entry.missionId = recordMissionId;
      if (!entry.missionId) { entry.resolved = true; pushUnbound(entry, 'run Mission identity is unavailable', fileName); continue; }
      if (entry.sessionId && recordSessionId && entry.sessionId !== recordSessionId) {
        entry.resolved = true; pushUnbound(entry, 'final record session conflicts with the started run session', fileName); continue;
      }
      if (entry.sessionId && !recordSessionId) {
        entry.resolved = true; pushUnbound(entry, 'final record has no session identity', fileName); continue;
      }
      if (!entry.sessionId) entry.sessionId = recordSessionId;
    } else {
      if (!recordMissionId || !missionSet.has(recordMissionId)) continue;
      if (!recordSessionId) { rejectOurs('final record has no session identity'); continue; }
      entry = { provider: providerKey, runId, missionId: recordMissionId, sessionId: recordSessionId,
        resolved: false, bound: false, invalid: null };
      starts.set(startKey(providerKey, runId), entry);
      startOrder.push(entry);
    }
    entry.resolved = true;
    const dto = record.modelObservation && typeof record.modelObservation === 'object'
      && !Array.isArray(record.modelObservation) ? record.modelObservation : null;
    const bound = dto ? bindModelObservation(dto, {
      provider: entry.provider, runId: entry.runId, missionId: entry.missionId, sessionId: entry.sessionId,
    }) : null;
    if (bound) { observations.push(bound); entry.bound = true; }
    else {
      entry.bound = false;
      pushUnbound(entry, dto
        ? 'retained model observation does not bind to this run identity'
        : 'no retained model observation', fileName);
    }
  }

  // Every known start without a usable final record stays required and unbound.
  for (const entry of startOrder) {
    if (!entry.resolved) pushUnbound(entry, 'no final run record was retained for this started run');
  }
  const requiredRuns = [];
  for (const entry of startOrder) requiredRuns.push(requiredIdentity(entry));
  // Unresolved/extra identities are appended so the frozen summary fails closed
  // instead of silently dropping an unreadable run from the denominator.
  for (const marker of extraRequired) requiredRuns.push(marker);

  const summary = requiredRuns.length
    ? summarizeModelObservations(observations, { requiredRuns })
    : emptyModelObservationSummary();
  return { observations, requiredRuns, summary, unboundRuns };
};

// The single collection status that proves this round's own experience was
// durably collected. The production collector writes `recorded` when at least one
// inspected observation created a new durable record or idempotently matched an
// already-durable one, with no skips. `skipped`, `mixed`, `failed`, `pending` and
// any unfamiliar/malformed status fail closed.
const DURABLE_EXPERIENCE_STATUS = 'recorded';

// A durable counter is a nonnegative safe integer. An absent (or undefined)
// counter means the producer did not report it and counts as zero; every other
// supplied value — negative, fractional, nonfinite, string, null, boolean — is
// malformed and fails the whole observation closed instead of being coerced.
const durableExperienceCount = (value) => {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/**
 * Pure observation-ready predicate: has this round's experience already been
 * durably collected, whether it was created now or found idempotently?
 *
 * True exactly when `collection.status === 'recorded'` AND at least one durable
 * record exists — `recorded` (this round created it) or `existing` (this round's
 * inspection matched an already-durable record for the same evidence key, so
 * nothing further has to be produced). The real slot-02 run reached two completed
 * candidates with `recorded=0, existing=1`; waiting for a new record alone made
 * the observer wait out a collect timeout/recovery and a third Agent start that
 * was cancelled without a response.
 *
 * False for a missing/non-object collection, any status other than `recorded`
 * (`failed`, `pending`, `skipped`, `mixed`, unknown), a malformed counter and a
 * zero total. I/O-free and NEVER a success signal: it only says the experience is
 * observable now, and replaces none of the candidate, audit, rollback, budget or
 * stop-receipt checks.
 */
export const hasDurableCollectedExperience = (collection) => {
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return false;
  if (collection.status !== DURABLE_EXPERIENCE_STATUS) return false;
  const recorded = durableExperienceCount(collection.recorded);
  const existing = durableExperienceCount(collection.existing);
  if (recorded === null || existing === null) return false;
  return recorded + existing > 0;
};

// The loop intent a confirmed Mission stop must have persisted. A proving stop
// is exactly `stopped`: `paused`/`idle` by themselves are not a stopped intent.
const STOPPED_LOOP_STATUSES = Object.freeze(['stopped']);

/**
 * Evaluate the real Mission-stop receipt (HTTP body `{state}` or a later bounded
 * read-only `{state}` observation). Pure: it never cancels, mutates or advances
 * anything, and an unknown/unconfirmed release is always false.
 */
export const evaluateMissionStopReceipt = ({ missionId, receipt } = {}) => {
  const reasons = [];
  const reject = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!isNonBlankText(missionId)) reject('requested Mission id is missing');
  const state = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && receipt.state && typeof receipt.state === 'object' && !Array.isArray(receipt.state)
    ? receipt.state : null;
  if (!state) {
    reject('stop receipt state is missing or malformed');
    return { confirmed: false, reasons };
  }
  if (state.activeMissionId !== missionId) reject('stop receipt does not belong to the requested active Mission');
  if (state.missionPaused !== true) reject('Mission stop intent is not paused');
  const loopStatus = state.iterationStats?.loopStatus;
  if (!STOPPED_LOOP_STATUSES.includes(loopStatus)) reject('iteration loop is not in a stopped state');

  const missionRelease = state.workflowRecovery?.resourceRelease;
  if (!missionRelease || typeof missionRelease !== 'object' || Array.isArray(missionRelease)) {
    reject('workflowRecovery.resourceRelease is missing');
  } else {
    if (missionRelease.confirmed !== true) reject('Mission resource release is not confirmed');
    if (missionRelease.status !== 'confirmed') reject('Mission resource release status is not confirmed');
    if (missionRelease.blocked === true) reject('Mission resource release is blocked');
    if (missionRelease.quarantined === true) reject('Mission resource release is quarantined');
    if (releasePending(missionRelease)) reject('Mission resource release is pending or unconfirmed');
    // The array is required; an empty array is admissible only because the release
    // itself is already explicitly confirmed above (nothing was pending).
    if (!Array.isArray(missionRelease.resources)) {
      reject('Mission resource release has no resources array');
    } else {
      for (const resource of missionRelease.resources) {
        if (!resource || typeof resource !== 'object' || Array.isArray(resource)) { reject('a Mission resource entry is malformed'); continue; }
        if (resource.confirmed !== true) reject('a Mission resource has no explicit confirmed release');
        if (releasePending(resource)) reject('a Mission resource release is pending or unconfirmed');
        if (resource.blocked === true) reject('a Mission resource release is blocked');
        if (resource.quarantined === true) reject('a Mission resource release is quarantined');
      }
    }
  }

  // A still-live current Agent run must be released too, and must belong to the
  // same Mission. A terminal Agent status alone is never release proof. An idle
  // placeholder Agent without a current run does not invent an execution
  // resource, so it must not require a fabricated Agent release.
  const agent = state.agent;
  if (agent !== undefined && agent !== null) {
    if (typeof agent !== 'object' || Array.isArray(agent)) {
      reject('current Agent state is malformed');
    } else {
      const agentRunId = isNonBlankText(agent.runId) ? agent.runId : '';
      if (agentRunId) {
        if (agent.missionId !== missionId) reject('current Agent run belongs to a foreign Mission');
        const agentRelease = agent.resourceRelease;
        if (!agentRelease || typeof agentRelease !== 'object' || Array.isArray(agentRelease)) {
          reject('current Agent has no explicit release proof');
        } else {
          if (agentRelease.confirmed !== true) reject('current Agent release is not confirmed');
          if (agentRelease.status !== 'confirmed') reject('current Agent release status is not confirmed');
          if (releasePending(agentRelease)) reject('current Agent release is pending or quarantined');
        }
        const barrier = resourceReleaseEvidence(state, { missionId, runId: agentRunId });
        if (!barrier.confirmed) reject('current Agent resource release barrier is unresolved');
      }
    }
  }

  // A confirmed Mission aggregate is not enough: the existing provider-neutral
  // cancellation contract must also prove that no other execution resource
  // (research Agent, baseline materializer, GPU test/benchmark) is still in a
  // cancellation/quarantine barrier.
  const resourceBarrier = resourceReleaseBarrier(state);
  if (resourceBarrier) {
    reject('an execution resource release barrier is still pending');
    if (resourceBarrier.quarantined === true) reject('an execution resource release is quarantined');
  }
  return { confirmed: reasons.length === 0, reasons };
};

// Overall attempt outcome from the per-family outcomes, never hiding a failure.
export const combineAttemptOutcome = ({ failure = null, timedOut = false, familyOutcomes = [] } = {}) => {
  const outcomes = familyOutcomes.filter(Boolean);
  if (failure) return timedOut ? 'timeout' : 'failure';
  if (!outcomes.length) return 'failure';
  if (outcomes.every((outcome) => outcome === 'full_success')) return 'full_success';
  if (outcomes.every((outcome) => outcome === 'full_success' || outcome === 'budget_terminal')
    && outcomes.some((outcome) => outcome === 'budget_terminal')) return 'budget_terminal';
  return 'failure';
};
