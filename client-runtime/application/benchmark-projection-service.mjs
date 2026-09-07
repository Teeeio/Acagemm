export const createBenchmarkProjectionService = ({ operatorTestQueue, testServiceClient, applyOperatorTestSnapshot, artifactDirForMission, mkdir, writeFile, path, collectExperience }) => {
  const project = async ({ state }) => {
    if (state.benchmark?.status !== 'running' || !state.benchmark?.testTaskId) return { changed: false, state };
    const before = JSON.stringify(state.benchmark);
    try {
      let snapshot;
      try { snapshot = await operatorTestQueue.get(state.benchmark.testTaskId); }
      catch (error) { if (error.code !== 'OPERATOR_TEST_QUEUE_NOT_FOUND') throw error; snapshot = await testServiceClient.get(state.benchmark.testTaskId); }
      applyOperatorTestSnapshot(state, snapshot);
      if (typeof collectExperience === 'function' && ['complete', 'failed', 'cancelled'].includes(state.benchmark?.status)) {
        const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
        try { await collectExperience({ state, mission }); }
        catch (error) {
          state.iterationStats = { ...(state.iterationStats || {}), experienceCollection: {
            ...(state.iterationStats?.experienceCollection || {}), status: 'failed',
            error: { code: error.code || 'ROUND_EXPERIENCE_FAILED', message: error.message, effectUnknown: Boolean(error.effectUnknown) },
          } };
        }
      }
      if (state.benchmark?.status === 'complete' && state.benchmark?.result) {
        const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
        const root = artifactDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
        await mkdir(root, { recursive: true });
        const result = state.benchmark.result;
        await Promise.all([
          writeFile(path.join(root, 'benchmark.json'), `${JSON.stringify(result.benchmark || [], null, 2)}\n`, 'utf8'),
          writeFile(path.join(root, 'tracer.json'), `${JSON.stringify(result.tracer || {}, null, 2)}\n`, 'utf8'),
          writeFile(path.join(root, 'profiler.json'), `${JSON.stringify(result.profiler || {}, null, 2)}\n`, 'utf8'),
          writeFile(path.join(root, 'test-result.json'), `${JSON.stringify({ taskId: snapshot.taskId, candidate: state.benchmark.candidate, result, completedAt: snapshot.completedAt }, null, 2)}\n`, 'utf8'),
        ]);
        state.benchmark.artifacts = { root, benchmark: path.join(root, 'benchmark.json'), tracer: path.join(root, 'tracer.json'), profiler: path.join(root, 'profiler.json') };
      }
      return { changed: before !== JSON.stringify(state.benchmark), state };
    } catch (error) {
      const serviceError = { code: error.code || 'OPERATOR_TEST_SERVICE_ERROR', message: error.message, observedAt: new Date().toISOString() };
      if (state.benchmark.lastServiceError?.code === serviceError.code) return { changed: false, state };
      state.benchmark.lastServiceError = serviceError;
      return { changed: true, state };
    }
  };
  return Object.freeze({ project });
};
