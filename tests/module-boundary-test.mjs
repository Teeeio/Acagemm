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

const [stateStore, iterationLoop, localServer, projectRoutes, projectsService, missionRoutes, missionsService, missionQueryRoutes, missionQueryService, semanticRoutes, semanticService, researchRoutes, researchService, runRoutes, runService, reviewRoutes, reviewService, decisionRoutes, decisionService, candidateValidationRoutes, candidateValidationService, baselineRoutes, baselineService, operatorTestRoutes, operatorTestService, packageJson] = await Promise.all([
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
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/missions['"]/, 'Mission collection routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/projects['"]/, 'Project collection routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:resume-mission|request-review|cancel-review|resolve-review)['"]/, 'Review action routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:adopt|reject|revert-adoption)['"]/, 'Decision routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/(?:apply-patch|start-benchmark|rollback-stage)['"]/, 'Candidate validation routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/actions\/materialize-baseline['"]/, 'Baseline routes must stay extracted');
assert.doesNotMatch(localServer, /url\.pathname === ['"]\/api\/operator-tests['"]|url\.pathname\.match\(\/\^\\\/api\\\/operator-tests/, 'Operator Test routes must stay extracted');

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
