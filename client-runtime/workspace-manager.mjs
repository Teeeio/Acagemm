import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createScopedGitEnvironment } from './git-environment.mjs';

const defaultGitTimeoutMs = 20_000;

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

const execFileAsync = (execFileImpl, command, args, options = {}) => new Promise((resolve, reject) => {
  execFileImpl(command, args, {
    ...options,
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
});

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

  const captureDiff = async (target) => {
    const inspection = await inspect(target, { refresh: true });
    if (!inspection.ready) {
      const error = new Error(inspection.detail || 'Mission 工作区不可用。');
      error.code = inspection.code || 'WORKSPACE_UNAVAILABLE';
      error.status = 409;
      throw error;
    }
    // Intent-to-add makes newly created candidate files visible to git diff
    // without staging their contents or changing the candidate commit.
    await git(['add', '-N', '--', '.'], target).catch(() => {});
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
    };
  };

  const inspectSources = async (sourceRoot, references = []) => {
    if (!sourceRoot || !await exists(sourceRoot)) return { ready: true, sourceRoot: sourceRoot || null, sources: [], references: [], errors: [] };
    const canonicalRoot = await normalizePath(sourceRoot);
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const sources = [];
    const errors = [];
    for (const entry of entries) {
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
        const head = (await git(['rev-parse', 'HEAD'], sourcePath)).stdout.trim();
        const status = (await git(['status', '--porcelain=v1'], sourcePath)).stdout.split(/\r?\n/).filter(Boolean);
        const repository = await git(['remote', 'get-url', 'origin'], sourcePath).then((result) => result.stdout.trim()).catch(() => '');
        sources.push({ id: entry.name, path: sourcePath, repository, commit: head, clean: status.length === 0, changedFiles: status.map((line) => line.slice(3).trim()) });
        if (status.length) errors.push({ code: 'SOURCE_REPOSITORY_DIRTY', source: entry.name, detail: `第三方来源包含 ${status.length} 个未提交变更，不能作为固定引用。`, changedFiles: status.map((line) => line.slice(3).trim()) });
      } catch (cause) {
        errors.push({ code: 'SOURCE_REPOSITORY_INVALID', source: entry.name, detail: cause.stderr?.trim() || cause.message });
      }
    }
    const verifiedReferences = await Promise.all((references || []).map(async (reference) => {
      const repositoryIdentity = normalizeRepositoryIdentity(reference.repository);
      const source = sources.find((item) => repositoryIdentity && normalizeRepositoryIdentity(item.repository) === repositoryIdentity);
      if (!source) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_REPOSITORY_MISSING', detail: '引用的上游仓库未登记在 Source Registry。' };
      if (!reference.commit || !(source.commit === reference.commit || source.commit.startsWith(reference.commit))) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_COMMIT_MISMATCH', detail: `引用 Commit 与 Source Registry 当前 HEAD 不一致（${source.commit.slice(0, 12)}）。` };
      const relativePath = String(reference.path || '').replaceAll('\\', '/').replace(/^\.\//, '');
      if (!relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_PATH_INVALID', detail: '来源引用必须使用仓库内相对路径。' };
      const referencedPath = path.resolve(source.path, relativePath);
      const contained = referencedPath === path.resolve(source.path) || referencedPath.startsWith(`${path.resolve(source.path)}${path.sep}`);
      if (!contained || !await exists(referencedPath)) return { ...reference, verified: false, code: 'SOURCE_REFERENCE_PATH_MISSING', detail: '来源引用路径不存在或超出仓库边界。' };
      return { ...reference, verified: true, sourceId: source.id, resolvedCommit: source.commit };
    }));
    errors.push(...verifiedReferences.filter((reference) => !reference.verified).map((reference) => ({ code: reference.code, source: reference.repository, detail: reference.detail })));
    return { ready: errors.length === 0, sourceRoot, sources, references: verifiedReferences, errors };
  };

  const updateSourceRegistry = async ({ sourceRoot, runtimeRoot, missionId, references = [] }) => {
    if (!sourceRoot || !runtimeRoot) return { schemaVersion: 1, sources: [] };
    const inspection = await inspectSources(sourceRoot, references);
    const registryPath = path.join(runtimeRoot, 'source-registry.json');
    let registry = { schemaVersion: 1, sources: [] };
    try { registry = JSON.parse(await readFile(registryPath, 'utf8')); } catch { /* initialize below */ }
    const byKey = new Map((registry.sources || []).map((source) => [`${source.repository || source.id}@${source.commit || ''}`, source]));
    for (const source of inspection.sources) {
      const key = `${source.repository || source.id}@${source.commit || ''}`;
      byKey.set(key, { ...byKey.get(key), ...source, lastUsedByMission: missionId || null, updatedAt: new Date().toISOString() });
    }
    for (const reference of inspection.references.filter((item) => item.verified)) {
      const key = `${reference.repository}@${reference.resolvedCommit || reference.commit}`;
      byKey.set(key, { ...byKey.get(key), repository: reference.repository, commit: reference.resolvedCommit || reference.commit, lastUsedByMission: missionId || null, referencedPaths: [...new Set([...(byKey.get(key)?.referencedPaths || []), reference.path].filter(Boolean))], updatedAt: new Date().toISOString() });
    }
    const next = { schemaVersion: 1, sources: [...byKey.values()] };
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

  return { ensure, inspect, bootstrapRepository, captureDiff, inspectSources, updateSourceRegistry, adoptPatch, revertAdoption, excludeProjectRuntime, git };
}

export const workspaceManager = createWorkspaceManager();
