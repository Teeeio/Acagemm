import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const exists = async (relative) => access(path.join(root, relative)).then(() => true, () => false);

const removedLegacyModules = [
  'tools/local-c500-tester/cli.mjs',
  'tools/local-c500-tester/workflow-entry.mjs',
  'tools/local-c500-tester/candidate-agent.mjs',
  'tools/local-c500-tester/candidate-generation.mjs',
  'tools/local-c500-tester/local-c500-adapter.mjs',
  'tools/local-c500-tester/accept-gate.mjs',
];

for (const relative of removedLegacyModules) {
  assert.equal(await exists(relative), false, `legacy workflow module must stay removed: ${relative}`);
}

const [stateStore, iterationLoop, localServer, projectRoutes, projectsService, missionRoutes, missionsService, missionQueryRoutes, missionQueryService, semanticRoutes, semanticService, researchRoutes, researchService, runRoutes, runService, reviewRoutes, reviewService, decisionRoutes, decisionService, candidateValidationRoutes, candidateValidationService, baselineRoutes, baselineService, operatorTestRoutes, operatorTestService, missionControlRoutes, missionControlService, knowledgeRoutes, knowledgeService, runtimeQueryRoutes, runtimeQueryService, runtimeStateRoutes, runtimeStateService, resetRoutes, resetService, sourceService, iterationResearchService, roundRecoveryService, agentRoundService, roundPreflightService, roundArtifactGuard, baselineSourceService, materializerPolicyService, baselineFailureProjection, benchmarkProjectionService, repositoryAdoptionService, autopilotCandidateService, autopilotContextService, autopilotCandidateActionService, autopilotValidationService, autopilotService, autopilotBaselineResearchService, autopilotFixedProfileService, autopilotStrictSourceService, autopilotCandidateBaselineService, baselineBenchmarkService, baselineMaterializerCommandService, baselineSourceInspectionService, baselineMaterializerRecoveryService, iterationService, runtimeProjectionService, runtimeAdvanceService, packageJson] = await Promise.all([
  read('client-runtime/state-store.mjs'),
  read('client-runtime/iteration-loop.mjs'),
  read('client-runtime/local-server.mjs'),
  read('client-runtime/server/project-routes.mjs'),
  read('client-runtime/application/projects-service.mjs'),
  read('client-runtime/server/mission-routes.mjs'),
  read('client-runtime/application/missions-service.mjs'),
  read('client-runtime/server/mission-query-routes.mjs'),
  read('client-runtime/application/mission-query-service.mjs'),
  read('client-runtime/server/semantic-routes.mjs'),
  read('client-runtime/application/semantic-service.mjs'),
  read('client-runtime/server/research-routes.mjs'),
  read('client-runtime/application/research-service.mjs'),
  read('client-runtime/server/run-routes.mjs'),
  read('client-runtime/application/run-service.mjs'),
  read('client-runtime/server/review-action-routes.mjs'),
  read('client-runtime/application/review-action-service.mjs'),
  read('client-runtime/server/decision-routes.mjs'),
  read('client-runtime/application/decision-service.mjs'),
  read('client-runtime/server/candidate-validation-routes.mjs'),
  read('client-runtime/application/candidate-validation-service.mjs'),
  read('client-runtime/server/baseline-routes.mjs'),
  read('client-runtime/application/baseline-service.mjs'),
  read('client-runtime/server/operator-test-routes.mjs'),
  read('client-runtime/application/operator-test-service.mjs'),
  read('client-runtime/server/mission-control-routes.mjs'),
  read('client-runtime/application/mission-control-service.mjs'),
  read('client-runtime/server/knowledge-routes.mjs'),
  read('client-runtime/application/knowledge-service.mjs'),
  read('client-runtime/server/runtime-query-routes.mjs'),
  read('client-runtime/application/runtime-query-service.mjs'),
  read('client-runtime/server/runtime-state-routes.mjs'),
  read('client-runtime/application/runtime-state-service.mjs'),
  read('client-runtime/server/reset-routes.mjs'),
  read('client-runtime/application/reset-service.mjs'),
  read('client-runtime/application/source-service.mjs'),
  read('client-runtime/application/iteration-research-service.mjs'),
  read('client-runtime/application/round-recovery-service.mjs'),
  read('client-runtime/application/agent-round-service.mjs'),
  read('client-runtime/application/round-preflight-service.mjs'),
  read('client-runtime/application/round-artifact-guard.mjs'),
  read('client-runtime/application/baseline-source-service.mjs'),
  read('client-runtime/application/materializer-policy-service.mjs'),
  read('client-runtime/application/baseline-failure-projection.mjs'),
  read('client-runtime/application/benchmark-projection-service.mjs'),
  read('client-runtime/application/repository-adoption-service.mjs'),
  read('client-runtime/application/autopilot-candidate-service.mjs'),
  read('client-runtime/application/autopilot-context-service.mjs'),
  read('client-runtime/application/autopilot-candidate-action-service.mjs'),
  read('client-runtime/application/autopilot-validation-service.mjs'),
  read('client-runtime/application/autopilot-service.mjs'),
  read('client-runtime/application/autopilot-baseline-research-service.mjs'),
  read('client-runtime/application/autopilot-fixed-profile-service.mjs'),
  read('client-runtime/application/autopilot-strict-source-service.mjs'),
  read('client-runtime/application/autopilot-candidate-baseline-service.mjs'),
  read('client-runtime/application/baseline-benchmark-service.mjs'),
  read('client-runtime/application/baseline-materializer-command-service.mjs'),
  read('client-runtime/application/baseline-source-inspection-service.mjs'),
  read('client-runtime/application/baseline-materializer-recovery-service.mjs'),
  read('client-runtime/application/iteration-service.mjs'),
  read('client-runtime/application/runtime-projection-service.mjs'),
  read('client-runtime/application/runtime-advance-service.mjs'),
  read('package.json').then(JSON.parse),
]);

assert.doesNotMatch(stateStore, /from ['"]\.\/agent-runtime\.mjs['"]/, 'state store must not depend on the Agent service facade');
assert.match(stateStore, /from ['"]\.\/runtime-events\.mjs['"]/);
assert.match(iterationLoop, /from ['"]\.\/runtime-events\.mjs['"]/);
assert.match(localServer, /from ['"]\.\/runtime-events\.mjs['"]/);
assert.doesNotMatch(projectRoutes, /state-store|workspace-manager|node:fs/, 'Project routes must stay transport-only');
assert.doesNotMatch(projectsService, /server\/|tools\/local-c500-tester/, 'Projects service must not depend on transport or TUI');
assert.doesNotMatch(missionRoutes, /state-store|workspace-manager|node:fs/, 'Mission routes must stay transport-only');
assert.doesNotMatch(missionsService, /server\/|tools\/local-c500-tester/, 'Missions service must not depend on transport or TUI');
assert.doesNotMatch(missionQueryRoutes, /state-store|workspace-manager|node:fs/, 'Mission query routes must stay transport-only');
assert.doesNotMatch(missionQueryService, /server\/|tools\/local-c500-tester/, 'Mission query service must not depend on transport or TUI');
assert.doesNotMatch(semanticRoutes, /state-store|semantic-snapshot|node:fs/, 'Semantic routes must stay transport-only');
assert.doesNotMatch(semanticService, /server\/|tools\/local-c500-tester/, 'Semantic service must not depend on transport or TUI');
assert.doesNotMatch(researchRoutes, /state-store|agent-runtime|node:fs/, 'Research routes must stay transport-only');
assert.doesNotMatch(researchService, /server\/|tools\/local-c500-tester/, 'Research service must not depend on transport or TUI');
assert.doesNotMatch(runRoutes, /state-store|agent-runtime|node:fs/, 'Run routes must stay transport-only');
assert.doesNotMatch(runService, /server\/|tools\/local-c500-tester/, 'Run service must not depend on transport or TUI');
assert.doesNotMatch(reviewRoutes, /state-store|agent-runtime|node:fs/, 'Review routes must stay transport-only');
assert.doesNotMatch(reviewService, /server\/|tools\/local-c500-tester/, 'Review service must not depend on transport or TUI');
assert.doesNotMatch(decisionRoutes, /state-store|agent-runtime|node:fs/, 'Decision routes must stay transport-only');
assert.doesNotMatch(decisionService, /server\/|tools\/local-c500-tester/, 'Decision service must not depend on transport or TUI');
assert.doesNotMatch(candidateValidationRoutes, /state-store|agent-runtime|operator-test-queue|workspace-manager|node:fs/, 'Candidate validation routes must stay transport-only');
assert.doesNotMatch(candidateValidationService, /server\/|tools\/local-c500-tester/, 'Candidate validation service must not depend on transport or TUI');
assert.doesNotMatch(baselineRoutes, /state-store|agent-runtime|baseline-materializer|node:fs/, 'Baseline routes must stay transport-only');
assert.doesNotMatch(baselineService, /server\/|tools\/local-c500-tester/, 'Baseline service must not depend on transport or TUI');
assert.doesNotMatch(operatorTestRoutes, /operator-test-queue|local-c500-service-client|node:fs/, 'Operator Test routes must stay transport-only');
assert.doesNotMatch(operatorTestService, /server\/|local-c500-service-client|tools\/local-c500-tester/, 'Operator Test service must depend only on the injected queue port');
assert.doesNotMatch(missionControlRoutes, /state-store|agent-runtime|operator-test-queue|node:fs/, 'Mission Control routes must stay transport-only');
assert.doesNotMatch(missionControlService, /server\/|tools\/local-c500-tester/, 'Mission Control service must not depend on transport or TUI');
assert.doesNotMatch(knowledgeRoutes, /state-store|node:fs/, 'Knowledge routes must stay transport-only');
assert.doesNotMatch(knowledgeService, /server\/|tools\/local-c500-tester/, 'Knowledge service must not depend on transport or TUI');
assert.doesNotMatch(runtimeQueryRoutes, /state-store|node:fs/, 'Runtime query routes must stay transport-only');
assert.doesNotMatch(runtimeQueryService, /server\/|tools\/local-c500-tester/, 'Runtime query service must not depend on transport or TUI');
assert.doesNotMatch(runtimeStateRoutes, /state-store|node:fs/, 'Runtime state routes must stay transport-only');
assert.doesNotMatch(runtimeStateService, /server\/|tools\/local-c500-tester/, 'Runtime state service must not depend on transport or TUI');
assert.doesNotMatch(resetRoutes, /state-store|node:fs/, 'Reset routes must stay transport-only');
assert.doesNotMatch(resetService, /server\/|tools\/local-c500-tester/, 'Reset service must not depend on transport or TUI');
assert.doesNotMatch(sourceService, /server\/|tools\/local-c500-tester/, 'Source service must not depend on transport or TUI');
assert.doesNotMatch(iterationResearchService, /server\/|tools\/local-c500-tester/, 'Iteration research service must not depend on transport or TUI');
assert.doesNotMatch(roundRecoveryService, /server\/|tools\/local-c500-tester/, 'Round recovery service must not depend on transport or TUI');
assert.doesNotMatch(agentRoundService, /server\/|tools\/local-c500-tester/, 'Agent round service must not depend on transport or TUI');
assert.doesNotMatch(roundPreflightService, /server\/|tools\/local-c500-tester/, 'Round preflight service must not depend on transport or TUI');
assert.doesNotMatch(roundArtifactGuard, /server\/|tools\/local-c500-tester/, 'Round artifact guard must not depend on transport or TUI');
assert.doesNotMatch(baselineSourceService, /server\/|tools\/local-c500-tester/, 'Baseline source service must not depend on transport or TUI');
assert.doesNotMatch(materializerPolicyService, /server\/|tools\/local-c500-tester/, 'Materializer policy service must not depend on transport or TUI');
assert.doesNotMatch(baselineFailureProjection, /server\/|tools\/local-c500-tester/, 'Baseline failure projection must not depend on transport or TUI');
assert.doesNotMatch(benchmarkProjectionService, /server\/|tools\/local-c500-tester/, 'Benchmark projection service must not depend on transport or TUI');
assert.doesNotMatch(repositoryAdoptionService, /server\/|tools\/local-c500-tester/, 'Repository adoption service must not depend on transport or TUI');
assert.doesNotMatch(autopilotCandidateService, /server\/|tools\/local-c500-tester/, 'Autopilot candidate service must not depend on transport or TUI');
assert.doesNotMatch(autopilotContextService, /server\/|tools\/local-c500-tester/, 'Autopilot context service must not depend on transport or TUI');
assert.doesNotMatch(autopilotCandidateActionService, /server\/|tools\/local-c500-tester/, 'Autopilot candidate action service must not depend on transport or TUI');
assert.doesNotMatch(autopilotValidationService, /server\/|tools\/local-c500-tester/, 'Autopilot validation service must not depend on transport or TUI');
assert.doesNotMatch(autopilotService, /server\/|tools\/local-c500-tester/, 'Autopilot service must not depend on transport or TUI');
assert.doesNotMatch(autopilotBaselineResearchService, /server\/|tools\/local-c500-tester/, 'Autopilot baseline research service must not depend on transport or TUI');
assert.doesNotMatch(autopilotFixedProfileService, /server\/|tools\/local-c500-tester/, 'Autopilot fixed profile service must not depend on transport or TUI');
assert.doesNotMatch(autopilotStrictSourceService, /server\/|tools\/local-c500-tester/, 'Autopilot strict source service must not depend on transport or TUI');
assert.doesNotMatch(autopilotCandidateBaselineService, /server\/|tools\/local-c500-tester/, 'Autopilot candidate baseline service must not depend on transport or TUI');
assert.doesNotMatch(baselineBenchmarkService, /server\/|tools\/local-c500-tester/, 'Baseline benchmark service must not depend on transport or TUI');
assert.doesNotMatch(baselineMaterializerCommandService, /server\/|tools\/local-c500-tester/, 'Baseline materializer command service must not depend on transport or TUI');
assert.doesNotMatch(baselineSourceInspectionService, /server\/|tools\/local-c500-tester/, 'Baseline source inspection service must not depend on transport or TUI');
assert.doesNotMatch(baselineMaterializerRecoveryService, /server\/|tools\/local-c500-tester/, 'Baseline materializer recovery service must not depend on transport or TUI');
assert.doesNotMatch(iterationService, /server\/|tools\/local-c500-tester/, 'Iteration service must not depend on transport or TUI');
assert.doesNotMatch(runtimeProjectionService, /server\/|tools\/local-c500-tester/, 'Runtime projection service must not depend on transport or TUI');
assert.doesNotMatch(runtimeAdvanceService, /server\/|tools\/local-c500-tester/, 'Runtime advance service must not depend on transport or TUI');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/missions['"]/, 'Mission collection routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/projects['"]/, 'Project collection routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:resume-mission|request-review|cancel-review|resolve-review)['"]/, 'Review action routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:adopt|reject|revert-adoption)['"]/, 'Decision routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:apply-patch|start-benchmark|rollback-stage)['"]/, 'Candidate validation routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/materialize-baseline['"]/, 'Baseline routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/operator-tests['"]|url\.pathname\.match\(\/\^\\\/api\\\/operator-tests/, 'Operator Test routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:human-feedback|stop-mission)['"]|missionRunCancelMatch/, 'Mission Control routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname(?:\.startsWith\()?['"]\/api\/knowledge/, 'Knowledge routes must stay extracted');
assert.doesNotMatch(localServer, /request\.method === ['"]GET['"] && url\.pathname === ['"]\/api\/(?:runtime\/preflight|state|workspace)['"]/, 'Runtime query routes must stay extracted');
assert.doesNotMatch(localServer, /request\.method === ['"]PATCH['"] && url\.pathname === ['"]\/api\/state['"]/, 'Runtime state routes must stay extracted');
assert.doesNotMatch(localServer, /request\.method === ['"]POST['"] && url\.pathname === ['"]\/api\/reset['"]/, 'Reset routes must stay extracted');
assert.doesNotMatch(localServer, /EXPERIENCE_RESEARCH_FAILED|baseline_source_unresolved/, 'Autopilot research policy must stay extracted');
assert.doesNotMatch(localServer, /const advanceTesterAutopilot/, 'Autopilot decision table must stay extracted');
assert.doesNotMatch(localServer, /iterationDeps/, 'Transitional iterationDeps must stay removed');
assert.doesNotMatch(localServer, /baseline\.semantic_fallback_selected/, 'Baseline orchestration policy must stay extracted');
const baselineOrchestrationSource = await read('client-runtime/application/baseline-orchestration-service.mjs');
assert.doesNotMatch(baselineOrchestrationSource, /server\/|tools\/local-c500-tester/, 'Baseline orchestration service must not depend on transport or TUI');

for (const requiredDocument of [
  'AGENTS.md',
  'docs/development/ARCHITECTURE.md',
  'docs/development/MODULE_CONTRACT_TEMPLATE.md',
  'client-runtime/README.md',
  'client-runtime/state-repository.md',
  'client-runtime/application/README.md',
  'client-runtime/application/projects-service.md',
  'client-runtime/application/missions-service.md',
  'client-runtime/application/mission-query-service.md',
  'client-runtime/application/semantic-service.md',
  'client-runtime/application/research-service.md',
  'client-runtime/application/run-service.md',
  'client-runtime/application/review-action-service.md',
  'client-runtime/application/decision-service.md',
  'client-runtime/application/candidate-validation-service.md',
  'client-runtime/application/baseline-service.md',
  'client-runtime/application/operator-test-service.md',
  'client-runtime/application/mission-control-service.md',
  'client-runtime/application/knowledge-service.md',
  'client-runtime/application/runtime-query-service.md',
  'client-runtime/application/runtime-state-service.md',
  'client-runtime/application/reset-service.md',
  'client-runtime/application/source-service.md',
  'client-runtime/application/iteration-research-service.md',
  'client-runtime/application/round-recovery-service.md',
  'client-runtime/application/agent-round-service.md',
  'client-runtime/application/round-preflight-service.md',
  'client-runtime/application/round-artifact-guard.md',
  'client-runtime/application/baseline-source-service.md',
  'client-runtime/application/materializer-policy-service.md',
  'client-runtime/application/baseline-failure-projection.md',
  'client-runtime/application/benchmark-projection-service.md',
  'client-runtime/application/repository-adoption-service.md',
  'client-runtime/application/autopilot-candidate-service.md',
  'client-runtime/application/autopilot-context-service.md',
  'client-runtime/application/autopilot-candidate-action-service.md',
  'client-runtime/application/autopilot-validation-service.md',
  'client-runtime/application/autopilot-service.md',
  'client-runtime/application/autopilot-baseline-research-service.md',
  'client-runtime/application/autopilot-fixed-profile-service.md',
  'client-runtime/application/autopilot-strict-source-service.md',
  'client-runtime/application/autopilot-candidate-baseline-service.md',
  'client-runtime/application/baseline-benchmark-service.md',
  'client-runtime/application/baseline-materializer-command-service.md',
  'client-runtime/application/baseline-source-inspection-service.md',
  'client-runtime/application/baseline-materializer-recovery-service.md',
  'client-runtime/application/iteration-service.md',
  'client-runtime/application/runtime-projection-service.md',
  'client-runtime/application/runtime-advance-service.md',
  'client-runtime/application/baseline-orchestration-service.md',
  'client-runtime/server/README.md',
  'client-runtime/agent-runtime/README.md',
  'tools/local-c500-tester/README.md',
  'tools/local-c500-tester/components/README.md',
  'tests/README.md',
]) {
  assert.equal(await exists(requiredDocument), true, `module contract is required: ${requiredDocument}`);
}

assert.equal(Object.keys(packageJson.scripts).some((name) => /local-c500-(?:tester|adapter|workflow|discovery|generation|adoption|e2e)$/.test(name)), false);

console.log('[module-boundary] production path, dependency direction, and local contracts passed');
