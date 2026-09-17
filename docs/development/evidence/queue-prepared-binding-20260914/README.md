# Prepared binding repair: retained integration and final-gate failure

Continuation: the user explicitly confirmed the displayed boundary-correction
request. The correction and independent compatibility test were dispatched,
independently combined and integrated. Root release now passes 143 checks and
non-hardware robustness passes 44 checks (including the release gate). See
`continuation.json` and `final-archive-index.json` for the current evidence.
The original blocked state and failure below remain a historical snapshot.

Recorded 2026-09-14. This is upstream review evidence, not a live-GPU pass.

The trusted preparedArtifactDigest production wiring and its independent queue
tests were integrated via dispatch tasks task_3b83f182c3434326803709c0a0e53ff2 and
task_01681af2b5024a52941fd9125cb410fa. The exact-candidate combination
task_f344c3fba9e54772acb5131dd64baafd, attempt run_c4467a4b342843058ed3034d8cfa01f2,
was independently reviewed, accepted and integrated: real command exit 0,
queue binding 7/7, existing failure-boundary 16/16, failed feedback, module boundary
and command recovery passed. All nine integrated candidate files matched their
platform SHA-256 receipts. The required same-name module contract was separately
integrated as task_67c99a2452854ad9b58938f687671ae0.

Root then ran npm.cmd run verify:local-c500-release. Its actual exit code is 1:
the unchanged test:state-domain-boundary detects the preparer importing concrete
execution-package-store.mjs. The original upstream route incorrectly allowed this
helper import; the first combination did not include this guard. It is a real
remaining defect, not a passed release. The non-hardware command was not run
because it includes this same known failing release gate.

The bounded correction is frozen in ../../QUEUE_PREPARED_BINDING_BOUNDARY_ADDENDUM.md:
move the unchanged pure contentDigest to existing execution-package-contract.mjs,
keep store importing/re-exporting the identical function, and make the preparer
import only the pure contract. Preserve the existing dependency guard, all queue
assertions, strict evidence rules, hardware matrices and budgets. Independent
compatibility tests and a new exact-candidate combination must precede final gates.

Two correction dispatch attempts were rejected by automatic approval review.
No correction task was created and no correction implementation was written.
The exact request and verbatim rejection reasons are retained here. Existing
approved and integrated work remains in the working tree; no new live source was
frozen, no new GPU smoke was launched, and the fresh N=20 denominator remains 0/20.
The older f3a5446 smoke and prior 20-run batch remain separate historical groups.

Large originals are retained under
.operator-studio-local/queue-prepared-binding-20260914/ (root release output,
combination-v1 failure and combination-v2 pass). The archive index in this directory
records their exact hashes and the retained integrated source bytes.
