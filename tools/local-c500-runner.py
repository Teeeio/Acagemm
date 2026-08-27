import argparse
import importlib.util
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path


def _load_operator(run_py: Path):
    spec = importlib.util.spec_from_file_location("operator_studio_generated", run_py)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load generated operator: {run_py}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(run_py.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    missing = [name for name in ("get_inputs", "run", "reference") if not callable(getattr(module, name, None))]
    if missing:
        raise RuntimeError(f"generated run.py is missing required functions: {', '.join(missing)}")
    return module


def _torch_and_device():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("torch.cuda is unavailable; refusing to label this execution as local C500 hardware")
    return torch, torch.cuda.current_device()


def _probe_c500(torch, device):
    mx_smi = shutil.which("mx-smi")
    if not mx_smi:
        raise RuntimeError("mx-smi is unavailable; local C500 hardware provenance cannot be established")
    probe = subprocess.run([mx_smi], capture_output=True, text=True, timeout=20, check=False)
    if probe.returncode != 0:
        raise RuntimeError(f"mx-smi failed: {(probe.stderr or probe.stdout).strip()}")
    return {
        "tool": mx_smi,
        "deviceIndex": int(device),
        "deviceName": torch.cuda.get_device_name(device),
        "torchVersion": torch.__version__,
        "mxSmi": (probe.stdout or "").strip()[:4000],
    }


def _sync(torch):
    torch.cuda.synchronize()


def _assert_close(torch, actual, expected, atol, rtol):
    torch.testing.assert_close(actual, expected, atol=atol, rtol=rtol)


def _named_cases(module, count, test_spec):
    provider = getattr(module, "get_test_cases", None)
    if not callable(provider):
        return [
            {"name": f"compat-{index + 1}", "category": "representative", "inputs": module.get_inputs()}
            for index in range(count)
        ]
    generated = list(provider())
    if len(generated) != count:
        raise RuntimeError(f"get_test_cases() must return exactly {count} cases; got {len(generated)}")
    normalized = []
    for index, item in enumerate(generated):
        if not isinstance(item, dict) or ("inputs" not in item and not callable(item.get("make_inputs"))) or not item.get("name") or not item.get("category"):
            raise RuntimeError(f"correctness case {index + 1} must contain name, category, and inputs or make_inputs")
        normalized.append(item)
    required = set(((test_spec or {}).get("correctness") or {}).get("requiredCategories") or [])
    present = {str(item["category"]) for item in normalized}
    missing = sorted(required - present)
    if missing:
        raise RuntimeError(f"get_test_cases() is missing required categories: {', '.join(missing)}")
    return normalized


def _run_correctness(module, torch, cases, atol, rtol, test_spec=None, oracle_module=None):
    started = time.perf_counter()
    oracle = oracle_module or module
    generated_cases = _named_cases(oracle, cases, test_spec)
    details = []
    dtype_tolerance = ((test_spec or {}).get("correctness") or {}).get("dtypeTolerance") or {}
    cos_limit = float(((test_spec or {}).get("correctness") or {}).get("requireCosDiffBelow") or 1e-5)
    for index, case in enumerate(generated_cases):
        inputs = case.get("inputs") if "inputs" in case else case["make_inputs"]()
        expected = oracle.reference(inputs)
        actual = module.run(inputs)
        _sync(torch)
        tensor_type = getattr(torch, "Tensor", ())
        floating_inputs = [value for value in inputs.values() if tensor_type and isinstance(value, tensor_type) and value.is_floating_point()]
        dtype_name = str((floating_inputs[0].dtype if floating_inputs else getattr(actual, "dtype", "unknown"))).replace("torch.", "")
        tolerance = dtype_tolerance.get(dtype_name) or {}
        case_atol, case_rtol = float(tolerance.get("atol", atol)), float(tolerance.get("rtol", rtol))
        if tensor_type and isinstance(actual, tensor_type) and isinstance(expected, tensor_type):
            actual_float, expected_float = actual.float(), expected.float()
            delta = actual_float - expected_float
            max_diff = float(delta.abs().max().item()) if delta.numel() else 0.0
            rmse = float(torch.sqrt(torch.mean(delta.square())).item()) if delta.numel() else 0.0
            if delta.numel():
                cosine = torch.nn.functional.cosine_similarity(actual_float.flatten(), expected_float.flatten(), dim=0)
                cos_diff = float(1.0 - cosine.abs().item())
            else:
                cos_diff = 0.0
        else:
            max_diff = rmse = cos_diff = 0.0
        try:
            _assert_close(torch, actual, expected, case_atol, case_rtol)
            if cos_diff >= cos_limit:
                raise AssertionError(f"cos_diff {cos_diff} is not below {cos_limit}")
        except Exception as error:
            return {
                "passed": False,
                "total": cases,
                "passedCases": index,
                "failedCase": index + 1,
                "failedCaseName": case["name"],
                "failedCaseCategory": case["category"],
                "error": str(error),
                "caseResults": details + [{"case": case["name"], "dtype": dtype_name, "maxDiff": max_diff, "rmse": rmse, "cosDiff": cos_diff, "passed": False}],
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
            }
        details.append({"case": case["name"], "dtype": dtype_name, "maxDiff": max_diff, "rmse": rmse, "cosDiff": cos_diff, "passed": True})
    return {
        "passed": True,
        "total": cases,
        "passedCases": cases,
        "categories": sorted({str(case["category"]) for case in generated_cases}),
        "caseNames": [str(case["name"]) for case in generated_cases],
        "caseResults": details,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def _percentile(samples, fraction):
    if not samples:
        return None
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, math.floor((len(ordered) - 1) * fraction))]


def _benchmark(module, torch, warmup, repeats):
    return _benchmark_inputs(module, torch, [{"name": "primary", "inputs": module.get_inputs()}], warmup, repeats)[0]


def _benchmark_inputs(module, torch, profiles, warmup, repeats, oracle_module=None):
    results = []
    for profile in profiles:
        inputs = profile.get("inputs") if "inputs" in profile else profile["make_inputs"]()
        reference = _benchmark_one(oracle_module, torch, inputs, warmup, repeats) if oracle_module else None
        result = _benchmark_one(module, torch, inputs, warmup, repeats)
        results.append({
            "profile": profile["name"],
            **result,
            "referenceP50Us": reference["p50Us"] if reference else None,
            "speedup": (reference["p50Us"] / result["p50Us"]) if reference and result["p50Us"] > 0 else None,
        })
    return results


def _benchmark_one(module, torch, inputs, warmup, repeats):
    import triton

    measured = triton.testing.do_bench(
        lambda: module.run(inputs),
        warmup=max(1, warmup),
        rep=max(1, repeats),
        quantiles=[0.5, 0.95, 0.0, 1.0],
    )
    values = list(measured) if isinstance(measured, (tuple, list)) else [float(measured)] * 4
    return {
        "p50Us": float(values[0]) * 1000.0,
        "p95Us": float(values[1]) * 1000.0,
        "minUs": float(values[2]) * 1000.0,
        "maxUs": float(values[3]) * 1000.0,
        "warmup": warmup,
        "samples": repeats,
    }


def _named_benchmark_profiles(module, test_spec):
    provider = getattr(module, "get_benchmark_inputs", None)
    if not callable(provider):
        return [{"name": "primary", "inputs": module.get_inputs()}]
    generated = list(provider())
    if not generated:
        raise RuntimeError("get_benchmark_inputs() returned no profiles")
    normalized = []
    for index, item in enumerate(generated):
        if not isinstance(item, dict) or ("inputs" not in item and not callable(item.get("make_inputs"))) or not item.get("name"):
            raise RuntimeError(f"benchmark profile {index + 1} must contain name and inputs or make_inputs")
        normalized.append(item)
    required = set(((test_spec or {}).get("benchmark") or {}).get("requiredProfiles") or [])
    present = {str(item["name"]) for item in normalized}
    missing = sorted(required - present)
    if missing:
        raise RuntimeError(f"get_benchmark_inputs() is missing required profiles: {', '.join(missing)}")
    primary = ((test_spec or {}).get("benchmark") or {}).get("primaryProfile") or "primary"
    if str(normalized[0]["name"]) != str(primary):
        raise RuntimeError(f"first benchmark profile must be {primary}")
    return normalized


def _render(template, values):
    command = template
    for key, value in values.items():
        command = command.replace("{" + key + "}", str(value))
    return command


def _analysis_tool(name, env_name, default_template, values, artifact_dir):
    executable = shutil.which(name)
    template = os.environ.get(env_name, default_template)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if not executable and env_name not in os.environ:
        error = f"{name} is unavailable; optional diagnostic collection was skipped"
        (artifact_dir / "stderr.txt").write_text(error + "\n", encoding="utf-8")
        (artifact_dir / "stdout.txt").write_text("", encoding="utf-8")
        return {
            "status": "unavailable",
            "tool": name,
            "attempted": True,
            "artifactDir": str(artifact_dir),
            "error": error,
        }
    command = _render(template, {**values, "artifactDir": artifact_dir, "tool": executable or name})
    started = time.perf_counter()
    try:
        process = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=300, check=False)
    except Exception as error:
        detail = f"{name} invocation failed: {error}"
        (artifact_dir / "stderr.txt").write_text(detail + "\n", encoding="utf-8")
        (artifact_dir / "stdout.txt").write_text("", encoding="utf-8")
        return {
            "status": "failed",
            "tool": name,
            "attempted": True,
            "command": command,
            "artifactDir": str(artifact_dir),
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
            "error": detail,
        }
    (artifact_dir / "stdout.txt").write_text(process.stdout or "", encoding="utf-8")
    (artifact_dir / "stderr.txt").write_text(process.stderr or "", encoding="utf-8")
    if process.returncode != 0:
        detail = f"{name} failed with exit code {process.returncode}: {(process.stderr or process.stdout).strip()}"
        return {
            "status": "failed",
            "tool": name,
            "attempted": True,
            "command": command,
            "artifactDir": str(artifact_dir),
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
            "exitCode": process.returncode,
            "error": detail,
        }
    return {
        "status": "completed",
        "tool": name,
        "attempted": True,
        "command": command,
        "artifactDir": str(artifact_dir),
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def _trace_target(run_py):
    module = _load_operator(run_py)
    torch, _ = _torch_and_device()
    inputs = module.get_inputs()
    module.run(inputs)
    _sync(torch)


def _run(args):
    run_py = Path(args.run_py or os.environ["OPERATOR_LOCAL_C500_RUN_PY"]).resolve()
    result_json = Path(args.result_json or os.environ["OPERATOR_LOCAL_C500_RESULT_JSON"]).resolve()
    task_dir = Path(os.environ.get("OPERATOR_LOCAL_C500_TASK_DIR", result_json.parent)).resolve()
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    module = _load_operator(run_py)
    oracle_path = os.environ.get("OPERATOR_LOCAL_C500_ORACLE_RUN_PY")
    oracle_module = _load_operator(Path(oracle_path).resolve()) if oracle_path else module
    torch, device = _torch_and_device()
    hardware = _probe_c500(torch, device)
    matrix = task.get("matrix") or {}
    correctness_cases = max(1, int(matrix.get("correctnessCases") or 24))
    warmup = max(0, int(matrix.get("warmup") or 50))
    repeats = max(1, int(matrix.get("repeats") or 200))
    test_spec = matrix.get("testSpec") or {}
    correctness_spec = test_spec.get("correctness") or {}
    atol = float(correctness_spec.get("atol", args.atol))
    rtol = float(correctness_spec.get("rtol", args.rtol))
    correctness = _run_correctness(module, torch, correctness_cases, atol, rtol, test_spec, oracle_module)
    if not correctness["passed"]:
        raise RuntimeError(f"correctness failed on case {correctness.get('failedCase')}: {correctness.get('error')}")
    benchmark_profiles = _named_benchmark_profiles(oracle_module, test_spec)
    benchmark_results = _benchmark_inputs(module, torch, benchmark_profiles, warmup, repeats, oracle_module)
    primary_benchmark = benchmark_results[0]

    runner = Path(__file__).resolve()
    python = Path(sys.executable).resolve()
    values = {
        "python": f'"{python}"',
        "runner": f'"{runner}"',
        "runPy": f'"{run_py}"',
    }
    trace = _analysis_tool(
        "mctracer",
        "OPERATOR_LOCAL_C500_MCTRACER_COMMAND",
        '"{tool}" --output "{artifactDir}" {python} {runner} --stage trace-target --run-py {runPy}',
        values,
        task_dir / "analysis" / "mctracer",
    )
    profile = _analysis_tool(
        "mcProfiler",
        "OPERATOR_LOCAL_C500_MCPROFILER_COMMAND",
        '"{tool}" --output "{artifactDir}" {python} {runner} --stage trace-target --run-py {runPy}',
        values,
        task_dir / "analysis" / "mcProfiler",
    )
    environment_name = str((matrix.get("environments") or ["C500"])[0])
    result = {
        "benchmark": [{
            "environment": environment_name,
            "metric": task.get("metric") or "latency_p50",
            "profile": benchmark["profile"],
            "value": benchmark["p50Us"],
            "unit": "us",
            "samples": benchmark["samples"],
            "warmup": benchmark["warmup"],
            "p95": benchmark["p95Us"],
            "referenceValue": benchmark.get("referenceP50Us"),
            "speedup": benchmark.get("speedup"),
            "correctness": correctness,
        } for benchmark in benchmark_results],
        "tracer": {
            "format": "operator-trace/v1",
            "status": trace["status"],
            "events": [{"name": "mctracer", "category": "tool", "artifactDir": trace["artifactDir"], "durationMs": trace.get("durationMs")}]
            if trace["status"] == "completed" else [],
            "diagnostics": [trace["error"]] if trace.get("error") else [],
            "artifacts": trace,
        },
        "profiler": {
            "format": "operator-profile/v1",
            "status": profile["status"],
            "metrics": {
                "latencyP50Us": primary_benchmark["p50Us"],
                "latencyP95Us": primary_benchmark["p95Us"],
                "toolDurationMs": profile.get("durationMs"),
                "artifactDir": profile["artifactDir"],
            },
            "diagnostics": [profile["error"]] if profile.get("error") else [],
            "artifacts": profile,
        },
        "environment": {
            "requested": task.get("hardware") or matrix.get("environments") or ["C500"],
            "runtime": "local-c500-runner/v1",
            "service": "local-c500-adapter",
            "liveHardware": True,
            "source": "local-c500",
            "hardware": hardware,
            "candidateDigest": (task.get("candidate") or {}).get("digest"),
            "runPySource": task.get("runPySource"),
            "optionalDiagnostics": {"mctracer": trace["status"], "mcProfiler": profile["status"]},
        },
    }
    result_json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("run", "trace-target"), default="run")
    parser.add_argument("--run-py")
    parser.add_argument("--result-json")
    parser.add_argument("--atol", type=float, default=1e-3)
    parser.add_argument("--rtol", type=float, default=1e-3)
    args = parser.parse_args()
    try:
        if args.stage == "trace-target":
            _trace_target(Path(args.run_py).resolve())
        else:
            _run(args)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
