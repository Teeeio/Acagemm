# Workspace Manager Contract

`snapshotGit(args,cwd,input?)` exposes the existing isolated import Git port to
the explicit-attempt workspace adapter. It retains scoped environment/config,
disabled hooks/fsmonitor/lazy-fetch, bounded output and the 20-second timeout.
Callers use raw-object plumbing rather than repository programs/content filters.

`captureDiff(target,{readOnly:true})` skips intent-to-add and reports untracked
non-generated files plus HEAD. Frozen feedback rejects untracked additions and
compares the captured patch and immutable source manifest without index writes.
Default capture behavior remains unchanged for candidate generation.

`workspace-manager.mjs` is the filesystem/Git adapter. Application services consume
its injected public port; it does not register Projects, decide Gates, run Agents,
execute repository scripts or own a second iteration workflow.

Existing APIs remain `ensure`, `inspect`, `bootstrapRepository`, `captureDiff`,
`inspectSources`, `updateSourceRegistry`, `adoptPatch`, `applyWorkspacePatch`,
`revertAdoption`, `excludeProjectRuntime` and `git`. Existing fixture/workspace
behavior and remote bootstrap are unchanged by local source import.

## Controlled local source import

`importSourceRepository({ sourceRepository, root, registeredRoots = [] })` imports
an ordinary local Git working tree into an independent managed baseline. Both
paths must be absolute. `root` must be absent or an empty directory; its parent
must already exist. Source/destination and destination/registered-project roots
must not overlap, including after canonical resolution. No existing Project is
automatically reused, migrated or updated.

The result contains:

- `root`, `repository = root/repository`, `sourceRoot = root/sources`, and
  `runtimeRoot = root/.operator-studio`.
- `sourceImport`: schemaVersion `1`, mode `working-tree-snapshot`, original
  `repository` input, `canonicalRepository`, full source `head` (null for an
  unborn repository), `indexDigest`, `snapshotDigest`, `dirty`, `fileCount`,
  `totalBytes`, independent baseline `importedHead`, and `importedAt`.
- `rollback()`: an in-process compensating port for failed Project registration.
  It removes only this import's owned three-layer directories, after checking
  directory identity and link boundaries. A pre-existing empty root is retained;
  a newly created root is removed only if empty. Foreign entries are not removed.
  Call only while completing this import transaction, never as project deletion.

The adapter creates only a single-commit independent repository, not a clone or
linked worktree. It includes current bytes of indexed regular files and
non-ignored untracked files. Working-tree and staged deletions remain absent;
tracked ignored files remain included. Untracked ignored files, original `.git`,
history, remote settings, hooks, filters and credentials are not copied.
`sources` and the runtime root start empty; the application invokes the existing
layout port to create the descriptor and source registry.

`snapshotDigest` binds the source HEAD, raw index digest, ordered paths, Git file
modes and content hashes. Three reads (before copying, while copying, and after
baseline construction) must agree. Each file is also checked before and after
its bounded handle read. Drift fails closed without retry or registration.
This is optimistic snapshot validation, not an OS lock against hostile concurrent
filesystem mutation. `dirty` compares raw working-tree/index objects with HEAD;
it deliberately does not run Git status or clean filters, so line-ending/filter
normalization can also make it true for a Git-normalized clean worktree.

Import uses isolated Git environment/config overrides, read-only source plumbing,
and hash-object `--no-filters` / update-index / commit-tree for the destination.
Optional index locks, fsmonitor, global config, hooks and lazy fetch are disabled.
Destination info/attributes disables content conversion so its baseline contains
the exact copied bytes. No network or source repository programs are run.

Admission defaults: at most **20,000 listed paths**, **512 MiB total file bytes**,
**64 MiB per file**, **16 MiB Git command output/index**, and **20 seconds per Git
command**. `createWorkspaceManager({sourceImportLimits})` may tighten the first
three limits for a host/test; HTTP callers cannot raise them. Paths are portable
and case-unambiguous. Links/junctions (even internal links), special files,
embedded repositories, submodules, unresolved index conflicts, linked worktrees,
external/shared object stores and partial clones are refused. Reserved `.git`
and `.operator-studio` path components cannot be imported as ordinary content.

## Stable errors

| Code | Status | Meaning |
|---|---:|---|
| `PROJECT_SOURCE_NOT_ABSOLUTE` / `PROJECT_ROOT_NOT_ABSOLUTE` | 400 | Invalid absolute input path |
| `PROJECT_SOURCE_NOT_GIT` | 400 | Not an ordinary Git root |
| `PROJECT_IMPORT_PARENT_UNAVAILABLE` | 400 | Destination parent is unavailable |
| `PROJECT_IMPORT_PATH_OVERLAP` | 409 | Source and destination overlap |
| `PROJECT_IMPORT_PROJECT_EXISTS` | 409 | Destination overlaps a registered Project |
| `PROJECT_IMPORT_TARGET_NOT_EMPTY` | 409 | Occupied destination or competing import |
| `PROJECT_IMPORT_LINK_UNSUPPORTED` | 400 | Link/junction in selected source or destination |
| `PROJECT_IMPORT_ENTRY_UNSUPPORTED` | 400 | Nonregular source entry / embedded repository |
| `PROJECT_IMPORT_PATH_INVALID` | 400 | Unsafe/reserved/ambiguous path, including embedded directory entries |
| `PROJECT_IMPORT_SUBMODULE_UNSUPPORTED` | 400 | Gitlink/submodule cannot be safely snapshotted |
| `PROJECT_IMPORT_GIT_LAYOUT_UNSUPPORTED` | 400 | External/shared objects or partial clone |
| `PROJECT_IMPORT_UNMERGED` | 409 | Unresolved index merge |
| `PROJECT_IMPORT_LIMIT_EXCEEDED` | 413 | File, byte or metadata limit |
| `PROJECT_IMPORT_SOURCE_CHANGED` | 409 | Source changed across snapshot reads |
| `PROJECT_IMPORT_CLEANUP_BLOCKED` | 409 | Owned directory identity changed; automatic cleanup stopped |
| `PROJECT_IMPORT_FAILED` | 503 | Other bounded Git/filesystem failure |

## Verification

`node tests/project-source-import-test.mjs` uses real temporary Git repositories
and records per-case duration. `node tests/workspace-manager-test.mjs` verifies
existing Workspace behavior. Neither requires a model, GPU or remote service.

Git 子进程的 stdin/stdout/stderr 管道错误会拒绝当前操作，不能以退出码 0 掩盖可能丢失的输出，也不能让未处理的流错误终止整个本地 API。独立工作区初始化仍将错误投影为 WORKSPACE_GIT_INIT_FAILED；不会修改系统长路径策略或全局 Git 配置。Windows 的过长 cwd 仍可能不受子进程支持，客户端生成的项目组件保持短名；用户选定根路径过长时应显示具体操作失败。
