import argparse
import hashlib
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
        raise RuntimeError("torch.cuda is unavailable; refusing to label this execution as C550 hardware")
    return torch, torch.cuda.current_device()


def _probe_c550(torch, device):
    mx_smi = shutil.which("mx-smi")
    if not mx_smi:
        raise RuntimeError("mx-smi is unavailable; C550 hardware provenance cannot be established")
    probe = subprocess.run([mx_smi], capture_output=True, text=True, timeout=20, check=False)
    if probe.returncode != 0:
        raise RuntimeError(f"mx-smi failed: {(probe.stderr or probe.stdout).strip()}")
    device_name = torch.cuda.get_device_name(device)
    expected_device = os.environ.get("OPERATOR_LOCAL_C500_EXPECTED_DEVICE", "C550").strip().upper()
    if expected_device and expected_device not in str(device_name).upper():
        raise RuntimeError(f"target device mismatch: expected {expected_device}, detected {device_name}")
    return {
        "tool": mx_smi,
        "deviceIndex": int(device),
        "deviceName": device_name,
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


def _json_digest(value):
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _input_signature(value, torch):
    tensor_type = getattr(torch, "Tensor", ())
    if tensor_type and isinstance(value, tensor_type):
        tensor = value.detach().contiguous().view(torch.uint8).cpu()
        content_digest = hashlib.sha256(tensor.numpy().tobytes()).hexdigest()
        return {"kind": "tensor", "shape": list(value.shape), "dtype": str(value.dtype).replace("torch.", ""), "contentDigest": content_digest}
    if isinstance(value, dict):
        return {str(key): _input_signature(item, torch) for key, item in sorted(value.items(), key=lambda item: str(item[0]))}
    if isinstance(value, (list, tuple)):
        return [_input_signature(item, torch) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return {"kind": type(value).__name__}


def _reference_cache_key(case, inputs, torch, context):
    return _json_digest({
        "schemaVersion": "operator-studio.correctness-reference-cache/v1",
        "profileId": context.get("profileId"),
        "testSpec": context.get("testSpec"),
        "case": {"name": case.get("name"), "category": case.get("category")},
        "inputs": _input_signature(inputs, torch),
        "seed": context.get("seed"),
        "oracleDigest": context.get("oracleDigest"),
        "pythonVersion": context.get("pythonVersion"),
        "torchVersion": context.get("torchVersion"),
        "deviceName": context.get("deviceName"),
        "deviceRuntime": context.get("deviceRuntime"),
    })


def _load_reference_cache(torch, cache_file, device):
    try:
        expected = torch.load(cache_file, map_location="cpu", weights_only=True)
        tensor_type = getattr(torch, "Tensor", ())
        if not tensor_type or not isinstance(expected, tensor_type):
            return None
        return expected.to(device=device)
    except Exception:
        return None


def _save_reference_cache(torch, cache_file, expected):
    tensor_type = getattr(torch, "Tensor", ())
    if not tensor_type or not isinstance(expected, tensor_type):
        return False
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_file.with_name(f".{cache_file.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        torch.save(expected.detach().cpu(), temporary)
        os.replace(temporary, cache_file)
        return True
    finally:
        temporary.unlink(missing_ok=True)


def _typed_error(code, message, phase, role, details=None):
    """Frozen neutral typed failure shared by every terminal correctness outcome."""
    return {
        "code": str(code),
        "message": str(message),
        "phase": str(phase),
        "role": str(role),
        "retryable": False,
        "details": dict(details or {}),
    }


def _not_run_correctness(total):
    """A real terminal with no attempted case: never a fabricated failed case."""
    return {
        "status": "not_run",
        "passed": None,
        "total": int(total or 0),
        "executedCases": 0,
        "passedCases": 0,
        "failedCase": None,
        "failedCaseName": None,
        "failedCaseCategory": None,
        "caseResults": [],
        "failure": None,
        "error": None,
    }


def _write_json_atomic(path, value):
    """Temporary file + os.replace in the destination directory (never a direct write)."""
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _execution_package(task):
    """The admitted package binding, read verbatim from the task payload only."""
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else task
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload.get(key)
        for key in ("packageDigest", "admissionId", "preparedArtifactDigest", "environmentDigest",
                    "acceptanceDigest", "workspaceId", "target", "build", "adapter")
        if payload.get(key) is not None
    }


def _candidate_of(task):
    candidate = task.get("candidate") if isinstance(task, dict) else None
    if not isinstance(candidate, dict):
        payload = task.get("payload") if isinstance(task, dict) and isinstance(task.get("payload"), dict) else {}
        candidate = payload.get("candidate")
    return candidate if isinstance(candidate, dict) else {}


def _environment_record(task, matrix, hardware=None, diagnostics_mode=None, tracer_status=None, profiler_status=None):
    """Environment provenance. A missing probe is never replaced by a current-host default."""
    task = task if isinstance(task, dict) else {}
    matrix = matrix if isinstance(matrix, dict) else {}
    environment = {
        "requested": task.get("hardware") or matrix.get("environments") or ["C550"],
        "runtime": "local-c500-runner/v1",
        "service": "local-c500-adapter",
        "source": "local-c500",
        "liveHardware": bool(isinstance(hardware, dict) and hardware),
        "hardware": hardware,
        "candidateDigest": _candidate_of(task).get("digest"),
        "runPySource": task.get("runPySource"),
    }
    if diagnostics_mode is not None:
        environment["diagnosticsMode"] = diagnostics_mode
    if tracer_status is not None or profiler_status is not None:
        environment["optionalDiagnostics"] = {"mctracer": tracer_status, "mcProfiler": profiler_status}
    return environment


def _failed_result(task, error, correctness, environment):
    """A failed execution never keeps a benchmark row and stays non-publishable."""
    result = {
        "status": "failed",
        "error": error,
        "correctness": correctness,
        "benchmark": [],
        "environment": environment,
        "publishable": False,
    }
    package = _execution_package(task)
    if package:
        result["executionPackage"] = package
        environment["executionPackage"] = package
    return result


def _case_dtype(torch, inputs):
    tensor_type = getattr(torch, "Tensor", ())
    floating = [value for value in inputs.values() if tensor_type and isinstance(value, tensor_type) and value.is_floating_point()]
    return str(getattr(floating[0], "dtype", "unknown")).replace("torch.", "") if floating else "unknown"


def _failed_correctness(*, total, index, name, category, code, role, message, dtype_name, metrics, details, cache_stats, started):
    """Preserve the attempted prefix and attach the same typed first failure everywhere."""
    typed = _typed_error(code, message, "correctness", role, {"case": name, "caseIndex": index + 1, "category": category})
    case_entry = {
        "case": name,
        "dtype": dtype_name,
        "maxDiff": metrics.get("maxDiff") if metrics else None,
        "rmse": metrics.get("rmse") if metrics else None,
        "cosDiff": metrics.get("cosDiff") if metrics else None,
        "passed": False,
        "error": message,
        "failure": typed,
    }
    return {
        "status": "failed",
        "passed": False,
        "total": total,
        "executedCases": index + 1,
        "passedCases": index,
        "failedCase": index + 1,
        "failedCaseName": name,
        "failedCaseCategory": category,
        "error": message,
        "failure": typed,
        "caseResults": details + [case_entry],
        "referenceCache": cache_stats,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def _case_metrics(torch, actual, expected):
    """Real computed numeric diagnostics, or None when they cannot be computed.

    Each diagnostic is committed as soon as it is really computed: a later
    diagnostic raising keeps the values already observed and reports its real
    error instead of flattening the whole measurement back to null. A metric
    that was never computed stays absent (null downstream), never a fabricated
    0. A pair of tensors that really is empty legitimately differs by an empty
    amount, so that single case keeps actual 0 values. A non-tensor candidate
    output or a shape/type error keeps null; a fabricated 0 would claim a
    comparison that never happened.

    Returns ``(metrics, error)``: ``metrics`` holds only the diagnostics that
    were really computed and ``error`` is the first diagnostic failure or None.
    """
    tensor_type = getattr(torch, "Tensor", ())
    if not tensor_type or not isinstance(actual, tensor_type) or not isinstance(expected, tensor_type):
        return None, None
    actual_float, expected_float = actual.float(), expected.float()
    delta = actual_float - expected_float
    if not int(delta.numel()):
        return {"maxDiff": 0.0, "rmse": 0.0, "cosDiff": 0.0}, None

    def cosine_diff():
        cosine = torch.nn.functional.cosine_similarity(actual_float.flatten(), expected_float.flatten(), dim=0)
        return float(1.0 - cosine.abs().item())

    metrics = {}
    error = None
    for key, observe in (
        ("maxDiff", lambda: float(delta.abs().max().item())),
        ("rmse", lambda: float(torch.sqrt(torch.mean(delta.square())).item())),
        ("cosDiff", cosine_diff),
    ):
        try:
            metrics[key] = observe()
        except Exception as failure:  # noqa: BLE001 - the diagnostic failed, not the runner
            if error is None:
                error = failure
    return metrics, error


def _run_correctness(module, torch, cases, atol, rtol, test_spec=None, oracle_module=None, reference_cache=None):
    started = time.perf_counter()
    oracle = oracle_module or module
    generated_cases = _named_cases(oracle, cases, test_spec)
    details = []
    cache_stats = {"schemaVersion": "operator-studio.correctness-reference-cache/v1", "enabled": bool(reference_cache), "hits": 0, "misses": 0}
    dtype_tolerance = ((test_spec or {}).get("correctness") or {}).get("dtypeTolerance") or {}
    cos_limit = float(((test_spec or {}).get("correctness") or {}).get("requireCosDiffBelow") or 1e-5)
    tensor_type = getattr(torch, "Tensor", ())
    for index, case in enumerate(generated_cases):
        name = str(case["name"])
        category = str(case["category"])
        dtype_name = "unknown"
        # Oracle-owned input generation (including a throwing make_inputs) and dtype
        # resolution keep the selected index/prefix and an accurate role=oracle.
        try:
            inputs = case.get("inputs") if "inputs" in case else case["make_inputs"]()
            if not isinstance(inputs, dict):
                raise TypeError(f"correctness case {index + 1} inputs must be a mapping, got {type(inputs).__name__}")
            dtype_name = _case_dtype(torch, inputs)
        except Exception as error:
            return _failed_correctness(
                total=cases, index=index, name=name, category=category,
                code="OPERATOR_ORACLE_EXCEPTION", role="oracle", message=str(error),
                dtype_name=dtype_name, metrics=None, details=details, cache_stats=cache_stats, started=started)
        expected = None
        cache_file = None
        if reference_cache:
            # The reference cache is backend infrastructure: a cache failure keeps
            # the passed prefix and role=backend, never role=oracle.
            try:
                cache_key = _reference_cache_key(case, inputs, torch, reference_cache)
                cache_file = Path(reference_cache["root"]) / cache_key[:2] / f"{cache_key}.pt"
                input_tensor = next((value for value in inputs.values() if tensor_type and isinstance(value, tensor_type)), None)
                device = input_tensor.device if input_tensor is not None else None
                if cache_file.exists() and device is not None:
                    expected = _load_reference_cache(torch, cache_file, device)
                if expected is not None:
                    cache_stats["hits"] += 1
                else:
                    cache_stats["misses"] += 1
            except Exception as error:
                return _failed_correctness(
                    total=cases, index=index, name=name, category=category,
                    code="OPERATOR_REFERENCE_CACHE_FAILURE", role="backend", message=str(error),
                    dtype_name=dtype_name, metrics=None, details=details, cache_stats=cache_stats, started=started)
        if expected is None:
            # An oracle reference throw keeps the attempted case and role=oracle,
            # but is never learnable as an operator failure.
            try:
                expected = oracle.reference(inputs)
            except Exception as error:
                return _failed_correctness(
                    total=cases, index=index, name=name, category=category,
                    code="OPERATOR_ORACLE_EXCEPTION", role="oracle", message=str(error),
                    dtype_name=dtype_name, metrics=None, details=details, cache_stats=cache_stats, started=started)
            if cache_file is not None:
                try:
                    _save_reference_cache(torch, cache_file, expected)
                except Exception as error:
                    return _failed_correctness(
                        total=cases, index=index, name=name, category=category,
                        code="OPERATOR_REFERENCE_CACHE_FAILURE", role="backend", message=str(error),
                        dtype_name=dtype_name, metrics=None, details=details, cache_stats=cache_stats, started=started)
        # A throwing candidate.run was still attempted for this named case (never not_run)
        # and its uncomputed numeric diagnostics stay null, never a fabricated 0.
        try:
            actual = module.run(inputs)
            _sync(torch)
        except Exception as error:
            return _failed_correctness(
                total=cases, index=index, name=name, category=category,
                code="OPERATOR_CANDIDATE_EXCEPTION", role="candidate", message=str(error),
                dtype_name=dtype_name, metrics=None, details=details, cache_stats=cache_stats, started=started)
        # Reading the output dtype, the output diagnostics and the oracle
        # comparison are one candidate stage: a shape/type/numeric/cosine failure
        # there is an OPERATOR_CORRECTNESS_MISMATCH that keeps the attempted case
        # and its prefix, never a lost generic runner error. Diagnostics really
        # computed before the failure are kept; ones never computed stay null.
        metrics = None
        try:
            floating_inputs = [value for value in inputs.values() if tensor_type and isinstance(value, tensor_type) and value.is_floating_point()]
            dtype_name = str((floating_inputs[0].dtype if floating_inputs else getattr(actual, "dtype", "unknown"))).replace("torch.", "")
            tolerance = dtype_tolerance.get(dtype_name) or {}
            case_atol, case_rtol = float(tolerance.get("atol", atol)), float(tolerance.get("rtol", rtol))
            metrics, metric_error = _case_metrics(torch, actual, expected)
            if metric_error is not None:
                raise metric_error
            _assert_close(torch, actual, expected, case_atol, case_rtol)
            if metrics is not None and metrics["cosDiff"] >= cos_limit:
                raise AssertionError(f"cos_diff {metrics['cosDiff']} is not below {cos_limit}")
        except Exception as error:
            return _failed_correctness(
                total=cases, index=index, name=name, category=category,
                code="OPERATOR_CORRECTNESS_MISMATCH", role="candidate", message=str(error),
                dtype_name=dtype_name, metrics=metrics, details=details, cache_stats=cache_stats, started=started)
        observed = {"maxDiff": None, "rmse": None, "cosDiff": None}
        if metrics is not None:
            observed.update(metrics)
        details.append({"case": name, "dtype": dtype_name, **observed, "passed": True})
    return {
        "status": "passed",
        "passed": True,
        "total": cases,
        "executedCases": cases,
        "passedCases": cases,
        "failedCase": None,
        "failedCaseName": None,
        "failedCaseCategory": None,
        "failure": None,
        "error": None,
        "categories": sorted({str(case["category"]) for case in generated_cases}),
        "caseNames": [str(case["name"]) for case in generated_cases],
        "caseResults": details,
        "referenceCache": cache_stats,
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


DIAGNOSTICS_MODE_ENV = "OPERATOR_DIAGNOSTICS_MODE"
DIAGNOSTICS_MODES = ("unavailable", "mock")
DIAGNOSTIC_FORMATS = {"tracer": "operator-trace/v1", "profiler": "operator-profile/v1"}


def _diagnostics_mode():
    """Resolve the diagnostic collection mode.

    Priority: an explicit ``mock`` value never executes a real tool; the default
    ``unavailable`` still performs a real invocation whenever a command is
    configured or the tool is on PATH, and only falls back to ``unavailable``
    when neither exists. Any other value is a configuration error, not a silent
    downgrade.
    """
    raw = os.environ.get(DIAGNOSTICS_MODE_ENV)
    if raw is None or not str(raw).strip():
        return "unavailable"
    mode = str(raw).strip().lower()
    if mode not in DIAGNOSTICS_MODES:
        raise RuntimeError(f"{DIAGNOSTICS_MODE_ENV} must be one of {'|'.join(DIAGNOSTICS_MODES)}; got {raw!r}")
    return mode


def _analysis_tool(name, env_name, default_template, values, artifact_dir, mode=None):
    """Collect one optional diagnostic, returning a raw collection record.

    ``status`` is one of ``completed`` / ``failed`` (a real tool process ran),
    ``unavailable`` (no tool/command exists) or ``mocked`` (simulation only).
    ``source`` records where the record came from: ``tool`` / ``unavailable`` /
    ``mock``. Raw stdout, stderr and artifacts stay on disk and their paths are
    kept here for a future real parser; nothing in this record is projected as
    real trace events or profiler metrics by itself.
    """
    if mode is None:
        mode = _diagnostics_mode()
    else:
        # An explicit mode is validated exactly like the environment value; an
        # illegal optional mode is a configuration error, never silently treated
        # as a real invocation.
        mode = str(mode).strip().lower()
        if mode not in DIAGNOSTICS_MODES:
            raise RuntimeError(f"diagnostic mode must be one of {'|'.join(DIAGNOSTICS_MODES)}; got {mode!r}")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if mode == "mock":
        marker_path = artifact_dir / "simulated.json"
        marker = {
            "schemaVersion": "operator-studio.diagnostic-simulation/v1",
            "tool": name,
            "status": "mocked",
            "source": "mock",
            "simulated": True,
            "reason": f"{name} diagnostics were requested in {DIAGNOSTICS_MODE_ENV}=mock; no real collection was executed.",
        }
        marker_path.write_text(json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {
            "status": "mocked",
            "source": "mock",
            "simulated": True,
            "real": False,
            "tool": name,
            "attempted": False,
            "artifactDir": str(artifact_dir),
            "simulatedMarker": str(marker_path),
            "error": None,
        }
    executable = shutil.which(name)
    configured = env_name in os.environ
    stdout_path = artifact_dir / "stdout.txt"
    stderr_path = artifact_dir / "stderr.txt"
    if not executable and not configured:
        error = f"{name} is unavailable; optional diagnostic collection was skipped"
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text(error + "\n", encoding="utf-8")
        return {
            "status": "unavailable",
            "source": "unavailable",
            "simulated": False,
            "real": False,
            "tool": name,
            "attempted": True,
            "artifactDir": str(artifact_dir),
            "stdoutPath": str(stdout_path),
            "stderrPath": str(stderr_path),
            "error": error,
        }
    template = os.environ.get(env_name, default_template)
    command = _render(template, {**values, "artifactDir": artifact_dir, "tool": executable or name})
    started = time.perf_counter()
    try:
        process = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=300, check=False)
    except Exception as error:
        detail = f"{name} invocation failed: {error}"
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text(detail + "\n", encoding="utf-8")
        return {
            "status": "failed",
            "source": "tool",
            "simulated": False,
            "real": False,
            "tool": name,
            "attempted": True,
            "command": command,
            "artifactDir": str(artifact_dir),
            "stdoutPath": str(stdout_path),
            "stderrPath": str(stderr_path),
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
            "error": detail,
        }
    stdout_path.write_text(process.stdout or "", encoding="utf-8")
    stderr_path.write_text(process.stderr or "", encoding="utf-8")
    base = {
        "source": "tool",
        "simulated": False,
        "real": True,
        "tool": name,
        "attempted": True,
        "command": command,
        "artifactDir": str(artifact_dir),
        "stdoutPath": str(stdout_path),
        "stderrPath": str(stderr_path),
        "stdoutBytes": len((process.stdout or "").encode("utf-8")),
        "stderrBytes": len((process.stderr or "").encode("utf-8")),
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }
    if process.returncode != 0:
        detail = f"{name} failed with exit code {process.returncode}: {(process.stderr or process.stdout).strip()}"
        return {**base, "status": "failed", "exitCode": process.returncode, "error": detail}
    return {**base, "status": "completed"}


def _diagnostics_binding(task):
    """Read diagnostic provenance from the task's real fields only.

    ``runId`` is the benchmark-command ``requestId`` carried on
    ``task.payload``; it is the queue run identity and is deliberately distinct
    from the backend ``taskId``. A backend task id is never substituted for a
    run id. Missing fields stay ``None``. Nothing is filled from the current
    time, the benchmark result or a guessed default: an unbound diagnostic must
    be visibly unbound downstream.
    """
    task = task if isinstance(task, dict) else {}
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    candidate = task.get("candidate") if isinstance(task.get("candidate"), dict) else payload.get("candidate")
    if not isinstance(candidate, dict):
        candidate = {}
    snapshot = task.get("semanticSnapshot") if isinstance(task.get("semanticSnapshot"), dict) else {}
    semantic_binding = task.get("semanticBinding") if isinstance(task.get("semanticBinding"), dict) else payload.get("semanticBinding")
    if not isinstance(semantic_binding, dict):
        semantic_binding = {}

    def declared(value):
        return value.strip() if isinstance(value, str) and value.strip() else None

    return {
        "candidateDigest": declared(candidate.get("digest")),
        "runId": declared(payload.get("requestId")),
        "taskId": declared(task.get("taskId")),
        "sourceRunId": declared(candidate.get("sourceRunId")),
        "semanticDigest": declared(snapshot.get("digest")) or declared(semantic_binding.get("semanticDigest")),
    }


def _diagnostic_result(kind, collection, binding):
    """Pure projection from a raw collection record to the wired result shape.

    A successful tool exit only proves the collection command ran. Until a real
    parser exists, ``events``/``metrics`` stay empty and benchmark p50/p95 never
    leak into diagnostics. Mock and unavailable records never become
    ``completed``.

    Mock provenance wins over a contradictory status: an explicit
    ``source=mock`` or ``simulated=true`` is normalized to
    ``status=mocked`` / ``source=mock`` / ``simulated=true`` regardless of the
    incoming status. A record that claims ``completed``/``failed`` without any
    ``source`` cannot prove a real collection, so its source is conservatively
    reported as ``unknown`` instead of being promoted to ``tool``.
    """
    if kind not in DIAGNOSTIC_FORMATS:
        raise ValueError(f"unknown diagnostic kind: {kind!r}")
    collection = collection if isinstance(collection, dict) else {}
    binding = binding if isinstance(binding, dict) else {}
    status = str(collection.get("status") or "unavailable")
    declared_source = str(collection["source"]) if collection.get("source") else None
    mock_provenance = declared_source == "mock" or collection.get("simulated") is True or status == "mocked"
    if mock_provenance:
        # Mock/simulated provenance always wins over a contradictory status.
        status = "mocked"
        source = "mock"
        simulated = True
    else:
        simulated = False
        if declared_source:
            source = declared_source
        elif status == "unavailable":
            source = "unavailable"
        else:
            # Missing source cannot prove a real collection; never promote a
            # bare completed/failed status to ``tool``.
            source = "unknown"
    diagnostics = []
    if collection.get("error"):
        diagnostics.append(str(collection["error"]))
    if mock_provenance:
        diagnostics.append("Mock or simulated provenance: no real diagnostic collection was executed; this result cannot satisfy a real-evidence rule.")
    elif status == "unavailable":
        diagnostics.append("The diagnostic tool is unavailable; no diagnostic content was collected.")
    elif source == "unknown":
        diagnostics.append("The collection record carries no source; missing provenance cannot prove a real diagnostic collection, so events/metrics stay empty.")
    elif status == "completed":
        diagnostics.append("The tool exited successfully, which only proves the collection command ran; no real events or metrics have been parsed from its output yet.")
    elif status == "failed":
        diagnostics.append("The tool process failed; no real diagnostic content was collected.")
    artifacts = {
        key: collection.get(key)
        for key in ("tool", "attempted", "command", "artifactDir", "stdoutPath", "stderrPath", "stdoutBytes",
                    "stderrBytes", "exitCode", "durationMs", "real", "simulated", "simulatedMarker")
        if collection.get(key) is not None
    }
    if "simulated" in artifacts or simulated:
        # Keep the retained raw record consistent with the normalized verdict.
        artifacts["simulated"] = simulated
    result = {
        "format": DIAGNOSTIC_FORMATS[kind],
        "status": status,
        "source": source,
        "simulated": simulated,
        "binding": {
            "candidateDigest": binding.get("candidateDigest"),
            "runId": binding.get("runId"),
            "taskId": binding.get("taskId"),
            "sourceRunId": binding.get("sourceRunId"),
            "semanticDigest": binding.get("semanticDigest"),
        },
        "diagnostics": diagnostics,
        "artifacts": artifacts,
    }
    if kind == "tracer":
        result["events"] = []
    else:
        result["metrics"] = {}
    return result


def _trace_target(run_py):
    module = _load_operator(run_py)
    torch, _ = _torch_and_device()
    inputs = module.get_inputs()
    module.run(inputs)
    _sync(torch)


def _write_runner_status(task_dir, progress, stage, message):
    target = task_dir / "runner-status.json"
    temporary = task_dir / f".runner-status.{os.getpid()}.tmp"
    temporary.write_text(json.dumps({"progress": progress, "stage": stage, "message": message, "updatedAt": time.time()}, ensure_ascii=False) + "\n", encoding="utf-8")
    # Windows readers may briefly hold the destination without FILE_SHARE_DELETE.
    # Keep the old complete record until replacement succeeds; never truncate it.
    deadline = time.monotonic() + 1.0
    while True:
        try:
            os.replace(temporary, target)
            return
        except PermissionError as error:
            remaining = deadline - time.monotonic()
            if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or remaining <= 0:
                raise
            time.sleep(min(0.025, remaining))


def _run(args):
    run_py = Path(args.run_py or os.environ["OPERATOR_LOCAL_C500_RUN_PY"]).resolve()
    result_json = Path(args.result_json or os.environ["OPERATOR_LOCAL_C500_RESULT_JSON"]).resolve()
    task_dir = Path(os.environ.get("OPERATOR_LOCAL_C500_TASK_DIR", result_json.parent)).resolve()
    task = {}
    matrix = {}
    diagnostics_mode = None

    def persist_failure(code, message, phase, role, *, correctness=None, hardware=None, total=0):
        """Persist a structured terminal failure atomically instead of only stderr."""
        error = _typed_error(code, message, phase, role)
        terminal = correctness if correctness is not None else _not_run_correctness(total)
        environment = _environment_record(task, matrix, hardware=hardware, diagnostics_mode=diagnostics_mode)
        record = _failed_result(task, error, terminal, environment)
        _write_json_atomic(task_dir / "correctness.json", terminal)
        _write_json_atomic(result_json, record)
        return record

    try:
        diagnostics_mode = _diagnostics_mode()
    except Exception as error:
        persist_failure("OPERATOR_DIAGNOSTICS_CONFIG_INVALID", str(error), "preflight", "backend")
        raise
    try:
        task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
        if not isinstance(task, dict):
            task = {}
        matrix = task.get("matrix") if isinstance(task.get("matrix"), dict) else {}
    except Exception as error:
        task, matrix = {}, {}
        persist_failure("OPERATOR_TASK_CONFIG_INVALID", str(error), "preflight", "backend")
        raise
    correctness_cases = 0
    try:
        correctness_cases = max(1, int(matrix.get("correctnessCases") or 24))
        warmup = max(0, int(matrix.get("warmup") or 50))
        repeats = max(1, int(matrix.get("repeats") or 200))
        # The testSpec tolerances are part of the same preflight: a malformed spec
        # is a typed preflight failure, not a generic runner error on stderr.
        test_spec = matrix.get("testSpec") or {}
        if not isinstance(test_spec, dict):
            raise TypeError(f"matrix.testSpec must be an object, got {type(test_spec).__name__}")
        correctness_spec = test_spec.get("correctness") or {}
        if not isinstance(correctness_spec, dict):
            raise TypeError(f"matrix.testSpec.correctness must be an object, got {type(correctness_spec).__name__}")
        atol = float(correctness_spec.get("atol", args.atol))
        rtol = float(correctness_spec.get("rtol", args.rtol))
    except Exception as error:
        persist_failure("OPERATOR_MATRIX_INVALID", str(error), "preflight", "backend", total=correctness_cases)
        raise
    diagnostics_binding = _diagnostics_binding(task)
    try:
        module = _load_operator(run_py)
        oracle_path = os.environ.get("OPERATOR_LOCAL_C500_ORACLE_RUN_PY")
        oracle_module = _load_operator(Path(oracle_path).resolve()) if oracle_path else module
    except Exception as error:
        persist_failure("OPERATOR_MODULE_LOAD_FAILURE", str(error), "preflight", "backend", total=correctness_cases)
        raise
    try:
        torch, device = _torch_and_device()
        hardware = _probe_c550(torch, device)
    except Exception as error:
        # A missing probe never becomes current-host/default metadata.
        persist_failure("OPERATOR_HARDWARE_PROBE_FAILURE", str(error), "probe", "backend", total=correctness_cases)
        raise
    _write_runner_status(task_dir, 15, "correctness", f"Running {correctness_cases} fixed correctness cases.")
    cache_root = os.environ.get("OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR")
    oracle_file = Path(oracle_path).resolve() if oracle_path else run_py
    reference_cache = None
    if cache_root and oracle_path:
        reference_cache = {
            "root": str(Path(cache_root).resolve()),
            "profileId": matrix.get("profileId"),
            "testSpec": test_spec,
            "seed": (test_spec.get("generation") or {}).get("seed"),
            "oracleDigest": hashlib.sha256(oracle_file.read_bytes()).hexdigest(),
            "pythonVersion": sys.version.split()[0],
            "torchVersion": str(torch.__version__),
            "deviceName": hardware.get("deviceName"),
            "deviceRuntime": {
                "mxSmiVersion": next((line.strip() for line in str(hardware.get("mxSmi") or "").splitlines() if "mx-smi" in line.lower() and "version" in line.lower()), None),
                "driverVersion": next((part.strip() for line in str(hardware.get("mxSmi") or "").splitlines() if "Driver Version:" in line for part in [line.split("Driver Version:", 1)[1].split()[0]]), None),
                "macaVersion": next((part.strip() for line in str(hardware.get("mxSmi") or "").splitlines() if "MACA Version:" in line for part in [line.split("MACA Version:", 1)[1].split()[0]]), None),
            },
        }
    try:
        correctness = _run_correctness(module, torch, correctness_cases, atol, rtol, test_spec, oracle_module, reference_cache)
    except Exception as error:
        # Oracle case/metadata generation threw before any case was attempted.
        persist_failure("OPERATOR_ORACLE_EXCEPTION", str(error), "correctness", "oracle",
                        total=correctness_cases, hardware=hardware)
        raise
    if correctness.get("status") == "failed":
        failure = correctness.get("failure") or _typed_error(
            "OPERATOR_CORRECTNESS_MISMATCH", correctness.get("error") or "correctness failed", "correctness", "candidate")
        environment = _environment_record(task, matrix, hardware=hardware, diagnostics_mode=diagnostics_mode)
        record = _failed_result(task, failure, correctness, environment)
        _write_runner_status(task_dir, 100, "correctness_failed", f"Correctness failed: {correctness.get('failedCaseName') or correctness.get('failedCase')}.")
        _write_json_atomic(task_dir / "correctness.json", correctness)
        _write_json_atomic(result_json, record)
        raise RuntimeError(f"correctness failed on case {correctness.get('failedCase')}: {correctness.get('error')}")
    # Keep the already-observed passed correctness on disk before any benchmark
    # work starts: a later benchmark-stage failure must never erase it.
    _write_json_atomic(task_dir / "correctness.json", correctness)
    _write_runner_status(task_dir, 55, "correctness_complete", f"All {correctness_cases} correctness cases passed.")
    try:
        benchmark_profiles = _named_benchmark_profiles(oracle_module, test_spec)
        _write_runner_status(task_dir, 60, "benchmark", f"Running {len(benchmark_profiles)} fixed benchmark profiles.")
        benchmark_results = _benchmark_inputs(module, torch, benchmark_profiles, warmup, repeats, oracle_module)
    except Exception as error:
        # A benchmark-stage exception preserves the already observed passed correctness
        # and is never relabeled as a correctness mismatch.
        failure = _typed_error("OPERATOR_BENCHMARK_FAILURE", str(error), "benchmark", "backend")
        environment = _environment_record(task, matrix, hardware=hardware, diagnostics_mode=diagnostics_mode)
        record = _failed_result(task, failure, correctness, environment)
        _write_json_atomic(result_json, record)
        raise
    _write_runner_status(task_dir, 90, "benchmark_complete", f"Completed {len(benchmark_profiles)} benchmark profiles.")

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
        mode=diagnostics_mode,
    )
    profile = _analysis_tool(
        "mcProfiler",
        "OPERATOR_LOCAL_C500_MCPROFILER_COMMAND",
        '"{tool}" --output "{artifactDir}" {python} {runner} --stage trace-target --run-py {runPy}',
        values,
        task_dir / "analysis" / "mcProfiler",
        mode=diagnostics_mode,
    )
    tracer_result = _diagnostic_result("tracer", trace, diagnostics_binding)
    profiler_result = _diagnostic_result("profiler", profile, diagnostics_binding)
    _write_runner_status(task_dir, 95, "optional_diagnostics", f"Optional diagnostics handled (mode={diagnostics_mode}).")
    environment_name = str((matrix.get("environments") or ["C550"])[0])
    environment = _environment_record(
        task, matrix, hardware=hardware, diagnostics_mode=diagnostics_mode,
        tracer_status=tracer_result["status"], profiler_status=profiler_result["status"])
    result = {
        "status": "completed",
        "correctness": correctness,
        "error": None,
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
        "tracer": tracer_result,
        "profiler": profiler_result,
        "environment": environment,
    }
    package = _execution_package(task)
    if package:
        result["executionPackage"] = package
        environment["executionPackage"] = package
    _write_json_atomic(result_json, result)
    _write_runner_status(task_dir, 100, "complete", "Correctness and benchmark completed.")


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
