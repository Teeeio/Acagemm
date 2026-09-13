# 真实 shared-GPU Agent 回归原始证据归档（2026-09-13）

本目录按原字节归档 Root 已完成、并已由独立离线 reader 深核的 21 个真实 shared-GPU
Agent 运行原件，以及配套的最终报告、账本与运行日志。**只归档，不重跑**：归档过程没有
启动任何模型 / GPU / Runtime / 网络，没有改写、移动或删除任何原件，也没有修改生产代码。

- 归档日期：2026-09-13
- 归档范围：`n20-index.json` 的 20 个 affine runRoot + 独立覆盖 run `shared-gpu-yj5NVB`，共 **21 个唯一真实 root**
- 证据边界：provider-reported 元数据，不是远端服务认证；`publishable=false`
- 本归档**不**声称 N=20 通过，**不**声称整个迭代流程稳定

## 1. 结论摘要

| 项目 | 结果 |
| --- | --- |
| 真实 affine 独立调用 | 20（唯一 root 20），全部 `full_success` |
| affine 同指纹可比样本 | **19**（指纹 `sha256:d09574cc…c8bc15`） |
| 第 2 次 affine 调用 | `full_success` 但**不可比**（指纹 `sha256:18d788cf…dad1d4f`，`provider.model` unknown） |
| 严格 N20（≥20 同指纹全 `full_success`） | **未通过（false）**；**无替补、未补第 21 次** |
| 独立 reduction + normalization 覆盖 | 1 次 `full_success`（`shared-gpu-yj5NVB`），**单独计覆盖，不并入 affine N20** |
| 离线独立深核（reader v3） | 21/21 通过，`reasons` 0、`gaps` 0，`strictN20Eligible=false` |
| 成功候选 | affine 40 + 覆盖 4 = 44，**44 个 digest 互不相同** |
| affine 候选任务 | 47 = 40 completed + 7 failed |
| 失败保留 | 7 个失败候选全部保留；成功恢复**不**抹去缺陷 |
| 全部 stop / 资源释放 | 全部确认（`allStopsConfirmed=true`、`allTasksReleased=true`） |

统计来源：本目录 [`reports/final-root-assessment.json`](reports/final-root-assessment.json)
与 [`reports/final-independent-verification.json`](reports/final-independent-verification.json)（两者为归档原件，未改写）。

## 2. 归档内容

| 路径 | 内容 |
| --- | --- |
| `retained-runs.zip`（**Release 附件**，不入本仓库） | 21 个真实 root 的**全部普通文件**原字节 ZIP，entry 为 `shared-gpu-<rand>/<相对路径>`；取得与校验见第 8 节第 1 步 |
| [`archive-manifest.json`](archive-manifest.json) | schema、21 root 原地址、每 root 文件数/字节数、每 ZIP entry 的 path/bytes/sha256、ZIP hash，以及复制 reports/logs 的原 source 路径与 bytes/sha256 |
| [`reports/`](reports/) | 10 份最终报告/账本原件（下方清单） |
| [`logs/`](logs/) | 21 份运行日志原件 |
| [`verify-retained-runs.mjs`](verify-retained-runs.mjs) | 冻结的只读离线验收 reader（本任务逐字只读，未修改） |
| [`preflight-audit.md`](preflight-audit.md) | 既有只读静态预审（本任务逐字只读，未修改） |
| [`.gitattributes`](.gitattributes) | JSON/log 保持原始字节（`-text`），ZIP 标记 binary |
| [`.gitignore`](.gitignore) | 仅在本目录重新放行被根 `.gitignore` 的 `*.log`，不改根配置 |

### 2.1 reports/（10 份，字节原样）

1. [`n20-plan.json`](reports/n20-plan.json) — 冻结批次计划、冻结配置、矩阵与预算
2. [`n20-index.json`](reports/n20-index.json) — 20 个 affine root 的索引、outcome、fingerprint、日志名
3. [`n20-resume-decision.json`](reports/n20-resume-decision.json) — 第 2 次取消后的暂停/恢复决定（继续剩余 18 次、不替换、不补第 21）
4. [`final-independent-verification.json`](reports/final-independent-verification.json) — reader v3 对 21 原件的最终独立报告
5. [`final-n20-ledger.json`](reports/final-n20-ledger.json) — 冻结账本（分组、分母、n20 资格）
6. [`final-root-assessment.json`](reports/final-root-assessment.json) — Root 最终评估（统计、冻结源、失败明细、逐次调用）
7. [`runner-correctness-fact-loss.json`](reports/runner-correctness-fact-loss.json) — 失败 correctness 事实丢失缺陷的根因链
8. [`affine-smoke-execution.json`](reports/affine-smoke-execution.json) — affine 两轮 smoke 执行记录
9. [`family-coverage-execution.json`](reports/family-coverage-execution.json) — reduction/normalization 覆盖执行记录
10. [`reader-v3-root-negative-probes.json`](reports/reader-v3-root-negative-probes.json) — reader v3 负例探针（`fixtureOnly:true`）

### 2.2 logs/（21 份，字节原样）

- [`affine-smoke.log`](logs/affine-smoke.log)（对应 index 1）
- `affine-n20-02.log` … `affine-n20-20.log`（共 19 份，对应 index 2–20）
- [`family-coverage.log`](logs/family-coverage.log)（对应覆盖 run）

### 2.3 明确排除的内容（防止 synthetic 混入）

- `reader-v2-fixtures/`、`reader-v2-root-negative-probes.json` 等 **fixture-only / synthetic** 内容**未**进入 ZIP；
- 历史其他 root（`.tmp-real-agent` 下 9 月上旬的旧目录）与 24 条旧/异 provider 记录**未**归档；
- 未读取、未拷贝任何宿主配置或凭据；`runtime/git-trust/*.gitconfig` 只是 run 内部生成的
  `safe.directory` + 合成身份（`Operator Studio <operator-studio@local.invalid>`），随原件原样归档；
- `offline-reader-v1-root.json` / `offline-reader-v2-root.json` 属早期读者审查失败报告，**未**纳入本
  证据归档，仍只保留在 Root 原目录，不得当作真实样本证据。

## 3. 冻结配置（批次期间未改）

来自 [`n20-plan.json`](reports/n20-plan.json) 的 `frozenConfig`：

| 维度 | 值 |
| --- | --- |
| provider runtime | `claude-code`（**CLI/运行器**，不是模型） |
| CLI 版本 | `2.1.232 (Claude Code)`，来源 `runtime-descriptor` |
| 响应模型 | `deepseek-v4-flash`，来源 `observed`（`assistant.message.model`） |
| backend | `local-shared-gpu`，`executionMode=gpu`，`publishable=false` |
| hardware | NVIDIA GeForce RTX 3060 Laptop GPU，driver 551.78，sm86，6144 MiB |
| torch / cuda | `2.6.0+cu124` / `12.4`（来自真实任务 `targetProbe`） |
| families | `['affine']` |
| candidateTasks | 2 |
| matrix | correctness 4 cases（minimal/representative/boundary/ragged，atol=rtol=1e-5），warmup 3，repeats 10，profiles `primary`/`small` |
| budgets | mission 720000 ms，mainAgent 180000 ms，logicalCleanup 60000 ms，taskTimeout 120 s |
| code commit | `887c98bc3d115380a769e09d4a96c8a9e34626de` |
| code contentDigest | `sha256:6ceb6b82cc1f0dfbbe2c5a06b9586bdc43735020e312d4e6dae0a25d3953b4f4` |
| dirty | `dirty=true`，`dirtyFileCount=2` |
| prompt policy | `operator-studio.experience-selection/v1+scope-match+updatedAt-desc-id-asc`，roundFacts `operator-studio.round-facts/v1` |

冻结源核验（[`final-root-assessment.json`](reports/final-root-assessment.json) → `frozenSource`）：
`sourceFileCount=313`，`allMatched=true`，即 313 个参与源文件 SHA-256 **最终全部匹配**；dirty 的 2 项为
用户原有未追踪文件（`?? .dispatch/`、`?? docs/development/TEAM_HANDOFF.md`），**不是**本批次产生。
**固定矩阵与预算没有修改**；执行代码、请求配置与预算未人为变更；55 次调用中 **54 次已观测**响应
标签一致，另有 **1 次保持 `unknown`**，不对其模型作任何推断（详见 §5）。

## 4. affine N20 结果（逐次）

| index | runRoot（basename） | outcome | 可比 | fingerprint 前缀 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 1 | `shared-gpu-Sx7jVn` | full_success | 是 | `d09574cc` | affine-smoke.log |
| 2 | `shared-gpu-nGBRDg` | full_success | **否**（`provider.model` unknown） | `18d788cf` | affine-n20-02.log |
| 3 | `shared-gpu-vLyEX5` | full_success | 是 | `d09574cc` | affine-n20-03.log |
| 4 | `shared-gpu-JiyKnZ` | full_success | 是 | `d09574cc` | affine-n20-04.log |
| 5 | `shared-gpu-McoGAb` | full_success | 是 | `d09574cc` | affine-n20-05.log |
| 6 | `shared-gpu-1SRaGR` | full_success | 是 | `d09574cc` | affine-n20-06.log |
| 7 | `shared-gpu-GiQwdT` | full_success | 是 | `d09574cc` | affine-n20-07.log |
| 8 | `shared-gpu-X69hIj` | full_success | 是 | `d09574cc` | affine-n20-08.log |
| 9 | `shared-gpu-lfFBiu` | full_success | 是 | `d09574cc` | affine-n20-09.log |
| 10 | `shared-gpu-WvSCLT` | full_success | 是 | `d09574cc` | affine-n20-10.log |
| 11 | `shared-gpu-FO1IVw` | full_success | 是 | `d09574cc` | affine-n20-11.log |
| 12 | `shared-gpu-ZcRfwY` | full_success | 是 | `d09574cc` | affine-n20-12.log |
| 13 | `shared-gpu-iNT7Ta` | full_success | 是 | `d09574cc` | affine-n20-13.log |
| 14 | `shared-gpu-8Q8JpK` | full_success | 是 | `d09574cc` | affine-n20-14.log |
| 15 | `shared-gpu-soPHyY` | full_success | 是 | `d09574cc` | affine-n20-15.log |
| 16 | `shared-gpu-EFHl4V` | full_success | 是 | `d09574cc` | affine-n20-16.log |
| 17 | `shared-gpu-CwAlvs` | full_success | 是 | `d09574cc` | affine-n20-17.log |
| 18 | `shared-gpu-8pX9jL` | full_success | 是 | `d09574cc` | affine-n20-18.log |
| 19 | `shared-gpu-IVSPpH` | full_success | 是 | `d09574cc` | affine-n20-19.log |
| 20 | `shared-gpu-S24jNc` | full_success | 是 | `d09574cc` | affine-n20-20.log |
| 覆盖 | `shared-gpu-yj5NVB` | full_success | 是（覆盖组） | `0255dee3` | family-coverage.log |

- 20 次 affine 全部 `full_success`，**没有丢样、没有补样**；严格 N20 需要 **≥20 个同指纹**全成功，
  本批次同一可比指纹只有 **19** 个，因此严格 N20 = **false**。
- 第 2 次（`shared-gpu-nGBRDg`）真实 `full_success`、release 已确认，但其 3 个 required model run 中
  有一个 **cancelled run 只发出 init**、没有 `assistant.message.model`，响应模型保持 **unknown**（真实，
  不能由 init/env/usage 标签补），故该次不可比；`n20-resume-decision.json` 明确决定
  **继续剩余 18 次、不替换第 2 次、不加第 21 次**。
- `n20.eligible` 只是**可比性/分母资格**标志，**不等于**严格 N20 通过；此处严格判定来自
  `strictN20` 与 `n20.eligible` 之外的 `full_success===runs` 核对（见 `final-n20-ledger.json`）。

## 5. 模型观测

- affine：**51** 个模型调用（required model runs），**50 observed**；唯一 unknown 是第 2 次中只发出
  init 的 cancelled run `claude_MTZ4S0GP_97CF866B`（`provider.model` unknown → 该 run 不可比）。
- 覆盖 run：4 个模型调用，**4/4 observed**。
- 合计 **55** 次调用；所有 observed 记录的 provider-reported 响应标签均为 **`deepseek-v4-flash`**。
- **`Claude Code` 是 CLI/运行器，不是模型**；`system.init.model`（旧 P1 记录里的 Claude 标签）与
  `result.modelUsage` key 只是诊断，**不能**当作响应模型。响应身份只认 `assistant.message.model`。
- 第 13 次有 2 个、第 15 次有 1 个研究（research）run（`claude_research_*`，均 `completed`、
  `modelObservationStatus=observed`），属于**生产内恢复流程**，**不是死锁**。

## 6. 候选与失败（全部保留，成功恢复不抹去缺陷）

- affine 候选任务 **47** = **40 completed** + **7 failed**；失败发生在第 **8、13、15、16** 次调用，
  每次都自动回滚并继续，最终该次仍为 `full_success`；失败候选、原 stderr 均在 ZIP 原件中保留。
- **6 次真实 correctness case 1 失败被结构化误写为 `not_run`**，且 `experienceEvidencePresent=false`
  （失败事实与执行经验绑定丢失）：

  | 次 | 失败候选数 | 原始失败摘要 | 原 stderr SHA-256（前缀） |
  | --- | --- | --- | --- |
  | 8 | 1 | `correctness failed on case 1`，max abs diff 0.125（tol 1e-5） | `596477fc…` |
  | 13 | 2 | `correctness failed on case 1`，max abs diff 0.3999999761581421 | `d4f24c49…` |
  | 15 | 3 | `correctness failed on case 1`，max abs diff 0.25 | `5756e072…` |

- 第 **16** 次的首次候选是**另一类**失败：`addcmul(): argument 'tensor2' (position 3) must be Tensor,
  not float`——这是**执行类型错误**，与上表 6 次数值 correctness 失败不是同一事实；但它的结构化结果
  同样被 generic fallback 记为 `not_run`（`structuredCorrectness.status=not_run`、`caseResults` 为空，
  与 6 次相同），因此**不能**说它“不是 `not_run`”。stderr SHA-256 `9e2ea171…`。
- 根因链（[`reports/runner-correctness-fact-loss.json`](reports/runner-correctness-fact-loss.json)）：
  `tools/local-c500-runner.py:202` 返回详细 failed correctness → `:606` 在 result 落盘前抛
  `RuntimeError` → `:686` 捕获后返回 1 且**不写 result** → `tools/local-shared-gpu-runner.py:269`
  的 fallback 归类成 generic backend failure / `not_run`。
- 每个失败候选的 `resourceRelease.confirmed=true`；全部 stop 与资源释放确认，无遗留任务。

## 7. 独立离线深核（reader v3）

[`reports/final-independent-verification.json`](reports/final-independent-verification.json)：

- `result.ok=true`、`exitCode=0`、`runCount=21`、`fullSuccessRuns=21`、`verifiedRuns=21`、
  `strictN20Eligible=false`；
- 21 个 run **全部 `passed=true`**，`reasons`（提供但矛盾的阻断证据）为 0，`gaps`（缺失证据）为 0；
- 冻结 helper 哈希与当前仓库一致：`scripts/shared-gpu-acceptance.mjs`
  `sha256:242d3fe2…7955`、`scripts/summarize-gpu-agent-runs.mjs`
  `sha256:91bbab8a…0c2aa1`、`client-runtime/model-observation.mjs`
  `sha256:2625f6fb…5143d`；
- 覆盖统计：`invocations=21`、`families=['affine','normalization','reduction']`、
  `candidateTasks=44`、`distinctCandidateDigests=44`、`modelRuns=55`、`models=['deepseek-v4-flash']`。

离核查验范围（reader 逐 run 独立重算，不采信落盘 summary）：每个 run **只读自身 runRoot**；
经验原文 id/version/全文、`roundFacts`、候选与 queue/request 绑定、`workspaceClean` 回滚、
`verifyContinuationAudit` 的 8 条不变量、两个**不同**候选 digest、每行 correctness 4/4 与
`primary`/`small`、stop receipt（含 202 需后续只读状态证明）、`workflowWritesAfterStart=0`、
以及 required model runs 覆盖每个已启动 run。不会去搜索宿主或历史目录，也不会回填旧数据。

## 8. 离线复核步骤（可独立复现）

> 复核只读；不要把 ZIP 解压覆盖到任何原件目录。

1. 先取得 `retained-runs.zip` 并**核对 SHA-256**。该 ZIP **不由本仓库分发**：本体 287197411 bytes，
   超过 GitHub 单文件 100 MiB 上限，因此作为 Release 附件发布；哈希值记录在第 9 节。

   ```powershell
   $repo = (Get-Location).Path
   $evid = Join-Path $repo 'docs/development/evidence/live-regression-20260913'
   $zip  = Join-Path $env:TEMP 'retained-runs.zip'

   Invoke-WebRequest -Uri 'https://github.com/Teeeio/Acagemm/releases/download/evidence-live-regression-20260913/retained-runs.zip' -OutFile $zip

   $sha = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
   if ($sha -ne '272467fc11d461198e23419519ef129571ea3f4d6941dc9301bb0302bc7cde54') {
     throw "retained-runs.zip SHA-256 不匹配，停止复核：$sha"
   }
   ```

   附件地址与哈希同时由本目录的 `archive-manifest.json` 独立佐证；两者对不上时以 manifest 为准并停止复核。

2. 在**当前仓库根**执行下面的完整 PowerShell 脚本：它从当前仓库解析路径、用 `Guid` 建立**唯一的**
   独立解压目标（不覆盖任何既有解压目录）、从归档的 `reports/n20-index.json` 读取 20 个原 root 的
   **basename**、再加上覆盖 root `shared-gpu-yj5NVB` 构造 21 个显式路径，然后调用 reader：

   ```powershell
   $scratch = Join-Path $env:TEMP ('retained-runs-check-' + [guid]::NewGuid().ToString('N'))

   Expand-Archive -Path $zip -DestinationPath $scratch -Force

   $index = Get-Content (Join-Path $evid 'reports/n20-index.json') -Raw | ConvertFrom-Json
   $roots = @($index | ForEach-Object { Join-Path $scratch (Split-Path -Leaf $_.runRoot) })
   $roots += Join-Path $scratch 'shared-gpu-yj5NVB'

   & node (Join-Path $evid 'verify-retained-runs.mjs') --repo $repo @roots
   ```

3. 期望：stdout 单一 JSON，`result.ok=true`、`runCount=21`、`verifiedRuns=21`、
   `strictN20Eligible=false`；退出码 0。

说明：原件内部历史记录中的**绝对路径字符串不改写**（ZIP 按原字节保存），reader 用**原件相对内容**
重新核验，不依赖宿主目录。ZIP 中所有 runRoot 条目齐全，21 条路径都存在。

## 9. 归档完整性

| 项 | 值 |
| --- | --- |
| `retained-runs.zip`（Release 附件） | 34956 entries，287197411 bytes，SHA-256 `272467fc11d461198e23419519ef129571ea3f4d6941dc9301bb0302bc7cde54`（取得方式见第 8 节第 1 步） |
| `archive-manifest.json` | 9253956 bytes，SHA-256 `0ffd3987ecdfc96145daf73b14436b471ed424c44d16349f15a489c3aa3eabf3` |
| 21 root 汇总 | 34956 个普通文件，630215307 bytes（每 root 明细见 manifest `roots[]`） |
| 复制 reports | 10 份，字节原样（source→archive 路径、bytes、sha256 见 manifest `reports[]`） |
| 复制 logs | 21 份，字节原样（同上，见 manifest `logs[]`） |

manifest 逐项记录 ZIP 每个 entry 的 `path`/`bytes`/`sha256`，可用于与解压结果逐文件对照；
复制文件**未做**任何文本转换（换行、编码、BOM 均保持原样），ZIP 内文件内容亦为原字节。

## 10. 后续工作（本任务不做，不修生产）

1. **先修失败结果的结构化落盘与身份绑定经验回流**：让 failed correctness 与其身份、错误阶段在
   `return` 之前被序列化，经验绑定不再因 `EXPERIENCE_BINDING_MISSING` 丢失；
2. **核查无响应取消的观测终止路径**：取消/无响应必须保持 unknown 并可终止，**不能伪补 model**；
3. 上述修复后**冻结新版本**，再另起新的 N20 批次（新指纹、不合并本批样本）。

本任务**不修改生产代码**、**不重跑** 139/41 门禁、**不启动**模型/GPU/网络，也**不声称**
整个流程已经稳定或可发布。

## 11. 明确非声明

- 无 N=20 稳定性结论，无长跑稳定性结论，无真实仪器/发布级结论；`publishable=false`。
- provider-reported 模型标签不是远端服务认证；`prepared-before-send` audit 只证明生产准备了什么，
  不证明真实 provider 收到或遵从。
- 20 次 affine `full_success` **不等于**严格 N20 通过；`n20.eligible` 只是样本/分母资格。
- 覆盖（reduction/normalization）与稳定性是两个独立结论，覆盖 run 不并入 affine N20。
- 本归档不改写任何历史证据、`TEAM_HANDOFF`、账本或生产源；旧拒绝记录保持历史原样。
