# Source Service Contract

`source-service.mjs` registers Git repositories under a Mission source root and reports source entry counts.

Inputs are `{ state, mission }`; outputs are transport-neutral `{ count, references?, errors? }`. Missing roots are reported as stable errors and never throw. Git metadata is read through the injected workspace port; the service does not mutate Mission state or format HTTP responses.

## Per-run accounting

`countSources` reports the whole Source Registry directory count (registry scale only) and must never be
presented as this run's harvest. `countRunSources({ state })` returns this `researchRun`'s own
acquisition result (`{ count, failures, runId }`), so historical registry directories cannot inflate the
reported research output. Source counts and usable-material counts are reported separately.

## Registered reference shape

Registration writes exactly one reference per Git repository under the source root:

    { repository, commit, scope: 'repository' }

It is a **repository-level** reference: it asserts "this repository at this commit" and names no file.
`scope` is stated explicitly rather than left to be inferred from an empty `path`, and no `path` key is
written — a repository-level reference must never fabricate a file path to look like a file reference.
Verification of both scopes lives in `workspace-manager.mjs` (`inspectSources`); a missing `path` is only
read as repository level when the caller omitted `scope` entirely, and an explicit `scope: 'file'` with no
path is a hard `SOURCE_REFERENCE_PATH_INVALID`. Unknown scopes are rejected with
`SOURCE_REFERENCE_SCOPE_INVALID`.
