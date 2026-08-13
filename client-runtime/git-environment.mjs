import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeDir } from './storage-paths.mjs';

const quoteGitConfigValue = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const normalizeGitPath = (value) => path.resolve(value).replaceAll('\\', '/');

export const createScopedGitEnvironment = async (workspace, baseEnv = process.env, options = {}) => {
  const normalizedWorkspace = normalizeGitPath(workspace);
  const configuredDir = options.configDir || path.join(runtimeDir, 'git-trust');
  const configName = `${createHash('sha256').update(normalizedWorkspace.toLowerCase()).digest('hex').slice(0, 24)}.gitconfig`;
  const inheritedGlobalConfigs = baseEnv.GIT_CONFIG_GLOBAL
    ? [baseEnv.GIT_CONFIG_GLOBAL]
    : ['~/.gitconfig', '~/.config/git/config'];
  const content = [
    ...inheritedGlobalConfigs.flatMap((includePath) => [
      '[include]',
      `\tpath = ${quoteGitConfigValue(includePath)}`,
    ]),
    '[safe]',
    `\tdirectory = ${quoteGitConfigValue(normalizedWorkspace)}`,
    '',
  ].join('\n');

  // The packaged/runtime directory can be read-only when the app is started
  // by an automation account. Keep the trust file scoped to one workspace,
  // but fall back to the OS temp directory instead of failing every Git probe.
  const configDirs = [...new Set([
    configuredDir,
    path.join(os.tmpdir(), 'operator-studio-git-trust'),
  ])];
  let configPath;
  let lastError;
  for (const configDir of configDirs) {
    try {
      await mkdir(configDir, { recursive: true });
      configPath = path.join(configDir, configName);
      await writeFile(configPath, content, 'utf8');
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!configPath) throw lastError;
  return {
    ...baseEnv,
    GIT_CONFIG_GLOBAL: configPath,
  };
};
