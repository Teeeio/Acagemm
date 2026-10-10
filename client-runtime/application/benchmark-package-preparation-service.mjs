import { canonicalJson, contentDigest } from '../execution-package-contract.mjs';
import { normalizeOperatorLanguage } from '../operator-language.mjs';
import { capabilitySupportsLanguage, findTargetCapability } from '../target-capability-registry.mjs';

// 公共准备端口：组合根注入可信 store、适配器身份与端口映射，本服务只负责包组装、oracle 校验和准入绑定。
// 唯一行为增量是把 admission 的可信 preparedArtifactDigest 写入返回 request；绝不采信 caller/result 回填。
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, details });

// 语言覆盖是**后端承诺**，所以要在「语言」与「环境」同时在场的地方强制，而不是只写在登记表里。
// 在此之前 `capabilitySupportsLanguage` 没有任何生产调用点：登记表声明了 languages，却没人据此拒绝，
// 于是「本机后端支持哪些实现语言」只是一句无人执行的描述。后果不是立刻可见的——Mission 被接受、
// Agent 被告知去写 operator.cu，然后死在构建阶段，报错长得像工具链坏了，而不是「这个后端不支持这种语言」。
//
// 判据取**登记表**而不是适配器物化清单：适配器物化的是执行语言（run.py 这个桥，永远是 python），
// 实现语言是另一条轴。两者分开，cuda-cpp-extension 仍是一个 python 包，只是多带一个 operator.cu。
const assertLanguageCovered = ({ environmentId, mission }) => {
  const capability = findTargetCapability(environmentId);
  // 只对**平台已声明且已验证**的后端判语言覆盖。登记表没意见的环境（别的适配器接进来的新后端）
  // 与已登记但未验证的后端，都不在这里判：那是环境解析器的职责，它已经会拒
  // PACKAGE_ENVIRONMENT_UNKNOWN / PACKAGE_ENVIRONMENT_UNVERIFIED。两层各判一次，
  // 就会出现两个都自称权威、理由却不同的拒绝——而且会先把「准备层其实与后端无关」这条契约弄丢。
  if (capability?.qualificationRequired) {
    const language = normalizeOperatorLanguage(mission?.implementation).id;
    if (!capability.implementedLanguages.includes(language)) throw fail('PACKAGE_LANGUAGE_UNSUPPORTED', 'This development adapter has no implementation for the selected language.', { environmentId, language });
    return; // Actual device/version qualification is exclusively the trusted resolver.
  }
  if (!capability || !capability.available) return;
  // 未声明语言的 Mission 保留历史默认（PyTorch），它没有选过语言，也就没有选错。
  const language = normalizeOperatorLanguage(mission?.implementation).id;
  if (capabilitySupportsLanguage(environmentId, language)) return;
  throw fail('PACKAGE_LANGUAGE_UNSUPPORTED',
    'The registered capability for this environment does not cover the Mission implementation language.',
    { environmentId, language, capabilityId: capability.id, covered: [...capability.languages] });
};

// 端口映射是**必需**输入。此前语言（python）、环境（local-shared-gpu）和两个入口文件名都写在本文件里，
// 于是「换一个后端」等于改准备层；缺映射时唯一的「兼容」做法就是回落到这组写死的值，而那正是要拆掉的东西。
// 所以这里不设默认值：读到不认识的组合就拒绝，不把请求挂到一个没被任何人声明的语言或环境上。
const resolvePort = ({ packageAdapter, packagePort }) => {
  const adapterId = packageAdapter?.id;
  if (!adapterId || !packagePort || typeof packagePort !== 'object') {
    throw fail('PACKAGE_PORT_MISSING', 'Execution package preparation requires an adapter identity and its port mapping.');
  }
  // 身份与接线必须来自同一个适配器。混用两个适配器的映射会让包带着 A 的身份、按 B 的契约组装。
  if (packagePort.adapterId !== adapterId) {
    throw fail('PACKAGE_PORT_MISMATCH', 'The port mapping belongs to a different adapter than the injected identity.', { adapterId, portAdapterId: packagePort.adapterId ?? null });
  }
  const required = (value, field) => {
    if (typeof value !== 'string' || !value.trim()) throw fail('PACKAGE_PORT_INVALID', 'The adapter port mapping must declare ' + field + '.', { field });
    return value;
  };
  const checks = packagePort.checks;
  if (!Array.isArray(checks) || !checks.length || checks.some((check) => typeof check !== 'string' || !check.trim())) {
    throw fail('PACKAGE_PORT_INVALID', 'The adapter port mapping must declare its non-empty check list.', { field: 'checks' });
  }
  return Object.freeze({
    language: required(packagePort.language, 'language'),
    environmentId: required(packagePort.environmentId, 'environmentId'),
    candidateSourceExtensions: Array.isArray(packagePort.candidateSourceExtensions) ? [...packagePort.candidateSourceExtensions] : [],
    candidateEntrypoint: required(packagePort.candidateEntrypoint, 'candidateEntrypoint'),
    acceptanceEntrypoint: required(packagePort.acceptanceEntrypoint, 'acceptanceEntrypoint'),
    checks: Object.freeze([...checks]),
  });
};

export const createBenchmarkPackagePreparer = ({ executionPackageStore, packageAdapter, packagePort }) => {
  // 组合期就失败：配置错误不该等到第一个 Mission 走到提交那一步才暴露。
  const port = resolvePort({ packageAdapter, packagePort });
  return async ({ request, mission, matrix, missionRunPy }) => {
    const deadline = request.deadline || new Date(Date.now() + Number(request.limits?.timeoutSeconds || 600) * 1000).toISOString();
    if (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now()) throw fail('PACKAGE_PREPARE_TIMEOUT', 'Original execution deadline expired before preparation.');
    assertLanguageCovered({ environmentId: port.environmentId, mission });
    const testSpec = matrix.testSpec;
    if (!testSpec || typeof testSpec !== 'object') throw fail('PACKAGE_TEST_SPEC_REQUIRED', 'Shared-GPU execution requires a frozen testSpec from the active Profile.');
    const candidateFiles = { [port.candidateEntrypoint]: String(missionRunPy?.content || request.runPy || '') };
    const dependencyFiles = Object.fromEntries(Object.entries(missionRunPy?.implementationFiles || request.implementationFiles || {}));
    for (const [name, content] of Object.entries(dependencyFiles)) {
      if (port.candidateSourceExtensions.some(extension => name.toLowerCase().endsWith(extension))) { candidateFiles[name] = content; delete dependencyFiles[name]; }
    }
    const oracle = request.oracleRunPy;
    if (!oracle) throw fail('PACKAGE_ORACLE_INVALID', 'Execution package requires an independent acceptance entrypoint.');
    const candidateDigest = /^sha256:[a-f0-9]{64}$/.test(request.candidate?.digest || '')
      ? request.candidate.digest
      : contentDigest(Buffer.from(candidateFiles[port.candidateEntrypoint], 'utf8'));
    const semanticDigest = request.semanticBinding?.semanticDigest && /^sha256:[a-f0-9]{64}$/.test(request.semanticBinding.semanticDigest)
      ? request.semanticBinding.semanticDigest
      : contentDigest(Buffer.from(canonicalJson(testSpec), 'utf8'));
    const assembled = await executionPackageStore.assemble({
      language: port.language, adapter: packageAdapter, environmentId: port.environmentId,
      binding: { missionId: request.missionId, workspaceId: mission.workspaceId || mission.id || request.missionId, candidateId: request.candidate?.id, candidateDigest },
      candidateEntrypoint: port.candidateEntrypoint, candidateFiles, dependencyFiles,
      acceptance: { entrypoint: port.acceptanceEntrypoint, files: { [port.acceptanceEntrypoint]: oracle }, semanticDigest, testSpec }, build: {},
    });
    const admission = await executionPackageStore.prepare(assembled.packageDigest, { deadline });
    return {
      ...request,
      candidate: { ...request.candidate, digest: candidateDigest },
      workspaceId: mission.workspaceId || mission.id || request.missionId,
      packageDigest: assembled.packageDigest, admissionId: admission.admissionId,
      preparedArtifactDigest: admission.preparedArtifactDigest,
      environmentDigest: admission.environmentDigest, acceptanceDigest: admission.acceptanceDigest,
      target: admission.target, build: admission.build, adapter: admission.adapter,
      checks: [...port.checks],
      deadline,
    };
  };
};
