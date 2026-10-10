# Target capability registry

`targetCapabilityCatalogSnapshot()` returns `{schemaVersion,revision,entries}`.
`operator-studio.target-capability-catalog/v1` describes the snapshot contract;
revision is SHA-256 of canonical JSON over all detached capability entries.
A capability-content change changes revision. Round selection freezes contents
and revision, so a later catalog change does not relabel old retrieval.
The static catalog neither probes a GPU nor confirms backend connectivity.
Existing verification/available rules remain unchanged.

`target-capability-registry.mjs` 是「这个后端能不能在这台机器上真跑」的唯一声明点。
纯声明，无副作用，不 import 任何适配器实现模块（适配器反过来读登记表，import 回去就成了环）。

## 一条能力是什么

| 字段 | 含义 |
|---|---|
| `id` / `label` / `vendor` | 人类可读身份 |
| `adapterId` | 实现它的适配器身份；**没有实现就是 `null`** |
| `environmentId` | 环境解析器认的 id |
| `target` | `{ platform, device }`，进包 manifest 的那个 target |
| `languages` | 该能力覆盖的**实现语言**，用 `operator-language.mjs` 的适配器 id 拼写（`pytorch-python` / `cuda-cpp-extension` …） |
| `verification` | `verified` \| `unverified` |
| `available` | **派生值**：`verification === 'verified'` |
| `unavailableReason` | 未验证时必填，取自固定词表 |
| `evidence` | `verified` 时应能指出证据在哪 |

`available` 不是可声明字段。写成字段就会有人手滑标成 `true`；派生出来，未验证能力就**不可能**
返回虚假的 `available`——不是靠约定，是靠没有那个字段可写。

这个模块**不 import 任何有副作用的模块**，包括 `shared-gpu-runtime.mjs`——那是真正会去跑
`nvidia-smi` 的探针（顶层 `import node:child_process`）。环境 id 与 target 在这里各存一份本地常量，
一致性由 `tests/target-capability-test.mjs` 对着真常量核对。理由是应用层要读这张表（准备服务判语言
覆盖）：一旦 import 过去，准备层就传递依赖上了有副作用的内置模块，`state-domain-boundary` 会正确地拒绝。

`adapterId: null` 也是刻意的：给一个还没实现的后端编一个适配器 id，会让人以为已经有实现，
而那正是「未验证等级被悄悄升级」的起点。同理，没有实现的后端 `languages` 是空数组——它覆盖不了
任何实现语言，写上一个 `python` 只会让人以为那里已经能跑。

`languages` 用的是**实现语言**的词汇表，和包的语言（`SHARED_GPU_PACKAGE_PORT.language`）是两条轴。
写错词汇表不会报错，只会让 `capabilitySupportsLanguage` 的比较永远不成立，于是每个 Mission 都被拒——
所以 `tests/target-capability-test.mjs` 会核对这里列的每个 id 都是真实存在的适配器 id。

## 当前登记

| environmentId | 厂商 | 等级 | 覆盖的实现语言 | 说明 |
|---|---|---|---|---|
| `local-shared-gpu` | NVIDIA | `verified` | `pytorch-python`、`cuda-cpp-extension` | G-LOCAL-CORE 十二个冻结 Mission 走真实生产路径跑了整批；另有一份真实的自定义 CUDA kernel 链实测（元素级/归约/GEMM，见 `docs/development/NVIDIA_NATIVE_COVERAGE.md`）支撑 `cuda-cpp-extension` 这一项。该实测是能力证据，不是 Mission 证据，也不可发布 |
| `ascend-npu` | Huawei | `unverified` | — | 无目标机，无实现 |
| `musa-mtt` | Moore Threads | `unverified` | — | 无目标机，无实现 |

Triton 与 mxmaca **不在** `local-shared-gpu` 的覆盖里：`.gpu-venv` 里没有 triton，共享 GPU 运行器
也不带 Triton 代码路径。声称覆盖它不是「预留」，是让人以为 Mission 已经能跑。

## 强制点

登记表只在**环境解析**（`createSharedGpuEnvironmentResolver.resolve`）上生效，那是「把一个 id
变成可信环境」的唯一入口，也是包组装、预检和准入的共同上游：

- 未登记 → `PACKAGE_ENVIRONMENT_UNKNOWN`（保持原样，这是「名字写错」）。
- 已登记但未验证 → `PACKAGE_ENVIRONMENT_UNVERIFIED`，`details` 带 `capabilityId` /
  `verification` / `reason`，**且不启动任何运行时探测**。

两种情况分开，是因为混在一起会把人推向错误结论：以为「只是名字不对」，换个名字再试，最后可能
落到别的能力上。用 NVIDIA 冒充 Ascend 记录，比直接失败坏得多。

## 查询 API

| 导出 | 语义 |
|---|---|
| `listTargetCapabilities()` | 返回副本，调用方改不动登记表 |
| `findTargetCapability(environmentId)` | 记录或 `null` |
| `resolveTargetCapability(environmentId)` | 记录，未登记则 `TARGET_CAPABILITY_UNKNOWN` |
| `targetCapabilityAvailability(environmentId)` | `{ available, registered, reason, capability }`；未登记与未验证分开表达，都不返回 `available: true` |
| `assertTargetCapabilityAvailable(environmentId)` | 「准备一个环境去跑」的入口应该走这里 |
| `capabilitySupportsLanguage(environmentId, language)` | 语言覆盖查询；`language` 用实现语言的适配器 id。**「支持」蕴含「可用」**：未登记或未验证都返回 `false` |

`capabilitySupportsLanguage` 的生产调用点是
`application/benchmark-package-preparation-service.mjs` 的准备路径：Mission 被接受之前先问一句
「这个后端支持这个 Mission 的实现语言吗」，不支持就以 `PACKAGE_LANGUAGE_UNSUPPORTED` 干净拒绝。
在此之前登记表声明了 `languages` 却没有任何人据此拒绝——「本机后端支持哪些实现语言」只是一句
无人执行的描述，代价是 Mission 被接受、Agent 被告知去写 `operator.cu`，然后死在构建阶段，
报错长得像工具链坏了。拒绝只对**已登记且已验证**的后端生效；登记表没意见的环境由环境解析器负责。

## 升级等级需要什么

把一条能力从 `unverified` 改成 `verified`，需要的是**目标机上的真实证据**，不是这次改动的完成度。
在拿到证据之前，唯一诚实的写法就是留在 `unverified`。

## Implemented development targets

`local-metax-c500` and `local-ascend910b` now reference real adapter identities.
`implementedLanguages` records implemented software; `languages=[]`,
`verification=unverified`, `available=false` and `publishable=false` still record
absence of target-machine acceptance. The trusted target resolver can qualify an
exact device/version for explicitly authorized development execution, without
changing that static verification grade. See accelerator-package-adapter.md.
