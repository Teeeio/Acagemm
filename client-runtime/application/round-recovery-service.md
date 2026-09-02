# Round Recovery Service Contract

Validates restoration of a rejected iteration checkpoint before a new Agent round. It returns recovery metadata or `null`; mismatched workspace digests raise `ROUND_ROLLBACK_WORKSPACE_DIRTY`. Runtime and workspace operations are injected, with no HTTP or persistence access.
