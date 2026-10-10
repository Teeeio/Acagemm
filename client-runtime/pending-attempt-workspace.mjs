import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, contentDigest, assertPackagePath } from './execution-package-contract.mjs';

const fail = message => Object.assign(new Error(message), { code: 'PENDING_ATTEMPT_WORKSPACE_CHANGED', status: 409 });
const exists = async target => { try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const plainDirectories = async target => {
  let cursor = path.parse(target).root;
  for (const part of path.relative(cursor, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await exists(cursor);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw fail('新任务路径不能经过链接或普通文件。');
  }
};
const regularBytes = async file => {
  await plainDirectories(path.dirname(file));
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8 * 1024 * 1024) throw fail('新任务文件不符合安全读取要求。');
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1) throw fail('新任务文件在读取期间变化。');
  return bytes;
};
const overlap = (a, b) => {
  const contains = (p, c) => { const rel = path.relative(p, c); return !rel || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
  return contains(a, b) || contains(b, a);
};

// Publish a fresh complete Mission directory atomically. Interrupted staging
// directories are retained for diagnosis; an existing destination is never repaired.
export const createPendingAttemptWorkspace = ({ readPendingCandidate, workspaceForMission, git }) => {
  const context = async intent => {
    const bundle = await readPendingCandidate(intent.pending);
    if (bundle.manifestDigest !== intent.origin.manifestDigest || bundle.manifest.missionId !== intent.origin.missionId) throw fail('冻结来源与新尝试不一致。');
    const workspace = workspaceForMission(intent.mission);
    if (!path.isAbsolute(workspace) || path.basename(workspace) !== 'repository') throw fail('新任务工作区路径无效。');
    const directory = path.dirname(workspace);
    if (overlap(directory, bundle.manifest.workspace)) throw fail('新工作区必须与原工作区隔离。');
    await plainDirectories(directory);
    const identity = { schemaVersion: 'operator-studio.attempt-workspace/v1', missionId: intent.mission.id,
      origin: intent.origin, files: bundle.manifest.files, workspace };
    return { bundle, workspace, directory, identity };
  };
  const inspect = async intent => {
    const { bundle, workspace, directory, identity } = await context(intent);
    if (!await exists(directory)) return null;
    const record = JSON.parse((await regularBytes(path.join(directory, 'attempt.json'))).toString('utf8'));
    if (canonicalJson(record.identity) !== canonicalJson(identity)) throw fail('目标目录已被其他任务占用。');
    const actual = [];
    const walk = async (dir, prefix = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('Git 边界无效。');
          continue;
        }
        if (entry.isSymbolicLink()) throw fail('新任务工作区含有链接。');
        const name = prefix + entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/');
        else actual.push(name);
      }
    };
    await walk(workspace);
    if (canonicalJson(actual.sort()) !== canonicalJson(bundle.files.map(file => file.path).sort())) throw fail('新任务文件集合已变化。');
    for (const file of bundle.files) {
      const bytes = await regularBytes(path.join(workspace, file.path));
      if (bytes.length !== file.size || contentDigest(bytes) !== file.digest) throw fail('新任务源码已变化，不能重放创建。');
    }
    const head = (await git(['rev-parse', 'HEAD'], workspace)).stdout.trim();
    const status = (await git(['status', '--porcelain', '--untracked-files=all'], workspace)).stdout.trim();
    if (head !== record.head || status) throw fail('新任务 Git 基线已变化。');
    return { workspace, head, manifestDigest: bundle.manifestDigest, missionId: intent.mission.id };
  };
  const prepare = async intent => {
    const previous = await inspect(intent);
    if (previous) return previous;
    const { bundle, workspace, directory, identity } = await context(intent);
    await mkdir(path.dirname(directory), { recursive: true });
    await plainDirectories(path.dirname(directory));
    const stage = `${directory}.prepare-${randomUUID()}`;
    const repository = path.join(stage, 'repository');
    await mkdir(stage); await mkdir(repository);
    for (const file of bundle.files) {
      assertPackagePath(file.path);
      const target = path.join(repository, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(file.content, 'base64');
      if (contentDigest(bytes) !== file.digest || bytes.length !== file.size) throw fail('冻结源码校验失败。');
      const handle = await open(target, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    await git(['init', '--template='], repository);
    await git(['config', 'core.longpaths', 'true'], repository);
    await git(['config', 'core.autocrlf', 'false'], repository);
    await git(['config', 'core.hooksPath', '.git/no-hooks'], repository);
    await git(['config', 'user.name', 'Operator Studio'], repository);
    await git(['config', 'user.email', 'operator-studio@local.invalid'], repository);
    await mkdir(path.join(repository, '.git', 'info'), { recursive: true });
    await writeFile(path.join(repository, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
    const index = [];
    for (const file of bundle.files) {
      const hash = (await git(['hash-object', '-w', '--no-filters', '--', file.path], repository)).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(hash)) throw fail('无法创建冻结源码对象。');
      index.push(`100644 ${hash}\t${file.path}\0`);
    }
    await git(['update-index', '-z', '--index-info'], repository, index.join(''));
    const tree = (await git(['write-tree'], repository)).stdout.trim();
    const commit = (await git(['commit-tree', tree, '-m', 'Initial sources from frozen candidate'], repository)).stdout.trim();
    await git(['update-ref', 'HEAD', commit], repository);
    const head = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();
    await writeFile(path.join(stage, 'workspace.json'), JSON.stringify({ schemaVersion: 1, missionId: intent.mission.id,
      mode: 'managed-snapshot', repository: intent.mission.repository, workspace, source: null, createdAt: intent.origin.createdAt }));
    await writeFile(path.join(stage, 'attempt.json'), JSON.stringify({ identity, head }));
    await plainDirectories(path.dirname(directory));
    if (await exists(directory)) throw fail('目标目录在准备期间出现，保留双方目录供检查。');
    await rename(stage, directory);
    return inspect(intent);
  };
  return Object.freeze({ prepare, inspect });
};
