// Contract/integration tests: real, bounded Python CPU processes; no Agent or GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../tools/local-cpu-runner.py', import.meta.url));
const python = process.env.OPERATOR_CPU_PYTHON || 'python';
const candidateCode = 'def run(inputs):\n    return inputs\n';
const defaultCases = '[{"name": "minimum", "category": "minimal", "inputs": {"v": [1.0, -2.0]}}, {"name": "boundary", "category": "boundary", "inputs": {"v": [0.0]}}]';
const defaultProfiles = '[{"name": "primary", "inputs": {"v": [3.0]}}, {"name": "secondary", "inputs": {"v": [5.0]}}]';
const oracleCode = ({
  cases = defaultCases,
  profiles = defaultProfiles,
  reference = 'return inputs',
  prelude = '',
} = {}) => [
  prelude,
  'def get_test_cases():',
  '    return ' + cases,
  'def get_benchmark_inputs():',
  '    return ' + profiles,
  'def reference(inputs):',
  ...reference.split('\n').map((line) => '    ' + line),
  '',
].join('\n');

const taskInput = () => ({
  schemaVersion: 1,
  purpose: 'candidate',
  candidate: { id: 'candidate-contract', digest: 'sha256:' + 'a'.repeat(64) },
  hardware: ['CPU'],
  metric: 'latency_p50',
  matrix: {
    environments: ['CPU'],
    correctnessCases: 2,
    warmup: 0,
    repeats: 3,
    testSpec: {
      schemaVersion: 'operator-studio.test-spec/v1',
      correctness: { requestedCases: 2, requiredCategories: ['minimal', 'boundary'], atol: 0, rtol: 0, requireNamedCases: true },
      benchmark: { requiredProfiles: ['primary', 'secondary'], primaryProfile: 'primary', warmup: 0, repeats: 3 },
    },
  },
});

const readJson = async (filename) => {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const sha256 = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');

test('strict CPU runner contracts', { timeout: 120_000 }, async (t) => {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, 'operator-cpu-runner-contract-'));
  assert.equal(path.dirname(root), temporaryParent);
  assert.ok(path.basename(root).startsWith('operator-cpu-runner-contract-'));

  const execute = async ({
    candidate = candidateCode,
    oracle = oracleCode(),
    task = taskInput(),
    oracleMode = 'separate',
    taskJson = JSON.stringify(task),
    timeout = 5_000,
  } = {}) => {
    const taskDir = await mkdtemp(path.join(root, 'task-'));
    const runPy = path.join(taskDir, 'run.py');
    const oraclePy = path.join(taskDir, 'oracle.py');
    const resultJson = path.join(taskDir, 'result.json');
    await Promise.all([
      writeFile(runPy, candidate, 'utf8'),
      writeFile(path.join(taskDir, 'task.json'), taskJson, 'utf8'),
    ]);
    if (oracleMode === 'hardlink') await link(runPy, oraclePy);
    else if (oracleMode === 'separate') await writeFile(oraclePy, oracle, 'utf8');
    const environment = {
      ...process.env,
      OPERATOR_LOCAL_C500_TASK_DIR: taskDir,
      OPERATOR_LOCAL_C500_RUN_PY: runPy,
      OPERATOR_LOCAL_C500_RESULT_JSON: resultJson,
      PYTHONDONTWRITEBYTECODE: '1',
    };
    delete environment.OPERATOR_LOCAL_C500_ORACLE_RUN_PY;
    if (oracleMode !== 'missing') environment.OPERATOR_LOCAL_C500_ORACLE_RUN_PY = oracleMode === 'same' ? runPy : oraclePy;
    const child = spawnSync(python, ['-I', runner], {
      cwd: taskDir,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
    });
    const [result, correctness, status] = await Promise.all([
      readJson(resultJson),
      readJson(path.join(taskDir, 'correctness.json')),
      readJson(path.join(taskDir, 'runner-status.json')),
    ]);
    return { child, result, correctness, status, taskDir, candidate, oracle, taskJson };
  };

  const evidenceBoundary = (result) => {
    assert.equal(result.schemaVersion, 'operator-studio.cpu-result/v2');
    assert.equal(result.source, 'cpu-e2e');
    assert.equal(result.liveHardware, false);
    assert.equal(result.environment.source, 'cpu-e2e');
    assert.equal(result.environment.liveHardware, false);
    assert.equal(result.environment.hardware.device, 'CPU');
    assert.equal(result.tracer.status, 'unavailable');
    assert.equal(result.tracer.simulated, true);
    assert.deepEqual(result.tracer.events, []);
    assert.equal(result.profiler.status, 'unavailable');
    assert.equal(result.profiler.simulated, true);
    assert.deepEqual(result.profiler.metrics, {});
  };
  const success = async (options) => {
    const outcome = await execute(options);
    assert.equal(outcome.child.error, undefined, outcome.child.error?.message);
    assert.equal(outcome.child.status, 0, outcome.child.stderr || outcome.child.stdout);
    assert.equal(outcome.result.status, 'completed');
    assert.equal(outcome.result.error, null);
    assert.equal(outcome.correctness.passed, true);
    assert.equal(outcome.status.stage, 'complete');
    assert.equal(outcome.status.progress, 100);
    assert.deepEqual(outcome.result.correctness, outcome.correctness);
    evidenceBoundary(outcome.result);
    return outcome;
  };
  const failure = async (options, code, phase = 'preflight', role = 'oracle') => {
    const outcome = await execute(options);
    assert.equal(outcome.child.error, undefined, outcome.child.error?.message);
    assert.equal(outcome.child.status, 1, outcome.child.stderr || outcome.child.stdout);
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.error.code, code, JSON.stringify(outcome.result.error));
    assert.equal(outcome.result.error.phase, phase);
    assert.equal(outcome.result.error.role, role);
    assert.equal(outcome.result.error.retryable, false);
    assert.ok(outcome.result.error.message);
    assert.equal(typeof outcome.result.error.details, 'object');
    assert.deepEqual(outcome.result.benchmark, []);
    assert.deepEqual(outcome.result.correctness, outcome.correctness);
    if (phase === 'preflight') {
      assert.equal(outcome.correctness.status, 'not_run');
      assert.equal(outcome.correctness.passed, null);
      assert.equal(outcome.correctness.executedCases, 0);
      assert.equal(outcome.status.stage, 'rejected');
    }
    assert.equal(outcome.status.progress, 100);
    evidenceBoundary(outcome.result);
    return outcome;
  };

  try {
    await t.test('bare run-only candidates use independent oracle inputs, real timings, and exact zero warmup', async () => {
      const candidate = [
        'calls = 0',
        'def run(inputs):',
        '    global calls',
        '    calls += 1',
        '    if calls > 8: raise AssertionError("unexpected warmup or extra execution")',
        '    return inputs',
        'def reference(inputs): raise AssertionError("candidate reference must not execute")',
        'def get_test_cases(): raise AssertionError("candidate cases must not execute")',
        'def get_benchmark_inputs(): raise AssertionError("candidate profiles must not execute")',
        '',
      ].join('\n');
      const outcome = await success({ candidate });
      assert.deepEqual(outcome.correctness.caseNames, ['minimum', 'boundary']);
      assert.equal(outcome.correctness.total, 2);
      assert.equal(outcome.correctness.executedCases, 2);
      assert.equal(outcome.correctness.passedCases, 2);
      assert.equal(outcome.correctness.atol, 0);
      assert.equal(outcome.correctness.rtol, 0);
      assert.deepEqual(outcome.result.benchmark.map((row) => row.profile), ['primary', 'secondary']);
      for (const row of outcome.result.benchmark) {
        assert.equal(row.warmup, 0);
        assert.equal(row.samples, 3);
        assert.ok(Number.isFinite(row.value) && row.value > 0);
        assert.ok(row.min <= row.value && row.value <= row.max);
      }
      assert.equal(outcome.result.environment.candidateRunPyDigest, sha256(candidate));
      assert.equal(outcome.result.environment.oracleRunPyDigest, sha256(outcome.oracle));
      assert.equal(outcome.result.environment.taskContentDigest, sha256(outcome.taskJson));
    });

    await t.test('scalar, tuple, nested dictionary, boolean, string, None and large integer values execute', async () => {
      const oracle = oracleCode({
        cases: '[{"name":"minimum","category":"minimal","inputs":(True, None, "text", {"nested":[1, 2.0, {"value":1152921504606846977}]} )}, {"name":"boundary","category":"boundary","inputs":0.125}]',
        profiles: '[{"name":"primary","inputs":[1,2,3]}, {"name":"secondary","inputs":{"value":False}}]',
      });
      await success({ oracle });
    });

    for (const purpose of ['candidate', 'baseline']) {
      await t.test(purpose + ' requires an explicit independent oracle', async () => {
        const task = taskInput();
        task.purpose = purpose;
        await failure({ task, oracleMode: 'missing' }, 'CPU_ORACLE_REQUIRED');
        await success({ task });
      });
    }
    for (const oracleMode of ['same', 'hardlink', 'absent']) {
      await t.test('oracle rejects ' + oracleMode + ' file identity', async () => {
        await failure({ oracleMode }, 'CPU_ORACLE_INVALID');
      });
    }

    const contractFailures = [
      ['no cases fallback', { cases: '[]' }, 'CPU_CASE_CONTRACT_INVALID'],
      ['too few cases are not repeated', { cases: '[{"name":"only","category":"minimal","inputs":1}]' }, 'CPU_CASE_CONTRACT_INVALID'],
      ['extra cases are not discarded', { cases: defaultCases + ' + [{"name":"extra","category":"minimal","inputs":1}]' }, 'CPU_CASE_CONTRACT_INVALID'],
      ['duplicate case names', { cases: '[{"name":"same","category":"minimal","inputs":1},{"name":"same","category":"boundary","inputs":2}]' }, 'CPU_CASE_CONTRACT_INVALID'],
      ['missing required category', { cases: defaultCases.replace('"category": "boundary"', '"category": "minimal"') }, 'CPU_CASE_CONTRACT_INVALID'],
      ['case must be a named record', { cases: '[1,2]' }, 'CPU_CASE_CONTRACT_INVALID'],
      ['case provider must return a concrete sequence', { cases: '(x for x in [])' }, 'CPU_CASE_CONTRACT_INVALID'],
      ['case inputs are required', { cases: defaultCases.replace('"inputs": {"v": [0.0]}', '"wrong": 0') }, 'CPU_CASE_CONTRACT_INVALID'],
      ['no profiles fallback', { profiles: '[]' }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
      ['missing profile', { profiles: '[{"name":"primary","inputs":1}]' }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
      ['extra profile', { profiles: defaultProfiles + ' + [{"name":"extra","inputs":1}]' }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
      ['duplicate profile', { profiles: defaultProfiles.replace('"secondary"', '"primary"') }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
      ['wrong profile name', { profiles: defaultProfiles.replace('"secondary"', '"other"') }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
      ['primary must be first', { profiles: 'list(reversed(' + defaultProfiles + '))' }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
      ['profile inputs are required', { profiles: '[{"name":"primary"},{"name":"secondary","inputs":1}]' }, 'CPU_BENCHMARK_CONTRACT_INVALID'],
    ];
    for (const [name, changes, code] of contractFailures) {
      await t.test(name, async () => {
        await failure({ oracle: oracleCode(changes), candidate: 'raise AssertionError("candidate must not load before oracle preflight")\n' }, code);
      });
    }

    await t.test('lazy inputs are materialized once and validated', async () => {
      await success({ oracle: oracleCode({
        cases: '[{"name":"minimum","category":"minimal","make_inputs":lambda: [1.0]}, {"name":"boundary","category":"boundary","make_inputs":lambda: []}]',
        profiles: '[{"name":"primary","make_inputs":lambda: [1.0]}, {"name":"secondary","make_inputs":lambda: []}]',
      }) });
      await failure({ oracle: oracleCode({ cases: defaultCases.replace('"inputs": {"v": [0.0]}', '"inputs": 1, "make_inputs": lambda: 1') }) }, 'CPU_CASE_CONTRACT_INVALID');
    });

    const specFailures = [
      ['missing frozen testSpec', (task) => { delete task.matrix.testSpec; }, 'CPU_TEST_SPEC_INVALID'],
      ['top-level count conflicts', (task) => { task.matrix.correctnessCases = 1; }, 'CPU_TEST_SPEC_CONFLICT'],
      ['top-level warmup conflicts', (task) => { task.matrix.warmup = 1; }, 'CPU_TEST_SPEC_CONFLICT'],
      ['top-level repeats conflict', (task) => { task.matrix.repeats = 4; }, 'CPU_TEST_SPEC_CONFLICT'],
      ['negative tolerance', (task) => { task.matrix.testSpec.correctness.atol = -1; }, 'CPU_TEST_SPEC_INVALID'],
      ['boolean tolerance', (task) => { task.matrix.testSpec.correctness.atol = false; }, 'CPU_TEST_SPEC_INVALID'],
      ['missing tolerance', (task) => { delete task.matrix.testSpec.correctness.rtol; }, 'CPU_TEST_SPEC_INVALID'],
      ['zero repeats', (task) => { task.matrix.testSpec.benchmark.repeats = 0; }, 'CPU_TEST_SPEC_INVALID'],
      ['fractional count', (task) => { task.matrix.testSpec.correctness.requestedCases = 1.5; }, 'CPU_TEST_SPEC_INVALID'],
      ['duplicate category specification', (task) => { task.matrix.testSpec.correctness.requiredCategories = ['minimal', 'minimal']; }, 'CPU_TEST_SPEC_INVALID'],
      ['undeclared primary profile', (task) => { task.matrix.testSpec.benchmark.primaryProfile = 'other'; }, 'CPU_TEST_SPEC_INVALID'],
      ['CPU cannot substitute for C550', (task) => { task.hardware = ['C550']; }, 'CPU_ENVIRONMENT_MISMATCH'],
      ['unsupported tensor contracts are not weakened', (task) => { task.matrix.testSpec.correctness.dtypeTolerance = {}; }, 'CPU_TEST_SPEC_UNSUPPORTED'],
    ];
    for (const [name, change, code] of specFailures) {
      await t.test(name, async () => {
        const task = taskInput();
        change(task);
        await failure({ task }, code, 'preflight', 'contract');
      });
    }

    await t.test('invalid JSON non-finite constants are rejected before execution', async () => {
      for (const taskJson of ['{"matrix":NaN}', '{"candidate":{"digest":1e9999}}']) {
        await failure({ taskJson }, 'CPU_TASK_INVALID', 'preflight', 'contract');
      }
    });

    await t.test('missing and failing providers never trigger compatibility inputs', async () => {
      await failure({ oracle: 'def reference(inputs): return inputs\ndef get_benchmark_inputs(): return []\n' }, 'CPU_MODULE_INVALID');
      await failure({ oracle: oracleCode({ cases: '1 / 0' }) }, 'CPU_ORACLE_PROVIDER_FAILED');
      await failure({ oracle: oracleCode({ cases: '[{"name":"minimum","category":"minimal","make_inputs":lambda: 1/0}, {"name":"boundary","category":"boundary","inputs":1}]' }) }, 'CPU_ORACLE_INPUT_FAILED');
      await failure({ candidate: 'def reference(inputs): return inputs\n' }, 'CPU_MODULE_INVALID', 'preflight', 'candidate');
    });

    const invalidInputs = [
      ['NaN input', 'float("nan")', 'CPU_VALUE_NON_FINITE'],
      ['infinite input', 'float("inf")', 'CPU_VALUE_NON_FINITE'],
      ['unsupported input', '{1, 2}', 'CPU_VALUE_TYPE_UNSUPPORTED'],
    ];
    for (const [name, value, code] of invalidInputs) {
      await t.test(name, async () => {
        await failure({ oracle: oracleCode({ cases: defaultCases.replace('{"v": [0.0]}', value) }) }, code);
        await failure({ oracle: oracleCode({ profiles: defaultProfiles.replace('{"v": [5.0]}', value) }) }, code);
      });
    }
    await t.test('cyclic inputs are rejected without recursively executing the kernel', async () => {
      await failure({ oracle: oracleCode({
        prelude: 'cycle = []\ncycle.append(cycle)',
        cases: defaultCases.replace('{"v": [0.0]}', 'cycle'),
      }) }, 'CPU_VALUE_INVALID');
    });

    const candidateFailures = [
      ['numeric mismatch', 'return {"v": [value + 1.0 for value in inputs["v"]]}', 'CPU_CORRECTNESS_MISMATCH'],
      ['zero tolerances stay zero', 'return {"v": [value + 1e-9 for value in inputs["v"]]}', 'CPU_CORRECTNESS_MISMATCH'],
      ['result type mismatch', 'return 0.0', 'CPU_RESULT_TYPE_MISMATCH'],
      ['result shape mismatch', 'return {"v": []}', 'CPU_RESULT_SHAPE_MISMATCH'],
      ['NaN result', 'return float("nan")', 'CPU_VALUE_NON_FINITE'],
      ['infinite result', 'return float("inf")', 'CPU_VALUE_NON_FINITE'],
      ['unsupported result', 'return {1, 2}', 'CPU_VALUE_TYPE_UNSUPPORTED'],
    ];
    for (const [name, body, code] of candidateFailures) {
      await t.test(name, async () => {
        const outcome = await failure({ candidate: 'def run(inputs):\n    ' + body + '\n' }, code, 'correctness', 'candidate');
        assert.equal(outcome.correctness.passed, false);
        assert.equal(outcome.correctness.executedCases, 2);
        assert.equal(outcome.correctness.caseResults.length, 2);
        assert.equal(outcome.correctness.failedCase, 1);
        assert.equal(outcome.correctness.failure.category, 'validation');
      });
    }
    await t.test('finite nonzero tolerance is honored without weakening integer equality', async () => {
      const task = taskInput();
      task.matrix.testSpec.correctness.atol = 1e-6;
      await success({ task, candidate: 'def run(inputs):\n    return {"v": [value + 1e-9 for value in inputs["v"]]}\n' });
      const oracle = oracleCode({ cases: defaultCases.replace('{"v": [0.0]}', '1152921504606846977') });
      await failure({ oracle, candidate: 'def run(inputs):\n    return 1152921504606846976 if type(inputs) is int else inputs\n' }, 'CPU_CORRECTNESS_MISMATCH', 'correctness', 'candidate');
    });

    await t.test('correct numeric value with wrong scalar/container type is rejected', async () => {
      const cases = '[{"name":"minimum","category":"minimal","inputs":1},{"name":"boundary","category":"boundary","inputs":1}]';
      await failure({ oracle: oracleCode({ cases }), candidate: 'def run(inputs):\n    return True\n' }, 'CPU_RESULT_TYPE_MISMATCH', 'correctness', 'candidate');
      await failure({ oracle: oracleCode({ cases }), candidate: 'def run(inputs):\n    return 1.0\n' }, 'CPU_RESULT_TYPE_MISMATCH', 'correctness', 'candidate');
      const lists = '[{"name":"minimum","category":"minimal","inputs":[1]},{"name":"boundary","category":"boundary","inputs":[1]}]';
      await failure({ oracle: oracleCode({ cases: lists }), candidate: 'def run(inputs):\n    return tuple(inputs)\n' }, 'CPU_RESULT_TYPE_MISMATCH', 'correctness', 'candidate');
    });

    await t.test('input mutation fails even if the returned answer matches the oracle', async () => {
      const candidate = 'import copy\ndef run(inputs):\n    original = copy.deepcopy(inputs)\n    inputs["v"].append(99.0)\n    return original\n';
      await failure({ candidate }, 'CPU_INPUT_MUTATED', 'correctness', 'candidate');
      const oracle = oracleCode({ prelude: 'import copy', reference: 'original = copy.deepcopy(inputs)\ninputs["v"].append(99.0)\nreturn original' });
      await failure({ oracle }, 'CPU_INPUT_MUTATED', 'correctness', 'oracle');
    });

    await t.test('kernel exceptions remain structured correctness failures, including SystemExit', async () => {
      for (const exception of ['ValueError("kernel input failure")', 'RuntimeError("network timeout inside kernel")', 'SystemExit(7)']) {
        const outcome = await failure({ candidate: 'def run(inputs):\n    raise ' + exception + '\n' }, 'CPU_CANDIDATE_EXCEPTION', 'correctness', 'candidate');
        assert.equal(outcome.result.error.category, 'validation');
        assert.equal(outcome.correctness.passedCases, 0);
        assert.equal(outcome.correctness.failedCases, 2);
        assert.equal(outcome.correctness.failure.details.exceptionType, exception.split('(')[0]);
      }
    });

    await t.test('all declared cases settle even when the first candidate case fails', async () => {
      const outcome = await failure({ candidate: 'def run(inputs):\n    if len(inputs["v"]) == 2: raise ValueError("first case")\n    return inputs\n' }, 'CPU_CANDIDATE_EXCEPTION', 'correctness', 'candidate');
      assert.equal(outcome.correctness.executedCases, 2);
      assert.equal(outcome.correctness.passedCases, 1);
      assert.equal(outcome.correctness.failedCases, 1);
      assert.equal(outcome.correctness.caseResults[1].passed, true);
    });

    await t.test('oracle exceptions and non-finite oracle answers identify the oracle role', async () => {
      await failure({ oracle: oracleCode({ reference: 'raise ValueError("oracle failed")' }) }, 'CPU_ORACLE_EXCEPTION', 'correctness', 'oracle');
      await failure({ oracle: oracleCode({ reference: 'return float("inf")' }) }, 'CPU_VALUE_NON_FINITE', 'correctness', 'oracle');
    });

    await t.test('missing dependencies stay separate from candidate numerical errors', async () => {
      const outcome = await failure({ candidate: 'import __missing_cpu_contract_dependency__\ndef run(inputs): return inputs\n' }, 'CPU_DEPENDENCY_UNAVAILABLE', 'preflight', 'candidate');
      assert.equal(outcome.result.error.category, 'dependency');
      assert.equal(outcome.result.error.details.exceptionType, 'ModuleNotFoundError');
    });

    const benchmarkFailures = [
      ['exception', 'raise ValueError("benchmark-only failure")', 'CPU_CANDIDATE_EXCEPTION'],
      ['non-finite output', 'return float("nan")', 'CPU_VALUE_NON_FINITE'],
      ['wrong output', 'return {"v":[6.0]}', 'CPU_CORRECTNESS_MISMATCH'],
      ['wrong type', 'return [5.0]', 'CPU_RESULT_TYPE_MISMATCH'],
      ['input mutation', 'inputs["v"].append(1.0)', 'CPU_INPUT_MUTATED'],
    ];
    for (const [name, line, code] of benchmarkFailures) {
      await t.test('benchmark rejects ' + name + ' and withholds partial timing evidence', async () => {
        const candidate = 'def run(inputs):\n    if inputs["v"] == [5.0]:\n        ' + line + '\n    return inputs\n';
        const outcome = await failure({ candidate }, code, 'benchmark', 'candidate');
        assert.equal(outcome.correctness.passed, true);
        assert.equal(outcome.correctness.passedCases, 2);
        assert.deepEqual(outcome.result.benchmark, []);
      });
    }

    await t.test('real Python execution is bounded by the caller timeout', async () => {
      const started = performance.now();
      const outcome = await execute({ candidate: 'def run(inputs):\n    while True: pass\n', timeout: 1000 });
      assert.equal(outcome.child.error?.code, 'ETIMEDOUT');
      assert.ok(performance.now() - started < 5_000);
      assert.equal(outcome.result, null);
      assert.equal(outcome.status.stage, 'correctness');
    });
  } finally {
    // The child has exited or was killed/reaped by spawnSync before cleanup.
    assert.equal(path.dirname(root), temporaryParent);
    assert.ok(path.basename(root).startsWith('operator-cpu-runner-contract-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
