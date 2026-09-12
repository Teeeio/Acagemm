# Response Model Observation Contract

I/O-free, deterministic contract for what responding model a Claude Code run
actually reported. Frozen by
[docs/development/MODEL_OBSERVATION_ACCEPTANCE.md](../docs/development/MODEL_OBSERVATION_ACCEPTANCE.md).
The module reads no files, environment, network or clock; it validates shape and
internal consistency only.

## Evidence semantics

Claude Code is the runtime, not necessarily the responding model. Only
`assistant.message.model` reports the responding model. `system.init.model`
(`configuredModels`) and `result.modelUsage` keys (`usageModels`) are retained as
diagnostic labels and never create or override an observation. This is
provider-reported metadata, not independent attestation of the remote service:
`observed` means the stream was complete and internally consistent, not that the
remote model was verified.

## Public API

| Export | Contract |
|---|---|
| `MODEL_OBSERVATION_SCHEMA_VERSION` | `'operator-studio.model-observation/v1'` |
| `observeClaudeModel({ runId, missionId, sessionId, events=[] })` | complete frozen DTO |
| `bindModelObservation(value, { provider, runId, missionId, sessionId })` | deep detached valid DTO, or `null` |
| `summarizeModelObservations(observations=[], { requiredRuns=[] }={})` | comparability summary |

DTO (all fields required, exactly this key set):

```text
{ schemaVersion, provider:'claude-code', runId, missionId, sessionId,
  status:'observed'|'unknown'|'conflict', model:string|null,
  source:'assistant.message.model'|null, models:string[],
  configuredModels:string[], usageModels:string[],
  observations:[{ eventIndex, sessionId, model }], reasons:string[] }
```

`models`/`configuredModels`/`usageModels` are trimmed, unique and sorted.
`observations` carry metadata only (index, session, model) — never text, thinking,
tool input or secrets. `eventIndex` is the zero-based position of the event inside
the captured safe model-metadata sequence (the same sequence the pure API is
handed), so `user`/tool/other non-metadata events never shift or duplicate it;
each index must be unique within a DTO. Identity strings (`runId`/`missionId`/`sessionId`) and every
observation session must be nonblank and are compared by **exact bytes** — never
trimmed or normalized, so `' s '` and `'s'` are different sessions. A blank
run/mission/session identity can never yield `observed`. Model labels are trimmed
(a label is not an identity). Missing/blank/`unknown`/`null`/`undefined`/
`<synthetic>` labels are case-insensitive sentinels and are never observations.

### observeClaudeModel

1. Every `assistant` event is read before telemetry filtering. A missing or
   foreign `session_id` invalidates completeness and retains a reason; a foreign
   session never replaces the requested identity. Matching is byte-exact: a
   padded/trimmed variant is foreign, never merged.
2. Zero assistant responses, or any missing/invalid response model or session,
   yields `unknown` unless several concrete models/sessions make it `conflict`.
3. Exactly one concrete response model across complete matching responses yields
   `observed` with `source:'assistant.message.model'`. Several concrete models
   yield `conflict` with `model`/`source` cleared and the visible labels sorted.
4. `configuredModels` comes from `system.init.model`; `usageModels` from
   `result.modelUsage` keys. Neither supplies observations. Other fields named
   `model` and prose are ignored.
5. Every run starts `unknown`; a resume hint is not an observation. Metadata is
   preserved through normal lines, an unterminated final JSON line, logical
   completion, physical close and cancellation/error.

### bindModelObservation

Returns a deep detached copy only for a complete, internally consistent DTO whose
provider/run/mission/session exactly equal the supplied identity (all four
nonblank). It rejects: wrong schema/status, `observed` without a model/source,
a model absent from a singleton `models`, unsorted/duplicate/blank model arrays,
non-array fields, negative or fractional observation indexes, observation models
or sessions inconsistent with the DTO, and — for every status — a `models` array
that is not *exactly* the model set backed by `observations` (no unbacked claim,
no hidden observed model, no repeated `eventIndex`). `observed` must carry no
reason; `unknown`/`conflict` must carry at least one nonblank reason. `unknown`/
`conflict` DTOs may bind, but never establish comparability.

### summarizeModelObservations

Returns `{ schemaVersion, status, model, modelSource, models, requiredRunCount,
observedRunCount, reasons }`. `requiredRuns` entries need nonblank
provider/run/mission/session and must be unique by provider/mission/run; blank,
duplicated or empty required sets are `unknown`. Evidence is attributed only to an
exact required binding: missing, malformed, foreign or contradictory per-run
evidence can never produce `observed`, and unattributed evidence keeps the
summary `unknown`. Repeated identical DTOs for one binding count once; identity is
compared with a stable field-semantic canonical form, so JSON object key order can
never turn one valid DTO into a contradiction, while a genuinely different model
stays a conflict. `observed` requires every required run to report the same single
model, then `modelSource:'observed'`; different models across valid runs are
`conflict`; otherwise `modelSource` is `'unknown'`.

## Producer / projection / archive ownership

- `claude-client.mjs` persists `record.modelObservation` on every run, starting
  `unknown`. It accumulates minimal safe metadata from each raw JSON line before
  telemetry filtering (so thinking-only responses are observed without their
  content being persisted), learns the session from the current stream by exact
  bytes (the first real stream session becomes and stays `record.sessionId`/
  `record.threadId`; the resume hint is a request parameter only, never an
  observed identity), and persists on every metadata change — including the
  unterminated final line captured before the buffer is cleared. Cancellation,
  error and physical close retain the latest valid metadata. The adapter never
  uses model identity as a control gate.
- `agent-runtime.mjs` derives the expected identity from the current agent +
  active Mission (both must agree when both are present) and rejects a run record
  claiming another run/mission/provider instead of re-labelling it. The expected
  session is an independent run-record identity, compared byte-exactly: the
  record's actual `sessionId`, or its compatible `threadId` when no session was
  recorded, and the two must agree when both are present. The DTO's own
  `sessionId` is never an authority — a cancelled run gets no self-binding
  fallback, so a DTO whose session disagrees with the record is refused.
  Missing/foreign/malformed/stale evidence — including an unreadable run record —
  clears the value. A metadata-only change is a real
  change (`changed=true`) even when status/event count did not move. Workflow,
  candidate admission, Gate and resource-release rules are unchanged.
- `mission-project-state.mjs` keeps a detached exact-bound copy as
  `runHistory[].modelObservation` on reset/archive, clears the live run
  observation, and never lets a new run inherit it. Identity uses the live run's
  exact provider/run/mission and stream session. A repeated reset for the same
  run preserves the first valid archived copy instead of deleting it, and an old
  archive is never used to backfill a currently foreign/inconsistent identity.

## Tests

`node tests/model-observation-test.mjs` (adapter/pure/projection/archive, 34
hardware-free checks). `tests/model-observation-acceptance-test.mjs` reuses the
same pure API for the driver/ledger comparability half, which is completed by the
acceptance scripts, not by this module.

## Boundaries

No UI/HTTP API is added and no report claims remote authenticity: this contract
only records what the provider stream reported. Round facts, prompt audit and
Gate decisions stay independent of model observation.
