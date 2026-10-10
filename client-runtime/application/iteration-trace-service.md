# Iteration Trace Query Service

`createIterationTraceService({readState, traceStore})` returns a frozen object
with `query(missionId, options={})` and `evaluate(missionId, {includeRecords=false})`.
Both dependencies are required read ports;
the constructor rejects missing ports with TypeError.

Query reads an atomic committed state snapshot, validates the Mission exists,
and delegates its `iterationTrace` head with the requested Mission scope and
kind/view/limit/cursor to `traceStore.query`. Options cannot override the method's
Mission ID. An unknown Mission returns `MISSION_NOT_FOUND` (404). Adapter query,
cursor and corruption failures propagate with their original code/status.

No select/save, recovery, filesystem, Provider, test queue or Gate effects occur.
The composition root supplies read-only state and trace ports. HTTP formatting
belongs to the route adapter. Returned facts retain their original qualification;
this service does not certify evidence or make workflow decisions.

Evaluation pins one state snapshot/head for all latest-fact pages, then calls the
pure [evaluation projection](../iteration-evaluation.md). `includeRecords` returns
`{schemaVersion,report,markdown,records}` for deterministic offline reconstruction;
otherwise it returns the report. More than 50000 facts returns
`EVALUATION_TOO_LARGE` (413), never a silently truncated aggregate. Corruption or
read failure also aborts the whole report. Larger histories remain accessible
through the ordinary paginated trace API. No evaluation cache or disk writes occur.

Record fields, cursor and coverage semantics are specified in the shared
[trace contract](../iteration-trace.md). Verify with `test:iteration-trace` and
the actual HTTP checks in `test:runtime-read-isolation`.
