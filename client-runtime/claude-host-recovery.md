# Legacy local-host recovery contract

The Claude adapter owns immutable run-scoped host-anchor and host-termination sidecars. Capture reads Windows MachineGuid as a SHA-256 fingerprint (never exports the raw identity), BootId, actual OS boot time and observation time. It binds the complete original run file byte digest, run ID, Mission ID and start time. No provider call or termination occurs.

Recovery requires the same host fingerprint, a strictly larger boot counter, and actual new boot time later than both the checkpoint and original run start. Unknown, stale, changed, foreign or malformed evidence fails closed. Only legacy local Windows stdio Claude runs without a durable Job identity are eligible; newer runs use the verified Job receipt path. A derived cancelled/unknown-interrupted resource projection does not rewrite the original raw record, invent its exit code/time, declare remote provider completion, reset budgets or grant publication. Remote outcome and cost remain unknown.

Public adapter API: createClaudeHostRecovery({runsDir,readHostIdentity?}) -> capture(runId), recover(runId), project(record). The optional identity port exists for CPU fixtures. Production reads only actual OS identity. No caller-supplied host proof is accepted.

Formal entry: POST /api/missions/:missionId/runs/:runId/local-host-recovery with exactly {action:'capture'} or {action:'recover'}. Mission Control validates active Mission/run, paused Claude ownership and that all other resources are released. Recovery remains paused and reconciles only the matching local Agent resource. Unknown/remote test resources retain their barrier. Capture never releases resources. Operator must save work and perform a full Windows Restart; sleep, hibernate or restarting the service is insufficient. No automatic restart exists.

Verification: npm run test:claude-host-recovery. CPU fixtures verify same-boot, foreign-host, changed-run and conflicting-time refusal; later same-host proof; raw-record preservation, unknown remote outcome/cost and other-resource refusal.
