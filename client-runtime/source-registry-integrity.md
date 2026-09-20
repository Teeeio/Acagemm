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
  不参与判定。理由：引用级错误讲的是「某个 mission 声称用了什么」，不是来源根自身状态——
  候选自报来源可以指向未登记的仓库，也可以指向一个已被上游推进的历史 commit（Source Registry
  按 `仓库@commit` 逐条留存，同一仓库可同时存在多个 commit 条目，而来源根只可能匹配当前 HEAD）。
  以整份 `errors` 为依据，巡检就会因 mission 级声明问题报「来源被改」，真信号被噪声淹掉。
  （历史上还有一条噪声：注册端写 `path: ''` 导致 `SOURCE_REFERENCE_PATH_INVALID` 恒定出现；
  2026-09-20 起仓库级引用成为一等 scope，该噪声已消失，但本约束不依赖它——理由如上，与注册端写法无关。）
- **modified 优先于 unverifiable。** 两者同时存在时 `verdict = 'modified'`：被改过是可证结论，
  读不出来只是不可知。两者都会停自动流转，但理由码不同，消费者不得把后者说成前者。
- `inspection` 缺失 / `errors` 非数组 ⇒ `clean`。判定不臆造证据：没有错误码就没有结论。
- 纯函数、全定义：不抛错，不做 I/O。
- 不改写 `inspection`，也不补齐缺失字段。

## Non-Responsibilities

- 不做巡检本身（`workspace-manager.mjs` 的 `inspectSources`）。
- 不做升级动作：不写 `loopStatus`、不发事件、不碰 `mission.status`
  （`application/source-registry-integrity-service.mjs`）。
- 不判定引用级证据是否成立：引用级错误码只如实回传进 `ignored`。判定引用是
  `workspace-manager.mjs` 的 `inspectSources` 的事，不在本模块职责内。
- 不声称覆盖全部改动形式：来源被改动且**已提交**、同时又**没有** `operatorStudio.sourceTree`
  登记时，本模块看不到（`inspectSources` 在该路径上退化成「无 pin 即无约束」）。
  这是已知残余缺口，未被本模块或上游堵住。
