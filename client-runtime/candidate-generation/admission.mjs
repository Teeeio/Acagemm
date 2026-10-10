import { operatorLanguageWorkspaceRequirement, validateOperatorLanguageCandidate } from '../operator-language.mjs';
import { briefProducedNoObservation } from '../experiment-brief.mjs';

// How many times an artifact whose attempts never produced an observation may be
// re-tested before the repeat rejection applies again. Small on purpose: the bound
// exists so a broken environment cannot turn one artifact into unbounded hardware time.
const MAX_UNOBSERVED_RETESTS = 2;
import {
  CANDIDATE_GENERATION_PATH,
  CANDIDATE_OUTCOME,
  describeGenerationPath,
} from './classification.mjs';

// Manifest, file inventory and content are supplied by the Workspace adapter.
// `generationPath` 是可选的上游观测（生成路径 + 编辑工具状态）。它只作为事实标记
// 透传，不参与任何 passed 判定：准入权威永远是工作区 Git Diff。
export function inspectCandidateDiff({ agentResult, manifest, stableDigest = null, provider, runId, generationPath = null }) {
  const observed = generationPath || {};
  const pathDescriptor = describeGenerationPath({
    path: observed.path || CANDIDATE_GENERATION_PATH.STRUCTURED_EDIT,
    editToolStatus: observed.editToolStatus || 'absent',
    degraded: observed.degraded === true,
    degradationReason: observed.degradationReason || null,
  });
  const patchRejected = observed.patchRejected === true;
  // 编辑工具状态不再单独抽出判据：它是事实标记，随 stamp 铺到每条 validation 上
  // （editToolStatus），但不决定分类——分类只回答「候选去哪了」，而工具状态回答
  // 「怎么生成的」。两者混用会让一个已准入的候选被贴上根因码。
  // 失败分支同样带上标记，否则「候选去哪了」在这些分支又变回无因标签。
  const stamp = (validation, extra) => ({
    ...validation,
    ...pathDescriptor,
    ...extra,
  });
  let candidateValidation = null;
  let verifiedCandidates = [];
  if (agentResult.candidates.length) {
    const selectedCandidate = agentResult.candidates.find((candidate) => candidate.id === agentResult.recommendedCandidate) || agentResult.candidates[0];
    const declaredFiles = String(selectedCandidate.files || '').split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
    const actualFiles = manifest.changedFiles.map((file) => file.replaceAll('\\', '/'));
    const undeclaredFiles = actualFiles.filter((file) => !declaredFiles.includes(file));
    const missingFiles = declaredFiles.filter((file) => !actualFiles.includes(file));
    if (!manifest.dirty || !manifest.diff || (stableDigest && manifest.digest === stableDigest)) {
      candidateValidation = stamp({
        passed: false,
        code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_EMPTY`,
        detail: `${provider.name} 返回了候选，但 Mission 工作区没有真实 Git Diff。`,
        classification: patchRejected ? CANDIDATE_OUTCOME.PATCH_ADMISSION_FAILED : CANDIDATE_OUTCOME.WORKSPACE_CAPTURE_GAP,
        declaredFiles,
        observedFiles: actualFiles,
      }, { patchValidation: patchRejected ? 'rejected' : 'not_applicable', workspaceAdmission: 'failed' });
      verifiedCandidates = [];
    } else if (undeclaredFiles.length || missingFiles.length) {
      candidateValidation = stamp({
        passed: false,
        code: `${provider.slug.toUpperCase()}_CANDIDATE_FILES_MISMATCH`,
        detail: `候选文件清单与真实 Diff 不一致。未声明：${undeclaredFiles.join(', ') || '无'}；未修改：${missingFiles.join(', ') || '无'}。`,
        classification: CANDIDATE_OUTCOME.WORKSPACE_CAPTURE_GAP,
        undeclaredFiles,
        missingFiles,
      }, { patchValidation: 'passed', workspaceAdmission: 'failed' });
      verifiedCandidates = [];
    } else {
      // 工作区 Git Diff 是候选准入权威。来源引用只作信息标记（候选自报），不校验、不阻塞准入——
      // 迁移场景中参考材料可能含非 git 内容、agent 引用 commit 也可能与实际拉取不一致，强制校验会误拦。
      const claimedReferences = Array.isArray(selectedCandidate.sourceReferences) ? selectedCandidate.sourceReferences : [];
      candidateValidation = stamp({
        passed: true,
        code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_VERIFIED`,
        digest: manifest.digest,
        files: actualFiles,
        sourceReferences: claimedReferences,
        sourceReferencesNote: '候选自报来源标记，未做固定来源校验（工作区 Diff 为准入权威）',
        classification: CANDIDATE_OUTCOME.CANDIDATE_VERIFIED,
      }, { patchValidation: 'passed', workspaceAdmission: 'passed' });
      verifiedCandidates = [{
        ...selectedCandidate,
        files: actualFiles.join(', '),
        sourceReferences: claimedReferences,
        patchDigest: manifest.digest,
        sourceRunId: runId,
        ...pathDescriptor,
        patchValidation: 'passed',
        workspaceAdmission: 'passed',
      }];
    }
  } else {
    const actualFiles = manifest.changedFiles.map((file) => file.replaceAll('\\', '/'));
    if (manifest.dirty && manifest.diff && actualFiles.length && (!stableDigest || manifest.digest !== stableDigest)) {
      // 模型没返回候选、但工作区有真实 Diff：这里的候选是「观测所得」，不是模型声明的，
      // 因此必须显式标降级，不能再静默通过。
      const claimedReferences = Array.isArray(agentResult.sourceReferences) ? agentResult.sourceReferences : [];
      const observedDescriptor = describeGenerationPath({
        path: CANDIDATE_GENERATION_PATH.WORKSPACE_OBSERVED,
        editToolStatus: pathDescriptor.editToolStatus,
        degraded: true,
        degradationReason: 'candidates_absent_but_diff_observed',
      });
      candidateValidation = {
        passed: true,
        code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_OBSERVED`,
        digest: manifest.digest,
        files: actualFiles,
        sourceReferences: claimedReferences,
        sourceReferencesNote: 'Agent 未返回 candidates；客户端以 Mission 工作区 Git Diff 作为候选准入权威。',
        // 这一支的判定事实是「没有声明、却有真实 Diff、且已准入」，与 capture_gap
        // （声明了候选却看不见 Diff）方向相反，不能共用标签，否则一个 passed:true 的
        // 候选会带着「工作区捕获失败」的诊断流进 loop.needs_human 与决策记录。
        // 编辑工具是否失败不属于本码：它已由上面的 generationPath 描述符（editToolStatus）
        // 如实携带，准入权威仍是工作区 Git Diff。
        classification: CANDIDATE_OUTCOME.WORKSPACE_OBSERVED_CANDIDATE,
        ...observedDescriptor,
        patchValidation: 'not_applicable',
        workspaceAdmission: 'passed',
      };
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
        ...observedDescriptor,
        patchValidation: 'not_applicable',
        workspaceAdmission: 'passed',
      }];
    }
  }
  return { candidateValidation, verifiedCandidates };
}

export function candidateWorkspaceRequirements(mission = {}) {
  const contract = mission.operatorProfile?.candidateContract;
  // The inventory must be collected for exactly the files the language contract
  // validates, otherwise the check reads a list nobody gathered and reports every
  // required file as missing. Both sides read one function.
  return {
    requiredWorkspaceFiles: operatorLanguageWorkspaceRequirement(mission.implementation, contract),
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
  // Re-testing an identical diff normally buys nothing: the same artifact already
  // consumed a hardware measurement slot, and a confirmed result — pass or fail — must
  // not be re-run to fish for a different one.
  //
  // An attempt the environment killed is not that. It never observed the artifact, so
  // retrying the identical artifact is the *same* experiment resumed, not a second
  // one. Only when every prior attempt at this digest ended that way is the retest
  // allowed, and only up to a small bound: a chronically flaky environment is not a
  // licence to loop on one artifact, and each retry still costs a real measurement.
  const priorAttempts = runHistory.filter((round) => round?.candidateDigest === nextDigest);
  const retestOfUnobservedArtifact = priorAttempts.length > 0
    && priorAttempts.length < MAX_UNOBSERVED_RETESTS
    && priorAttempts.every((round) => briefProducedNoObservation(round?.benchmark?.experimentBrief));
  const changedFiles = String(verifiedCandidates[0].files || '').split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
  const candidateContract = mission.operatorProfile?.candidateContract || null;
  const languageValidation = validateOperatorLanguageCandidate({ language: mission.implementation, changedFiles, workspaceFiles, entryContent, contract: candidateContract });
  if ((strictZeroSource || mission.implementation) && !languageValidation.passed) {
    // Two different owners can fail the same contract. A diff that misses or breaks
    // the required files is a candidate problem: the round ran, and the next attempt
    // can repair it. A workspace that does not contain the files the contract
    // declares is a workspace/baseline problem — the first round of a Mission whose
    // workspace was materialized without its entry file looks exactly like this, and
    // reporting it under the candidate's code tells the operator to look at the wrong
    // side. The retry policy is deliberately unchanged (the agent may legitimately
    // create the missing file next round); only the attribution is separated.
    const missingWorkspaceFiles = languageValidation.missingWorkspace;
    const workspaceOwned = missingWorkspaceFiles.length > 0
      && languageValidation.unexpected.length === 0
      && languageValidation.missing.length === 0
      && languageValidation.missingAny.length === 0
      && languageValidation.contentMismatch === false;
    candidateValidation = {
      passed: false,
      code: workspaceOwned ? 'CANDIDATE_WORKSPACE_CONTRACT_UNMET' : 'CANDIDATE_LANGUAGE_CONTRACT_FAILED',
      detail: workspaceOwned
        ? `工作区缺少 ${languageValidation.language} 契约要求的文件：${missingWorkspaceFiles.join(', ')}。这不是候选质量问题：当前工作区（首轮为 Baseline 物化结果）本身不满足已声明的文件契约。`
        : `候选不符合 ${languageValidation.language} 文件/语言契约。unexpected=${languageValidation.unexpected.join(',') || '-'} missing=${languageValidation.missing.join(',') || '-'} missingWorkspace=${missingWorkspaceFiles.join(',') || '-'} missingAny=${languageValidation.missingAny.join(',') || '-'} contentMismatch=${languageValidation.contentMismatch} contentEvidence=${languageValidation.contentEvidence} kernelRouteCovered=${languageValidation.kernelRouteCovered}`,
      // A workspace defect is not one of the "where did the candidate go" root causes,
      // so it carries no classification: labelling it there would claim the candidate
      // generation path was the problem.
      classification: null,
      workspaceOwned,
      missingWorkspaceFiles,
      languageValidation,
    };
    verifiedCandidates = [];
  } else if (previousDigests.has(nextDigest) && !retestOfUnobservedArtifact) {
    const priorAttemptCount = priorAttempts.length;
    candidateValidation = {
      passed: false,
      code: `${provider.slug.toUpperCase()}_CANDIDATE_DIFF_REPEATED`,
      detail: priorAttemptCount
        ? `该工作区 Diff 已被测试过 ${priorAttemptCount} 次并产生了对候选的观测，不能重复消耗新的硬件测量序号。`
        : '该工作区 Diff 已在前一轮测试，不能重复消耗新的硬件测量序号。',
      digest: nextDigest,
      priorAttemptCount,
    };
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
