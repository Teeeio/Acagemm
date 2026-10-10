# Execution package import service

`createExecutionPackageImportService` is the transport-neutral use case behind
`POST /api/execution-packages/import`. It accepts a source directory or tar,
zip, or tar.gz archive, requires explicit Mission/Workspace/Candidate binding
and entrypoints, delegates byte/path checks to `execution-package-import.mjs`,
then immediately calls the trusted package store's `prepare`. No dependency
installation or source execution occurs before admission. A returned admission
is the only value suitable for test submission.
