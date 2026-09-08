const fail = (code) => ({ verified: false, code });
const digest = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.toLowerCase().replace(/^sha256:/u, '');
  return /^[a-f0-9]{64}$/u.test(raw) ? raw : null;
};
const prefixed = (value) => {
  const raw = digest(value);
  return raw ? `sha256:${raw}` : null;
};
const normalizedEvidence = (value) => {
  if (!value || typeof value !== 'object') return null;
  // A worker cannot downgrade a live-GPU claim to a simulated receipt. An
  // omitted legacy flag is derived from the authoritative execution mode,
  // but an explicit false is a conflict and must be rejected.
  if (value.liveHardware === false) return null;
  const result = { ...value };
  for (const key of ['patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest']) {
    const normalized = digest(value[key]);
    if (!normalized) return null;
    result[key] = normalized;
  }
  result.liveHardware = result.executionMode === 'gpu';
  return result;
};
const sameEvidence = (left, right) => {
  const a = normalizedEvidence(left); const b = normalizedEvidence(right);
  return a && b && JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Trusted composition-root verifier for shared-host GPU observations.
 * Worker flags are ignored: the package admission and the persisted result
 * binding are the only authorities that can produce a verified receipt.
 */
export const createSharedGpuExperienceVerifier = ({ executionPackageStore, packageAdapter, readTask, now = () => Date.now() } = {}) => {
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
    if (benchmark.status !== 'complete' || benchmark.resourceRelease?.confirmed === false || !result?.experienceEvidence || !sameEvidence(result.experienceEvidence, evidence)) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
    if (benchmark.candidate?.id !== evidence.candidateId || prefixed(benchmark.candidate?.digest) !== prefixed(evidence.patchDigest)) return fail('EXECUTION_PACKAGE_CANDIDATE_MISMATCH');
    if (state.appliedCandidateId && state.appliedCandidateId !== evidence.candidateId) return fail('EXECUTION_PACKAGE_CANDIDATE_MISMATCH');
    if (packageBinding.packageDigest !== prefixed(evidence.packageDigest)
      || packageBinding.environmentDigest !== prefixed(evidence.environmentDigest)
      || packageBinding.acceptanceDigest !== prefixed(evidence.acceptanceDigest)) return fail('EXECUTION_PACKAGE_BINDING_MISMATCH');
    if (packageBinding.workspaceId !== (mission.workspaceId || mission.id)) return fail('EXECUTION_PACKAGE_WORKSPACE_MISMATCH');
    if (!packageBinding.admissionId || !packageBinding.preparedArtifactDigest) return fail('EXECUTION_PACKAGE_ADMISSION_MISSING');
    const request = {
      packageDigest: packageBinding.packageDigest,
      admissionId: packageBinding.admissionId,
      missionId: mission.id,
      workspaceId: packageBinding.workspaceId,
      purpose: benchmark.purpose || 'candidate',
      candidate: { id: evidence.candidateId, digest: prefixed(evidence.patchDigest) },
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
    if (typeof readTask === 'function') {
      let task;
      try { task = await readTask(benchmark.testTaskId); } catch { return fail('EXECUTION_PACKAGE_QUEUE_UNAVAILABLE'); }
      if (!task || task.taskId !== benchmark.testTaskId || task.status !== 'completed' || task.resourceRelease?.confirmed !== true) return fail('EXECUTION_PACKAGE_QUEUE_NOT_TERMINAL');
      if (!task.result?.experienceEvidence || !sameEvidence(task.result.experienceEvidence, evidence)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
    }
    let verified;
    try { verified = await executionPackageStore.verifyAdmission(request); }
    catch { return fail('EXECUTION_PACKAGE_ADMISSION_INVALID'); }
    if (signal?.aborted) throw signal.reason;
    if (packageBinding.preparedArtifactDigest !== verified.admission?.preparedArtifactDigest) return fail('EXECUTION_PACKAGE_ARTIFACT_BINDING_MISMATCH');
    const artifact = await packageAdapter.verifyPreparedArtifact({
      manifest: verified.manifest, environment: verified.environment,
      preparedArtifactDigest: verified.admission.preparedArtifactDigest,
    });
    if (artifact?.valid !== true) return fail('EXECUTION_PACKAGE_ARTIFACT_INVALID');
    return {
      verified: true,
      evidence,
      summary: `Trusted shared-GPU package admission ${packageBinding.admissionId} and prepared artifact were revalidated; development evidence remains non-publishable.`,
    };
  };
};
