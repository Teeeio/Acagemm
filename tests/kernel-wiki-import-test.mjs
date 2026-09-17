// Independent acceptance matrix for PHASE3_WIKI_CONTRACT.md section B (and the
// import half of section D): the KernelWiki page parser, the deterministic
// snapshot builder, the atomic apply path and the pinned offline CLI.
//
// The apply path runs against the real experience repository (atomic file
// store). The CLI runs against throwaway Git repositories created here: it must
// read only committed blobs at the pinned commit, ignore dirty working-tree
// content, refuse to overwrite an output file and never touch a live store. No
// model, network, Python or GPU process is started.
//
// Written before the parallel B candidate was combined: until the combination
// provides `client-runtime/kernel-wiki-import.mjs` and `scripts/import-kernel-wiki.mjs`
// this file can only be syntax-checked, and the author phase runs `node --check`
// only. A green run after combination is contract/integration evidence for the
// frozen interface, never a live-CLI, stability or publishability claim.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createExperienceRepository } from '../client-runtime/experience-repository.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { validateExperienceStore } from '../client-runtime/experience-contract.mjs';
import { parseKernelWikiPage, buildKernelWikiSnapshot, applyKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const SNAPSHOT_SCHEMA = 'operator-studio.kernel-wiki-snapshot/v1';
const PINNED_COMMIT = 'b6b4301f15e8ce6955a56776690643ce5db369e6';
const MIT_LICENSE = [
  'MIT License',
  '',
  'Copyright (c) 2026 KernelWiki authors',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
  '',
].join('\n');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-wiki-import-test-'));
const PROJECT = 'project-a';
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
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// The contract freezes the snapshot digest as "SHA256 of canonical recursively
// key-sorted JSON of envelope WITHOUT snapshotDigest". Recomputed here instead of
// trusting the producer with its own digest.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const envelopeDigest = (envelope) => {
  const withoutDigest = { ...envelope };
  delete withoutDigest.snapshotDigest;
  return sha256(JSON.stringify(canonical(withoutDigest)));
};
const recordIdFor = (projectId, unitId) => `kw-${sha256(projectId).slice(0, 16)}-${unitId}`;
const digestOf = (snapshot) => snapshot.snapshotDigest ?? snapshot.digest;
const records = async (repository) => (await repository.read()).records;
const findRecord = (list, id) => list.find((record) => record.id === id);
// The store keeps versions in insertion order, so the head of an ID is its last
// entry, not its first.
const headRecord = (list, id) => list.filter((record) => record.id === id).at(-1);
const unitOf = (snapshot, unitId) => snapshot.units.find((unit) => unit.unitId === unitId);
// The parser DTO field names are not frozen by the contract; the snapshot
// envelope and the apply outcome are. Read identity tolerantly, assert the
// frozen surface strictly.
const identityOf = (parsed) => ({
  pageId: parsed.pageId ?? parsed.id,
  title: parsed.title,
  type: parsed.type,
  topics: [...(parsed.topics ?? parsed.tags ?? [])],
  symptoms: [...(parsed.symptoms ?? [])],
  candidateTechniques: [...(parsed.candidateTechniques ?? parsed.candidate_techniques ?? [])],
  architectures: [...(parsed.architectures ?? [])],
  body: String(parsed.body ?? parsed.content ?? parsed.markdown ?? ''),
});
// A rejected input must fail for its own rule with an explicit domain error code,
// never with an unrelated TypeError or an assertion raised by a broken fixture.
// The pure importer's code names are not frozen by the contract, so this pins the
// code kind (a screaming-snake domain code) instead of guessing a name; the
// one-aspect mutation in every negative is what keeps the branch honest.
const codedFailure = (error) => {
  assert.ok(error instanceof Error, `a rejected input must throw an Error, saw ${String(error)}`);
  assert.match(String(error?.code ?? ''), /^[A-Z][A-Z0-9_]+$/u, `a rejected input must carry an explicit domain error code, saw ${JSON.stringify(error?.code)}`);
  return true;
};
// A refused CLI run is observed at the process level: the only error code the CLI
// has is its own non-zero exit (or a spawn failure code).
const cliFailure = (error) => {
  const code = error?.code;
  assert.ok((typeof code === 'number' && code !== 0) || (typeof code === 'string' && code.length > 0), `a refused CLI run must fail with a non-zero process exit code, saw ${JSON.stringify(code)}`);
  return true;
};

// `pages` is the documented `[{path,text}]` shape, so callers must pass `.text`
// to the string API: the helper never returns a bare string.
const sourcePage = ({ id, path: overridePath, title, type, tags = [], symptoms = [], techniques = [], architectures = [], body, extra = [] }) => ({
  path: overridePath ?? `wiki/techniques/${id}.md`,
  text: [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    `type: ${type}`,
    `tags: [${tags.map((tag) => `"${tag}"`).join(', ')}]`,
    'architectures:',
    ...architectures.map((value) => `  - ${value}`),
    'symptoms:',
    ...(symptoms.length ? symptoms.map((value) => `  - ${value}`) : ['  - none-recorded']),
    'candidate_techniques:',
    ...techniques.map((value) => `  - ${value}`),
    ...extra,
    '---',
    '',
    body,
    '',
  ].join('\n'),
});
const PERFORMANCE_CLAIMS = [
  'performance_claims:',
  '  speedup: "1.4x"',
  '  baseline: "unverified upstream claim"',
  '  nested:',
  '    note: "must never be read as evidence"',
];
const archReview = (pageId, reviewId) => ({
  pageId, reviewId, mode: 'architecture-specific',
  hardware: ['nvidia-gpu'], architectures: ['sm86'], requiredCapabilities: [], software: [],
});
const transferReview = (pageId, reviewId, content) => ({
  pageId, reviewId, mode: 'reviewed-transfer', content,
  topics: ['vectorization'], hardware: ['nvidia-gpu'], architectures: ['sm86'], requiredCapabilities: [], software: [],
});
const setupRepo = async (name) => {
  const rootDir = path.join(scratch, name);
  return { rootDir, repository: createExperienceRepository({ rootDir }), file: path.join(rootDir, 'experiences.json') };
};
// The real repository transaction owns revision/atomicity. The pure apply API
// answers with the documented {changed,result} envelope; `repository.transact`
// returns `clone(outcome.result)` after validating `changed`, so the wrapper
// keeps `changed` from the envelope and exposes exactly the documented result
// fields below. `assertApplyResultShape` is what proves that shape at the
// combination point instead of assuming it.
const importSnapshot = async (repository, snapshot, options) => {
  let outcome = null;
  const result = await repository.transact((draft) => {
    outcome = applyKernelWikiSnapshot(draft, snapshot, options);
    return outcome;
  });
  assert.equal(typeof outcome?.changed, 'boolean', 'the apply API must answer with a {changed,result} envelope');
  assert.ok(outcome.result && typeof outcome.result === 'object', 'the apply envelope must carry its result object');
  return { changed: outcome.changed, result };
};
const assertApplyResultShape = (result, label) => {
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), `${label}: the apply result must be a plain object`);
  for (const key of ['created', 'updated', 'unchanged']) assert.equal(typeof result[key], 'number', `${label}: ${key} must be a count`);
  assert.ok(Array.isArray(result.records), `${label}: records must be an array`);
  for (const record of result.records) {
    assert.equal(typeof record.id, 'string', `${label}: a record entry names its id`);
    assert.ok(record.id.length > 0 && record.id.length <= 160, `${label}: a record id stays inside the 160-character bound`);
    assert.equal(typeof record.version, 'number', `${label}: a record entry names its version`);
  }
  assert.equal(result.sourceCommit, PINNED_COMMIT, `${label}: the result names the pinned source commit`);
  assert.match(String(result.snapshotDigest ?? ''), /^[0-9a-f]{64}$/u, `${label}: the result names the applied snapshot digest`);
  return result;
};
const gitRepo = async (name, files) => {
  const root = path.join(scratch, name);
  await fs.mkdir(root, { recursive: true });
  const write = async (relative, content) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  };
  const git = async (...args) => (await execFileAsync('git', args, { cwd: root, windowsHide: true })).stdout.trim();
  for (const [relative, content] of Object.entries(files)) await write(relative, content);
  await git('init', '-q');
  await git('config', 'user.name', 'Kernel Wiki Import Test');
  await git('config', 'user.email', 'wiki-import@test.invalid');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'wiki baseline');
  return { root, write, git, commit: await git('rev-parse', 'HEAD') };
};

try {
  await test('real source-like frontmatter parses, including quoted colons, block lists and ignored nested blocks', async () => {
    const page = sourcePage({
      id: 'tail-handling',
      title: 'Tail handling: vectorized remainder loop',
      type: 'technique',
      tags: ['vectorization', 'tail'],
      symptoms: ['tail-effect'],
      techniques: ['masked-tail-loop'],
      architectures: ['sm86', 'sm90'],
      extra: PERFORMANCE_CLAIMS,
      body: '# Tail handling\n\nWhen the reduction shape is not a multiple of the vector width, mask the final block.',
    });
    const parsed = identityOf(parseKernelWikiPage(page.text, { path: page.path }));
    assert.equal(parsed.pageId, 'tail-handling');
    assert.equal(parsed.title, 'Tail handling: vectorized remainder loop', 'a quoted colon must survive as a scalar');
    assert.equal(parsed.type, 'technique');
    assert.deepEqual([...parsed.architectures].sort(), ['sm86', 'sm90'], 'a block list is read in full');
    assert.deepEqual([...parsed.topics].sort(), ['tail', 'vectorization'], 'an inline list is read in full');
    assert.deepEqual(parsed.symptoms, ['tail-effect']);
    assert.deepEqual(parsed.candidateTechniques, ['masked-tail-loop']);
    assert.match(parsed.body, /mask the final block/);
    const serialized = JSON.stringify(parseKernelWikiPage(page.text, { path: page.path }));
    assert.equal(serialized.includes('1.4x'), false, 'a nested performance_claims block is ignored');
    assert.equal(serialized.includes('unverified upstream claim'), false);
    assert.equal(serialized.includes('must never be read as evidence'), false);
    assert.deepEqual(parseKernelWikiPage(page.text, { path: page.path }), parseKernelWikiPage(page.text, { path: page.path }), 'parsing is deterministic');
    // Unknown scalar metadata is ignored rather than fatal (or retained verbatim).
    const withExtra = sourcePage({
      id: 'tail-handling', title: 'Tail handling', type: 'technique', tags: ['vectorization'],
      architectures: ['sm86'], body: 'Body.',
      extra: [...PERFORMANCE_CLAIMS, 'maintainer: someone', 'reviewed_at: "2026-01-01T00:00:00Z"'],
    });
    assert.equal(identityOf(parseKernelWikiPage(withExtra.text, { path: withExtra.path })).pageId, 'tail-handling');
    // `pattern` is a real Wiki type and must be retained as-is, not coerced away.
    const pattern = sourcePage({
      id: 'tail-pattern', title: 'Tail pattern', type: 'pattern', tags: ['vectorization'],
      symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: [], body: 'Pattern body.',
    });
    const parsedPattern = identityOf(parseKernelWikiPage(pattern.text, { path: pattern.path }));
    assert.equal(parsedPattern.type, 'pattern');
    assert.deepEqual(parsedPattern.architectures, [], 'an empty architecture block is retained as empty');
    const emptyArchitectureSnapshot = buildKernelWikiSnapshot({ pages: [pattern], sourceCommit: PINNED_COMMIT, reviews: [] });
    assert.deepEqual(unitOf(emptyArchitectureSnapshot, 'tail-pattern').selectionMetadata.architectures, [], 'an empty architecture is retained but cannot auto-qualify');
  });

  await test('malformed pages and oversized sources fail explicitly instead of importing a partial unit', async () => {
    const valid = sourcePage({
      id: 'tail-handling', title: 'Tail handling', type: 'technique',
      tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'],
      architectures: ['sm86'], extra: PERFORMANCE_CLAIMS, body: 'Body.',
    });
    const at = (text, pagePath = valid.path) => () => parseKernelWikiPage(text, { path: pagePath });
    // Every negative starts from the complete valid page and mutates one aspect,
    // so each one fails for its intended reason and not for a broken fixture.
    assert.throws(at(valid.text.replace('type: technique\n', '')), codedFailure, 'a missing type is rejected');
    assert.throws(at(valid.text.replace('id: tail-handling\n', '')), codedFailure, 'a missing id is rejected');
    assert.throws(at(valid.text.replace('id: tail-handling', 'id: ""')), codedFailure, 'an empty id is rejected');
    assert.throws(at(valid.text.replace('id: tail-handling', 'id: bad id!')), codedFailure, 'an unsafe page id is rejected');
    assert.throws(at(valid.text.replace('id: tail-handling\n', 'id: one\nid: two\n')), codedFailure, 'a duplicate scalar key is rejected');
    assert.throws(at('# No frontmatter at all\n'), codedFailure, 'missing frontmatter is rejected');
    assert.throws(at('---\nid: x\ntitle: "unterminated\n---\n'), codedFailure, 'unterminated frontmatter is rejected');
    // The title is display text, not import identity: a page without a frontmatter
    // title still imports. The fallback is deterministic and is asserted as one
    // exact value per page, never as "one of these" - a title that could be
    // either the heading or the page id is not a checked behaviour.
    const untitled = identityOf(parseKernelWikiPage(valid.text.replace('title: "Tail handling"\n', ''), { path: valid.path }));
    assert.equal(untitled.pageId, 'tail-handling', 'a missing title never breaks page identity');
    assert.equal(untitled.title, 'tail-handling', 'with neither a frontmatter title nor a heading the display title falls back to the page id');
    const headed = identityOf(parseKernelWikiPage(
      valid.text.replace('title: "Tail handling"\n', '').replace('Body.', 'Body.\n\n# Heading derived title\n'),
      { path: valid.path },
    ));
    assert.equal(headed.pageId, 'tail-handling');
    assert.equal(headed.title, 'Heading derived title', 'a missing frontmatter title falls back to the first markdown heading');
    assert.throws(at(valid.text, '../outside.md'), codedFailure, 'a path outside wiki/ is rejected');
    assert.throws(at(valid.text, 'wiki/../../etc/passwd.md'), codedFailure, 'a traversal path is rejected');
    assert.throws(at(valid.text, '/etc/wiki/page.md'), codedFailure, 'an absolute path is rejected');
    const oversized = sourcePage({
      id: 'oversized-page', title: 'Oversized page', type: 'technique',
      tags: ['vectorization'], architectures: ['sm86'], body: 'x'.repeat(9000),
    });
    assert.throws(() => parseKernelWikiPage(oversized.text, { path: oversized.path }), codedFailure, 'a page above the 8000-character bound is rejected, never silently cut');
    assert.throws(() => buildKernelWikiSnapshot({ pages: [oversized], sourceCommit: PINNED_COMMIT, reviews: [] }), codedFailure, 'the builder rejects an oversized page before any snapshot exists');
  });

  await test('the snapshot builder is deterministic, digest-pinned and sensitive to source changes', async () => {
    const pages = [
      sourcePage({ id: 'tail-handling', title: 'Tail handling', type: 'technique', tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'], extra: PERFORMANCE_CLAIMS, body: 'First body.' }),
      sourcePage({ id: 'tail-effect', title: 'Tail effect', type: 'symptom', tags: ['tail'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'], body: 'Symptom body.' }),
    ];
    const reviews = [archReview('tail-handling', 'review-sm86-1')];
    const snapshot = buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews });
    assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA);
    assert.equal(snapshot.sourceCommit, PINNED_COMMIT);
    assert.match(digestOf(snapshot), /^[0-9a-f]{64}$/, 'the snapshot pins its own digest');
    assert.equal(digestOf(snapshot), envelopeDigest(snapshot), 'the digest is the canonical envelope digest, recomputed independently');
    assert.deepEqual(snapshot.units.map((unit) => unit.unitId), [...snapshot.units.map((unit) => unit.unitId)].sort(), 'units are ordered deterministically by unitId');
    for (const unit of snapshot.units) {
      assert.deepEqual(Object.keys(unit).sort(), ['content', 'evidenceRefs', 'scope', 'selectionMetadata', 'title', 'unitId'], `unit keys are frozen: ${JSON.stringify(Object.keys(unit))}`);
      assert.equal(unit.selectionMetadata.source, 'kernel-wiki');
      assert.equal(unit.selectionMetadata.sourceCommit, PINNED_COMMIT);
      assert.equal(unit.selectionMetadata.pageId, unit.unitId === 'tail-handling' ? 'tail-handling' : 'tail-effect');
      assert.equal(unit.selectionMetadata.unitDigest, sha256(unit.content), 'the unit digest covers the injected content');
      assert.match(unit.selectionMetadata.sourceDigest, /^[0-9a-f]{64}$/);
      assert.match(unit.content, /https?:\/\//u, 'content keeps the source URL');
      // The frozen content must cite the exact source revision it came from: a
      // page whose injected text does not name the pinned commit cannot be traced
      // back to the blob it was read from.
      assert.ok(unit.content.includes(PINNED_COMMIT), `content cites the pinned source commit, saw ${unit.content}`);
      assert.ok(Array.isArray(unit.evidenceRefs));
      // The raw snapshot unit scope is the pre-domain envelope shape: it carries
      // no normalized tags, so an absent `tags` key is the correct state and must
      // never be the page's source topics. Normalization is asserted on the store
      // record below, where the domain contract does require `scope.tags === []`.
      assert.deepEqual(unit.scope.tags ?? [], [], 'raw Wiki topics never become raw unit scope tags');
      for (const topic of unit.selectionMetadata.topics ?? []) {
        assert.equal(JSON.stringify(unit.scope).includes(topic), false, `the raw unit scope never copies the source topic ${topic}`);
      }
    }
    const raw = unitOf(snapshot, 'tail-effect');
    assert.equal(raw.selectionMetadata.sourceDigest, sha256(pages[1].text), 'the source digest covers the complete original page');
    assert.equal(JSON.stringify(snapshot).includes('1.4x'), false, 'upstream performance claims never enter the snapshot');
    assert.deepEqual(buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews }), snapshot, 'identical input yields an identical snapshot');

    const changedPage = { ...pages[1], text: pages[1].text.replace('Symptom body.', 'Changed symptom body.') };
    const changed = buildKernelWikiSnapshot({ pages: [pages[0], changedPage], sourceCommit: PINNED_COMMIT, reviews });
    assert.notEqual(digestOf(changed), digestOf(snapshot), 'a changed page changes the digest');
    assert.notEqual(unitOf(changed, 'tail-effect').selectionMetadata.unitDigest, raw.selectionMetadata.unitDigest);
    assert.notEqual(digestOf(buildKernelWikiSnapshot({ pages, sourceCommit: 'f'.repeat(40), reviews })), digestOf(snapshot), 'a changed pin changes the digest');
    const otherTitle = buildKernelWikiSnapshot({ pages: [pages[0], { ...pages[1], text: pages[1].text.replace('Tail effect', 'Tail effect renamed') }], sourceCommit: PINNED_COMMIT, reviews });
    assert.notEqual(digestOf(otherTitle), digestOf(snapshot), 'a changed frontmatter scalar changes the digest');

    // Complete valid fixtures, one broken aspect each.
    assert.throws(() => buildKernelWikiSnapshot({ pages: [pages[0], { ...pages[1], path: pages[0].path }], sourceCommit: PINNED_COMMIT, reviews: [] }), codedFailure, 'duplicate page paths are rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages: [pages[0], { ...pages[1], path: 'wiki/symptoms/tail-effect.md', text: pages[1].text.replace('id: tail-effect', 'id: tail-handling') }], sourceCommit: PINNED_COMMIT, reviews: [] }), codedFailure, 'duplicate page ids are rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews: [archReview('missing-page', 'review-sm86-1')] }), codedFailure, 'a review for an unknown page is rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages, sourceCommit: 'not-a-commit', reviews: [] }), codedFailure, 'a malformed pin is rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT.toUpperCase(), reviews: [] }), codedFailure, 'an uppercase pin is rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages, reviews: [] }), codedFailure, 'a missing pin is rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages: [], sourceCommit: PINNED_COMMIT, reviews: [] }), codedFailure, 'an empty page list is rejected');
    assert.throws(() => buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews: [transferReview('tail-handling', 'review-transfer-1', '')] }), codedFailure, 'a reviewed transfer without explicit content is rejected');
    const bulk = (count) => Array.from({ length: count }, (_, index) => sourcePage({
      id: `bulk-${index}`, title: `Bulk page ${index}`, type: 'guidance', tags: ['bulk'], architectures: ['sm86'], body: `Bulk body ${index}.`,
    }));
    assert.equal(buildKernelWikiSnapshot({ pages: bulk(256), sourceCommit: PINNED_COMMIT, reviews: [] }).units.length, 256, '256 pages are accepted');
    assert.throws(() => buildKernelWikiSnapshot({ pages: bulk(257), sourceCommit: PINNED_COMMIT, reviews: [] }), codedFailure, '257 pages exceed the frozen bound');
  });

  await test('applying a snapshot writes real repository records with the pinned identity, and reviews keep the raw unit', async () => {
    const pages = [
      sourcePage({ id: 'tail-handling', title: 'Tail handling', type: 'technique', tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'], extra: PERFORMANCE_CLAIMS, body: 'Reviewed body.' }),
      sourcePage({ id: 'tail-effect', title: 'Tail effect', type: 'symptom', tags: ['tail'], symptoms: ['tail-effect'], techniques: [], architectures: ['sm86'], body: 'Unreviewed body.' }),
    ];
    // An architecture-specific review qualifies the original unit; it does not
    // create a transfer unit.
    const architectureSpecific = buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews: [archReview('tail-handling', 'review-sm86-1')] });
    const { repository, rootDir } = await setupRepo('apply');
    const first = await importSnapshot(repository, architectureSpecific, { projectId: PROJECT, now: now(), author: 'phase3-import' });
    assert.equal(first.changed, true);
    // The wrapper's `result` is checked against the frozen apply result shape, so
    // a differently nested or renamed payload cannot pass as "created 2".
    assertApplyResultShape(first.result, 'first import');
    assert.equal(first.result.created, 2, JSON.stringify(first.result));
    assert.equal(first.result.updated, 0);
    assert.equal(first.result.unchanged, 0);
    assert.deepEqual(first.result.records.map((record) => record.version), [1, 1]);
    assert.equal(JSON.stringify(first.result.records.map((record) => record.id)).includes('-transfer-'), false, 'an architecture-specific review creates no transfer unit');
    const stored = await records(repository);
    const ids = stored.map((record) => record.id);
    assert.ok(ids.includes(recordIdFor(PROJECT, 'tail-handling')), `the page unit id is pinned: ${ids.join(',')}`);
    assert.ok(ids.includes(recordIdFor(PROJECT, 'tail-effect')), 'an unreviewed page is still imported');
    for (const record of stored) {
      assert.equal(record.projectId, PROJECT);
      assert.ok(record.content.includes(PINNED_COMMIT), 'the stored guidance cites the pinned source commit it was read from');
      assert.ok(record.id.length <= 160);
      assert.equal(record.verification.publishable, false);
      assert.equal(record.verification.status, 'unverified');
      assert.equal(record.verification.evidenceClass, 'human-guidance');
      assert.equal(record.source, 'human');
      assert.equal(record.kind, 'guidance');
      assert.equal(record.confidence, 'low');
      assert.deepEqual(record.scope.tags, [], 'raw Wiki topics never become scope tags');
      assert.equal(record.selectionMetadata.source, 'kernel-wiki');
    }
    assert.equal(findRecord(stored, recordIdFor(PROJECT, 'tail-handling')).selectionMetadata.applicability.mode, 'architecture-specific');
    assert.equal(findRecord(stored, recordIdFor(PROJECT, 'tail-effect')).selectionMetadata.applicability.mode, 'unreviewed');
    validateExperienceStore(await repository.read());
    const service = createExperienceService({ repository, now, createId: () => 'EXP-unused' });
    assert.equal((await service.read(null, { projectId: PROJECT })).experiences.length, 2);
    assert.equal((await service.read(null, { projectId: 'project-b' })).experiences.length, 0, 'records are project-scoped');
    assert.deepEqual(await fs.readdir(rootDir), ['experiences.json'], 'no second storage or side index is created');

    // A reviewed-transfer review adds a separate stable unit with the reviewed
    // content, keeps the raw unit, and never overwrites it.
    const transferContent = 'Project-reviewed sm86 transfer guidance: mask the final block with an explicit remainder loop.';
    const withTransfer = buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews: [archReview('tail-handling', 'review-sm86-1'), transferReview('tail-handling', 'review-transfer-1', transferContent)] });
    const transferUnit = unitOf(withTransfer, 'tail-handling-transfer-review-transfer-1');
    assert.equal(transferUnit.content.includes(transferContent), true);
    assert.equal(JSON.stringify(transferUnit.selectionMetadata).includes('review-transfer-1'), true);
    const { repository: transferRepository } = await setupRepo('apply-transfer');
    const applied = await importSnapshot(transferRepository, withTransfer, { projectId: PROJECT, now: now(), author: 'phase3-import' });
    assert.equal(applied.result.created, 3, JSON.stringify(applied.result));
    const transferStored = await records(transferRepository);
    const rawRecord = findRecord(transferStored, recordIdFor(PROJECT, 'tail-handling'));
    const transferRecord = findRecord(transferStored, recordIdFor(PROJECT, 'tail-handling-transfer-review-transfer-1'));
    assert.ok(rawRecord, 'the raw unit is kept alongside its transfer');
    assert.ok(transferRecord, 'the reviewed transfer is a separate stable unit');
    assert.ok(rawRecord.content.includes('Reviewed body.'), 'the transfer never overwrites the raw unit');
    assert.ok(transferRecord.content.includes(transferContent));
    assert.equal(transferRecord.selectionMetadata.pageId, 'tail-handling', 'the transfer keeps the original source metadata');
    assert.equal(transferRecord.selectionMetadata.applicability.mode, 'reviewed-transfer');
    assert.equal(transferRecord.selectionMetadata.applicability.reviewId, 'review-transfer-1');
    assert.ok(transferRecord.selectionMetadata.sourceDigest === rawRecord.selectionMetadata.sourceDigest);
    assert.notEqual(transferRecord.selectionMetadata.unitDigest, rawRecord.selectionMetadata.unitDigest);
    validateExperienceStore(await transferRepository.read());
  });

  await test('re-importing identical source is a revision-preserving no-op while changed source appends a version', async () => {
    const base = sourcePage({ id: 'tail-handling', title: 'Tail handling', type: 'technique', tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'], extra: PERFORMANCE_CLAIMS, body: 'First body.' });
    const options = { projectId: PROJECT, now: now(), author: 'phase3-import' };
    const { repository, file } = await setupRepo('idempotence');
    const first = await importSnapshot(repository, buildKernelWikiSnapshot({ pages: [base], sourceCommit: PINNED_COMMIT, reviews: [] }), options);
    assert.equal(first.changed, true);
    const bytesBefore = await fs.readFile(file, 'utf8');
    const revisionBefore = (await repository.read()).revision;
    const second = await importSnapshot(repository, buildKernelWikiSnapshot({ pages: [base], sourceCommit: PINNED_COMMIT, reviews: [] }), options);
    assert.equal(second.changed, false, 'identical source reports no change');
    // A no-op still answers with the complete documented result, not a short one.
    assertApplyResultShape(second.result, 'identical re-import');
    assert.deepEqual(second.result.records, first.result.records, 'an unchanged unit is reported with its identity');
    assert.equal(second.result.created, 0);
    assert.equal(second.result.updated, 0);
    assert.equal(second.result.unchanged, 1);
    assert.equal(await fs.readFile(file, 'utf8'), bytesBefore, 'identical source never rewrites the store');
    assert.equal((await repository.read()).revision, revisionBefore, 'identical source never advances the repository revision');

    advance();
    const revised = { ...base, text: base.text.replace('First body.', 'Revised body after review.') };
    const changed = await importSnapshot(repository, buildKernelWikiSnapshot({ pages: [revised], sourceCommit: PINNED_COMMIT, reviews: [] }), options);
    assert.equal(changed.changed, true, 'changed source must be applied');
    assertApplyResultShape(changed.result, 'changed re-import');
    assert.equal(changed.result.updated, 1);
    const history = (await records(repository)).filter((record) => record.id === recordIdFor(PROJECT, 'tail-handling'));
    assert.equal(history.length, 2, 'history is append-only');
    assert.deepEqual(history.map((record) => record.version).sort(), [1, 2]);
    assert.match(history.find((record) => record.version === 2).content, /Revised body after review/);
    assert.match(history.find((record) => record.version === 1).content, /First body/, 'the earlier version is never rewritten');
    validateExperienceStore(await repository.read());

    // A page missing from a later snapshot is retained, never deleted.
    const other = sourcePage({ id: 'tail-effect', title: 'Tail effect', type: 'symptom', tags: ['tail'], symptoms: ['tail-effect'], architectures: ['sm86'], body: 'Symptom body.' });
    await importSnapshot(repository, buildKernelWikiSnapshot({ pages: [revised, other], sourceCommit: PINNED_COMMIT, reviews: [] }), options);
    assert.ok(findRecord(await records(repository), recordIdFor(PROJECT, 'tail-effect')), 'the second page is imported');
    const onlyFirst = await importSnapshot(repository, buildKernelWikiSnapshot({ pages: [revised], sourceCommit: PINNED_COMMIT, reviews: [] }), options);
    assert.equal(onlyFirst.changed, false, 'a snapshot that only drops a page changes nothing for the retained units');
    assert.ok(findRecord(await records(repository), recordIdFor(PROJECT, 'tail-effect')), 'a page missing from a later snapshot is retained');
    validateExperienceStore(await repository.read());
  });

  await test('the same source is isolated per project, unrelated IDs conflict and malformed snapshots roll back', async () => {
    const pages = [sourcePage({ id: 'tail-handling', title: 'Tail handling', type: 'technique', tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'], extra: PERFORMANCE_CLAIMS, body: 'Body.' })];
    const built = buildKernelWikiSnapshot({ pages, sourceCommit: PINNED_COMMIT, reviews: [] });
    const { repository, file } = await setupRepo('isolation');
    await importSnapshot(repository, built, { projectId: 'project-a', now: now(), author: 'phase3-import' });
    advance();
    await importSnapshot(repository, built, { projectId: 'project-b', now: now(), author: 'phase3-import' });
    const stored = await records(repository);
    const ids = new Set(stored.map((record) => record.id));
    assert.ok(ids.has(recordIdFor('project-a', 'tail-handling')));
    assert.ok(ids.has(recordIdFor('project-b', 'tail-handling')));
    assert.equal(stored.length, 2, 'the same unit in two projects is two records, not a conflict');
    const unaffected = stored.find((record) => record.projectId === 'project-a');

    // An unrelated existing record with the pinned ID is a conflict, not an overwrite.
    const { repository: conflictRepository, file: conflictFile } = await setupRepo('conflict');
    const pinnedId = recordIdFor(PROJECT, 'tail-handling');
    const conflicting = createExperienceService({ repository: conflictRepository, now, createId: () => pinnedId });
    await conflicting.create({ projectId: PROJECT, title: 'Unrelated local record', content: 'Not the imported page.', author: 'engineer' });
    const conflictBytes = await fs.readFile(conflictFile, 'utf8');
    await assert.rejects(importSnapshot(conflictRepository, built, { projectId: PROJECT, now: now(), author: 'phase3-import' }), codedFailure, 'an unrelated existing ID must not be overwritten');
    assert.equal(await fs.readFile(conflictFile, 'utf8'), conflictBytes, 'a rejected import writes nothing');

    const before = await fs.readFile(file, 'utf8');
    const revision = (await repository.read()).revision;
    for (const broken of [
      null,
      { schemaVersion: 'operator-studio.kernel-wiki-snapshot/v2', sourceCommit: built.sourceCommit },
      { ...built, sourceCommit: 'not-a-commit' },
      { ...built, snapshotDigest: 'f'.repeat(64) },
      { ...built, units: [] },
      { ...built, units: [{ ...built.units[0], unitId: '' }] },
    ]) {
      await assert.rejects(importSnapshot(repository, broken, { projectId: PROJECT, now: now(), author: 'phase3-import' }), codedFailure, 'a malformed or digest-stale snapshot is rejected');
    }
    await assert.rejects(importSnapshot(repository, built, { projectId: '../escape', now: now(), author: 'phase3-import' }), codedFailure, 'an unsafe project id is rejected');
    await assert.rejects(importSnapshot(repository, built, { projectId: PROJECT, now: 'not-a-time', author: 'phase3-import' }), codedFailure, 'a non-ISO clock is rejected');
    await assert.rejects(importSnapshot(repository, built, { projectId: PROJECT, now: now() }), codedFailure, 'a missing author is rejected');
    assert.equal(await fs.readFile(file, 'utf8'), before, 'a rejected import writes nothing');
    assert.equal((await repository.read()).revision, revision);
    assert.deepEqual(findRecord(await records(repository), unaffected.id), unaffected, 'no record was partially rewritten');

    // A multi-unit snapshot whose second unit was edited after the envelope was
    // sealed: the envelope digest is recomputed to stay valid, the stale unit
    // digest must still stop the whole transaction before any unit is written.
    const twoPages = [pages[0], sourcePage({ id: 'tail-effect', title: 'Tail effect', type: 'symptom', tags: ['tail'], symptoms: ['tail-effect'], architectures: ['sm86'], body: 'Symptom body.' })];
    const sealed = buildKernelWikiSnapshot({ pages: twoPages, sourceCommit: PINNED_COMMIT, reviews: [] });
    const tampered = structuredClone(sealed);
    tampered.units[1].content = `${tampered.units[1].content}Injected after sealing.\n`;
    tampered.snapshotDigest = envelopeDigest(tampered);
    assert.notEqual(envelopeDigest(tampered), envelopeDigest(sealed), 'the tamper changes the canonical payload while the digest field is re-sealed');
    const bytesBeforeTamper = await fs.readFile(file, 'utf8');
    const revisionBeforeTamper = (await repository.read()).revision;
    await assert.rejects(importSnapshot(repository, tampered, { projectId: PROJECT, now: now(), author: 'phase3-import' }), codedFailure, 'a stale unit digest stops the whole import');
    assert.equal(await fs.readFile(file, 'utf8'), bytesBeforeTamper, 'no unit of a partially valid snapshot is written');
    assert.equal((await repository.read()).revision, revisionBeforeTamper);
    assert.equal(findRecord(await records(repository), recordIdFor(PROJECT, 'tail-effect')), undefined, 'the valid first unit of a rejected snapshot is not imported either');
  });

  await test('a review lifecycle advances one stable page unit, a new review gets its own ID, and illegal unit combinations roll back', async () => {
    const page = sourcePage({
      id: 'tail-handling', title: 'Tail handling', type: 'technique', tags: ['vectorization'],
      symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'],
      extra: PERFORMANCE_CLAIMS, body: 'Reviewed body.',
    });
    const options = { projectId: PROJECT, now: now(), author: 'phase3-import' };
    const { repository, file } = await setupRepo('review-lifecycle');
    const snapshotWith = (reviews) => buildKernelWikiSnapshot({ pages: [page], sourceCommit: PINNED_COMMIT, reviews });
    const pageRecordId = recordIdFor(PROJECT, 'tail-handling');
    const transferRecordId = recordIdFor(PROJECT, 'tail-handling-transfer-review-transfer-1');

    // 1) The raw page first imports as unreviewed human guidance.
    const first = await importSnapshot(repository, snapshotWith([]), options);
    assert.equal(first.changed, true);
    // The lifecycle assertions below read `result.created/updated/unchanged`; this
    // pins the wrapper to the same documented apply result shape they assume.
    assertApplyResultShape(first.result, 'review lifecycle raw import');
    assert.equal(first.result.created, 1);
    assert.equal(first.result.updated, 0);
    assert.equal(first.result.unchanged, 0);
    assert.equal(headRecord(await records(repository), pageRecordId).version, 1);
    assert.equal(headRecord(await records(repository), pageRecordId).selectionMetadata.applicability.mode, 'unreviewed');

    // 2) The same page with an architecture-specific review keeps the same stable
    // unit ID and advances it instead of creating a second unit.
    advance();
    const reviewed = await importSnapshot(repository, snapshotWith([archReview('tail-handling', 'review-sm86-1')]), options);
    assert.equal(reviewed.result.created, 0, 'qualifying the original unit never creates a second unit');
    assert.equal(reviewed.result.updated, 1);
    assert.equal(reviewed.result.unchanged, 0);
    let head = headRecord(await records(repository), pageRecordId);
    assert.equal(head.version, 2, 'the reviewed page advances the same page unit');
    assert.equal(head.selectionMetadata.applicability.mode, 'architecture-specific');
    assert.equal(head.selectionMetadata.applicability.reviewId, 'review-sm86-1');
    assert.equal((await records(repository)).filter((record) => record.id === pageRecordId).length, 2, 'history stays append-only');

    // 3) Revoking the review advances the same ID again; no version is deleted.
    advance();
    const revoked = await importSnapshot(repository, snapshotWith([]), options);
    assert.equal(revoked.result.created, 0);
    assert.equal(revoked.result.updated, 1);
    head = headRecord(await records(repository), pageRecordId);
    assert.equal(head.version, 3, 'revoking a review advances the raw unit in place');
    assert.equal(head.selectionMetadata.applicability.mode, 'unreviewed');
    assert.equal(head.selectionMetadata.applicability.reviewId, null);
    validateExperienceStore(await repository.read());

    // 4) A reviewed transfer is a separate stable unit under its own derived ID,
    // and it never overwrites the raw unit it came from.
    advance();
    const transferContent = 'Project-reviewed sm86 transfer guidance: mask the final block.';
    const transferred = await importSnapshot(repository, snapshotWith([transferReview('tail-handling', 'review-transfer-1', transferContent)]), options);
    assert.equal(transferred.result.created, 1, 'the transfer unit is created under a new stable ID');
    assert.equal(transferred.result.unchanged, 1, 'the untouched raw unit stays unchanged');
    const transfer = headRecord(await records(repository), transferRecordId);
    assert.ok(transfer, 'the transfer ID is pageId-transfer-reviewId');
    assert.equal(transfer.version, 1);
    assert.equal(headRecord(await records(repository), pageRecordId).version, 3, 'the raw unit is never rewritten by its transfer');
    assert.match(headRecord(await records(repository), pageRecordId).content, /Reviewed body/);

    // 5) A different review ID is a different stable unit; the earlier one stays.
    advance();
    const secondReview = await importSnapshot(repository, snapshotWith([transferReview('tail-handling', 'review-transfer-2', 'A second project-reviewed transfer.')]), options);
    assert.equal(secondReview.result.created, 1);
    assert.ok(findRecord(await records(repository), recordIdFor(PROJECT, 'tail-handling-transfer-review-transfer-2')), 'a new review ID derives a new stable unit ID');
    assert.ok(headRecord(await records(repository), transferRecordId), 'the earlier transfer unit is retained');
    validateExperienceStore(await repository.read());

    // 6) Illegal page/path/unitId combinations are conflicts: the envelope digest
    // stays internally consistent, so each one must fail on its own rule and the
    // whole transaction stays byte-identical.
    const sealed = snapshotWith([archReview('tail-handling', 'review-sm86-1'), transferReview('tail-handling', 'review-transfer-1', transferContent)]);
    const rawUnit = sealed.units.find((unit) => unit.unitId === 'tail-handling');
    const transferUnit = sealed.units.find((unit) => unit.unitId === 'tail-handling-transfer-review-transfer-1');
    assert.ok(rawUnit && transferUnit, 'the sealed envelope carries both the raw unit and its transfer');
    assert.equal(envelopeDigest(sealed), digestOf(sealed), 'the unmodified envelope is sealed by its own digest');
    // Each illegal envelope is re-sealed after the single mutation, so it can only
    // fail on the rule it breaks, never on a stale envelope digest.
    const rewire = (mutate) => {
      const broken = structuredClone(sealed);
      mutate(broken);
      broken.snapshotDigest = envelopeDigest(broken);
      return broken;
    };
    const illegal = {
      'unitId disagrees with pageId': rewire((draft) => { draft.units.find((unit) => unit.unitId === 'tail-handling').unitId = 'other-page'; }),
      'selection pageId disagrees with unitId': rewire((draft) => { draft.units.find((unit) => unit.unitId === 'tail-handling').selectionMetadata.pageId = 'other-page'; }),
      'transfer unitId is not derived from pageId and reviewId': rewire((draft) => { draft.units.find((unit) => unit.unitId.includes('-transfer-')).unitId = 'tail-handling-transfer-review-other'; }),
      'source path outside wiki/': rewire((draft) => { draft.units.find((unit) => unit.unitId === 'tail-handling').selectionMetadata.sourcePath = 'docs/page.md'; }),
      'two units share one unitId': rewire((draft) => { draft.units.find((unit) => unit.unitId.includes('-transfer-')).unitId = 'tail-handling'; }),
      'metadata unitDigest does not cover the content': rewire((draft) => { draft.units.find((unit) => unit.unitId === 'tail-handling').selectionMetadata.unitDigest = 'f'.repeat(64); }),
    };
    const bytesBeforeIllegal = await fs.readFile(file, 'utf8');
    const revisionBeforeIllegal = (await repository.read()).revision;
    for (const [label, envelope] of Object.entries(illegal)) {
      await assert.rejects(importSnapshot(repository, envelope, { projectId: PROJECT, now: now(), author: 'phase3-import' }), codedFailure, `an envelope with ${label} must be rejected`);
    }
    assert.equal(await fs.readFile(file, 'utf8'), bytesBeforeIllegal, 'no illegal envelope writes any unit');
    assert.equal((await repository.read()).revision, revisionBeforeIllegal);
    assert.equal(headRecord(await records(repository), pageRecordId).version, 3, 'the raw unit is unchanged by every rejected envelope');
    assert.equal(headRecord(await records(repository), transferRecordId).version, 1);
    validateExperienceStore(await repository.read());
  });

  await test('the pinned CLI reads only committed blobs, refuses to overwrite and never touches a live store', async () => {
    const committedPage = sourcePage({
      id: 'tail-handling', title: 'Tail handling: committed version', type: 'technique',
      tags: ['vectorization'], symptoms: ['tail-effect'], techniques: ['masked-tail-loop'],
      architectures: ['sm86'], extra: PERFORMANCE_CLAIMS, body: 'Committed body text.',
    });
    const symptomPage = sourcePage({
      id: 'tail-effect', title: 'Tail effect', type: 'symptom',
      tags: ['tail'], symptoms: ['tail-effect'], architectures: ['sm86'], body: 'Symptom body.',
    });
    const source = await gitRepo('cli', {
      'LICENSE': MIT_LICENSE,
      'wiki/techniques/tail-handling.md': committedPage.text,
      'wiki/symptoms/tail-effect.md': symptomPage.text,
      'docs/private-note.md': '# Private\n\nPRIVATE-NOTE-TOKEN\n',
    });
    // The pinned revision must be a real historical commit, not just HEAD.
    await source.write('wiki/techniques/tail-handling.md', committedPage.text.replace('Committed body text.', 'SECOND-COMMIT body text.'));
    await source.git('add', '-A');
    await source.git('commit', '-q', '-m', 'second revision');
    const headCommit = await source.git('rev-parse', 'HEAD');
    assert.notEqual(headCommit, source.commit);
    // Dirty the working tree after the pin: the importer must still read the blob.
    await source.write('wiki/techniques/tail-handling.md', committedPage.text.replace('Committed body text.', 'DIRTY-WORKING-TREE body.'));
    const dirtyStatus = await source.git('status', '--porcelain');
    const configBefore = await fs.readFile(path.join(source.root, '.git', 'config'), 'utf8');

    const dataDir = path.join(scratch, 'cli-live-data');
    const runtimeDir = path.join(scratch, 'cli-live-runtime');
    const cliEnv = { ...process.env, OPERATOR_DATA_DIR: dataDir, OPERATOR_RUNTIME_DIR: runtimeDir };
    const runCli = (args) => execFileAsync(process.execPath, ['scripts/import-kernel-wiki.mjs', ...args], {
      cwd: repoRoot, windowsHide: true, env: cliEnv, maxBuffer: 8 * 1024 * 1024,
    });
    // Every output lives outside the source repository so the CLI cannot pollute
    // the very `git status` the test asserts on.
    const outDir = path.join(scratch, 'cli-out');
    await fs.mkdir(outDir, { recursive: true });
    const output = path.join(outDir, 'envelope.json');

    await runCli(['--source', source.root, '--commit', source.commit, '--out', output]);
    const envelope = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(envelope.schemaVersion, SNAPSHOT_SCHEMA);
    assert.equal(envelope.sourceCommit, source.commit);
    assert.match(digestOf(envelope), /^[0-9a-f]{64}$/);
    assert.equal(digestOf(envelope), envelopeDigest(envelope), 'the CLI envelope digest is canonical and recomputable');
    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes('DIRTY-WORKING-TREE'), false, 'uncommitted working-tree content is ignored');
    assert.equal(serialized.includes('SECOND-COMMIT'), false, 'a later commit is never substituted for the pin');
    assert.equal(serialized.includes('PRIVATE-NOTE-TOKEN'), false, 'only wiki/ pages and LICENSE are read');
    assert.ok(serialized.includes('Committed body text.'), 'the blob at the pinned commit is imported');
    // The envelope carries a structured license provenance object, not a bare
    // string: identity (spdx/path/copyright) is validated separately from the
    // verbatim MIT text, which must equal the committed LICENSE blob byte for byte.
    assert.equal(typeof envelope.license, 'object', 'the license provenance envelope is structured');
    assert.equal(Array.isArray(envelope.license), false);
    assert.equal(envelope.license.spdx, 'MIT', 'the license is identified as MIT');
    assert.equal(envelope.license.path, 'LICENSE', 'the license is pinned to the committed LICENSE blob');
    assert.equal(typeof envelope.license.copyright, 'string', 'the MIT copyright notice is carried');
    assert.ok(envelope.license.copyright.trim().length > 0, 'the MIT copyright notice is not empty');
    assert.equal(typeof envelope.license.text, 'string', 'the MIT license text is carried as snapshot provenance');
    assert.equal(envelope.license.text, MIT_LICENSE, 'the license text is the committed blob verbatim, never summarized or substituted');
    assert.ok(envelope.license.text.includes('MIT License'), 'the MIT notice text is preserved');
    assert.ok(envelope.license.text.includes('Permission is hereby granted'));
    assert.equal(serialized.includes('Apache'), false, 'the snapshot never substitutes a different license');
    assert.deepEqual(await fs.readdir(outDir), ['envelope.json'], 'the CLI writes only the requested output file');
    assert.equal(await source.git('status', '--porcelain'), dirtyStatus, 'the source repository working tree is left untouched');
    assert.equal(await fs.readFile(path.join(source.root, '.git', 'config'), 'utf8'), configBefore, 'no source or global Git config is edited');

    // A pin that is not a commit of this source must fail without output.
    const other = await gitRepo('cli-other', { 'LICENSE': MIT_LICENSE, 'wiki/other.md': symptomPage.text });
    const foreign = path.join(outDir, 'foreign.json');
    await assert.rejects(runCli(['--source', source.root, '--commit', other.commit, '--out', foreign]), cliFailure, 'a pin that is not a commit of this source is refused');
    await assert.rejects(fs.stat(foreign), { code: 'ENOENT' });
    const missing = path.join(outDir, 'missing.json');
    await assert.rejects(runCli(['--source', source.root, '--commit', '0'.repeat(40), '--out', missing]), cliFailure, 'an unknown commit is refused');
    await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
    await assert.rejects(runCli(['--source', source.root, '--commit', 'not-a-commit', '--out', path.join(outDir, 'bad.json')]), cliFailure, 'a malformed commit is refused');
    await assert.rejects(runCli(['--source', path.join(scratch, 'no-such-source'), '--commit', source.commit, '--out', path.join(outDir, 'nosource.json')]), cliFailure, 'a missing source is refused');
    // An existing output file is never overwritten.
    const bytes = await fs.readFile(output, 'utf8');
    await assert.rejects(runCli(['--source', source.root, '--commit', source.commit, '--out', output]), cliFailure, 'an existing output file is never overwritten');
    assert.equal(await fs.readFile(output, 'utf8'), bytes, 'the pinned output file must refuse to be overwritten');
    // Nothing outside the requested output file was created: no live store, no state.
    await assert.rejects(fs.stat(path.join(dataDir, 'mock-db.json')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(runtimeDir, 'experiences')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(source.root, 'experiences.json')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(outDir), ['envelope.json'], 'a rejected run leaves no partial output behind');

    // The optional reviews file: a reviewed transfer is honoured and applied
    // through the real import path, keeping the raw unit as well.
    const transferContent = 'Project-reviewed sm86 transfer guidance for the committed tail page.';
    const reviewsFile = path.join(outDir, 'reviews.json');
    await fs.writeFile(reviewsFile, JSON.stringify([archReview('tail-handling', 'review-sm86-1'), transferReview('tail-handling', 'review-transfer-1', transferContent)]), 'utf8');
    const reviewedOut = path.join(outDir, 'reviewed.json');
    await runCli(['--source', source.root, '--commit', source.commit, '--out', reviewedOut, '--reviews', reviewsFile]);
    const reviewed = JSON.parse(await fs.readFile(reviewedOut, 'utf8'));
    assert.equal(digestOf(reviewed), envelopeDigest(reviewed));
    assert.ok(unitOf(reviewed, 'tail-handling'), 'the raw unit is still present with a review attached');
    assert.ok(unitOf(reviewed, 'tail-handling-transfer-review-transfer-1'), 'the reviewed transfer unit is in the CLI envelope');
    const { repository } = await setupRepo('cli-apply');
    const applied = await importSnapshot(repository, reviewed, { projectId: PROJECT, now: now(), author: 'phase3-import' });
    assert.equal(applied.changed, true);
    const ids = (await records(repository)).map((record) => record.id);
    assert.ok(ids.includes(recordIdFor(PROJECT, 'tail-handling')), ids.join(','));
    assert.ok(ids.includes(recordIdFor(PROJECT, 'tail-handling-transfer-review-transfer-1')), 'the CLI envelope carries the reviewed transfer unit');
    validateExperienceStore(await repository.read());
  });

  if (failed) {
    console.error(`Kernel wiki import: ${failed} of ${passed + failed} independent checks FAILED.`);
    process.exitCode = 1;
  } else {
    console.log(`Kernel wiki import: ${passed} independent checks passed.`);
  }
} finally {
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('operator-wiki-import-test-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
