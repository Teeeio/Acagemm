# Repository Adoption Service Contract

Adopts an eligible managed-runtime candidate into the Iteration Repository after a passed Accept Gate. Ineligible states are no-ops; adoption failures become explicit blocked recovery state and a runtime event. Inputs/outputs are `{ state }` and `{ changed, state }`.
