# Baseline Materializer Command Service Contract

Submits the strict-zero-source `materialize-baseline` command with the resolved source and matrix. Execution is journaled and state-version checked through injected command ports. Input is `{ state, baselineSource, matrix }`; output is updated state.
