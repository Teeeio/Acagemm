export const createMissionControlRoutes = ({ json, readJson, missionControl }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !missionControl) throw new TypeError('Mission control routes require json, readJson, and missionControl dependencies.');
  return async ({ request, response, url }) => {
    const cancelMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const outcome = await missionControl.cancelRun(decodeURIComponent(cancelMatch[1]), decodeURIComponent(cancelMatch[2]));
      json(response, 202, outcome);
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/actions/human-feedback') {
      const outcome = await missionControl.addHumanFeedback(await readJson(request));
      json(response, outcome.statusCode, outcome.payload || { state: outcome.state, feedback: outcome.feedback });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/actions/stop-mission') {
      const outcome = await missionControl.stopMission();
      json(response, outcome.statusCode, outcome.payload || { state: outcome.state });
      return true;
    }
    return false;
  };
};
