// Phase 3 writer B: pinned KernelWiki source -> experience snapshot -> store.
//
// Pure module. It never touches the filesystem, network, clock, model or GPU,
// and it never writes live Runtime storage. scripts/import-kernel-wiki.mjs reads
// git blobs at an exact commit and writes one snapshot file; the production
// import path calls applyKernelWikiSnapshot inside one repository transaction.
//
// Design authority: TEAM_HANDOFF.md sections 6 and 8.4; frozen implementation
// contract docs/development/PHASE3_WIKI_CONTRACT.md, section B.
//
// KernelWiki material is provenance, never evidence: every imported record stays
// human guidance / unverified / publishable=false. Unknown frontmatter (notably
// the upstream nested performance_claims block) is ignored for selection but is
// still covered by sourceDigest, and is never read as verified performance or as
// applicability. Original topics are never copied into scope.tags.
import { createHash } from 'node:crypto';
import { appendExperience, experienceError, EXPERIENCE_LIMITS, updateExperience, validateExperienceStore } from './experience-contract.mjs';

export const KERNEL_WIKI_SNAPSHOT_SCHEMA_VERSION = 'operator-studio.kernel-wiki-snapshot/v1';

const SOURCE = 'kernel-wiki';
const SOURCE_URL_BASE = 'https://github.com/mit-han-lab/KernelWiki';
const MAX_PAGES = 256;
const MAX_UNITS = 512;
// record id = 'kw-' + first16(sha256(projectId)) + '-' + unitId, bounded by 160.
const RECORD_ID_PREFIX = 'kw-';
const RECORD_ID_MAX = 160;
const UNIT_ID_MAX = RECORD_ID_MAX - RECORD_ID_PREFIX.length - 16 - 1;
const LIST_MAX = 32;
const ITEM_MAX = 160;
const REF_MAX = 512;
const SCOPE_ITEM_MAX = 160;
const SCOPE_LIST_MAX = 16;
const PATH_MAX = 240;
const LICENSE_TEXT_MAX = 8000;

const ENVELOPE_KEYS = ['schemaVersion', 'sourceCommit', 'units', 'snapshotDigest', 'license'];
const UNIT_KEYS = ['unitId', 'title', 'content', 'scope', 'selectionMetadata', 'evidenceRefs'];
const SCOPE_KEYS = ['tags', 'hardware', 'architecture'];
const METADATA_KEYS = ['source', 'sourceCommit', 'sourcePath', 'pageId', 'sourceDigest', 'unitDigest', 'type', 'topics', 'symptoms', 'candidateTechniques', 'architectures', 'applicability'];
const APPLICABILITY_KEYS = ['mode', 'reviewId', 'hardware', 'architectures', 'requiredCapabilities', 'software'];
const APPLICABILITY_MODES = ['unreviewed', 'architecture-specific', 'reviewed-transfer'];
const REVIEW_KEYS = ['pageId', 'reviewId', 'mode', 'content', 'topics', 'hardware', 'architectures', 'requiredCapabilities', 'software'];
const REVIEW_MODES = ['architecture-specific', 'reviewed-transfer'];
const LICENSE_KEYS = ['spdx', 'path', 'copyright', 'text'];
// Frontmatter keys this importer maps. Everything else (for example the upstream
// performance_claims block) is retained only inside the original page hash and
// reported as ignoredKeys.
const FRONTMATTER_SCALARS = ['id', 'title', 'type'];
const FRONTMATTER_LISTS = ['tags', 'symptoms', 'candidate_techniques', 'architectures'];
const FRONTMATTER_KEYS = [...FRONTMATTER_SCALARS, ...FRONTMATTER_LISTS];

const invalid = (message) => { throw Object.assign(new Error(message), { code: 'KERNEL_WIKI_INVALID', status: 400 }); };

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const plain = (value, allowed, label) => {
  if (!isPlain(value)) invalid(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) || (allowed && !allowed.includes(key))) invalid(`${label} contains an unsupported field`);
  }
  return value;
};
const hasControlCharacters = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const boundedString = (value, label, max = ITEM_MAX) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasControlCharacters(value)) invalid(`${label} must be a bounded nonempty string`);
  return value.trim();
};
// License text is the only multi-line value this format carries; everything
// else must stay a single bounded line. It is normalized like body text, so its
// surrounding whitespace is dropped.
const multilineString = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} must be a bounded nonempty string`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) invalid(`${label} must be a bounded nonempty string`);
  }
  return value.trim();
};
// The LICENSE blob is the one value carried verbatim: the license text reaches
// the snapshot exactly as the pinned commit stores it, so leading/trailing
// whitespace and CRLF/LF endings survive and snapshotDigest covers the actual
// upstream text. This validator only checks the existing bounds — string, some
// nonempty text, the character bound and no other control characters — and never
// rewrites the value. Body content and every other string keep the normalizing
// validators above.
const licenseTextValue = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} must be a bounded nonempty string`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) || code === 0x7f) invalid(`${label} must be a bounded nonempty string`);
  }
  return value;
};
const identifierValue = (value, label, max = ITEM_MAX) => {
  const result = boundedString(value, label, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u.test(result) || result.includes('..')) invalid(`${label} is not a safe identifier`);
  return result;
};
const digestValue = (value, label) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) invalid(`${label} must be a SHA-256 digest`);
  return value;
};
const commitValue = (value, label) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) invalid(`${label} must be a full 40-character lowercase hex commit`);
  return value;
};
const timestampValue = (value, label) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
};
const stringList = (value, label, max = LIST_MAX, itemMax = ITEM_MAX) => {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be a bounded array of at most ${max} entries`);
  const result = [];
  for (const item of value) {
    const text = boundedString(item, `${label} item`, itemMax);
    if (!result.includes(text)) result.push(text);
  }
  return result;
};
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = (value) => JSON.stringify(value, (_key, item) => (item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  : item));
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const splitLines = (text) => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
const isIndented = (line) => line.length > 0 && line !== line.trimStart();
const isListItem = (line) => { const trimmed = line.trim(); return trimmed === '-' || trimmed.startsWith('- '); };
const safeSourcePath = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > PATH_MAX || hasControlCharacters(value)) invalid('page path must be a bounded nonempty string');
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) invalid(`page path ${value} is not a safe relative path`);
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) invalid(`page path ${value} is not a safe relative path`);
  if (segments[0] !== 'wiki' || segments.length < 2) invalid(`page path ${value} must live under the pinned wiki/ directory`);
  if (!value.endsWith('.md')) invalid(`page path ${value} must be a wiki/*.md markdown page`);
  return value;
};
const enforceContentBound = (content, label) => {
  if (content.length > EXPERIENCE_LIMITS.content) invalid(`injected content for ${label} is ${content.length} characters; the importer never truncates upstream code or claims, so this page must be split upstream`);
  return content;
};
// Minimal frontmatter reader: scalars, quoted scalars, inline lists and block
// string lists. Duplicate keys, nested mappings under a consumed key, unsafe
// paths and oversized pages fail explicitly; unknown keys and unknown structured
// blocks are skipped and only reported as ignoredKeys.
const parseScalarValue = (raw, label) => {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) invalid(`${label} has an unterminated double-quoted scalar`);
    return value.slice(1, -1);
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) invalid(`${label} has an unterminated single-quoted scalar`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
};
const parseInlineList = (raw, label) => {
  if (!raw.trim().endsWith(']')) invalid(`${label} has an unterminated inline list`);
  const items = [];
  let current = '';
  let quote = null;
  for (const character of raw.trim().slice(1, -1)) {
    if (quote) {
      if (character === quote) quote = null; else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ',') { items.push(current); current = ''; continue; }
    current += character;
  }
  if (quote) invalid(`${label} has an unterminated quote inside an inline list`);
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
};
const parseFrontmatterValue = (raw, label) => {
  const value = raw.trim();
  if (value.startsWith('[')) return parseInlineList(value, label);
  if (value.startsWith('{')) invalid(`${label} must not be a nested mapping`);
  return parseScalarValue(value, label);
};
const collectBlock = (lines, start, end) => {
  let index = start;
  while (index < end) {
    const line = lines[index];
    if (!line.trim() || isIndented(line) || isListItem(line)) { index += 1; continue; }
    break;
  }
  return { block: lines.slice(start, index), next: index };
};
const parseBlockList = (block, label) => {
  const items = [];
  for (const line of block) {
    if (!line.trim()) continue;
    if (!isListItem(line)) invalid(`${label} mixes list items with nested or structured lines`);
    const item = parseScalarValue(line.trim().slice(1), label);
    if (item === null) invalid(`${label} contains an empty list item`);
    const mapping = /^[A-Za-z0-9_-]+:/u.exec(item);
    const looksLikeMapping = mapping && (item.length === mapping[0].length || item[mapping[0].length] !== item[mapping[0].length].trim());
    if (looksLikeMapping) invalid(`${label} must contain scalar list items, not nested mappings`);
    items.push(item);
  }
  return items;
};
const parseFrontmatter = (text, label) => {
  const lines = splitLines(text);
  if (lines[0]?.trim() !== '---') invalid(`${label} must start with a --- frontmatter block`);
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { end = index; break; }
  }
  if (end < 0) invalid(`${label} has an unterminated frontmatter block`);
  const entries = new Map();
  const ignored = new Set();
  let index = 1;
  while (index < end) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) { index += 1; continue; }
    if (isIndented(line) || isListItem(line)) invalid(`${label} frontmatter line ${index + 1} is not a supported top-level key: value entry`);
    const match = /^([A-Za-z0-9_-]+):(.*)$/u.exec(line);
    if (!match) invalid(`${label} frontmatter line ${index + 1} is not a supported key: value entry`);
    const key = match[1];
    if (entries.has(key) || ignored.has(key)) invalid(`${label} frontmatter key ${key} is duplicated`);
    const consumed = FRONTMATTER_KEYS.includes(key);
    const rawValue = match[2].trim();
    if (rawValue) {
      const value = parseFrontmatterValue(rawValue, `${label} frontmatter key ${key}`);
      if (consumed) entries.set(key, value); else ignored.add(key);
      index += 1;
      continue;
    }
    const { block, next } = collectBlock(lines, index + 1, end);
    if (block.some((item) => item.trim())) {
      if (consumed) entries.set(key, parseBlockList(block, `${label} frontmatter key ${key}`));
      else ignored.add(key);
    } else if (consumed) {
      entries.set(key, null);
    } else {
      ignored.add(key);
    }
    index = next;
  }
  return { entries, ignored, body: lines.slice(end + 1).join('\n').trim() };
};
const readScalar = (value, label, required) => {
  if (value === null || value === undefined) {
    if (required) invalid(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string') invalid(`${label} must be a scalar`);
  return boundedString(value, label);
};
const readList = (value, label) => (value === null || value === undefined
  ? []
  : stringList(Array.isArray(value) ? value : [value], label));

// Parse one pinned page. The raw page text is hashed exactly as supplied
// (complete original UTF-8 page); parsing itself normalizes line endings only.
export function parseKernelWikiPage(text, options = {}) {
  plain(options, ['path'], 'parse options');
  if (typeof text !== 'string') invalid('page text must be a string');
  const path = safeSourcePath(options.path);
  if (text.length > EXPERIENCE_LIMITS.content) invalid(`page ${path} is ${text.length} characters; oversized pages fail explicitly instead of being truncated`);
  const sourceDigest = sha256(text);
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const { entries, ignored, body } = parseFrontmatter(withoutBom, `page ${path}`);
  if (!body) invalid(`page ${path} has no body content after its frontmatter`);
  const pageId = identifierValue(readScalar(entries.get('id'), `page ${path} frontmatter id`, true), `page ${path} frontmatter id`);
  const type = readScalar(entries.get('type'), `page ${path} frontmatter type`, true);
  const heading = splitLines(body).map((line) => line.trim()).find((line) => line.startsWith('# ') && line.slice(2).trim().length > 0);
  const declaredTitle = readScalar(entries.get('title'), `page ${path} frontmatter title`, false);
  const title = boundedString(declaredTitle ?? (heading ? heading.slice(2).trim() : pageId), `page ${path} title`, EXPERIENCE_LIMITS.title);
  return freeze({
    path,
    pageId,
    title,
    type,
    topics: readList(entries.get('tags'), `page ${path} frontmatter tags`),
    symptoms: readList(entries.get('symptoms'), `page ${path} frontmatter symptoms`),
    candidateTechniques: readList(entries.get('candidate_techniques'), `page ${path} frontmatter candidate_techniques`),
    architectures: readList(entries.get('architectures'), `page ${path} frontmatter architectures`),
    body,
    ignoredKeys: [...ignored].sort(),
    sourceDigest,
  });
}

const sourceUrl = (page, sourceCommit) => `${SOURCE_URL_BASE}/blob/${sourceCommit}/${page.path}`;
const citationBlock = (page, sourceCommit, note) => [
  '---',
  `Source: KernelWiki ${page.path} @ ${sourceCommit}`,
  sourceUrl(page, sourceCommit),
  note,
].join('\n');
const rawUnitContent = (page, sourceCommit) => enforceContentBound([
  page.body,
  '',
  citationBlock(page, sourceCommit, 'KernelWiki page content is unreviewed human guidance for this project; it is not a verified or measured result.'),
].join('\n'), page.path);
const transferUnitContent = (page, sourceCommit, review) => enforceContentBound([
  review.content,
  '',
  citationBlock(page, sourceCommit, `Project-reviewed transferable suggestion from review ${review.reviewId}; unverified, and not an executed or measured result.`),
].join('\n'), `${page.path}#${review.reviewId}`);

const unreviewedApplicability = () => freeze({ mode: 'unreviewed', reviewId: null, hardware: [], architectures: [], requiredCapabilities: [], software: [] });
const reviewedApplicability = (mode, review) => freeze({
  mode,
  reviewId: review.reviewId,
  hardware: freeze([...review.hardware]),
  architectures: freeze([...review.architectures]),
  requiredCapabilities: freeze([...review.requiredCapabilities]),
  software: freeze([...review.software]),
});
const scopeForReview = (review) => {
  const scope = {};
  if (review.hardware.length) scope.hardware = [...review.hardware];
  if (review.architectures.length) scope.architecture = [...review.architectures];
  return scope;
};
const selectionMetadataFor = ({ page, content, sourceCommit, applicability, topics, symptoms, candidateTechniques, architectures }) => freeze({
  source: SOURCE,
  sourceCommit,
  sourcePath: page.path,
  pageId: page.pageId,
  sourceDigest: page.sourceDigest,
  unitDigest: sha256(content),
  type: page.type,
  topics: freeze(topics),
  symptoms: freeze(symptoms),
  candidateTechniques: freeze(candidateTechniques),
  architectures: freeze(architectures),
  applicability,
});

const indexReviews = (reviews, pages) => {
  const byPageId = new Map(pages.map((page) => [page.pageId, page]));
  const seen = new Set();
  const architectureSpecific = new Map();
  const transfers = [];
  reviews.forEach((entry, index) => {
    plain(entry, REVIEW_KEYS, `reviews[${index}]`);
    const pageId = identifierValue(entry.pageId, `reviews[${index}].pageId`);
    const reviewId = identifierValue(entry.reviewId, `reviews[${index}].reviewId`);
    if (!REVIEW_MODES.includes(entry.mode)) invalid(`reviews[${index}].mode must be one of ${REVIEW_MODES.join(', ')}`);
    if (!byPageId.has(pageId)) invalid(`review ${reviewId} references unknown page ${pageId}`);
    const key = `${pageId}::${reviewId}`;
    if (seen.has(key)) invalid(`duplicate review ${reviewId} for page ${pageId}`);
    seen.add(key);
    const review = {
      pageId,
      reviewId,
      mode: entry.mode,
      content: entry.content === undefined || entry.content === null ? null : boundedString(entry.content, `reviews[${index}].content`, EXPERIENCE_LIMITS.content),
      topics: entry.topics === undefined || entry.topics === null ? [] : stringList(entry.topics, `reviews[${index}].topics`),
      // Applicability tokens are canonical lowercase, exactly like the scope
      // dimensions the experience contract normalizes them against.
      hardware: stringList(entry.hardware ?? [], `reviews[${index}].hardware`).map((item) => item.toLowerCase()),
      architectures: stringList(entry.architectures ?? [], `reviews[${index}].architectures`).map((item) => item.toLowerCase()),
      requiredCapabilities: stringList(entry.requiredCapabilities ?? [], `reviews[${index}].requiredCapabilities`).map((item) => item.toLowerCase()),
      software: stringList(entry.software ?? [], `reviews[${index}].software`).map((item) => item.toLowerCase()),
    };
    // Both reviewed modes assert applicability for this project. A review that
    // names no architecture cannot qualify anything, so it is rejected here and
    // refused again by validateApplicability in any snapshot that carries it.
    if (!review.architectures.length) invalid(`review ${reviewId} must declare a nonempty reviewed architecture list for mode ${review.mode}`);
    if (review.mode === 'reviewed-transfer') {
      if (!review.content) invalid(`reviewed-transfer ${reviewId} must supply its reviewed content explicitly; the importer never summarizes upstream pages`);
      transfers.push(review);
      return;
    }
    if (architectureSpecific.has(pageId)) invalid(`page ${pageId} already has an architecture-specific review`);
    architectureSpecific.set(pageId, review);
  });
  return { architectureSpecific, transfers };
};

const buildUnits = (pages, sourceCommit, reviews) => {
  const index = indexReviews(reviews, pages);
  const units = [];
  for (const page of [...pages].sort((left, right) => left.pageId.localeCompare(right.pageId))) {
    const review = index.architectureSpecific.get(page.pageId) ?? null;
    const content = rawUnitContent(page, sourceCommit);
    units.push({
      unitId: page.pageId,
      title: page.title,
      content,
      scope: review ? scopeForReview(review) : {},
      selectionMetadata: selectionMetadataFor({
        page,
        content,
        sourceCommit,
        applicability: review ? reviewedApplicability('architecture-specific', review) : unreviewedApplicability(),
        topics: page.topics,
        symptoms: page.symptoms,
        candidateTechniques: page.candidateTechniques,
        architectures: page.architectures,
      }),
      evidenceRefs: [sourceUrl(page, sourceCommit)],
    });
    for (const transfer of index.transfers.filter((item) => item.pageId === page.pageId)) {
      const transferContent = transferUnitContent(page, sourceCommit, transfer);
      const unitId = `${page.pageId}-transfer-${transfer.reviewId}`;
      identifierValue(unitId, `transfer unit id for review ${transfer.reviewId}`, UNIT_ID_MAX);
      units.push({
        unitId,
        title: boundedString(`${page.title} (reviewed transfer ${transfer.reviewId})`, `transfer title for review ${transfer.reviewId}`, EXPERIENCE_LIMITS.title),
        content: transferContent,
        scope: scopeForReview(transfer),
        selectionMetadata: selectionMetadataFor({
          page,
          content: transferContent,
          sourceCommit,
          applicability: reviewedApplicability('reviewed-transfer', transfer),
          topics: transfer.topics.length ? transfer.topics : page.topics,
          symptoms: [],
          candidateTechniques: [],
          architectures: page.architectures,
        }),
        evidenceRefs: [sourceUrl(page, sourceCommit), `kernel-wiki-review:${transfer.reviewId}`],
      });
    }
  }
  units.sort((left, right) => left.unitId.localeCompare(right.unitId));
  return units;
};

const normalizeLicense = (license) => {
  plain(license, LICENSE_KEYS, 'snapshot license');
  return freeze({
    spdx: boundedString(license.spdx, 'license.spdx', 32),
    path: boundedString(license.path, 'license.path', PATH_MAX),
    copyright: license.copyright === undefined ? '' : boundedString(license.copyright, 'license.copyright', REF_MAX),
    text: licenseTextValue(license.text, 'license.text', LICENSE_TEXT_MAX),
  });
};

// The envelope digest covers every other envelope key, license included; the
// canonical form sorts object keys recursively so the digest is reproducible
// across machines.
export function buildKernelWikiSnapshot({ pages, sourceCommit, reviews = [], license } = {}) {
  if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES) invalid(`pages must be a nonempty array of at most ${MAX_PAGES} entries`);
  commitValue(sourceCommit, 'sourceCommit');
  if (!Array.isArray(reviews)) invalid('reviews must be an array');
  const parsedPages = pages.map((entry, index) => {
    plain(entry, ['path', 'text'], `pages[${index}]`);
    return parseKernelWikiPage(entry.text, { path: entry.path });
  });
  const seenPaths = new Set();
  const seenIds = new Set();
  for (const page of parsedPages) {
    if (seenPaths.has(page.path)) invalid(`duplicate page path ${page.path}`);
    seenPaths.add(page.path);
    if (seenIds.has(page.pageId)) invalid(`duplicate page id ${page.pageId}`);
    seenIds.add(page.pageId);
  }
  const units = buildUnits(parsedPages, sourceCommit, reviews);
  const envelope = { schemaVersion: KERNEL_WIKI_SNAPSHOT_SCHEMA_VERSION, sourceCommit, units };
  if (license !== undefined) envelope.license = normalizeLicense(license);
  const snapshot = { ...envelope, snapshotDigest: sha256(canonicalJson(envelope)) };
  return freeze(validateKernelWikiSnapshot(snapshot));
}
const canonicalString = (value, label, max) => {
  const text = boundedString(value, label, max);
  if (text !== value) invalid(`${label} must not carry surrounding whitespace`);
  return text;
};
const canonicalMultilineString = (value, label, max) => {
  const text = multilineString(value, label, max);
  if (text !== value) invalid(`${label} must not carry surrounding whitespace`);
  return text;
};
const validateScope = (scope, label) => {
  plain(scope, SCOPE_KEYS, label);
  if (stringList(scope.tags ?? [], `${label}.tags`, LIST_MAX, SCOPE_ITEM_MAX).length) invalid(`${label}.tags must stay empty: KernelWiki topics are provenance and never become access constraints`);
  for (const key of ['hardware', 'architecture']) {
    if (scope[key] !== undefined) stringList(scope[key], `${label}.${key}`, SCOPE_LIST_MAX, SCOPE_ITEM_MAX);
  }
  return scope;
};
const validateApplicability = (applicability, label) => {
  plain(applicability, APPLICABILITY_KEYS, label);
  if (!APPLICABILITY_MODES.includes(applicability.mode)) invalid(`${label}.mode must be one of ${APPLICABILITY_MODES.join(', ')}`);
  const dimensions = ['hardware', 'architectures', 'requiredCapabilities', 'software'];
  if (applicability.mode === 'unreviewed') {
    if (applicability.reviewId !== null) invalid(`${label}.reviewId must be null for an unreviewed unit`);
    for (const key of dimensions) {
      if (stringList(applicability[key], `${label}.${key}`).length) invalid(`${label}.${key} cannot carry a review assertion while the unit is unreviewed`);
    }
    return applicability;
  }
  identifierValue(applicability.reviewId, `${label}.reviewId`);
  for (const key of dimensions) stringList(applicability[key], `${label}.${key}`);
  // Both reviewed modes qualify a unit for an explicitly reviewed architecture
  // list; an empty list means the review asserts nothing and is invalid. An
  // unreviewed unit is different: it may omit architectures, but then it can
  // never auto-qualify (its dimensions must all stay empty).
  if (stringList(applicability.architectures, `${label}.architectures`).length === 0) invalid(`${label}.architectures must list at least one reviewed architecture for mode ${applicability.mode}`);
  return applicability;
};
const validateMetadata = (metadata, sourceCommit, label) => {
  plain(metadata, METADATA_KEYS, label);
  if (metadata.source !== SOURCE) invalid(`${label}.source must be ${SOURCE}`);
  if (commitValue(metadata.sourceCommit, `${label}.sourceCommit`) !== sourceCommit) invalid(`${label}.sourceCommit must match the snapshot sourceCommit`);
  safeSourcePath(metadata.sourcePath);
  identifierValue(metadata.pageId, `${label}.pageId`);
  digestValue(metadata.sourceDigest, `${label}.sourceDigest`);
  digestValue(metadata.unitDigest, `${label}.unitDigest`);
  boundedString(metadata.type, `${label}.type`);
  for (const key of ['topics', 'symptoms', 'candidateTechniques', 'architectures']) stringList(metadata[key], `${label}.${key}`);
  validateApplicability(metadata.applicability, `${label}.applicability`);
  return metadata;
};
// Full snapshot validation. Nothing may reach the store before every unit,
// digest and the envelope digest have been verified.
export function validateKernelWikiSnapshot(snapshot) {
  plain(snapshot, ENVELOPE_KEYS, 'snapshot');
  if (snapshot.schemaVersion !== KERNEL_WIKI_SNAPSHOT_SCHEMA_VERSION) invalid('unsupported kernel wiki snapshot schemaVersion');
  const sourceCommit = commitValue(snapshot.sourceCommit, 'snapshot.sourceCommit');
  if (!Array.isArray(snapshot.units) || !snapshot.units.length || snapshot.units.length > MAX_UNITS) invalid(`snapshot.units must be a nonempty array of at most ${MAX_UNITS} entries`);
  const unitIds = new Set();
  snapshot.units.forEach((unit, index) => {
    const label = `snapshot.units[${index}]`;
    plain(unit, UNIT_KEYS, label);
    const unitId = identifierValue(unit.unitId, `${label}.unitId`, UNIT_ID_MAX);
    if (unitIds.has(unitId)) invalid(`duplicate unitId ${unitId}`);
    unitIds.add(unitId);
    canonicalString(unit.title, `${label}.title`, EXPERIENCE_LIMITS.title);
    const content = canonicalMultilineString(unit.content, `${label}.content`, EXPERIENCE_LIMITS.content);
    validateScope(unit.scope, `${label}.scope`);
    validateMetadata(unit.selectionMetadata, sourceCommit, `${label}.selectionMetadata`);
    if (unit.selectionMetadata.unitDigest !== sha256(content)) invalid(`${label}.content does not match its selectionMetadata.unitDigest`);
    stringList(unit.evidenceRefs, `${label}.evidenceRefs`, LIST_MAX, REF_MAX);
  });
  if (snapshot.license !== undefined) {
    plain(snapshot.license, LICENSE_KEYS, 'snapshot.license');
    boundedString(snapshot.license.spdx, 'snapshot.license.spdx', 32);
    boundedString(snapshot.license.path, 'snapshot.license.path', PATH_MAX);
    if (snapshot.license.copyright !== '') boundedString(snapshot.license.copyright, 'snapshot.license.copyright', REF_MAX);
    licenseTextValue(snapshot.license.text, 'snapshot.license.text', LICENSE_TEXT_MAX);
  }
  digestValue(snapshot.snapshotDigest, 'snapshot.snapshotDigest');
  const { snapshotDigest, ...envelope } = snapshot;
  if (snapshotDigest !== sha256(canonicalJson(envelope))) invalid('snapshotDigest does not match the snapshot envelope');
  return snapshot;
}

export const kernelWikiRecordId = (projectId, unitId) => `${RECORD_ID_PREFIX}${sha256(identifierValue(projectId, 'projectId')).slice(0, 16)}-${identifierValue(unitId, 'unitId', UNIT_ID_MAX)}`;

// The canonical scope the experience contract stores for the scopes this
// importer emits: tags stay empty, dimensions are lowercased, architecture only
// appears when it was explicitly declared. Used to detect an identical re-import
// without duplicating the store schema.
const canonicalScope = (scope) => {
  const result = { tags: [], hardware: [...(scope.hardware ?? [])].map((item) => item.toLowerCase()), dtype: [], shape: {} };
  const architecture = [...(scope.architecture ?? [])].map((item) => item.toLowerCase());
  if (architecture.length) result.architecture = architecture;
  return result;
};
// The permanent KernelWiki ownership a unit claims: its role — raw page or
// reviewed transfer — together with the page and the source path it came from. The
// record ID is derived from the unit ID, so an existing record ID may only be
// continued by the same owner; a same-ID record that belongs to another page,
// another path or the other role is never taken over.
//
// Review applicability is NOT part of that ownership. A raw page keeps its record
// ID when a project adds, replaces or revokes its architecture-specific review:
// that is changed provenance, and the frozen contract advances it as a new version
// of the same ID. Only a reviewed transfer is bound to its review ID, because
// pageId + '-transfer-' + reviewId is a separate stable unit — a different review
// ID is a different unit with its own record, never a continuation.
const unitIdentity = (unit, label) => {
  const metadata = unit.selectionMetadata;
  const { mode, reviewId } = metadata.applicability;
  if (mode === 'reviewed-transfer') {
    const expected = `${metadata.pageId}-transfer-${reviewId}`;
    if (unit.unitId !== expected) invalid(`${label}.unitId must be ${expected} for a reviewed-transfer unit`);
    return { role: 'transfer', pageId: metadata.pageId, sourcePath: metadata.sourcePath, reviewId };
  }
  if (unit.unitId !== metadata.pageId) invalid(`${label}.unitId must equal selectionMetadata.pageId for a ${mode} unit`);
  return { role: 'raw', pageId: metadata.pageId, sourcePath: metadata.sourcePath };
};
const sameIdentity = (metadata, identity) => {
  if (!isPlain(metadata) || metadata.source !== SOURCE) return false;
  if (metadata.pageId !== identity.pageId || metadata.sourcePath !== identity.sourcePath) return false;
  if (!isPlain(metadata.applicability)) return false;
  if (identity.role === 'transfer') {
    return metadata.applicability.mode === 'reviewed-transfer' && metadata.applicability.reviewId === identity.reviewId;
  }
  // A raw page stays the same unit across review changes. A record claiming the
  // transfer role at a raw page ID is the other owner and is never continued.
  return metadata.applicability.mode !== 'reviewed-transfer';
};
const importedRecordMatches = (head, input) => head.projectId === input.projectId
  && head.source === 'human' && head.kind === 'guidance'
  && head.visibility === input.visibility && head.title === input.title && head.content === input.content
  && head.author === input.author && head.confidence === input.confidence
  && canonicalJson(head.evidenceRefs) === canonicalJson(input.evidenceRefs)
  && canonicalJson(head.scope) === canonicalJson(canonicalScope(input.scope))
  && canonicalJson(head.selectionMetadata) === canonicalJson(input.selectionMetadata);

// Pure store mutation, meant to run inside ONE repository.transact: it takes the
// mutable draft store, appends new units, advances changed units by expected
// version, and reports an identical import as unchanged so the repository
// revision does not move. Missing pages are never deleted: units absent from a
// later snapshot stay in the store as their latest version.
export function applyKernelWikiSnapshot(store, snapshot, options = {}) {
  plain(options, ['projectId', 'now', 'author'], 'import options');
  if (!isPlain(store) || !Array.isArray(store.records)) throw experienceError('EXPERIENCE_INVALID', 'applyKernelWikiSnapshot requires the mutable experience store draft', 400);
  const projectId = identifierValue(options.projectId, 'projectId');
  const now = timestampValue(options.now, 'now');
  const author = boundedString(options.author, 'author');
  const validated = validateKernelWikiSnapshot(snapshot);
  const prefix = `${RECORD_ID_PREFIX}${sha256(projectId).slice(0, 16)}-`;
  // Resolve the record ID and the KernelWiki identity of every unit, and check the
  // existing head, BEFORE the first mutation: a same-ID record that is not the
  // same kernel-wiki unit of this project is an error, not something to advance.
  const planned = validated.units
    .map((unit, index) => ({ unit, index }))
    .sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId))
    .map(({ unit, index }) => {
      const label = `snapshot.units[${index}]`;
      const id = `${prefix}${unit.unitId}`;
      if (id !== kernelWikiRecordId(projectId, unit.unitId)) invalid(`${label} does not derive a canonical record id`);
      const identity = unitIdentity(unit, label);
      const head = store.records.findLast((record) => record.id === id) ?? null;
      if (head) {
        if (head.projectId !== projectId || head.source !== 'human' || head.kind !== 'guidance') {
          throw experienceError('EXPERIENCE_ID_CONFLICT', `Experience ${id} already exists and is not human guidance of this project`, 409);
        }
        if (!sameIdentity(head.selectionMetadata, identity)) {
          const owner = identity.role === 'transfer'
            ? `${identity.pageId} (transfer review ${identity.reviewId})`
            : `${identity.pageId} (raw page)`;
          throw experienceError('EXPERIENCE_ID_CONFLICT', `Experience ${id} already belongs to a different KernelWiki unit identity than ${owner}`, 409);
        }
      }
      return { id, unit, head };
    });
  const records = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const { id, unit, head } of planned) {
    const input = {
      projectId,
      visibility: 'project',
      title: unit.title,
      content: unit.content,
      scope: unit.scope,
      author,
      confidence: 'low',
      evidenceRefs: [...unit.evidenceRefs],
      selectionMetadata: unit.selectionMetadata,
    };
    if (!head) {
      const outcome = appendExperience(store, input, { id, now, source: 'human' });
      created += 1;
      records.push({ id, version: outcome.result.experience.version });
      continue;
    }
    if (importedRecordMatches(head, input)) {
      unchanged += 1;
      records.push({ id, version: head.version });
      continue;
    }
    const outcome = updateExperience(store, id, {
      visibility: 'project',
      title: unit.title,
      content: unit.content,
      scope: unit.scope,
      author,
      confidence: 'low',
      evidenceRefs: [...unit.evidenceRefs],
      selectionMetadata: unit.selectionMetadata,
    }, { projectId, expectedVersion: head.version }, { now });
    updated += 1;
    records.push({ id, version: outcome.result.experience.version });
  }
  records.sort((left, right) => left.id.localeCompare(right.id));
  const changed = created + updated > 0;
  // The full resulting store is validated on every path, including an identical
  // no-op: "unchanged" must mean the untouched draft is a complete valid store,
  // never that a corrupt draft was skipped.
  validateExperienceStore(store);
  return {
    changed,
    result: {
      created,
      updated,
      unchanged,
      records,
      sourceCommit: validated.sourceCommit,
      snapshotDigest: validated.snapshotDigest,
    },
  };
}
