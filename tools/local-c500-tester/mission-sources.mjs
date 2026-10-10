import { lstat, readdir, open, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { normalizeSourcePath } from './mission-spec.mjs';

// Local intake adapter. No Runtime state, Mission transitions or source writes.
const excluded = new Set(['.git', '.operator-studio', 'node_modules', '.venv', 'venv', '__pycache__', '.ds_store']);
export const missionSourcePolicyVersion = 'operator-studio.mission-source-policy/v1';
const pendingEntry = Buffer.from('# Operator Studio: implementation pending; no baseline or test evidence.\ndef run(*args, **kwargs):\n    raise NotImplementedError("Implement the confirmed operator contract")\n');
const sensitiveDirectories = new Set(['.ssh', '.aws', '.azure', '.kube', '.gcloud', '.codex', '.claude']);
const sensitiveName = (name) => /^\.env(?:\.|$)/iu.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/iu.test(name)
  || /(?:\.pem|\.key|\.p12|\.pfx|\.keystore)$/iu.test(name)
  || /^(?:credentials?|secrets?|service[-_]?account)(?:\.[^.]+)?$/iu.test(name)
  || /^(?:\.npmrc|\.pypirc|\.netrc)$/iu.test(name);
const gitEnvironment = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' });
};
// Preview reads selected source bytes only after path, ignore and credential policy checks.
const readSourceBytes = async (source, before) => {
  const handle = await open(source, 'r');
  try {
    if (!same(before, await handle.stat())) fail('读取前文件发生变化，请重新选择。');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    await plainPath(source);
    if (length !== before.size || !same(before, await handle.stat()) || !same(before, await lstat(source))) fail('读取时文件发生变化，请重新选择。');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
};
const findIgnoreRoot = async (directory) => {
  let current = directory;
  for (let depth = 0; depth < 64; depth++) {
    try { const marker = await lstat(path.join(current, '.git')); if (marker.isDirectory() || marker.isFile()) return current; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directory;
};
const fail = (message) => { const error = new Error(message); error.code = 'MISSION_SOURCE_IMPORT_INVALID'; throw error; };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const plainPath = async (target) => {
  let current = path.resolve(target);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('请选择实际文件或文件夹，不支持链接。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
};

export const listMissionSourceDirectory = async (requestedPath) => {
  if (requestedPath === ':roots:') {
    const roots = process.platform === 'win32'
      ? (await Promise.all(Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).map(async (root) => {
        try { return (await lstat(root)).isDirectory() ? root : null; } catch { return null; }
      }))).filter(Boolean) : ['/'];
    return { path: ':roots:', label: '此电脑', parent: null, entries: roots.map((root) => ({ name: root, path: root, directory: true })) };
  }
  const target = path.resolve(requestedPath === ':home:' ? os.homedir() : requestedPath || os.homedir());
  await plainPath(target);
  const entries = (await readdir(target, { withFileTypes: true }))
    .filter((entry) => !excluded.has(entry.name.toLowerCase()) && (entry.isDirectory() || entry.isFile()))
    .map((entry) => ({ name: entry.name, path: path.join(target, entry.name), directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path: target, parent: path.dirname(target) === target ? ':roots:' : path.dirname(target), entries };
};

export const inspectMissionSources = async (selections = [], options = {}) => {
  if (!Array.isArray(selections) || selections.length > 64 || selections.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) fail('请选择本机文件或文件夹（最多 64 项）。');
  if (!Array.isArray(options.includeIgnoredPaths || []) || (options.includeIgnoredPaths || []).length > 64) fail('忽略文件只能逐项明确选回（最多 64 项）。');
  const includedPaths = [...new Set((options.includeIgnoredPaths || []).map((value) => normalizeSourcePath(value)))].sort();
  const files = [], excludedFiles = [], candidates = [], ignoreRules = new Map(), directoryChecks = [];
  const contents = new Map(), names = new Map(), origins = new Set();
  let totalBytes = 0, directories = 0, entries = 0;
  const excludedFile = (source, name, reasonCode, reason, directory = false) => {
    excludedFiles.push({ path: name, sourcePath: source, reasonCode, reason, canInclude: reasonCode === 'gitignored', ...(directory ? { directory: true } : {}) });
  };
  const registerRule = async (source, root) => {
    if (ignoreRules.has(source)) return;
    let before;
    try { before = await lstat(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await plainPath(source);
    if (!before.isFile() || before.nlink !== 1 || before.size > 2 * 1024 * 1024) fail('忽略规则必须是 ≤2 MiB 的普通 .gitignore 文件。');
    const bytes = await readSourceBytes(source, before);
    ignoreRules.set(source, { sourcePath: source, path: path.relative(root, source).split(path.sep).join('/'), digest: digest(bytes), before });
  };
  const visit = async (source, relative = '', depth = 0, root) => {
    if (!relative && excluded.has(path.basename(source).toLowerCase())) fail('请选择算子源码，不导入版本库、依赖包或缓存目录。');
    if (depth > 32) fail('文件夹层级过深，请选择更具体的源码目录。');
    if (++entries > 8192) fail('素材预览范围过大，请选择本次算子更具体的源码目录。');
    await plainPath(source);
    const before = await lstat(source);
    const rawName = relative || path.basename(source);
    const name = excluded.has(path.basename(source).toLowerCase()) ? rawName : normalizeSourcePath(rawName);
    if (excluded.has(path.basename(source).toLowerCase())) {
      excludedFile(source, name, 'system', '版本库、依赖包或缓存不属于任务源码', before.isDirectory()); return;
    }
    if (sensitiveDirectories.has(path.basename(source).toLowerCase()) || sensitiveName(path.basename(source))) {
      excludedFile(source, name, 'sensitive', '凭据或敏感配置禁止导入；请使用不含凭据的普通配置文件', before.isDirectory()); return;
    }
    if (before.isDirectory()) {
      if (++directories > 512) fail('目录过多，请只选择本次算子需要的文件。');
      directoryChecks.push([source, before]);
      for (const entry of (await readdir(source)).sort()) await visit(path.join(source, entry), relative ? relative + '/' + entry : entry, depth + 1, root);
      if (!same(before, await lstat(source))) fail('选择的文件夹正在变化，请稍后重试。');
      return;
    }
    if (!before.isFile() || before.nlink !== 1) fail('素材必须是普通文件，不支持链接或特殊文件。');
    if (name.split('/').some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('不能导入此路径：' + name);
    if (origins.has(source)) return;
    origins.add(source);
    if (path.basename(source).toLowerCase() === '.gitignore') {
      await registerRule(source, root); excludedFile(source, name, 'policy', '导入规则单独冻结，不作为模型可写源码'); return;
    }
    candidates.push({ source, name, before, root });
  };
  const selected = [...new Set(selections.map((entry) => path.resolve(entry)))];
  for (const source of selected) {
    if (selected.some((parent) => parent !== source && source.startsWith(parent + path.sep))) continue;
    await plainPath(source);
    const selectedInfo = await lstat(source), directory = selectedInfo.isDirectory() ? source : path.dirname(source);
    const root = await findIgnoreRoot(directory);
    // Native Git checks only .gitignore in the selected scope and its repository ancestry.
    for (let current = directory; ; current = path.dirname(current)) {
      await registerRule(path.join(current, '.gitignore'), root);
      if (current === root) break;
      if (path.dirname(current) === current) fail('无法确认素材忽略规则边界。');
    }
    await visit(source, '', 0, root);
  }
  const ignored = new Set();
  let ignoreHome;
  try {
    if (ignoreRules.size && candidates.length) {
      // Isolated Git metadata: never reads the source repository's config, index,
      // info/exclude, global config or hooks, and never writes selected sources.
      ignoreHome = await mkdtemp(path.join(os.tmpdir(), 'mission-ignore-policy-'));
      const env = gitEnvironment();
      const git = (args, settings = {}) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
        '-c', 'core.longpaths=true', '-c', 'core.excludesFile=', ...args],
      { env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...settings });
      git(['init', '--bare', '--template=', '-q', ignoreHome]);
      for (const root of new Set(candidates.map((candidate) => candidate.root))) {
        const group = candidates.filter((candidate) => candidate.root === root);
        const byPath = new Map(group.map((candidate) => [path.relative(root, candidate.source).split(path.sep).join('/'), candidate.source]));
        let output;
        try {
          output = git(['--git-dir=' + ignoreHome, '--work-tree=' + root, 'check-ignore', '--no-index', '-z', '-v', '--stdin'],
            { cwd: root, input: [...byPath.keys()].join('\0') + '\0' });
        } catch (error) {
          if (error.status !== 1) fail('无法安全读取 .gitignore 规则，请确认 Git 可用并重新预览。');
          output = error.stdout || '';
        }
        const fields = output.split('\0');
        for (let at = 0; at + 3 < fields.length; at += 4) if (!fields[at + 2].startsWith('!')) ignored.add(byPath.get(fields[at + 3]));
      }
    }
  } finally {
    if (ignoreHome) {
      if (path.dirname(ignoreHome) !== path.resolve(os.tmpdir()) || !path.basename(ignoreHome).startsWith('mission-ignore-policy-')) throw new Error('Invalid ignore-policy cleanup root');
      await plainPath(ignoreHome);
      await rm(ignoreHome, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  }
  for (const [source, rule] of ignoreRules) if (!same(rule.before, await lstat(source))) fail('忽略规则在读取时发生变化，请重新预览确认。');
  for (const [source, before] of directoryChecks) if (!same(before, await lstat(source))) fail('选择的文件夹正在变化，请稍后重试。');
  for (const { source, name, before } of candidates) {
    const gitignored = ignored.has(source);
    if (gitignored && !includedPaths.includes(name)) { excludedFile(source, name, 'gitignored', '.gitignore 默认排除；若为必需依赖请逐项明确选回'); continue; }
    const parts = name.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const existing = names.get(prefix.toLowerCase());
      if (existing && (existing.name !== prefix || existing.file || index === parts.length)) fail('导入路径冲突：' + prefix + '；请取消重复文件或分开导入。');
      names.set(prefix.toLowerCase(), { name: prefix, file: index === parts.length });
    }
    if (files.length >= 64 || before.size > 2 * 1024 * 1024 || totalBytes + before.size > 8 * 1024 * 1024) fail('素材限 64 个文件、每个 2 MiB、合计 8 MiB；请选择更小的源码范围。');
    const bytes = await readSourceBytes(source, before);
    totalBytes += bytes.length;
    files.push({ path: name, size: bytes.length, digest: digest(bytes), ...(gitignored ? { includedIgnored: true } : {}) });
    contents.set(name, bytes);
  }
  for (const name of includedPaths) {
    if (excludedFiles.some((file) => file.path === name && !file.canInclude)) fail('此项不能选回：' + name + '，请查看排除原因。');
    if (!files.some((file) => file.path === name)) fail('指定选回的依赖不存在或不在选择范围：' + name + '；请重新预览。');
  }
  if (!contents.has('run.py') && files.length >= 64) fail('需为系统创建的 run.py 留出一个文件名额。');
  if (!contents.has('run.py') && names.has('run.py')) fail('run.py 是系统入口，请不要导入同名文件夹或大小写不同的入口名。');
  const generatedFiles = contents.has('run.py') ? [] : [{ path: 'run.py', size: pendingEntry.length, digest: digest(pendingEntry), generated: true }];
  if (totalBytes + (generatedFiles[0]?.size || 0) > 8 * 1024 * 1024) fail('含系统入口的最终素材超过 8 MiB，请减少源码范围。');
  const rules = [...ignoreRules.values()].map(({ before, ...rule }) => rule).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  const sourcePolicy = { version: missionSourcePolicyVersion, includeIgnoredPaths: includedPaths, ignoreRulesDigest: digest(JSON.stringify(rules)) };
  sourcePolicy.digest = digest(JSON.stringify(sourcePolicy));
  const reviewDigest = digest(JSON.stringify({ selections: selected, sourcePolicy, files, generatedFiles, excludedFiles }));
  return { selections: selected, files, totalBytes, generatedFiles, excludedFiles, sourcePolicy, reviewDigest, contents };
};

// Existing /api/projects/import remains the only project registration path.
// The short-lived Git snapshot is an implementation detail, never user-owned.
export const stageMissionSources = async (home, selections, expectedFiles, options = {}) => {
  const snapshot = await inspectMissionSources(selections, options);
  const identity = (files) => JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)));
  if (!Array.isArray(expectedFiles) || identity(snapshot.files) !== identity(expectedFiles)
    || (options.expectedReviewDigest && options.expectedReviewDigest !== snapshot.reviewDigest)
    || (options.expectedPolicyDigest && options.expectedPolicyDigest !== snapshot.sourcePolicy.digest)) fail('素材或导入规则自选择后已变化，请重新打开导入清单确认。');
  await mkdir(home, { recursive: true });
  const repository = await mkdtemp(path.join(home, 'mission-intake-'));
  // Only our fresh child is removed; user-selected sources are read-only.
  const cleanup = async () => {
    if (path.dirname(repository) !== path.resolve(home) || !path.basename(repository).startsWith('mission-intake-')) throw new Error('Invalid intake cleanup root');
    await plainPath(repository);
    await rm(repository, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  };
  try {
    if (!snapshot.contents.has('run.py')) snapshot.contents.set('run.py', pendingEntry);
    for (const [name, bytes] of snapshot.contents) {
      const target = path.join(repository, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    }
    // A caller's GIT_DIR/INDEX_FILE or global helpers must never redirect writes.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' });
    const git = (args, input) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
      '-c', 'core.longpaths=true', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { cwd: repository, env, encoding: 'utf8', windowsHide: true, timeout: 15000, input });
    git(['init', '--template=', '-q']);
    git(['config', 'user.name', 'Operator Studio']);
    git(['config', 'user.email', 'operator-studio@local.invalid']);
    // Plumbing does not execute imported hooks, attributes, filters or ignore rules.
    const lines = [...snapshot.contents.keys()].map((name) => `100644 ${git(['hash-object', '-w', '--no-filters', '--', name]).trim()}\t${name}\0`).join('');
    git(['update-index', '-z', '--index-info'], lines);
    const tree = git(['write-tree']).trim();
    git(['update-ref', 'HEAD', git(['commit-tree', tree, '-m', 'Imported Mission materials']).trim()]);
    return { repository, cleanup, files: [...snapshot.files, ...snapshot.generatedFiles], sourcePolicy: snapshot.sourcePolicy, reviewDigest: snapshot.reviewDigest };
  } catch (error) { await cleanup(); throw error; }
};
