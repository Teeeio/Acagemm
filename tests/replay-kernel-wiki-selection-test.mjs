// Acceptance matrix for scripts/replay-kernel-wiki-selection.mjs.
//
// The replay is a read-only historical-evidence tool, so the properties that matter
// are exactly the ones that decide what its report is allowed to claim:
//   - a selected KernelWiki unit's REVIEWED applicability and the raw source page's
//     own architecture list are never merged into one field;
//   - an injected unreviewed unit, a broken provenance sidecar or a record missing
//     from the final store are DEFECTS, while weak relevance is only a warning;
//   - the secondary re-run never claims to be the round's own selection, and a
//     difference explained by a record written after the round is labelled as such;
//   - fixture-shaped directories (frozen repo snapshots) are never counted as runs.
//
// No model, provider, GPU, Python, scheduler or Runtime process is started. The only
// child process is the script's own CLI, spawned with a fixed argv (shell: false) to
// check its exit codes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyKernelWikiSnapshot, buildKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';
import { appendExperience, emptyExperienceStore, retrieveExperienceSelection, validateExperienceStore } from '../client-runtime/experience-contract.mjs';
import { WIKI_SELECTION_POLICY_VERSION } from '../client-runtime/experience-selection.mjs';
import {
  buildAuditRow, collectAudits, declaredApplicability, discoverRunDirs, exclusionSummary,
  recheckSelection, relevanceWarnings, replayRuns, selectionDefects, summarize, wikiRelevance,
} from '../scripts/replay-kernel-wiki-selection.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(projectRoot, 'scripts', 'replay-kernel-wiki-selection.mjs');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'operator-wiki-replay-test-'));
const SOURCE_COMMIT = 'b6b4301f15e8ce6955a56776690643ce5db369e6';
const PROJECT = 'PRJ_REPLAY';
const MISSION = 'MIS_REPLAY';
const ROUND = `${MISSION}:round:2`;
const CLOCK = '2026-09-16T15:00:09.168Z';
const AFTER_CLOCK = '2026-09-16T15:03:04.088Z';
let passed = 0;
let failed = 0;
const test = async (name, run) => {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};

// --- KernelWiki source pages (the production importer is the only writer of metadata) ---
const list = (values) => `[${values.map((value) => `"${value}"`).join(', ')}]`;
const block = (key, values) => (values.length ? [`${key}:`, ...values.map((value) => `  - ${value}`)] : [`${key}: []`]);
const page = ({ id, title, type = 'technique', topics = [], techniques = [], architectures = [], body = 'Reviewed guidance body.' }) => ({
  path: `wiki/techniques/${id}.md`,
  text: [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    `type: ${type}`,
    `tags: ${list(topics)}`,
    'symptoms: []',
    ...block('candidate_techniques', techniques),
    ...block('architectures', architectures),
    '---',
    '',
    body,
    '',
  ].join('\n'),
});
// A reviewed transfer must carry its own reviewed content: the importer never
// summarizes the upstream page for it.
const review = (pageId, reviewId, architectures, mode = 'architecture-specific') => ({
  pageId, reviewId, mode, hardware: ['nvidia-gpu'], architectures, requiredCapabilities: [], software: [],
  ...(mode === 'reviewed-transfer' ? { content: `Transferred guidance for ${pageId} at sm86.` } : {}),
});

const TARGET = { hardware: ['nvidia-gpu'], architecture: ['sm86'], capabilities: [], software: [] };
const FEATURES = [
  { kind: 'structure', value: 'generic_affine', basis: 'Mission operator identity' },
  { kind: 'technique', value: 'vectorization', basis: 'Mission goal names vectorization' },
];
const SCOPE = { hardware: ['nvidia-gpu'], architecture: ['sm86'], operator: 'generic_affine' };

/** Build a real experience store: one reviewed-transfer wiki unit, one unreviewed wiki unit, one local record. */
const buildStore = ({ now = CLOCK, includeSnapshots = true } = {}) => {
  const store = emptyExperienceStore();
  if (includeSnapshots) {
    const snapshot = buildKernelWikiSnapshot({
      pages: [
        page({ id: 'technique-vectorized-loads', title: 'Vectorized loads', topics: ['vectorization', 'cache-policy'], architectures: ['sm100', 'sm90'] }),
        page({ id: 'hw-mbarrier', title: 'mbarrier', type: 'pattern', topics: ['mbarrier'], architectures: ['sm90'] }),
      ],
      sourceCommit: SOURCE_COMMIT,
      reviews: [review('technique-vectorized-loads', 'sm86-principles-v1', ['sm86'], 'reviewed-transfer')],
    });
    applyKernelWikiSnapshot(store, snapshot, { projectId: PROJECT, now, author: 'replay-test' });
  }
  appendExperience(store, {
    source: 'human', kind: 'guidance', projectId: PROJECT, visibility: 'project',
    title: 'Local affine observation', content: 'Local observation content.', author: 'tester',
    confidence: 'medium', scope: SCOPE,
  }, { id: 'exp-local-0001', now, source: 'human' });
  return store;
};

const query = (overrides = {}) => ({
  projectId: PROJECT, allowedProjectIds: [], missionId: MISSION, roundId: ROUND, scope: SCOPE,
  selection: { policyVersion: WIKI_SELECTION_POLICY_VERSION, features: FEATURES, target: TARGET },
  ...overrides,
});

const wikiRecordOf = (store, suffix) => store.records.find((record) => record.id.includes(suffix));
const transferRecord = (store) => wikiRecordOf(store, 'transfer-sm86-principles-v1');

// --- pure: declared applicability -------------------------------------------------

await test('reviewed applicability and the raw source-page architecture list stay separate fields', () => {
  const store = buildStore();
  const record = transferRecord(store);
  assert.ok(record, 'the reviewed-transfer unit must exist in the fixture store');
  const declared = declaredApplicability(record.selectionMetadata);
  assert.deepEqual(declared.reviewedArchitectures, ['sm86'], 'the reviewed applicability is the unit\'s own review scope');
  assert.deepEqual(declared.pageArchitectures, ['sm100', 'sm90'], 'the raw page list is reported as its own field');
  assert.deepEqual(declared.declaredArchitectures, ['sm100', 'sm86', 'sm90'], 'only the union is compared against the target');
  assert.equal(declared.reviewed, true);
  assert.equal(declared.mode, 'reviewed-transfer');
  assert.equal(declared.reviewId, 'sm86-principles-v1');
  // The basis must name the reviewed block, otherwise "reviewed for sm86" and "the page
  // mentioned sm86" are indistinguishable in the report.
  assert.equal(declared.architectureBasis, 'reviewed-applicability');
});

await test('an unreviewed unit is not reviewed, and a unit with no architecture list has no basis at all', () => {
  const unreviewed = declaredApplicability({ architectures: ['sm90'], applicability: { mode: 'unreviewed', reviewId: null, architectures: [] } });
  assert.equal(unreviewed.reviewed, false, 'unreviewed units must never count as reviewed');
  assert.deepEqual(unreviewed.declaredArchitectures, ['sm90']);
  assert.equal(unreviewed.architectureBasis, 'source-page-only', 'the basis must say the page, not a review, provided it');
  const empty = declaredApplicability({ applicability: { mode: 'unreviewed' } });
  assert.equal(empty.reviewed, false);
  assert.equal(empty.architectureBasis, 'none');
  assert.deepEqual(empty.declaredArchitectures, []);
});

// --- pure: relevance --------------------------------------------------------------

await test('relevance names the matched term instead of only a boolean, for topics and page ids alike', () => {
  const store = buildStore();
  const byTopic = wikiRelevance({ record: transferRecord(store), target: TARGET, features: FEATURES });
  assert.deepEqual(byTopic.architectureMatches, ['sm86'], 'the reviewed applicability matches the target arch');
  assert.deepEqual(byTopic.hardwareMatches, ['nvidia-gpu']);
  assert.deepEqual(byTopic.matchedFeatures, [{ feature: 'technique:vectorization', term: 'vectorization' }],
    'the feature must be reported with the exact vocabulary term it hit');
  assert.deepEqual(byTopic.targetArchitectures, ['sm86']);
  // A page id is part of the vocabulary as well: `technique-vectorized-loads` carries
  // "vectorized", and a target of `generic_affine` hits nothing, so the basis is
  // reported as no overlap rather than silently counted.
  const pageIdOnly = wikiRelevance({
    record: { id: 'kw-x', version: 1, selectionMetadata: { pageId: 'technique-vectorized-loads', topics: [], applicability: { mode: 'unreviewed' } } },
    target: TARGET,
    features: [{ kind: 'technique', value: 'vectorized' }, { kind: 'structure', value: 'generic_affine' }],
  });
  assert.deepEqual(pageIdOnly.matchedFeatures, [{ feature: 'technique:vectorized', term: 'vectorized' }]);
  const none = wikiRelevance({
    record: { id: 'kw-y', version: 1, selectionMetadata: { pageId: 'p', topics: ['nothing'], applicability: { mode: 'unreviewed' } } },
    target: TARGET, features: FEATURES,
  });
  assert.deepEqual(none.matchedFeatures, []);
});

// --- pure: defects vs warnings ----------------------------------------------------

await test('an injected unreviewed unit, a broken sidecar and a vanished record are defects', () => {
  const store = buildStore();
  const reviewed = transferRecord(store);
  const unreviewed = wikiRecordOf(store, 'hw-mbarrier');
  const selection = { sources: [{ recordId: reviewed.id, version: reviewed.version }, { recordId: 'kw-ghost', version: 1 }] };
  const wikiItems = [
    wikiRelevance({ record: reviewed, target: TARGET, features: FEATURES }),
    { ...wikiRelevance({ record: unreviewed, target: TARGET, features: FEATURES }), reason: 'technique-match', bucket: 'technique' },
    { recordId: 'kw-vanished', version: 1, missingRecord: true },
  ];
  const codes = selectionDefects({ selection, wikiItems }).map((defect) => defect.code);
  assert.ok(codes.includes('unreviewed-wiki-injected'), 'injecting an unreviewed unit must be a defect');
  assert.ok(codes.includes('wiki-item-missing-provenance'), 'an injected item with no sidecar entry must be a defect');
  assert.ok(codes.includes('wiki-record-absent-from-final-store'), 'a record gone from the final store must be reported');
  assert.ok(codes.includes('provenance-without-item'), 'a sidecar entry with no injected item must be a defect');
  // The clean case must be empty: a detector that always fires is not a detector.
  assert.deepEqual(selectionDefects({
    selection: { sources: [{ recordId: reviewed.id, version: reviewed.version }] },
    wikiItems: [wikiRelevance({ record: reviewed, target: TARGET, features: FEATURES })],
  }), []);
});

await test('weak relevance is a warning, never a defect', () => {
  const store = buildStore();
  const unreviewed = wikiRecordOf(store, 'hw-mbarrier');
  const offTarget = { ...wikiRelevance({ record: unreviewed, target: TARGET, features: FEATURES }) };
  const codes = relevanceWarnings({ wikiItems: [offTarget] }).map((warning) => warning.code);
  assert.deepEqual(codes, ['declared-architecture-excludes-target', 'no-feature-topic-overlap']);
  const onTarget = wikiRelevance({ record: transferRecord(store), target: TARGET, features: FEATURES });
  assert.deepEqual(relevanceWarnings({ wikiItems: [onTarget] }), []);
  assert.deepEqual(selectionDefects({ selection: { sources: [] }, wikiItems: [] }), []);
});

await test('exclusion reasons are counted with unreviewed surfaced and the truncated tail kept visible', () => {
  const summary = exclusionSummary({
    excluded: [{ id: 'a', version: 1, reason: 'unreviewed' }, { id: 'b', version: 1, reason: 'unreviewed' }, { id: 'c', version: 1, reason: 'scope' }],
    excludedOmitted: 3,
    excludedUnauthorized: 1,
  });
  assert.deepEqual(summary.byReason, { unreviewed: 2, scope: 1 });
  assert.equal(summary.unreviewed, 2);
  assert.equal(summary.omitted, 3);
  assert.equal(summary.unauthorized, 1);
  assert.equal(exclusionSummary(undefined).total, 0, 'a selection without exclusions must not throw');
});

// --- pure: row building and aggregation -------------------------------------------

await test('a row keeps only KernelWiki items in `wiki`, carries the policy reason, and tolerates a vanished record', () => {
  const store = buildStore();
  const local = store.records.find((record) => record.id === 'exp-local-0001');
  const transfer = transferRecord(store);
  const rows = {
    records: new Map([[`${transfer.id}@${transfer.version}`, transfer]]),
  };
  const selection = {
    roundId: ROUND, contextId: 'EXPCTX_test', experienceCondition: 'local-and-wiki', policyVersion: WIKI_SELECTION_POLICY_VERSION,
    scope: SCOPE, target: TARGET, features: FEATURES, sources: [{ recordId: transfer.id, version: transfer.version }],
    selected: [
      { id: local.id, version: local.version, source: 'human', useAs: 'suggestion', reason: 'feature-match', bucket: 'local' },
      { id: transfer.id, version: transfer.version, source: 'human', useAs: 'suggestion', reason: 'technique-match', bucket: 'technique' },
      { id: 'kw-vanished', version: 1, source: 'human', useAs: 'suggestion', reason: 'technique-match', bucket: 'technique' },
    ],
    excluded: [],
  };
  const row = buildAuditRow({ runDir: '/run', selection, loopStartedAt: CLOCK, records: rows.records });
  assert.deepEqual(row.wiki.map((item) => item.recordId), [transfer.id, 'kw-vanished'], 'the local record must not be counted as wiki');
  assert.equal(row.wiki[0].reason, 'technique-match', 'the audit\'s own reason code is what gets reported');
  assert.equal(row.wiki[0].bucket, 'technique');
  assert.equal(row.wiki[1].missingRecord, true, 'a record gone from the final store is marked, not silently dropped');
  assert.deepEqual(row.defects.map((defect) => defect.code), ['wiki-record-absent-from-final-store']);
  assert.equal(row.selectedCount, 3);
  // Records absent from the store can only be recognised by the canonical id prefix, so the
  // rule the audit row was built with (`kernelWikiRecordId`) must be the fallback.
  assert.equal(buildAuditRow({ runDir: '/run', selection: { ...selection, selected: [] }, loopStartedAt: null, records: new Map() }).loopStartedAt, null);
});

await test('summary groups by condition and reports hit rates over audits, not runs', () => {
  const row = (experienceCondition, wikiCount, extra = {}) => ({
    run: '/run-a', experienceCondition, wiki: Array.from({ length: wikiCount }, (_value, index) => ({ recordId: `kw-${index}`, version: 1 })), defects: [], relevanceWarnings: [], ...extra,
  });
  const summary = summarize([row('local-and-wiki', 1), row('local-and-wiki', 0), row(null, 0), { ...row('local-only', 0), run: '/run-b' }]);
  assert.equal(summary.audits, 4);
  assert.equal(summary.runs, 2, 'runs are counted by distinct directory');
  assert.equal(summary.wikiHitAudits, 1);
  assert.equal(summary.wikiItemsSelected, 1);
  assert.deepEqual(summary.distinctWikiUnits, ['kw-0@1']);
  assert.deepEqual(summary.byCondition.map((entry) => [entry.condition, entry.audits, entry.wikiHits]), [
    ['(unset)', 1, 0], ['local-and-wiki', 2, 1], ['local-only', 1, 0],
  ]);
  assert.equal(summary.wikiCapBinds, 0, 'a row that never recorded a quota-wiki exclusion cannot claim the cap bound');
});

await test('whether the injection cap ever bound is read from the persisted audits, not asserted', () => {
  // The cap "binding" has exactly one observable: a candidate the audit recorded as excluded for
  // `quota-wiki`. Anything else (a full page of wiki items, a high cap) is not evidence.
  const audit = (wikiQuota, wikiCount, quotaWikiExclusions) => ({
    run: '/run-a', experienceCondition: 'local-and-wiki', wikiQuota, defects: [], relevanceWarnings: [],
    wiki: Array.from({ length: wikiCount }, (_value, index) => ({ recordId: `kw-${index}`, version: 1 })),
    exclusions: { total: quotaWikiExclusions, byReason: quotaWikiExclusions ? { 'quota-wiki': quotaWikiExclusions } : {} },
  });
  const inert = summarize([audit(6, 1, 0), audit(6, 0, 0)]);
  assert.deepEqual(inert.quotaProfiles, [{ wiki: 6, audits: 2, maxSelected: 1, cutByCap: 0 }]);
  assert.equal(inert.wikiCapBinds, 0);
  const binding = summarize([audit(6, 1, 0), audit(3, 3, 2), audit(3, 2, 0)]);
  assert.deepEqual(binding.quotaProfiles, [
    { wiki: 3, audits: 2, maxSelected: 3, cutByCap: 2 },
    { wiki: 6, audits: 1, maxSelected: 1, cutByCap: 0 },
  ], 'each round is attributed to the cap the audit recorded at the time');
  assert.equal(binding.wikiCapBinds, 1, 'only the round with a quota-wiki exclusion proves the cap cut a candidate');
  // An audit that predates the field must be reported as unrecorded, never defaulted to today's cap.
  assert.deepEqual(summarize([{ run: '/run', experienceCondition: null, wiki: [], defects: [], relevanceWarnings: [] }]).quotaProfiles,
    [{ wiki: null, audits: 1, maxSelected: 0, cutByCap: 0 }]);
});

// --- I/O: audit collection and corpus discovery ------------------------------------

await test('audits are deduped by contextId, and a run directory is only one with both a store and a db', async () => {
  const selection = { roundId: ROUND, contextId: 'EXPCTX_same' };
  const audits = collectAudits({ a: { roundExperienceSelection: selection, loopStartedAt: CLOCK }, b: [{ roundExperienceSelection: selection }, { roundExperienceSelection: { roundId: 'R2', contextId: 'EXPCTX_other' } }] });
  assert.equal(audits.length, 2, 'the same contextId reachable through two paths is one audit');
  assert.equal(audits[0].loopStartedAt, CLOCK, 'the replay clock comes from the surrounding iteration stats');

  const root = path.join(scratch, 'discovery');
  // A fixture-shaped checkout snapshot must never be walked into.
  await mkdir(path.join(root, 'frozen-snapshot', 'client-runtime'), { recursive: true });
  await writeFile(path.join(root, 'frozen-snapshot', 'package.json'), '{}', 'utf8');
  await mkdir(path.join(root, 'frozen-snapshot', 'docs', 'evidence', 'runtime', 'experiences'), { recursive: true });
  await writeFile(path.join(root, 'frozen-snapshot', 'docs', 'evidence', 'runtime', 'experiences', 'experiences.json'), '{"records":[]}', 'utf8');
  await mkdir(path.join(root, 'frozen-snapshot', 'docs', 'evidence', 'data'), { recursive: true });
  await writeFile(path.join(root, 'frozen-snapshot', 'docs', 'evidence', 'data', 'mock-db.json'), '{}', 'utf8');
  await mkdir(path.join(root, 'node_modules', 'junk', 'runtime', 'experiences'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'junk', 'data'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'junk', 'runtime', 'experiences', 'experiences.json'), '{"records":[]}', 'utf8');
  await writeFile(path.join(root, 'node_modules', 'junk', 'data', 'mock-db.json'), '{}', 'utf8');
  // The real run directory.
  await mkdir(path.join(root, 'runs', 'slot-01', 'runtime', 'experiences'), { recursive: true });
  await writeFile(path.join(root, 'runs', 'slot-01', 'runtime', 'experiences', 'experiences.json'), '{"records":[]}', 'utf8');
  await mkdir(path.join(root, 'runs', 'slot-01', 'data'), { recursive: true });
  await writeFile(path.join(root, 'runs', 'slot-01', 'data', 'mock-db.json'), '{}', 'utf8');
  // A store without its database is not a run either.
  await mkdir(path.join(root, 'half', 'runtime', 'experiences'), { recursive: true });
  await writeFile(path.join(root, 'half', 'runtime', 'experiences', 'experiences.json'), '{"records":[]}', 'utf8');

  const discovered = discoverRunDirs(root);
  assert.deepEqual(discovered.runDirs.map((dir) => path.basename(dir)), ['slot-01']);
  assert.deepEqual(discovered.skippedCheckouts.map((dir) => path.basename(dir)), ['frozen-snapshot'],
    'a repo snapshot must be reported as skipped, never counted as a run');
});

// --- secondary evidence: the confounded re-run -------------------------------------

await test('the re-run never claims to be the round selection: no clock or a drifted policy skips it with its confounds named', () => {
  const store = buildStore();
  const selection = { policyVersion: WIKI_SELECTION_POLICY_VERSION, projectId: PROJECT, missionId: MISSION, roundId: ROUND, scope: SCOPE, features: FEATURES, target: TARGET, selected: [] };
  const noClock = recheckSelection({ store, selection, now: null });
  assert.equal(noClock.status, 'skipped');
  assert.match(noClock.reason, /loopStartedAt/u);
  assert.equal(noClock.confounds.length, 3, 'the confounds must travel with every verdict, skips included');
  assert.ok(noClock.confounds.some((entry) => /quota-profile-is-not-part-of-the-policy-version/u.test(entry)),
    'a quota change is invisible to the policy version, so the re-run must name it as a confound');
  const drifted = recheckSelection({ store, selection: { ...selection, policyVersion: 'operator-studio.optimization-hypothesis-selection/v0' }, now: CLOCK });
  assert.equal(drifted.status, 'skipped');
  assert.match(drifted.reason, /policy version changed/u);
});

await test('a difference explained by a record written after the round is labelled as store visibility, not as a selection change', () => {
  const store = buildStore();
  const persisted = retrieveExperienceSelection(store, query(), { now: CLOCK }).selection;
  const wikiKey = transferRecord(store).id + '@1';
  assert.ok(persisted.selected.some((entry) => entry.id.startsWith('kw-')), 'the fixture must select the reviewed-transfer unit to be meaningful');

  const unchanged = recheckSelection({ store, selection: persisted, now: CLOCK });
  assert.equal(unchanged.status, 'same');
  assert.deepEqual(unchanged.confounds.length, 3);

  // A local record appended AFTER the round: today's store sees it, the round could not.
  const later = buildStore();
  appendExperience(later, {
    source: 'human', kind: 'guidance', projectId: PROJECT, visibility: 'project',
    title: 'Written after the round', content: 'Post-round observation.', author: 'tester',
    confidence: 'medium', scope: SCOPE,
  }, { id: 'exp-local-later', now: AFTER_CLOCK, source: 'human' });
  const afterRound = recheckSelection({ store: later, selection: persisted, now: CLOCK });
  assert.equal(afterRound.status, 'differs-only-by-post-round-records');
  assert.equal(afterRound.removed.length, 0, 'nothing selected at the time may be lost');
  assert.deepEqual(afterRound.added.map((entry) => entry.key), ['exp-local-later@1']);
  assert.equal(afterRound.added[0].postdatesRound, true);
  assert.equal(afterRound.added[0].createdAt, AFTER_CLOCK);
  assert.ok(afterRound.replayed.includes(wikiKey), 'the KernelWiki unit must be reproduced by the re-run');

  // A record that already existed at the time but was NOT selected: the difference is
  // real, so the label must stay `differs` instead of swallowing it.
  const preexisting = buildStore();
  appendExperience(preexisting, {
    source: 'human', kind: 'guidance', projectId: PROJECT, visibility: 'project',
    title: 'Written before the round', content: 'Pre-existing observation.', author: 'tester',
    confidence: 'medium', scope: SCOPE,
  }, { id: 'exp-local-earlier', now: '2026-09-16T14:00:00.000Z', source: 'human' });
  const unexplained = recheckSelection({ store: preexisting, selection: persisted, now: CLOCK });
  assert.equal(unexplained.status, 'differs', `expected an unexplained difference, got ${unexplained.status}`);
  assert.deepEqual(unexplained.added.map((entry) => entry.key), ['exp-local-earlier@1']);
  assert.equal(unexplained.added[0].postdatesRound, false, 'a record that predates the round is not an explanation');
  void wikiKey;
});

// --- end to end over a fixture corpus, then the CLI --------------------------------

const writeFixture = async (name, { selection, store }) => {
  const runDir = path.join(scratch, 'corpus', name);
  await mkdir(path.join(runDir, 'runtime', 'experiences'), { recursive: true });
  await mkdir(path.join(runDir, 'data'), { recursive: true });
  await writeFile(path.join(runDir, 'runtime', 'experiences', 'experiences.json'), JSON.stringify(store), 'utf8');
  await writeFile(path.join(runDir, 'data', 'mock-db.json'), JSON.stringify({ mission: { iterationStats: { loopStartedAt: CLOCK, roundExperienceSelection: selection } } }), 'utf8');
  return runDir;
};

await test('end to end: a real audited selection replays as a clean hit, and the CLI exits 0 on it', async () => {
  const store = buildStore();
  const persisted = retrieveExperienceSelection(store, query({ selection: { ...query().selection, experienceCondition: 'local-and-wiki' } }), { now: CLOCK }).selection;
  assert.deepEqual(persisted.experienceCondition, 'local-and-wiki');
  // Production stores are validated; this fixture must be a store the contract accepts.
  validateExperienceStore(store);
  const runDir = await writeFixture('clean-hit', { selection: persisted, store });
  const report = replayRuns({ runDirs: [runDir] });
  assert.equal(report.summary.audits, 1);
  assert.equal(report.summary.wikiHitAudits, 1, 'the wiki hit must be visible in the aggregate');
  assert.deepEqual(report.summary.defects, [], 'a genuine reviewed-transfer hit is not a defect');
  assert.deepEqual(report.summary.relevanceWarnings, [], 'arch, hardware and topic all match, so there is no warning');
  // Two pages plus the reviewed transfer unit of one of them: the transfer is its own
  // unit, which is exactly why a report must annotate per unit and not per page.
  assert.equal(report.runs[0].kernelWikiRecords, 3);
  const cli = spawnSync(process.execPath, [scriptPath, '--json', '--run', runDir], { encoding: 'utf8', shell: false });
  assert.equal(cli.status, 0, `the CLI must exit 0 on a clean hit\n${cli.stderr}`);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.summary.wikiItemsSelected, 1);
  assert.equal(parsed.rows[0].wiki[0].reason, 'technique-match');
  assert.equal(parsed.rows[0].wiki[0].architectureBasis, 'reviewed-applicability');
});

await test('the CLI exits non-zero when the audit carries an unreviewed injection, and names it', async () => {
  const store = buildStore();
  const unreviewed = wikiRecordOf(store, 'hw-mbarrier');
  const reviewed = transferRecord(store);
  const tampered = {
    schemaVersion: 'operator-studio.experience-selection/v1', policyVersion: WIKI_SELECTION_POLICY_VERSION,
    experienceCondition: 'local-and-wiki', projectId: PROJECT, missionId: MISSION, roundId: ROUND,
    contextId: 'EXPCTX_tampered', scope: SCOPE, target: TARGET, features: FEATURES,
    sources: [{ recordId: unreviewed.id, version: unreviewed.version }],
    selected: [{ id: unreviewed.id, version: unreviewed.version, source: 'human', useAs: 'suggestion', reason: 'technique-match', bucket: 'technique' }],
    excluded: [],
  };
  const runDir = await writeFixture('unreviewed-injection', { selection: tampered, store });
  const report = replayRuns({ runDirs: [runDir] });
  assert.deepEqual(report.summary.defects.map((defect) => defect.code), ['unreviewed-wiki-injected', 'declared-architecture-excludes-target', 'no-feature-topic-overlap'].slice(0, 1));
  const cli = spawnSync(process.execPath, [scriptPath, '--json', '--run', runDir], { encoding: 'utf8', shell: false });
  assert.equal(cli.status, 1, 'a defect must make the CLI exit non-zero');
  assert.match(cli.stdout, /unreviewed-wiki-injected/u);
  void reviewed;
});

await test('the CLI reports usage and unreadable roots with distinct exit codes instead of a stack trace', () => {
  const bad = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8', shell: false });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --nope/u);
  assert.match(bad.stderr, /Usage:/u);
  const missing = spawnSync(process.execPath, [scriptPath, '--root', path.join(scratch, 'does-not-exist')], { encoding: 'utf8', shell: false });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /根目录不可读/u);
  const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8', shell: false });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--recheck/u);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
