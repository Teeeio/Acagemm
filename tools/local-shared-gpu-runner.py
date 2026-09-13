"""Shared-host NVIDIA GPU adapter for the existing operator runner.

This adapter reuses the fixed runner's correctness and matrix checks while
replacing the C550-specific hardware probe and optional Triton-only benchmark
timer. It is an MVP development backend: the caller must have already admitted
the layered package, and its result is never publishable hardware evidence.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "local-c500-runner.py"


def _write_json(path: Path, value):
    """Write terminal records atomically so queue polling never sees partial JSON."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _load_base():
    spec = importlib.util.spec_from_file_location("operator_studio_base_runner", SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load base runner: {SOURCE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _resolve_architecture(executable):
    """Best-effort architecture identity, read from the driver.

    Never guessed from the device name: a name->sm table would silently claim an
    architecture the driver never confirmed. Older nvidia-smi builds do not
    expose compute_cap, so this runs as a separate optional query and returning
    None simply leaves the architecture undeclared.
    """
    try:
        probe = subprocess.run(
            [executable, "--query-gpu=compute_cap", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except Exception as error:  # noqa: BLE001 - optional probe, never fatal
        return None, f"compute capability query failed: {error}"
    if probe.returncode != 0 or not probe.stdout.strip():
        return None, "nvidia-smi did not expose compute_cap; architecture left undeclared"
    raw = probe.stdout.strip().splitlines()[0].strip()
    digits = raw.replace(".", "", 1)
    if not raw or not digits.isdigit() or "." not in raw:
        return None, f"unexpected compute_cap value: {raw}"
    major, minor = raw.split(".", 1)
    return f"sm{major}{minor}", None


def _probe_nvidia(torch, device):
    executable = os.environ.get("OPERATOR_GPU_NVIDIA_SMI") or shutil.which("nvidia-smi")
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
    result = {
        "tool": executable,
        "deviceIndex": int(device),
        "deviceName": row[0].strip(),
        "driverVersion": row[1].strip(),
        "memoryMiB": int(row[2].strip()) if len(row) > 2 and row[2].strip().isdigit() else None,
        "torchVersion": torch.__version__,
        "cudaVersion": getattr(torch.version, "cuda", None),
        "nvidiaSmi": probe.stdout.strip()[:4000],
    }
    architecture, architecture_note = _resolve_architecture(executable)
    if architecture:
        result["architecture"] = architecture
    else:
        result["architectureNote"] = architecture_note
    return result


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


def _load_package_operator(run_py: Path, *, package_root=None, oracle=False):
    """Load only from the prepared package root, retaining it for lazy imports.

    Candidate modules need only ``run``; the independent oracle owns the frozen
    case/profile providers and ``reference``.  Keeping the prepared root on
    ``sys.path`` also makes package-local imports used inside ``run`` reliable.
    """
    run_py = Path(run_py).resolve()
    # The prepared artifact root (not merely the entrypoint's parent) is the
    # sole import root, allowing nested entrypoints to use packaged modules.
    import_root = Path(package_root or run_py.parent).resolve()
    sys.path.insert(0, str(import_root))
    spec = importlib.util.spec_from_file_location(
        f"operator_studio_{'oracle' if oracle else 'candidate'}_{os.getpid()}_{time.time_ns()}", run_py)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load prepared operator: {run_py}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    required = ("reference", "get_test_cases", "get_benchmark_inputs") if oracle else ("run",)
    missing = [name for name in required if not callable(getattr(module, name, None))]
    if missing:
        raise RuntimeError(f"prepared {'oracle' if oracle else 'candidate'} is missing required functions: {', '.join(missing)}")
    return module


def _execution_package(payload):
    """The admitted package binding, read verbatim from the task payload only."""
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload.get(key)
        for key in ("packageDigest", "admissionId", "preparedArtifactDigest", "environmentDigest",
                    "acceptanceDigest", "workspaceId", "target", "build", "adapter")
        if payload.get(key) is not None
    }


def _failure_result(task_dir: Path, result_path: Path, error, *, candidate=None, oracle=None):
    """Persist a structured terminal failure when the reused runner fails preflight."""
    task = {}
    try:
        task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    if not isinstance(task, dict):
        task = {}
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else task
    if not isinstance(payload, dict):
        payload = {}
    matrix = task.get("matrix") if isinstance(task.get("matrix"), dict) else {}
    try:
        requested_total = max(0, int(matrix.get("correctnessCases") or 0))
    except (TypeError, ValueError):
        requested_total = 0
    environment = {
        "requested": task.get("hardware") or matrix.get("environments") or ["local-shared-gpu"],
        "runtime": "local-shared-gpu-runner/v1", "service": "local-shared-gpu-adapter",
        "source": "local-shared-gpu", "publishable": False,
    }
    if candidate:
        environment["candidateRunPy"] = str(candidate)
    if oracle:
        environment["oracleRunPy"] = str(oracle)
    record = error if isinstance(error, dict) else {
        "code": "SHARED_GPU_RUNNER_FAILED", "message": str(error), "phase": "runner",
        "role": "backend", "retryable": False, "details": {},
    }
    correctness = {
        "status": "not_run", "passed": None, "total": requested_total,
        "executedCases": 0, "passedCases": 0, "failedCase": None,
        "failedCaseName": None, "failedCaseCategory": None,
        "caseResults": [], "error": None, "failure": None,
    }
    result = {
        "schemaVersion": "operator-studio.shared-gpu-result/v1", "status": "failed",
        "error": record, "correctness": correctness,
        "benchmark": [], "environment": environment, "publishable": False,
    }
    package = _execution_package(payload)
    if package:
        result["executionPackage"] = package
        environment["executionPackage"] = package
    if result_path and not result_path.is_dir():
        _write_json(result_path, result)
    return 1


CANDIDATE_FAILURE_CODES = ("OPERATOR_CORRECTNESS_MISMATCH", "OPERATOR_CANDIDATE_EXCEPTION")


def _experience_evidence(result, payload, package, environment, has_probe):
    """Keep the passed path compatible; only a real failed candidate correctness is learnable."""
    if not package:
        return None
    candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else {}
    if result.get("status") == "failed":
        if not has_probe:
            # Preflight/probe/backend failures must never become GPU evidence.
            return None
        correctness = result.get("correctness") if isinstance(result.get("correctness"), dict) else {}
        if correctness.get("status") != "failed" or correctness.get("passed") is not False:
            return None
        if result.get("benchmark") != []:
            return None
        failure = correctness.get("failure") if isinstance(correctness.get("failure"), dict) else result.get("error")
        if not isinstance(failure, dict):
            return None
        if failure.get("phase") != "correctness" or failure.get("role") != "candidate":
            return None
        if failure.get("code") not in CANDIDATE_FAILURE_CODES:
            return None
        cases = correctness.get("caseResults")
        if not isinstance(cases, list):
            return None
        try:
            total = int(correctness.get("total"))
            executed = int(correctness.get("executedCases"))
            passed_cases = int(correctness.get("passedCases"))
            failed_case = int(correctness.get("failedCase"))
        except (TypeError, ValueError):
            return None
        if total < 1 or executed < 1 or executed > total:
            return None
        if passed_cases != executed - 1 or failed_case != executed or len(cases) != executed:
            return None
        evidence = {
            "missionId": payload.get("missionId"),
            "candidateId": candidate.get("id"),
            "runId": payload.get("requestId"),
            "patchDigest": candidate.get("digest"),
            "packageDigest": package.get("packageDigest"),
            "environmentDigest": package.get("environmentDigest"),
            "acceptanceDigest": package.get("acceptanceDigest"),
            "hardware": "nvidia-gpu",
            "executionMode": "gpu",
            "outcome": "failed",
            "operation": "test",
            "liveHardware": True,
        }
        if isinstance(environment.get("architecture"), str) and environment["architecture"]:
            evidence["architecture"] = environment["architecture"]
        return evidence
    evidence = {
        "missionId": payload.get("missionId"),
        "candidateId": candidate.get("id"),
        "runId": payload.get("requestId"),
        "patchDigest": candidate.get("digest"),
        "packageDigest": package.get("packageDigest"),
        "environmentDigest": package.get("environmentDigest"),
        "acceptanceDigest": package.get("acceptanceDigest"),
        "hardware": "nvidia-gpu",
        "executionMode": "gpu",
        "outcome": "passed",
        "operation": "test",
        "liveHardware": True,
    }
    if isinstance(environment.get("architecture"), str) and environment["architecture"]:
        evidence["architecture"] = environment["architecture"]
    return evidence


def _normalize_result(result, task):
    """Normalize the reused runner record without ever erasing a real typed failure."""
    result["schemaVersion"] = "operator-studio.shared-gpu-result/v1"
    environment = result.get("environment")
    if not isinstance(environment, dict):
        environment = {}
        result["environment"] = environment
    raw_probe = environment.get("hardware")
    probe = raw_probe if isinstance(raw_probe, dict) else {}
    has_probe = bool(probe.get("deviceName") and probe.get("driverVersion"))
    architecture = probe.get("architecture") if has_probe else None
    environment.update({
        "runtime": "local-shared-gpu-runner/v1",
        "service": "local-shared-gpu-adapter",
        "source": "local-shared-gpu",
    })
    if has_probe:
        environment.update({
            "hardware": "nvidia-gpu",
            "executionMode": "gpu",
            "liveHardware": True,
            "targetProbe": probe,
        })
        if isinstance(architecture, str) and architecture:
            environment["architecture"] = architecture
            environment["device"] = probe.get("deviceName")
            environment["driverVersion"] = probe.get("driverVersion")
        else:
            # 未解析出架构就不声明该维度：不猜、不填默认值。
            environment["architectureNote"] = probe.get("architectureNote") or "architecture was not resolved"
    else:
        # No verified driver probe: never promote a failure into live GPU hardware.
        environment["liveHardware"] = False
        environment["targetProbe"] = None
        environment.setdefault("architectureNote", "architecture was not resolved")
    environment["publishable"] = False
    result["publishable"] = False

    payload = task.get("payload") if isinstance(task.get("payload"), dict) else task
    if not isinstance(payload, dict):
        payload = {}
    package = _execution_package(payload)
    if package:
        result["executionPackage"] = package
        environment["executionPackage"] = package
    evidence = _experience_evidence(result, payload, package, environment, has_probe)
    if evidence is None:
        result.pop("experienceEvidence", None)
    else:
        result["experienceEvidence"] = evidence
    return result


def main():
    runner = _load_base()
    runner._probe_c550 = _probe_nvidia
    runner._benchmark_one = _benchmark_one
    task_dir_value = os.environ.get("OPERATOR_LOCAL_C500_TASK_DIR", "").strip()
    result_value = os.environ.get("OPERATOR_LOCAL_C500_RESULT_JSON", "").strip()
    candidate_value = os.environ.get("OPERATOR_LOCAL_C500_RUN_PY", "").strip()
    task_dir = Path(task_dir_value).resolve() if task_dir_value else Path()
    result_path = Path(result_value).resolve() if result_value else Path()
    candidate = Path(candidate_value).resolve() if candidate_value else Path()
    oracle_value = os.environ.get("OPERATOR_LOCAL_C500_ORACLE_RUN_PY", "").strip()
    oracle = Path(oracle_value).resolve() if oracle_value else None
    if not task_dir_value or not task_dir.is_dir() or not result_value:
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_RUNNER_CONFIG_INVALID", "message": "task/result paths are required", "phase": "preflight", "role": "contract", "retryable": False, "details": {}})
    if not oracle_value or oracle is None or not oracle.is_file():
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_ORACLE_REQUIRED", "message": "An independent oracle file is required for every shared-GPU task.", "phase": "preflight", "role": "oracle", "retryable": False, "details": {}} , candidate=candidate)
    if candidate == oracle:
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_ORACLE_INVALID", "message": "Candidate and oracle must be different prepared files.", "phase": "preflight", "role": "oracle", "retryable": False, "details": {}}, candidate=candidate, oracle=oracle)
    # The adapter owns the task directory. Reject host paths even if an env var
    # is tampered with after package admission.
    try:
        candidate.relative_to(task_dir)
        oracle.relative_to(task_dir)
    except ValueError:
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_PATH_INVALID", "message": "Runner inputs must reside inside the prepared package directory.", "phase": "preflight", "role": "contract", "retryable": False, "details": {}}, candidate=candidate, oracle=oracle)
    # The adapter owns this directory: drop any stale terminal record first so a
    # previous success can never mask a preflight or execution failure.
    try:
        if result_path.is_file():
            result_path.unlink()
    except OSError:
        pass
    runner._load_operator = lambda file: _load_package_operator(file, package_root=task_dir, oracle=(Path(file).resolve() == oracle))
    status = runner.main()
    if not result_path.is_file():
        # Base runner catches failures and returns 1 without a result file.
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_RUNNER_FAILED", "message": "Shared-GPU runner terminated without a result record.", "phase": "runner", "role": "backend", "retryable": False, "details": {"exitCode": status}}, candidate=candidate, oracle=oracle)
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
        task_path = Path(os.environ.get("OPERATOR_LOCAL_C500_TASK_JSON", ""))
        if not task_path.is_file():
            task_path = task_dir / "task.json"
        task = json.loads(task_path.read_text(encoding="utf-8")) if task_path.is_file() else {}
        _normalize_result(result, task if isinstance(task, dict) else {})
        _write_json(result_path, result)
    except Exception as error:
        print(f"shared GPU result normalization failed: {error}", file=sys.stderr)
        return 1
    return status


if __name__ == "__main__":
    raise SystemExit(main())
