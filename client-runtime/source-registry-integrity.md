# Source Registry Integrity Module Contract

模块归属：`client-runtime/` 根级纯叶子模块。不做 I/O、不 spawn 进程、不读时钟、不 import 运行时实现，
供 `application/source-registry-integrity-service.mjs` 与测试共用。

## Purpose

判定一次 Source Registry 巡检的结论：来源是**被改过**、**核验不了**，还是**干净**。

第三方来源是固定引用。来源根被改动后，以它为材料基线的自动流转不再可信，必须停下等人裁决。
本模块只做归类，不做升级动作（升级在应用服务里）。

## Public API

| 导出 | 说明 |
|---|---|
| `classifySourceRegistryIntegrity({ inspection })` | `{ verdict, modified, unverifiable, ignored, ignoredCodes, reasonCode }` |
| `SOURCE_MODIFIED_CODES` | `['SOURCE_REPOSITORY_DIRTY', 'SOURCE_REPOSITORY_TREE_MISMATCH']` |
| `SOURCE_UNVERIFIABLE_CODES` | `['SOURCE_REPOSITORY_INVALID', 'SOURCE_ROOT_ENTRY_INVALID', 'SOURCE_PATH_OUTSIDE_REGISTRY']` |

`verdict` ∈ `clean` / `modified` / `unverifiable`；`reasonCode` 为 `null` /
`source_root_modified` / `source_root_unverifiable`。

## Invariants

- **只认来源级错误码。** 引用级错误码（`SOURCE_REFERENCE_*`）与任何未知码一律进 `ignored`，
  不参与判定。理由：`application/source-service.mjs` 注册来源时会写 `path: ''`，
  于是 `SOURCE_REFERENCE_PATH_INVALID` 会稳定出现；若以整份 `errors` 为依据，每次巡检都会
  报「被改」，真信号被噪声淹掉。
- **modified 优先于 unverifiable。** 两者同时存在时 `verdict = 'modified'`：被改过是可证结论，
  读不出来只是不可知。两者都会停自动流转，但理由码不同，消费者不得把后者说成前者。
- `inspection` 缺失 / `errors` 非数组 ⇒ `clean`。判定不臆造证据：没有错误码就没有结论。
- 纯函数、全定义：不抛错，不做 I/O。
- 不改写 `inspection`，也不补齐缺失字段。

## Non-Responsibilities

- 不做巡检本身（`workspace-manager.mjs` 的 `inspectSources`）。
- 不做升级动作：不写 `loopStatus`、不发事件、不碰 `mission.status`
  （`application/source-registry-integrity-service.mjs`）。
- 不顺带修 `path: ''` 那个注册缺陷：本模块只是不让它污染判定。
- 不声称覆盖全部改动形式：来源被改动且**已提交**、同时又**没有** `operatorStudio.sourceTree`
  登记时，本模块看不到（`inspectSources` 在该路径上退化成「无 pin 即无约束」）。
  这是已知残余缺口，未被本模块或上游堵住。
