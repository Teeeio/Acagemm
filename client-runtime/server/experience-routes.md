# Experience Routes

Thin transport for GET/POST /api/projects/:projectId/experiences and
GET/PATCH /api/projects/:projectId/experiences/:id. Optional GET version is a
number. PATCH uses expectedVersion for optimistic concurrency; archival uses
status=archived instead of deleting history. Routes decode identifiers, reuse
the bounded cached JSON reader, and forward application outcomes. No project,
experience verification, authorization or storage rules are implemented here.

POST /api/projects/:projectId/experiences/import-kernel-wiki is matched **before**
the generic experience ID matcher, so "import-kernel-wiki" is never treated as an
experience ID and the import never falls through to the collection POST. Only POST is
the import verb; GET/PATCH/DELETE on that path are not handled here. The body is read
with the existing bounded reader (default 1 MB): oversized snapshots fail explicitly
instead of the server disabling its request limit.

Verification: node tests/experience-api-service-test.mjs
