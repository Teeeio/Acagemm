# Runtime Projection Service Contract

Combines workflow reconciliation and Agent runtime state projection in a transport-neutral boundary. Input is `{ state, runtime }`; output is `{ state, changed }`. Ordering is fixed: workflow reconciliation precedes Agent projection. No persistence or HTTP effects are performed.
