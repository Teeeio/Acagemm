export const createRuntimeStatePipelineService = ({ maintenance, processTests, migrateState, recordMigration, projectBaselineFailure, runtimeProjection, benchmarkProjection, pendingTests = null, repositoryAdoption, runtimeAdvance }) => {
  if (typeof runtimeAdvance?.canStartNewWork !== 'function') throw new TypeError('Pipeline requires the shared new-work admission policy.');
  const canStart = runtimeAdvance.canStartNewWork;
  const advance = async ({ state, runtime }) => {
    const maintained = canStart(state) ? maintenance.advance({ state, runtimeMode: runtime.mode }) : { state, changed: false };
    state = maintained.state;
    const migration = migrateState(state);
    if (migration.changed) recordMigration(state, migration);

    const baselineFailureChanged = projectBaselineFailure(state);
    let changed = maintained.changed || migration.changed || baselineFailureChanged;
    const projection = await runtimeProjection.project({ state, runtime });
    changed ||= projection.changed;
    // Pausing suppresses new Agent/iteration work, but a benchmark command
    // already committed in state owns a queue slot and must still be allowed
    // to submit/poll to reach a terminal outcome. This does not enable
    // adoption or the next round while the Mission remains paused.
    const committed = benchmark => benchmark?.status === 'running' && Boolean(benchmark?.testTaskId);
    const hasCommittedBenchmark = committed(projection.state.benchmark)
      || (projection.state.missions || []).some(mission => mission.id !== projection.state.activeMissionId
        && mission.iterationStats?.pendingTest && committed(mission.benchmark));
    try { await processTests({ allowStart: canStart(projection.state) || hasCommittedBenchmark }); }
    catch (error) { if (error.code !== 'OPERATOR_TEST_QUEUE_BUSY') throw error; }
    const benchmark = await benchmarkProjection.project({ state: projection.state });
    changed ||= benchmark.changed;
    const pending = pendingTests ? await pendingTests.advance({ state: benchmark.state }) : benchmark;
    changed ||= pending.changed;
    const adoption = canStart(pending.state) ? await repositoryAdoption.adopt({ state: pending.state }) : { state: pending.state, changed: false };
    changed ||= adoption.changed;
    const advanced = await runtimeAdvance.advance({ state: adoption.state });
    changed ||= advanced.changed;
    return { state: advanced.state, changed };
  };

  return Object.freeze({ advance });
};
