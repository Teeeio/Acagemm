export const createOperatorTestService = ({ queue } = {}) => {
  if (!queue || typeof queue.list !== 'function' || typeof queue.get !== 'function' || typeof queue.cancel !== 'function') {
    throw new TypeError('Operator test service requires a queue with list, get, and cancel operations.');
  }
  return Object.freeze({
    list: async () => ({ tasks: await queue.list(), queueFile: queue.path }),
    get: (taskId) => queue.get(taskId),
    cancel: (taskId) => queue.cancel(taskId),
  });
};
