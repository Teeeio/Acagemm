# Test Module Contract

## Purpose

Tests protect production contracts. A test must identify whether it is unit, contract, integration, robustness, or end-to-end coverage.

## Rules

- Do not preserve tests for removed production paths.
- Do not use simulation evidence as proof of C550 correctness or performance.
- Tests that spawn a Runtime must use an isolated tester home and disable ambient auto tick unless the test targets auto tick.
- Temporary state must be cleaned in `finally` blocks.
- Contract tests should assert stable behavior and error codes, not incidental implementation text.
- Hardware-free release checks must not invoke Python runner, `mx-smi`, `mctracer`, or `mcProfiler` unless explicitly mocked.

## Naming

- `*-test.mjs`: Node unit/contract/integration test.
- `*-test.py`: Python runner contract test.
- `e2e-*`: full production-path scenario.
- `*-extreme-test.mjs`: generated or adversarial state-space coverage.

## Verification Entry Points

```bash
npm run verify:local-c500-release
npm run verify:non-hardware-robustness
```

`npm run e2e:cpu-iteration` is the deterministic full-workflow E2E. It uses the
Reference Fixture for Candidate generation and executes lightweight Correctness
and Benchmark work in the standard-library CPU runner. The result is always
`source=cpu-e2e` and `liveHardware=false` and cannot prove C550 correctness or
performance. The non-hardware verification entry point includes this E2E.

`npm run e2e:cpu-agent-iteration` is the opt-in acceptance test that uses a real
local Agent plus actual CPU correctness and benchmark execution. It verifies
that an unmet Accept Gate closes the current round and starts the next Agent
round without harness intervention. It is excluded from routine verification
because it consumes a live Agent session.
