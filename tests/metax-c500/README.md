# MetaX C500 CPU contract verification

This directory owns CPU-only tests for the new C500 adapter. No model, GPU, SMI,
compiler build, live Runtime or platform installation is started. Probe/Event/native
loader/build-load/release ports are explicit doubles. Numeric test values such as
two microseconds are synthetic fixtures, never C500 performance data.

`python -B tests/metax-c500/runner-test.py` checks exact timing invocation counts,
synchronization, units and original settlement rules; uses the existing real
correctness engine for all 24 scalar fixture cases; preserves both required
benchmark profiles; verifies candidate versus Oracle failure attribution,
independent Oracle/source drift, CPU-only benchmark refusal, no native fallback,
Oracle-native-load exclusion, terminal replay and nonpublishable fixture records.

`node tests/metax-c500/adapter-test.mjs` checks exact version/device/vendor/timer
admission, refreshed environment drift, actual package store and Python AST
materialization, bound preparation receipts and immutable source verification.
Native/compiler receipts are labelled fixtures; no GPU compilation occurs.
Missing/foreign/unknown worker release stays quarantined.

Temporary files are created exclusively below `tools/metax-c500`; cleanup checks
the resolved root before removing the test's own directory. Override
`OPERATOR_C500_TEST_PYTHON` with the existing CPU Python interpreter on another host;
no dependency installation is performed.

These suites establish software behavior only. Real C500 qualification and
performance, MetaX fork compatibility and Linux lifecycle acceptance remain separate.
