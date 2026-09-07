import { validateOperatorLanguageCandidate } from '../operator-language.mjs';

// Manifest, file inventory and content are supplied by the Workspace adapter.
export function inspectCandidateDiff({ agentResult, manifest, stableDigest = null, provider, runId }) {
  let candidateValidation = null;
  let verifiedCandidates = agentResult.candidates;
  if (agentResult.candidates.length) {
    const selectedCandidate = agentResult.candidates.find((candidate) => candidate.id === agentResult.recommendedCandidate) || agentResult.candidates[0];
    const declaredFiles = String(selectedCandidate.files || '').split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
    const actualFiles = manifest.changedFiles.map((file) => file.replaceAll('\\', '/'));
    const undeclaredFiles = actualFiles.filter((file) => !declaredFiles.includes(file));
    const missingFiles = declaredFiles.filter((file) => !actualFiles.includes(file));
    if (!manifest.dirty || !manifest.diff || (stableDigest && manifest.digest === stableDigest)) {
      candidateValidation = { passed: false, code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_EMPTY`, detail: `${provider.name} 返回了候选，但 Mission 工作区没有真实 Git Diff。` };
      verifiedCandidates = [];
    } else if (undeclaredFiles.length || missingFiles.length) {
      candidateValidation = { passed: false, code: `${provider.slug.toUpperCase()}_CANDIDATE_FILES_MISMATCH`, detail: `候选文件清单与真实 Diff 不一致。未声明：${undeclaredFiles.join(', ') || '无'}；未修改：${missingFiles.join(', ') || '无'}。`, undeclaredFiles, missingFiles };
      verifiedCandidates = [];
    } else {
      // 工作区 Git Diff 是候选准入权威。来源引用只作信息标记（候选自报），不校验、不阻塞准入——
      // 迁移场景中参考材料可能含非 git 内容、agent 引用 commit 也可能与实际拉取不一致，强制校验会误拦。
      const claimedReferences = Array.isArray(selectedCandidate.sourceReferences) ? selectedCandidate.sourceReferences : [];
      candidateValidation = { passed: true, code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_VERIFIED`, digest: manifest.digest, files: actualFiles, sourceReferences: claimedReferences, sourceReferencesNote: '候选自报来源标记，未做固定来源校验（工作区 Diff 为准入权威）' };
      verifiedCandidates = [{ ...selectedCandidate, files: actualFiles.join(', '), sourceReferences: claimedReferences, patchDigest: manifest.digest, sourceRunId: runId }];
    }
  } else {
    const actualFiles = manifest.changedFiles.map((file) => file.replaceAll('\\', '/'));
    if (manifest.dirty && manifest.diff && actualFiles.length && (!stableDigest || manifest.digest !== stableDigest)) {
      const claimedReferences = Array.isArray(agentResult.sourceReferences) ? agentResult.sourceReferences : [];
      candidateValidation = { passed: true, code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_OBSERVED`, digest: manifest.digest, files: actualFiles, sourceReferences: claimedReferences, sourceReferencesNote: 'Agent 未返回 candidates；客户端以 Mission 工作区 Git Diff 作为候选准入权威。' };
      verifiedCandidates = [{
        id: 'candidate-01',
        version: 'agent.1',
        label: 'Observed workspace candidate',
        title: actualFiles.includes('run.py') ? '单文件 run.py 优化候选' : 'Agent 工作区 Diff 候选',
        hypothesis: agentResult.summary || 'Agent 已在 Mission 工作区产生候选 Diff。',
        change: actualFiles.join(', '),
        files: actualFiles.join(', '),
        status: '待验证',
        classification: 'weak_candidate',
        acceptGate: { passed: false, result: 'pending', checks: [] },
        correctness: 'pending',
        decision: 'pending',
        decisionReason: '',
        evidence: [],
        knowledge: null,
        sourceReferences: claimedReferences,
        tone: 'blue',
        source: `${provider.slug}-agent`,
        patchDigest: manifest.digest,
        sourceRunId: runId,
      }];
    }
  }
  return { candidateValidation, verifiedCandidates };
}

export function candidateWorkspaceRequirements(mission = {}) {
  const contract = mission.operatorProfile?.candidateContract;
  return {
    requiredWorkspaceFiles: [...(contract?.requiredWorkspaceFiles || ['run.py'])],
    contentFiles: [...(contract?.contentFiles || ['run.py'])],
  };
}

// Language validation, repeated-diff rejection and ordinal assignment remain pure.
export function finalizeCandidateAdmission({
  admission, mission = {}, workspaceFiles = [], entryContent = '',
  runHistory = [], round = 0, provider,
}) {
  let { candidateValidation, verifiedCandidates } = admission;
  if (!verifiedCandidates.length) return admission;
  const strictZeroSource = mission.sourcePolicy?.mode === 'agent-research-only' || mission.sourcePolicy?.strictZeroSource === true;
  const previousDigests = new Set(runHistory.map((round) => round.candidateDigest).filter(Boolean));
  const nextDigest = verifiedCandidates[0].patchDigest;
  const changedFiles = String(verifiedCandidates[0].files || '').split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
  const candidateContract = mission.operatorProfile?.candidateContract || null;
  const languageValidation = validateOperatorLanguageCandidate({ language: mission.implementation, changedFiles, workspaceFiles, entryContent, contract: candidateContract });
  if ((strictZeroSource || mission.implementation) && !languageValidation.passed) {
    candidateValidation = {
      passed: false,
      code: 'CANDIDATE_LANGUAGE_CONTRACT_FAILED',
      detail: `候选不符合 ${languageValidation.language} 文件/语言契约。unexpected=${languageValidation.unexpected.join(',') || '-'} missing=${languageValidation.missing.join(',') || '-'} missingWorkspace=${languageValidation.missingWorkspace.join(',') || '-'} missingAny=${languageValidation.missingAny.join(',') || '-'} contentMismatch=${languageValidation.contentMismatch}`,
      languageValidation,
    };
    verifiedCandidates = [];
  } else if (previousDigests.has(nextDigest)) {
    candidateValidation = { passed: false, code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_REPEATED`, detail: '该工作区 Diff 已在前一轮测试，不能重复消耗新的硬件测量序号。', digest: nextDigest };
    verifiedCandidates = [];
  } else {
    const ordinal = Math.max(1, Number(round || 0) + 1);
    const candidateId = `candidate-${String(ordinal).padStart(2, '0')}`;
    verifiedCandidates = verifiedCandidates.map((candidate) => ({
      ...candidate,
      agentOriginalId: candidate.id || null,
      id: candidateId,
      version: `agent.${ordinal}`,
    }));
  }
  return { candidateValidation, verifiedCandidates };
}
