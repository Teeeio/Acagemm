// Independent acceptance matrix for PHASE3_WIKI_CONTRACT.md sections A and D:
// optional version-bound selection metadata plus the deterministic
// optimization-hypothesis selector and its retrieval path.
//
// The selector itself is pure. Everything else runs against the real experience
// repository (atomic file store), the real experience contract retrieval and the
// real HTTP application API used as the only writer of selection metadata. No
// Runtime, provider, model, network, Python or GPU process is started.
//
// This file was written before the parallel A/B candidates were combined; until
// the combination provides `client-runtime/experience-selection.mjs` and the
// selection-aware retrieval/import path it can only be syntax-checked, and the
// author phase runs `node --check` only. A green run after combination is
// contract/integration evidence for the frozen interface: it is software
// correctness, not a claim about selection benefit, model quality, GPU behaviour
// or the historical strict N20.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExperienceRepository } from '../client-runtime/experience-repository.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { createExperienceApiService } from '../client-runtime/application/experience-api-service.mjs';
import {
  validateExperienceStore, formatExperienceContext,
  EXPERIENCE_SELECTION_POLICY_VERSION, EXPERIENCE_SELECTION_SCHEMA_VERSION, EXPERIENCE_LIMITS,
} from '../client-runtime/experience-contract.mjs';
import { buildKernelWikiSnapshot, applyKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';
import { WIKI_SELECTION_POLICY_VERSION, normalizeSelectionMetadata, rankExperienceCandidates } from '../client-runtime/experience-selection.mjs';
import { evaluateDiagnosticEvidence, DIAGNOSTIC_REASONS } from '../client-runtime/evidence-decision.mjs';

const SOURCE_COMMIT = 'b6b4301f15e8ce6955a56776690643ce5db369e6';
const PROJECT = 'project-a';
const SOFT_RENDER_BYTES = 24 * 1024;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-selection-test-'));
const CLOCK_BASE = '2026-09-15T00:00:00.000Z';
let clock = CLOCK_BASE;
const now = () => clock;
const advance = (seconds = 60) => { clock = new Date(Date.parse(clock) + seconds * 1000).toISOString(); };
let passed = 0;
let failed = 0;
// Every independent case is isolated: the clock restarts, a failure is reported
// with its own name and stack, and the remaining cases still run so one
// combination collects every error instead of only the first. Any failed case
// makes the file exit non-zero, so a partial run is never reported as green.
const test = async (name, run) => {
  clock = CLOCK_BASE;
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};
// A rejected operation must fail for its own rule with an explicit domain error
// code, never with an unrelated TypeError or an assertion raised by a broken
// fixture. The selection module's own code names are not frozen by the contract,
// so this pins the code kind; the frozen domain codes are asserted exactly where
// the existing experience contract already fixes them.
const codedFailure = (error) => {
  assert.ok(error instanceof Error, `a rejected operation must throw an Error, saw ${String(error)}`);
  assert.match(String(error?.code ?? ''), /^[A-Z][A-Z0-9_]+$/u, `a rejected operation must carry an explicit domain error code, saw ${JSON.stringify(error?.code)}`);
  return true;
};

const target = (overrides = {}) => ({ hardware: ['nvidia-gpu'], architecture: ['sm86'], capabilities: [], software: [], ...overrides });
const features = (...list) => list;
const selection = (overrides = {}) => ({ policyVersion: WIKI_SELECTION_POLICY_VERSION, features: [], target: target(), ...overrides });
const query = (overrides = {}) => ({
  projectId: PROJECT, missionId: 'mission-1', roundId: 'mission-1:round:1',
  scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
  ...overrides,
});
// A bounded, valid feature that matches nothing: it keeps the request on the
// documented path without pulling any Wiki unit into the result.
const noMatch = () => ({ kind: 'technique', value: 'tech-none', basis: 'Unverified direction; no Wiki unit is expected to match.' });
const headList = (records) => [...new Map(records.map((record) => [record.id, record])).values()];
const idsOf = (entries) => entries.map((entry) => entry.id);
const indexOfId = (entries, id) => idsOf(entries).indexOf(id);
const titleOf = (records, title) => {
  const record = records.find((item) => item.title === title);
  assert.ok(record, `expected a stored record titled ${title}`);
  return record;
};
const ranks = (records, options) => rankExperienceCandidates(records, { target: target(), ...options });
// The audit's container for per-selected-unit snapshot identity is not frozen
// (it may be a source list, a map keyed by record id, or fields on the selected
// entries themselves), but the audited facts are: every selected unit names its
// own record identity and its own source commit/digest, so two selected units
// can never collapse into one audited source identity.
const sourceEntryId = (entry) => entry?.recordId ?? entry?.id ?? entry?.experienceId ?? null;
const sourceEntryDigest = (entry) => entry?.unitDigest ?? entry?.digest ?? null;
const sourceEntries = (audit) => {
  const found = [];
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (sourceEntryId(value) !== null) found.push(value);
    for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  visit(audit, 0);
  return found;
};
// The selected source identity of one record: the audited entry that names this
// record and carries a source digest.
const auditedSourceOf = (audit, record) => sourceEntries(audit)
  .find((entry) => sourceEntryId(entry) === record.id && typeof sourceEntryDigest(entry) === 'string');

// --- KernelWiki source pages; the production importer is the only writer of selection metadata ---
const list = (values) => `[${values.map((value) => `"${value}"`).join(', ')}]`;
const block = (key, values) => (values.length ? [`${key}:`, ...values.map((value) => `  - ${value}`)] : [`${key}: []`]);
const page = ({ id, title, type = 'technique', tags = [], symptoms = [], techniques = [], architectures = [], body = 'Reviewed guidance body.' }) => ({
  path: `wiki/techniques/${id}.md`,
  text: [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    `type: ${type}`,
    `tags: ${list(tags)}`,
    ...block('symptoms', symptoms),
    ...block('candidate_techniques', techniques),
    ...block('architectures', architectures),
    'performance_claims:',
    '  speedup: "1.4x"',
    '  nested:',
    '    verified: true',
    '    note: "upstream claim, never selection input"',
    '---',
    '',
    body,
    '',
  ].join('\n'),
});
const review = (pageId, reviewId, architectures, overrides = {}) => ({
  pageId, reviewId, mode: 'architecture-specific',
  hardware: ['nvidia-gpu'], architectures, requiredCapabilities: [], software: [], ...overrides,
});
const archReview = (pageId) => review(pageId, `review-sm86-${pageId}`, ['sm86']);
const transferReview = (pageId, content) => review(pageId, `review-transfer-${pageId}`, ['sm86'], {
  mode: 'reviewed-transfer', content,
});
const setup = async (name, { pages = [], reviews = [], projectId = PROJECT } = {}) => {
  const rootDir = path.join(scratch, name);
  const repository = createExperienceRepository({ rootDir });
  let snapshot = null;
  if (pages.length > 0) {
    snapshot = buildKernelWikiSnapshot({ pages, sourceCommit: SOURCE_COMMIT, reviews });
    await repository.transact((draft) => applyKernelWikiSnapshot(draft, snapshot, { projectId, now: now(), author: 'phase3-import' }));
  }
  const service = createExperienceService({ repository, now, createId: () => `EXP-${randomUUID()}` });
  return { rootDir, repository, service, snapshot, file: path.join(rootDir, 'experiences.json'), store: await repository.read() };
};
const currentRecords = async (service) => (await service.read(null, { projectId: PROJECT })).experiences;
const createLocal = (service, title, overrides = {}) => service.create({
  projectId: PROJECT, visibility: 'project', title,
  content: `Local observation: ${title}.`, author: 'tester',
  scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] }, ...overrides,
});

const baseMetadata = () => ({
  source: 'kernel-wiki',
  sourceCommit: SOURCE_COMMIT,
  sourcePath: 'wiki/techniques/tail-handling.md',
  pageId: 'tail-handling',
  sourceDigest: 'a'.repeat(64),
  unitDigest: 'b'.repeat(64),
  type: 'technique',
  topics: ['vectorization'],
  symptoms: ['tail-effect'],
  candidateTechniques: ['masked-tail-loop'],
  architectures: ['sm86'],
  applicability: {
    mode: 'architecture-specific', reviewId: 'review-sm86-tail-handling',
    hardware: ['nvidia-gpu'], architectures: ['sm86'], requiredCapabilities: [], software: [],
  },
});
const metadataApplicability = (overrides) => ({ ...baseMetadata(), applicability: { ...baseMetadata().applicability, ...overrides } });
const diagnosticDigest = (character) => character.repeat(64);
// The complete, schema-valid tracer envelope: every negative case below mutates
// exactly one aspect of it, so it fails on its intended branch.
const tracerEnvelope = (overrides = {}) => ({
  format: 'operator-trace/v1', status: 'completed', source: 'mctracer', simulated: false,
  binding: { candidateDigest: diagnosticDigest('c'), runId: 'run-1' },
  artifacts: ['artifacts/mctracer/stdout.json'],
  events: [{ category: 'kernel', name: 'vector_add_kernel', startUs: 0, durationUs: 12.5 }],
  ...overrides,
});
const tracerBinding = { candidateDigest: diagnosticDigest('c'), runId: 'run-1' };

try {
  await test('the D selection policy version is the frozen value', async () => {
    assert.equal(WIKI_SELECTION_POLICY_VERSION, 'operator-studio.optimization-hypothesis-selection/v1');
    assert.notEqual(WIKI_SELECTION_POLICY_VERSION, EXPERIENCE_SELECTION_POLICY_VERSION);
  });

  await test('selection metadata is canonical, bounded, and rejects malformed or unsafe values', async () => {
    const normalized = normalizeSelectionMetadata(baseMetadata());
    const metadataKeys = ['applicability', 'architectures', 'candidateTechniques', 'pageId', 'source', 'sourceCommit', 'sourceDigest', 'sourcePath', 'symptoms', 'topics', 'type', 'unitDigest'];
    const applicabilityKeys = ['architectures', 'hardware', 'mode', 'requiredCapabilities', 'reviewId', 'software'];
    assert.deepEqual(Object.keys(normalized).filter((key) => !metadataKeys.includes(key)), [], 'metadata carries no key outside the frozen set');
    for (const key of ['source', 'sourceCommit', 'sourcePath', 'pageId', 'sourceDigest', 'unitDigest', 'type', 'applicability']) assert.ok(Object.hasOwn(normalized, key), `metadata keeps ${key}`);
    for (const key of ['topics', 'symptoms', 'candidateTechniques', 'architectures']) assert.ok(normalized[key] === undefined || Array.isArray(normalized[key]), `${key} stays a bounded array`);
    assert.deepEqual(Object.keys(normalized.applicability).filter((key) => !applicabilityKeys.includes(key)), []);
    for (const key of ['mode', 'reviewId', 'hardware', 'architectures']) assert.ok(Object.hasOwn(normalized.applicability, key), `applicability keeps ${key}`);
    assert.equal(normalized.source, 'kernel-wiki');
    assert.equal(normalized.sourceCommit, SOURCE_COMMIT);
    assert.equal(normalized.pageId, 'tail-handling');
    assert.equal(normalized.applicability.mode, 'architecture-specific');
    assert.equal(normalized.applicability.reviewId, 'review-sm86-tail-handling');
    // Duplicate array entries must never survive normalization (accepted either by
    // de-duplication or by an explicit rejection).
    const deduped = (() => {
      try { return normalizeSelectionMetadata({ ...baseMetadata(), topics: ['vectorization', 'vectorization', 'tiling'] }).topics; }
      catch { return ['vectorization', 'tiling']; }
    })();
    assert.equal(new Set(deduped).size, deduped.length);
    const unreviewed = normalizeSelectionMetadata(metadataApplicability({ mode: 'unreviewed', reviewId: null, architectures: [] }));
    assert.equal(unreviewed.applicability.mode, 'unreviewed');
    assert.equal(unreviewed.applicability.reviewId, null);

    // Each negative is the complete valid metadata with one aspect broken.
    const invalid = {
      'unknown key': { ...baseMetadata(), confidence: 0.87 },
      'unknown source': { ...baseMetadata(), source: 'vendor-blog' },
      'uppercase commit': { ...baseMetadata(), sourceCommit: SOURCE_COMMIT.toUpperCase() },
      'short commit': { ...baseMetadata(), sourceCommit: 'b6b4301f' },
      'path escape': { ...baseMetadata(), sourcePath: 'wiki/../secret.md' },
      'path outside wiki': { ...baseMetadata(), sourcePath: 'docs/page.md' },
      'absolute path': { ...baseMetadata(), sourcePath: '/etc/wiki/page.md' },
      'unsafe page id': { ...baseMetadata(), pageId: 'bad id!' },
      'bad source digest': { ...baseMetadata(), sourceDigest: 'z'.repeat(64) },
      'short unit digest': { ...baseMetadata(), unitDigest: 'b'.repeat(63) },
      'too many topics': { ...baseMetadata(), topics: Array.from({ length: 33 }, (_, index) => `topic-${index}`) },
      'oversized topic': { ...baseMetadata(), topics: ['x'.repeat(161)] },
      'empty type': { ...baseMetadata(), type: '   ' },
      'unknown mode': metadataApplicability({ mode: 'verified' }),
      'transfer without review': metadataApplicability({ mode: 'reviewed-transfer', reviewId: null }),
      'unreviewed with review': metadataApplicability({ mode: 'unreviewed', reviewId: 'review-1' }),
      'architecture-specific without architecture': metadataApplicability({ mode: 'architecture-specific', architectures: [] }),
      'reviewed transfer without target architecture': metadataApplicability({ mode: 'reviewed-transfer', reviewId: 'review-1', architectures: [] }),
      'missing applicability': { ...baseMetadata(), applicability: undefined },
      'array instead of object': [baseMetadata()],
      'null': null,
    };
    for (const [label, value] of Object.entries(invalid)) assert.throws(() => normalizeSelectionMetadata(value), codedFailure, `${label} must fail explicitly`);
    // Unreviewed metadata is legal but its reviewId must be null; sm80 is never
    // inferred to satisfy sm86, so a foreign architecture stays a foreign value.
    const sm100 = normalizeSelectionMetadata(metadataApplicability({ mode: 'architecture-specific', reviewId: 'review-sm100', architectures: ['sm100'] }));
    assert.deepEqual(sm100.applicability.architectures, ['sm100']);
  });

  await test('generic create/update reject selectionMetadata and schema-1 records stay byte-compatible', async () => {
    const { service, repository, file } = await setup('metadata-entry');
    const api = createExperienceApiService({ loadState: async () => ({ projects: [{ id: PROJECT }, { id: 'project-b' }] }), experiences: service });
    const created = await createLocal(service, 'Plain guidance');
    assert.equal(Object.hasOwn(created.experience, 'selectionMetadata'), false, 'absent metadata is omitted, never null-filled');
    const bytesBefore = await fs.readFile(file, 'utf8');
    await assert.rejects(api.create(PROJECT, {
      title: 'Smuggled metadata', content: 'Not through the import API.', author: 'tester',
      selectionMetadata: baseMetadata(),
    }), (error) => error.code === 'EXPERIENCE_INVALID', 'the generic HTTP create path must reject selectionMetadata');
    await assert.rejects(api.update(PROJECT, created.experience.id, {
      selectionMetadata: baseMetadata(), expectedVersion: created.experience.version,
    }), (error) => error.code === 'EXPERIENCE_INVALID', 'the generic HTTP update path must reject selectionMetadata');
    // The rejection belongs to the domain write path, not to an HTTP-layer field
    // filter: the generic service port refuses the same property directly.
    await assert.rejects(service.create({
      projectId: PROJECT, visibility: 'project', title: 'Smuggled service metadata',
      content: 'Not through the import API.', author: 'tester', selectionMetadata: baseMetadata(),
    }), (error) => error.code === 'EXPERIENCE_INVALID', 'the generic service create path must reject selectionMetadata');
    await assert.rejects(service.update(created.experience.id, { selectionMetadata: baseMetadata() }, {
      projectId: PROJECT, expectedVersion: created.experience.version,
    }), (error) => error.code === 'EXPERIENCE_INVALID', 'the generic service update path must reject selectionMetadata');
    assert.equal(await fs.readFile(file, 'utf8'), bytesBefore, 'a rejected generic write changes nothing');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(JSON.stringify(raw).includes('selectionMetadata'), false);
    validateExperienceStore(raw);
    // The explicit import path is the entry: after combination it is the only
    // writer that stores metadata, and it keeps the schema-1 store shape.
    const wikiPage = page({ id: 'tail-handling', title: 'Imported page', tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'] });
    const snapshot = buildKernelWikiSnapshot({ pages: [wikiPage], sourceCommit: SOURCE_COMMIT, reviews: [archReview('tail-handling')] });
    await service.importKernelWiki(snapshot, { projectId: PROJECT, author: 'phase3-import' });
    const imported = (await currentRecords(service)).find((record) => record.title === 'Imported page');
    assert.ok(imported, 'the import API stores the page');
    assert.equal(imported.selectionMetadata.source, 'kernel-wiki', 'the import API is the metadata entry');
    assert.equal((await repository.read()).schemaVersion, 1, 'the store schema stays 1 after an import');
    const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(migrated.schemaVersion, 1);
    assert.equal(migrated.records.find((record) => record.id === created.experience.id).selectionMetadata, undefined, 'historical records keep their exact shape');
    validateExperienceStore(migrated);
  });

  await test('a query without selection keeps legacy ordering, policy version and frozen-context validity', async () => {
    const { service, repository } = await setup('legacy-ordering');
    const first = await createLocal(service, 'Oldest guidance');
    advance(); const second = await createLocal(service, 'Middle guidance');
    advance(); const third = await createLocal(service, 'Newest guidance');
    const legacy = await service.retrieveWithSelection(query());
    assert.deepEqual(idsOf(legacy.context.items), [third.experience.id, second.experience.id, first.experience.id]);
    assert.equal(legacy.selection.policyVersion, EXPERIENCE_SELECTION_POLICY_VERSION);
    assert.equal(legacy.selection.schemaVersion, EXPERIENCE_SELECTION_SCHEMA_VERSION);
    assert.equal(legacy.selection.requestedLimit, 8, 'the legacy default limit is preserved exactly');
    validateExperienceStore(await repository.read());
    // A frozen round context assembled by the legacy path must still render and
    // validate with zero migration.
    const rendered = formatExperienceContext(legacy.context, { projectId: PROJECT, missionId: 'mission-1', roundId: 'mission-1:round:1' });
    assert.match(rendered, /BEGIN UNTRUSTED EXPERIENCE DATA/);
    await assert.rejects(
      service.retrieveWithSelection(query({ selection: { ...selection(), policyVersion: 'operator-studio.experience-selection/v0' } })),
      codedFailure,
      'an unknown selection policy version must be rejected, not silently downgraded',
    );
  });

  await test('selection retrieval ranks local experience first and enforces the default D quotas without padding', async () => {
    // TEAM_HANDOFF 8.3: `wiki/patterns/` pages are symptom-indexed ("symptom ->
    // candidate techniques"), so a `type: pattern` page belongs to the symptom
    // bucket and its `candidate_techniques` are a one-hop source - never a
    // technique unit of its own and never guidance.
    const pages = [
      page({ id: 'symptom-tail', title: 'Tail symptom page', type: 'symptom', symptoms: ['tail-effect'], techniques: ['tech-1', 'tech-2', 'tech-3'], architectures: ['sm86'] }),
      page({ id: 'tech-alpha', title: 'Technique alpha page', tags: ['tech-1'], architectures: ['sm86'] }),
      page({ id: 'tech-beta', title: 'Technique beta page', tags: ['tech-2'], architectures: ['sm86'] }),
      page({ id: 'tech-gamma', title: 'Technique gamma page', tags: ['tech-3'], architectures: ['sm86'] }),
      page({ id: 'guide-one', title: 'Guidance one page', type: 'guidance', tags: ['guide'], architectures: ['sm86'] }),
      page({ id: 'guide-two', title: 'Guidance two page', type: 'guidance', tags: ['guide'], architectures: ['sm86'] }),
      page({ id: 'pattern-one', title: 'Pattern one page', type: 'pattern', tags: ['tech-4'], symptoms: ['tail-effect'], techniques: ['tech-4'], architectures: ['sm86'] }),
      page({ id: 'tech-four', title: 'Technique four page', tags: ['tech-4'], architectures: ['sm86'] }),
      page({ id: 'unreviewed-page', title: 'Unreviewed page', tags: ['tech-9'], architectures: ['sm86'] }),
    ];
    const reviews = ['symptom-tail', 'tech-alpha', 'tech-beta', 'tech-gamma', 'guide-one', 'guide-two', 'pattern-one', 'tech-four'].map(archReview);
    const { service } = await setup('quotas', { pages, reviews });
    for (let index = 0; index < 6; index += 1) { advance(); await createLocal(service, `Local record ${index}`); }
    const records = await currentRecords(service);
    assert.equal(records.length, 15);
    const byId = new Map(records.map((record) => [record.id, record]));
    // The quota a stored Wiki unit is charged against follows its page type:
    // technique stays technique, pattern/symptom are the symptom bucket, and
    // every other Wiki type may only enter guidance.
    const bucketOf = (record) => {
      if (!record.selectionMetadata) return 'local';
      if (record.selectionMetadata.type === 'technique') return 'technique';
      return ['symptom', 'pattern'].includes(record.selectionMetadata.type) ? 'symptom' : 'guidance';
    };

    const match = features(
      { kind: 'symptom', value: 'tail-effect', basis: 'The mission goal names tail shapes; this is a hypothesis.' },
      { kind: 'technique', value: 'tech-1', basis: 'Unverified direction to try.' },
    );
    const retrieved = await service.retrieveWithSelection(query({ selection: selection({ features: match }) }));
    const selectedIds = idsOf(retrieved.selection.selected);
    assert.equal(retrieved.selection.policyVersion, WIKI_SELECTION_POLICY_VERSION, 'the D path must not stamp the legacy policy version');
    assert.equal(new Set(selectedIds).size, selectedIds.length, 'a selection never repeats a record');
    const selectedRecords = selectedIds.map((id) => byId.get(id));
    assert.ok(selectedRecords.every(Boolean), 'every selected ID must still exist in the repository');
    const localSelected = selectedRecords.filter((record) => !record.selectionMetadata);
    const wikiSelected = selectedRecords.filter((record) => record.selectionMetadata);
    assert.ok(localSelected.length >= 1 && localSelected.length <= 4, `local quota is 4, saw ${localSelected.length}`);
    assert.ok(wikiSelected.length >= 2 && wikiSelected.length <= 6, `wiki quota is 6, saw ${wikiSelected.length}`);
    assert.ok(selectedIds.length <= 10, `the default D quota is 10 (local 4 + Wiki 6), saw ${selectedIds.length}`);
    assert.ok(selectedIds.length <= EXPERIENCE_LIMITS.contextItems, 'the 20-item hard bound still holds');
    const types = wikiSelected.map((record) => record.selectionMetadata.type);
    const buckets = wikiSelected.map(bucketOf);
    assert.ok(buckets.filter((bucket) => bucket === 'symptom').length <= 2, `symptom quota is 2 (pattern pages included), saw ${types.join(',')}`);
    assert.ok(buckets.filter((bucket) => bucket === 'technique').length <= 3, `technique quota is 3, saw ${types.join(',')}`);
    assert.ok(buckets.filter((bucket) => bucket === 'guidance').length <= 1, `guidance quota is 1, saw ${types.join(',')}`);
    const patternRecord = titleOf(records, 'Pattern one page');
    const techFour = titleOf(records, 'Technique four page');
    assert.equal(bucketOf(patternRecord), 'symptom', 'a pattern page is symptom-indexed provenance, never a guidance unit');
    assert.ok(selectedIds.includes(patternRecord.id), 'the symptom-indexed pattern page is selected as a hypothesis');
    assert.ok(selectedIds.includes(techFour.id), 'a selected pattern page expands its candidate technique one hop');
    assert.equal(buckets.filter((bucket) => bucket === 'symptom').length, 2, 'both symptom-bucket units fit inside the symptom quota');
    const unreviewed = titleOf(records, 'Unreviewed page');
    assert.equal(selectedIds.includes(unreviewed.id), false, 'an unreviewed page is retained but never injected');
    assert.equal(retrieved.context.items.some((item) => item.id === unreviewed.id), false);
    // If the audit reports the unreviewed unit at all, it must carry a bounded
    // reason; it may never be presented as a selected unit.
    for (const entry of retrieved.selection.excluded.filter((item) => item.id === unreviewed.id)) assert.ok(entry.reason.length > 0);
    assert.equal((retrieved.selection.selected ?? []).some((entry) => entry.id === unreviewed.id), false);
    for (const item of retrieved.context.items) {
      assert.ok(item.content.length > 0, 'context items keep their full content');
      assert.ok(Array.isArray(item.scope.hardware), 'context items keep their scope');
    }
    // The pure ranker is the same order: local guidance precedes every Wiki unit,
    // the symptom-indexed pattern page sits in the symptom bucket, and a page of
    // any other type is only ever a guidance fallback.
    const ranked = ranks(records, { features: match });
    const firstLocal = ranked.ordered.findIndex((entry) => entry.bucket === 'local');
    const firstWiki = ranked.ordered.findIndex((entry) => entry.bucket !== 'local');
    assert.ok(firstLocal >= 0, 'local experience is ranked');
    assert.ok(firstWiki === -1 || firstLocal < firstWiki, 'local experience is ranked before Wiki units');
    for (const entry of ranked.ordered) {
      assert.deepEqual(Object.keys(entry).sort(), ['bucket', 'id', 'reason', 'version']);
      assert.ok(['local', 'symptom', 'technique', 'guidance'].includes(entry.bucket));
      assert.equal(typeof entry.reason, 'string');
      assert.ok(entry.reason.length > 0);
    }
    assert.equal(ranked.ordered.find((entry) => entry.id === patternRecord.id)?.bucket, 'symptom', 'a symptom-indexed pattern page is ranked in the symptom bucket');
    for (const id of [titleOf(records, 'Guidance one page').id, titleOf(records, 'Guidance two page').id]) {
      const bucket = ranked.ordered.find((entry) => entry.id === id)?.bucket;
      assert.ok(bucket === undefined || bucket === 'guidance', `a guidance page may only be guidance, saw ${bucket}`);
    }
    for (const entry of ranked.excluded) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'reason', 'version']);
      assert.ok(entry.reason.length > 0, 'an exclusion always carries a bounded reason');
    }
    // The audit records the snapshot identity of the Wiki units it selected from.
    // The audit field names are not frozen, so this asserts the serialized value.
    assert.equal(JSON.stringify(retrieved.selection).includes(SOURCE_COMMIT), true, 'the audit records the pinned source commit of a selected unit');
    assert.equal(retrieved.selection.repositoryRevision, retrieved.context.repositoryRevision);
  });

  await test('metadata recall is not truncated by the legacy top-20 window', async () => {
    const { service } = await setup('recall');
    const oldest = await createLocal(service, 'Long-standing unresolved failure');
    for (let index = 0; index < 24; index += 1) { advance(); await createLocal(service, `Recent local record ${index}`); }
    const legacy = await service.retrieveWithSelection(query());
    assert.equal(legacy.context.items.some((item) => item.id === oldest.experience.id), false, 'legacy updatedAt ordering drops it');
    const retrieved = await service.retrieveWithSelection(query({
      selection: selection({ features: [noMatch()], preferredIds: [oldest.experience.id] }),
    }));
    assert.ok(idsOf(retrieved.selection.selected).includes(oldest.experience.id), 'an explicitly preferred ID beyond the legacy window is still recalled');
    assert.ok((await currentRecords(service)).length >= 25);
    assert.equal(retrieved.selection.repositoryRevision, retrieved.context.repositoryRevision, 'the audit names the repository revision it selected from');
  });

  await test('sm100/NVIDIA units never satisfy an sm86/nvidia target and a missing dimension fails applicability', async () => {
    const pages = [
      page({ id: 'sm100-kernel', title: 'sm100 kernel page', tags: ['tech-sm100'], architectures: ['sm100'] }),
      page({ id: 'sm86-kernel', title: 'sm86 kernel page', tags: ['tech-sm86'], architectures: ['sm86'] }),
    ];
    const reviews = [review('sm100-kernel', 'review-sm100-kernel', ['sm100']), review('sm86-kernel', 'review-sm86-kernel', ['sm86'])];
    const { service, store } = await setup('architecture', { pages, reviews });
    const both = features(
      { kind: 'technique', value: 'tech-sm100', basis: 'Unverified direction.' },
      { kind: 'technique', value: 'tech-sm86', basis: 'Unverified direction.' },
    );
    const records = store.records;
    const sm100 = titleOf(records, 'sm100 kernel page');
    const sm86 = titleOf(records, 'sm86 kernel page');
    const matches = await service.retrieveWithSelection(query({ selection: selection({ features: both }) }));
    const matchIds = idsOf(matches.selection.selected);
    assert.ok(matchIds.includes(sm86.id));
    assert.equal(matchIds.includes(sm100.id), false, 'a shared NVIDIA tag must not let sm100 content satisfy sm86');
    // The architecture dimension is missing consistently: the canonical query
    // scope and the selection target both leave it empty, so the query itself is
    // legal and the only rule under test is applicability - an architecture-bound
    // unit can never be assumed to fit a target that never named an architecture.
    const noArchitecture = await service.retrieveWithSelection(query({
      scope: { hardware: ['nvidia-gpu'], architecture: [] },
      selection: selection({ features: both, target: target({ architecture: [] }) }),
    }));
    assert.equal(noArchitecture.context.items.length, 0, 'a missing target architecture fails applicability instead of being assumed');
    assert.equal(noArchitecture.selection.selected.length, 0);
    const omittedArchitecture = await service.retrieveWithSelection(query({
      scope: { hardware: ['nvidia-gpu'] },
      selection: selection({ features: both, target: { hardware: ['nvidia-gpu'], architecture: [], capabilities: [], software: [] } }),
    }));
    assert.equal(omittedArchitecture.context.items.length, 0, 'omitting the architecture dimension on both sides is still not a match');
    const sm80 = await service.retrieveWithSelection(query({
      scope: { hardware: ['nvidia-gpu'], architecture: ['sm80'] },
      selection: selection({ features: both, target: target({ architecture: ['sm80'] }) }),
    }));
    assert.equal(idsOf(sm80.selection.selected).includes(sm86.id), false, 'sm80 is never inferred to satisfy sm86');
    // A selection target that disagrees with the canonical query scope is an
    // illegal query: it must be rejected outright. Ranking can never widen access,
    // so requiring it to answer with an empty (or narrowed) selection would be
    // asserting success for a request the contract forbids.
    await assert.rejects(service.retrieveWithSelection(query({
      scope: { hardware: ['nvidia-gpu'], architecture: ['sm80'] },
      selection: selection({ features: both, target: target({ architecture: ['sm86'] }) }),
    })), codedFailure, 'a selection target that disagrees with the canonical query scope must be rejected, not answered');
    await assert.rejects(service.retrieveWithSelection(query({
      scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
      selection: selection({ features: both, target: target({ hardware: ['amd-gpu'] }) }),
    })), codedFailure, 'a selection target hardware that disagrees with the query scope must be rejected, not answered');
    const nilTarget = ranks(records, { features: both, target: target({ architecture: [] }) });
    assert.deepEqual(idsOf(nilTarget.ordered), []);
  });

  await test('a pattern-typed unit is a symptom source, never a technique or guidance unit', async () => {
    // TEAM_HANDOFF 8.3: `wiki/patterns/` pages are the symptom -> candidate
    // technique layer, so a real `type: pattern` page is symptom-bucketed and is
    // itself a one-hop source. It is never promoted to technique or guidance.
    const pages = [
      page({ id: 'pattern-vector', title: 'Pattern vector page', type: 'pattern', tags: ['pattern-vec'], symptoms: ['pattern-symptom'], techniques: ['pattern-vec'], architectures: ['sm86'] }),
      page({ id: 'technique-vector', title: 'Technique vector page', tags: ['pattern-vec'], architectures: ['sm86'] }),
    ];
    const { service, store } = await setup('pattern', { pages, reviews: [archReview('pattern-vector'), archReview('technique-vector')] });
    const pattern = titleOf(store.records, 'Pattern vector page');
    const technique = titleOf(store.records, 'Technique vector page');
    assert.equal(pattern.selectionMetadata.type, 'pattern', 'the original nonempty page type is preserved as provenance');
    const match = features({ kind: 'symptom', value: 'pattern-symptom', basis: 'Symptom hypotheses are unverified directions, never a measured bottleneck.' });
    const ranked = ranks(headList(store.records), { features: match });
    assert.equal(ranked.ordered.find((entry) => entry.id === pattern.id)?.bucket, 'symptom', 'a pattern unit is symptom-indexed, never technique or guidance');
    assert.equal(ranked.ordered.find((entry) => entry.id === technique.id)?.bucket, 'technique', 'the one-hop candidate technique becomes a technique unit');
    const retrieved = await service.retrieveWithSelection(query({ selection: selection({ features: match }) }));
    const selectedIds = idsOf(retrieved.selection.selected);
    assert.ok(selectedIds.includes(pattern.id), 'the symptom-indexed pattern page is selected as a hypothesis');
    assert.ok(selectedIds.includes(technique.id), 'one hop from the pattern page reaches its candidate technique');
    // A raw technique feature never turns a pattern page into a technique unit.
    const techniqueFeature = features({ kind: 'technique', value: 'pattern-vec', basis: 'Unverified direction taken from the review.' });
    const byTechnique = ranks(headList(store.records), { features: techniqueFeature });
    assert.notEqual(byTechnique.ordered.find((entry) => entry.id === pattern.id)?.bucket, 'technique', 'a pattern unit is never promoted into the technique bucket');
    assert.equal(byTechnique.ordered.find((entry) => entry.id === technique.id)?.bucket, 'technique', 'a technique-typed unit with the same topic stays a technique');
    const direct = await service.retrieveWithSelection(query({ selection: selection({ features: techniqueFeature }) }));
    assert.ok(idsOf(direct.selection.selected).includes(technique.id), 'the topical technique match is selected');
  });

  await test('symptom candidateTechniques expand exactly one hop, only to techniques, and never duplicate', async () => {
    const pages = [
      page({ id: 'symptom-hop', title: 'Hop symptom page', type: 'symptom', symptoms: ['hop-symptom'], techniques: ['tech-hop'], architectures: ['sm86'] }),
      page({ id: 'hop-technique', title: 'One hop technique page', tags: ['tech-hop'], techniques: ['tech-deep'], architectures: ['sm86'] }),
      page({ id: 'deep-technique', title: 'Two hop technique page', tags: ['tech-deep'], architectures: ['sm86'] }),
      page({ id: 'hop-pattern', title: 'Hop pattern page', type: 'pattern', tags: ['tech-hop'], architectures: ['sm86'] }),
    ];
    const reviews = pages.map((item) => archReview(item.path.split('/').pop().replace('.md', '')));
    const { service, store } = await setup('single-hop', { pages, reviews });
    const hop = await service.retrieveWithSelection(query({
      selection: selection({ features: features({ kind: 'symptom', value: 'hop-symptom', basis: 'Hypothesis only.' }) }),
    }));
    const hopIds = idsOf(hop.selection.selected);
    const oneHop = titleOf(store.records, 'One hop technique page');
    const twoHop = titleOf(store.records, 'Two hop technique page');
    const symptomSource = titleOf(store.records, 'Hop symptom page');
    const hopPattern = titleOf(store.records, 'Hop pattern page');
    assert.ok(hopIds.includes(oneHop.id), 'a matching symptom page expands its candidate technique one hop');
    assert.equal(hopIds.includes(twoHop.id), false, 'related expansion never recurses');
    assert.equal(new Set(hopIds).size, hopIds.length, 'no duplicate is injected twice');
    assert.deepEqual([...hopIds].sort(), [symptomSource.id, oneHop.id].sort(), 'one hop selects exactly the matching symptom unit and its technique-unit candidate');
    // The same unit reached directly and through the symptom hop stays one entry.
    const direct = await service.retrieveWithSelection(query({
      selection: selection({
        features: features(
          { kind: 'symptom', value: 'hop-symptom', basis: 'Hypothesis only.' },
          { kind: 'technique', value: 'tech-hop', basis: 'Unverified direction.' },
        ),
      }),
    }));
    const directIds = idsOf(direct.selection.selected);
    assert.equal(new Set(directIds).size, directIds.length);
    assert.equal(directIds.filter((id) => id === oneHop.id).length, 1);
    const ranked = ranks(headList(store.records), { features: features({ kind: 'symptom', value: 'hop-symptom', basis: 'Hypothesis only.' }) });
    assert.equal(ranked.ordered.filter((entry) => entry.id === oneHop.id).length, 1);
    assert.equal(ranked.ordered.some((entry) => entry.id === twoHop.id), false);
    // One hop reaches technique units only: the pattern page sharing the hop
    // topic is neither a hop target nor a technique/guidance unit.
    assert.equal(hopIds.includes(hopPattern.id), false, 'a pattern page is never a one-hop technique target');
    assert.notEqual(ranked.ordered.find((entry) => entry.id === hopPattern.id)?.bucket, 'technique', 'a pattern unit sharing the hop topic is never promoted into the technique bucket');
    assert.equal(ranked.ordered.some((entry) => entry.id === hopPattern.id), false, 'a pattern unit without a matching symptom is neither a hop target nor a guidance fallback');
  });

  await test('only the exact previously attempted identity is demoted, for local and Wiki units alike', async () => {
    const pages = [
      page({ id: 'shared-a', title: 'Shared technique A', tags: ['tech-shared'], architectures: ['sm86'] }),
      page({ id: 'shared-b', title: 'Shared technique B', tags: ['tech-shared'], architectures: ['sm86'] }),
    ];
    const { service, store } = await setup('repeat', { pages, reviews: [archReview('shared-a'), archReview('shared-b')] });
    const olderLocal = await createLocal(service, 'Older local observation');
    advance();
    const newerLocal = await createLocal(service, 'Newer local observation');
    const records = headList(await currentRecords(service));
    const first = titleOf(store.records, 'Shared technique A');
    const second = titleOf(store.records, 'Shared technique B');
    const match = features({ kind: 'technique', value: 'tech-shared', basis: 'Unverified direction.' });
    const ranked = ranks(records, { features: match });
    assert.ok(idsOf(ranked.ordered).includes(first.id) && idsOf(ranked.ordered).includes(second.id), 'both same-topic techniques are available before any repeat');
    assert.ok(indexOfId(ranked.ordered, first.id) < indexOfId(ranked.ordered, second.id), 'deterministic ties use ID ascending');
    assert.ok(indexOfId(ranked.ordered, newerLocal.experience.id) < indexOfId(ranked.ordered, olderLocal.experience.id), 'more recent local guidance is ranked first');
    const attempt = [{ id: first.id, version: first.version, attemptKey: 'masked-tail-loop:block64:sm86' }];
    const repeated = ranks(records, { features: match, repeatedAttempts: attempt });
    const repeatedIds = idsOf(repeated.ordered);
    assert.ok(repeatedIds.includes(second.id), 'an exact repeat never bans the whole technique category');
    assert.ok(repeatedIds.includes(first.id), 'the repeated technique stays available');
    assert.ok(repeatedIds.indexOf(second.id) < repeatedIds.indexOf(first.id), 'the exact repeated ID/version is demoted');
    // Only the exact version is demoted.
    const otherVersion = ranks(records, {
      features: match,
      repeatedAttempts: [{ id: first.id, version: first.version + 1, attemptKey: 'masked-tail-loop:block64:sm86' }],
    });
    assert.ok(indexOfId(otherVersion.ordered, first.id) < indexOfId(otherVersion.ordered, second.id), 'a different version is not demoted by an exact-version repeat claim');
    // Only the exact ID is demoted.
    const otherId = ranks(records, {
      features: match,
      repeatedAttempts: [{ id: 'not-a-stored-id', version: 1, attemptKey: 'masked-tail-loop:block64:sm86' }],
    });
    assert.deepEqual(idsOf(otherId.ordered), idsOf(ranked.ordered), 'a repeat claim for an unknown ID never changes the order');
    // The same exact-repeat rule applies to a local record.
    const localRepeat = ranks(records, {
      features: match,
      repeatedAttempts: [{ id: newerLocal.experience.id, version: newerLocal.experience.version, attemptKey: 'masked-tail-loop:block64:sm86' }],
    });
    assert.ok(indexOfId(localRepeat.ordered, olderLocal.experience.id) < indexOfId(localRepeat.ordered, newerLocal.experience.id), 'an exact local repeat is demoted to the older observation');
    const retrieved = await service.retrieveWithSelection(query({ selection: selection({ features: match, repeatedAttempts: attempt }) }));
    assert.ok(idsOf(retrieved.selection.selected).includes(second.id));
    assert.equal(new Set(idsOf(retrieved.selection.selected)).size, idsOf(retrieved.selection.selected).length);
  });

  await test('retrieval uses the latest same-project version and never leaks another project', async () => {
    const { service } = await setup('latest-head');
    const versioned = await createLocal(service, 'Versioned local record', { content: 'Version one content.' });
    advance();
    await service.update(versioned.experience.id, { content: 'Version two content.' }, { projectId: PROJECT, expectedVersion: 1 });
    advance();
    await createLocal(service, 'Versioned local record', { projectId: 'project-b', content: 'Foreign project content.' });
    advance();
    const foreignLocal = await currentRecords(service);
    const retrieved = await service.retrieveWithSelection(query({ selection: selection({ features: [noMatch()] }) }));
    assert.equal(retrieved.context.items.length, 1, 'only the current project contributes');
    const item = retrieved.context.items[0];
    assert.equal(item.id, versioned.experience.id);
    assert.equal(item.version, 2, 'the latest version is selected, not a historical one');
    assert.match(item.content, /Version two content/);
    assert.equal(retrieved.context.versions[versioned.experience.id], 2);
    const serialized = JSON.stringify({ context: retrieved.context, selection: retrieved.selection });
    assert.equal(serialized.includes('Foreign project content'), false, 'an inaccessible project record is never named');
    assert.equal(serialized.includes('project-b'), false, 'an inaccessible project id is never disclosed');
    assert.ok(foreignLocal.some((record) => record.projectId === PROJECT), 'the same-project head is the authority');
    // The frozen experience contract only ever retrieves the head version: a
    // legacy pin to an older version must not resurrect it as this round's
    // context, and the pinned-out head is audited with the frozen reason.
    const pinned = await service.retrieveWithSelection(query({ versions: { [versioned.experience.id]: 1 } }));
    assert.equal(pinned.context.items.length, 0, 'a pin below the head selects nothing instead of an old version');
    assert.deepEqual(pinned.context.versions, {});
    const pinnedExcluded = pinned.selection.excluded.filter((entry) => entry.id === versioned.experience.id);
    assert.equal(pinnedExcluded.length, 1, 'the pinned-out head is audited once');
    assert.equal(pinnedExcluded[0].version, 2, 'the audit names the current head version');
    assert.equal(pinnedExcluded[0].reason, 'version-pinned', 'the frozen version-pinned reason is preserved');
    // The same head rule holds on the D selection path: a stale pin never makes
    // the historical version the selected one.
    const pinnedSelection = await service.retrieveWithSelection(query({
      versions: { [versioned.experience.id]: 1 }, selection: selection({ features: [noMatch()] }),
    }));
    assert.equal(idsOf(pinnedSelection.selection.selected).includes(versioned.experience.id), false, 'a D selection cannot serve a version the pin excludes');
    // The historical version is still readable through an explicit version read.
    const historical = await service.read(versioned.experience.id, { projectId: PROJECT, version: 1 });
    assert.equal(historical.experience.version, 1, 'historical versions stay readable by exact version');
    assert.match(historical.experience.content, /Version one content/);
    assert.equal((await service.read(versioned.experience.id, { projectId: PROJECT })).experience.version, 2, 'a plain read still returns the head');
  });

  await test('raw Wiki units and their reviewed transfers stay separate, audited records', async () => {
    const rawBody = 'Original reviewed guidance body for the raw unit.';
    const transferContent = 'Project-reviewed sm86 transfer guidance.';
    const pages = [page({ id: 'tail-raw', title: 'Raw tail page', tags: ['tech-raw'], symptoms: ['tail-effect'], architectures: ['sm86'], body: rawBody })];
    const { service, repository, store } = await setup('raw-transfer', { pages, reviews: [archReview('tail-raw'), transferReview('tail-raw', transferContent)] });
    const raw = titleOf(store.records, 'Raw tail page');
    const transfer = store.records.find((record) => record.selectionMetadata?.applicability?.mode === 'reviewed-transfer');
    assert.ok(transfer, 'the reviewed transfer is a separate stored unit');
    assert.notEqual(raw.id, transfer.id, 'a transfer never overwrites the raw unit ID');
    assert.match(raw.content, /Original reviewed guidance body/);
    assert.match(transfer.content, /Project-reviewed sm86 transfer guidance/);
    assert.equal(transfer.selectionMetadata.sourceDigest, raw.selectionMetadata.sourceDigest, 'the transfer keeps the original source identity');
    const audited = await service.retrieveWithSelection(query({
      selection: selection({ features: features({ kind: 'technique', value: 'tech-raw', basis: 'Unverified direction.' }) }),
    }));
    const auditedIds = idsOf(audited.selection.selected);
    assert.equal(new Set(auditedIds).size, auditedIds.length, 'the audit never repeats a record');
    assert.ok(auditedIds.includes(raw.id), 'the raw unit stays auditable');
    assert.ok(auditedIds.includes(transfer.id), 'the reviewed transfer is selectable in the same round as its raw unit');
    // The audit must name the snapshot identity of EVERY selected unit: the raw
    // unit and its transfer share a source page but not a unit identity, so each
    // selected record carries its own recordId/version/unitDigest.
    const auditedSources = [raw, transfer].map((record) => {
      const entry = auditedSourceOf(audited.selection, record);
      assert.ok(entry, `the audit must name the selected source identity of ${record.id}`);
      assert.equal(sourceEntryId(entry), record.id);
      assert.equal(entry.version, record.version, `the audited source version of ${record.id} is the selected version`);
      assert.equal(sourceEntryDigest(entry), record.selectionMetadata.unitDigest, `the audited unit digest of ${record.id} is the selected content identity`);
      assert.equal(JSON.stringify(entry).includes(SOURCE_COMMIT), true, `the audited source of ${record.id} names the pinned commit`);
      return entry;
    });
    assert.notEqual(sourceEntryDigest(auditedSources[0]), sourceEntryDigest(auditedSources[1]), 'the raw unit and its transfer are audited as two distinct source identities');
    assert.equal(audited.context.items.find((item) => item.id === raw.id).content.includes('Original reviewed guidance body'), true, 'selecting the transfer never rewrites the raw unit');
    const rawStillStored = (await currentRecords(service)).find((record) => record.id === raw.id);
    assert.match(rawStillStored.content, /Original reviewed guidance body/);
    validateExperienceStore(await repository.read());
  });

  await test('exact-ID selection revalidates status and expiry and never leaks inaccessible records', async () => {
    const { service, repository } = await setup('privacy');
    const active = await createLocal(service, 'Active local record');
    advance();
    const archived = await createLocal(service, 'Archived local record');
    await service.update(archived.experience.id, { status: 'archived' }, { projectId: PROJECT, expectedVersion: 1 });
    advance();
    const expired = await createLocal(service, 'Expired local record', { expiresAt: '2026-09-14T00:00:00.000Z' });
    advance();
    const foreignPrivate = await createLocal(service, 'Foreign private record', { projectId: 'project-b', visibility: 'project' });
    advance();
    const foreignShared = await createLocal(service, 'Foreign shared record', { projectId: 'project-b', visibility: 'shared' });
    const retrieved = await service.retrieveWithSelection(query({
      allowedProjectIds: [], selection: selection({ features: [noMatch()], preferredIds: [archived.experience.id, expired.experience.id, foreignPrivate.experience.id] }),
    }));
    const selectedIds = idsOf(retrieved.selection.selected);
    assert.deepEqual(selectedIds, [active.experience.id]);
    assert.equal(selectedIds.includes(archived.experience.id), false, 'a record archived after the input list was built is still revalidated');
    assert.equal(selectedIds.includes(expired.experience.id), false, 'an expired record is revalidated');
    assert.ok(retrieved.selection.excludedUnauthorized >= 1, 'inaccessible candidates are counted, never named');
    const rendered = JSON.stringify({ context: retrieved.context, selection: retrieved.selection });
    assert.equal(rendered.includes(foreignPrivate.experience.id), false, 'an inaccessible record ID must never appear in exclusion details');
    assert.equal(rendered.includes(foreignShared.experience.id), false);
    assert.equal(rendered.includes('Foreign private record'), false);
    // The store still holds every record; only the returned view is filtered.
    const storedIds = new Set((await repository.read()).records.map((record) => record.id));
    for (const created of [active, archived, expired, foreignPrivate, foreignShared]) assert.ok(storedIds.has(created.experience.id));
  });

  await test('the 24 KiB soft budget is measured on rendered UTF-8 bytes and skips an oversized optional record', async () => {
    const { service } = await setup('soft-budget');
    const small = await createLocal(service, 'Small local record', { content: 'Compare the reference output for every case.' });
    advance();
    // The record is legal on its own (inside the 8000-character content and 32 KiB
    // record bounds) but its rendered form exceeds the optional 24 KiB budget.
    const oversized = await createLocal(service, 'Oversized local record', {
      content: '好'.repeat(EXPERIENCE_LIMITS.content),
      evidenceRefs: Array.from({ length: 24 }, (_, index) => `${index}-`.padEnd(160, 'r')),
    });
    assert.equal(oversized.experience.content.length, EXPERIENCE_LIMITS.content, 'the record itself is inside the 8000-character content bound');
    const renderOf = (context) => Buffer.byteLength(formatExperienceContext(context, {
      projectId: PROJECT, missionId: 'mission-1', roundId: 'mission-1:round:1',
    }), 'utf8');
    // Control: the legacy single-item context proves the record alone breaches the
    // soft budget, so the D result below is not green because of a small fixture.
    const alone = await service.retrieveWithSelection(query({ limit: 1 }));
    assert.deepEqual(idsOf(alone.context.items), [oversized.experience.id], 'the control context holds exactly the oversized record');
    const softCandidateBytes = renderOf(alone.context);
    const retrieved = await service.retrieveWithSelection(query({ selection: selection({ features: [noMatch()] }) }));
    const renderedBytes = renderOf(retrieved.context);
    assert.ok(softCandidateBytes > SOFT_RENDER_BYTES, `the oversized candidate must actually breach the budget on its own, saw ${softCandidateBytes}`);
    assert.ok(renderedBytes <= SOFT_RENDER_BYTES, `rendered formatter output must stay inside the soft 24 KiB budget, saw ${renderedBytes}`);
    assert.equal(idsOf(retrieved.selection.selected).includes(oversized.experience.id), false, 'an oversized optional record is skipped');
    assert.ok(idsOf(retrieved.selection.selected).includes(small.experience.id), 'a later smaller record is still considered');
    assert.ok(Buffer.byteLength(JSON.stringify(retrieved.context), 'utf8') <= EXPERIENCE_LIMITS.contextBytes, 'the 64 KiB hard bound still holds');
    assert.ok(retrieved.selection.contextBytes <= EXPERIENCE_LIMITS.contextBytes);
  });

  await test('Wiki provenance is never diagnostic evidence', async () => {
    const pages = [page({ id: 'evidence-page', title: 'Evidence page', tags: ['tech-evidence'], architectures: ['sm86'] })];
    const { service, store } = await setup('provenance', { pages, reviews: [archReview('evidence-page')] });
    const imported = titleOf(store.records, 'Evidence page');
    assert.notEqual(imported.source, 'execution', 'an imported page is never an execution observation');
    assert.equal(imported.verification.publishable, false, 'imported guidance can never be published as evidence');
    assert.equal(imported.verification.status, 'unverified');
    assert.ok(!imported.evidence, 'provenance is recorded, never promoted to evidence');
    assert.deepEqual(imported.scope.tags, [], 'raw Wiki topics are provenance metadata, never scope tags');
    validateExperienceStore(store);
    assert.ok((await currentRecords(service)).every((record) => record.verification.publishable === false));

    // Expert 6.13 case 7: a schema-valid diagnostic envelope whose provenance is
    // mock/simulated/unavailable/incomplete stays ineligible. The frozen
    // eligibility cases are unchanged; this re-asserts the invariant at the
    // combination point with the real signature and a complete legal fixture.
    const real = evaluateDiagnosticEvidence('tracer', tracerEnvelope(), tracerBinding);
    assert.equal(real.schemaValid, true, 'the positive control fixture is schema-valid');
    assert.equal(real.available, true, 'the positive control fixture is an available collection');
    assert.equal(real.evidenceEligible, true, `the positive control must qualify: ${JSON.stringify(real.reasons)}`);
    for (const [label, envelope, reason] of [
      ['mock', tracerEnvelope({ status: 'mock' }), DIAGNOSTIC_REASONS.SIMULATED],
      ['simulated', tracerEnvelope({ simulated: true }), DIAGNOSTIC_REASONS.SIMULATED],
      ['not completed', tracerEnvelope({ status: 'running' }), DIAGNOSTIC_REASONS.STATUS_NOT_COMPLETED],
      ['source unavailable', tracerEnvelope({ source: 'unavailable' }), DIAGNOSTIC_REASONS.SOURCE_MISSING],
    ]) {
      const verdict = evaluateDiagnosticEvidence('tracer', envelope, tracerBinding);
      // The frozen tracer schema is format + events, so a non-real provenance is
      // still schema-valid: schemaValid is asserted per the real schema instead of
      // being guessed from the provenance decision.
      assert.equal(verdict.schemaValid, true, `${label} keeps a schema-valid envelope`);
      assert.equal(verdict.available, false, `${label} is not an available collection`);
      assert.equal(verdict.evidenceEligible, false, `${label} must not satisfy the real-diagnostics rule`);
      assert.ok(verdict.reasons.includes(reason), `${label} must report the frozen ${reason} reason`);
    }
    // A schema-invalid envelope is a different branch: no events/format mismatch
    // fails before any provenance decision is made.
    const wrongSchema = evaluateDiagnosticEvidence('tracer', tracerEnvelope({ format: 'operator-trace/v2' }), tracerBinding);
    assert.equal(wrongSchema.schemaValid, false, 'the frozen tracer format is operator-trace/v1');
    assert.equal(wrongSchema.available, false);
    assert.equal(wrongSchema.evidenceEligible, false);
    assert.deepEqual(wrongSchema.reasons, [DIAGNOSTIC_REASONS.SCHEMA_INVALID]);
    // A schema-valid envelope without the expected candidate/run binding is
    // available but never eligible for adoption.
    const unbound = evaluateDiagnosticEvidence('tracer', tracerEnvelope(), {});
    assert.equal(unbound.schemaValid, true);
    assert.equal(unbound.evidenceEligible, false, 'an unmatched diagnostic binding never qualifies');
    assert.ok(unbound.reasons.includes(DIAGNOSTIC_REASONS.BINDING_EXPECTED_MISSING));
    assert.ok(Object.values(DIAGNOSTIC_REASONS).length > 0);
  });

  await test('selection options are bounded and ranking is deterministic', async () => {
    const { service } = await setup('bounds', {
      pages: [page({ id: 'bound-page', title: 'Bound page', tags: ['tech-bound'], architectures: ['sm86'] })],
      reviews: [archReview('bound-page')],
    });
    const preferredLocal = await createLocal(service, 'Preferred local record');
    const records = await currentRecords(service);
    const feature = (value) => ({ kind: 'technique', value, basis: 'Unverified direction.' });
    // Each negative keeps the otherwise complete option object valid and breaks
    // exactly one documented bound or field.
    assert.throws(() => ranks(records, { features: Array.from({ length: 9 }, (_, index) => feature(`tech-${index}`)) }), codedFailure, 'features are capped at 8');
    assert.throws(() => ranks(records, { features: [feature('a'), feature('b'), feature('c')] }), codedFailure, 'at most 2 features per kind');
    assert.throws(() => ranks(records, { features: [{ kind: 'technique', value: 'a', basis: '' }] }), codedFailure, 'basis must be a nonempty string');
    assert.throws(() => ranks(records, { features: [{ kind: 'technique', value: 'a', basis: 'x'.repeat(1001) }] }), codedFailure, 'basis is capped at 1000 characters');
    assert.throws(() => ranks(records, { features: [{ kind: 'technique', value: 'x'.repeat(161), basis: 'x' }] }), codedFailure, 'a feature value is capped at 160 characters');
    assert.throws(() => ranks(records, { features: [{ kind: 'bottleneck', value: 'a', basis: 'x' }] }), codedFailure, 'unknown feature kinds are rejected');
    assert.throws(() => ranks(records, { features: [{ kind: 'technique', value: 'a', basis: 'x', confidence: 0.87 }] }), codedFailure, 'no numeric confidence is accepted');
    // `features` stays a complete, valid (empty) array in every preferred/repeat
    // negative, so each one fails on its own bound and never on a missing field.
    assert.throws(() => ranks(records, { features: [], preferredIds: Array.from({ length: 21 }, (_, index) => `id-${index}`) }), codedFailure, 'preferredIds are capped at 20');
    const preferred = ranks(records, { features: [], preferredIds: [preferredLocal.experience.id] });
    assert.ok(preferred.ordered.some((entry) => entry.id === preferredLocal.experience.id), 'an explicitly preferred local ID is still recalled without a topical feature');
    assert.throws(() => ranks(records, { features: [], repeatedAttempts: Array.from({ length: 21 }, (_, index) => ({ id: `id-${index}`, version: 1, attemptKey: 'k' })) }), codedFailure, 'repeatedAttempts are capped at 20');
    assert.throws(() => ranks(records, { features: [], repeatedAttempts: [{ id: 'x', version: 1, attemptKey: '' }] }), codedFailure, 'attemptKey must identify modification, parameters and conditions');
    assert.throws(() => ranks(records, { features: [], repeatedAttempts: [{ id: 'x', attemptKey: 'k' }] }), codedFailure, 'a repeat claim needs an exact version');
    assert.throws(() => ranks(records, { features: [], repeatedAttempts: [{ id: 'x', version: 1 }] }), codedFailure, 'a repeat claim needs an explicit attempt key');
    const once = ranks(records, { features: [feature('tech-bound')] });
    const twice = ranks(records, { features: [feature('tech-bound')] });
    assert.deepEqual(once, twice, 'ranking is deterministic for identical input');
    assert.equal(JSON.stringify(once).includes('1.4x'), false, 'upstream performance claims never reach a ranking reason');
  });

  if (failed) {
    console.error(`Experience selection: ${failed} of ${passed + failed} independent checks FAILED.`);
    process.exitCode = 1;
  } else {
    console.log(`Experience selection: ${passed} independent checks passed.`);
  }
} finally {
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('operator-selection-test-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
