# Legacy Claude execution retirement

The separate [durable Job loss preview](claude-job-loss-preview.md) prepares
read-only proposals without expanding this committing legacy interface.
`readLocalClaudeTransportCensus` also accepts optional `pinnedPids` and
`identityTokens`; they add exact owner/helper identities to the existing global
native-Claude/run/session/workspace census. Invalid/empty tokens are rejected.
Defaults retain the existing legacy behavior. No census terminates a process.

This adapter supports task-level retirement without a Windows restart. Eligibility is deliberately narrow: native Windows claude.exe, unchanged executable mtime since the recorded run start, local legacy iteration lacking process identity/exit receipt, and a recorded Read/Write/Edit-only tool surface that withholds Bash. Two complete live process censuses must show no native Claude process and no original run/session/workspace command identity. Any matching process, incomplete census or changed binary blocks retirement. The application additionally requires every persisted GPU queue task and all other resources to have explicit released terminal receipts.

Retirement preserves original run bytes and the unknown whole-tree exit, remote model outcome and remote cost. Its immutable sidecar binds original record SHA256, run, Mission, session and workspace plus census evidence. Permanent provider entry guards reject the old Mission/run/session before authentication/model start. Agent projection skips retired executions even if old event files later receive a successful result. Original Mission resume is refused. Only a separately identified new Mission with a new workspace/session may continue through the existing queue, journal and Gate; runtime-home stays unchanged.

The resource-release contract distinguishes confirmed exit from a retired operational lease. Historical releaseConfirmed=false and failure/budget/best records stay unchanged. Only the matching retired Agent stops blocking new execution; unknown GPU/foreign/untracked resources remain blocked. Receipt state is written only by this trusted application path; caller-supplied identity or proof is not accepted. No process is terminated or OS setting changed. This is native transport absence plus permanent task fencing, not a fabricated historical exit or proof that a remote request finished. Unobserved historical helper exit remains unknown.

API: POST /api/missions/:missionId/runs/:runId/retire-execution with an empty body. The Mission must be active, paused and quarantined. Adapter createClaudeExecutionRetirement({runsDir,command,...}) exposes read, retire and assertStartAllowed. Injected census/stat ports are for CPU fixtures; production uses actual CIM/file metadata. Conflicts fail closed. Sidecar writes precede application commit and repeat calls reconcile the same receipt.

Verify npm run test:claude-execution-retirement. Fixtures test active/incomplete refusal, raw-preservation, unknown exit/cost, permanent old IDs, late result exclusion, other GPU barrier retention, and a real owned CPU process detected before actual exit. No model/GPU run is required.
