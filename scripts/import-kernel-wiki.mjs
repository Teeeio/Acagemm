#!/usr/bin/env node
// Pinned KernelWiki snapshot builder (Phase 3 writer B).
//
// Reads ONLY git blobs at an exact commit: every wiki/**.md page and the
// repository LICENSE. It never checks out, fetches or mutates the source
// repository, never reads dirty working files, performs no network, model or GPU
// work, and never writes live Runtime storage. It writes exactly one snapshot
// file that the operator imports later through the production HTTP API inside an
// isolated Runtime.
//
// usage: node scripts/import-kernel-wiki.mjs --source PATH --commit HEX --out NEWFILE [--reviews JSONFILE]
//
// exit codes: 0 = snapshot written; 1 = read/build failure; 2 = usage error.
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createScopedGitEnvironment } from '../client-runtime/git-environment.mjs';
import { buildKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';

const execFileAsync = promisify(execFile);
const USAGE = 'usage: node scripts/import-kernel-wiki.mjs --source PATH --commit HEX --out NEWFILE [--reviews JSONFILE]';
const OPTIONS = ['--source', '--commit', '--out', '--reviews'];
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

class UsageError extends Error {}

const parseArguments = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument ${argument}`);
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!OPTIONS.includes(name)) throw new UsageError(`unknown option ${name}`);
    if (values.has(name)) throw new UsageError(`${name} is repeated`);
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${name} requires a value`);
    values.set(name, value);
  }
  for (const required of ['--source', '--commit', '--out']) if (!values.has(required)) throw new UsageError(`${required} is required`);
  const commit = values.get('--commit');
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new UsageError('--commit must be a full 40-character lowercase hex commit');
  return { source: values.get('--source'), commit, out: values.get('--out'), reviews: values.get('--reviews') ?? null };
};

const readBlob = async (env, sourceDir, spec) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', sourceDir, 'cat-file', 'blob', spec], {
      env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new Error(`cannot read git blob ${spec} at the pinned commit: ${String(error.stderr ?? error.message).trim()}`);
  }
};

const gitText = async (env, sourceDir, args) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', sourceDir, ...args], {
      env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
};

const loadReviews = async (file) => {
  if (!file) return [];
  const raw = await readFile(path.resolve(file), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--reviews ${file} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`--reviews ${file} must contain a JSON array of review assertions`);
  return parsed;
};

// The snapshot may never be written into the pinned clone. A path counts as
// inside when either the literal or the case-folded comparison says so, so a
// Windows path alias, a symlinked parent directory or a differently cased
// spelling cannot smuggle the output into the source tree.
const isInside = (parent, candidate) => [[parent, candidate], [parent.toLowerCase(), candidate.toLowerCase()]]
  .some(([base, target]) => {
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
// Resolve --out against its real (symlink-resolved) parent directory and refuse
// anything that already exists or lands inside the pinned source. The write below
// additionally uses the exclusive 'wx' flag, so even a race cannot overwrite a
// file that appeared after this check.
const resolveOutPath = async (sourceReal, requested) => {
  const outPath = path.resolve(requested);
  const outStat = await lstat(outPath).catch(() => null);
  if (outStat) throw new UsageError(`--out ${requested} already exists; refusing to overwrite an existing file`);
  const parent = path.dirname(outPath);
  const parentReal = await realpath(parent).catch(() => path.resolve(parent));
  const resolvedOut = path.join(parentReal, path.basename(outPath));
  if (isInside(sourceReal, resolvedOut)) {
    throw new UsageError(`--out ${requested} is inside --source; the pinned clone must stay untouched, so the snapshot must be written outside it`);
  }
  return outPath;
};

const main = async (argv) => {
  const options = parseArguments(argv);
  const sourceDir = path.resolve(options.source);
  const sourceStat = await stat(sourceDir).catch(() => null);
  if (!sourceStat) throw new UsageError(`--source ${options.source} does not exist`);
  if (!sourceStat.isDirectory()) throw new UsageError('--source must be a directory');
  const outPath = await resolveOutPath(await realpath(sourceDir), options.out);
  const reviews = await loadReviews(options.reviews);

  // Scoped Git trust only: one generated config file in an explicit temporary
  // directory, no global configuration edits.
  const baseEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const env = await createScopedGitEnvironment(sourceDir, baseEnv, {
    configDir: path.join(os.tmpdir(), 'operator-studio-kernel-wiki-import'),
  });

  const resolved = (await gitText(env, sourceDir, ['rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`])).trim();
  if (resolved !== options.commit) throw new Error(`--commit ${options.commit} did not resolve to itself in ${sourceDir}`);
  const listing = await gitText(env, sourceDir, ['ls-tree', '-r', '-z', '--name-only', options.commit, '--', 'wiki']);
  const entries = listing.split(NUL).filter(Boolean);
  const pagePaths = entries.filter((entry) => entry.endsWith('.md')).sort();
  const skipped = entries.length - pagePaths.length;
  if (!pagePaths.length) throw new Error(`the pinned commit has no wiki/**.md pages under wiki/`);
  if (skipped > 0) console.error(`[import-kernel-wiki] note: skipped ${skipped} non-markdown entr${skipped === 1 ? 'y' : 'ies'} under wiki/`);

  const pages = [];
  for (const pagePath of pagePaths) {
    const blob = await readBlob(env, sourceDir, `${options.commit}:${pagePath}`);
    pages.push({ path: pagePath, text: blob.toString('utf8') });
  }

  const licenseBlob = await readBlob(env, sourceDir, `${options.commit}:LICENSE`);
  // The blob text is recorded VERBATIM: the trailing newline, any leading or
  // trailing whitespace and CRLF/LF endings all stay in the snapshot, so
  // snapshotDigest covers the actual upstream LICENSE. The MIT check and the
  // copyright line are derived from a read-only normalized probe, which is never
  // stored, so inspecting the license cannot rewrite it.
  const licenseText = licenseBlob.toString('utf8');
  const licenseProbe = licenseText.replaceAll(CR, '').trim();
  if (!/MIT License|Permission is hereby granted, free of charge/iu.test(licenseProbe)) {
    throw new Error('the LICENSE blob at the pinned commit is not the expected MIT license; refusing to record a license claim the source does not state');
  }
  const copyright = licenseProbe.split(LF).map((line) => line.trim()).find((line) => line.toLowerCase().startsWith('copyright')) ?? '';
  const license = { spdx: 'MIT', path: 'LICENSE', copyright, text: licenseText };

  const snapshot = buildKernelWikiSnapshot({ pages, sourceCommit: options.commit, reviews, license });
  // Exclusive create: an existing file is never truncated or replaced.
  await writeFile(outPath, JSON.stringify(snapshot, null, 2) + LF, { encoding: 'utf8', flag: 'wx' });
  console.log(`[import-kernel-wiki] source ${sourceDir} @ ${options.commit}`);
  console.log(`[import-kernel-wiki] pages ${pages.length}, units ${snapshot.units.length}, snapshotDigest ${snapshot.snapshotDigest}`);
  console.log(`[import-kernel-wiki] wrote ${outPath}`);
  console.log('[import-kernel-wiki] snapshot only: no live Runtime storage was written; import it through the production HTTP API.');
  return 0;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`[import-kernel-wiki] ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`[import-kernel-wiki] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
