# 03 候选生成评估入口

这个目录是 03「候选生成｜Agent 与 Mission 工作区」的开发者评估工具。入口调用生产
HTTP API，复用 Mission Workspace、Agent Runtime、Operator Test Queue 和现有证据投影；它
不复制候选准入、Accept Gate 或自动采用规则，也不会把评估结果写成正式经验。

## 快速开始

准备一个包内自包含的 `run.py`。它至少实现 `get_test_cases()`、
`get_benchmark_inputs()`、`reference(inputs)` 和 `run(inputs)`；输入工厂与 reference 是
独立 oracle，Candidate 不得修改。配置示例：

```json
{
  "operator": "vector_add",
  "title": "03 vector_add iteration",
  "goal": "只优化 run(inputs)，保持输入、输出、reference 和测试矩阵不变；提交一个真实 Diff。",
  "backend": "local-cpu",
  "runtimeMode": "codex-cli",
  "model": "gpt-5.6-sol",
  "metric": "latency p50",
  "baselinePath": "./operators/vector_add/run.py",
  "semanticDraft": {
    "operator": "vector_add",
    "inputs": [{"name":"x","shape":["B","N"],"dtype":["float16","float32"]}],
    "outputs": [{"shape":["B","N"],"dtype":"same-as-x"}],
    "math": {"formula":"y = x + bias"},
    "edgeCases": ["N=1", "N not divisible by tile"],
    "invariants": ["不修改输入", "输出 shape 与 x 相同"],
    "immutableRules": ["不得修改 reference 和测试输入工厂"]
  },
  "testMatrix": {
    "environments": ["CPU"],
    "stages": ["Correctness", "Full Benchmark"],
    "correctnessCases": 4,
    "warmup": 2,
    "repeats": 10,
    "testSpec": {
      "schemaVersion": "operator-studio.test-spec/v1",
      "correctness": {"requestedCases":4,"requiredCategories":["minimal","representative","boundary"],"atol":1e-5,"rtol":1e-5,"requireNamedCases":true},
      "benchmark": {"requiredProfiles":["primary"],"primaryProfile":"primary","warmup":2,"repeats":10}
    }
  }
}
```

运行：

```bash
npm run eval:candidate-generation -- --config ./03-vector-add.json --output ./artifacts/03-vector-add
```

默认使用本机 CPU 后端以便快速回归；GPU 评估可将 `backend` 改为
`local-shared-gpu`，并在配置中选择对应的 CUDA 输入/实现。生成模型默认
`gpt-5.6-sol`，也可显式使用 `gpt-5.5`。每次运行有总超时和测试任务超时，超时后写出
`failure.json`，不会无限等待。

输出目录包括：

- `evaluation.json`：机器可读的生成耗时、队列等待、provider/runtime 耗时、token 用量、准入、correctness 和 benchmark。
- `evaluation.md`：适合开发伙伴直接查看的摘要。
- `observations.json`：原始 state、任务、事件和 runtime 日志，便于定位卡住/失败原因。
- `failure.json`：入口自身失败时的错误和日志；这不是“候选失败”证据。

缺失 token 用量保留为 `null`/`unavailable`，绝不显示为零。只有 baseline 与 candidate 都
通过 correctness、profile 和单位匹配、测量值为正时才计算 speedup；因此 benchmark 的
“快”不能掩盖 correctness 失败。

## 输入与迭代修改规则

`semanticDraft` 是 03 的语义输入，入口创建 Mission 后立即通过
`POST /api/missions/:id/semantic/freeze` 冻结。后续候选轮次只能修改实现路径；要改变
shape、dtype、输入工厂、reference、容差或 benchmark profile，必须创建新的语义快照和
新的评估配置，不能在同一轮悄悄改测试。

增加另一种算子时，复制配置的语义/测试部分即可，不复制脚本流程：

1. 在 `semanticDraft` 描述 operator、inputs、outputs、数学规则、边界和不变量。
2. 在 `testSpec` 加入最小、代表、边界/非整除、dtype 等具名 correctness case 类别。
3. 在 `run.py` 的 `get_test_cases()` 和 `get_benchmark_inputs()` 中提供确定性、可序列化的包内数据；`reference()` 独立于 `run()`。
4. 将生产最接近的 profile 标为 `primary`，固定 warmup/repeats；不要根据 Candidate 结果回写矩阵。
5. 多文件或 C++/CUDA 算子应改用执行包入口和对应 language adapter；本脚本的配置仍只描述语义、矩阵和目标，不把 Python 假设扩散到 03 契约。

评估结束时入口会暂停 Mission，防止自动采用或自动开始下一轮。报告只用于 03 内部优化，
不能作为发布、真机经验或性能承诺；共享 GPU 结果同样是开发证据。

## 纯报告 API

不启动 Runtime 的单元/离线场景可直接使用 `report.mjs` 的
`buildCandidateGenerationEvaluation({ generationTiming, generationUsage, candidateValidation, baselineTask, candidateTask, config })`。
它是纯函数，不读写队列、Gate 或状态。测试：

```bash
npm run test:candidate-generation-eval-report
```
