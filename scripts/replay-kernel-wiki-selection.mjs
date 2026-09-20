// KernelWiki 选择的历史 replay（只读）。
//
// 证明什么：历史运行的落盘审计里，KernelWiki 单元到底有没有被选中、按什么理由被选中、
// 被选中单元自己声明的适用范围（架构/硬件/特征）与当轮目标是否真的对得上。
// 不证明什么：这是 **历史 replay**，不是模型或 GPU 收益验证。不启动模型、GPU、provider、
// 调度器或任何子进程；不写任何运行目录；不重跑任何一轮优化；不改变任何门限或契约。
//
// 证据优先级（read-only replay 的关键，报告里必须保持这个顺序）：
//   1) 落盘的 `roundExperienceSelection` 审计 = **主证据**。它记录当轮真实选择，不会因为
//      之后 store 被追加记录而改变。
//   2) `--recheck` 重跑 `retrieveExperienceSelection` = **次要**的可复现性检查。它有两个
//      已确认的混淆源，重跑差异只能当线索、不能当"当轮事实"：
//        a) 磁盘上的 store 是**最终**状态；当轮之后写入的记录当时还看不见，今天可见。
//        b) 审计没有持久化 `preferredIds` / `repeatedAttempts`，而它们参与排序，重跑无法复刻。
//
// 退出码：0 = 报告完成且未发现缺陷；1 = 用法错误或发现缺陷；2 = 指定的运行目录不可读。
//
// 契约文档：scripts/replay-kernel-wiki-selection.md
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIKI_SELECTION_POLICY_VERSION } from '../client-runtime/experience-selection.mjs';
import { retrieveExperienceSelection } from '../client-runtime/experience-contract.mjs';

export const REPLAY_SCHEMA_VERSION = 'operator-studio.kernel-wiki-selection-replay/v1';
export const KERNEL_WIKI_SOURCE = 'kernel-wiki';
export const UNREVIEWED_MODE = 'unreviewed';
const STORE_RELATIVE = path.join('runtime', 'experiences', 'experiences.json');
const DB_RELATIVE = path.join('data', 'mock-db.json');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const usage = () => [
  'Usage: node scripts/replay-kernel-wiki-selection.mjs [--root <dir>]... [--run <runDir>]... [--recheck] [--json]',
  '',
  '  --root <dir>    递归发现的根目录，默认 <repo>/.operator-studio-local（可重复）',
  '  --run <runDir>  只 replay 指定运行目录，可重复；给了就不再走 --root 发现',
  '  --recheck       额外重跑 retrieveExperienceSelection（次要证据，带混淆，见脚本头注释）',
  '  --json          以 JSON 输出完整报告',
  '',
  '只读：不启动模型/GPU/provider/子进程，不写任何运行目录。',
].join('\n');

// ---------------------------------------------------------------- 纯函数（可单测）

const isNonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringList = (value) => (Array.isArray(value) ? value.filter(isNonBlank) : []);
const lower = (value) => String(value).toLowerCase();
const tokens = (value) => lower(value).split(/[^a-z0-9]+/u).filter(Boolean);
const identity = (id, version) => `${id}@${version}`;
const uniqueSorted = (values) => [...new Set(values)].sort();
const intersect = (left, right) => {
  const rightSet = new Set(right.map(lower));
  return uniqueSorted(left.filter((item) => rightSet.has(lower(item))));
};

/**
 * 一个 KernelWiki 单元**自己声明**的适用范围。
 *
 * 两个来源必须分开报告，不能混成一个：
 *   - `applicability.*` 是**已审**适用范围（review 断言这个单元可以迁移到哪些目标）；
 *   - `architectures` / `hardware`（顶层）是源页面自己的原始清单。
 * "被审为可用于本目标" 与 "源页面顺带提过本目标" 是两件不同的事，合成一个字段就再也分不开。
 * `reviewed` 要求非 unreviewed 且带 reviewId：unreviewed 单元被注入本身就是缺陷。
 */
export const declaredApplicability = (metadata) => {
  const applicability = isPlainObject(metadata?.applicability) ? metadata.applicability : {};
  const reviewedArchitectures = stringList(applicability.architectures);
  const pageArchitectures = stringList(metadata?.architectures);
  const mode = isNonBlank(applicability.mode) ? applicability.mode : null;
  return {
    mode,
    reviewId: isNonBlank(applicability.reviewId) ? applicability.reviewId : null,
    reviewed: mode !== null && mode !== UNREVIEWED_MODE && isNonBlank(applicability.reviewId),
    reviewedArchitectures,
    pageArchitectures,
    declaredArchitectures: uniqueSorted([...reviewedArchitectures, ...pageArchitectures]),
    declaredHardware: stringList(applicability.hardware),
    // 架构判定的依据：已审 > 源页面自带 > 什么都没有。报告里必须显示依据，否则一串架构
    // 看不出是"谁说的"。
    architectureBasis: reviewedArchitectures.length ? 'reviewed-applicability'
      : pageArchitectures.length ? 'source-page-only' : 'none',
  };
};

/**
 * 一个被选中的 KernelWiki 单元与当轮目标的**相关性**（不是"证据"，只是可复核的对照）。
 * 特征重叠用的是当轮审计里的 `features`（kind:value），命中词表 = topics ∪ pageId 分词。
 * 命中就报出命中的那个词，而不是只给一个布尔值，便于人工判断这条相关性站不站得住。
 */
export const wikiRelevance = ({ record, target, features }) => {
  const metadata = isPlainObject(record?.selectionMetadata) ? record.selectionMetadata : {};
  const declared = declaredApplicability(metadata);
  const targetArchitectures = stringList(target?.architecture);
  const targetHardware = stringList(target?.hardware);
  const topics = stringList(metadata.topics);
  const vocabulary = [...topics, ...tokens(metadata.pageId)];
  const matchedFeatures = [];
  for (const feature of Array.isArray(features) ? features : []) {
    const value = String(feature?.value ?? '');
    const featureTokens = tokens(value);
    const term = vocabulary.find((entry) => featureTokens.includes(lower(entry)));
    if (term) matchedFeatures.push({ feature: `${feature?.kind}:${value}`, term });
  }
  return {
    recordId: record.id,
    version: record.version,
    pageId: isNonBlank(metadata.pageId) ? metadata.pageId : null,
    ...declared,
    targetArchitectures,
    targetHardware,
    architectureMatches: intersect(declared.declaredArchitectures, targetArchitectures),
    hardwareMatches: intersect(declared.declaredHardware, targetHardware),
    topics,
    matchedFeatures,
    sourceCommit: metadata.sourceCommit ?? null,
    sourcePath: metadata.sourcePath ?? null,
    unitDigest: metadata.unitDigest ?? null,
  };
};

/**
 * 违规（真缺陷）判定：只看"注入了一条不该注入的东西"这一类，绝不把相关性弱当缺陷。
 * 只有三类：未审单元被注入、被注入单元没有对应的 provenance sidecar、sidecar 里有不存在于
 * 注入清单的条目（sidecar 与清单必须一一对应，这是既有 study 契约的原样要求）。
 */
export const selectionDefects = ({ selection, wikiItems }) => {
  const sources = Array.isArray(selection?.sources) ? selection.sources : [];
  const provenance = new Set(sources.map((entry) => identity(entry.recordId, entry.version)));
  const injected = new Set(wikiItems.map((item) => identity(item.recordId, item.version)));
  const defects = [];
  for (const item of wikiItems) {
    if (item.missingRecord) { defects.push({ code: 'wiki-record-absent-from-final-store', recordId: item.recordId, version: item.version }); continue; }
    if (!item.reviewed) defects.push({ code: 'unreviewed-wiki-injected', recordId: item.recordId, version: item.version, mode: item.mode });
    if (!provenance.has(identity(item.recordId, item.version))) defects.push({ code: 'wiki-item-missing-provenance', recordId: item.recordId, version: item.version });
  }
  for (const entry of sources) {
    if (!injected.has(identity(entry.recordId, entry.version))) defects.push({ code: 'provenance-without-item', recordId: entry.recordId, version: entry.version });
  }
  return defects;
};

/** 相关性提醒：不是缺陷，只是"命中了但适用范围/特征对不上，值得人看一眼"。 */
export const relevanceWarnings = ({ wikiItems }) => {
  const warnings = [];
  for (const item of wikiItems) {
    if (item.missingRecord) continue;
    if (item.declaredArchitectures.length && !item.architectureMatches.length) {
      warnings.push({ code: 'declared-architecture-excludes-target', recordId: item.recordId, declared: item.declaredArchitectures, target: item.targetArchitectures });
    }
    if (!item.matchedFeatures.length) warnings.push({ code: 'no-feature-topic-overlap', recordId: item.recordId, topics: item.topics });
  }
  return warnings;
};

/** 排除原因计数：`unreviewed` 是 KernelWiki 被"审核状态"挡住的主因，单独可见。 */
export const exclusionSummary = (selection) => {
  const excluded = Array.isArray(selection?.excluded) ? selection.excluded : [];
  const byReason = {};
  for (const entry of excluded) byReason[entry?.reason ?? 'unknown'] = (byReason[entry?.reason ?? 'unknown'] ?? 0) + 1;
  return {
    total: excluded.length,
    byReason,
    unreviewed: byReason.unreviewed ?? 0,
    omitted: selection?.excludedOmitted ?? 0,
    unauthorized: selection?.excludedUnauthorized ?? 0,
  };
};

const isKernelWikiEntry = ({ entry, record }) => {
  if (isPlainObject(record?.selectionMetadata)) return record.selectionMetadata.source === KERNEL_WIKI_SOURCE;
  // 记录已不在最终 store 里时，只能靠 canonical record id 前缀（`kernelWikiRecordId` 的产物）。
  return String(entry?.id ?? '').startsWith('kw-');
};

/**
 * 把一份审计 + 它当时的 store 变成一行可复核的记录。纯函数：调用方传入已经读好的记录索引。
 * `records` 是**最终** store 的索引；当轮记录的旧版本可能已不存在，此时按 missing 记录，
 * 并且照样把审计本身当证据（审计不依赖 store 是否还在）。
 */
export const buildAuditRow = ({ runDir, selection, loopStartedAt, records }) => {
  const selected = Array.isArray(selection?.selected) ? selection.selected : [];
  const wiki = [];
  for (const entry of selected) {
    const record = records.get(identity(entry.id, entry.version));
    if (!isKernelWikiEntry({ entry, record })) continue;
    const base = record
      ? wikiRelevance({ record, target: selection.target, features: selection.features })
      : { recordId: entry.id, version: entry.version, missingRecord: true };
    wiki.push({
      ...base,
      reason: entry.reason ?? null,
      bucket: entry.bucket ?? null,
      useAs: entry.useAs ?? null,
      recordSource: entry.source ?? null,
    });
  }
  const row = {
    run: runDir.replaceAll('\\', '/'),
    roundId: selection?.roundId ?? null,
    contextId: selection?.contextId ?? null,
    experienceCondition: selection?.experienceCondition ?? null,
    policyVersion: selection?.policyVersion ?? null,
    targetArchitecture: stringList(selection?.target?.architecture),
    targetHardware: stringList(selection?.target?.hardware),
    features: (Array.isArray(selection?.features) ? selection.features : []).map((feature) => `${feature?.kind}:${feature?.value}`),
    selectedCount: selected.length,
    wiki,
    exclusions: exclusionSummary(selection),
    loopStartedAt: loopStartedAt ?? null,
  };
  row.defects = selectionDefects({ selection, wikiItems: wiki });
  row.relevanceWarnings = relevanceWarnings({ wikiItems: wiki });
  return row;
};

/** 汇总。wiki 命中率按"审计条数"算，不按 run 数算——一个 run 里的两次审计按 contextId 已去重。 */
export const summarize = (rows) => {
  const byCondition = new Map();
  for (const row of rows) {
    const key = row.experienceCondition ?? '(unset)';
    const entry = byCondition.get(key) ?? { condition: key, audits: 0, wikiHits: 0, wikiItems: 0 };
    entry.audits += 1;
    entry.wikiHits += row.wiki.length ? 1 : 0;
    entry.wikiItems += row.wiki.length;
    byCondition.set(key, entry);
  }
  const hits = rows.filter((row) => row.wiki.length);
  const flat = (key) => rows.flatMap((row) => row[key].map((entry) => ({ run: row.run, roundId: row.roundId, contextId: row.contextId, ...entry })));
  return {
    runs: uniqueSorted(rows.map((row) => row.run)).length,
    audits: rows.length,
    wikiHitAudits: hits.length,
    wikiItemsSelected: rows.reduce((total, row) => total + row.wiki.length, 0),
    distinctWikiUnits: uniqueSorted(hits.flatMap((row) => row.wiki.map((item) => identity(item.recordId, item.version)))),
    byCondition: [...byCondition.values()].sort((left, right) => left.condition.localeCompare(right.condition)),
    defects: flat('defects'),
    relevanceWarnings: flat('relevanceWarnings'),
  };
};

/**
 * 次要证据：用**当前** store 重跑一次同一选择。返回结构里永远带 `confounds`，调用方
 * 不得把它渲染成"当轮就是这样"。
 */
export const recheckSelection = ({ store, selection, now }) => {
  const confounds = [
    'store-read-is-final-not-as-of-the-round: records written after this round are visible today',
    'preferredIds-and-repeatedAttempts-are-not-persisted-in-the-audit-so-ranking-cannot-be-replayed',
  ];
  if (!isNonBlank(now)) return { status: 'skipped', reason: 'no replay clock: the surrounding iteration stats carry no loopStartedAt', confounds };
  if (selection?.policyVersion !== WIKI_SELECTION_POLICY_VERSION) {
    return { status: 'skipped', reason: `policy version changed: audit=${selection?.policyVersion} current=${WIKI_SELECTION_POLICY_VERSION}`, confounds };
  }
  const query = {
    projectId: selection.projectId,
    // 审计不记录 allowedProjectIds；全部 store 里 shared 可见性记录为 0 时传空数组是等价的。
    allowedProjectIds: [],
    missionId: selection.missionId,
    roundId: selection.roundId,
    scope: selection.scope,
    selection: { policyVersion: selection.policyVersion, features: selection.features, target: selection.target },
  };
  if (selection.experienceCondition !== undefined && selection.experienceCondition !== null) {
    query.selection.experienceCondition = selection.experienceCondition;
  }
  let replayed;
  try {
    replayed = retrieveExperienceSelection(store, query, { now });
  } catch (cause) {
    return { status: 'error', reason: `${cause?.code ?? 'ERROR'}: ${cause?.message ?? cause}`, confounds };
  }
  const persisted = uniqueSorted((selection.selected ?? []).map((entry) => identity(entry.id, entry.version)));
  const current = uniqueSorted((replayed.selection.selected ?? []).map((entry) => identity(entry.id, entry.version)));
  const currentSet = new Set(current);
  const persistedSet = new Set(persisted);
  // 新增条目是不是"当轮之后才写进 store 的"：这是把笼统的"store 是最终状态"变成可核验事实的
  // 唯一办法。时间戳直接和重跑时钟（loopStartedAt）比；同一个存储里都是 UTC ISO 串，字典序即时间序。
  const describe = (key) => {
    const record = (store.records ?? []).find((item) => identity(item.id, item.version) === key);
    const createdAt = record?.createdAt ?? null;
    return { key, createdAt, postdatesRound: Boolean(createdAt && createdAt > now) };
  };
  const added = current.filter((key) => !persistedSet.has(key)).map(describe);
  const removed = persisted.filter((key) => !currentSet.has(key)).map(describe);
  // `differs-only-by-post-round-records`：当轮选中的条目一条都没丢，新增的全部产生于当轮之后。
  // 这**只**说明"当时存在的记录集合被复现了"，不说明排序/配额与当轮逐位相同——审计没持久化
  // preferredIds/repeatedAttempts，排序无法复刻。
  const onlyPostRound = removed.length === 0 && added.length > 0 && added.every((entry) => entry.postdatesRound);
  return {
    status: persisted.join('|') === current.join('|') ? 'same' : onlyPostRound ? 'differs-only-by-post-round-records' : 'differs',
    confounds,
    storeRevisionAtSelection: selection.repositoryRevision ?? null,
    storeRevisionNow: store.revision ?? null,
    persisted,
    replayed: current,
    added,
    removed,
    contextIdAtSelection: selection.contextId ?? null,
    contextIdReplayed: replayed.selection.contextId ?? null,
  };
};

// ---------------------------------------------------------------- I/O

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * 递归找运行目录：同时有 runtime/experiences/experiences.json 和 data/mock-db.json 才算。
 *
 * 刻意不进入「仓库快照」目录：`.operator-studio-local` 下存在整份代码树的冻结副本
 * （frozen-*），它们内部也有 experiences.json 之类的文件。把 fixture 当成真实运行来统计，
 * 会让这份报告的证据价值直接归零，所以检出 `package.json` + `client-runtime` 的目录一律
 * 不进入、只计数，并在报告里说明跳过了几个。
 */
export const discoverRunDirs = (root) => {
  const found = [];
  const skippedCheckouts = [];
  const isCheckoutSnapshot = (dir, entries) => entries.some((entry) => entry.name === 'package.json' && entry.isFile())
    && entries.some((entry) => entry.name === 'client-runtime' && entry.isDirectory());
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.name === 'experiences.json' && entry.isFile())
      && existsSync(path.join(dir, '..', '..', DB_RELATIVE))) {
      found.push(path.resolve(dir, '..', '..'));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      let childEntries = [];
      try { childEntries = readdirSync(child, { withFileTypes: true }); } catch { continue; }
      if (isCheckoutSnapshot(child, childEntries)) { skippedCheckouts.push(child.replaceAll('\\', '/')); continue; }
      walk(child);
    }
  };
  walk(root);
  return { runDirs: uniqueSorted(found), skippedCheckouts };
};

/** 审计去重键 = contextId：同一轮的选择可能经由两条路径被写进同一个 DB，实体是同一份。 */
export const collectAudits = (db) => {
  const audits = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (isPlainObject(node.roundExperienceSelection)) {
      const selection = node.roundExperienceSelection;
      const key = isNonBlank(selection.contextId) ? selection.contextId : `${selection.roundId}:${audits.size}`;
      if (!audits.has(key)) audits.set(key, { selection, loopStartedAt: node.loopStartedAt ?? null });
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(db);
  return [...audits.values()];
};

export const readRun = (runDir) => {
  const storePath = path.join(runDir, STORE_RELATIVE);
  const dbPath = path.join(runDir, DB_RELATIVE);
  if (!existsSync(storePath) || !existsSync(dbPath)) return null;
  const store = readJson(storePath);
  const db = readJson(dbPath);
  const records = new Map((store.records ?? []).map((record) => [identity(record.id, record.version), record]));
  return { storePath, dbPath, store, records, audits: collectAudits(db) };
};

export const replayRuns = ({ runDirs, recheck = false }) => {
  const rows = [];
  const runs = [];
  for (const runDir of runDirs) {
    const run = readRun(runDir);
    if (!run) { runs.push({ run: runDir.replaceAll('\\', '/'), status: 'unreadable', reason: 'missing experiences.json or data/mock-db.json' }); continue; }
    const runRows = [];
    for (const { selection, loopStartedAt } of run.audits) {
      const row = buildAuditRow({ runDir, selection, loopStartedAt, records: run.records });
      if (recheck) row.recheck = recheckSelection({ store: run.store, selection, now: loopStartedAt });
      runRows.push(row);
      rows.push(row);
    }
    runs.push({
      run: runDir.replaceAll('\\', '/'),
      status: 'read',
      audits: runRows.length,
      storeRecords: (run.store.records ?? []).length,
      storeRevision: run.store.revision ?? null,
      kernelWikiRecords: (run.store.records ?? []).filter((record) => record?.selectionMetadata?.source === KERNEL_WIKI_SOURCE).length,
    });
  }
  return { runs, rows, summary: summarize(rows) };
};

// ---------------------------------------------------------------- CLI

const parseArguments = (argv) => {
  const options = { roots: [], runDirs: [], recheck: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { ...options, help: true };
    else if (flag === '--recheck') options.recheck = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--root' || flag === '--run') {
      const value = argv[index + 1];
      if (!isNonBlank(value)) throw new Error(`${flag} requires a directory`);
      index += 1;
      (flag === '--root' ? options.roots : options.runDirs).push(value);
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!options.roots.length && !options.runDirs.length) options.roots.push(path.join(projectRoot, '.operator-studio-local'));
  return options;
};

const renderItem = (item) => {
  const lines = [`    + ${identity(item.recordId, item.version)}  bucket=${item.bucket} reason=${item.reason} useAs=${item.useAs}`];
  if (item.missingRecord) return [...lines, '      记录已不在最终 store 中：相关性无法从 store 复核，审计本身仍是主证据'];
  lines.push(`      reviewed: mode=${item.mode} reviewId=${item.reviewId} reviewed=${item.reviewed}`);
  lines.push(`      声明架构: reviewed=[${item.reviewedArchitectures.join(',')}] page=[${item.pageArchitectures.join(',')}]`
    + ` -> 与目标[${item.targetArchitectures.join(',')}]交集=[${item.architectureMatches.join(',')}] (依据=${item.architectureBasis})`);
  lines.push(`      声明硬件: [${item.declaredHardware.join(',')}] -> 与目标[${item.targetHardware.join(',')}]交集=[${item.hardwareMatches.join(',')}]`);
  lines.push(item.matchedFeatures.length
    ? `      特征重叠: ${item.matchedFeatures.map((match) => `${match.feature} ~ "${match.term}"`).join('; ')}`
    : `      特征重叠: 无（topics=[${item.topics.join(',')}]）`);
  lines.push(`      provenance: ${item.sourcePath} @ ${String(item.sourceCommit).slice(0, 12)} unitDigest=${String(item.unitDigest).slice(0, 12)}`);
  return lines;
};

const renderReport = ({ runs, rows, summary, skippedCheckoutSnapshots }) => {
  const lines = [];
  lines.push('[replay] KernelWiki 选择历史 replay —— 只读，不启动模型/GPU/provider/子进程');
  lines.push('[replay] 本报告是历史 replay，不是模型或 GPU 收益验证；主证据是落盘审计，重跑只是次要检查');
  lines.push(`[replay] runs=${summary.runs} audits=${summary.audits}(按 contextId 去重) wiki命中审计=${summary.wikiHitAudits} 命中单元条目=${summary.wikiItemsSelected}`);
  for (const run of runs) {
    if (run.status !== 'read') { lines.push(`[replay] !! ${run.run} 不可读：${run.reason}`); continue; }
    lines.push(`[replay] ${run.run} audits=${run.audits} store=${run.storeRecords}条(rev ${run.storeRevision}) 其中kernel-wiki=${run.kernelWikiRecords}`);
  }
  if (skippedCheckoutSnapshots?.length) {
    lines.push(`[replay] 已跳过 ${skippedCheckoutSnapshots.length} 个仓库快照目录（不是运行目录，避免把 fixture 当证据）：`);
    for (const dir of skippedCheckoutSnapshots) lines.push(`  ${dir}`);
  }
  lines.push('');
  lines.push('条件               审计数  wiki命中审计  命中单元条目');
  for (const entry of summary.byCondition) {
    lines.push(`${entry.condition.padEnd(18)} ${String(entry.audits).padStart(5)} ${String(entry.wikiHits).padStart(11)} ${String(entry.wikiItems).padStart(13)}`);
  }
  if (summary.distinctWikiUnits.length) {
    lines.push('');
    lines.push(`被选中的不同 KernelWiki 单元（${summary.distinctWikiUnits.length}）：`);
    for (const unit of summary.distinctWikiUnits) lines.push(`  ${unit}`);
  }
  const hits = rows.filter((row) => row.wiki.length);
  lines.push('');
  lines.push(`--- 命中明细（${hits.length} 条审计）---`);
  if (!hits.length) lines.push('  （无命中）');
  for (const row of hits) {
    lines.push(`${row.run}`);
    lines.push(`  ${row.roundId}  condition=${row.experienceCondition ?? '(unset)'} target arch=[${row.targetArchitecture.join(',')}] hw=[${row.targetHardware.join(',')}]`);
    lines.push(`  features: ${row.features.join(', ') || '(none)'}`);
    for (const item of row.wiki) lines.push(...renderItem(item));
    const reasons = Object.entries(row.exclusions.byReason).map(([reason, count]) => `${reason}=${count}`).join(', ');
    lines.push(`  排除: ${row.exclusions.total} 条 (${reasons || 'none'})${row.exclusions.omitted ? ` 另有 ${row.exclusions.omitted} 条未列出` : ''}`);
    if (row.recheck) {
      const { recheck } = row;
      lines.push(`  重跑(次要证据, 有混淆): ${recheck.status}`
        + (recheck.reason ? ` — ${recheck.reason}` : '')
        + (recheck.storeRevisionAtSelection !== undefined ? ` [store rev ${recheck.storeRevisionAtSelection} -> ${recheck.storeRevisionNow}]` : ''));
      for (const entry of recheck.added ?? []) lines.push(`    +${entry.key} createdAt=${entry.createdAt}${entry.postdatesRound ? ' (产生于当轮之后，不是选择变化)' : ''}`);
      for (const entry of recheck.removed ?? []) lines.push(`    -${entry.key} createdAt=${entry.createdAt}`);
    }
  }
  lines.push('');
  lines.push(`[replay] 缺陷: ${summary.defects.length}`);
  for (const defect of summary.defects) lines.push(`  ${defect.code} ${identity(defect.recordId, defect.version)} (${defect.roundId})${defect.mode ? ` mode=${defect.mode}` : ''}`);
  lines.push(`[replay] 相关性提醒（不是缺陷）: ${summary.relevanceWarnings.length}`);
  for (const warning of summary.relevanceWarnings) {
    lines.push(`  ${warning.code} ${warning.recordId} (${warning.roundId})`
      + `${warning.declared ? ` 声明=[${warning.declared.join(',')}] 目标=[${warning.target.join(',')}]` : ''}`
      + `${warning.topics ? ` topics=[${warning.topics.join(',')}]` : ''}`);
  }
  if (rows.some((row) => row.recheck)) {
    lines.push('[replay] 重跑差异**不能**当成当轮事实：store 是最终状态，且审计未持久化 preferredIds/repeatedAttempts');
  }
  return lines.join('\n');
};

const main = () => {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (cause) {
    console.error(`[replay] ${cause.message}\n\n${usage()}`);
    return 1;
  }
  if (options.help) { console.log(usage()); return 0; }
  let runDirs = options.runDirs.map((dir) => path.resolve(dir));
  const missing = [];
  const skippedCheckouts = [];
  if (!runDirs.length) {
    const roots = options.roots.map((root) => path.resolve(root));
    for (const root of roots) {
      if (!existsSync(root) || !statSync(root).isDirectory()) { missing.push(root); continue; }
      const discovered = discoverRunDirs(root);
      runDirs.push(...discovered.runDirs);
      skippedCheckouts.push(...discovered.skippedCheckouts);
    }
  }
  runDirs = uniqueSorted(runDirs);
  if (missing.length) { console.error(`[replay] 根目录不可读：${missing.join(', ')}`); return 2; }
  if (!runDirs.length) { console.error('[replay] 没有找到任何运行目录（需要同时有 runtime/experiences/experiences.json 与 data/mock-db.json）'); return 2; }
  const report = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    recheck: options.recheck,
    runDirs: runDirs.map((dir) => dir.replaceAll('\\', '/')),
    skippedCheckoutSnapshots: uniqueSorted(skippedCheckouts),
    ...replayRuns({ runDirs, recheck: options.recheck }),
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report.summary.defects.length ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
