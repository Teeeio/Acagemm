import { runtimeDefinitions } from './definitions.mjs';

const requiredOperationsByTransport = Object.freeze({
  'stdio-jsonl': ['describe', 'preflight', 'start', 'readRun', 'readEvents', 'cancel', 'eventText'],
  'http-session': ['health', 'providers', 'createSession', 'prompt', 'readStatus', 'readEvents', 'readDiff', 'cancel'],
});

const validateDefinition = (definition) => {
  for (const field of ['id', 'label', 'clientKey', 'transport', 'eventParser', 'usageSemantics', 'operations']) {
    if (!definition?.[field]) throw new Error(`Agent Runtime definition is missing ${field}.`);
  }
  if (!definition.capabilities || typeof definition.capabilities !== 'object') {
    throw new Error(`Agent Runtime definition ${definition.id} is missing capabilities.`);
  }
  if (Object.values(definition.capabilities).some((value) => typeof value !== 'boolean')) {
    throw new Error(`Agent Runtime definition ${definition.id} has a non-boolean capability.`);
  }
  if (Object.entries(definition.operations).some(([operation, method]) => !operation || typeof method !== 'string' || !method)) {
    throw new Error(`Agent Runtime definition ${definition.id} has an invalid operation mapping.`);
  }
  const missingOperations = (requiredOperationsByTransport[definition.transport] || []).filter((operation) => !definition.operations[operation]);
  if (missingOperations.length) {
    throw new Error(`Agent Runtime definition ${definition.id} is missing ${definition.transport} operations: ${missingOperations.join(', ')}.`);
  }
  if (definition.managedWorkspace && !definition.failureClassifier) {
    throw new Error(`Agent Runtime definition ${definition.id} is missing failureClassifier.`);
  }
  return definition;
};

const freezeDefinition = (definition) => Object.freeze({
  ...definition,
  operations: Object.freeze({ ...definition.operations }),
  capabilities: Object.freeze({ ...definition.capabilities }),
});

export const createRuntimeRegistry = (definitions = runtimeDefinitions) => {
  const entries = new Map();
  for (const candidate of definitions) {
    validateDefinition(candidate);
    if (entries.has(candidate.id)) throw new Error(`Duplicate Agent Runtime definition: ${candidate.id}`);
    const definition = freezeDefinition(candidate);
    entries.set(definition.id, definition);
  }
  return Object.freeze({
    get(id) {
      return entries.get(id) || null;
    },
    require(id) {
      const definition = entries.get(id);
      if (!definition) {
        const error = new Error(`Unsupported Agent Runtime: ${id}`);
        error.code = 'AGENT_RUNTIME_UNSUPPORTED';
        throw error;
      }
      return definition;
    },
    list() {
      return [...entries.values()];
    },
    supports(id, capability) {
      return entries.get(id)?.capabilities?.[capability] === true;
    },
  });
};

export const runtimeRegistry = createRuntimeRegistry();

export const productionWorkflowCapabilities = Object.freeze([
  'research',
  'materializer',
  'iteration',
  'workspaceWrite',
  'structuredEvents',
  'cancellation',
  'usageReporting',
]);

export const inspectRuntimeCapabilities = (runtimeId, required = productionWorkflowCapabilities, registry = runtimeRegistry) => {
  const definition = registry.get(runtimeId);
  if (!definition) return { runtimeId, supported: false, missing: [...required], definition: null };
  const missing = required.filter((capability) => !registry.supports(runtimeId, capability));
  return { runtimeId, supported: missing.length === 0, missing, definition };
};
