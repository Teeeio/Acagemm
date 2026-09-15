# Closeout acceptance (2026-09-15)

Scope: documentation, an offline portable evidence handoff, and disposition of
obsolete platform tasks. No production changes, GPU/model runs, dependency installs,
global configuration changes, network publication, or Phase 3 implementation.

Frozen truth: `../run-diagnostics-20260914/acceptance.json`. Production source is
21c6d7868bd3c5aa74dfcc098f87e3ad4236f948. Affine smoke 1x2; strict N20 exactly
20/20 full-success/comparable and 44/44 observed model calls, 40 distinct candidates;
separate reduction/normalization coverage 4 distinct candidates and 4/4 observations.
Model deepseek-v4-flash; local shared NVIDIA GPU/sm86; publishable=false. Historical
failures remain failures in evidence, including the old 19-comparable/1-unknown N20.

## Documentation writer

Update current-entry sections in README.md, docs/development/README.md,
GENERIC_OPERATOR_GOAL.md, CURRENT_TASK_HANDOFF.md, TEAM_HANDOFF.md. Cite the canonical
acceptance JSON and this directory's PORTABLE.md. Keep dated historical bodies,
especially TEAM_HANDOFF expert section 6, intact; clearly label old state as historical.
TEAM_HANDOFF was user-provided/untracked and is now included as a reviewed handoff
document; AGENTS.md and user .codex/.dispatch/.dispatch-backups remain excluded.
Do not claim remote push, all-provider/all-hardware stability, or Phase 3 completion.
Only dispatch platform agents are called downstream/下游; Acagemm has a runtime agent.

## Portable evidence writer

Create `portable-evidence.py` (Python standard library only) and `PORTABLE.md` here.
CLI: `build --repo PATH --archives-root PATH --out NEW_DIRECTORY`; archives-root is
the explicit `.operator-studio-local` base. `verify --bundle DIRECTORY --scratch
NEW_DIRECTORY --report PATH`. Verification must work with only a relocated bundle,
Python and Node, without source checkout, Git, npm, provider, GPU, network or original
absolute paths. Builder can read Git-frozen helpers via `git show COMMIT:path` and
the exact reader and eight archives listed in immutable inputs.json; check all input
SHA256s. Bundle includes this script, frozen inputs, reader, four helper modules,
eight byte-original ZIPs, and a relative-path SHA256 file manifest. No configuration,
credentials, unrelated repository files or private history beyond listed originals.

Verify checks entire payload membership/bytes/SHA before extraction or Node execution.
Reject missing/extra/mutated payloads, unsafe traversal/absolute/drive/duplicate/symlink
archive members, existing scratch, and invalid manifest paths. Do not silently skip
failed history: all eight ZIPs must pass hashes and per-entry integrity. Only three
recovered ZIPs are successful-run replay inputs. Extract to fresh scratch, preserving
all original bytes (including historical absolute path strings). Reuse the unmodified
accepted reader with bundled helper repo and explicit extracted run roots. Recompute
strict N20 and exact runs/candidates/models against inputs.json; do not trust summary
flags alone. Emit real subprocess codes and bounded summary in JSON. Preserve full
reader output in scratch. No shell or irreversible cleanup; never delete user paths.

## Upstream acceptance

Authors run targeted syntax/CLI checks only; no broad tests or live model/GPU run.
Root checks actual diffs, doc links/claims, and exact expert section preservation.
Root builds from integrated tool, relocates bundle outside source/original directories,
runs offline verification with repository env unset, and confirms exactly 1/20/1
invocations, 2/40/4 candidates, 2/44/4 actual model observations and strict N20 true
only for the n20 group. One corrupt ZIP byte must fail before reader runs; a traversal
member must be rejected, not extracted. No new production test registration necessary:
this is a bounded delivery utility, not the production workflow.

Root archives six failed-task receipts before stopping obsolete retries with explicit
reasons, preserves their failed attempt/digests and stage membership, verifies after
receipts, then marks the completed regression stage complete. Cancellation is task
disposition only and cannot upgrade original test outcomes or count as integration.
Root owns canonical `closeout.json`, final local git bundle, archive manifests and
commit. New documentation must not preclaim these future results.
