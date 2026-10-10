# Projects Service Contract

## Purpose

`projects-service.mjs` owns Project use-case orchestration. It exposes transport-neutral queries and commands used by the production HTTP API.

## Inputs And Outputs

`importSource` optionally accepts boolean `activate` (default true). `false`
registers the independent material snapshot while retaining activeProjectId;
preparation-draft saves use this option. Invalid types are rejected before
filesystem effects. Existing resource-release and rollback rules still apply.

| Operation | Input | Output |
|---|---|---|
| `list()` | none | `{ projects, activeProjectId }`; each Project includes Mission counts |
| `create(input)` | absolute `root`, optional Git initialization/bootstrap fields | `{ state, project }` |
| `importSource(input)` | absolute `sourceRepository`, absolute new/empty `root`, optional `name` | `{ state, project }`; `project.sourceImport` carries verified source identity |
| `sources(projectId)` | encoded ID is decoded by the route | three-layer paths, repository/source inspections, source registry |
| `select(projectId)` | Project ID | saved state, selected Project and optional selected Mission ID |
| `update(projectId, input)` | Project ID and editable fields | saved state and updated Project |
| `remove(projectId)` | Project ID | saved state and removed Project |
| `bootstrap(projectId, input)` | Project ID, `gitUrl`, optional `gitRef` | saved state, linked Mission reset count, Project, bootstrap result |
| `reinitialize(projectId)` | Project ID | saved state, migrated Project, and optional runtime backup path |

## Injected Ports

- `loadState()` and `persistState(state)`: coordinated Runtime state access.
- `ensureProjectLayout(input)`: creates and records the strict three-layer layout.
- `workspaceDirForMission(id, repository, projectRoot)`: required path-query port
  for the active snapshot. Production binds the State Workspace adapter; the
  service never imports that adapter. Missing required ports throw TypeError.
- `workspace`: Git inspection, initialization, bootstrap, source inspection and
  `importSourceRepository({sourceRepository, root, registeredRoots})`. The import
  method returns managed paths, `sourceImport`, and a transaction-local `rollback`.
  It is required only when import is called, preserving existing port consumers.
- `filesystem`: directory existence, creation, and UTF-8 file reads.
- `projectState`: required Project domain mutations (`createProject`, `selectProject`,
  `updateProject`, `deleteProject`), normally from `createMissionProjectState`.
  There is no implicit state-store default; a missing method fails construction.

## Stable Errors

| Code | HTTP status | Meaning |
|---|---:|---|
| `PROJECT_ROOT_NOT_ABSOLUTE` | 400 | Project root is not an absolute local path |
| `PROJECT_ROOT_UNAVAILABLE` | 404 | Root does not exist and initialization was not requested |
| `ITERATION_REPOSITORY_UNAVAILABLE` or inspection code | 400 | Repository inspection failed |
| `PROJECT_NOT_FOUND` | 404 | Project ID is unknown |
| `PROJECT_REINITIALIZATION_REQUIRED` | 409 | Three-layer source view is unavailable |
| `MISSION_RESOURCE_RELEASE_PENDING` | 409 | Import blocked by pending, unconfirmed or quarantined execution-resource release |

Domain mutation errors from the injected Mission/Project state contract are preserved.

`POST /api/projects/import` maps directly to `importSource` and returns HTTP 201
with the same `{state, project}` response shape as create. It accepts only the
local source/root/name use case; clone URLs, initialization switches and other
create options do not change import behavior. Input shape/name errors return
`PROJECT_IMPORT_INPUT_INVALID` (400), and a workspace port without import returns
`PROJECT_IMPORT_UNAVAILABLE` (503). Admission errors are preserved from the
[Workspace import contract](../workspace-manager.md), including target conflicts,
source drift and resource limits.

The service clones loaded state, passes all existing Project roots to the
Workspace port, and registers only the verified snapshot. The original repository
is never registered as the mutable iteration repository. It attaches the full
adapter-produced `sourceImport` record after the domain mutation, creates the
existing three-layer descriptor with the new Project ID, then persists once.
Preparation, layout or failed atomic persistence never mutates the loaded state;
registration/layout/persistence rejection rolls back owned import files. The
injected persistence port must reject before committing when reporting failure,
as it is the existing state transaction boundary; this is not a new distributed
filesystem/state transaction or crash-recovery journal. Import never automatically
reuses or migrates a Project. Original source identity is available to the caller
for an explicit reuse decision.

Import is a standalone Project operation: before calling the Workspace port or
creating any filesystem content it uses the canonical `assertResourcesReleased`
contract. It does not call `guardMutation`, require the active Mission to be
unpaused, or require/start/renew a Mission budget. A paused draft can therefore
import another repository, and an invalid source still returns its source
validation error. Import never resumes/stops the old Mission or changes its
budget/iteration state. Unconfirmed or quarantined resources still reject with
`MISSION_RESOURCE_RELEASE_PENDING` before Workspace, layout or persistence
effects. Existing bootstrap/reinitialize commands retain `guardMutation`.

## Invariants

- A newly registered Project always uses `root/repository`, `root/sources`, and `root/.operator-studio`.
- Project state is persisted only after repository inspection succeeds.
- HTTP request/response objects never enter this module.
- Git and filesystem effects are accessed only through injected ports.
- Bootstrap and legacy-layout reinitialization own their filesystem/Git migration effects here; route code only maps the commands.

## Verification

`projects-service-test.mjs` injects the real production workflow guard to cover
valid/invalid import while paused, unstarted/expired budgets without mutation,
pending/unconfirmed/quarantined resource barriers before effects, and unchanged
guards on bootstrap/reinitialize. The Workspace port is mocked here; the main
integration suite owns real HTTP/Git verification.

```bash
npm run test:projects-service
node tests/project-source-import-test.mjs
npm run test:smoke
npm run verify:local-c500-release
```
