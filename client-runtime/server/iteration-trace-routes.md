# Iteration Trace Routes

`createIterationTraceRoutes({json, traces})` creates a thin route handler taking
`{request,response,url}`. It owns `GET /api/missions/:id/traces`,
`GET /api/missions/:id/evaluation` and `GET /api/missions/:id/evaluation/export`;
other paths/methods return false without side effects. Evaluation routes delegate
to `traces.evaluate` with export selecting `includeRecords:true`. Standard bridge
metadata remains on the outer JSON transport envelope, outside an exported report.

The handler decodes the Mission ID, converts the optional numeric limit (default
100), and passes kind (default null), view (default latest) and opaque cursor
(default null) to `traces.query`. Successful responses use the injected JSON
responder with status 200. The standard transport catches service errors; this
adapter does not mask errors, validate workflow, select Missions, write state or
perform filesystem/GPU work.

The response and validation contract lives in
[iteration-trace.md](../iteration-trace.md). Verify route delegation with
`test:iteration-trace` and production wiring/read isolation with
`test:runtime-read-isolation`.
