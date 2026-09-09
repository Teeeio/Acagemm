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

## 迭代经验与上下文注入

03 有两条明确的上下文入口，不能混为一谈：

### 生产迭代：自动注入冻结的 Experience Context

每次通过 Production API 启动一个新 Round 时，应用层会先由
`roundExperienceService` 按以下身份检索经验：

```text
Project -> Mission -> Round ID -> operator/hardware/tags scope -> repository revision
```

它会把当前项目内与 Scope 匹配的人工指导和已沉淀执行观察整理成
带 `contextId`、版本映射、scope digest 和 repository revision 的冻结上下文，再传入
Agent Runtime 的 `experienceInstruction`，最终进入 03 Candidate Prompt。上下文会被标记为
`UNTRUSTED JSON DATA`，只能帮助 Agent 选择下一次尝试，不能覆盖：

- Frozen Semantic Snapshot、shape、dtype、输入/输出和数学不变量；
- 独立 Baseline oracle、Correctness cases、Benchmark profiles 和 Accept Gate；
- Agent 工作区边界、重试预算和测试队列顺序。

本评估脚本每次创建全新的临时 Project，不会自动继承另一次评估的历史。要做可重复的
“带经验/不带经验”对比，可在配置中增加 `experienceGuidance`，入口会在 Agent 启动前
通过生产 Experience API 写入这些人工指导，然后由正常的冻结/检索路径注入 03：

```json
{
  "experienceGuidance": [
    {
      "title": "上一轮优化总结（人工整理）",
      "content": "primary profile 未改善；已尝试 naive vectorization，本轮优先检查内存布局。",
      "author": "operator-engineer",
      "confidence": "medium",
      "scope": {"operator":"vector_add","hardware":["cpu"]}
    }
  ]
}
```

最多接受 20 条人工指导；检索仍会按 Scope 和系统上下文上限筛选，不保证所有记录都进入
Prompt。即使内容提到上一轮测量，也仍是未验证人工建议，不会变成执行证据。可以在
`observations.json` 的 `state.iterationStats.roundExperience` 中检查实际注入的 `items`、
`versions` 和 `contextId`。

对于正在运行的同一 Project，也可以直接写入人工指导，下一轮启动时由系统按版本和
Scope 自动读取：

```bash
curl -X POST http://127.0.0.1:4174/api/projects/PROJECT_ID/experiences \
  -H 'content-type: application/json' \
  -d '{
    "title": "避免重复的向量化方向",
    "content": "上一轮 primary profile 正确性通过但没有改善；不要重复同一 patch digest，优先检查内存访问布局。",
    "author": "operator",
    "confidence": "medium",
    "scope": {"operator":"vector_add","hardware":["cpu"]}
  }'
```

执行观察不能通过这个人工 API 伪造；它们必须由测试队列完成、具有完整 Candidate/Package/
Environment/Acceptance 绑定并经证据校验后，由系统写入 Experience
Repository。CPU/GPU 观察仍是开发经验，不能因此获得发布资格。

### 纯 03 Prompt 测试：显式注入上一轮证据

不启动 Runtime 的 `buildCandidateGenerationPrompt()` 单元测试可以显式提供诊断上下文：

```js
buildCandidateGenerationPrompt({
  mission: {
    id: 'MIS_demo',
    semanticSnapshot,
    iterationContext: {
      roundId: 'MIS_demo:round:2',
      priorCandidateDigest: 'sha256:...',
      attemptedDirections: ['naive vectorization']
    },
    iterationEvidence: {
      decision: 'discard',
      correctnessFailures: [{"case":"ragged","reason":"shape mismatch"}],
      benchmarkProfiles: [{"profile":"primary","value":101.2,"unit":"us"}],
      remainingGap: 'primary latency target not met'
    }
  },
  baseline: {
    iterationEvidence: {
      source: 'previous-round',
      rejectedDigests: ['sha256:...'],
      nextDirection: '改用 contiguous layout'
    }
  },
  goal: '只做一个不重复的实现修改',
  workspace: '/isolated/mission/workspace'
});
```

Prompt 会把这些字段包在 `BEGIN ... END` 边界内并标记为不可信事实。字段缺失时首轮仍
可正常生成；字段存在时只能用于定位失败和避免重复，不能改变返回结构或测试契约。
这些 `iterationContext`/`iterationEvidence` 例子是纯 Prompt API 输入，不是当前评估 CLI
的配置字段。当前 CLI 提供 `experienceGuidance` 人工经验注入，但尚未提供上一轮原始任务
的导入/重放入口；真实多轮执行经验应由同一 Project 的生产迭代流程产生。不要把人工摘要
包装成已验证执行观察，也不要声称独立评估已覆盖跨轮自动经验继承。

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
