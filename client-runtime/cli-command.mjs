import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const firstLine = (value = '') => String(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;

const locateWindowsShim = (configuredCommand, provider, whereImpl) => {
  if (path.isAbsolute(configuredCommand) && existsSync(configuredCommand)) return configuredCommand;
  const base = configuredCommand.toLowerCase().endsWith('.cmd') ? configuredCommand : `${provider}.cmd`;
  const result = whereImpl('where.exe', [base], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? firstLine(result.stdout) : null;
};

export const resolveCliInvocation = ({
  provider,
  configuredCommand,
  platform = process.platform,
  whereImpl = spawnSync,
  existsImpl = existsSync,
  nodeExecutable = process.execPath,
} = {}) => {
  const requested = String(configuredCommand || provider || '').trim();
  if (platform !== 'win32' || !['claude', 'codex'].includes(provider)) return { command: requested, prefixArgs: [], requested };
  const npmShim = requested === provider || requested === `${provider}.cmd` || requested.toLowerCase().endsWith('.cmd');
  if (!npmShim) return { command: requested, prefixArgs: [], requested };

  const shim = locateWindowsShim(requested, provider, whereImpl);
  if (!shim) return { command: requested === provider ? `${provider}.cmd` : requested, prefixArgs: [], requested };
  const npmRoot = path.dirname(shim);
  if (provider === 'claude') {
    const executable = path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsImpl(executable)) return { command: executable, prefixArgs: [], requested, shim };
  }
  if (provider === 'codex') {
    const bundledExecutable = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    if (existsImpl(bundledExecutable)) return { command: bundledExecutable, prefixArgs: [], requested, shim };
    const entry = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsImpl(entry)) {
      const bundledNode = path.join(npmRoot, 'node.exe');
      return { command: existsImpl(bundledNode) ? bundledNode : nodeExecutable, prefixArgs: [entry], requested, shim };
    }
  }
  return { command: shim, prefixArgs: [], requested, shim };
};
