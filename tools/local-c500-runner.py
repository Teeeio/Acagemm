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


def _run_correctness(module, torch, cases, atol, rtol):
    started = time.perf_counter()
    for index in range(cases):
        inputs = module.get_inputs()
        expected = module.reference(inputs)
        actual = module.run(inputs)
        _sync(torch)
        try:
            _assert_close(torch, actual, expected, atol, rtol)
        except Exception as error:
            return {
                "passed": False,
                "total": cases,
                "passedCases": index,
                "failedCase": index + 1,
                "error": str(error),
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
            }
    return {
        "passed": True,
        "total": cases,
        "passedCases": cases,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def _percentile(samples, fraction):
    if not samples:
        return None
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, math.floor((len(ordered) - 1) * fraction))]


def _benchmark(module, torch, warmup, repeats):
    inputs = module.get_inputs()
    for _ in range(warmup):
        module.run(inputs)
    _sync(torch)
    samples = []
    for _ in range(repeats):
        start = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        start.record()
        module.run(inputs)
        end.record()
        end.synchronize()
        samples.append(float(start.elapsed_time(end)) * 1000.0)
    return {
        "p50Us": statistics.median(samples),
        "p95Us": _percentile(samples, 0.95),
        "minUs": min(samples),
        "maxUs": max(samples),
        "warmup": warmup,
        "samples": repeats,
    }


def _render(template, values):
    command = template
    for key, value in values.items():
        command = command.replace("{" + key + "}", str(value))
    return command


def _analysis_tool(name, env_name, default_template, values, artifact_dir):
    executable = shutil.which(name)
    template = os.environ.get(env_name, default_template)
    if not executable and env_name not in os.environ:
        raise RuntimeError(f"{name} is unavailable; real C500 evidence requires the analysis tool")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    command = _render(template, {**values, "artifactDir": artifact_dir, "tool": executable or name})
    started = time.perf_counter()
    process = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=300, check=False)
    (artifact_dir / "stdout.txt").write_text(process.stdout or "", encoding="utf-8")
    (artifact_dir / "stderr.txt").write_text(process.stderr or "", encoding="utf-8")
    if process.returncode != 0:
        raise RuntimeError(f"{name} failed with exit code {process.returncode}: {(process.stderr or process.stdout).strip()}")
    return {
        "status": "completed",
        "tool": name,
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
    torch, device = _torch_and_device()
    hardware = _probe_c500(torch, device)
    matrix = task.get("matrix") or {}
    correctness_cases = max(1, int(matrix.get("correctnessCases") or 24))
    warmup = max(0, int(matrix.get("warmup") or 50))
    repeats = max(1, int(matrix.get("repeats") or 200))
    correctness = _run_correctness(module, torch, correctness_cases, args.atol, args.rtol)
    if not correctness["passed"]:
        raise RuntimeError(f"correctness failed on case {correctness.get('failedCase')}: {correctness.get('error')}")
    benchmark = _benchmark(module, torch, warmup, repeats)

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
            "value": benchmark["p50Us"],
            "unit": "us",
            "samples": benchmark["samples"],
            "warmup": benchmark["warmup"],
            "p95": benchmark["p95Us"],
            "correctness": correctness,
        }],
        "tracer": {
            "format": "operator-trace/v1",
            "status": "completed",
            "events": [{"name": "mctracer", "category": "tool", "artifactDir": trace["artifactDir"], "durationMs": trace["durationMs"]}],
            "artifacts": trace,
        },
        "profiler": {
            "format": "operator-profile/v1",
            "status": "completed",
            "metrics": {
                "latencyP50Us": benchmark["p50Us"],
                "latencyP95Us": benchmark["p95Us"],
                "toolDurationMs": profile["durationMs"],
                "artifactDir": profile["artifactDir"],
            },
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
