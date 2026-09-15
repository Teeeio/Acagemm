const IMPORT_PATH = /^\/api\/projects\/([^/]+)\/experiences\/import-kernel-wiki$/;
const COLLECTION_PATH = /^\/api\/projects\/([^/]+)\/experiences(?:\/([^/]+))?$/;

export function createExperienceRoutes({ json, readJson, experiences } = {}) {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !experiences) throw new TypeError('Experience routes require HTTP helpers and an application service.');
  return async ({ request, response, url }) => {
    // 导入路径必须先于通用 ID 匹配器判断：否则 "import-kernel-wiki" 会被当成经验 ID，
    // 落到通用 POST 分支之外。GET 等其它方法在此路径上不处理，交由后续路由。
    const imported = IMPORT_PATH.exec(url.pathname);
    if (imported) {
      if (request.method !== 'POST') return false;
      const outcome = await experiences.importKernelWiki(decodeURIComponent(imported[1]), await readJson(request));
      json(response, outcome.statusCode, outcome.payload);
      return true;
    }
    const match = COLLECTION_PATH.exec(url.pathname);
    if (!match) return false;
    const projectId = decodeURIComponent(match[1]);
    const id = match[2] ? decodeURIComponent(match[2]) : null;
    let outcome;
    if (request.method === 'GET') {
      const version = url.searchParams?.get('version');
      outcome = id ? await experiences.get(projectId, id, version === null || version === undefined ? {} : { version: Number(version) }) : await experiences.list(projectId);
    } else if (request.method === 'POST' && !id) {
      outcome = await experiences.create(projectId, await readJson(request));
    } else if (request.method === 'PATCH' && id) {
      outcome = await experiences.update(projectId, id, await readJson(request));
    } else return false;
    json(response, outcome.statusCode, outcome.payload);
    return true;
  };
}
