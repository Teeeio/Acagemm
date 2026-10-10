import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Platform policy is deliberately kept in this small adapter.  Workflow and
// package contracts consume the resolved executable, not platform-specific
// virtual-environment paths.
const defaultExists = (candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
};

const normaliseRoot = (rootDir) => rootDir ? path.resolve(rootDir) : repositoryRoot;

const validateWindowsStorageRoot = (rootDir) => {
  // Inspect the original spelling before path.resolve/native realpath can hide
  // namespace, stream or Win32 trailing-dot/space ambiguity. Tildes are valid
  // literal characters; only the filesystem may expand an actual short name.
  if (typeof rootDir !== 'string') return; // path.resolve retains its type error.
  const segments = rootDir.replace(/^[a-z]:/i, '').split(/[\\/]/u);
  if (/^[\\/]+(?:[?.]|\?\?)[\\/]/u.test(rootDir)
    || /[<>:"|?*\u0000-\u001f]/u.test(rootDir.replace(/^[a-z]:/i, ''))
    || segments.some((segment) => segment !== '.' && segment !== '..' && (
      /[. ]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(segment)
    ))) {
    throw Object.assign(new Error('Windows storage root must be an ordinary path without device namespaces, streams, reserved device names or trailing dots/spaces.'), {
      code: 'PLATFORM_STORAGE_ROOT_INVALID',
    });
  }
};

/**
 * Resolve a user-selected storage root before deriving any child paths.
 * On Windows, expand the existing prefix through the native filesystem and
 * append missing suffixes unchanged. Only ENOENT permits walking to a parent;
 * access, I/O and not-a-directory errors remain errors. This identifies the
 * same directory, grants no permissions, and must not retry a denied run.
 * Non-Windows keeps path.resolve semantics without filesystem access.
 */
export const resolveCanonicalStorageRoot = (rootDir, {
  platform = process.platform,
  realpath = fs.realpathSync.native,
} = {}) => {
  if (platform === 'win32') validateWindowsStorageRoot(rootDir);
  const absolute = path.resolve(rootDir);
  if (platform !== 'win32') return absolute;
  const suffix = [];
  let prefix = absolute;
  while (true) {
    try {
      return path.join(realpath(prefix), ...suffix);
    } catch (error) {
      const parent = path.dirname(prefix);
      if (error?.code !== 'ENOENT' || parent === prefix) throw error;
      suffix.unshift(path.basename(prefix));
      prefix = parent;
    }
  }
};

/**
 * Resolve the Python executable used by local shared-GPU adapters.
 *
 * OPERATOR_GPU_PYTHON remains the explicit override.  If it is absent, a
 * repository-local virtual environment is preferred using the native layout
 * (`Scripts/python.exe` on Windows, `bin/python` on POSIX).  A PATH command is
 * returned as the final fallback so Linux hosts do not receive a Windows-only
 * path and shell command templates remain portable.
 */
export const resolvePythonExecutable = ({
  rootDir,
  env = process.env,
  platform = process.platform,
  exists = defaultExists,
} = {}) => {
  const explicit = String(env.OPERATOR_GPU_PYTHON || env.PYTHON || '').trim();
  if (explicit) return explicit;

  const root = normaliseRoot(rootDir);
  const relativeCandidates = platform === 'win32'
    ? ['.gpu-venv/Scripts/python.exe', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
    : ['.gpu-venv/bin/python', '.venv/bin/python', 'venv/bin/python'];
  for (const relative of relativeCandidates) {
    const candidate = path.join(root, ...relative.split('/'));
    if (exists(candidate)) return candidate;
  }
  return platform === 'win32' ? 'python' : 'python3';
};

export const resolveGpuPython = resolvePythonExecutable;

/** Quote one executable/path for the command shell used by the supervisor. */
export const quoteCommandArgument = (value, platform = process.platform) => {
  const text = String(value);
  if (platform === 'win32') return `"${text.replaceAll('"', '\\"')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
};

export const platformPythonLayout = (platform = process.platform) => platform === 'win32'
  ? { virtualEnvironmentBin: 'Scripts', executable: 'python.exe', fallback: 'python' }
  : { virtualEnvironmentBin: 'bin', executable: 'python', fallback: 'python3' };
