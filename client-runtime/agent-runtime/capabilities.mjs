import { runtimeRegistry } from './registry.mjs';

export const isManagedWorkspaceRuntimeMode = (runtimeMode, registry = runtimeRegistry) => (
  registry.get(runtimeMode)?.managedWorkspace === true
);
