# Experience Routes

Thin transport for GET/POST /api/projects/:projectId/experiences and
GET/PATCH /api/projects/:projectId/experiences/:id. Optional GET version is a
number. PATCH uses expectedVersion for optimistic concurrency; archival uses
status=archived instead of deleting history. Routes decode identifiers, reuse
the bounded cached JSON reader, and forward application outcomes. No project,
experience verification, authorization or storage rules are implemented here.

Verification: node tests/experience-api-service-test.mjs
