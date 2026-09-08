# Generic Mission import (`operator-studio.generic-mission/v1`)

通用算子从现有源码项目导入，不经过固定 Profile。调用
`importMissionSpecification(spec)` 即可复用 Production API 的
`/api/projects` → `/api/missions` →（可选）`/runs` 路径。

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

`repository` 必须是绝对路径；Projects service 使用三层布局（项目根目录下的 `repository/`）。如果传入已有裸 Git 根目录，请先在 Production API 登记对应三层项目；导入器不会擅自复制源码或创建旁路仓库。`sourceFiles` 只描述仓库内文件，不能包含 `..`，且至少有一个 `entrypoint`。导入不会复制、修改或执行这些文件。`start:false`（默认）只创建 Mission，让正常 baseline Research/Materializer 流程先完成；只有调用者提供明确完成的 baseline（含 `materializer.status=completed` 和 `result.runPy`）时才允许 `start:true`。未就绪时返回 `GENERIC_MISSION_BASELINE_NOT_READY`，不会制造 baseline 或 current best。

目前语言别名映射到已有执行适配器：`python`/`pytorch`、`triton`、`cuda-cpp`、`mxmaca-cpp-extension`。新增语言时应在 `client-runtime/operator-language.mjs` 增加适配器，再扩展此 DTO 校验；不要在 TUI 中另建执行流程。
