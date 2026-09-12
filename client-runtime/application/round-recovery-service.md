# Round Recovery Service Contract

Validates restoration of a rejected iteration checkpoint before a new Agent round. It returns recovery metadata or `null`; mismatched workspace digests raise `ROUND_ROLLBACK_WORKSPACE_DIRTY`. Runtime and workspace operations are injected, with no HTTP or persistence access.

The returned shape and its recovery criteria are unchanged. Archived round facts
read rollback truth from the persisted `workflowRecovery.lastRecovery` and the
checkpoint matched by `lastRecovery.checkpointId` (`stableDigest` included), rather than extending this service's
return value, so a caller cannot mistake checkpoint metadata for a performed
rollback.
