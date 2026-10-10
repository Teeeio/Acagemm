import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createScopedGitEnvironment } from './git-environment.mjs';
import { isAcquiringSourceDirectory } from './source-registry-integrity.mjs';

const defaultGitTimeoutMs = 20_000;

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

const execFileAsync = (execFileImpl, command, args, options = {}) => new Promise((resolve, reject) => {
  const { input, ...execOptions } = options;
  const child = execFileImpl(command, args, {
    ...execOptions,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? defaultGitTimeoutMs,
  }, (error, stdout = '', stderr = '') => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
  // A Windows pipe error can be emitted on stdio independently of the child callback.
  // Preserve uncertainty as a rejected operation instead of crashing the local API.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.once?.('error', reject);
  }
  if (input !== undefined) child.stdin.end(input);
});

// These are import admission limits, not operator-test or iteration budgets.
export const PROJECT_SOURCE_IMPORT_LIMITS = Object.freeze({ maxFiles: 20_000, maxBytes: 512 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 });
const importError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const digestBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const containsPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const pathsOverlap = (a, b) => containsPath(a, b) || containsPath(b, a);
const optionalLstat = async (target) => {
  try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const assertPlainPath = async (target) => {
  const absolute = path.resolve(target);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await optionalLstat(cursor);
    if (info?.isSymbolicLink()) throw importError('PROJECT_IMPORT_LINK_UNSUPPORTED', '导入路径不能经过符号链接或目录联接。');
  }
};
const requireImportPath = (value, code) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw importError(code, '源码仓库和项目根目录必须使用本机绝对路径。');
  }
  return path.resolve(value);
};

const normalizePath = async (value) => {
  const canonical = await realpath(value).catch(() => path.resolve(value));
  return canonical.replaceAll('\\', '/').toLowerCase();
};
const normalizeRepositoryIdentity = (value = '') => String(value).trim().replaceAll('\\', '/').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
const excludedSnapshotEntries = new Set(['.git', '.operator-studio']);
const isExcludedSnapshotEntry = (source) => excludedSnapshotEntries.has(path.basename(source).toLowerCase());
export const isGeneratedWorkspaceArtifact = (file) => {
  const normalized = String(file || '').replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  if (!normalized || normalized === '.') return false;
  if (normalized.split('/').some((part) => part === '__pycache__' || part === '.pytest_cache')) return true;
  if (/\.py[cod]$/i.test(basename)) return true;
  return false;
};
const validateGitArgument = (value, label) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    const error = new Error(`${label} 不能为空。`);
    error.code = 'GIT_ARGUMENT_EMPTY';
    error.status = 400;
    throw error;
  }
  if (trimmed.startsWith('-') || /[\0\r\n]/.test(trimmed)) {
    const error = new Error(`${label} 包含不受支持的字符。`);
    error.code = 'GIT_ARGUMENT_INVALID';
    error.status = 400;
    throw error;
  }
  return trimmed;
};

export const copyWorkspaceSnapshot = async (source, target) => {
  await mkdir(target, { recursive: true });
  // A project-local workspace is a child of the source repository. Copying
  // entries one by one prevents recursive source -> .operator-studio copies.
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (isExcludedSnapshotEntry(entry.name)) continue;
    await cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      filter: (candidate) => !isExcludedSnapshotEntry(candidate),
    });
  }
};

export function createWorkspaceManager(options = {}) {
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const gitCommand = options.gitCommand || process.env.GIT_COMMAND || 'git';
  const inspectionCache = new Map();

  const git = async (args, cwd, extra = {}) => execFileAsync(execFileImpl, gitCommand, args, {
    cwd,
    ...extra,
    env: await createScopedGitEnvironment(cwd, { ...process.env, ...(extra.env || {}) }, options.gitEnvironmentOptions),
  });

  // Import deliberately does not inherit Git redirection, global filters, hooks,
  // fsmonitor or lazy-fetch behavior. Source commands are read-only plumbing.
  const importGit = async (args, cwd, input) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
      GIT_ATTR_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Operator Studio', GIT_AUTHOR_EMAIL: 'operator-studio@local.invalid',
      GIT_COMMITTER_NAME: 'Operator Studio', GIT_COMMITTER_EMAIL: 'operator-studio@local.invalid',
    });
    return execFileAsync(execFileImpl, gitCommand, [
      '-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', 'core.longpaths=true',
      '-c', 'core.hooksPath=', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      ...args,
    ], cwd ? { cwd, env, input, maxBuffer: 16 * 1024 * 1024 } : { env, input });
  };

  const prepareSourceImport = async ({ sourceRepository, root, registeredRoots = [] } = {}) => {
    const source = requireImportPath(sourceRepository, 'PROJECT_SOURCE_NOT_ABSOLUTE');
    const destination = requireImportPath(root, 'PROJECT_ROOT_NOT_ABSOLUTE');
    await assertPlainPath(source);
    await assertPlainPath(destination);
    if (pathsOverlap(source, destination)) throw importError('PROJECT_IMPORT_PATH_OVERLAP', '源码仓库与受管项目目录不能重叠。', 409);
    for (const registered of registeredRoots.filter((item) => typeof item === 'string' && path.isAbsolute(item))) {
      const canonical = await realpath(registered).catch(() => path.resolve(registered));
      if (pathsOverlap(canonical, destination)) throw importError('PROJECT_IMPORT_PROJECT_EXISTS', '目标目录与已登记项目重叠。', 409);
    }
    const sourceInfo = await optionalLstat(source);
    const gitDir = path.join(source, '.git');
    const gitInfo = await optionalLstat(gitDir);
    if (!sourceInfo?.isDirectory() || !gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) {
      throw importError('PROJECT_SOURCE_NOT_GIT', '请选择普通 Git 仓库根目录；不支持裸仓库、链接工作树或外置 .git。');
    }
    const canonicalSource = await realpath(source);
    const parent = path.dirname(destination);
    const parentInfo = await optionalLstat(parent);
    if (!parentInfo?.isDirectory()) throw importError('PROJECT_IMPORT_PARENT_UNAVAILABLE', '目标项目的父目录必须已存在。');
    const canonicalDestination = path.join(await realpath(parent), path.basename(destination));
    if (pathsOverlap(canonicalSource, canonicalDestination)) throw importError('PROJECT_IMPORT_PATH_OVERLAP', '源码仓库与受管项目目录不能重叠。', 409);
    for (const registered of registeredRoots.filter((item) => typeof item === 'string' && path.isAbsolute(item))) {
      const canonical = await realpath(registered).catch(() => path.resolve(registered));
      if (pathsOverlap(canonical, canonicalDestination)) throw importError('PROJECT_IMPORT_PROJECT_EXISTS', '目标目录与已登记项目重叠。', 409);
    }

    const limits = { ...PROJECT_SOURCE_IMPORT_LIMITS };
    // A host/test may tighten admission limits, never increase them via an API request.
    for (const key of Object.keys(limits)) {
      const value = options.sourceImportLimits?.[key];
      if (Number.isSafeInteger(value) && value > 0) limits[key] = Math.min(limits[key], value);
    }
    const readPlainFile = async (file, maximum) => {
      await assertPlainPath(file);
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) throw importError('PROJECT_IMPORT_ENTRY_UNSUPPORTED', '源码快照只支持普通文件。');
      if (before.size > maximum) throw importError('PROJECT_IMPORT_LIMIT_EXCEEDED', '源码文件或总字节数超过导入上限。', 413);
      const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        if (!sameVersion(before, await handle.stat())) throw importError('PROJECT_IMPORT_SOURCE_CHANGED', '读取时源码发生变化，请停止编辑后重试。', 409);
        const chunks = [];
        let size = 0;
        while (true) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, maximum - size + 1));
          const { bytesRead } = await handle.read(buffer);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > maximum) throw importError('PROJECT_IMPORT_LIMIT_EXCEEDED', '源码文件或总字节数超过导入上限。', 413);
          chunks.push(buffer.subarray(0, bytesRead));
        }
        await assertPlainPath(file);
        if (!sameVersion(before, await handle.stat()) || !sameVersion(before, await lstat(file))) {
          throw importError('PROJECT_IMPORT_SOURCE_CHANGED', '读取时源码发生变化，请停止编辑后重试。', 409);
        }
        return { bytes: Buffer.concat(chunks), mode: before.mode };
      } finally { await handle.close(); }
    };
    const captureContents = async (copyTo = null) => {
      await assertPlainPath(source);
      await assertPlainPath(gitDir);
      if (!sameFile(sourceInfo, await lstat(source)) || !sameFile(gitInfo, await lstat(gitDir))) {
        throw importError('PROJECT_IMPORT_SOURCE_CHANGED', '源码仓库目录发生变化。', 409);
      }
      for (const entry of ['HEAD', 'config', 'index', 'packed-refs', 'objects', 'objects/info', 'refs', 'refs/heads', 'info/exclude']) {
        await assertPlainPath(path.join(gitDir, entry));
      }
      if (await optionalLstat(path.join(gitDir, 'commondir')) || await optionalLstat(path.join(gitDir, 'objects', 'info', 'alternates'))) {
        throw importError('PROJECT_IMPORT_GIT_LAYOUT_UNSUPPORTED', '不支持共享或外置 Git 对象存储。');
      }
      const promisor = await importGit(['config', '--local', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], source)
        .then((result) => result.stdout.trim()).catch((error) => { if (error.code === 1) return ''; throw error; });
      if (promisor) throw importError('PROJECT_IMPORT_GIT_LAYOUT_UNSUPPORTED', '不支持需要在线补齐对象的部分克隆。');
      let topLevel;
      try { topLevel = (await importGit(['rev-parse', '--show-toplevel'], source)).stdout.trim(); }
      catch { throw importError('PROJECT_SOURCE_NOT_GIT', '源码目录不是可用的普通 Git 仓库。'); }
      if (await realpath(topLevel) !== canonicalSource) throw importError('PROJECT_SOURCE_NOT_GIT', '请选择 Git 仓库根目录。');
      const head = await importGit(['rev-parse', '--verify', '--quiet', 'HEAD'], source).then((result) => result.stdout.trim()).catch((error) => {
        if (error.code === 1) return null;
        throw error;
      });
      const indexFile = path.join(gitDir, 'index');
      const indexDigest = await optionalLstat(indexFile) ? digestBytes((await readPlainFile(indexFile, 16 * 1024 * 1024)).bytes) : null;
      const index = (await importGit(['ls-files', '--stage', '-z'], source)).stdout.split('\0').filter(Boolean);
      const tracked = new Map();
      const indexedObjects = [];
      for (const entry of index) {
        const match = /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
        if (!match || match[3] !== '0') throw importError('PROJECT_IMPORT_UNMERGED', '请先解决 Git 索引中的合并冲突。', 409);
        if (match[1] === '160000') throw importError('PROJECT_IMPORT_SUBMODULE_UNSUPPORTED', '当前导入不支持子模块，请先提供独立源码仓库。');
        if (match[1] === '120000') throw importError('PROJECT_IMPORT_LINK_UNSUPPORTED', '源码快照不能包含符号链接。');
        tracked.set(match[4], match[1]);
        indexedObjects.push({ path: match[4], mode: match[1], hash: match[2] });
      }
      const untracked = (await importGit(['ls-files', '--others', '--exclude-standard', '-z'], source)).stdout.split('\0').filter(Boolean);
      const names = [...new Set([...tracked.keys(), ...untracked])].sort();
      if (names.length > limits.maxFiles) throw importError('PROJECT_IMPORT_LIMIT_EXCEEDED', `源码文件数量超过 ${limits.maxFiles} 项导入上限。`, 413);
      // Even git status can execute configured clean filters. Compare raw blobs
      // with HEAD/index instead, without invoking any source-defined programs.
      const objectFormat = (await importGit(['rev-parse', '--show-object-format'], source)).stdout.trim();
      if (!['sha1', 'sha256'].includes(objectFormat)) throw importError('PROJECT_SOURCE_NOT_GIT', '不支持此 Git 对象格式。');
      const headObjects = head ? (await importGit(['ls-tree', '-r', '-z', head], source)).stdout.split('\0').filter(Boolean).map((entry) => {
        const match = /^(\d{6}) \S+ ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) throw importError('PROJECT_SOURCE_NOT_GIT', '无法读取源码提交身份。');
        return { path: match[3], mode: match[1], hash: match[2] };
      }) : [];
      const files = [];
      const foldedNames = new Map();
      let totalBytes = 0;
      for (const name of names) {
        const segments = name.split('/');
        if (segments.some((part) => !part || part === '.' || part === '..' || /[\\:<>"|?*\x00-\x1f\ufffd]/.test(part)
          || /[. ]$/.test(part) || /^\.git$/i.test(part) || /^\.operator-studio$/i.test(part)
          || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || path.isAbsolute(name)) {
          throw importError('PROJECT_IMPORT_PATH_INVALID', '源码包含不能安全导入的路径。');
        }
        for (let length = 1; length <= segments.length; length += 1) {
          const prefix = segments.slice(0, length).join('/');
          const existing = foldedNames.get(prefix.toLowerCase());
          if (existing && existing !== prefix) throw importError('PROJECT_IMPORT_PATH_INVALID', '源码路径存在大小写冲突。');
          foldedNames.set(prefix.toLowerCase(), prefix);
        }
        const file = path.join(source, ...segments);
        await assertPlainPath(file);
        const info = await optionalLstat(file);
        if (!info) continue; // A tracked deletion stays deleted in the new baseline.
        const { bytes, mode } = await readPlainFile(file, Math.min(limits.maxFileBytes, limits.maxBytes - totalBytes));
        totalBytes += bytes.length;
        const blob = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        const entry = { path: name, size: bytes.length, digest: digestBytes(bytes), hash: blob, mode: process.platform === 'win32' ? tracked.get(name) || '100644' : (mode & 0o111 ? '100755' : '100644') };
        files.push(entry);
        if (copyTo) {
          const target = path.join(copyTo, ...segments);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, bytes, { flag: 'wx' });
          if (process.platform !== 'win32') await chmod(target, entry.mode === '100755' ? 0o755 : 0o644);
        }
      }
      const ordered = (entries) => entries.map(({ path: name, mode, hash }) => ({ path: name, mode, hash })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const baseline = JSON.stringify(ordered(headObjects));
      const dirty = JSON.stringify(ordered(files)) !== baseline || JSON.stringify(ordered(indexedObjects)) !== baseline;
      const snapshotDigest = digestBytes(JSON.stringify({ head, indexDigest, files }));
      return { head, indexDigest, snapshotDigest, dirty, files, totalBytes };
    };
    const capture = async (copyTo) => {
      try { return await captureContents(copyTo); }
      catch (error) {
        if (error.code === 'ENOENT') throw importError('PROJECT_IMPORT_SOURCE_CHANGED', '读取期间源码消失，请停止编辑后重试。', 409);
        throw error;
      }
    };

    let rootInfo = await optionalLstat(destination);
    if (rootInfo && (!rootInfo.isDirectory() || (await readdir(destination)).length)) {
      throw importError('PROJECT_IMPORT_TARGET_NOT_EMPTY', '目标项目目录必须为空，不能覆盖已有内容。', 409);
    }
    const before = await capture();
    const createdRoot = !rootInfo;
    const owned = [];
    let lockOwned = false;
    const lockPath = path.join(destination, '.operator-studio-import.lock');
    const rollback = async () => {
      await assertPlainPath(destination);
      const current = await optionalLstat(destination);
      if (!current || !sameFile(rootInfo, current)) throw importError('PROJECT_IMPORT_CLEANUP_BLOCKED', '导入目录身份变化，已停止自动清理。', 409);
      for (const entry of owned.toReversed()) {
        const target = path.join(destination, entry.name);
        await assertPlainPath(target);
        const info = await optionalLstat(target);
        if (info && !sameFile(info, entry.info)) throw importError('PROJECT_IMPORT_CLEANUP_BLOCKED', '导入内容身份变化，已停止自动清理。', 409);
        if (info) await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      }
      if (lockOwned) await rm(lockPath, { force: true });
      if (createdRoot && (await readdir(destination)).length === 0) await rmdir(destination);
    };
    let claimed = false;
    try {
      await assertPlainPath(destination);
      if (createdRoot) { await mkdir(destination); rootInfo = await lstat(destination); claimed = true; }
      else if (!sameFile(rootInfo, await lstat(destination))) throw importError('PROJECT_IMPORT_TARGET_NOT_EMPTY', '目标目录已变化。', 409);
      await writeFile(lockPath, '', { flag: 'wx' });
      lockOwned = true;
      claimed = true;
      if ((await readdir(destination)).some((name) => name !== path.basename(lockPath))) throw importError('PROJECT_IMPORT_TARGET_NOT_EMPTY', '目标目录已被其他操作使用。', 409);
      for (const name of ['repository', 'sources', '.operator-studio']) {
        await mkdir(path.join(destination, name));
        owned.push({ name, info: await lstat(path.join(destination, name)) });
      }
      const repository = path.join(destination, 'repository');
      const copied = await capture(repository);
      if (before.snapshotDigest !== copied.snapshotDigest) throw importError('PROJECT_IMPORT_SOURCE_CHANGED', '复制期间源码发生变化，请停止编辑后重试。', 409);
      // No clone, checkout, add/filter, hooks or source-repository writes. Plumbing
      // commits the exact copied bytes, including files newly ignored by a dirty .gitignore.
      await importGit(['init', '--template='], repository);
      await importGit(['config', 'core.autocrlf', 'false'], repository);
      await importGit(['config', 'user.name', 'Operator Studio'], repository);
      await importGit(['config', 'user.email', 'operator-studio@local.invalid'], repository);
      await mkdir(path.join(repository, '.git', 'info'), { recursive: true });
      await writeFile(path.join(repository, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
      const indexLines = [];
      for (let offset = 0; offset < copied.files.length; offset += 32) {
        const batch = copied.files.slice(offset, offset + 32);
        const hashes = (await importGit(['hash-object', '-w', '--no-filters', '--', ...batch.map((file) => file.path)], repository)).stdout.trim().split(/\r?\n/);
        if (hashes.length !== batch.length || hashes.some((hash) => !/^[a-f0-9]{40,64}$/.test(hash))) throw importError('PROJECT_IMPORT_FAILED', '无法建立源码快照对象。', 503);
        batch.forEach((file, index) => indexLines.push(`${file.mode} ${hashes[index]}\t${file.path}\0`));
      }
      if (indexLines.length) await importGit(['update-index', '-z', '--index-info'], repository, indexLines.join(''));
      const tree = (await importGit(['write-tree'], repository)).stdout.trim();
      const importedHead = (await importGit(['commit-tree', tree, '-m', 'Operator Studio imported working-tree baseline'], repository)).stdout.trim();
      await importGit(['update-ref', 'HEAD', importedHead], repository);
      const after = await capture();
      if (before.snapshotDigest !== after.snapshotDigest) throw importError('PROJECT_IMPORT_SOURCE_CHANGED', '导入完成前源码发生变化，请停止编辑后重试。', 409);
      await rm(lockPath);
      lockOwned = false;
      return {
        root: destination, repository, sourceRoot: path.join(destination, 'sources'), runtimeRoot: path.join(destination, '.operator-studio'),
        sourceImport: { schemaVersion: 1, mode: 'working-tree-snapshot', repository: sourceRepository, canonicalRepository: canonicalSource,
          head: before.head, indexDigest: before.indexDigest, snapshotDigest: before.snapshotDigest, dirty: before.dirty,
          fileCount: before.files.length, totalBytes: before.totalBytes, importedHead, importedAt: new Date().toISOString() },
        rollback,
      };
    } catch (cause) {
      if (claimed) {
        try { await rollback(); } catch (cleanupError) { cleanupError.cause = cause; throw cleanupError; }
      }
      if (cause.code?.startsWith?.('PROJECT_')) throw cause;
      if (cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw importError('PROJECT_IMPORT_LIMIT_EXCEEDED', '源码清单超过导入上限。', 413);
      throw importError(cause.code === 'EEXIST' ? 'PROJECT_IMPORT_TARGET_NOT_EMPTY' : 'PROJECT_IMPORT_FAILED',
        cause.code === 'EEXIST' ? '目标目录已存在或正在被使用。' : '源码导入失败，未登记项目。', cause.code === 'EEXIST' ? 409 : 503);
    }
  };

  const importSourceRepository = async (input) => {
    try { return await prepareSourceImport(input); }
    catch (error) {
      if (error.code?.startsWith?.('PROJECT_')) throw error;
      const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'PROJECT_IMPORT_LIMIT_EXCEEDED' : 'PROJECT_IMPORT_FAILED';
      throw importError(code, code === 'PROJECT_IMPORT_LIMIT_EXCEEDED' ? '源码清单超过导入上限。' : '源码导入失败，未登记项目。', code === 'PROJECT_IMPORT_LIMIT_EXCEEDED' ? 413 : 503);
    }
  };

  const readMetadata = async (target) => {
    try { return JSON.parse(await readFile(path.join(path.dirname(target), 'workspace.json'), 'utf8')); } catch { return null; }
  };

  const writeMetadata = async (target, metadata) => {
    await writeFile(path.join(path.dirname(target), 'workspace.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  };

  const excludeProjectRuntime = async (repository) => {
    const gitPath = (await git(['rev-parse', '--git-path', 'info/exclude'], repository)).stdout.trim();
    const excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(repository, gitPath);
    let existing = '';
    try { existing = await readFile(excludePath, 'utf8'); } catch { /* created below */ }
    const entries = existing.split(/\r?\n/).map((entry) => entry.trim());
    if (entries.includes('.operator-studio/')) return excludePath;
    await mkdir(path.dirname(excludePath), { recursive: true });
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    await writeFile(excludePath, `${existing}${separator}.operator-studio/\n`, 'utf8');
    return excludePath;
  };

  const initializeSnapshot = async ({ source, target, missionId, repository }) => {
    await copyWorkspaceSnapshot(source, target);
    try {
      await git(['init'], target);
      await git(['config', 'core.longpaths', 'true'], target);
      await git(['config', 'user.name', 'Operator Studio'], target);
      await git(['config', 'user.email', 'operator-studio@local.invalid'], target);
      await git(['add', '-A'], target);
      await git(['commit', '--allow-empty', '-m', 'Operator Studio mission baseline'], target);
    } catch (cause) {
      const error = new Error(`无法为 Mission 创建独立 Git 基线：${cause.stderr || cause.message}`);
      error.code = 'WORKSPACE_GIT_INIT_FAILED';
      error.status = 503;
      throw error;
    }
    const metadata = {
      schemaVersion: 1,
      missionId,
      mode: 'managed-snapshot',
      repository: repository || null,
      source,
      workspace: target,
      createdAt: new Date().toISOString(),
    };
    await writeMetadata(target, metadata);
    return metadata;
  };

  const tryCreateWorktree = async ({ repository, target, missionId }) => {
    if (!repository || !path.isAbsolute(repository) || !await exists(repository)) return null;
    let repositoryRoot;
    try {
      repositoryRoot = (await git(['rev-parse', '--show-toplevel'], repository)).stdout.trim();
      if (!repositoryRoot) return null;
      await mkdir(path.dirname(target), { recursive: true });
      await git(['-C', repositoryRoot, 'worktree', 'add', '--detach', target, 'HEAD'], repositoryRoot);
    } catch {
      return null;
    }
    const metadata = {
      schemaVersion: 1,
      missionId,
      mode: 'git-worktree',
      repository: repositoryRoot,
      source: repositoryRoot,
      workspace: target,
      createdAt: new Date().toISOString(),
    };
    await writeMetadata(target, metadata);
    return metadata;
  };

  const inspect = async (target, { refresh = false } = {}) => {
    const cacheKey = await normalizePath(target);
    if (!refresh && inspectionCache.has(cacheKey)) return inspectionCache.get(cacheKey);
    if (!await exists(target)) {
      return { ready: false, code: 'WORKSPACE_MISSING', detail: 'Mission 工作区不存在。', workspace: target };
    }
    try {
      const topLevel = (await git(['rev-parse', '--show-toplevel'], target)).stdout.trim();
      if (await normalizePath(topLevel) !== await normalizePath(target)) {
        return { ready: false, code: 'WORKSPACE_GIT_BOUNDARY_INVALID', detail: 'Git 根目录与 Mission 工作区不一致。', workspace: target, gitRoot: topLevel };
      }
      const status = (await git(['status', '--porcelain=v1'], target)).stdout.split(/\r?\n/).filter(Boolean);
      const trackedFiles = (await git(['ls-files', '-z'], target)).stdout.split('\0').filter(Boolean);
      const head = await git(['rev-parse', '--short', 'HEAD'], target).then((result) => result.stdout.trim()).catch(() => null);
      const inspection = {
        ready: true,
        code: 'WORKSPACE_READY',
        workspace: target,
        gitRoot: topLevel,
        head,
        dirty: status.length > 0,
        changedFiles: status.length,
        trackedFiles: trackedFiles.length,
        baselineEmpty: trackedFiles.length === 0,
        metadata: await readMetadata(target),
      };
      inspectionCache.set(cacheKey, inspection);
      return inspection;
    } catch (cause) {
      return { ready: false, code: 'WORKSPACE_GIT_INVALID', detail: (cause.stderr || cause.message).trim(), workspace: target };
    }
  };

  const bootstrapRepository = async ({ target, source, ref = 'HEAD' }) => {
    const repositoryUrl = validateGitArgument(source, 'Git 仓库地址');
    const checkoutRef = String(ref || 'HEAD').trim() || 'HEAD';
    validateGitArgument(checkoutRef, 'Git 基线');
    if (!target || !path.isAbsolute(target)) {
      const error = new Error('Iteration Repository 必须是本机绝对路径。');
      error.code = 'ITERATION_REPOSITORY_PATH_INVALID';
      error.status = 400;
      throw error;
    }

    const targetExists = await exists(target);
    const entries = targetExists ? await readdir(target) : [];
    const hasGitDirectory = entries.some((name) => name.toLowerCase() === '.git');
    const nonGitEntries = entries.filter((name) => name.toLowerCase() !== '.git');

    try {
      if (!targetExists || (!hasGitDirectory && nonGitEntries.length === 0)) {
        await mkdir(path.dirname(target), { recursive: true });
        await git(['clone', '--', repositoryUrl, target], path.dirname(target), { timeout: 120_000 });
        if (checkoutRef !== 'HEAD') await git(['checkout', '--force', checkoutRef], target, { timeout: 60_000 });
      } else if (hasGitDirectory) {
        const inspection = await inspect(target, { refresh: true });
        if (!inspection.ready) {
          const error = new Error(inspection.detail || 'Iteration Repository 不是可用的 Git 仓库。');
          error.code = inspection.code || 'ITERATION_REPOSITORY_INVALID';
          error.status = 409;
          throw error;
        }
        if (inspection.dirty || !inspection.baselineEmpty) {
          const error = new Error('Iteration Repository 已包含代码或未提交变更，不能自动补齐基线。');
          error.code = 'ITERATION_REPOSITORY_NOT_EMPTY';
          error.status = 409;
          throw error;
        }
        const hasOrigin = await git(['remote', 'get-url', 'origin'], target).then(() => true).catch(() => false);
        if (hasOrigin) await git(['remote', 'set-url', 'origin', repositoryUrl], target);
        else await git(['remote', 'add', 'origin', repositoryUrl], target);
        if (checkoutRef === 'HEAD') await git(['fetch', 'origin'], target, { timeout: 120_000 });
        else await git(['fetch', 'origin', checkoutRef], target, { timeout: 120_000 });
        await git(['checkout', '--force', 'FETCH_HEAD'], target, { timeout: 60_000 });
        await git(['reset', '--hard', 'FETCH_HEAD'], target, { timeout: 60_000 });
      } else {
        const error = new Error('Iteration Repository 目录已包含非 Git 内容，不能自动拉取覆盖。');
        error.code = 'ITERATION_REPOSITORY_NOT_EMPTY';
        error.status = 409;
        throw error;
      }
    } catch (cause) {
      if (cause.status) throw cause;
      const error = new Error(`无法补齐 Iteration Repository：${cause.stderr?.trim() || cause.message}`);
      error.code = 'ITERATION_REPOSITORY_BOOTSTRAP_FAILED';
      error.status = 409;
      throw error;
    }

    const inspection = await inspect(target, { refresh: true });
    if (!inspection.ready || inspection.baselineEmpty) {
      const error = new Error(inspection.baselineEmpty ? '远端仓库没有可跟踪文件，不能作为 Mission 基线。' : (inspection.detail || '补齐后的仓库不可用。'));
      error.code = inspection.baselineEmpty ? 'ITERATION_REPOSITORY_REMOTE_EMPTY' : (inspection.code || 'ITERATION_REPOSITORY_INVALID');
      error.status = 409;
      throw error;
    }
    const origin = await git(['remote', 'get-url', 'origin'], target).then((result) => result.stdout.trim()).catch(() => repositoryUrl);
    inspectionCache.delete(await normalizePath(target));
    return { repository: inspection.gitRoot, origin, ref: checkoutRef, head: inspection.head, trackedFiles: inspection.trackedFiles, bootstrappedAt: new Date().toISOString() };
  };

  const ensure = async ({ missionId, target, repository, template, mode = 'auto' }) => {
    await mkdir(path.dirname(target), { recursive: true });
    if (await exists(target)) {
      const inspection = await inspect(target);
      if (inspection.ready) return inspection;
      const source = repository && path.isAbsolute(repository) && await exists(repository) ? repository : template;
      try {
        await git(['init'], target);
        await git(['config', 'core.longpaths', 'true'], target);
        await git(['config', 'user.name', 'Operator Studio'], target);
        await git(['config', 'user.email', 'operator-studio@local.invalid'], target);
        await git(['add', '-A'], target);
        await git(['commit', '--allow-empty', '-m', 'Operator Studio mission baseline'], target);
        await writeMetadata(target, { schemaVersion: 1, missionId, mode: 'managed-snapshot', repository: repository || null, source, workspace: target, createdAt: new Date().toISOString() });
        return inspect(target);
      } catch (cause) {
        const error = new Error(`Mission 工作区无法建立 Git 边界：${cause.stderr || cause.message}`);
        error.code = 'WORKSPACE_GIT_INIT_FAILED';
        error.status = 503;
        throw error;
      }
    }

    const worktree = mode === 'snapshot' ? null : await tryCreateWorktree({ repository, target, missionId });
    if (!worktree) {
      const source = repository && path.isAbsolute(repository) && await exists(repository) ? repository : template;
      await initializeSnapshot({ source, target, missionId, repository });
    }
    return inspect(target);
  };

  const captureDiff = async (target, { readOnly = false } = {}) => {
    const inspection = await inspect(target, { refresh: true });
    if (!inspection.ready) {
      const error = new Error(inspection.detail || 'Mission 工作区不可用。');
      error.code = inspection.code || 'WORKSPACE_UNAVAILABLE';
      error.status = 409;
      throw error;
    }
    // Intent-to-add makes newly created candidate files visible to git diff
    // without staging their contents or changing the candidate commit.
    if (!readOnly) await git(['add', '-N', '--', '.'], target).catch(() => {});
    const untrackedFiles = readOnly
      ? (await git(['ls-files', '--others', '--exclude-standard', '-z'], target)).stdout.split('\0').filter(Boolean).filter(file => !isGeneratedWorkspaceArtifact(file))
      : [];
    const nameOutput = (await git(['diff', '--name-only', '-z', '--no-ext-diff', 'HEAD'], target)).stdout;
    const rawChangedFiles = nameOutput.split('\0').map((file) => file.replaceAll('\\', '/')).filter(Boolean);
    const unsafeFiles = rawChangedFiles.filter((file) => path.isAbsolute(file) || file.split('/').includes('..') || file === '.git' || file.startsWith('.git/'));
    if (unsafeFiles.length) {
      const error = new Error(`候选 Diff 包含工作区边界外路径：${unsafeFiles.join(', ')}`);
      error.code = 'WORKSPACE_DIFF_PATH_INVALID';
      error.status = 409;
      throw error;
    }
    const changedFiles = rawChangedFiles.filter((file) => !isGeneratedWorkspaceArtifact(file));
    const diff = changedFiles.length
      ? (await git(['diff', '--binary', '--no-ext-diff', 'HEAD', '--', ...changedFiles], target)).stdout
      : '';
    return {
      workspace: target,
      changedFiles,
      diff,
      digest: `sha256:${createHash('sha256').update(diff).digest('hex')}`,
      dirty: changedFiles.length > 0,
      ...(readOnly ? { untrackedFiles, head: inspection.head } : {}),
    };
  };

  const inspectSources = async (sourceRoot, references = []) => {
    if (!sourceRoot || !await exists(sourceRoot)) return { ready: true, sourceRoot: sourceRoot || null, sources: [], references: [], errors: [] };
    const canonicalRoot = await normalizePath(sourceRoot);
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const sources = [];
    const errors = [];
    for (const entry of entries) {
      if (isAcquiringSourceDirectory(entry.name)) continue;
      if (!entry.isDirectory()) {
        errors.push({ code: 'SOURCE_ROOT_ENTRY_INVALID', source: entry.name, detail: 'Source Registry 根目录只允许包含独立 Git 仓库目录。' });
        continue;
      }
      const sourcePath = path.join(sourceRoot, entry.name);
      const canonicalSource = await normalizePath(sourcePath);
      if (!canonicalSource.startsWith(`${canonicalRoot}/`)) {
        errors.push({ code: 'SOURCE_PATH_OUTSIDE_REGISTRY', source: entry.name, detail: '来源目录超出 Source Registry 边界。' });
        continue;
      }
      try {
        const gitRoot = (await git(['rev-parse', '--show-toplevel'], sourcePath)).stdout.trim();
        if (await normalizePath(gitRoot) !== canonicalSource) throw new Error('来源目录不是独立 Git 根目录。');
        const [head, tree] = await Promise.all([
          git(['rev-parse', 'HEAD'], sourcePath).then((result) => result.stdout.trim()),
          git(['rev-parse', 'HEAD^{tree}'], sourcePath).then((result) => result.stdout.trim()),
        ]);
        const status = (await git(['status', '--porcelain=v1'], sourcePath)).stdout.split(/\r?\n/).filter(Boolean);
        const transportRepository = await git(['config', '--get', 'remote.origin.url'], sourcePath).then((result) => result.stdout.trim()).catch(() => '');
        const configuredTransport = await git(['config', '--get', 'operatorStudio.transportRepository'], sourcePath).then((result) => result.stdout.trim()).catch(() => '');
        const canonicalRepository = await git(['config', '--get', 'operatorStudio.canonicalRepository'], sourcePath).then((result) => result.stdout.trim()).catch(() => transportRepository);
        const recordedTree = await git(['config', '--get', 'operatorStudio.sourceTree'], sourcePath).then((result) => result.stdout.trim()).catch(() => tree);
        if (configuredTransport && normalizeRepositoryIdentity(configuredTransport) !== normalizeRepositoryIdentity(transportRepository)) {
          throw new Error('Source transport metadata 与 Git origin 不一致。');
        }
        // 登记的 tree pin 与当前 HEAD tree 不一致 = 来源内容被改过（可能是别处提交的，工作区反而是干净的）。
        // 这必须与「不是独立 Git 根 / 元数据与 origin 不一致」这类结构性故障分开：前者证明「仓库结构没坏、
        // 内容换了」，是修改证据；后者只说明无法核验。混成一个码会让上游无法区分「被改」与「看不懂」。
        if (recordedTree && recordedTree !== tree) {
          const mismatch = new Error('Source tree metadata 与当前 HEAD tree 不一致。');
          mismatch.code = 'SOURCE_REPOSITORY_TREE_MISMATCH';
          mismatch.recordedTree = recordedTree;
          mismatch.tree = tree;
          throw mismatch;
        }
        const changedFiles = status.map((line) => line.slice(3).trim());
        // `git status` 非空不等于「被改过」：克隆/检出中断时 index 从未写入（`.git/index` 不存在），
        // HEAD tree 里的每个文件都会被读成删除——几千条 `D`。这证明不了上游改过任何东西，
        // 只能说明这个目录读不出可信内容。两者必须分开报，否则就是拿本地网络故障去指控上游来源被篡改。
        const checkoutIncomplete = status.length > 0
          && (await git(['ls-files'], sourcePath)).stdout.split(/\r?\n/).filter(Boolean).length === 0;
        const transportMode = normalizeRepositoryIdentity(canonicalRepository) === normalizeRepositoryIdentity(transportRepository) ? 'canonical' : 'mirror';
        sources.push({
          id: entry.name,
          path: sourcePath,
          repository: canonicalRepository,
          canonicalRepository,
          transportRepository,
          transportMode,
          mirrorVerified: transportMode === 'mirror',
          commit: head,
          tree,
          clean: status.length === 0,
          // 检出未完成时不上报 changedFiles：那不是变更清单，UI 照它渲染会显示「N 个未提交变更」。
          checkoutIncomplete,
          changedFiles: checkoutIncomplete ? [] : changedFiles,
        });
        if (checkoutIncomplete) {
          errors.push({ code: 'SOURCE_REPOSITORY_CHECKOUT_INCOMPLETE', source: entry.name, detail: `来源目录的 Git index 为空（检出未完成），无法作为固定引用核验；这不表示来源内容被改过。` });
        } else if (status.length) {
          errors.push({ code: 'SOURCE_REPOSITORY_DIRTY', source: entry.name, detail: `第三方来源包含 ${status.length} 个未提交变更，不能作为固定引用。`, changedFiles });
        }
      } catch (cause) {
        const mismatch = cause.code === 'SOURCE_REPOSITORY_TREE_MISMATCH';
        errors.push({
          code: mismatch ? 'SOURCE_REPOSITORY_TREE_MISMATCH' : 'SOURCE_REPOSITORY_INVALID',
          source: entry.name,
          detail: cause.stderr?.trim() || cause.message,
          // 只有 tree pin 不一致才带上两棵树：它们是「内容被改过」的直接证据，而不是「读不出来」。
          ...(mismatch ? { recordedTree: cause.recordedTree, tree: cause.tree } : {}),
        });
      }
    }
    const verifiedReferences = await Promise.all((references || []).map(async (reference) => {
      const repositoryIdentity = normalizeRepositoryIdentity(reference.repository);
      const source = sources.find((item) => repositoryIdentity && normalizeRepositoryIdentity(item.repository) === repositoryIdentity);
      if (!source) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_REPOSITORY_MISSING', detail: '引用的上游仓库未登记在 Source Registry。' };
      const referenceCommit = String(reference.commit || '').trim().toLowerCase();
      const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(referenceCommit);
      const commitMatches = source.transportMode === 'mirror'
        ? fullCommit && source.commit.toLowerCase() === referenceCommit
        : Boolean(referenceCommit) && (source.commit.toLowerCase() === referenceCommit || source.commit.toLowerCase().startsWith(referenceCommit));
      if (!commitMatches) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_COMMIT_MISMATCH', detail: `引用 Commit 与 Source Registry 当前 HEAD 不一致（${source.commit.slice(0, 12)}）。` };
      const relativePath = String(reference.path || '').replaceAll('\\', '/').replace(/^\.\//, '');
      // 引用有两个正式的 scope，必须显式判定，不能靠 path 恰好为空来碰巧表达：
      //  - file：指向仓库内一个相对文件路径（默认）。
      //  - repository：仓库级引用，断言「这个仓库在这个 commit 上」，不指向任何文件。它的身份
      //    与 sources 条目本身一致，因此不需要、也不允许再做路径解析。
      // 未声明 scope 时按 path 推断：只有空路径能推断成仓库级（候选自报来源允许只给仓库+commit）。
      const declaredScope = reference.scope === undefined || reference.scope === null ? null : String(reference.scope).trim().toLowerCase();
      if (declaredScope !== null && declaredScope !== 'file' && declaredScope !== 'repository') {
        return { ...reference, verified: false, code: 'SOURCE_REFERENCE_SCOPE_INVALID', detail: '来源引用的 scope 只能是 file 或 repository。' };
      }
      const referenceScope = declaredScope ?? (relativePath ? 'file' : 'repository');
      if (referenceScope === 'repository') {
        return {
          ...reference,
          scope: 'repository',
          path: '',
          verified: true,
          sourceId: source.id,
          resolvedCommit: source.commit,
          resolvedTree: source.tree,
          canonicalRepository: source.canonicalRepository,
          transportRepository: source.transportRepository,
          transportMode: source.transportMode,
          mirrorVerified: source.mirrorVerified,
        };
      }
      if (!relativePath) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_PATH_INVALID', detail: 'file 级来源引用必须使用仓库内相对路径。' };
      if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_PATH_INVALID', detail: '来源引用必须使用仓库内相对路径。' };
      const referencedPath = path.resolve(source.path, relativePath);
      const contained = referencedPath === path.resolve(source.path) || referencedPath.startsWith(`${path.resolve(source.path)}${path.sep}`);
      const [referenceInfo, resolvedReference, resolvedSource] = await Promise.all([
        lstat(referencedPath).catch(() => null),
        realpath(referencedPath).catch(() => null),
        realpath(source.path).catch(() => null),
      ]);
      const realContained = resolvedReference && resolvedSource && (resolvedReference === resolvedSource || resolvedReference.startsWith(`${resolvedSource}${path.sep}`));
      if (!contained || !referenceInfo?.isFile() || referenceInfo.isSymbolicLink() || !realContained) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_PATH_MISSING', detail: '来源引用路径不存在、是符号链接或超出仓库边界。' };
      return {
        ...reference,
        scope: 'file',
        verified: true,
        sourceId: source.id,
        resolvedCommit: source.commit,
        resolvedTree: source.tree,
        canonicalRepository: source.canonicalRepository,
        transportRepository: source.transportRepository,
        transportMode: source.transportMode,
        mirrorVerified: source.mirrorVerified,
      };
    }));
    errors.push(...verifiedReferences.filter((reference) => !reference.verified).map((reference) => ({ code: reference.code, source: reference.repository, detail: reference.detail })));
    return { ready: errors.length === 0, sourceRoot, sources, references: verifiedReferences, errors };
  };

  const updateSourceRegistry = async ({ sourceRoot, runtimeRoot, missionId, references = [] }) => {
    if (!sourceRoot || !runtimeRoot) return { schemaVersion: 2, sources: [] };
    const inspection = await inspectSources(sourceRoot, references);
    const registryPath = path.join(runtimeRoot, 'source-registry.json');
    let registry = { schemaVersion: 2, sources: [] };
    try { registry = JSON.parse(await readFile(registryPath, 'utf8')); } catch { /* initialize below */ }
    const byKey = new Map((registry.sources || []).map((source) => [`${source.repository || source.id}@${source.commit || ''}`, source]));
    for (const source of inspection.sources) {
      const key = `${source.repository || source.id}@${source.commit || ''}`;
      byKey.set(key, { ...byKey.get(key), ...source, lastUsedByMission: missionId || null, updatedAt: new Date().toISOString() });
    }
    for (const reference of inspection.references.filter((item) => item.verified)) {
      const key = `${reference.repository}@${reference.resolvedCommit || reference.commit}`;
      // 仓库级引用没有文件路径可记：它由 referencedRepositoryLevel 标记，referencedPaths 只收
      // file 级引用。只在为真时写入，避免后续的 file 级引用把已有标记覆盖掉。
      const repositoryLevel = reference.scope === 'repository' ? { referencedRepositoryLevel: true } : {};
      byKey.set(key, { ...byKey.get(key), repository: reference.repository, commit: reference.resolvedCommit || reference.commit, lastUsedByMission: missionId || null, ...repositoryLevel, referencedPaths: [...new Set([...(byKey.get(key)?.referencedPaths || []), reference.path].filter(Boolean))], updatedAt: new Date().toISOString() });
    }
    const next = { schemaVersion: 2, sources: [...byKey.values()] };
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  };

  const adoptPatch = async ({ repository, patchPath, candidateId, expectedHead = null }) => {
    if (!repository || !path.isAbsolute(repository) || !await exists(repository)) {
      const error = new Error('Iteration Repository 不存在或不是本机绝对路径。');
      error.code = 'ITERATION_REPOSITORY_UNAVAILABLE';
      error.status = 409;
      throw error;
    }
    const inspection = await inspect(repository, { refresh: true });
    if (!inspection.ready) {
      const error = new Error(inspection.detail || 'Iteration Repository 不是可用的独立 Git 仓库。');
      error.code = inspection.code || 'ITERATION_REPOSITORY_INVALID';
      error.status = 409;
      throw error;
    }
    if (inspection.dirty) {
      const error = new Error('Iteration Repository 存在未提交变更，不能自动采用 Candidate。');
      error.code = 'ITERATION_REPOSITORY_DIRTY';
      error.status = 409;
      throw error;
    }
    const head = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();
    if (expectedHead && head !== expectedHead) {
      const error = new Error('Iteration Repository HEAD 已偏离 Mission 基线，必须重新建立 Snapshot。');
      error.code = 'ITERATION_REPOSITORY_BASELINE_DIVERGED';
      error.status = 409;
      throw error;
    }
    let applied = false;
    try {
      const alreadyApplied = await git(['apply', '--reverse', '--check', '--binary', patchPath], repository)
        .then(() => true)
        .catch(() => false);
      if (alreadyApplied) {
        return { repository, candidateId, previousHead: head, commit: head, adoptedAt: new Date().toISOString(), alreadyApplied: true };
      }
      await git(['apply', '--check', '--binary', patchPath], repository);
      await git(['apply', '--binary', patchPath], repository);
      applied = true;
      await git(['add', '-A'], repository);
      await git(['commit', '-m', `Operator Studio adopt ${candidateId}`], repository);
    } catch (cause) {
      await git(['reset'], repository).catch(() => {});
      if (applied) await git(['apply', '--reverse', '--binary', patchPath], repository).catch(() => {});
      const error = new Error(`Candidate Patch 无法安全应用到 Iteration Repository：${cause.stderr?.trim() || cause.message}`);
      error.code = 'ITERATION_REPOSITORY_PATCH_REJECTED';
      error.status = 409;
      throw error;
    }
    const commit = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();
    inspectionCache.delete(await normalizePath(repository));
    return { repository, candidateId, previousHead: head, commit, adoptedAt: new Date().toISOString() };
  };

  const applyWorkspacePatch = async ({ repository, patch }) => {
    if (!repository || !path.isAbsolute(repository) || !await exists(repository)) {
      const error = new Error('Mission Workspace 不存在或不是本机绝对路径。');
      error.code = 'MISSION_WORKSPACE_UNAVAILABLE';
      error.status = 409;
      throw error;
    }
    const text = String(patch || '');
    if (!text.trim()) {
      const error = new Error('Agent 返回的 Patch 为空。');
      error.code = 'AGENT_PATCH_EMPTY';
      error.status = 400;
      throw error;
    }
    const paths = [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1].trim().replaceAll('\\', '/'));
    if (!paths.length || paths.some((value) => !value || value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.split('/').includes('..'))) {
      const error = new Error('Agent Patch 包含缺失、绝对路径或越界路径。');
      error.code = 'AGENT_PATCH_PATH_INVALID';
      error.status = 400;
      throw error;
    }
    const patchPath = path.join(repository, `.operator-studio-agent-${process.pid}-${Date.now()}.patch`);
    await writeFile(patchPath, text, 'utf8');
    try {
      // Agent-produced unified diffs occasionally contain correct hunks with
      // stale line counts after JSON rendering. Git can safely recalculate
      // those counts while retaining the actual context and path checks.
      await git(['apply', '--recount', '--check', '--binary', patchPath], repository);
      await git(['apply', '--recount', '--binary', patchPath], repository);
      inspectionCache.delete(await normalizePath(repository));
      return { files: [...new Set(paths)] };
    } finally {
      await rm(patchPath, { force: true }).catch(() => {});
    }
  };

  const revertAdoption = async ({ repository, commit }) => {
    const inspection = await inspect(repository, { refresh: true });
    if (!inspection.ready || inspection.dirty) {
      const error = new Error(inspection.dirty ? 'Iteration Repository 存在未提交变更，不能自动回退。' : inspection.detail);
      error.code = inspection.dirty ? 'ITERATION_REPOSITORY_DIRTY' : (inspection.code || 'ITERATION_REPOSITORY_INVALID');
      error.status = 409;
      throw error;
    }
    try {
      await git(['cat-file', '-e', `${commit}^{commit}`], repository);
      await git(['revert', '--no-edit', commit], repository);
    } catch (cause) {
      await git(['revert', '--abort'], repository).catch(() => {});
      const error = new Error(`无法生成采用回退提交：${cause.stderr?.trim() || cause.message}`);
      error.code = 'ITERATION_REPOSITORY_REVERT_FAILED';
      error.status = 409;
      throw error;
    }
    const revertCommit = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();
    inspectionCache.delete(await normalizePath(repository));
    return { repository, revertedCommit: commit, revertCommit, revertedAt: new Date().toISOString() };
  };

  return { ensure, inspect, bootstrapRepository, importSourceRepository, captureDiff, inspectSources, updateSourceRegistry, adoptPatch, applyWorkspacePatch, revertAdoption, excludeProjectRuntime, git, snapshotGit: importGit };
}

export const workspaceManager = createWorkspaceManager();
