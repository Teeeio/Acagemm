# Experience API Service

Wraps the versioned Experience service for the local Production API. Requires
read-only loadState and experiences.read/create/update ports. list/get/create/update
take a project ID from the route and return statusCode/payload. The project must
exist in the current Runtime's Project catalog; each read is limited to that
project, regardless of caller-provided sharing flags. This is a single-user local
API, not multi-tenant authentication.

Create accepts human guidance only. Update requires expectedVersion and preserves
immutable history. The body cannot assign projectId, allowedProjectIds, evidence,
verification, source or kind. There is no public execution-observation write API.
Missing projects produce EXPERIENCE_PROJECT_NOT_FOUND (404); domain/storage/version
errors propagate unchanged. No Runtime mutation, Agent execution, queue execution
or publication occurs. Only the injected Experience repository is written.

Verification: node tests/experience-api-service-test.mjs
