# Independent Experiment Storage

This adapter prepares reproducible inputs, not a second optimization workflow.
Missions, generation, testing, Gate decisions and feedback still use production APIs.

## Public API

- `freezeExperienceSnapshot({snapshotPath, repository?})` reads the validated
  repository once, or explicitly starts with an empty store. It exclusively writes
  canonical snapshot bytes and returns their SHA-256, revision and record count.
  It never updates the source repository or replaces a previous snapshot.
- `createIndependentExperiment({rootDir, experimentId, snapshotPath,
  snapshotDigest, files, configuration?, condition?, memoryMode?})` requires a new absolute
  directory and a pinned snapshot. It copies initial source text and experience
  bytes, creates independent data/runtime roots, and publishes `experiment.json`
  last. Returned environment values must be applied together. A partially created
  directory remains diagnostic evidence; creation never silently resumes it.
- `inspectIndependentExperiment({rootDir, manifestDigest})` verifies the pinned
  manifest, initial snapshot and exact source tree, then checks the writable store
  still contains the initial history. It returns current counts without resetting
  learned history. Missing/corrupt stores fail, even with an empty initial snapshot.
- `inspectExperimentEnvironment(environment?)` is the Runtime startup admission.
  Without `OPERATOR_EXPERIMENT_ROOT` ordinary deployment is unchanged. With it,
  all returned environment values must match; mismatch fails before storage
  initialization/migration, serving HTTP or executing a model/test. `__bridge`
  responses include the admitted identities and **startup-time** experience counts.
- `inspectExperimentAgentAccess({rootDir, workspace, directories?, bridgeDir})`
  rejects foreign or linked working/read/configuration roots before provider spawn.

## Layout and identity

`initial-experiences.json` and `input/` are frozen inputs. `runtime/experiences/`
is a writable copy, while `data/`, other runtime artifacts and managed projects are
private to the experiment. Explicit `OPERATOR_DATA_DIR` and `OPERATOR_RUNTIME_DIR`
disable the legacy auto-migration path. Initial source, configuration, snapshot
and full experiment identities are independently hashed; the external pinned
manifest digest prevents edited metadata from silently becoming authoritative.

The manifest also freezes the [memory mode](experiment-memory.md). Default
`local-only` uses `fixed-start-learning`; `facts-only` uses `facts-only-control`.
`continuous-chain` requires explicit selection with `local-only` and is reported
separately from independent repetitions. Legacy manifests without a mode retain
their corresponding independent default. Startup returns initial store counts
and mode for trusted Mission binding, alongside current startup observations.

Conditions currently supported are `local-only` and `facts-only`; both preserve
within-experiment collection. Optional retrieval is filtered by the existing
experience contract. Neither condition flag alone provides isolation. No project
IDs or historical evidence are rewritten: a nonempty seed retains original
project authorization. The primary local campaign uses an empty seed; seeded
cross-project studies must explicitly arrange matching authorized visibility.

Sources accept bounded portable relative filenames and UTF-8 text. Links,
case collisions, Agent configuration and Git history are refused. Restarts verify
the exact initial file set. Initial code must be imported/copied into the managed
project via the ordinary preparation path; Agents never edit the frozen input.
The production Missions service binds new Mission identities to the admitted
manifest and observed store. The batch driver still supplies task/repetition
identity; storage preparation alone does not prove a live run is comparable.

## Agent context

The controlled profile uses Claude Code, managed run-specific configuration,
fresh sessions, `--safe-mode`, explicit managed settings and local working roots.
New manifests bind `claude-safe-mode-confined-fresh-session-v2`. Startup refuses
older Agent policies; historical artifacts remain readable and are never rewritten
to claim that they used the new mode.
Automatic external memory is disabled and reads outside granted working roots
are blocked by CLI settings. Required prior-round facts remain in the prompt.
See [Claude adapter](claude-client.md). This is application/CLI confinement, not
an OS sandbox. A real CLI boundary check and live-run audit are required before
claiming an experiment passed isolation; a spawn fixture proves arguments only.

## Limits and verification

One Runtime writes each experiment. Filesystem checks do not defend against an
adversarial host swapping paths during a check, and no power-loss atomicity is
claimed. Snapshots and preparation are exclusive writes; an interrupted prepare
may leave an unusable directory, which is retained rather than auto-deleted.

`npm run test:experiment-storage` checks source preservation, A/B retrieval,
restart retention, path/digest/missing-file rejection, real production HTTP
experience writes and restart, and provider parameters with a spawn fixture.
It performs no model or GPU optimization and grants no publication evidence.
