# Phase 3: frozen implementation and acceptance contract (2026-09-15)

Authority: TEAM_HANDOFF.md sections 6 and 8.4. Baseline 50ac264; accepted live
production source remains 21c6d78. This batch implements import and deterministic
round selection through the existing production API and prepare path. No new
scheduler, vector store, model selection call, dependency or GPU run. The prior
N20 is not validation of this new source. A later controlled three-condition live
study measures selection benefit; this batch cannot claim performance benefit.

## Single route and ownership

A owns experience-contract.mjs/.md and new experience-selection.mjs/.md: optional
version-bound selection metadata plus deterministic selection. B owns new pure
kernel-wiki-import.mjs/.md and scripts/import-kernel-wiki.mjs/.md: pinned source
to import snapshot and atomic domain import. C owns existing application
experience-service, experience-api-service, round-experience-service and server
experience-routes (.mjs/.md pairs): import and prepare integration. D owns new
independent tests, test registration and shared README/ownership catalogs. No
other writer touches these files. All authors can start from this contract;
new cross-file behavior is checked only after exact candidate combination.

## A: metadata and selector API

Keep experience store/context schema 1 and existing records byte-compatible.
Add OPTIONAL selectionMetadata to human guidance inputs/records/updates only;
omit the property when absent. Never add it to execution records or change
scope.tags semantics. The existing generic HTTP create/update must reject this
property; the explicit import API is its entry. Frozen contexts naturally retain
the metadata on their exact record ID/version. Historical contexts remain valid.

Metadata is a bounded, canonical plain object with ONLY these keys:
source='kernel-wiki', sourceCommit (40 lowercase hex), sourcePath (safe relative
wiki/*.md path, nested directories allowed), pageId (safe experience identifier),
sourceDigest (64 lowercase hex of complete original UTF-8 page), unitDigest
(64 lowercase hex of injected content), type (original nonempty type), topics,
symptoms, candidateTechniques, architectures (bounded unique string arrays),
applicability={mode,reviewId,hardware,architectures,requiredCapabilities,software}.
All arrays max32 entries, each max160 chars. applicability mode is unreviewed,
architecture-specific, or reviewed-transfer; reviewId is null for unreviewed,
otherwise a nonempty bounded identifier. Metadata is provenance, NOT evidence.
Unreviewed pages are retained in store but are never automatically injected.
No raw topic/tag implies a required capability. Architecture-specific units
require a nonempty explicitly reviewed architecture list; reviewed-transfer
units also require an explicit reviewed target architecture list. Missing target
dimensions fail applicability; do not infer sm86 from device names or sm80.
Across hardware, architecture, required capabilities and software use AND;
within hardware/architecture use OR, requiredCapabilities/software use subset.

experience-selection.mjs exports WIKI_SELECTION_POLICY_VERSION =
'operator-studio.optimization-hypothesis-selection/v1',
normalizeSelectionMetadata(value), and rankExperienceCandidates(records, options).
It must not import experience-contract (avoid a cycle). Pure dependencies only.
options={features,target,preferredIds?,repeatedAttempts?}; target has hardware,
architecture,capabilities,software string arrays. features is max8 objects
{kind,value,basis}; kind structure|failure|symptom|technique, max2 per kind,
value max160, basis a nonempty string max1000. Symptoms remain hypotheses;
no numeric confidence and no inference from time/shape to measured bottlenecks.
preferredIds max20; repeatedAttempts max20 objects {id,version,attemptKey};
attemptKey identifies modification+parameters+conditions, not a method name.
rank returns {ordered:[{id,version,reason,bucket}],excluded:[{id,version,reason}]}.
bucket is local|symptom|technique|guidance; other Wiki types may only enter
guidance. Deterministic ties use ID ascending and version descending, not clock.
Local execution/current-project guidance is ranked first: current failure
observations, explicit preferred IDs (best/unresolved), then matching features,
then recent local guidance. Preserve record content and scope in full.
Wiki order: failure match, structure match, symptom hypothesis match, technique
match; an explicitly reviewed guidance unit can be fallback. No topical match
means exclusion for ordinary pages. Expand selected/matching symptom page
candidateTechniques ONE hop by pageId or technique topic; reapply applicability,
never recurse related. Only the exact supplied repeated ID/version is demoted;
never ban a technique category. Deduplicate content/unit identity.

retrieveExperienceContext and retrieveExperienceSelection accept optional
query.selection={policyVersion,features,target,preferredIds?,repeatedAttempts?}.
Without selection preserve legacy ordering and API exactly. With selection:
validate policy version, access, latest status/expiry/version and scope FIRST
over ALL metadata candidates, no top20 pre-truncation; rank; fetch exact ID and
version and revalidate scope/status/version before rendering. Rank cannot grant
access. Query target hardware/architecture must agree with canonical scope.
Never disclose inaccessible record IDs/content in exclusion details.
Default D quotas: local<=4, Wiki<=6 comprising symptom<=2, technique<=3,
guidance<=1. These are maxima, do not fill empty quotas. When previous attempts
are supplied, at most one previously untried technique is added. Keep existing
20 items/64KiB context/8000 content hard bounds and query.limit as further cap.
Soft 24KiB applies to actual UTF-8 FORMATTER output, not estimated chars;
mandatory round facts live outside this budget. Skip an oversized optional
record and consider later smaller ones. Audit selected and bounded excluded
reasons, strategy version, snapshot identity (repository revision plus selected
source commits/digests), features, quotas and actual rendered/context bytes.
Do not stamp the old policy version over a D selection in prepare.

## B: importer API and pinned CLI

Pure module exports parseKernelWikiPage(text,{path}),
buildKernelWikiSnapshot({pages,sourceCommit,reviews=[]}), and
applyKernelWikiSnapshot(store,snapshot,{projectId,now,author}).
pages=[{path,text}], max256, fixed commit 40 lowercase hex. Frontmatter supports
scalars, quoted scalars, inline and block string lists; duplicate keys/IDs,
unsafe paths, invalid required identity, oversized content fail explicitly.
Unknown scalar metadata and unconsumed structured blocks (notably upstream
performance_claims) may be ignored for selection but retained in original page
hash; never interpret them as verified performance or applicability. The frozen
52-page source was inspected: maximum whole page is 5316 chars, no splitter is
needed for this version. Above 8000 chars reject with a clear error, don't cut
code/claims silently. Empty architecture is retained but cannot auto-qualify.
Use type, tags->topics, symptoms, candidate_techniques, architectures. NEVER
copy topics into scope.tags. All original pages retained as unreviewed human
guidance, including hardware-inapplicable pages. Content includes source URL.

reviews=[{pageId,reviewId,mode,content?,topics?,hardware,architectures,
requiredCapabilities,software}]. These are explicit project review assertions,
not model/provider verification. architecture-specific review qualifies the
original unit; reviewed-transfer creates a separate stable unit with reviewed
content, original source metadata and reviewId, keeping the raw unit as well.
Reviewed-transfer content must be supplied explicitly (no automatic summarizer).
Always preserve source citation and mark transfer as project-reviewed,
unverified suggestion. Reviews do not authorize publication or runtime effects.

Snapshot envelope schemaVersion='operator-studio.kernel-wiki-snapshot/v1',
sourceCommit, units, snapshotDigest. Unit has unitId,title,content,scope,
selectionMetadata,evidenceRefs. units deterministic by unitId; raw unitId=pageId,
transfer unitId=pageId+'-transfer-'+reviewId. snapshotDigest is SHA256 of canonical
recursively key-sorted JSON of envelope WITHOUT snapshotDigest. Validate all
fields, metadata/content digest and envelope digest before changing store.
Per-project record ID='kw-'+first16(SHA256(projectId))+'-'+unitId (max160).
Apply source=human/kind=guidance/confidence=low, unverified/human-guidance/
publishable=false via existing append/update APIs. Atomically transact ALL
units, no partial import. Return {changed,result:{created,updated,unchanged,
records:[{id,version}],sourceCommit,snapshotDigest}}. Identical import is no-op
with unchanged repository revision; changed content/provenance advances same ID
via expectedVersion, never deletes old versions. Existing unrelated conflicting
ID is an error, not overwritten. Validate full resulting store before returning.
Missing pages in a later snapshot are not deleted; report/document retention.

CLI: node scripts/import-kernel-wiki.mjs --source PATH --commit HEX --out NEWFILE
[--reviews JSONFILE]. Read ONLY git blobs at exact commit under wiki/ and LICENSE;
do not checkout, fetch, mutate source, or use dirty working files. Use existing
createScopedGitEnvironment for scoped trust in an explicit temporary directory;
no global config edits. Output only import snapshot (not vendored source tree),
copy MIT copyright/license into snapshot provenance (envelope additional key
license is allowed and included in digest). No network/model/GPU. CLI builds a
file; it must not write live Runtime storage or implement workflow. Root imports
the resulting snapshot via the production HTTP API in an isolated Runtime.

## C: existing application and HTTP integration

experienceService.importKernelWiki(snapshot,{projectId,author}) wraps the pure
apply API in ONE repository.transact, now from existing injected clock. No new
repository, side-index filesystem or second storage transaction. API service
importKernelWiki(projectId,body) checks the existing owning Project first,
accepts ONLY {snapshot,author}, returns {statusCode:200,payload:result}.
Route POST /api/projects/:projectId/experiences/import-kernel-wiki precedes the
generic ID matcher. Generic GET/PATCH semantics stay unchanged; no write on GET.
The server retains its body-size bound; CLI docs say use bounded snapshots and
explicit errors rather than disabling request limits.

prepare uses D selection for real experienceService.retrieveWithSelection.
Derive up to8 explicit features from Mission goal/semantic description and
committed same-Mission round facts/run history; no free-form output becomes
hardware capabilities. Backend-as-hardware remains explicit TARGET_INVALID.
Read resolvedTarget capabilities/software only when explicitly supplied;
unknown arrays stay empty. Local observations keep dtype/shape/environment/test
bindings. Current failure features must distinguish infrastructure/provider
failure from correctness/compiler/operator failures; the former do not become
operator optimization lessons. Prefer bound failed candidate and current best
experience IDs when identifiable; never invent bindings. Use only exact known
attempt identity for repeat demotion; absence means no repeat claim.
Existing roundFacts may lag until reset: safely read already committed run
history/round facts for selection; do not move reset before collect or mutate
mandatory facts to manufacture inputs. Preserve previous frozen same-round
context and selection across retries/recovery; fresh logical round reselects.
Legacy retrieve-only injected ports still work without additional arguments.
Actual final prompt continues existing formatter/agent path; selection errors
block a dependent start instead of silently falling back to no knowledge.

## D: independent acceptance matrix

New tests: tests/kernel-wiki-import-test.mjs,
tests/experience-selection-test.mjs, tests/kernel-wiki-runtime-test.mjs.
Use the APIs above, real experience repository where atomicity matters,
production route/application/prepare/formatter composition and an isolated
Runtime HTTP test for import. No real provider or GPU. Register these in
package.json and release list; one writer owns these shared registration files
and README/ownership catalogs. Do not alter old assertions/thresholds for green.

Cover expert 6.13 all eight cases (reuse existing diagnostic eligibility cases
unchanged), especially >20 metadata recall, sm100+NVIDIA rejected for sm86,
missing architecture/review rejected, all-Wiki-zero WITH complete mandatory facts
in FINAL assembled prompt, backend target error, same-round freeze/new-round
refresh, and import idempotence/change/history. Add cross-project ID isolation,
inaccessible audit privacy, version/status revalidation, UTF8 24KiB/64KiB and
quotas/dedup/single-hop, infrastructure failure not operator symptom, no numeric
bottleneck invention, exact-repeat-only demotion, old store/context zero migration,
malformed input and atomic rollback, source hash/pin mismatch and no live-store
CLI write. Include actual source-like frontmatter with an ignored nested
performance_claims block, quoted colons and block lists. Negative cases must
reach their intended branch, not fail earlier for an unrelated bad fixture.

Authors: syntax + nearest existing frozen-input tests only. D syntax only before
combination. Root exact candidate command runs new tests, nearest experience/
round/API/agent-start-context tests, state-domain and module boundaries, then
existing nonhardware robustness (includes release) once at the integration point.
Use real exit codes, retain failures, no success from worker assertions alone.

## Stop conditions and follow-through

Return a decision request on an incompatible public interface, undocumented
required mutation, inability to preserve existing invariants, repeat failure,
or insufficient source material. Do not expand scope. Root then builds all52
source pages from pinned b6b4301f15e8ce6955a56776690643ce5db369e6, preserves MIT
notice, imports twice into isolated production API, verifies zero duplicates and
new-round selected IDs/content in final prompt. Root-owned source reviews and
generated experience snapshot are separate from authored production files.
Current HEAD/past accepted ZIPs/configs remain untouched. Commit reviewed code,
tests, module docs and actual results; preserve the old N20's source identity.
