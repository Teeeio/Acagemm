import { runtimeRegistry } from './registry.mjs';

export const createAgentRuntimeEngine = ({ registry = runtimeRegistry, clients = {} } = {}) => {
  const resolveClient = (runtimeId) => {
    const definition = registry.require(runtimeId);
    const client = clients[definition.clientKey];
    if (!client) {
      const error = new Error(`Agent Runtime ${runtimeId} has no client for ${definition.clientKey}.`);
      error.code = 'AGENT_RUNTIME_CLIENT_UNAVAILABLE';
      throw error;
    }
    return client;
  };
  return Object.freeze({
    definition(runtimeId) {
      return registry.require(runtimeId);
    },
    supports(runtimeId, capability) {
      return registry.supports(runtimeId, capability);
    },
    client(runtimeId) {
      return resolveClient(runtimeId);
    },
    invoke(runtimeId, operation, ...args) {
      const definition = registry.require(runtimeId);
      const methodName = definition.operations[operation];
      if (!methodName) {
        const error = new Error(`Agent Runtime ${runtimeId} does not implement ${operation}.`);
        error.code = 'AGENT_RUNTIME_OPERATION_UNSUPPORTED';
        throw error;
      }
      const client = resolveClient(runtimeId);
      if (typeof client[methodName] !== 'function') {
        const error = new Error(`Agent Runtime ${runtimeId} client is missing ${methodName}.`);
        error.code = 'AGENT_RUNTIME_CLIENT_CONTRACT_INVALID';
        throw error;
      }
      return client[methodName](...args);
    },
  });
};
