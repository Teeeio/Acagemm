import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const normalize = (value) => value.replaceAll('\\', '/');

const collectFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) files.push(normalize(path.relative(root, absolute)));
  }
  return files.sort();
};

const fileMap = async (root) => {
  const files = await collectFiles(root);
  const result = new Map();
  for (const file of files) {
    const content = await readFile(path.join(root, file));
    result.set(file, createHash('sha256').update(content).digest('hex'));
  }
  return result;
};

const diffText = async (root, checkpoint, files) => {
  const chunks = [];
  for (const file of files) {
    const beforePath = path.join(checkpoint, file);
    const afterPath = path.join(root, file);
    let before = '';
    let after = '';
    try { before = await readFile(beforePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { after = await readFile(afterPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before === after) continue;
    chunks.push(`--- a/${file}\n+++ b/${file}\n@@\n-${before}+${after}`);
  }
  return chunks.join('\n');
};

export const createWorkspaceCheckpoint = async ({ workspaceRoot, checkpointRoot }) => {
  await stat(workspaceRoot);
  await rm(checkpointRoot, { recursive: true, force: true });
  await mkdir(checkpointRoot, { recursive: true });
  await cp(workspaceRoot, checkpointRoot, { recursive: true, force: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) });
  return { workspaceRoot, checkpointRoot, files: await collectFiles(checkpointRoot) };
};

export const captureWorkspaceDiff = async ({ workspaceRoot, checkpointRoot }) => {
  const before = await fileMap(checkpointRoot);
  const after = await fileMap(workspaceRoot);
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
  if (!changedFiles.length) return { dirty: false, changedFiles: [], digest: null, diff: '' };
  const diff = await diffText(workspaceRoot, checkpointRoot, changedFiles);
  const digest = `sha256:${createHash('sha256').update(JSON.stringify({ changedFiles, before: [...before], after: [...after], diff })).digest('hex')}`;
  return { dirty: true, changedFiles, digest, diff };
};

export const admitCandidateDiff = async ({ workspaceRoot, checkpointRoot, previousDigests = [] }) => {
  const manifest = await captureWorkspaceDiff({ workspaceRoot, checkpointRoot });
  if (!manifest.dirty) return { admitted: false, reason: 'no_candidate_diff', manifest };
  if (previousDigests.includes(manifest.digest)) return { admitted: false, reason: 'repeated_candidate_diff', manifest };
  return { admitted: true, reason: 'workspace_diff_verified', manifest };
};
