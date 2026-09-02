# Projects Service Contract

## Purpose

`projects-service.mjs` owns Project use-case orchestration. It exposes transport-neutral queries and commands used by the production HTTP API.

## Inputs And Outputs

| Operation | Input | Output |
|---|---|---|
| `list()` | none | `{ projects, activeProjectId }`; each Project includes Mission counts |
| `create(input)` | absolute `root`, optional Git initialization/bootstrap fields | `{ state, project }` |
| `sources(projectId)` | encoded ID is decoded by the route | three-layer paths, repository/source inspections, source registry |
| `select(projectId)` | Project ID | saved state, selected Project and optional selected Mission ID |
| `update(projectId, input)` | Project ID and editable fields | saved state and updated Project |
| `remove(projectId)` | Project ID | saved state and removed Project |
| `bootstrap(projectId, input)` | Project ID, `gitUrl`, optional `gitRef` | saved state, linked Mission reset count, Project, bootstrap result |
| `reinitialize(projectId)` | Project ID | saved state, migrated Project, and optional runtime backup path |

## Injected Ports

- `loadState()` and `persistState(state)`: coordinated Runtime state access.
- `ensureProjectLayout(input)`: creates and records the strict three-layer layout.
- `workspace`: Git inspection, initialization, bootstrap, and source inspection.
- `filesystem`: directory existence, creation, and UTF-8 file reads.
- `projectState`: Project domain mutations; defaults to the public state-store functions.

## Stable Errors

| Code | HTTP status | Meaning |
|---|---:|---|
| `PROJECT_ROOT_NOT_ABSOLUTE` | 400 | Project root is not an absolute local path |
| `PROJECT_ROOT_UNAVAILABLE` | 404 | Root does not exist and initialization was not requested |
| `ITERATION_REPOSITORY_UNAVAILABLE` or inspection code | 400 | Repository inspection failed |
| `PROJECT_NOT_FOUND` | 404 | Project ID is unknown |
| `PROJECT_REINITIALIZATION_REQUIRED` | 409 | Three-layer source view is unavailable |

Domain mutation errors from `state-store.mjs` are preserved.

## Invariants

- A newly registered Project always uses `root/repository`, `root/sources`, and `root/.operator-studio`.
- Project state is persisted only after repository inspection succeeds.
- HTTP request/response objects never enter this module.
- Git and filesystem effects are accessed only through injected ports.
- Bootstrap and legacy-layout reinitialization own their filesystem/Git migration effects here; route code only maps the commands.

## Verification

```bash
npm run test:projects-service
npm run test:smoke
npm run verify:local-c500-release
```
