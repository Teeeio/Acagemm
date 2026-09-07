export const createRuntimeStatePipelineService = ({ maintenance, processTests, migrateState, recordMigration, projectBaselineFailure, runtimeProjection, benchmarkProjection, repositoryAdoption, runtimeAdvance }) => {
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
    try { await processTests({ allowStart: canStart(projection.state) }); }
    catch (error) { if (error.code !== 'OPERATOR_TEST_QUEUE_BUSY') throw error; }
    const benchmark = await benchmarkProjection.project({ state: projection.state });
    changed ||= benchmark.changed;
    const adoption = canStart(benchmark.state) ? await repositoryAdoption.adopt({ state: benchmark.state }) : { state: benchmark.state, changed: false };
    changed ||= adoption.changed;
    const advanced = await runtimeAdvance.advance({ state: adoption.state });
    changed ||= advanced.changed;
    return { state: advanced.state, changed };
  };

  return Object.freeze({ advance });
};
