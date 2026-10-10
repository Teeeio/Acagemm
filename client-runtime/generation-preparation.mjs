// A failed context read is a committed diagnostic, never an Agent execution.
// Keep its admitted clock separately so pending evidence retains its own round.
export const generationPreparationFailureFor = (snapshot = {}) => {
  const failure = snapshot.iterationStats?.generationPreparationFailure;
  const missionId = snapshot.activeMissionId || snapshot.id;
  const mission = snapshot.missions?.find(item => item.id === missionId) || snapshot;
  if (failure?.schemaVersion !== 1 || failure.phase !== 'experience-read' || failure.effectsStarted !== false
    || failure.missionId !== missionId || failure.projectId !== mission.projectId
    || failure.sourceRunId !== (snapshot.agent?.runId || null)
    || failure.missionBudgetStartedAt !== snapshot.missionBudgetStartedAt
    || failure.semanticDigest !== (mission.semanticSnapshot?.digest || null)
    || failure.pendingManifestDigest !== (snapshot.iterationStats?.pendingFeedback?.manifestDigest || null)
    || !failure.roundBudget?.roundId || failure.roundBudget.status !== 'active'
    || !Number.isFinite(Date.parse(failure.roundBudget.deadlineAt))) return null;
  return failure;
};

export const isDraftPreparationRetry = snapshot => {
  const failure = generationPreparationFailureFor(snapshot);
  return Boolean(failure?.entryKind === 'draft' && !failure.sourceRunId && !failure.pendingManifestDigest);
};

export const throwPreparationFailure = result => {
  const failure = result?.result?.preparationFailure;
  if (failure) throw Object.assign(new Error(failure.error.message), {
    ...failure.error, details: { missionId: failure.missionId, roundId: failure.roundBudget.roundId,
      phase: failure.phase, effectsStarted: false, commandId: result.entry?.commandId,
      nextAction: '修复经验读取问题后显式重试；原 Mission 和轮次预算不会重置。' },
  });
  return result;
};
