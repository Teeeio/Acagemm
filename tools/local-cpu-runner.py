"""Strict standard-library CPU execution adapter; never live hardware evidence.

Package isolation and dependency admission belong to the calling adapter. This
runner validates the frozen test contract and executes an independent oracle.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
import os
import platform
import statistics
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True


class RunnerFailure(Exception):
    def __init__(self, code, message, *, phase="preflight", role="contract",
                 category="validation", details=None):
        super().__init__(message)
        self.record = {
            "code": code, "message": message, "category": category,
            "phase": phase, "role": role, "retryable": False,
            "details": details or {},
        }


def _failure(code, message, **context):
    raise RunnerFailure(code, message, **context)


def _exception(code, error, *, phase, role):
    return RunnerFailure(code, f"{type(error).__name__}: {str(error)[:2000]}",
                         phase=phase, role=role,
                         details={"exceptionType": type(error).__name__})


def _write_json(file_path: Path, value) -> None:
    temporary = file_path.with_name(f".{file_path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                        allow_nan=False) + "\n", encoding="utf-8")
        os.replace(temporary, file_path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_status(task_dir, progress, stage, message):
    _write_json(task_dir / "runner-status.json", {
        "progress": progress, "stage": stage, "message": message,
        "updatedAt": time.time(),
    })


def _integer(value, label, minimum=1):
    if type(value) is not int or value < minimum:
        _failure("CPU_TEST_SPEC_INVALID", f"{label} must be an integer >= {minimum}.")
    return value


def _names(value, label):
    if (type(value) is not list or not value
            or any(type(item) is not str or not item or item != item.strip() for item in value)
            or len(set(value)) != len(value)):
        _failure("CPU_TEST_SPEC_INVALID", f"{label} must contain unique non-empty names.")
    return value


def _tolerance(value, label):
    try:
        valid = type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        valid = False
    if not valid:
        _failure("CPU_TEST_SPEC_INVALID", f"{label} must be finite and non-negative.")
    return float(value)


def _test_contract(task):
    matrix = task.get("matrix")
    spec = matrix.get("testSpec") if type(matrix) is dict else None
    if type(spec) is not dict or spec.get("schemaVersion") != "operator-studio.test-spec/v1":
        _failure("CPU_TEST_SPEC_INVALID", "matrix.testSpec must use operator-studio.test-spec/v1.")
    correctness, benchmark = spec.get("correctness"), spec.get("benchmark")
    if type(correctness) is not dict or type(benchmark) is not dict:
        _failure("CPU_TEST_SPEC_INVALID", "Explicit correctness and benchmark contracts are required.")
    count = _integer(correctness.get("requestedCases"), "correctness.requestedCases")
    categories = _names(correctness.get("requiredCategories"), "correctness.requiredCategories")
    profiles = _names(benchmark.get("requiredProfiles"), "benchmark.requiredProfiles")
    primary = benchmark.get("primaryProfile")
    if type(primary) is not str or primary not in profiles:
        _failure("CPU_TEST_SPEC_INVALID", "benchmark.primaryProfile must name a required profile.")
    if len(categories) > count or correctness.get("requireNamedCases", True) is not True:
        _failure("CPU_TEST_SPEC_INVALID", "Named cases must cover every required category.")
    if any(key in correctness for key in ("dtypeTolerance", "requireCosDiffBelow")):
        _failure("CPU_TEST_SPEC_UNSUPPORTED", "Tensor dtype/cosine contracts require another adapter.")
    warmup = _integer(benchmark.get("warmup"), "benchmark.warmup", minimum=0)
    repeats = _integer(benchmark.get("repeats"), "benchmark.repeats")
    for key, expected in (("correctnessCases", count), ("warmup", warmup), ("repeats", repeats)):
        if key in matrix and (_integer(matrix[key], f"matrix.{key}", minimum=0 if key == "warmup" else 1) != expected):
            _failure("CPU_TEST_SPEC_CONFLICT", f"matrix.{key} conflicts with frozen testSpec.")
    for label, value in (("matrix.environments", matrix.get("environments")),
                         ("hardware", task.get("hardware", ["CPU"]))):
        if type(value) is not list or value != ["CPU"]:
            _failure("CPU_ENVIRONMENT_MISMATCH", f"{label} must select only CPU.")
    return {
        "count": count, "categories": categories, "profiles": profiles, "primary": primary,
        "warmup": warmup, "repeats": repeats,
        "atol": _tolerance(correctness.get("atol"), "correctness.atol"),
        "rtol": _tolerance(correctness.get("rtol"), "correctness.rtol"),
    }


def _load_module(file_path, role):
    required = ("run",) if role == "candidate" else ("reference", "get_test_cases", "get_benchmark_inputs")
    try:
        spec = importlib.util.spec_from_file_location(f"operator_{role}_{time.time_ns()}", file_path)
        if spec is None or spec.loader is None:
            _failure("CPU_MODULE_INVALID", "Cannot load Python module.", role=role)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except RunnerFailure:
        raise
    except ModuleNotFoundError as error:
        raise RunnerFailure("CPU_DEPENDENCY_UNAVAILABLE", f"Missing Python dependency: {error.name}",
                            role=role, category="dependency",
                            details={"exceptionType": type(error).__name__}) from error
    except (Exception, SystemExit) as error:
        raise _exception("CPU_MODULE_INVALID", error, phase="preflight", role=role) from error
    missing = [name for name in required if not callable(getattr(module, name, None))]
    if missing:
        _failure("CPU_MODULE_INVALID", f"{role} is missing callable functions: {', '.join(missing)}.", role=role)
    return module


def _snapshot(value, *, phase, role, location="inputs", seen=None):
    """Typed immutable snapshot: finite builtin values, alias-safe, no coercion."""
    kind = type(value)
    if kind in (type(None), bool, int, str):
        return (kind.__name__, value)
    if kind is float:
        if not math.isfinite(value):
            _failure("CPU_VALUE_NON_FINITE", f"{location} contains a non-finite number.", phase=phase, role=role)
        return ("float", value.hex())
    if kind not in (list, tuple, dict):
        _failure("CPU_VALUE_TYPE_UNSUPPORTED", f"{location} has unsupported type {kind.__name__}.",
                 phase=phase, role=role)
    seen = set() if seen is None else seen
    if id(value) in seen:
        _failure("CPU_VALUE_INVALID", f"{location} contains a cycle.", phase=phase, role=role)
    seen.add(id(value))
    try:
        def capture(item, suffix):
            return _snapshot(item, phase=phase, role=role, location=f"{location}{suffix}", seen=seen)
        if kind is dict:
            return ("dict", frozenset((capture(key, ".key"), capture(item, f"[{key!r}]"))
                                      for key, item in value.items()))
        return (kind.__name__, tuple(capture(item, f"[{index}]") for index, item in enumerate(value)))
    finally:
        seen.remove(id(value))


def _assert_close(actual, expected, atol, rtol, *, phase, role="candidate", location="result"):
    if type(actual) is not type(expected):
        _failure("CPU_RESULT_TYPE_MISMATCH", f"{location}: expected {type(expected).__name__}, got {type(actual).__name__}.",
                 phase=phase, role=role)
    if type(expected) is dict:
        context = {"phase": phase, "role": role}
        if {_snapshot(key, **context) for key in actual} != {_snapshot(key, **context) for key in expected}:
            _failure("CPU_RESULT_SHAPE_MISMATCH", f"{location}: dictionary keys differ.", phase=phase, role=role)
        for key in expected:
            _assert_close(actual[key], expected[key], atol, rtol, phase=phase, role=role, location=f"{location}[{key!r}]")
    elif type(expected) in (list, tuple):
        if len(actual) != len(expected):
            _failure("CPU_RESULT_SHAPE_MISMATCH", f"{location}: sequence lengths differ.", phase=phase, role=role)
        for index, (left, right) in enumerate(zip(actual, expected)):
            _assert_close(left, right, atol, rtol, phase=phase, role=role, location=f"{location}[{index}]")
    elif (type(expected) is float and not math.isclose(actual, expected, abs_tol=atol, rel_tol=rtol)) or (type(expected) is not float and actual != expected):
        _failure("CPU_CORRECTNESS_MISMATCH", f"{location}: values differ.", phase=phase, role=role)


def _named_records(oracle, method, expected_count, contract):
    label = "correctness" if method == "get_test_cases" else "benchmark"
    code = "CPU_CASE_CONTRACT_INVALID" if label == "correctness" else "CPU_BENCHMARK_CONTRACT_INVALID"
    try:
        raw_records = getattr(oracle, method)()
    except (Exception, SystemExit) as error:
        raise _exception("CPU_ORACLE_PROVIDER_FAILED", error, phase="preflight", role="oracle") from error
    if type(raw_records) not in (list, tuple) or len(raw_records) != expected_count:
        _failure(code, f"{method}() must return exactly {expected_count} records.",
                 role="oracle", details={"expectedCount": expected_count,
                                         "actualCount": len(raw_records) if type(raw_records) in (list, tuple) else None})
    names, records = set(), []
    for index, raw in enumerate(raw_records):
        if type(raw) is not dict:
            _failure(code, f"{label} record {index + 1} must be a dictionary.", role="oracle")
        name = raw.get("name")
        if type(name) is not str or not name or name != name.strip() or name in names:
            _failure(code, f"{label} names must be unique non-empty strings.", role="oracle")
        names.add(name)
        category = raw.get("category")
        if label == "correctness" and (type(category) is not str or not category or category != category.strip()):
            _failure(code, f"Correctness case {name} requires a category.", role="oracle")
        has_inputs, has_factory = "inputs" in raw, callable(raw.get("make_inputs"))
        if has_inputs == has_factory:
            _failure(code, f"{name} requires exactly one of inputs or callable make_inputs.", role="oracle")
        try:
            inputs = raw["inputs"] if has_inputs else raw["make_inputs"]()
        except (Exception, SystemExit) as error:
            raise _exception("CPU_ORACLE_INPUT_FAILED", error, phase="preflight", role="oracle") from error
        _snapshot(inputs, phase="preflight", role="oracle", location=f"{label}.{name}.inputs")
        records.append({"name": name, "category": category, "inputs": copy.deepcopy(inputs)})
    if label == "correctness":
        missing = sorted(set(contract["categories"]) - {item["category"] for item in records})
        if missing:
            _failure(code, f"Missing required correctness categories: {', '.join(missing)}.", role="oracle")
    elif names != set(contract["profiles"]) or records[0]["name"] != contract["primary"]:
        _failure(code, "Benchmark names must exactly match requiredProfiles and primary must be first.", role="oracle")
    return records


def _invoke(function, inputs, *, phase, role):
    sample = copy.deepcopy(inputs)
    before = _snapshot(sample, phase=phase, role=role)
    started = time.perf_counter_ns()
    try:
        result = function(sample)
    except (Exception, SystemExit) as error:
        code = "CPU_CANDIDATE_EXCEPTION" if role == "candidate" else "CPU_ORACLE_EXCEPTION"
        raise _exception(code, error, phase=phase, role=role) from error
    duration_us = (time.perf_counter_ns() - started) / 1000.0
    if _snapshot(sample, phase=phase, role=role) != before:
        _failure("CPU_INPUT_MUTATED", "Operator modified its input.", phase=phase, role=role)
    _snapshot(result, phase=phase, role=role, location="result")
    return result, duration_us


def _run_correctness(candidate, oracle, cases, contract):
    started = time.perf_counter()
    details, first_failure = [], None
    for index, case in enumerate(cases):
        detail = {"case": case["name"], "category": case["category"], "passed": True}
        try:
            expected, _ = _invoke(oracle.reference, case["inputs"], phase="correctness", role="oracle")
            actual, _ = _invoke(candidate.run, case["inputs"], phase="correctness", role="candidate")
            _assert_close(actual, expected, contract["atol"], contract["rtol"], phase="correctness")
        except RunnerFailure as error:
            detail.update(passed=False, error=error.record["message"], failure=error.record)
            if first_failure is None:
                first_failure = (index + 1, case, error.record)
        details.append(detail)
    passed_cases = sum(item["passed"] for item in details)
    result = {
        "status": "passed" if first_failure is None else "failed",
        "passed": first_failure is None, "total": len(cases),
        "executedCases": len(details), "passedCases": passed_cases,
        "failedCases": len(cases) - passed_cases,
        "categories": sorted({case["category"] for case in cases}),
        "caseNames": [case["name"] for case in cases],
        "caseResults": details,
        "atol": contract["atol"], "rtol": contract["rtol"],
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
        "source": "cpu-e2e", "liveHardware": False,
    }
    if first_failure:
        index, case, failure = first_failure
        result.update(failedCase=index, failedCaseName=case["name"],
                      failedCaseCategory=case["category"], error=failure["message"],
                      failure=failure)
    return result


def _measure(candidate, oracle, inputs, contract):
    expected, _ = _invoke(oracle.reference, inputs, phase="benchmark", role="oracle")
    samples = []
    for index in range(contract["warmup"] + contract["repeats"]):
        actual, duration_us = _invoke(candidate.run, inputs, phase="benchmark", role="candidate")
        _assert_close(actual, expected, contract["atol"], contract["rtol"], phase="benchmark")
        if not math.isfinite(duration_us) or duration_us <= 0:
            _failure("CPU_BENCHMARK_TIMING_INVALID", "Clock returned an invalid elapsed time.",
                     phase="benchmark", role="backend", category="internal")
        if index >= contract["warmup"]:
            samples.append(duration_us)
    ordered = sorted(samples)
    p95_index = min(len(ordered) - 1, math.floor((len(ordered) - 1) * 0.95))
    return {
        "p50Us": statistics.median(ordered), "p95Us": ordered[p95_index],
        "minUs": ordered[0], "maxUs": ordered[-1],
        "warmup": contract["warmup"], "samples": contract["repeats"],
    }


def _environment(task):
    return {
        "requested": task.get("hardware") or (task.get("matrix") or {}).get("environments") or ["CPU"],
        "runtime": "local-cpu-runner/v2", "service": "local-cpu-adapter",
        "source": "cpu-e2e", "liveHardware": False,
        "hardware": {"device": "CPU", "processor": platform.processor() or "unknown",
                     "python": platform.python_version()},
        "candidateDigest": (task.get("candidate") or {}).get("digest"),
        "runPySource": task.get("runPySource"),
    }


def _empty_result():
    return {
        "schemaVersion": "operator-studio.cpu-result/v2", "status": "running",
        "source": "cpu-e2e", "liveHardware": False, "error": None,
        "correctness": None, "benchmark": [],
        "tracer": {"format": "operator-trace/v1", "status": "unavailable", "events": [],
                   "diagnostics": ["CPU backend does not collect tracer evidence."], "simulated": True},
        "profiler": {"format": "operator-profile/v1", "status": "unavailable", "metrics": {},
                     "diagnostics": ["CPU backend does not collect profiler evidence."], "simulated": True},
        "environment": _environment({}),
    }


def _read_task(task_dir):
    def finite_float(text):
        value = float(text)
        if not math.isfinite(value):
            raise ValueError("Non-finite JSON number.")
        return value
    def invalid_constant(text):
        raise ValueError(f"Invalid JSON constant: {text}.")
    try:
        task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"),
                          parse_float=finite_float, parse_constant=invalid_constant)
        if type(task) is not dict:
            raise ValueError("task.json must contain an object.")
        for name in ("candidate", "payload", "matrix"):
            if name in task and type(task[name]) is not dict:
                raise ValueError(f"task.{name} must be an object.")
        return task
    except (OSError, ValueError) as error:
        raise _exception("CPU_TASK_INVALID", error, phase="preflight", role="contract") from error


def _required_path(name):
    value = os.environ.get(name)
    if not value or not value.strip():
        _failure("CPU_RUNNER_CONFIG_INVALID", f"{name} is required.")
    return Path(value).resolve()


def main() -> int:
    task_dir = _required_path("OPERATOR_LOCAL_C500_TASK_DIR")
    result_path = _required_path("OPERATOR_LOCAL_C500_RESULT_JSON")
    result, contract, failure = _empty_result(), None, None
    try:
        _write_status(task_dir, 5, "preflight", "Validating CPU execution contract.")
        task = _read_task(task_dir)
        result["environment"] = _environment(task)
        contract = _test_contract(task)
        run_py = _required_path("OPERATOR_LOCAL_C500_RUN_PY")
        oracle_value = os.environ.get("OPERATOR_LOCAL_C500_ORACLE_RUN_PY")
        if not oracle_value or not oracle_value.strip():
            _failure("CPU_ORACLE_REQUIRED", "An independent oracle file is required for every task.", role="oracle")
        oracle_path = Path(oracle_value).resolve()
        if not oracle_path.is_file():
            _failure("CPU_ORACLE_INVALID", "Oracle must be an existing file.", role="oracle")
        if not run_py.is_file():
            _failure("CPU_MODULE_INVALID", "Candidate must be an existing Python file.", role="candidate")
        if run_py.samefile(oracle_path):
            _failure("CPU_ORACLE_INVALID", "Candidate and oracle must be different files.", role="oracle")
        result["environment"].update(
            candidateRunPyDigest="sha256:" + hashlib.sha256(run_py.read_bytes()).hexdigest(),
            oracleRunPyDigest="sha256:" + hashlib.sha256(oracle_path.read_bytes()).hexdigest(),
            taskContentDigest="sha256:" + hashlib.sha256((task_dir / "task.json").read_bytes()).hexdigest(),
        )
        oracle = _load_module(oracle_path, "oracle")
        cases = _named_records(oracle, "get_test_cases", contract["count"], contract)
        profiles = _named_records(oracle, "get_benchmark_inputs", len(contract["profiles"]), contract)
        candidate = _load_module(run_py, "candidate")
        _write_status(task_dir, 15, "correctness", f"Running {len(cases)} CPU correctness cases.")
        correctness = _run_correctness(candidate, oracle, cases, contract)
        result["correctness"] = correctness
        _write_json(task_dir / "correctness.json", correctness)
        if not correctness["passed"]:
            failure = correctness["failure"]
        else:
            _write_status(task_dir, 60, "benchmark", "Running validated CPU benchmark profiles.")
            benchmark = []
            for profile in profiles:
                measured = _measure(candidate, oracle, profile["inputs"], contract)
                benchmark.append({
                    "environment": "CPU", "metric": task.get("metric") or "latency_p50",
                    "profile": profile["name"], "value": measured["p50Us"], "unit": "us",
                    "samples": measured["samples"], "warmup": measured["warmup"],
                    "p95": measured["p95Us"], "min": measured["minUs"], "max": measured["maxUs"],
                    "correctness": correctness,
                })
            result["benchmark"] = benchmark
    except RunnerFailure as error:
        failure = error.record
    except (Exception, SystemExit) as error:
        failure = _exception("CPU_RUNNER_INTERNAL_ERROR", error, phase="runner", role="backend").record
        failure["category"] = "internal"

    if failure:
        result["status"], result["error"] = "failed", failure
        if result["correctness"] is None:
            result["correctness"] = {
                "status": "not_run", "passed": None, "total": contract["count"] if contract else 0,
                "executedCases": 0, "passedCases": 0, "caseResults": [],
                "error": failure["message"], "failure": failure,
                "source": "cpu-e2e", "liveHardware": False,
            }
        stage = "rejected" if failure["phase"] == "preflight" else f"{failure['phase']}_failed"
    else:
        result["status"], stage = "completed", "complete"
    _write_json(task_dir / "correctness.json", result["correctness"])
    _write_json(result_path, result)
    _write_status(task_dir, 100, stage, failure["message"] if failure else "CPU correctness and benchmark completed.")
    summary = {"status": result["status"], "error": result["error"], "environment": result["environment"]}
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False), file=sys.stderr if failure else sys.stdout)
    return 1 if failure else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RunnerFailure as error:
        print(json.dumps({"status": "failed", "error": error.record}), file=sys.stderr)
        sys.exit(1)
