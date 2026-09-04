"""Small CPU-only operator runner for deterministic workflow E2E tests.

It implements the local execution result contract but always emits non-hardware
evidence. It is deliberately separate from the C550 runner so production device
checks cannot be weakened by a test-only switch.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import math
import os
import platform
import statistics
import sys
import time
from pathlib import Path


def _load_module(file_path: Path):
    spec = importlib.util.spec_from_file_location(f"operator_{time.time_ns()}", file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load operator module: {file_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    missing = [name for name in ("get_inputs", "run", "reference") if not callable(getattr(module, name, None))]
    if missing:
        raise RuntimeError(f"run.py is missing required functions: {', '.join(missing)}")
    return module


def _write_json(path: Path, value) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _write_status(task_dir: Path, progress: int, stage: str, message: str) -> None:
    _write_json(task_dir / "runner-status.json", {
        "progress": progress,
        "stage": stage,
        "message": message,
        "updatedAt": time.time(),
    })


def _assert_close(actual, expected, atol: float, rtol: float, path: str = "result") -> None:
    if isinstance(expected, bool) or isinstance(actual, bool):
        if actual is not expected:
            raise AssertionError(f"{path}: {actual!r} != {expected!r}")
        return
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if not math.isclose(float(actual), float(expected), abs_tol=atol, rel_tol=rtol):
            raise AssertionError(f"{path}: {actual!r} != {expected!r}")
        return
    if isinstance(expected, dict) and isinstance(actual, dict):
        if set(actual) != set(expected):
            raise AssertionError(f"{path}: keys {sorted(actual)} != {sorted(expected)}")
        for key in expected:
            _assert_close(actual[key], expected[key], atol, rtol, f"{path}.{key}")
        return
    if isinstance(expected, (list, tuple)) and isinstance(actual, (list, tuple)):
        if len(actual) != len(expected):
            raise AssertionError(f"{path}: length {len(actual)} != {len(expected)}")
        for index, (actual_item, expected_item) in enumerate(zip(actual, expected)):
            _assert_close(actual_item, expected_item, atol, rtol, f"{path}[{index}]")
        return
    if actual != expected:
        raise AssertionError(f"{path}: {actual!r} != {expected!r}")


def _correctness_cases(module, count: int):
    provider = getattr(module, "get_test_cases", None)
    raw_cases = list(provider()) if callable(provider) else []
    if not raw_cases:
        raw_cases = [{"name": f"case-{index + 1}", "category": "representative", "inputs": module.get_inputs()} for index in range(count)]
    cases = []
    for index in range(count):
        raw = raw_cases[index % len(raw_cases)]
        if isinstance(raw, dict) and "inputs" in raw:
            cases.append({
                "name": str(raw.get("name") or f"case-{index + 1}"),
                "category": str(raw.get("category") or "representative"),
                "inputs": raw["inputs"],
            })
        else:
            cases.append({"name": f"case-{index + 1}", "category": "representative", "inputs": raw})
    return cases


def _run_correctness(module, oracle, count: int, atol: float, rtol: float):
    started = time.perf_counter()
    details = []
    cases = _correctness_cases(oracle, count)
    for index, case in enumerate(cases):
        expected = oracle.reference(copy.deepcopy(case["inputs"]))
        actual = module.run(copy.deepcopy(case["inputs"]))
        try:
            _assert_close(actual, expected, atol, rtol)
        except Exception as error:
            details.append({"case": case["name"], "category": case["category"], "passed": False, "error": str(error)})
            return {
                "passed": False,
                "total": count,
                "passedCases": index,
                "failedCase": index + 1,
                "failedCaseName": case["name"],
                "failedCaseCategory": case["category"],
                "error": str(error),
                "caseResults": details,
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
            }
        details.append({"case": case["name"], "category": case["category"], "passed": True})
    return {
        "passed": True,
        "total": count,
        "passedCases": count,
        "categories": sorted({case["category"] for case in cases}),
        "caseNames": [case["name"] for case in cases],
        "caseResults": details,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def _benchmark_profiles(module):
    provider = getattr(module, "get_benchmark_inputs", None)
    raw_profiles = list(provider()) if callable(provider) else []
    if not raw_profiles:
        return [{"name": "primary", "inputs": module.get_inputs()}]
    profiles = []
    for index, raw in enumerate(raw_profiles):
        if isinstance(raw, dict) and "inputs" in raw:
            profiles.append({"name": str(raw.get("name") or ("primary" if index == 0 else f"profile-{index + 1}")), "inputs": raw["inputs"]})
        else:
            profiles.append({"name": "primary" if index == 0 else f"profile-{index + 1}", "inputs": raw})
    return profiles


def _measure(module, inputs, warmup: int, repeats: int):
    for _ in range(warmup):
        sample_inputs = copy.deepcopy(inputs)
        module.run(sample_inputs)
        _assert_close(sample_inputs, inputs, 0.0, 0.0, "benchmark inputs")
    samples = []
    for _ in range(repeats):
        sample_inputs = copy.deepcopy(inputs)
        started = time.perf_counter_ns()
        module.run(sample_inputs)
        samples.append((time.perf_counter_ns() - started) / 1000.0)
        _assert_close(sample_inputs, inputs, 0.0, 0.0, "benchmark inputs")
    ordered = sorted(samples)
    p95_index = min(len(ordered) - 1, math.floor((len(ordered) - 1) * 0.95))
    return {
        "p50Us": statistics.median(ordered),
        "p95Us": ordered[p95_index],
        "minUs": ordered[0],
        "maxUs": ordered[-1],
        "warmup": warmup,
        "samples": repeats,
    }


def main() -> int:
    task_dir = Path(os.environ["OPERATOR_LOCAL_C500_TASK_DIR"]).resolve()
    run_py = Path(os.environ["OPERATOR_LOCAL_C500_RUN_PY"]).resolve()
    result_path = Path(os.environ["OPERATOR_LOCAL_C500_RESULT_JSON"]).resolve()
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    module = _load_module(run_py)
    oracle_path = os.environ.get("OPERATOR_LOCAL_C500_ORACLE_RUN_PY")
    oracle = _load_module(Path(oracle_path).resolve()) if oracle_path else module
    matrix = task.get("matrix") or {}
    count = max(1, int(matrix.get("correctnessCases") or 1))
    warmup = max(0, int(matrix.get("warmup") or 2))
    repeats = max(1, int(matrix.get("repeats") or 10))
    correctness_spec = ((matrix.get("testSpec") or {}).get("correctness") or {})
    atol = float(correctness_spec.get("atol") or 1e-6)
    rtol = float(correctness_spec.get("rtol") or 1e-6)

    _write_status(task_dir, 15, "correctness", f"Running {count} CPU correctness case(s).")
    correctness = _run_correctness(module, oracle, count, atol, rtol)
    _write_json(task_dir / "correctness.json", correctness)
    if not correctness["passed"]:
        raise RuntimeError(f"correctness failed: {correctness['error']}")

    _write_status(task_dir, 60, "benchmark", "Running lightweight CPU benchmark profiles.")
    benchmark = []
    for profile_item in _benchmark_profiles(oracle):
        measured = _measure(module, profile_item["inputs"], warmup, repeats)
        benchmark.append({
            "environment": "CPU",
            "metric": task.get("metric") or "latency_p50",
            "profile": profile_item["name"],
            "value": measured["p50Us"],
            "unit": "us",
            "samples": measured["samples"],
            "warmup": measured["warmup"],
            "p95": measured["p95Us"],
            "correctness": correctness,
        })

    environment = {
        "requested": task.get("hardware") or matrix.get("environments") or ["CPU"],
        "runtime": "local-cpu-runner/v1",
        "service": "local-cpu-adapter",
        "liveHardware": False,
        "source": "cpu-e2e",
        "hardware": {"device": "CPU", "processor": platform.processor() or "unknown", "python": platform.python_version()},
        "candidateDigest": (task.get("candidate") or {}).get("digest"),
        "runPySource": task.get("runPySource"),
    }
    result = {
        "benchmark": benchmark,
        "tracer": {"format": "operator-trace/v1", "status": "unavailable", "events": [], "diagnostics": ["CPU E2E does not collect C550 tracer evidence."], "simulated": True},
        "profiler": {"format": "operator-profile/v1", "status": "unavailable", "metrics": {"latencyP50Us": benchmark[0]["value"]}, "diagnostics": ["CPU E2E does not collect C550 profiler evidence."], "simulated": True},
        "environment": environment,
    }
    _write_json(result_path, result)
    _write_status(task_dir, 100, "complete", "CPU correctness and benchmark completed.")
    print(json.dumps({"status": "completed", "benchmark": benchmark, "environment": environment}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
