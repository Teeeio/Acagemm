# 失败结果结构化回流：修复记录与独立验证入口（2026-09-13）

本目录是失败反馈修复的**静态证据入口**：记录已集成代码修复了哪些旧失败事实、
Root 做过哪些独立硬件自由（hardware-free）验证，以及哪些真实 GPU 结论**尚未**产生。

- 冻结契约：[`FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md`](../../FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md)
  （sha256 `55727780c161a2068b27702339df702737d9eaed78e5c2c29d6a1d72b182fbbb`）
- 测试模块总览：[`tests/README.md`](../../../../tests/README.md)
- 历史真实批次原件：[`live-regression-20260913/README.md`](../live-regression-20260913/README.md)
- 旧失败根因链：[`runner-correctness-fact-loss.json`](../live-regression-20260913/reports/runner-correctness-fact-loss.json)
- 取消/unknown 审计：[`NO_RESPONSE_OBSERVATION_AUDIT.md`](../../NO_RESPONSE_OBSERVATION_AUDIT.md)

## 1. 旧失败 → 现在的行为

旧真实批次（见 [`live-regression-20260913`](../live-regression-20260913/README.md) §6）暴露的事实：
`tools/local-c500-runner.py` 已算出详细 failed correctness，却在 result 落盘前抛
`RuntimeError`，由 `tools/local-shared-gpu-runner.py` 的 fallback 归类成 generic backend
failure / `not_run`，`experienceEvidencePresent=false` —— **失败事实与执行经验身份绑定
一起丢失**。其中 6 次是真实数值 correctness case 1 失败，第 16 次首次候选是另一类
`addcmul(): argument 'tensor2' ... must be Tensor, not float` 执行类型错误，两者当时都被
记成 `not_run`。

修复后保留（契约与已集成代码）：

- **attempted prefix 保留**：`correctness.status=passed|failed|not_run`，`caseResults` 是真实
  已尝试前缀（保留早停），`failedCase` 一基、`failedCaseName`/`failedCaseCategory` 指向真实
  用例；`total` 仍是冻结请求数，不因早停下调。`passedCases=executedCases-1` **只适用
  于 failed 早停分支**（此前用例通过，最后一个失败）；通过分支与 `not_run` 不套用
  该式。
- **typed error 保留**：`result.error`/`correctness.failure`/最后一个失败 case 的 failure 三处
  同值，冻结 `OPERATOR_CORRECTNESS_MISMATCH` / `OPERATOR_CANDIDATE_EXCEPTION` /
  `OPERATOR_ORACLE_EXCEPTION`（phase=correctness，role=candidate/oracle）。`not_run` 指
  **整体 correctness 未执行**（`executedCases=0`、`passedCases=0`、`caseResults=[]`），
  不为未尝试的用例造 case 记录，也不表示某个用例失败或成功。
- **真实 metrics 不伪造**：候选/oracle 抛错时未计算的 metric 为 null/absent，**绝不**补 0；
  正确性失败时 `benchmark=[]`、`publishable=false`、退出码非零，不把失败行写成成功 benchmark。
- **probe / package 保留**：`environment` 保留真实 `targetProbe`/device/driverVersion/可选
  architecture 与 `executionPackage`；缺失 probe 不会退化成宿主默认值，也不会因
  `backend=gpu` 就从 preflight/probe/oracle/backend 失败生成已验证 GPU 观测。
- **原子落盘**：`correctness.json`/`result.json` 经临时文件 + 同目录 `os.replace` 到达最终路径；
  shared normalization 同样原子并**保留**已有 typed failure，不覆盖成 generic `not_run`，
  不复用陈旧成功结果。
- **可信失败验证 / 轮次事实**：consumer 仅在独立读取队列任务、真实 probe、精确
  Mission/candidate/request/package 绑定与 release 全部相符时才接纳失败观测；
  `proof.summary` 确定性携带 typed code、phase/role、失败用例名/类别、计数与真实错误；
  失败详情后缀**上限 2000 字符**：typed code、phase/role、失败用例名/类别与
  total/executed/passed 计数等关键字段保留，错误信息保留**真实前缀**，超长字段被
  截断，因此该摘要不是原始完整 error。同一观测重复收集幂等。
  failed benchmark 状态下顶层 `result.correctness` 是权威，`not_run` 映射为 `not_observed`
  且不伪造 failed case；下一轮 prompt 与 pre-send audit 可见失败 case/code/error 与真实
  experience id/version/content，重试/回滚不替换失败候选身份。

## 2. 独立验证（Root 硬件自由，不是 live GPU）

Root 独立运行并通过下列硬件自由 fixture / 验收；这些是真实 `main()` 入口配合显式
double 的契约证据，**不是** GPU 采样、稳定性或发布结论。各条目时序不同，不统一归类为
“集成后”：`producer-v3-frozen.log` 与额外 fixture 是**集成前对候选目录**的独立测试；
`consumer-boundary-v3-root.log` 是**对 Root 已集成消费端**执行的独立测试（测试包当时未
integrate）；诊断在 producer 集成后。日志位于 Root 本机被忽略的
`.operator-studio-local/failure-feedback-20260913/`（按名引用，未纳入本仓库、未在本工作区重算）。

| Root 运行 | 结果 |
| --- | --- |
| `producer-v3-frozen.log`（Python producer，`tests/shared-gpu-failure-result-test.py`；集成前候选目录独立测） | **13/13 通过** |
| `root-failed-execution-feedback-test.log`（Node consumer 全链，集成后） | **全 6 section 通过** |
| `consumer-boundary-v3-root.log`（`tests/failed-execution-boundary-test.mjs`，对 Root 已集成消费端执行） | **16/16 通过** |
| 额外 fixture：`producer-extra-probes-v3.json` 3 例 + `producer-partial-metrics-v3.json` 断言（集成前候选目录独立测） | **4 项通过** |
| `root-diagnostic-runner-test.log`（producer 集成后） | **24 checks 通过** |

任务 ID 与 digest 分两类，**都不是「Root 运行 digest」**：实现产物的 digest 由平台按
任务给出，测试文件的 sha256 由本工作区对冻结文件只读重算，两者不是同一对象，不能互相
替代或反推。

实现产物（平台 artifact digest）：

| 实现产物 | 实现任务 ID | 平台 artifact digest |
| --- | --- | --- |
| producer（Python runner） | `task_1a92db537b7d4a6897378f3654ab2a14` | `be3367574ce87a3bc319598ec224195ef1a308827dcb98ee5793865c31ed79bc` |
| consumer（Node 验收路径） | `task_43f5f2f75cd141099a6af942012ead2e` | `90be123c3b3771bdc9ee03b7af8c60372cdc152bc0bb12e5b4a608c843ccc08c` |

独立测试文件（冻结件 sha256 + 来源任务）：

| 测试文件 | 来源任务 ID | 文件 sha256 |
| --- | --- | --- |
| `tests/shared-gpu-failure-result-test.py` | `task_0332b55f9c744fd4956a0a52461519eb` | `c21c48678b658bb1af7fa1697c5252d8eea38f20b07a119919b90d61a459ad88` |
| `tests/failed-execution-feedback-test.mjs` | `task_8919403d35014ec59b1540119efe22c1` | `5744a62d202f4f468af60e1ecce023d79474b040506bdc5b7cbe1785d49e4dd9` |
| `tests/failed-execution-boundary-test.mjs` | `task_b4d7dd643dbb4e0dab0fbe926f81b6ac` | `387ad8cb914c954b30200e3819d6c97ae1aca5fdcfa1c3e9aa049c56d5e6692a` |

boundary 边界回归包的 artifact digest
`e9cca40187a032b6d25108868a602a0e8d5b17634feae19b70cfdb38d26523e7` 对应任务
`task_b4d7dd643dbb4e0dab0fbe926f81b6ac`。producer 与 boundary 的测试文件 sha256 由平台
任务的 acceptance_inputs 锁定（不是契约 Markdown 内含 sha 锁表）；三者均已注册进
`package.json` 与**两个**验证门禁。

## 3. 历史真实批次结论保持不变

真实 affine 批次（[`live-regression-20260913`](../live-regression-20260913/README.md)）：
20 次 affine 全部 `full_success`，但同指纹可比样本为 **19 comparable + 1 unknown**
（第 2 次 cancelled run 只发出 init、响应模型真实 unknown），因此**严格 N20 仍未通过
（false）**，且**无替补、不补第 21 次、不回填模型、不丢失败**；family coverage
（reduction/normalization）单独计覆盖，不并入 affine N20。**成功恢复不抹去上述缺陷历史**。

## 4. 最终本地门禁与真实执行状态

- `verify:local-c500-release`：**142 checks，exit 0**；
- `verify:non-hardware-robustness`：**44 checks，exit 0**，其中包含既有配置要求的 release 142 项；
- [验证摘要](verification-summary.json)与[19 份验证原件归档](verification-originals.zip)已保存，标准归档校验通过；历史旧树的 139 / 41 不作为当前结果。
- 代码冻结为 `f3a54460c795cd6a64ceea01e0c2e0e3bcdf6d29`；[源码清单](live-source-manifest.json)记录了与已测试版本字节一致的 315 个参与文件。
- 最新授权后，**新的 affine 两轮真实 E2E 已完成并独立验收**：2 个不同通过候选，3 次实际模型观测均为 `deepseek-v4-flash`，停止和释放确认。此前两次 E2E 审批拒绝已成为历史记录。
- **新 N=20 尚未启动**：额外失败候选暴露生产准备回调漏传 `preparedArtifactDigest`，严格校验因此跳过失败经验。根因原件、独立验收及修复请求见[本次接续证据](../queue-prepared-binding-20260913/README.md)。新的实现/测试任务外发被自动审批拒绝，修复任务未创建。
- 当前已核实配置仍为本地代理到 `https://api.deepseek.com/anthropic`，自动故障转移关闭。[接续状态](live-run-status.json)保留旧审批记录和最新进展。

## 5. 下一步

1. E2E 外发授权已经获得并完成 smoke；新的开发任务需按自动审批要求补充明确授权，范围见[冻结修复请求](../queue-prepared-binding-20260913/repair-dispatch-request.json)。
2. 平台派发准备摘要接线修复与独立入口测试，组合验收、集成及既有门禁后冻结新源码；重新执行 **real affine 两轮** smoke，再启动 **20 个全新 affine 样本**。
3. **coverage（reduction/normalization）单独另行**，不并入 N20、不与旧批次混算；复核真实失败候选的结构化结果及后续经验、事实注入。
