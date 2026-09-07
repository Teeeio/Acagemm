// Public 03 module surface. Provider and filesystem effects stay behind the
// application-injected ports; only pure prompt/admission functions are exported.
export { buildCandidateGenerationPrompt } from './prompt.mjs';
export {
  candidateWorkspaceRequirements,
  finalizeCandidateAdmission,
  inspectCandidateDiff,
} from './admission.mjs';

