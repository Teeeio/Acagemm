export const createExecutionPackageRoutes = ({ json, readJson, imports } = {}) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || typeof imports?.import !== 'function') throw new TypeError('Execution package routes require JSON helpers and import service.');
  return async ({ request, response, url }) => {
    if (request.method === 'POST' && url.pathname === '/api/execution-packages/import') {
      json(response, 201, await imports.import(await readJson(request)));
      return true;
    }
    return false;
  };
};
