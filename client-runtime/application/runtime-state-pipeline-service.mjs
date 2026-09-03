export const createRuntimeStatePipelineService = ({ migrateState, recordMigration, projectBaselineFailure, runtimeProjection, benchmarkProjection, repositoryAdoption, runtimeAdvance }) => {
  const project = async ({ state, runtime }) => {
    const migration = migrateState(state);
    if (migration.changed) recordMigration(state, migration);

    const baselineFailureChanged = projectBaselineFailure(state);
    let changed = migration.changed || baselineFailureChanged;
    const projection = await runtimeProjection.project({ state, runtime });
    changed ||= projection.changed;
    const benchmark = await benchmarkProjection.project({ state: projection.state });
    changed ||= benchmark.changed;
    const adoption = await repositoryAdoption.adopt({ state: benchmark.state });
    changed ||= adoption.changed;
    const advanced = await runtimeAdvance.advance({ state: adoption.state });
    changed ||= advanced.changed;
    return { state: advanced.state, changed };
  };

  return Object.freeze({ project });
};
