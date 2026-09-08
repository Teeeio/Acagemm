"""Shared-host NVIDIA GPU adapter for the existing operator runner.

This adapter reuses the fixed runner's correctness and matrix checks while
replacing the C550-specific hardware probe and optional Triton-only benchmark
timer. It is an MVP development backend: the caller must have already admitted
the layered package, and its result is never publishable hardware evidence.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "local-c500-runner.py"


def _load_base():
    spec = importlib.util.spec_from_file_location("operator_studio_base_runner", SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load base runner: {SOURCE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _probe_nvidia(torch, device):
    executable = shutil.which("nvidia-smi")
    if not executable:
        raise RuntimeError("nvidia-smi is unavailable; shared GPU provenance cannot be established")
    probe = subprocess.run(
        [executable, "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=20, check=False,
    )
    if probe.returncode != 0 or not probe.stdout.strip():
        raise RuntimeError(f"nvidia-smi failed: {(probe.stderr or probe.stdout).strip()}")
    row = probe.stdout.strip().splitlines()[0].split(",")
    if len(row) < 2 or not row[0].strip():
        raise RuntimeError("nvidia-smi returned an invalid GPU record")
    return {
        "tool": executable,
        "deviceIndex": int(device),
        "deviceName": row[0].strip(),
        "driverVersion": row[1].strip(),
        "memoryMiB": int(row[2].strip()) if len(row) > 2 and row[2].strip().isdigit() else None,
        "torchVersion": torch.__version__,
        "cudaVersion": getattr(torch.version, "cuda", None),
        "nvidiaSmi": probe.stdout.strip()[:4000],
    }


def _benchmark_one(module, torch, inputs, warmup, repeats):
    for _ in range(max(1, warmup)):
        module.run(inputs)
    torch.cuda.synchronize()
    samples = []
    for _ in range(max(1, repeats)):
        start = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        start.record()
        module.run(inputs)
        end.record()
        end.synchronize()
        samples.append(float(start.elapsed_time(end)) * 1000.0)
    ordered = sorted(samples)
    percentile = lambda fraction: ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]
    return {
        "p50Us": percentile(0.5), "p95Us": percentile(0.95),
        "minUs": ordered[0], "maxUs": ordered[-1],
        "warmup": warmup, "samples": repeats,
    }


def main():
    runner = _load_base()
    runner._probe_c550 = _probe_nvidia
    runner._benchmark_one = _benchmark_one
    status = runner.main()
    result_path = Path(__import__("os").environ.get("OPERATOR_LOCAL_C500_RESULT_JSON", ""))
    if result_path.is_file():
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            environment = result.setdefault("environment", {})
            environment.update({
                "runtime": "local-shared-gpu-runner/v1",
                "service": "local-shared-gpu-adapter",
                "source": "local-shared-gpu",
                "hardware": "nvidia-gpu",
                "executionMode": "gpu",
                "liveHardware": True,
                "publishable": False,
            })
            result["publishable"] = False
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception as error:
            print(f"shared GPU result normalization failed: {error}", file=sys.stderr)
            return 1
    return status


if __name__ == "__main__":
    raise SystemExit(main())
