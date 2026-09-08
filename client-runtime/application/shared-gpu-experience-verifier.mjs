const fail = (code) => ({ verified: false, code });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Trusted composition-root verifier for shared-host GPU observations.
 * Worker flags are ignored: the package admission and the persisted result
 * binding are the only authorities that can produce a verified receipt.
 */
export const createSharedGpuExperienceVerifier = ({ executionPackageStore, packageAdapter, now = () => Date.now() } = {}) => {
  if (typeof executionPackageStore?.verifyAdmission !== 'function') throw new TypeError('executionPackageStore.verifyAdmission is required');
  if (typeof packageAdapter?.verifyPreparedArtifact !== 'function') throw new TypeError('packageAdapter.verifyPreparedArtifact is required');
  return async ({ state, mission, observation, signal }) => {
    if (signal?.aborted) throw signal.reason;
    const evidence = observation?.evidence;
    const benchmark = state?.benchmark;
    const result = benchmark?.result;
    const packageBinding = result?.executionPackage || benchmark?.executionPackage;
    if (!packageBinding || evidence?.executionMode !== 'gpu' || evidence.hardware !== 'nvidia-gpu') return fail('EXECUTION_PACKAGE_EVIDENCE_UNAVAILABLE');
    if (state.activeMissionId !== mission?.id || evidence.missionId !== mission?.id) return fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT');
    if (benchmark.status !== 'complete' || !result?.experienceEvidence || !same(result.experienceEvidence, evidence)) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
    if (benchmark.candidate?.id !== evidence.candidateId || benchmark.candidate?.digest !== evidence.patchDigest) return fail('EXECUTION_PACKAGE_CANDIDATE_MISMATCH');
    if (packageBinding.packageDigest !== evidence.packageDigest
      || packageBinding.environmentDigest !== evidence.environmentDigest
      || packageBinding.acceptanceDigest !== evidence.acceptanceDigest) return fail('EXECUTION_PACKAGE_BINDING_MISMATCH');
    if (packageBinding.workspaceId !== (mission.workspaceId || mission.id)) return fail('EXECUTION_PACKAGE_WORKSPACE_MISMATCH');
    if (!packageBinding.admissionId || !packageBinding.preparedArtifactDigest) return fail('EXECUTION_PACKAGE_ADMISSION_MISSING');
    const request = {
      packageDigest: packageBinding.packageDigest,
      admissionId: packageBinding.admissionId,
      missionId: mission.id,
      workspaceId: packageBinding.workspaceId,
      purpose: benchmark.purpose || 'candidate',
      candidate: { id: evidence.candidateId, digest: evidence.patchDigest },
      environmentDigest: packageBinding.environmentDigest,
      acceptanceDigest: packageBinding.acceptanceDigest,
      target: packageBinding.target,
      build: packageBinding.build,
      adapter: packageBinding.adapter,
      checks: ['correctness', 'benchmark'],
      requestId: evidence.runId,
      deadline: new Date(now() + 120000).toISOString(),
      limits: { timeoutSeconds: 1 },
    };
    let verified;
    try { verified = await executionPackageStore.verifyAdmission(request); }
    catch { return fail('EXECUTION_PACKAGE_ADMISSION_INVALID'); }
    if (signal?.aborted) throw signal.reason;
    const artifact = await packageAdapter.verifyPreparedArtifact({
      manifest: verified.manifest, environment: verified.environment,
      preparedArtifactDigest: packageBinding.preparedArtifactDigest,
    });
    if (artifact?.valid !== true) return fail('EXECUTION_PACKAGE_ARTIFACT_INVALID');
    return {
      verified: true,
      evidence,
      summary: `Trusted shared-GPU package admission ${packageBinding.admissionId} and prepared artifact were revalidated; development evidence remains non-publishable.`,
    };
  };
};
