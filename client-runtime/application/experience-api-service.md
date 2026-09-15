# Experience API Service

Wraps the versioned Experience service for the local Production API. Requires
read-only loadState and experiences.read/create/update ports. list/get/create/update
take a project ID from the route and return statusCode/payload. The project must
exist in the current Runtime's Project catalog; each read is limited to that
project, regardless of caller-provided sharing flags. This is a single-user local
API, not multi-tenant authentication.

Create accepts human guidance only. Update requires expectedVersion and preserves
immutable history. The body cannot assign projectId, allowedProjectIds, evidence,
verification, source, kind or selectionMetadata: the provenance metadata has exactly
one entry point, the explicit import API below, so the generic CRUD surface stays
closed. There is no public execution-observation write API.

Only read/create/update are required ports, so an existing read/create/update-only
composition keeps working; an absent import port fails at the import call, not at
construction.
Missing projects produce EXPERIENCE_PROJECT_NOT_FOUND (404); domain/storage/version
errors propagate unchanged. No Runtime mutation, Agent execution, queue execution
or publication occurs. Only the injected Experience repository is written.

`importKernelWiki(projectId,body)` is the only entry for KernelWiki snapshots. It
resolves the owning Project first (same EXPERIENCE_PROJECT_NOT_FOUND rule), accepts
only `{snapshot,author}` — any other key is EXPERIENCE_INVALID — and returns
`{statusCode:200,payload}` with the domain import result. It never writes on GET and
adds no second storage transaction; the bounded request reader is retained, so callers
import bounded snapshots rather than raising the server body limit.

Verification: node tests/experience-api-service-test.mjs
