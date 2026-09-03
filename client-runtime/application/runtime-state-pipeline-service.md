# Runtime State Pipeline Service Contract

Projects an already-loaded runtime snapshot through compatibility migration, Baseline failure projection, workflow/Agent projection, Benchmark projection, repository adoption, and automatic iteration advancement in that order.

Input is `{ state, runtime }`. Output is `{ state, changed }`. The service never loads, persists, or locks state; the server composition root owns the surrounding `stateRepository.runExclusive()` scope and persists the returned state once when `changed` is true.
