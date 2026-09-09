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
