// Public 03 module surface. Provider and filesystem effects stay behind the
// application-injected ports; only pure prompt/admission/classification
// functions are exported.
export { buildCandidateGenerationPrompt } from './prompt.mjs';
export {
  candidateWorkspaceRequirements,
  finalizeCandidateAdmission,
  inspectCandidateDiff,
} from './admission.mjs';
export {
  CANDIDATE_GENERATION_PATH,
  CANDIDATE_OUTCOME,
  CANDIDATE_PARSE_CLASSIFICATION,
  classifyEmptyCandidateOutcome,
  classifyParsedCandidateGeneration,
  describeGenerationPath,
  editToolSignal,
} from './classification.mjs';
