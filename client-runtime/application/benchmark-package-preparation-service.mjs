import { canonicalJson, contentDigest } from '../execution-package-contract.mjs';

// 公共准备端口：组合根注入可信 store 与 adapter，本服务只负责包组装、oracle 校验和准入绑定。
// 唯一行为增量是把 admission 的可信 preparedArtifactDigest 写入返回 request；绝不采信 caller/result 回填。
export const createBenchmarkPackagePreparer = ({ executionPackageStore, packageAdapter }) => async ({ request, mission, matrix, missionRunPy }) => {
  const testSpec = matrix.testSpec;
  if (!testSpec || typeof testSpec !== 'object') throw Object.assign(new Error('Shared-GPU execution requires a frozen testSpec from the active Profile.'), { code: 'PACKAGE_TEST_SPEC_REQUIRED', status: 409 });
  const candidateFiles = { 'run.py': String(missionRunPy?.content || request.runPy || '') };
  const dependencyFiles = Object.fromEntries(Object.entries(missionRunPy?.implementationFiles || request.implementationFiles || {}));
  const oracle = request.oracleRunPy;
  if (!oracle) throw Object.assign(new Error('Execution package requires an independent acceptance entrypoint.'), { code: 'PACKAGE_ORACLE_INVALID', status: 409 });
  const candidateDigest = /^sha256:[a-f0-9]{64}$/.test(request.candidate?.digest || '')
    ? request.candidate.digest
    : contentDigest(Buffer.from(candidateFiles['run.py'], 'utf8'));
  const semanticDigest = request.semanticBinding?.semanticDigest && /^sha256:[a-f0-9]{64}$/.test(request.semanticBinding.semanticDigest)
    ? request.semanticBinding.semanticDigest
    : contentDigest(Buffer.from(canonicalJson(testSpec), 'utf8'));
  const assembled = await executionPackageStore.assemble({
    language: 'python', adapter: packageAdapter, environmentId: 'local-shared-gpu',
    binding: { missionId: request.missionId, workspaceId: mission.workspaceId || mission.id || request.missionId, candidateId: request.candidate?.id, candidateDigest },
    candidateEntrypoint: 'run.py', candidateFiles, dependencyFiles,
    acceptance: { entrypoint: 'oracle.py', files: { 'oracle.py': oracle }, semanticDigest, testSpec }, build: {},
  });
  const admission = await executionPackageStore.prepare(assembled.packageDigest);
  return {
    ...request,
    candidate: { ...request.candidate, digest: candidateDigest },
    workspaceId: mission.workspaceId || mission.id || request.missionId,
    packageDigest: assembled.packageDigest, admissionId: admission.admissionId,
    preparedArtifactDigest: admission.preparedArtifactDigest,
    environmentDigest: admission.environmentDigest, acceptanceDigest: admission.acceptanceDigest,
    target: admission.target, build: admission.build, adapter: admission.adapter,
    checks: ['correctness', 'benchmark'],
    deadline: new Date(Date.now() + Number(request.limits?.timeoutSeconds || 600) * 1000).toISOString(),
  };
};
