import argparse
import importlib.util
import json
import math
import statistics
import sys
import time
from pathlib import Path


def _load_module(operator_path: Path):
    entry = operator_path if operator_path.is_file() else operator_path / "run.py"
    if not entry.exists():
        raise RuntimeError(f"operator entry not found: {entry}")
    spec = importlib.util.spec_from_file_location("local_c500_operator", entry)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(entry.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    for name in ("get_inputs", "run", "reference"):
        if not hasattr(module, name):
            raise RuntimeError(f"operator missing required function: {name}")
    return module


def _flatten(value):
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            out.extend(_flatten(item))
        return out
    if hasattr(value, "detach"):
        return _flatten(value.detach().cpu().float().reshape(-1).tolist())
    raise RuntimeError(f"unsupported output type: {type(value).__name__}")


def _compare(actual, expected, atol, rtol):
    left = _flatten(actual)
    right = _flatten(expected)
    if len(left) != len(right):
        return {"passed": False, "reason": f"length mismatch: {len(left)} != {len(right)}"}
    max_abs = 0.0
    max_rel = 0.0
    for a, b in zip(left, right):
        diff = abs(a - b)
        max_abs = max(max_abs, diff)
        denom = max(abs(b), 1e-12)
        max_rel = max(max_rel, diff / denom)
        if diff > atol + rtol * abs(b):
            return {"passed": False, "max_abs_diff": max_abs, "max_rel_diff": max_rel, "reason": "tolerance exceeded"}
    return {"passed": True, "max_abs_diff": max_abs, "max_rel_diff": max_rel}


def run_real(args):
    module = _load_module(Path(args.operator_path).resolve())
    inputs = module.get_inputs()
    expected = module.reference(inputs)
    if args.mode == "reference":
        latencies = []
        for _ in range(args.warmup):
            module.reference(inputs)
        for _ in range(args.repeats):
            started = time.perf_counter_ns()
            module.reference(inputs)
            latencies.append((time.perf_counter_ns() - started) / 1000.0)
        p50 = statistics.median(latencies) if latencies else None
        p95 = sorted(latencies)[math.floor((len(latencies) - 1) * 0.95)] if latencies else None
        return {
            "status": "completed",
            "correctness": "pass",
            "correctness_detail": {"passed": True, "reference_only": True},
            "latency_p50_us": p50,
            "latency_p95_us": p95,
            "warmup": args.warmup,
            "repeats": args.repeats,
            "mctracer": "not_run",
            "mcProfiler": "not_run",
        }
    actual = module.run(inputs)
    correctness = _compare(actual, expected, args.atol, args.rtol)
    latencies = []
    if correctness["passed"]:
        for _ in range(args.warmup):
            module.run(inputs)
        for _ in range(args.repeats):
            started = time.perf_counter_ns()
            module.run(inputs)
            latencies.append((time.perf_counter_ns() - started) / 1000.0)
    p50 = statistics.median(latencies) if latencies else None
    p95 = sorted(latencies)[math.floor((len(latencies) - 1) * 0.95)] if latencies else None
    return {
        "status": "completed" if correctness["passed"] else "failed",
        "correctness": "pass" if correctness["passed"] else "fail",
        "correctness_detail": correctness,
        "latency_p50_us": p50,
        "latency_p95_us": p95,
        "warmup": args.warmup,
        "repeats": args.repeats,
        "mctracer": "not_run",
        "mcProfiler": "not_run",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--operator-path", required=True)
    parser.add_argument("--mode", choices=["run", "reference"], default="run")
    parser.add_argument("--warmup", type=int, default=50)
    parser.add_argument("--repeats", type=int, default=200)
    parser.add_argument("--atol", type=float, default=1e-3)
    parser.add_argument("--rtol", type=float, default=1e-3)
    args = parser.parse_args()
    try:
        print(json.dumps(run_real(args), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
