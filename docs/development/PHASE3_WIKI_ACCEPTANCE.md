# Phase 3 验收说明（KernelWiki 导入 + 确定性选择）

本文件是**读者说明**，不是证据本体，也不是诊断副本：结果、计数、失败细节与边界一律以
[`evidence/p3-wiki-20260915/status.json`](evidence/p3-wiki-20260915/status.json)（单一事实源，
SHA-256 锁定）和该目录下的原件为准。设计权威是
[`TEAM_HANDOFF.md`](TEAM_HANDOFF.md) §6 方案 D 与 §8.4；冻结实现契约是
[`PHASE3_WIKI_CONTRACT.md`](PHASE3_WIKI_CONTRACT.md)。

## 1. 一句话结论

Phase 3 的**软件批次**已完成：KernelWiki 固定源导入、确定性选择器和现有生产 API/prepare
集成均已独立验收并集成，生产实现提交为 `bb3ddd5dfbe9285ec982c795ede04595edcf69cf`
（其后仅由 Root 补充 review 主题词，生产代码未再改动，`status.json` 已锁定）。
**本批没有任何新的实机模型或 GPU 业务运行**：新的生产版本没有新增实机 E2E 或 N20；
「无经验 / 仅本地经验 / 本地+已审查 Wiki」三条件的**策略收益仍待验证**，因此本批
**不宣称性能收益，也不宣称发布能力**（`publishable=false`）。

旧实机结论（严格 N20 20/20 等）**只对冻结源 `21c6d7868bd3c5aa74dfcc098f87e3ad4236f948`
及其固定矩阵有效**，不能被读作新生产版本的证据，也不能因为工作树 git clean 或无生产变更
就当成新 HEAD 的实机结论。

## 2. 本批已验收的软件成果

- 新增用例 **31** 个（import 8 / selection 16 / runtime 7）全部通过；门禁
  `release 147 / non-hardware 44`，exit 0（916.578 s），boundary recipe 通过，
  release 同时在该次 non-hardware 门禁内执行——计数是套件结果，不代表 294 个互不相同的
  release 检查。
- 固定源真实构建：KernelWiki commit `b6b4301f15e8ce6955a56776690643ce5db369e6`
  实际 **52 页 / 54 单元**。
- 幂等：隔离 Runtime 内两次导入，首次 `created 54`、第二次 `unchanged 54`，
  存储逐字节稳定、Runtime 状态未变、无重复。
- 实际选择：两条 sm86 `reviewed-transfer` 建议（kernel-fusion、vectorized-loads）进入
  最终 prompt；其中**经验注入区块**的 `renderedBytes` 为 6 383 UTF-8 字节，**不是**完整 prompt
  的长度，prompt 上下文已绑定；`publishable=false`。
- 集成清单（25 个文件）与逐文件 SHA-256 见 `status.json` 的 `integratedManifest`。

## 3. 固定源、审查与 snapshot 身份

| 身份 | 值 |
|---|---|
| KernelWiki 源 commit | `b6b4301f15e8ce6955a56776690643ce5db369e6` |
| snapshot 摘要 | `c849536ce799c7de4ac88fc770fb5f66ebad72350a92af42a8acb96d83557cd4` |
| snapshot 文件 | [`evidence/p3-wiki-20260915/snapshot.json`](evidence/p3-wiki-20260915/snapshot.json) |
| 审查文件 | [`kernel-wiki-reviews.json`](kernel-wiki-reviews.json)（SHA-256 `77185972…2a693`） |
| CLI 用法冻结副本 | [`scripts/import-kernel-wiki.md`](../../scripts/import-kernel-wiki.md)（SHA-256 `1b33df90…f358d`） |
| 旧实机冻结源（仅旧 N20） | `21c6d7868bd3c5aa74dfcc098f87e3ad4236f948` |

审查条目是**项目方的适用性断言**，不是模型或 provider 验证；导入内容一律
`source=human` / `kind=guidance` / `confidence=low` /
`verification={status:'unverified', evidenceClass:'human-guidance', publishable:false}`，
标注为 unverified 建议。上游页面嵌套的 `performance_claims` **不作为**选择或测量依据，
本文件也不对其具体存储形态作断言。未被审查的页面照常入库，但永不自动注入。

## 4. 必要用法（只有这一套流程）

### 4.1 CLI：生成导入 snapshot（不写生产存储）

```bash
node scripts/import-kernel-wiki.mjs --source PATH --commit HEX --out NEWFILE [--reviews JSONFILE]
```

- `--source`：KernelWiki 的本地克隆（裸库或工作树均可，**工作树内容永不读取**）；
  `--commit`：40 位小写 commit；`--out`：要写出的新文件名，必须**尚不存在**且解析后不在
  `--source` 内（否则 exit 2）；`--reviews`：可选审查断言 JSON（例如
  `docs/development/kernel-wiki-reviews.json`），按原样读取、绝不放宽。
- 只读该 commit 下的 `wiki/**.md` blob 与 `LICENSE`，不 checkout / fetch / 修改源，
  不读脏工作文件，无网络、无模型、无 GPU。
- exit code：`0` 写出 snapshot，`2` 用法错误，`1` 读取或构建失败。输出使用独占 `wx` 标志，
  **不会覆盖或截断已存在的文件**；读取、解析或构建失败时不产出可用 snapshot，因此也没有任何
  内容会被导入存储（导入只发生在 4.2 的 HTTP 步骤）。
- 它**只生成一个 snapshot 文件**，不写 Runtime 存储、不实现 workflow。

### 4.2 HTTP：经生产 API 导入（唯一写入口）

CLI 生成的文件由操作者导入到隔离 Runtime 的生产 API：

```http
POST /api/projects/:projectId/experiences/import-kernel-wiki
{ "snapshot": <snapshot.json>, "author": "<author>" }
```

- 该路由在通用 experience ID 匹配器之前匹配；请求体仍是既有有界读取器（上限 **1 MiB**），
  超过即显式失败，**不要**为了导入而放宽服务端请求上限。
- body 只接受 `{snapshot,author}`；其它键为 `EXPERIENCE_INVALID`。项目不存在为
  `EXPERIENCE_PROJECT_NOT_FOUND`（404）。成功的**线上 HTTP 响应是 HTTP 200，JSON body 直接是
  导入结果** `{created,updated,unchanged,records,sourceCommit,snapshotDigest}`；
  `{statusCode,payload}` 只是**内部应用服务**的封装返回值，不是线上 body 形状。
- 应用层在**唯一一次** `repository.transact` 内调用纯 apply：全部单元原子写入，无部分导入；
  同一 snapshot 重复导入为 no-op（记录与 revision 不变），内容或来源变化经 `expectedVersion`
  推进同一 ID，旧版本保留，绝不删除；同 ID 冲突是显式错误，不覆盖。
- `selectionMetadata` **只能**经这条导入 API 写入；通用 create/update 显式拒绝该字段。
- 接口细节见 [`client-runtime/kernel-wiki-import.md`](../../client-runtime/kernel-wiki-import.md)、
  [`experience-selection.md`](../../client-runtime/experience-selection.md)、
  [`server/experience-routes.md`](../../client-runtime/server/experience-routes.md)、
  [`experience-api-service.md`](../../client-runtime/application/experience-api-service.md)。
  这里是**现有**生产链路的用法说明，没有第二套导入器、调度器或向量库。

选择策略由 prepare 走既有 `retrieveWithSelection` 路径消费，策略版本
`operator-studio.optimization-hypothesis-selection/v1`；症状（symptom）始终是**待验证假设**，
不是已测瓶颈。渲染与上下文仍受既有 20 条 / 64 KiB / 8 000 字符硬上限约束。

## 5. 安全边界与明确不宣称的内容

- 本轮**没有**新的实机模型调用、GPU 运行或 N20；`status.json` 的
  `limits.newLiveModelOrGpuBusinessRuns = 0`、`newSourceN20 = "not_run"`。
- 三条件收益研究 `pending`，性能收益 `not_established`，`publishable=false`。
- 导入内容与审查断言不授予发布权、运行权或证据资格。
- 未审查页面永不自动注入；架构不适用页面仍然入库（全量入库、按目标硬件过滤）。
- 不把旧的 N20 当作新 Phase 3 的通过证明；也不因本批软件通过而宣称 Phase 3 阶段整体结项。
- 失败、返工、被拒与被取消的尝试**原样保留**，不计入成功样本；具体细节统一看
  [`status.json`](evidence/p3-wiki-20260915/status.json) 的 `issues` 与
  `final-gate/candidate-verification.json`。

## 6. 证据链接

- 单一事实源：[`evidence/p3-wiki-20260915/status.json`](evidence/p3-wiki-20260915/status.json)
- 最终门禁：[`final-gate/result.json`](evidence/p3-wiki-20260915/final-gate/result.json)、
  [`final-gate/candidate-verification.json`](evidence/p3-wiki-20260915/final-gate/candidate-verification.json)、
  [`final-gate/verification.json`](evidence/p3-wiki-20260915/final-gate/verification.json)
- 生产 API 审计（两次导入、幂等、选择、prompt 字节）：
  [`production-api/result.json`](evidence/p3-wiki-20260915/production-api/result.json)、
  [`production-api/final-prompt.txt`](evidence/p3-wiki-20260915/production-api/final-prompt.txt)
- 首次导入与快照身份：[`initial-api/execution.json`](evidence/p3-wiki-20260915/initial-api/execution.json)、
  [`initial-snapshot.json`](evidence/p3-wiki-20260915/initial-snapshot.json)、
  [`pure-audit.json`](evidence/p3-wiki-20260915/pure-audit.json)
- 旧实机验收（仅 `21c6d78` 有效）：
  [`run-diagnostics-20260914/acceptance.json`](evidence/run-diagnostics-20260914/acceptance.json)、
  [`closeout-20260915/closeout.json`](evidence/closeout-20260915/closeout.json)

## 7. 后续方向：三条件开发验收（上游未启动）

下一步是**受控的三条件开发验收**，用于回答「审查过的 Wiki 是否带来可测收益」：
无经验（no experience）/ 仅本地经验（local experience）/ 本地经验 + 已审查 Wiki
（local plus reviewed Wiki）。

- 三个条件必须使用**相同的工作负载、相同的任务预算与相同的 Profile/矩阵**；
  样本量、批次划分与是否启动由上游决定，本文件与实现者**不自行选定样本量，也不启动实验**。
- 比较前先验证选中项的证据确实进入最终 prompt（`prepared-before-send` 审计只证明生产准备了
  什么，不证明外部服务收到或遵守）。
- 结果按既有 `REAL_GPU_REGRESSION.md` 规则记录：同一完整配置指纹才可合并成 N，
  失败/unknown 保留在分母，`unknown` 模型绝不回填，旧 N20 不重新入池。
- 三条件未完成前，Phase 3 只按「软件已验收、收益待验证」表述。
