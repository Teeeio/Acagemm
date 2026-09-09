import { execFile } from 'node:child_process';
import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertPackagePath } from './execution-package-contract.mjs';

const execFileAsync = promisify(execFile);
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 422, retryable: false, details });

const relativePackagePath = (root, file) => {
  const relative = path.relative(root, file).split(path.sep).join('/');
  assertPackagePath(relative);
  return relative;
};

const collectDirectory = async (sourcePath, { ignore = ['.git'] } = {}) => {
  let root;
  try {
    const sourceInfo = await lstat(sourcePath);
    if (sourceInfo.isSymbolicLink()) throw fail('PACKAGE_SOURCE_UNSAFE', 'Operator source root may not be a symlink.');
    root = await realpath(sourcePath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw fail('PACKAGE_SOURCE_NOT_FOUND', 'Operator source directory does not exist.', { sourcePath, cause: error.code });
    throw error;
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('PACKAGE_SOURCE_INVALID', 'Operator source must be a real directory.');
  const ignored = new Set(ignore);
  const files = {};
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const info = await lstat(full);
      if (info.isDirectory()) continue;
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
        throw fail('PACKAGE_SOURCE_UNSAFE', 'Source directories may contain regular files only; symlinks and hardlinks are rejected.', { path: relativePackagePath(root, full) });
      }
      files[relativePackagePath(root, full)] = { encoding: 'base64', content: (await readFile(full)).toString('base64') };
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const info = await lstat(full);
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(full);
    }
  };
  await walk(root);
  if (!Object.keys(files).length) throw fail('PACKAGE_SOURCE_EMPTY', 'Operator source directory contains no regular files.');
  return { files, sourceType: 'directory', sourcePath: root };
};

const normalizeArchiveName = (name) => {
  let normalized = String(name).replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (!normalized || normalized.endsWith('/')) return null;
  assertPackagePath(normalized);
  return normalized;
};

const archiveExtension = (archivePath) => /[.]zip$/i.test(String(archivePath)) ? 'zip' : 'tar';

const collectTarArchive = async (archive, tarCommand) => {
  let listing;
  let verbose;
  try {
    ({ stdout: listing } = await execFileAsync(tarCommand, ['-tf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    ({ stdout: verbose } = await execFileAsync(tarCommand, ['-tvf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) { throw fail('PACKAGE_ARCHIVE_INVALID', 'Archive listing failed; the archive is not readable by tar.', { cause: error.code || 'TAR_FAILED' }); }
  for (const line of String(verbose).split(/\r?\n/)) {
    if (line && !['-', 'd'].includes(line[0])) throw fail('PACKAGE_SOURCE_UNSAFE', 'Archives may contain regular files and directories only.');
  }
  // Keep the normalized package path for identity, but retain the exact
  // archive member spelling for extraction. GNU tar on POSIX commonly emits
  // `./run.py`; extracting `run.py` would fail even though the listing passed.
  const archiveMembers = new Map();
  for (const rawName of String(listing).split(/\r?\n/)) {
    const name = normalizeArchiveName(rawName);
    if (!name) continue;
    const previous = archiveMembers.get(name);
    if (previous) throw fail('PACKAGE_SOURCE_UNSAFE', 'Archive contains duplicate or colliding normalized paths.', { path: name });
    archiveMembers.set(name, rawName);
  }
  const names = [...archiveMembers.keys()].sort();
  if (!names.length) throw fail('PACKAGE_SOURCE_EMPTY', 'Operator archive contains no regular files.');
  const files = {};
  try {
    for (const name of names) {
      const { stdout } = await execFileAsync(tarCommand, ['-xOf', archive, archiveMembers.get(name)], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      files[name] = { encoding: 'base64', content: Buffer.from(stdout).toString('base64') };
    }
  } catch (error) { throw fail('PACKAGE_ARCHIVE_INVALID', 'Archive file extraction failed.', { cause: error.code || 'TAR_FAILED' }); }
  return files;
};

const collectZipArchive = async (archive, unzipCommand) => {
  let listing;
  let verbose;
  try {
    // `-Z1` is the stable machine-readable name listing supported by
    // Info-ZIP/unzip on Linux and the Git-for-Windows distribution. The
    // verbose listing is used only to reject links/devices before extraction.
    ({ stdout: listing } = await execFileAsync(unzipCommand, ['-Z1', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    ({ stdout: verbose } = await execFileAsync(unzipCommand, ['-Z', '-v', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) { throw fail('PACKAGE_ARCHIVE_INVALID', 'ZIP listing failed; install a compatible unzip/bsdtar tool or provide an explicit command.', { cause: error.code || 'UNZIP_FAILED' }); }
  if (/symbolic\s+link|hard\s+link|block\s+special|character\s+special|fifo|socket/i.test(String(verbose))
    || /Unix file attributes \([^)]*\):\s*[lbcps]/i.test(String(verbose))) {
    throw fail('PACKAGE_SOURCE_UNSAFE', 'Archives may contain regular files and directories only.');
  }
  const archiveMembers = new Map();
  for (const rawName of String(listing).split(/\r?\n/)) {
    const name = normalizeArchiveName(rawName);
    if (!name) continue;
    if (archiveMembers.has(name)) throw fail('PACKAGE_SOURCE_UNSAFE', 'Archive contains duplicate or colliding normalized paths.', { path: name });
    archiveMembers.set(name, rawName);
  }
  const names = [...archiveMembers.keys()].sort();
  if (!names.length) throw fail('PACKAGE_SOURCE_EMPTY', 'Operator archive contains no regular files.');
  const files = {};
  try {
    for (const name of names) {
      const { stdout } = await execFileAsync(unzipCommand, ['-p', archive, archiveMembers.get(name)], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      files[name] = { encoding: 'base64', content: Buffer.from(stdout).toString('base64') };
    }
  } catch (error) { throw fail('PACKAGE_ARCHIVE_INVALID', 'ZIP file extraction failed.', { cause: error.code || 'UNZIP_FAILED' }); }
  return files;
};

const collectArchive = async (archivePath, { tarCommand = 'tar', unzipCommand = 'unzip' } = {}) => {
  let archive;
  try {
    const sourceInfo = await lstat(archivePath);
    if (sourceInfo.isSymbolicLink()) throw fail('PACKAGE_SOURCE_UNSAFE', 'Operator archive may not be a symlink.');
    archive = await realpath(archivePath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw fail('PACKAGE_SOURCE_NOT_FOUND', 'Operator archive does not exist.', { sourcePath: archivePath, cause: error.code });
    throw error;
  }
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw fail('PACKAGE_SOURCE_UNSAFE', 'Operator archive must be a regular file.');
  const kind = archiveExtension(archive);
  let files;
  if (kind === 'zip') {
    // bsdtar (Windows and some Linux distributions) can read ZIP directly;
    // GNU tar generally cannot. Try tar first, then the portable unzip CLI.
    try { files = await collectTarArchive(archive, tarCommand); }
    catch (tarError) {
      if (tarError?.code !== 'PACKAGE_ARCHIVE_INVALID') throw tarError;
      try { files = await collectZipArchive(archive, unzipCommand); }
      catch (unzipError) {
        if (unzipError?.code !== 'PACKAGE_ARCHIVE_INVALID') throw unzipError;
        throw fail('PACKAGE_ARCHIVE_INVALID', 'ZIP archive could not be read by tar or unzip.', { cause: unzipError.details?.cause || tarError.details?.cause || 'ARCHIVE_TOOL_UNAVAILABLE' });
      }
    }
  } else files = await collectTarArchive(archive, tarCommand);
  return { files, sourceType: 'archive', sourcePath: archive };
};

/**
 * Read a directory or tar archive into the language-neutral package envelope.
 * The caller still supplies the trusted adapter/environment and frozen oracle;
 * this module never installs dependencies or executes source files.
 */
export const importExecutionPackage = async ({ store, sourcePath, sourceType, ...input } = {}) => {
  if (!store || typeof store.assemble !== 'function') throw new TypeError('Execution package import requires a package store.');
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw fail('PACKAGE_SOURCE_REQUIRED', 'sourcePath is required.');
  const kind = sourceType || (/[.](?:tar(?:[.]gz|[.]tgz)?|zip)$/i.test(sourcePath) ? 'archive' : 'directory');
  const collected = kind === 'directory' ? await collectDirectory(sourcePath, input) : await collectArchive(sourcePath, input);
  const candidateEntrypoint = input.candidateEntrypoint || input.entrypoint;
  const acceptanceEntrypoint = input.acceptanceEntrypoint || input.acceptance?.entrypoint;
  if (!candidateEntrypoint || !acceptanceEntrypoint) throw fail('PACKAGE_ENTRYPOINT_REQUIRED', 'candidateEntrypoint and acceptanceEntrypoint are required for import.');
  assertPackagePath(candidateEntrypoint);
  assertPackagePath(acceptanceEntrypoint);
  const candidateFiles = {};
  const dependencyFiles = {};
  const acceptanceFiles = {};
  for (const [name, value] of Object.entries(collected.files)) {
    if (name === candidateEntrypoint) candidateFiles[name] = value;
    else if (name === acceptanceEntrypoint) acceptanceFiles[name] = value;
    else dependencyFiles[name] = value;
  }
  if (!candidateFiles[candidateEntrypoint]) throw fail('PACKAGE_ENTRYPOINT_INVALID', 'Candidate entrypoint is missing from the imported source.');
  if (!acceptanceFiles[acceptanceEntrypoint]) throw fail('PACKAGE_ORACLE_INVALID', 'Independent acceptance entrypoint is missing from the imported source.');
  const assembled = await store.assemble({ ...input, candidateFiles, dependencyFiles, acceptance: { ...(input.acceptance || {}), entrypoint: acceptanceEntrypoint, files: acceptanceFiles } });
  return { ...assembled, source: { type: collected.sourceType, path: collected.sourcePath, fileCount: Object.keys(collected.files).length } };
};

export { collectDirectory, collectArchive };
