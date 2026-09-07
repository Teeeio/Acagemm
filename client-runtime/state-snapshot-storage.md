# State Snapshot Storage Adapter Contract

## Responsibility and public API

Raw snapshot I/O and existing storage bootstrap/migration. This adapter must not
import state-store, run Gate/Knowledge/adoption policy, or coordinate workflow.

- `statePath`: configured data directory plus `mock-db.json`.
- `readStateSnapshot()`: reads/parses the existing JSON. It never initializes,
  normalizes, quarantines, recovers a journal or writes.
- `writeStateSnapshot(state)`: default atomic-file writer.
- `createStateSnapshotWriter({ filePath?, filesystem?, createId?, wait? })`:
  injectable writer for fault tests; filesystem supplies mkdir/writeFile/rename.
  The resulting async function returns the supplied state without mutation.
- `quarantineStateSnapshot(error)`: effectful recovery helper. Missing-file
  ENOENT returns null; otherwise renames the snapshot to a timestamped corrupt
  backup and returns its path. Only explicit recovery may call this.
- `createStorageInitializer({ createSeedState, createProductState, saveState,
  ensureMissionWorkspace })`: returns `ensureStorage({ ensureWorkspace = true })`.
  Factories, versioned commit and Workspace provisioning are injected ports.

## Invariants and effects

Writes create a same-directory unique temporary file before replacing the final
path by rename. EPERM/EACCES retry at most five times after the first attempt,
with 20/40/60/80/100 ms waits; other failures propagate immediately. No direct
overwrite, state normalization, version increment or policy retry occurs here.
State Repository owns serialization; state-store owns schema/version policy.

A failed write/rename leaves the previously committed bytes unchanged. Existing
temporary-file retention on failure is preserved for diagnosis; this is not a
multi-file transaction, cross-process lock or fsync durability guarantee.

Bootstrap retains the managed-storage migration marker and legacy entry allowlist;
copied runtime entries exclude Git metadata. It creates seed/product state only
when absent. Malformed JSON handling remains in explicit loadState recovery.
No bootstrap work occurs merely by importing this module.

## Error contract and verification

Raw filesystem errors and JSON SyntaxError propagate unchanged. The facade maps
query/recovery errors to Runtime error codes; this adapter does not hide failures.

Run `npm run test:state-storage-adapters`,
`npm run test:state-corruption-recovery`, `npm run test:runtime-read-isolation`
and `npm run verify:local-c500-release`.
Change atomicity/retry tests and migration coverage with any adapter change.
