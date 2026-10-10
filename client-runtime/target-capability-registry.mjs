import { ACCELERATOR_BACKENDS } from './accelerator-backends.mjs';
import { canonicalJson, contentDigest } from './execution-package-contract.mjs';

// 环境 id 与 target 在这里写成**本地常量**，而不是从 `shared-gpu-runtime.mjs` import：
// 那个模块是真的会去跑 `nvidia-smi` 的（顶层 import `node:child_process`），而登记表要被
// 应用层读到——准备服务要拿它判语言覆盖。一旦 import 过去，准备层就经由登记表传递依赖上了
// 有副作用的内置模块，`tests/state-domain-boundary-test.mjs` 会（正确地）拒绝。
//
// 这与下面 adapterId 的处理是同一个办法：这里存一份引用，一致性由
// `tests/target-capability-test.mjs` 对着真正的常量核对。一份常量住在有副作用的模块里，
// 就是每个纯调用方都要踩的坑。
const SHARED_GPU_ENVIRONMENT_ID = 'local-shared-gpu';
const SHARED_GPU_TARGET = Object.freeze({ platform: 'nvidia-cuda', device: 'gpu' });

// 目标能力登记表 —— 「这个后端能不能在这台机器上真跑」的唯一声明点。
//
// 一条能力把散在几处的接线收成一条可查询的记录：适配器身份、锁定环境、目标
// （platform/device）、语言，以及**验证等级**。等级只有两档，且只能由真实目标机上
// 跑过的证据承担：
//
//   verified   在本机真实跑过，并留下了可核对的证据
//   unverified 契约已登记，但没有任何真实目标机证据
//
// Ascend 与 MUSA 登记为 unverified，是为了让「没验证过」成为一条**可查询的事实**，
// 而不是一个沉默的 404。沉默的 404 会让人以为只是环境名写错了，于是换个名字再试，
// 最后拿到一条其实是 NVIDIA 在跑、却记在别人名下的结果。
//
// 因此 available 是**派生值**，不是声明值：只有 verified 才可能是 true。写成字段就会
// 有人手滑把它标成 true；派生出来，未验证能力就不可能返回虚假的 available。

export const CAPABILITY_VERIFICATION = Object.freeze({
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
});

export const CAPABILITY_UNAVAILABLE_REASONS = Object.freeze({
  NO_TARGET_MACHINE: 'no_target_machine',
  NOT_YET_VERIFIED: 'not_yet_verified',
});

const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, retryable: false, details });

const declare = (capability) => {
  const verification = capability.verification;
  if (!Object.values(CAPABILITY_VERIFICATION).includes(verification)) throw new TypeError('Target capability ' + capability.id + ' declares an unknown verification level.');
  const available = verification === CAPABILITY_VERIFICATION.VERIFIED;
  if (!available && !Object.values(CAPABILITY_UNAVAILABLE_REASONS).includes(capability.unavailableReason)) {
    throw new TypeError('An unverified target capability must state why it is unavailable.');
  }
  return Object.freeze({
    ...capability,
    target: Object.freeze({ ...capability.target }),
    languages: Object.freeze([...capability.languages]),
    available,
    unavailableReason: available ? null : capability.unavailableReason,
  });
};

export const TARGET_CAPABILITIES = Object.freeze([
  ...ACCELERATOR_BACKENDS.map(backend => declare({ id: backend.id, label: backend.hardware + ' development adapter (machine unverified)',
    vendor: backend.id === 'local-metax-c500' ? 'metax' : 'huawei', adapterId: backend.adapter.id, environmentId: backend.packagePort.environmentId,
    target: backend.target, languages: [], implementedLanguages: backend.implementationLanguages,
    verification: CAPABILITY_VERIFICATION.UNVERIFIED, unavailableReason: CAPABILITY_UNAVAILABLE_REASONS.NO_TARGET_MACHINE,
    evidence: null, qualificationRequired: true, publishable: false })),
  declare({
    id: 'local-shared-gpu',
    label: 'Local shared host GPU (NVIDIA)',
    vendor: 'nvidia',
    // 适配器身份写在这里的是一份**引用**，一致性由 `tests/target-capability-test.mjs`
    // 对着真正的常量核对：这个模块不 import 适配器模块，否则适配器反过来读登记表就成了环。
    adapterId: 'python-shared-gpu',
    environmentId: SHARED_GPU_ENVIRONMENT_ID,
    target: SHARED_GPU_TARGET,
    // 语言覆盖是**承诺**，不是描述；而且这里用的是**实现语言**的词汇表——`operator-language.mjs`
    // 的适配器 id，因为被 `capabilitySupportsLanguage(environmentId, language)` 查询的就是它。
    // 用别的词汇表（比如包的语言 `python`）会让比较永远不成立，于是每个 Mission 都被拒。
    //
    // 只列真的有本机证据的：
    //   pytorch-python      G-LOCAL-CORE——十二个冻结 Mission 走真实生产路径跑了整整两批
    //   cuda-cpp-extension  NVIDIA_NATIVE_COVERAGE——元素级/归约/GEMM 三家族手写 kernel 编译、加载、真执行且数值正确；
    //                       并且一个 affine Mission 经真实生产 autopilot 跑完后，候选自己的 build_directory 里
    //                       确实躺着 build.ninja 与 .pyd（冷启动 71 秒），其 kernel 实测 5.12 µs 对自带回退 14.34 µs
    // Triton 与 mxmaca 在这里**不**列：`.gpu-venv` 里没有 triton，共享 GPU 运行器也不带
    // Triton 代码路径。列上去是假承诺；让它们在这里被干净拒绝，才是把「跑不了」说清楚的地方——
    // 否则 Mission 会被接受、Agent 被告知去写 Triton，然后死在 `import triton` 上。
    languages: ['pytorch-python', 'cuda-cpp-extension'],
    verification: CAPABILITY_VERIFICATION.VERIFIED,
    evidence: 'Two independent records, one per covered implementation language: (1) pytorch-python — G-LOCAL-CORE, real local production runs through the shared-GPU runner, twelve frozen Missions, two whole batches; (2) cuda-cpp-extension — docs/development/NVIDIA_NATIVE_COVERAGE.md, a real custom CUDA kernel chain (elementwise/reduction/GEMM) built, loaded and executed on this host, and separately an affine Mission run end to end by the production autopilot whose candidate compiled and loaded its own extension inside the runner (71 s cold) with its kernel measured at 5.12 us against its own pure-PyTorch fallback at 14.34 us. Because that second language is covered only while a build actually happens, the claim carries its own enforcement: the runner fails a native-source candidate that produced no compiled extension, so this coverage cannot be satisfied by a pure-PyTorch fallback. That second record is capability evidence, not Mission or publishable evidence.',
  }),
  declare({
    id: 'ascend-npu',
    label: 'Huawei Ascend NPU',
    vendor: 'huawei',
    // 没有实现就没有适配器身份。填一个不存在的 id 会让人以为已经有实现，
    // 而那正是「未验证等级被悄悄升级」的起点。
    adapterId: null,
    environmentId: 'ascend-npu',
    target: { platform: 'ascend-cann', device: 'npu' },
    // 没有实现就覆盖不了任何实现语言。留着 `['python']` 会让人以为这里已经能跑 Python，
    // 而那正是「未验证等级被悄悄升级」的起点——和 adapterId 填 null 是同一个理由。
    languages: [],
    verification: CAPABILITY_VERIFICATION.UNVERIFIED,
    unavailableReason: CAPABILITY_UNAVAILABLE_REASONS.NO_TARGET_MACHINE,
    evidence: null,
  }),
  declare({
    id: 'musa-mtt',
    label: 'Moore Threads MUSA',
    vendor: 'moore-threads',
    adapterId: null,
    environmentId: 'musa-mtt',
    target: { platform: 'musa-mtt', device: 'gpu' },
    languages: [],
    verification: CAPABILITY_VERIFICATION.UNVERIFIED,
    unavailableReason: CAPABILITY_UNAVAILABLE_REASONS.NO_TARGET_MACHINE,
    evidence: null,
  }),
]);

// Static catalog identity; this is not a probe or a connected-backend receipt.
export const TARGET_CAPABILITY_CATALOG_SCHEMA = 'operator-studio.target-capability-catalog/v1';
export const targetCapabilityCatalogSnapshot = () => {
  const entries = listTargetCapabilities();
  return { schemaVersion: TARGET_CAPABILITY_CATALOG_SCHEMA, revision: contentDigest(canonicalJson(entries)), entries };
};

export const listTargetCapabilities = () => TARGET_CAPABILITIES.map((capability) => structuredClone(capability));

export const findTargetCapability = (environmentId) => TARGET_CAPABILITIES.find((capability) => capability.environmentId === environmentId || capability.id === environmentId) || null;

export const resolveTargetCapability = (environmentId) => {
  const capability = findTargetCapability(environmentId);
  if (!capability) throw fail('TARGET_CAPABILITY_UNKNOWN', 'No target capability is registered for this environment.', { environmentId });
  return capability;
};

// 查询式：调用方要的是「能不能跑、为什么不能」，不是一个异常。
// 未登记与未验证是两件事，返回值里分开表达，都不返回 available: true。
export const targetCapabilityAvailability = (environmentId) => {
  const capability = findTargetCapability(environmentId);
  if (!capability) return Object.freeze({ environmentId, available: false, registered: false, reason: 'unregistered', capability: null });
  return Object.freeze({ environmentId, available: capability.available, registered: true, reason: capability.unavailableReason, capability });
};

// 断言式：任何「准备一个环境去跑」的入口都应该走这里，而不是先拿到默认环境再祈祷。
export const assertTargetCapabilityAvailable = (environmentId) => {
  const availability = targetCapabilityAvailability(environmentId);
  if (!availability.registered) throw fail('TARGET_CAPABILITY_UNKNOWN', 'No target capability is registered for this environment.', { environmentId });
  if (!availability.available) {
    throw fail('TARGET_CAPABILITY_UNVERIFIED', 'The registered target capability has no verified target machine; it must not be substituted by another capability.', {
      environmentId, capabilityId: availability.capability.id, verification: availability.capability.verification, reason: availability.reason,
    });
  }
  return availability.capability;
};

// 「支持这个语言」必须蕴含「这台机器真能跑」。少了 available 这一项，未验证的后端也会
// 回答 true——那正是本模块开头警告的那种半真话：名字对得上，跑起来才发现没有人跑过。
export const capabilitySupportsLanguage = (environmentId, language) => {
  const availability = targetCapabilityAvailability(environmentId);
  return availability.registered && availability.available && availability.capability.languages.includes(language);
};
