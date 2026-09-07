# Execution package domain contract

This module contains pure, language-neutral rules and canonical JSON encoding.
It neither reads files nor imports concrete queues, compilers, or runtimes.

A v1 manifest identifies candidate, offline dependency and independent acceptance
layers by content digest. Each regular file has a portable relative path, byte
size and digest. Symlinks, traversal, Windows device/ADS paths and case collisions
are forbidden. Entrypoints are adapter-specific paths, not a universal run.py.

The environment is a locked registry identity; it is not permission to read an
ambient developer virtualenv. A target and explicit build settings are mandatory.
Candidate/Mission/Workspace binding is distinct from package and acceptance
digests. Acceptance specs and semantic identity are frozen independently.

validateExecutionManifest checks structure and invariants, not file contents.
Only a trusted package adapter may issue an admission after content checks and
target prepare/build/load. assertAdmissionBinding checks a trusted admission
against the complete submission and its finite deadline. A caller-supplied
validated boolean is not an admission. Runtime revalidation remains mandatory.

Python/CPU is the first planned adapter. Other language adapters obey these same
envelope rules. CPU evidence is not GPU publication authority.

Verification: node tests/execution-package-contract-test.mjs
