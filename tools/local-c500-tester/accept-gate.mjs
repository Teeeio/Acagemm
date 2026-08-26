const rule = (id, passed, required = true) => ({ id, passed: Boolean(passed), required });

export const evaluateLocalAcceptGate = ({ baseline = {}, candidate = {}, result = {}, currentBest = null } = {}) => {
  const rules = [
    rule('correctness.complete', result.correctness === 'pass'),
    rule('benchmark.valid', result.benchmark?.status === 'completed' && Number.isFinite(Number(result.benchmark?.latency_p50_us))),
    rule('tracer.complete', ['completed', 'generated'].includes(result.tracer?.status)),
    rule('profiler.complete', ['completed', 'generated'].includes(result.profiler?.status)),
    rule('baseline.trusted', baseline.status === 'complete' && Boolean(baseline.source)),
    rule('baseline.same_shape', baseline.shapeKey == null || baseline.shapeKey === result.matrix?.shapeKey),
    rule('candidate.digest', Boolean(candidate.digest) && candidate.digest === result.candidate?.digest),
    rule('performance.improves', Number(result.benchmark?.speedup || 0) > Number(currentBest?.speedup || 0), false),
  ];
  const liveHardware = result.environment?.liveHardware === true;
  const provenance = rule('evidence.provenance', liveHardware, false);
  rules.push(provenance);
  const failedRules = rules.filter((item) => !item.passed).map((item) => item.id);
  const hardFailures = rules.filter((item) => !item.passed && item.required).map((item) => item.id);
  const policyFailures = rules.filter((item) => !item.passed && item.id !== 'evidence.provenance').map((item) => item.id);
  const passed = policyFailures.length === 0;
  const publishable = passed && liveHardware;
  return {
    passed,
    publishable,
    result: hardFailures.length ? 'reject' : publishable ? 'adopt' : 'reference',
    failedRules,
    passedRules: rules.filter((item) => item.passed).map((item) => item.id),
    evaluatedRules: rules.length,
    summary: hardFailures.length ? `Accept Gate failed: ${hardFailures.join(', ')}` : publishable ? 'Accept Gate passed for live hardware adoption' : 'Evidence is simulation-only and cannot be published as real hardware knowledge',
  };
};

export const adoptAcceptedCandidate = ({ gate, candidate, experience = {} } = {}) => {
  if (!gate || gate.result !== 'adopt') return { adopted: false, reason: 'accept_gate_not_adopt' };
  return {
    adopted: true,
    currentBest: {
      candidate_id: candidate.id || candidate.candidate_id,
      digest: candidate.digest || candidate.patchDigest,
      speedup: candidate.speedup || null,
    },
    experience: {
      ...experience,
      sourceCandidate: candidate.id || candidate.candidate_id,
      status: gate.publishable ? 'validated' : 'simulation',
      evidenceLevel: gate.publishable ? 'live_hardware' : 'simulation_only',
    },
  };
};
