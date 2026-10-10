import { runtimeRegistry } from './registry.mjs';

const runtimeModeAliases = Object.freeze({
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  opencode: 'opencode-server',
  'opencode-server': 'opencode-server',
});

export const normalizeAgentRuntimeMode = (runtimeMode) => {
  const requested = String(runtimeMode || '').trim().toLowerCase();
  return runtimeModeAliases[requested] || String(runtimeMode || '').trim();
};

export const isManagedWorkspaceRuntimeMode = (runtimeMode, registry = runtimeRegistry) => (
  registry.get(normalizeAgentRuntimeMode(runtimeMode))?.managedWorkspace === true
);
