Operator Studio minimal accelerator source handoff v6

Prepared locally; not uploaded. Source only, without credentials, runtime/Mission data, node_modules, GPU environments or native binaries. The source package refreshes the previous explicit source allowlist and records per-file hashes. Root package-lock.json remains unchanged; only its transport copy removes the unrelated parent-directory/self-link entries and aligns direct dependency declarations with package.json.

Target: approved Docker container, all project/source/state/cache/build writes under /public-flash/wzp. Ascend image tag 202606-torch2.9.0-base and all target NPUs are explicitly authorized; actual digest/device nodes and the restricted container/executor configuration remain unobserved. This archive authorizes no remote action, installation, device probe or model call. Read ASCEND_ARM64_HANDOFF.txt, ascend-target-draft.json and tools/ascend910b/CONNECTION_PREFLIGHT.md first.

Requires existing approved Linux arm64 Node20+ and platform-native locked dependencies, and an actually compatible Python3.11/CANN/TorchNPU runtime. No Windows/x64 dependency bundle or automatic install/fallback is shipped. Metadata preflight does not import Torch or touch devices and never reports device readiness. Python3.11 grammar checks are syntax-only on local Python3.12/Windows. Native Linux lifecycle and real accelerator/FlagTree dispatch remain unverified.

The selected Linux CPU compatibility tests are included; this is not a complete release repository. Local full release verification is recorded separately. Do not run tests or probe-device until their scope is authorized.
