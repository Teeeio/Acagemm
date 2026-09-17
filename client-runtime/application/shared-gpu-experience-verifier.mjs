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

// Warm the same trusted resolver used by verifyAdmission, outside the short
// collection timer. This grants no evidence authority and accepts no stale value.
export const createSharedGpuExperiencePreflight = ({ environmentResolver, environmentId }) => {
  if (typeof environmentResolver?.resolve !== 'function' || typeof environmentId !== 'string' || !environmentId) {
    throw new TypeError('Shared-GPU experience preflight requires a trusted resolver and environment id');
  }
  return async ({ observation, signal }) => {
    if (signal?.aborted) throw signal.reason;
    const expected = digest(observation?.environmentDigest);
    if (!expected) throw Object.assign(new Error('Observation has no bound environment digest'), { code: 'PACKAGE_ENVIRONMENT_CHANGED', status: 409 });
    const environment = await environmentResolver.resolve(environmentId, { refresh: true });
    if (signal?.aborted) throw signal.reason;
    if (environment?.id !== environmentId || digest(environment?.digest) !== expected) {
      throw Object.assign(new Error('Bound observation environment changed during preflight'), { code: 'PACKAGE_ENVIRONMENT_CHANGED', status: 409 });
    }
    return { environmentDigest: environment.digest };
  };
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
const plainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
// Structural comparison of the whole authorized receipt, independent of key
// order: the runner appends `architecture` after `liveHardware`, while the
// canonical recorded evidence carries it among the declared fields. Key order
// is not identity, but every own field - including unknown extras - must still
// match exactly, so dropping `architecture` or flipping a value still fails.
const sameValue = (left, right) => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left); const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) return false;
  if (leftArray) return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  if (!plainObject(left) || !plainObject(right)) return false;
  const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
};
const sameEvidence = (left, right) => {
  const a = normalizedEvidence(left); const b = normalizedEvidence(right);
  return a !== null && b !== null && sameValue(a, b);
};

// A failed execution is learnable only as an operator correctness failure. These
// are the two frozen candidate codes; anything else (oracle, backend, preflight,
// benchmark) keeps its own identity and never becomes operator experience.
const FAILED_CANDIDATE_CODES = new Set(['OPERATOR_CORRECTNESS_MISMATCH', 'OPERATOR_CANDIDATE_EXCEPTION']);
// The whole failed correctness detail suffix - code/phase/role/case/category/counts
// and the real error - is bounded, not only the error message. Case/category are
// bounded separately so an overlong name cannot crowd out the typed identity.
const FAILURE_DETAIL_LIMIT = 2000;
const FAILED_CASE_TEXT_LIMIT = 200;

const boundedText = (value, limit) => {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= limit ? text : text.slice(0, limit);
};

// Deterministic, contract-bounded detail for a verified failed candidate. The
// typed code/phase/role, failed case identity and real counts always survive; the
// error keeps its real prefix and is truncated last so the suffix stays <=2000.
const failedCorrectnessDetail = ({ failure, correctness }) => {
  const category = boundedText(correctness.failedCaseCategory, FAILED_CASE_TEXT_LIMIT);
  const head = `code=${failure.code} phase=${failure.phase} role=${failure.role}`
    + `; case=${boundedText(correctness.failedCaseName, FAILED_CASE_TEXT_LIMIT)}${category ? ` category=${category}` : ''}`
    + `; total=${correctness.total} executed=${correctness.executedCases} passed=${correctness.passedCases}; error=`;
  const remaining = Math.max(0, FAILURE_DETAIL_LIMIT - head.length);
  return `${head}${failure.message.slice(0, remaining)}`;
};

// Strict shape admission for a failed candidate observation. It returns a
// production-owned rejection code or null; it never rewrites the observation,
// the projected result or the queue receipt (the caller asserts that separately).
// Contract: docs/development/FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md.
const rejectFailedObservation = ({ benchmark, result, evidence }) => {
  if (benchmark?.status !== 'failed' || benchmark?.purpose !== 'candidate' || benchmark.resourceRelease?.confirmed !== true) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (!result || result.status !== 'failed' || result.publishable !== false) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (!result.experienceEvidence || !sameEvidence(result.experienceEvidence, evidence)) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (evidence.outcome !== 'failed' || evidence.operation !== 'test' || evidence.liveHardware !== true) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  // Every concrete benchmark request/run identity must be the recorded observation run.
  if (benchmark.requestId != null && benchmark.requestId !== evidence.runId) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
  if (benchmark.runId != null && benchmark.runId !== evidence.runId) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
  // A genuine failure requires a real probed shared-GPU target. The declared
  // environment fields must be the real shared-GPU identity: a mock/cpu/simulated
  // source, hardware or execution mode is never eligible operator experience, and
  // an explicit non-live/publishable conflict fails closed rather than being
  // inferred away.
  const environment = result.environment;
  if (!plainObject(environment)) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (environment.source !== 'local-shared-gpu' || environment.hardware !== 'nvidia-gpu') return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (environment.executionMode !== 'gpu' || environment.liveHardware === false || environment.publishable === true) {
    return fail('EXECUTION_PACKAGE_EVIDENCE_UNAVAILABLE');
  }
  const probe = environment.targetProbe;
  const deviceName = plainObject(probe) && typeof probe.deviceName === 'string' ? probe.deviceName.trim() : '';
  const driverVersion = plainObject(probe) && typeof probe.driverVersion === 'string' ? probe.driverVersion.trim() : '';
  if (!deviceName || !driverVersion) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  // Top-level correctness is the authority; never a fabricated benchmark row.
  const correctness = result.correctness;
  if (!plainObject(correctness) || correctness.status !== 'failed' || correctness.passed !== false) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  const total = correctness.total;
  const executedCases = correctness.executedCases;
  const passedCases = correctness.passedCases;
  if (!Number.isInteger(total) || total < 1) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (!Number.isInteger(executedCases) || executedCases < 1 || executedCases > total) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (passedCases !== executedCases - 1 || correctness.failedCase !== executedCases) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (!Array.isArray(correctness.caseResults) || correctness.caseResults.length !== executedCases) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  const failedCaseName = typeof correctness.failedCaseName === 'string' ? correctness.failedCaseName.trim() : '';
  if (!failedCaseName) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  const error = result.error;
  // The frozen producer DTO is {code,message,phase,role,retryable,details}: the
  // message must be real nonempty text, retryable must be the deterministic false,
  // and details must be the producer's plain object rather than a missing/array slot.
  if (!plainObject(error) || typeof error.message !== 'string' || !error.message.trim()) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (error.retryable !== false || !plainObject(error.details)) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  if (!FAILED_CANDIDATE_CODES.has(error.code) || error.phase !== 'correctness' || error.role !== 'candidate') return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  // result.error / correctness.failure / the final case failure are the same typed
  // value; correctness.error and each case.error keep the real string error.message.
  if (correctness.error !== error.message || !sameValue(correctness.failure, error)) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
  for (let index = 0; index < executedCases; index += 1) {
    const item = correctness.caseResults[index];
    // Every attempted case must be a real named case; a fabricated or blank prefix
    // name is never an observed operator failure.
    if (!plainObject(item) || typeof item.case !== 'string' || !item.case.trim()) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
    if (index < executedCases - 1) {
      if (item.passed !== true) return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
    } else if (item.passed !== false || item.case !== failedCaseName || item.error !== error.message || !sameValue(item.failure, error)) {
      return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
    }
  }
  return null;
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
    // Legacy success and strict failure are explicit, mutually exclusive paths. Any
    // failed claim selects the strict path so a contradictory status can never be
    // admitted by the completed-only success checks; the strict path then re-proves
    // every terminal field instead of trusting the claim.
    const failedObservation = benchmark?.status === 'failed' || result?.status === 'failed' || evidence?.outcome === 'failed';
    let failedSummary = null;
    if (failedObservation) {
      const rejection = rejectFailedObservation({ benchmark, result, evidence });
      if (rejection) return rejection;
      const correctness = result.correctness;
      const failure = result.error;
      // The trusted-admission explanation stays; the failed correctness detail that
      // follows is the contract-bounded (<=2000) suffix, never the raw full error.
      failedSummary = 'Trusted shared-GPU package admission and prepared artifact were revalidated; '
        + 'development evidence remains non-publishable. '
        + failedCorrectnessDetail({ failure, correctness });
    } else if (benchmark.status !== 'complete' || benchmark.resourceRelease?.confirmed === false || !result?.experienceEvidence || !sameEvidence(result.experienceEvidence, evidence)) {
      return fail('EXECUTION_PACKAGE_EVIDENCE_MISMATCH');
    }
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
    if (failedObservation) {
      // readTask is mandatory for the failed path: without the independent queue
      // receipt a failed worker claim cannot be authorized.
      if (typeof readTask !== 'function') return fail('EXECUTION_PACKAGE_QUEUE_UNAVAILABLE');
      let task;
      try { task = await readTask(benchmark.testTaskId); } catch { return fail('EXECUTION_PACKAGE_QUEUE_UNAVAILABLE'); }
      if (!task || task.taskId !== benchmark.testTaskId || task.status !== 'failed' || task.resourceRelease?.confirmed !== true) return fail('EXECUTION_PACKAGE_QUEUE_NOT_TERMINAL');
      const queued = task.result;
      const payload = task.payload;
      const expectedWorkspaceId = mission.workspaceId || mission.id;
      if (!queued || !payload) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      // Queue payload identity must agree with the recorded evidence and the
      // active Mission/Workspace/candidate, using digest normalization only. A
      // declared purpose must be the candidate purpose, and the payload's
      // target/build/adapter must equal the selected package by full value rather
      // than merely being present.
      if (payload.purpose != null && payload.purpose !== 'candidate') return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (payload.missionId !== mission.id || payload.requestId !== evidence.runId
        || payload.workspaceId !== expectedWorkspaceId || payload.workspaceId !== packageBinding.workspaceId) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (!sameValue(payload.target, packageBinding.target)
        || !sameValue(payload.build, packageBinding.build)
        || !sameValue(payload.adapter, packageBinding.adapter)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (payload.candidate?.id !== evidence.candidateId || prefixed(payload.candidate?.digest) !== prefixed(evidence.patchDigest)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (prefixed(payload.packageDigest) !== prefixed(evidence.packageDigest)
        || prefixed(payload.environmentDigest) !== prefixed(evidence.environmentDigest)
        || prefixed(payload.acceptanceDigest) !== prefixed(evidence.acceptanceDigest)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (payload.admissionId !== packageBinding.admissionId
        || prefixed(payload.preparedArtifactDigest) !== prefixed(packageBinding.preparedArtifactDigest)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      // The persisted queue receipt must agree with the projection on the whole
      // correctness, typed error, evidence and package binding, not on booleans.
      if (queued.status !== 'failed' || queued.publishable !== false) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (!sameEvidence(queued.experienceEvidence, evidence)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (!sameValue(queued.correctness, result.correctness) || !sameValue(queued.error, result.error)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      // The queue receipt's own environment must carry the same real probe and
      // shared-GPU fields; a one-sided projection is never trusted.
      if (!sameValue(queued.environment, result.environment)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
      if (!sameValue(queued.executionPackage, packageBinding)) return fail('EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH');
    } else if (typeof readTask === 'function') {
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
      summary: failedSummary
        || `Trusted shared-GPU package admission ${packageBinding.admissionId} and prepared artifact were revalidated; development evidence remains non-publishable.`,
    };
  };
};
