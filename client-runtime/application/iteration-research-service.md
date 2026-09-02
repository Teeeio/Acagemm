# Iteration Research Service Contract

Owns the Agent/Workspace coordination for starting and cancelling iteration research. Inputs are state, mission, direction, workspace, and optional synchronous/run phase flags; `startResearch` returns the updated state and is a no-op for unmanaged runtimes. Workspace creation and Agent lifecycle are injected ports. No HTTP or persistence access is allowed.
