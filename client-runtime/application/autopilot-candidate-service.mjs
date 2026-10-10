export const selectAutopilotCandidate = (state) => {
  const candidates = state?.candidateEvaluations || [];
  return candidates.find((item) => item.patchDigest)
    || candidates.find((item) => item.acceptGate?.passed === true || item.classification === 'eligible')
    || candidates[0]
    || null;
};
