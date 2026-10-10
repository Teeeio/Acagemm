# Generic Mission import (`operator-studio.generic-mission/v1`)

Optional `targetProfile` carries `{architecture,hardware?,schemaVersion?,source?}`.
Its canonical version is `operator-studio.mission-target-profile/v1`, its source
is `user-declared`, and hardware must match the single Mission target. Example:
`"targetProfile":{"architecture":"sm86"}` with `"hardware":["nvidia-gpu"]`.
Omitting it leaves architecture unknown and does not block saving or generation.
It grants no executor capability. A spec-file hardware override conflicting with
this profile is rejected. The form exposes a guided optional architecture field.

通用算子从现有源码项目导入，不经过固定 Profile。调用
`importMissionSpecification(spec)` 即可复用 Production API 的
`/api/projects/import`（普通 Git）或 `/api/projects`（已有受管项目）→ `/api/missions` →（可选）`/runs` 路径。TUI 的 `P` 默认提供交互表单，不要求 JSON；`inputMode=spec-file` 保留已有规格导入。固定示例仍单独从固定 Profile 模块生成，不通过通用表单改写矩阵。

## 无 JSON 表单合同

`sourceMode=managed` 为默认：用户选择素材，系统管理目录与依赖；下表的
repository/dependencyFiles 是旧仓库表单的兼容字段。Ctrl+S 通过
`saveMissionConfigurationDraft` 保存可编辑准备草稿，只要求 operator/goal，
不调用完整规格组装或启动。完整提交才调用 `publishMissionDraft`。
带 draftId/draftRevision 提交时，后端只在成功创建 Mission 后消费该版本。

`missionSpecificationFromForm(draft)` 是无 I/O 的公开组装函数，`publishMissionDraft(draft)` 负责唯一 Production API 链路。默认 `mode=generic,inputMode=form,execution=save`。总览按视口分页，张量和性能 shape 每项一行；Enter 打开单项编辑，Esc 返回总览并保留修改，复制生成唯一名称（shape 不继承主场景），删除只影响当前项。PgUp/PgDn 在总览切换分组，在编辑页翻页；Tab/方向键切换字段，Ctrl+U 清空文本。普通字段 Enter 只移到下一项。通用交互任务必须通过“检查并提交”查看摘要，再在“确认提交”创建；无效配置仍定位到原字段（必要时打开对应编辑页）。编辑身份不进入保存 DTO；固定示例和规格导入保持原合同。

| 字段 | 格式与意义 |
|---|---|
| `repository` | 普通 Git 根目录的绝对路径，必须已有 `run.py` |
| `operator`, `goal` | 明确算子名称及优化目标，不自动猜测语义 |
| `language` | pytorch-python / cuda-cpp-extension / triton / mxmaca-cpp-extension |
| `target` | nvidia-gpu / C550 / ascend-npu；目标选择不代表执行端可用 |
| `dependencyFiles` | 可空；仓库相对路径的英文逗号列表，如 `operator.cu, deps/helper.py`，不重复 run.py/基线，不支持含逗号的文件名 |
| `baselineFile` | 必填独立 `.py` 仓库相对路径，不属于候选语言允许写入的文件 |
| `semanticInputs`, `semanticOutputs` | 内部兼容格式 `x:float32[N,K]@contiguous; scale:float32[]@scalar`，TUI 不提供整段文本编辑；通过张量项增删、维数选择、逐维填写生成。维度为非负整数或命名符号，`[]` 表示标量 |
| `semanticMath` | 计算公式，例如 `y = x * scale + bias` |
| `semanticConstraints`, `semanticBoundaries` | 英文分号分隔的不可变约束、边界行为；不适用也需明确填写“无” |
| `seed` | 非负安全整数，允许 0；确定性生成固定开启 |
| `requestedCases` | 正确性用例正整数数量 |
| `requiredCategories` | 非空、无重复英文逗号列表；需由独立基线真实覆盖；类别数不得多于 `requestedCases` |
| `atol`, `rtol` | 非负有限数，支持科学计数法；空白不等于 0 |
| `dtypeTolerance` | 可空对象 `{ float16: '1e-3' 或 '1e-3/1e-4' }`，只收输出 dtype；以 `testSpec.correctness.dtypeTolerance: { <dtype>: { atol, rtol } }` 及 `toleranceScope=output-dtype` 冻结，按每个输出逐个比较，未填的 dtype 沿用 `atol`/`rtol` |
| `cosineTolerance` | 正有限数，默认 `1e-5`；显式冻结为 `requireCosDiffBelow`，输出 cosDiff 必须严格小于该值 |
| `benchmarkShapes` | 可空的 shape 项列表 `[{ name, dims: { M: '128', … } }]`（TUI 中逐项创建、逐维度填数值，不接受文本语法）。名称用字母/数字/`_`/`-` 且不重复；每项必须给出输入/输出张量中全部命名维度的正整数值，不得含张量里不存在的维度；最多 16 项。非空时 shape 名即 `requiredProfiles`，并以 `testSpec.benchmark.shapes` 冻结（见下） |
| `requiredProfiles`, `primaryProfile` | 性能场景英文逗号列表及其中一个主场景；当前指标 latency p50。声明了 `benchmarkShapes` 时列表由 shape 名给出，主场景必须是其中之一 |
| `warmup`, `repeats` | 预热和测量正整数次数 |
| `settleTolerance`, `maxSettlements` | 显式收敛相对容差 `(0,1)`、正整数收敛次数上限 |
| `timeBudget` | 可空；显式值为正整数毫秒 |
| `execution` | save / generate-only / start；start 保留原本地迭代语义 |

`testSpec.benchmark.shapes` 可选：若出现，必须按 `requiredProfiles` 顺序每个 profile 一项 `{name, dims, inputShapes}`，`dims` 为正整数，`inputShapes` 列出带命名维度的输入张量的具体形状（标量和全固定形状的输入不列出）。它进入 test-spec 摘要，Agent 指令要求基线按此生成输入，Runner 在测量前逐项核对，不符即以 `OPERATOR_BENCHMARK_SHAPE_MISMATCH`（oracle 合同错误，不是候选裁决）失败。Accept Gate 的评判口径不变：每个 shape 都被测量并记录，但当前仍只按主场景评判。

维度符号是尺寸变量，语法为 `[A-Za-z_][A-Za-z0-9_]*`，区分大小写，不限于 N/C/H/W。同一用例内，所有输入/输出的同名符号共享尺寸；`[N,N]` 合法且要求两维相等，`[M,N]` 允许不同尺寸，`[N,M]` 保留反向顺序。TUI 对重复/共享符号显示等长提示，不自动去重或重命名。暂不支持 `N+1`、`2*N` 等维度表达式。固定尺寸为非负安全整数，`[0]` 是含空维度的张量，`[]` 才是标量；性能 shape 的符号取值仍要求正整数。

整数不接受小数、指数、负数或不安全整数；浮点数不接受单位尾缀、十六进制、NaN 或 Infinity。TUI 保留非法数字/名称输入并显示校验问题，不通过删除字符把 `-128`、`1.5`、`N+1` 改写成其他值；结构分隔符粘贴会显式拒绝，避免单项编辑插入额外张量/维度。全角字母、数字和标点仍归一化为半角。列表不接受空条目/重复条目。`sourceFiles` 由固定 `run.py:entrypoint`、依赖 `dependency` 和独立基线 `oracle` 组成；输入/输出、公式、约束和边界映射为真正透传的 `semanticDraft`。不把描述丢弃后只提交算子名称。

## 独立文件与执行动作

Production API client 先读取原仓库声明文件，再导入并逐字节确认受管副本。声明源码最多64个，每个≤2MiB、总计≤8MiB。文件/所有祖先目录必须常规，拒绝 symlink/junction、硬链接、路径逃逸、缺失及读取时变化。空 `run.py` 可作为已有源码文件，但缺失不允许；独立基线必须非空 UTF-8 `.py`、≤200000字节，并通过既有静态桥接检查：`get_inputs/run/reference/get_test_cases/get_benchmark_inputs`。该检查不会执行 Python，也不证明语义独立或用例通过。

文件来源标记 `user-provided`，记录实际文件摘要及 Git HEAD（HEAD 不等于脏文件摘要）。构造的 `baseline.materializer.status=completed` 仅表示文件工件就绪；`baseline.status=missing`、`evidence=null`，不得填正确率、性能或上游权威。后续测试仍走原有基线和候选队列。独立基线不能与候选允许写入的文件重合。

`executionMode=generate-only` 的前置输入上限为4MiB：所有声明 sourceFiles 的实际字节总和，加独立基线（文件读取结果或内嵌 materializer.runPy）的 UTF-8 byteLength。若基线也声明为 oracle 源文件，两份都计入；恰好4MiB可通过，超限在 Runtime/项目/旧任务变更前返回 `GENERIC_GENERATION_INPUT_TOO_LARGE`。iterate 保留每文件2MiB、源码总计8MiB的原限制。冻结 bundle 的8MiB限额是另一层检查，不是更大的生成输入预算。

`save` 保存暂停 Mission；`generate-only` 传 `executionMode=generate-only,start=true`，只绕过本地 executor/Doctor，仍须正常 Agent 准入；`start` 传 `executionMode=iterate,start=true`，保留本地目标、语言和硬件检查。两个启动动作均创建 paused 后调用同一个 `/runs {startDraft:true}`，不是新工作流。已生成/待测任务恢复仍返回 `GENERATION_ONLY_TEST_NOT_ENABLED`；冻结候选使用独立的 `POST /api/missions/:id/pending-candidate/submit {manifestDigest}` 入口。测试读冻结字节、保留原预算，不自动恢复生成。无来源元数据的旧包仍可导出，不能借用当前基线来源。

导出 `operator-studio.mission-export/v1` 中的 `pendingCandidate` 来自只读 `/api/missions/:id/pending-candidate`，内容为 `{pendingValidation,bundle}`，与导出状态中的待测清单一致。不是可变工作目录路径。

## 可选已有规格导入

最小规格：

```json
{
  "schemaVersion": "operator-studio.generic-mission/v1",
  "title": "Custom operator iteration",
  "goal": "Optimize the operator while preserving the declared test contract.",
  "repository": "F:/work/my-operator-project",
  "hardware": ["nvidia-gpu"],
  "metric": "latency p50",
  "implementation": {"language": "python", "entrypoints": ["run"]},
  "operatorProfile": {"operator": "custom.operator", "version": "v1"},
  "sourceFiles": [
    {"path": "run.py", "role": "entrypoint"},
    {"path": "oracle.py", "role": "oracle"}
  ],
  "testMatrix": {
    "environments": ["nvidia-gpu"],
    "testSpec": {
      "schemaVersion": "operator-studio.test-spec/v1",
      "generation": {"deterministic": true, "seed": 1},
      "correctness": {"requestedCases": 4, "requiredCategories": ["minimal", "representative", "boundary", "ragged"], "atol": 0.001, "rtol": 0.001},
      "benchmark": {"requiredProfiles": ["primary", "small", "boundary"], "primaryProfile": "primary", "warmup": 2, "repeats": 5}
    }
  },
  "start": false
}
```

`repository` 必须是绝对路径。普通 Git 根目录由后端复制到客户端数据目录下的独立三层项目，包含已跟踪修改、删除和非忽略新文件；不改原仓库，不执行仓库脚本或下载依赖。链接、子模块、重叠目录及超限快照被拒绝，详见 `workspace-manager.md` 的导入契约。`sourceFiles` 只描述仓库内文件，不能包含绝对路径、驱动器、空段、`.` 或 `..`，且至少有一个 `entrypoint`。

`start:false`（默认）原子保存为暂停 Mission，不会自行启动 Agent、Research/Materializer 或硬件测试。`baselineFile` 可导入独立文件；已有内嵌 baseline 合同保留兼容。启动需有文件工件就绪的 baseline（含 `materializer.status=completed` 和 `result.runPy`）；未就绪时在改变当前任务前返回 `GENERIC_MISSION_BASELINE_NOT_READY`。`executionMode` 仅接受 `generate-only/iterate`，缺省 iterate。iterate 启动还要求目标、语言与执行端匹配并通过预检。创建与 `/runs` 之间保持暂停，成功后才解除。不会制造测试完成或 current best。

TUI 读取上限为 750 KB 的 JSON 对象文件，可覆盖目标、语言、算子名称、优化目标和总预算；冻结测试规范和独立基线仍来自文件，不随界面选择降级。测试规范必须明确确定性种子、非负容差、正确性数量/类别和 benchmark profiles/warmup/repeats；不会用默认值补齐未声明的验收要求。

保存任务后首次启动使用 `/api/missions/:id/runs` 的 `startDraft:true`，由后端在既有写锁和准入流程内原子处理；不使用先解除暂停、再发启动请求的两步调用。预检失败保持原草稿暂停；执行效果不明时保留既有 journal 恢复义务。

通用 DTO 会保留 `semanticDraft` 与 `executionMode`；未知执行模式拒绝。冲突的顶层矩阵计数与 testSpec 拒绝，seed 0 保留。当前没有云执行端；表单是显式填写合同，不会从自然语言自动推断验收规范，此入口不能视为产品发布验收。

目前语言别名映射到已有执行适配器：`python`/`pytorch`、`triton`、`cuda-cpp`、`mxmaca-cpp-extension`。新增语言时应在 `client-runtime/operator-language.mjs` 增加适配器，再扩展此 DTO 校验；不要在 TUI 中另建执行流程。

## Controlled experiment attribution

An optional `experiment` uses the public `generation-origin.mjs` input contract:
`id`, `batchId`, `taskId`, positive `replicate`, `condition`, `manifestDigest`.
The normalizer validates and preserves these fields through production import.
Ordinary users need no additional form fields. The server still binds the trusted
storage/memory identity; caller metadata cannot grant storage access or change it.
