// Phase 3 controlled experience study — pure condition/audit contract.
//
// This module is pure and I/O-free: importing it never starts a Runtime, provider,
// model, CLI, GPU test or scheduler, and it never touches the filesystem, clock or
// network. It owns the frozen nine-slot schedule and the per-condition verification
// of a prepared-before-send prompt audit against the imported KernelWiki snapshot.
//
// Design authority: docs/development/EXPERIENCE_STUDY_CONTRACT.md section B and the
// author-frozen `verifyExperienceConditionAudit` signature. The condition interface
// itself (runtime `query.selection.experienceCondition` / OPERATOR_EXPERIENCE_CONDITION)
// is owned by writer A; this module only verifies what the production artifacts say.
//
// Every mode runs the same strict common facts checks (`verifyRoundFactsAudit`), so a
// facts-only candidate can never be verified with lost or tampered mandatory facts,
// and the default strict continuation verifier keeps requiring exactly one injected
// source-round execution experience.
import assert from 'node:assert/strict';
import { kernelWikiRecordId, validateKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';
import {
  bindSourceRoundExecutionExperience, canonicalJson, promptSection, verifyContinuationAudit, verifyRoundFactsAudit,
} from './shared-gpu-acceptance.mjs';

export const EXPERIENCE_STUDY_SCHEMA_VERSION = 'operator-studio.experience-condition-study/v1';

// Exact ordered condition vocabulary. The schedule rotates this order per block.
export const EXPERIENCE_CONDITIONS = Object.freeze(['facts-only', 'local-only', 'local-and-wiki']);
export const EXPERIENCE_STUDY_BLOCKS = 3;
export const EXPERIENCE_STUDY_SLOTS = EXPERIENCE_CONDITIONS.length * EXPERIENCE_STUDY_BLOCKS;

// Study-only goal policy. The suffix is identical for all conditions and is added
// only when an explicit study condition is configured; the default driver goal stays
// byte-identical to the unconfigured one.
export const EXPERIENCE_STUDY_GOAL_POLICY_VERSION = 'operator-studio.experience-study-goal/v1';
export const EXPERIENCE_STUDY_GOAL_SUFFIX = '在保持上述数值和测试约束的前提下，可以考虑向量化（vectorization）这一待验证方向；必须先确认访问合法性，不据此声称存在带宽瓶颈。';

// KernelWiki provenance constants. Imported units are human guidance: unverified,
// nonpublishable, and reviewed only for the architectures the review asserts.
export const KERNEL_WIKI_SOURCE = 'kernel-wiki';
export const KERNEL_WIKI_UNREVIEWED_MODE = 'unreviewed';
export const STUDY_WIKI_ARCHITECTURE = 'sm86';
export const STUDY_WIKI_HARDWARE = 'nvidia-gpu';

export const CONDITION_AUDIT_ASSERTIONS = Object.freeze([
  'the frozen selection audit records the exact explicit study condition',
  'the audited prompt is the authority: its parsed UNTRUSTED EXPERIENCE DATA items and versions equal the audited selection sidecar',
  'every audited selection entry has an item in the actual prompt and vice versa',
  'all modes retain the complete strict round-facts and candidate/queue bindings',
]);

/**
 * The frozen nine-slot balanced schedule. `buildStudySchedule()` is deterministic and
 * returns exactly nine entries: per block the condition order rotates left by one, so
 * every condition appears once per block and three times overall.
 */
export const buildStudySchedule = () => {
  const schedule = [];
  for (let block = 1; block <= EXPERIENCE_STUDY_BLOCKS; block += 1) {
    for (let offset = 0; offset < EXPERIENCE_CONDITIONS.length; offset += 1) {
      const condition = EXPERIENCE_CONDITIONS[(block - 1 + offset) % EXPERIENCE_CONDITIONS.length];
      schedule.push(Object.freeze({ index: (block - 1) * EXPERIENCE_CONDITIONS.length + offset + 1, block, condition }));
    }
  }
  return schedule;
};

const isNonBlankText = (value) => typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringList = (value) => (Array.isArray(value) ? value.filter(isNonBlankText) : []);

/**
 * Validate an imported KernelWiki snapshot and derive its frozen identity. The
 * snapshot envelope digest is recomputed by the production validator, so a tampered
 * or truncated file can never be used as a study source.
 */
export const studySnapshotIdentity = (snapshot) => {
  const validated = validateKernelWikiSnapshot(snapshot);
  const reviewedSm86UnitIds = validated.units
    .filter((unit) => isReviewedWikiMetadata(unit.selectionMetadata)
      && stringList(unit.selectionMetadata.applicability.architectures).includes(STUDY_WIKI_ARCHITECTURE))
    .map((unit) => unit.unitId);
  return {
    schemaVersion: validated.schemaVersion,
    sourceCommit: validated.sourceCommit,
    snapshotDigest: validated.snapshotDigest,
    unitCount: validated.units.length,
    reviewedSm86UnitIds,
  };
};

// The explicit condition is recorded on the frozen selection audit. Both the
// projection the Runtime delivers to the prompt audit and a top-level audit field are
// read; when more than one is present they must agree, and nothing is inferred.
export const auditExperienceCondition = (audit) => {
  const values = [audit?.selection?.experienceCondition, audit?.experienceCondition]
    .filter((value) => value !== undefined && value !== null);
  if (!values.length) return null;
  for (const value of values) {
    assert.equal(value, values[0],
      'audited experience condition is recorded inconsistently between the selection audit and the prompt audit');
  }
  return values[0];
};

const metadataOf = (item) => (isPlainObject(item) ? item.selectionMetadata : null);
const isWikiItem = (item) => metadataOf(item)?.source === KERNEL_WIKI_SOURCE;
const isReviewedWikiMetadata = (metadata) => isPlainObject(metadata)
  && metadata.source === KERNEL_WIKI_SOURCE
  && isPlainObject(metadata.applicability)
  && metadata.applicability.mode !== KERNEL_WIKI_UNREVIEWED_MODE
  && isNonBlankText(metadata.applicability.reviewId);

const assertHumanGuidanceShape = (item) => {
  assert.equal(item.source, 'human', 'an imported KernelWiki unit must stay human guidance');
  assert.equal(item.kind, 'guidance', 'an imported KernelWiki unit must stay guidance');
  assert.equal(item.status, 'active', 'a selected KernelWiki unit must be active');
  assert.ok(isPlainObject(item.verification), 'a selected KernelWiki unit must carry its verification block');
  assert.equal(item.verification.status, 'unverified', 'KernelWiki guidance must stay unverified');
  assert.equal(item.verification.publishable, false, 'KernelWiki guidance must stay nonpublishable');
  assert.equal(item.verification.evidenceClass, 'human-guidance', 'KernelWiki guidance must stay human guidance evidence class');
};

// Metadata fields whose canonical form differs between two objects. The union of
// both key sets is compared, so an extra field the imported unit does not have is
// just as visible as a missing or altered one; naming the differing fields keeps a
// forged/mixed provenance entry reviewable instead of just "not equal".
const mismatchedMetadataFields = (actual, expected) => [...new Set([
  ...Object.keys(expected), ...Object.keys(actual ?? {}),
])].filter((key) => canonicalJson(actual?.[key]) !== canonicalJson(expected[key]));

// Bind one selected KernelWiki prompt item to the imported snapshot. The record id
// must be the canonical per-project KernelWiki record id of a snapshot unit, the
// sourceCommit/unitDigest must resolve to exactly one unit, and the item's COMPLETE
// selection metadata plus title/content must be that unit's — identity, version,
// provenance, digests and review applicability field for field. A sidecar-only,
// partially forged or re-reviewed identity cannot satisfy this.
const bindWikiItem = ({ item, snapshot, projectId }) => {
  const metadata = metadataOf(item);
  assert.ok(isPlainObject(metadata), 'a selected KernelWiki item must carry its selection metadata');
  assert.ok(isNonBlankText(item.id), 'a selected KernelWiki item must carry its record id');
  assert.ok(Number.isSafeInteger(item.version) && item.version >= 1,
    'a selected KernelWiki item must carry a positive integer version');
  assert.equal(metadata.source, KERNEL_WIKI_SOURCE, 'a KernelWiki item must declare its kernel-wiki source');
  const matches = snapshot.units.filter((unit) => unit.selectionMetadata.unitDigest === metadata.unitDigest);
  assert.equal(matches.length, 1,
    `selected KernelWiki unitDigest must match exactly one imported snapshot unit (found ${matches.length})`);
  const unit = matches[0];
  // Every metadata field of the actual prompt item must be the imported unit's own
  // value: source/page/source path/type/topics/symptoms/techniques/architectures and
  // the review applicability block (mode, reviewId, hardware, architectures,
  // requiredCapabilities, software). Nothing is read from the selection sidecar.
  const mismatched = mismatchedMetadataFields(metadata, unit.selectionMetadata);
  assert.ok(mismatched.length === 0,
    `selected KernelWiki item metadata does not match the imported snapshot unit ${unit.unitId}: ${mismatched.join(', ')}`);
  // The record id is derived from the unit id, and the unit id is the page id only
  // for a raw page. A reviewed transfer is its own stable unit
  // (`<pageId>-transfer-<reviewId>`), so binding it to the bare page id would make
  // exactly the units a study needs unverifiable. This mirrors the production
  // importer's unit ownership rule (`unitIdentity`).
  if (metadata.applicability.mode === 'reviewed-transfer') {
    assert.equal(unit.unitId, `${metadata.pageId}-transfer-${metadata.applicability.reviewId}`,
      'a reviewed-transfer unit must be bound to its page id and review id');
  } else {
    assert.equal(unit.unitId, metadata.pageId,
      `a ${metadata.applicability.mode} unit must have the imported page id as its unit id`);
  }
  assert.equal(item.title, unit.title, 'actual prompt KernelWiki title must equal the imported snapshot unit');
  assert.equal(item.content, unit.content,
    'actual prompt KernelWiki content must equal the complete imported snapshot unit content');
  assert.equal(item.id, kernelWikiRecordId(projectId, unit.unitId),
    'selected KernelWiki record id must be the canonical record id of the imported unit for this project');
  assertHumanGuidanceShape(item);
  assert.ok(isReviewedWikiMetadata(metadata),
    `selected KernelWiki unit ${unit.unitId} must carry a reviewed applicability (unreviewed units are never injected)`);
  const architectures = stringList(metadata.applicability.architectures);
  const hardware = stringList(metadata.applicability.hardware);
  assert.ok(architectures.includes(STUDY_WIKI_ARCHITECTURE),
    `selected KernelWiki unit ${unit.unitId} must be reviewed for ${STUDY_WIKI_ARCHITECTURE}`);
  assert.ok(hardware.includes(STUDY_WIKI_HARDWARE),
    `selected KernelWiki unit ${unit.unitId} must be reviewed for ${STUDY_WIKI_HARDWARE}`);
  return {
    recordId: item.id,
    version: item.version,
    unitId: unit.unitId,
    pageId: metadata.pageId,
    sourceCommit: metadata.sourceCommit,
    sourcePath: metadata.sourcePath,
    sourceDigest: metadata.sourceDigest,
    unitDigest: metadata.unitDigest,
    reviewId: metadata.applicability.reviewId,
    mode: metadata.applicability.mode,
    architectures,
    hardware,
  };
};

// The audited `sources` list is a sidecar. It must correspond ONE TO ONE with the
// KernelWiki items the actual prompt carries: no sidecar-only identity, no
// duplicate entry, no dropped Wiki item and no borrowed identity from another
// (non-Wiki) record with the same id/version.
const assertWikiSourcesMatchPrompt = ({ selection, promptItems, promptContext }) => {
  const sources = selection.sources === undefined ? [] : selection.sources;
  assert.ok(Array.isArray(sources), 'audited selection sources must be an array when present');
  const wikiKeys = new Set();
  for (const item of promptContext.items) {
    if (!isWikiItem(item)) continue;
    const key = `${item.id}@${item.version}`;
    assert.ok(!wikiKeys.has(key), `actual prompt carries KernelWiki item ${key} more than once`);
    wikiKeys.add(key);
  }
  const seen = new Set();
  for (const source of sources) {
    assert.ok(isPlainObject(source), 'every audited selection source must be an object');
    const key = `${source.recordId}@${source.version}`;
    assert.ok(!seen.has(key), `audited selection lists KernelWiki source ${key} more than once`);
    seen.add(key);
    const item = promptItems.get(key);
    assert.ok(item, `audited selection source ${key} has no item in the actual prompt`);
    assert.ok(isWikiItem(item), `audited selection source ${key} is not an actual KernelWiki prompt item`);
    const metadata = metadataOf(item);
    for (const field of ['unitDigest', 'sourceCommit', 'sourcePath', 'sourceDigest', 'pageId']) {
      assert.equal(metadata[field], source[field],
        `audited selection source ${key} ${field} does not match the actual prompt item`);
    }
  }
  for (const key of wikiKeys) {
    assert.ok(seen.has(key), `actual prompt KernelWiki item ${key} is missing from the audited selection sources`);
  }
  return [...seen];
};

/**
 * Verify one invocation's prepared-before-send audit for an explicit study condition.
 *
 * All modes run the same strict common facts checks and require the actual prompt to
 * agree with the audited selection sidecar. Returns a serializable receipt (condition,
 * snapshot identity, bound source-round experience, selected Wiki identities) and
 * throws on any mismatch. Nothing is synthesized and no sidecar count is trusted.
 */
export const verifyExperienceConditionAudit = ({
  condition, audit, sourceRound, experiences, missionId, projectId, snapshot,
} = {}) => {
  assert.ok(EXPERIENCE_CONDITIONS.includes(condition),
    `unknown experience condition: ${String(condition)} (expected one of ${EXPERIENCE_CONDITIONS.join(', ')})`);
  assert.ok(isPlainObject(audit), 'condition audit artifact is required');
  assert.ok(isPlainObject(snapshot), 'the imported KernelWiki snapshot is required');
  const snapshotIdentity = studySnapshotIdentity(snapshot);

  // Strict, condition-independent facts: identity, prompt digest/bytes, frozen source
  // archive equality, the prompt's own MISSION ITERATION CONTEXT and the candidate /
  // durable queue binding.
  const factsReceipt = verifyRoundFactsAudit({ audit, sourceRound, missionId, projectId });
  assert.equal(auditExperienceCondition(audit), condition,
    `audited experience condition ${JSON.stringify(auditExperienceCondition(audit))} is not the scheduled ${condition}`);

  const selection = audit.selection;
  assert.ok(isPlainObject(selection), 'audited experience selection sidecar is required');
  const promptContext = promptSection(audit.prompt, 'UNTRUSTED EXPERIENCE DATA');
  assert.ok(Array.isArray(promptContext.items), 'actual prompt experience items must be an array');
  assert.ok(Array.isArray(selection.selected), 'audited selection must list its selected entries');
  assert.equal(promptContext.contextId, selection.contextId,
    'actual prompt context id must equal the audited selection context id');
  assert.equal(promptContext.items.length, selection.selected.length,
    'actual prompt items and audited selection entries must have the same length');

  // The actual prompt is the authority: every selection entry must be present in it
  // (and nothing else may be), with the same version and origin.
  const promptItems = new Map();
  for (const item of promptContext.items) {
    assert.ok(isPlainObject(item) && isNonBlankText(item.id) && Number.isInteger(item.version),
      'every actual prompt experience item must carry an id and integer version');
    const key = `${item.id}@${item.version}`;
    assert.ok(!promptItems.has(key), `actual prompt carries ${key} more than once`);
    promptItems.set(key, item);
  }
  for (const entry of selection.selected) {
    const item = promptItems.get(`${entry.id}@${entry.version}`);
    assert.ok(item, `audited selection entry ${entry.id}@${entry.version} has no item in the actual prompt`);
    assert.equal(item.source, entry.source, `selected experience ${entry.id} origin does not match the actual prompt`);
  }
  assert.deepEqual(promptContext.versions,
    Object.fromEntries(selection.selected.map((entry) => [entry.id, entry.version])),
    'actual prompt version map must equal the audited selection versions');

  // The audited `sources` list is a sidecar and must correspond one to one with the
  // KernelWiki items the actual prompt carries (see assertWikiSourcesMatchPrompt).
  const auditedSourceKeys = assertWikiSourcesMatchPrompt({ selection, promptItems, promptContext });

  const wikiItems = promptContext.items.filter(isWikiItem);
  const base = {
    schemaVersion: EXPERIENCE_STUDY_SCHEMA_VERSION,
    condition,
    missionId,
    projectId,
    snapshot: snapshotIdentity,
    facts: factsReceipt.facts,
    sourceRound: factsReceipt.sourceRound,
    audit: { roundId: factsReceipt.roundId, runId: factsReceipt.runId,
      promptDigest: factsReceipt.promptDigest, promptBytes: factsReceipt.promptBytes },
    promptItemCount: promptContext.items.length,
    selectedCount: selection.selected.length,
    auditedSources: auditedSourceKeys,
  };

  if (condition === 'facts-only') {
    // Zero optional experience of either source. The source-round execution
    // experience must still have been durably collected (it is simply not injected),
    // otherwise a lost collection would look identical to a valid zero selection.
    assert.equal(promptContext.items.length, 0, 'facts-only prompt must carry zero experience items');
    assert.equal(selection.selected.length, 0, 'facts-only selection must select zero experience entries');
    assert.deepEqual(promptContext.versions, {}, 'facts-only prompt must carry an empty version map');
    assert.ok(!Array.isArray(selection.sources) || selection.sources.length === 0,
      'facts-only selection must not report KernelWiki sources');
    const collected = bindSourceRoundExecutionExperience({ experiences, sourceRound, missionId });
    assert.equal(collected.length, 1,
      `facts-only requires the source-round candidate execution experience to be durably collected (found ${collected.length})`);
    return {
      ...base,
      selectedWiki: [],
      collectedExperience: {
        id: collected[0].id,
        version: collected[0].version,
        source: collected[0].source,
        evidenceCandidateId: collected[0].evidence.candidateId,
        evidenceRunId: collected[0].evidence.runId,
      },
      injectedExperience: null,
      wikiRequired: false,
      assertions: [...CONDITION_AUDIT_ASSERTIONS, 'facts-only selected zero experience while the source-round execution experience was durably collected'],
    };
  }

  // local-only and local-and-wiki keep the original strict continuation contract: the
  // source-round candidate execution experience is uniquely bound AND injected with its
  // complete unchanged content.
  const strict = verifyContinuationAudit({ audit, sourceRound, experiences, missionId, projectId });

  if (condition === 'local-only') {
    for (const item of promptContext.items) {
      assert.ok(!isWikiItem(item),
        `local-only prompt must not carry KernelWiki experience (found ${item.id})`);
    }
    return {
      ...base,
      selectedWiki: [],
      injectedExperience: strict.selectedExperience,
      wikiRequired: false,
      assertions: [...CONDITION_AUDIT_ASSERTIONS,
        'local-only excludes every KernelWiki record while keeping the D ranking for applicable local records',
        'the source-round candidate execution experience is uniquely bound and fully injected'],
    };
  }

  // local-and-wiki: the unchanged D selection, with at least one reviewed sm86
  // KernelWiki unit bound to the imported snapshot and carried in full by the prompt.
  assert.ok(wikiItems.length >= 1,
    'local-and-wiki requires at least one selected KernelWiki unit in the actual prompt');
  const selectedWiki = wikiItems.map((item) => bindWikiItem({ item, snapshot, projectId }));
  assert.ok(selectedWiki.some((identity) => identity.architectures.includes(STUDY_WIKI_ARCHITECTURE)),
    `local-and-wiki requires at least one reviewed ${STUDY_WIKI_ARCHITECTURE} KernelWiki unit`);
  return {
    ...base,
    selectedWiki,
    injectedExperience: strict.selectedExperience,
    wikiRequired: true,
    assertions: [...CONDITION_AUDIT_ASSERTIONS,
      'local-and-wiki keeps the unchanged D selection and additionally binds every selected KernelWiki unit to the imported snapshot'],
  };
};
