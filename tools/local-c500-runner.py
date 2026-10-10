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


def _assert_output_close(torch, actual, expected, atol, rtol, tolerances, cos_limit):
    # New generic contracts compare every output with its own dtype tolerance.
    # Shape/type/container mismatches still go through assert_close and fail.
    if isinstance(actual, dict) and isinstance(expected, dict) and actual.keys() == expected.keys():
        for name in expected:
            _assert_output_close(torch, actual[name], expected[name], atol, rtol, tolerances, cos_limit)
    elif isinstance(actual, (tuple, list)) and type(actual) is type(expected) and len(actual) == len(expected):
        for value, reference in zip(actual, expected):
            _assert_output_close(torch, value, reference, atol, rtol, tolerances, cos_limit)
    else:
        tolerance = tolerances.get(_tensor_dtype_name(expected)) or {}
        _assert_close(torch, actual, expected, float(tolerance.get('atol', atol)), float(tolerance.get('rtol', rtol)))
        metrics, error = _case_metrics(torch, actual, expected)
        if error is not None:
            raise error
        if metrics is not None and metrics['cosDiff'] >= cos_limit:
            raise AssertionError(f"cos_diff {metrics['cosDiff']} is not below {cos_limit}")


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
        # Size-one axes can be "contiguous" with a non-unit last stride, so
        # contiguous() may be a no-op that still cannot be viewed as bytes.
        # Copy logical values into canonical host storage, then flatten the byte
        # view (also supports scalar tensors). Never alter input shape/storage.
        tensor = value.detach().to(device='cpu', copy=True, memory_format=torch.contiguous_format).reshape(-1).view(torch.uint8)
        content_digest = hashlib.sha256(tensor.numpy().tobytes()).hexdigest()
        return {"kind": "tensor", "shape": list(value.shape), "dtype": str(value.dtype).replace("torch.", ""), "contentDigest": content_digest}
    if isinstance(value, dict):
        return {str(key): _input_signature(item, torch) for key, item in sorted(value.items(), key=lambda item: str(item[0]))}
    if isinstance(value, (list, tuple)):
        return [_input_signature(item, torch) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return {"kind": type(value).__name__}


class InputContractError(RuntimeError):
    # The baseline case inputs contradict the frozen tensor declaration.
    pass


def _validate_tensor_spec(correctness_spec):
    # Preflight check of the frozen tensor contract, dtype tolerances and cosine
    # bound: a malformed contract is a typed preflight failure, never ignored.
    if correctness_spec.get('toleranceScope') not in (None, 'output-dtype'):
        raise ValueError('unsupported correctness.toleranceScope')
    tolerances = correctness_spec.get("dtypeTolerance")
    if tolerances is not None:
        if not isinstance(tolerances, dict) or not all(
                isinstance(entry, dict) and all(isinstance(entry.get(key), (int, float)) and not isinstance(entry.get(key), bool)
                                                and math.isfinite(entry[key]) and entry[key] >= 0 for key in ("atol", "rtol"))
                for entry in tolerances.values()):
            raise ValueError("correctness.dtypeTolerance must map dtype names to non-negative finite {atol, rtol}")
    cos_limit = correctness_spec.get("requireCosDiffBelow")
    if cos_limit is not None and (isinstance(cos_limit, bool) or not isinstance(cos_limit, (int, float))
                                  or not math.isfinite(cos_limit) or cos_limit <= 0):
        raise ValueError("correctness.requireCosDiffBelow must be a positive finite number")
    tensors = correctness_spec.get("tensors")
    if tensors is None:
        return None

    def side(items):
        return isinstance(items, list) and items and len({str(item.get("name")) for item in items if isinstance(item, dict)}) == len(items) and all(
            isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("dtype"), str)
            and isinstance(item.get("shape"), list)
            and item.get('layout') in (None, 'contiguous', 'strided', 'channels_last', 'scalar')
            and (item.get('layout') != 'scalar' or len(item['shape']) == 0)
            and (item.get('layout') != 'channels_last' or len(item['shape']) == 4)
            and all((isinstance(dim, int) and not isinstance(dim, bool) and dim >= 0) or (isinstance(dim, str) and dim)
                    for dim in item["shape"])
            for item in items)

    if not isinstance(tensors, dict) or not side(tensors.get("inputs")) or not side(tensors.get("outputs")):
        raise ValueError("correctness.tensors must list {name, dtype, shape} inputs and outputs")
    return tensors


def _tensor_dtype_name(value):
    dtype = getattr(value, "dtype", None)
    return None if dtype is None else str(dtype).replace("torch.", "")


def _conform(label, value, declared, bound):
    # One value against one declared tensor. A Python number satisfies a declared
    # 0-d tensor (its dtype cannot be read); a tensor must match dtype and rank,
    # integer dims exactly and named dims one value across the case.
    want_dtype, want_shape = declared["dtype"], declared["shape"]
    if want_shape == [] and isinstance(value, (int, float)) and not isinstance(value, bool):
        return None
    shape = _declared_shape_of(value)
    dtype = _tensor_dtype_name(value)
    if shape is None or dtype is None:
        return f"{label} is {type(value).__name__}, declared tensor {want_dtype}{want_shape}"
    if dtype != want_dtype:
        return f"{label} has dtype {dtype}, declared {want_dtype}"
    if len(shape) != len(want_shape):
        return f"{label} has shape {shape}, declared rank {len(want_shape)} {want_shape}"
    layout = declared.get('layout')
    if layout == 'scalar' and len(shape) != 0:
        return f'{label} must be a scalar'
    if layout == 'contiguous' and (not callable(getattr(value, 'is_contiguous', None)) or not value.is_contiguous()):
        return f'{label} must be contiguous'
    if layout == 'strided' and str(getattr(value, 'layout', '')) != 'torch.strided':
        return f'{label} must have strided storage'
    if layout == 'channels_last':
        # torch is already loaded by the runner; no backend probe here.
        import torch
        if len(shape) != 4 or not value.is_contiguous(memory_format=torch.channels_last):
            return f'{label} must be four-dimensional channels_last'
    for size, dim in zip(shape, want_shape):
        if isinstance(dim, int):
            if size != dim:
                return f"{label} has shape {shape}, declared {want_shape}"
        elif bound.setdefault(dim, size) != size:
            return f"{label} has {dim}={size}, but {dim}={bound[dim]} elsewhere in this case"
    return None


def _check_case_inputs(inputs, tensors):
    bound = {}
    for declared in tensors["inputs"]:
        name = declared["name"]
        if name not in inputs:
            raise InputContractError(f"declared input {name} is missing from the case inputs")
        problem = _conform(f"input {name}", inputs[name], declared, bound)
        if problem:
            raise InputContractError(problem)
    return bound


def _output_contract_problem(actual, tensors, bound):
    outputs = tensors["outputs"]
    names = [item["name"] for item in outputs]
    if isinstance(actual, dict):
        missing = [name for name in names if name not in actual]
        if missing:
            return "output_contract: missing declared output " + ", ".join(missing)
        values = [actual[name] for name in names]
    elif len(outputs) == 1:
        values = [actual]
    elif isinstance(actual, (list, tuple)) and len(actual) == len(outputs):
        values = list(actual)
    else:
        return f"output_contract: expected {len(outputs)} outputs ({', '.join(names)}), got {type(actual).__name__}"
    bound = dict(bound)
    for declared, value in zip(outputs, values):
        problem = _conform("output " + declared["name"], value, declared, bound)
        if problem:
            return "output_contract: " + problem
    return None


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


COVERAGE_SCHEMA_VERSION = "operator-studio.correctness-coverage/v1"

PRETEST_ENV = "OPERATOR_TEST_PRETEST"
PRETEST_ON = ("1", "true", "on", "enabled")
PRETEST_OFF = ("0", "false", "off", "disabled")


def _pretest_enabled():
    """Rollback switch for the fast pre-test prefix (absent means enabled).

    Resolved in the runner, never on the client: the frozen testSpec and every digest
    bound to it must not move with an operator switch, or the same Mission would
    produce different package and semantic digests depending on the environment it
    ran in. Disabling the pre-test restores the exact pre-prefix execution order and
    still runs the whole correctness set. An unknown value is a configuration error,
    never a silent downgrade.
    """
    raw = os.environ.get(PRETEST_ENV)
    if raw is None or not str(raw).strip():
        return True
    value = str(raw).strip().lower()
    if value in PRETEST_ON:
        return True
    if value in PRETEST_OFF:
        return False
    raise RuntimeError(f"{PRETEST_ENV} must be one of {'|'.join(PRETEST_ON + PRETEST_OFF)}; got {raw!r}")


class PrefixContractError(RuntimeError):
    """A declared correctness prefix violates the frozen contract.

    Never a candidate failure and never learnable operator evidence: both the
    prefix declaration and the case names come from the trusted side (the frozen
    Profile and the frozen oracle), so the candidate cannot have caused it and
    must not be charged a repair attempt for it.
    """

    def __init__(self, message, *, missing=None, coverage=None):
        super().__init__(message)
        self.missing = list(missing or [])
        self.coverage = coverage


def _prefix_plan(size=0, source="not_evaluated", names=None, passed=None):
    """The prefix actually planned for this run: size, provenance, and pass state."""
    return {"size": max(0, int(size)), "source": str(source), "names": [str(name) for name in (names or [])], "passed": passed}


def _coverage(*, required, planned, executed, passed, skipped_reason, prefix):
    """Coverage measured against the contract's required set, never against what ran.

    ``required`` is the frozen contract's case count, ``planned`` the count this run
    intended to execute, and ``executed`` the count it really attempted. A report is
    only ``complete`` when the run planned the whole required set, executed all of it,
    skipped nothing, and reached no terminal failure. Zero required cases is never
    complete: an empty contract proves nothing.
    """
    required, planned, executed, passed = (max(0, int(value)) for value in (required, planned, executed, passed))
    skipped = max(0, planned - executed)
    return {
        "schemaVersion": COVERAGE_SCHEMA_VERSION,
        "requiredCases": required,
        "plannedCases": planned,
        "executedCases": executed,
        "passedCases": passed,
        "skippedCases": skipped,
        "skippedReason": skipped_reason,
        "prefix": dict(prefix),
        "complete": bool(required > 0 and planned == required and executed == planned and skipped == 0 and skipped_reason is None),
    }


def _not_run_correctness(total, *, skipped_reason="not_run", prefix=None, coverage=None):
    """A real terminal with no attempted case: never a fabricated failed case."""
    required = max(0, int(total or 0))
    record = {
        "status": "not_run",
        "passed": None,
        "total": required,
        "executedCases": 0,
        "passedCases": 0,
        "failedCase": None,
        "failedCaseName": None,
        "failedCaseCategory": None,
        "caseResults": [],
        "failure": None,
        "error": None,
    }
    # A record with no attempted case still states what it did not cover. The plan
    # existed (all required cases) and none of it ran, so the coverage is explicit
    # rather than implied by the absence of a pass.
    record["coverage"] = coverage if coverage is not None else _coverage(
        required=required, planned=required, executed=0, passed=0,
        skipped_reason=skipped_reason, prefix=prefix or _prefix_plan())
    return record


def _validate_prefix_spec(correctness_spec, required):
    """The declared prefix must be a list of non-empty frozen case names.

    ``None`` (absent) is the rollback path and stays valid. Any other shape is a
    malformed contract from the declaring side, never a silent fallback to the
    default order: a typo that quietly disables the prefix would look like a
    passing pre-test while measuring nothing.
    """
    declared = correctness_spec.get("prefix")
    if declared is None:
        return None

    def invalid(message):
        return PrefixContractError(message, coverage=_coverage(
            required=required, planned=required, executed=0, passed=0,
            skipped_reason="prefix_invalid", prefix=_prefix_plan(source="not_evaluated")))

    if isinstance(declared, str) or not isinstance(declared, (list, tuple)):
        raise invalid(f"testSpec.correctness.prefix must be a list of frozen case names, got {type(declared).__name__}")
    names = []
    for item in declared:
        if not isinstance(item, str) or not item.strip():
            raise invalid(f"testSpec.correctness.prefix entries must be non-empty case names, got {item!r}")
        names.append(item.strip())
    return names


def _plan_correctness_cases(generated_cases, correctness_spec, pretest_enabled=True):
    """Order the trusted cases so the declared prefix runs first.

    A prefix is a **reordering, never a filter**: every case the contract requires is
    still planned and still required for a pass, so a prefix can only make a failure
    arrive earlier, never make an incomplete measurement look complete. An absent or
    empty prefix keeps the oracle's own order exactly, which is the rollback path.

    Names are resolved against the frozen oracle's list; a declared name the oracle
    does not provide is a contract failure on the trusted side. Repeated names are
    deduplicated so no case is ever executed twice.

    The declared shape is always validated, even when the pre-test is switched off: a
    malformed declaration is a real contract defect and must not be masked by the
    switch. Name resolution, by contrast, only applies when the prefix is actually
    honoured, so switching the pre-test off remains a working escape hatch even if a
    profile ships a case name that does not exist.
    """
    names = _validate_prefix_spec(correctness_spec, len(generated_cases))
    if not names:
        return list(generated_cases), _prefix_plan(source="none")
    if not pretest_enabled:
        return list(generated_cases), _prefix_plan(source="disabled")
    by_name = {}
    for case in generated_cases:
        by_name.setdefault(str(case["name"]), case)
    ordered, seen = [], set()
    for name in names:
        if name in seen:
            continue
        case = by_name.get(name)
        if case is None:
            raise PrefixContractError(
                f"frozen correctness prefix names a case the oracle does not provide: {name}",
                missing=[name],
                coverage=_coverage(
                    required=len(generated_cases), planned=len(generated_cases), executed=0, passed=0,
                    skipped_reason="prefix_case_missing",
                    prefix=_prefix_plan(size=len(ordered), source="frozen",
                                        names=[str(item["name"]) for item in ordered])))
        seen.add(name)
        ordered.append(case)
    remaining = [case for case in generated_cases if str(case["name"]) not in seen]
    return ordered + remaining, _prefix_plan(
        size=len(ordered), source="frozen", names=[str(case["name"]) for case in ordered])


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


def _failed_correctness(*, total, planned, prefix, prefix_size, index, name, category, code, role, message, dtype_name, metrics, details, cache_stats, started):
    """Preserve the attempted prefix and attach the same typed first failure everywhere.

    ``skippedReason`` distinguishes a failure inside the pre-test from one after it
    passed: the same aborted run means something different to the reader depending on
    which side of the prefix it happened.
    """
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
    in_prefix = bool(prefix_size) and index < prefix_size
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
        "coverage": _coverage(
            required=total, planned=planned, executed=index + 1, passed=index,
            skipped_reason="prefix_failed" if in_prefix else "suffix_failed",
            prefix={**prefix, "passed": None if not prefix_size else not in_prefix}),
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
        # Normalize each nonzero vector's scale first. cosine_similarity's fixed
        # epsilon otherwise makes even identical tiny outputs look unrelated.
        # Float32 norm accumulation can exceed a 1e-5 cosine threshold even
        # when comparing a long vector with itself. Diagnose in float64.
        actual_cos, expected_cos = actual_float.double(), expected_float.double()
        actual_scale = float(actual_cos.abs().max().item())
        expected_scale = float(expected_cos.abs().max().item())
        if not math.isfinite(actual_scale) or not math.isfinite(expected_scale):
            raise ValueError("cosine comparison requires finite outputs")
        if actual_scale == 0.0 or expected_scale == 0.0:
            return 0.0 if actual_scale == expected_scale else 1.0
        cosine = torch.nn.functional.cosine_similarity(
            (actual_cos / actual_scale).flatten(), (expected_cos / expected_scale).flatten(), dim=0)
        return max(0.0, float(1.0 - cosine.abs().item()))

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


def _run_correctness(module, torch, cases, atol, rtol, test_spec=None, oracle_module=None, reference_cache=None, pretest_enabled=True):
    started = time.perf_counter()
    oracle = oracle_module or module
    correctness_spec = (test_spec or {}).get("correctness") or {}
    generated_cases = _named_cases(oracle, cases, test_spec)
    # The declared prefix reorders the trusted case list; it never removes a case.
    planned_cases, prefix_plan = _plan_correctness_cases(generated_cases, correctness_spec, pretest_enabled)
    planned_count = len(planned_cases)
    prefix_size = int(prefix_plan["size"])
    details = []
    cache_stats = {"schemaVersion": "operator-studio.correctness-reference-cache/v1", "enabled": bool(reference_cache), "hits": 0, "misses": 0}
    dtype_tolerance = correctness_spec.get("dtypeTolerance") or {}
    tensor_contract = correctness_spec.get("tensors") if isinstance(correctness_spec.get("tensors"), dict) else None
    cos_limit = float(correctness_spec.get("requireCosDiffBelow") or 1e-5)
    tensor_type = getattr(torch, "Tensor", ())

    def failed_now(**kwargs):
        """Terminal failure record that always carries this run's real coverage."""
        return _failed_correctness(
            total=cases, planned=planned_count, prefix=prefix_plan, prefix_size=prefix_size,
            details=details, cache_stats=cache_stats, started=started, **kwargs)

    for index, case in enumerate(planned_cases):
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
            return failed_now(
                index=index, name=name, category=category,
                code="OPERATOR_ORACLE_EXCEPTION", role="oracle", message=str(error),
                dtype_name=dtype_name, metrics=None)
        # The baseline case must have the declared dtypes and shapes: otherwise
        # the declaration and the oracle disagree, which no candidate can fix.
        bound_dims = {}
        if tensor_contract is not None:
            try:
                bound_dims = _check_case_inputs(inputs, tensor_contract)
            except InputContractError as error:
                return failed_now(
                    index=index, name=name, category=category,
                    code="OPERATOR_INPUT_CONTRACT_MISMATCH", role="oracle", message=str(error),
                    dtype_name=dtype_name, metrics=None)
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
                return failed_now(
                    index=index, name=name, category=category,
                    code="OPERATOR_REFERENCE_CACHE_FAILURE", role="backend", message=str(error),
                    dtype_name=dtype_name, metrics=None)
        if expected is None:
            # An oracle reference throw keeps the attempted case and role=oracle,
            # but is never learnable as an operator failure.
            try:
                expected = oracle.reference(inputs)
            except Exception as error:
                return failed_now(
                    index=index, name=name, category=category,
                    code="OPERATOR_ORACLE_EXCEPTION", role="oracle", message=str(error),
                    dtype_name=dtype_name, metrics=None)
            if cache_file is not None:
                try:
                    _save_reference_cache(torch, cache_file, expected)
                except Exception as error:
                    return failed_now(
                        index=index, name=name, category=category,
                        code="OPERATOR_REFERENCE_CACHE_FAILURE", role="backend", message=str(error),
                        dtype_name=dtype_name, metrics=None)
        # A throwing candidate.run was still attempted for this named case (never not_run)
        # and its uncomputed numeric diagnostics stay null, never a fabricated 0.
        before = _input_signature(inputs, torch) if tensor_contract is not None else None
        try:
            actual = module.run(inputs)
            _sync(torch)
        except Exception as error:
            return failed_now(
                index=index, name=name, category=category,
                code="OPERATOR_CANDIDATE_EXCEPTION", role="candidate", message=str(error),
                dtype_name=dtype_name, metrics=None)
        if tensor_contract is not None:
            # Declared-contract breaches are the candidate correctness failures.
            if _input_signature(inputs, torch) != before:
                problem = "input_mutated: run(inputs) modified its inputs"
            else:
                problem = _output_contract_problem(actual, tensor_contract, bound_dims)
            if problem:
                return failed_now(
                    index=index, name=name, category=category,
                    code="OPERATOR_CORRECTNESS_MISMATCH", role="candidate", message=problem,
                    dtype_name=dtype_name, metrics=None)
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
            if correctness_spec.get('toleranceScope') == 'output-dtype':
                _assert_output_close(torch, actual, expected, atol, rtol, dtype_tolerance, cos_limit)
            else:
                _assert_close(torch, actual, expected, case_atol, case_rtol)
            if metrics is not None and metrics["cosDiff"] >= cos_limit:
                raise AssertionError(f"cos_diff {metrics['cosDiff']} is not below {cos_limit}")
        except Exception as error:
            return failed_now(
                index=index, name=name, category=category,
                code="OPERATOR_CORRECTNESS_MISMATCH", role="candidate", message=str(error),
                dtype_name=dtype_name, metrics=metrics)
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
        # The oracle's own declared order, which the declared prefix reorders for
        # execution only. The real execution order is caseResults' order.
        "caseNames": [str(case["name"]) for case in generated_cases],
        "caseResults": details,
        "coverage": _coverage(
            required=cases, planned=planned_count, executed=planned_count, passed=planned_count,
            skipped_reason=None, prefix={**prefix_plan, "passed": True if prefix_size else None}),
        "referenceCache": cache_stats,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
    }


def _percentile(samples, fraction):
    if not samples:
        return None
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, math.floor((len(ordered) - 1) * fraction))]


# The settling rule's policy. The contract that declares it and the reasoning behind
# both numbers live in `client-runtime/test-spec.mjs`; these are only the fallbacks for
# a matrix that declares neither, so the two sides cannot disagree about the defaults.
DEFAULT_SETTLE_TOLERANCE = 0.02
DEFAULT_MAX_SETTLEMENTS = 8


def _settle_measurements(sample_settlement, tolerance, max_settlements):
    """Take whole settlements of one profile until two consecutive ones agree.

    `sample_settlement` performs one full settlement (its own warmup, then the
    declared repeats) and returns that settlement's stats. The scored value is the
    last settlement taken.

    Reaching the cap without agreement is reported rather than silently accepted:
    returns ``(stats, settled, settlements)`` with ``settled=False``, which the result
    records so the Accept Gate can refuse to read an unstable number as "no gain".

    The tolerance is relative to the smaller of the two readings, so "do these two
    agree" cannot depend on which of them was measured first. A non-positive reading
    never settles: the comparison is relative, and zero is not a magnitude to measure
    a relative difference against.
    """
    tolerance = float(tolerance) if tolerance is not None else DEFAULT_SETTLE_TOLERANCE
    previous = None
    stats = None
    settlements = 0
    for _ in range(max(1, int(max_settlements))):
        stats = sample_settlement()
        settlements += 1
        current = float(stats["p50Us"])
        baseline = min(previous, current) if previous is not None else 0.0
        if baseline > 0 and abs(current - previous) <= tolerance * baseline:
            return stats, True, settlements
        previous = current
    return stats, False, settlements


def _benchmark(module, torch, warmup, repeats):
    return _benchmark_inputs(module, torch, [{"name": "primary", "inputs": module.get_inputs()}], warmup, repeats)[0]


def _benchmark_inputs(module, torch, profiles, warmup, repeats, oracle_module=None, *,
                      settle_tolerance=DEFAULT_SETTLE_TOLERANCE,
                      max_settlements=DEFAULT_MAX_SETTLEMENTS):
    results = []
    for profile in profiles:
        inputs = profile.get("inputs") if "inputs" in profile else profile["make_inputs"]()
        reference = _benchmark_one(
            oracle_module, torch, inputs, warmup, repeats,
            settle_tolerance=settle_tolerance, max_settlements=max_settlements,
        ) if oracle_module else None
        result = _benchmark_one(
            module, torch, inputs, warmup, repeats,
            settle_tolerance=settle_tolerance, max_settlements=max_settlements,
        )
        results.append({
            "profile": profile["name"],
            **result,
            "referenceP50Us": reference["p50Us"] if reference else None,
            "speedup": (reference["p50Us"] / result["p50Us"]) if reference and result["p50Us"] > 0 else None,
        })
    return results


def _benchmark_one(module, torch, inputs, warmup, repeats, *,
                   settle_tolerance=DEFAULT_SETTLE_TOLERANCE,
                   max_settlements=DEFAULT_MAX_SETTLEMENTS):
    import triton

    def settle_once():
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

    stats, settled, settlements = _settle_measurements(settle_once, settle_tolerance, max_settlements)
    return {**stats, "settled": settled, "settlements": settlements}


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
    declared = ((test_spec or {}).get("benchmark") or {}).get("shapes")
    if declared:
        # Frozen shapes are materialized once here so the measured inputs are the
        # checked ones; a callable factory would otherwise be free to differ.
        by_name = {str(shape["name"]): shape for shape in declared}
        normalized = [
            {**item, "inputs": item["inputs"] if "inputs" in item else item["make_inputs"]()}
            for item in normalized
        ]
        for item in normalized:
            shape = by_name.get(str(item["name"]))
            if shape is not None:
                _check_declared_shape(item["name"], item["inputs"], shape.get("inputShapes") or {})
    tensors = ((test_spec or {}).get("correctness") or {}).get("tensors")
    if isinstance(tensors, dict):
        for item in normalized:
            if "inputs" in item:
                try:
                    _check_case_inputs(item["inputs"] if isinstance(item["inputs"], dict) else {}, tensors)
                except InputContractError as error:
                    raise BenchmarkShapeError("benchmark profile " + str(item["name"]) + ": " + str(error)) from error
    return normalized


class BenchmarkShapeError(RuntimeError):
    """A benchmark profile's inputs do not have the frozen declared shape."""


def _declared_shape_of(value):
    """Shape of a tensor-like (``.shape``) or a rectangular nested list; None otherwise."""
    shape = getattr(value, "shape", None)
    if shape is not None:
        return [int(item) for item in shape]
    if type(value) not in (list, tuple):
        return None
    if not value:
        return [0]
    inner = [_declared_shape_of(item) if type(item) in (list, tuple) else [] for item in value]
    if any(item is None or item != inner[0] for item in inner):
        return None
    return [len(value), *inner[0]]


def _check_declared_shape(name, inputs, expected):
    if not isinstance(inputs, dict):
        raise BenchmarkShapeError(f"benchmark profile {name} inputs must be a mapping to check declared shapes")
    for tensor, dims in expected.items():
        if tensor not in inputs:
            raise BenchmarkShapeError(f"benchmark profile {name} is missing declared input {tensor}")
        actual = _declared_shape_of(inputs[tensor])
        if actual != [int(item) for item in dims]:
            raise BenchmarkShapeError(f"benchmark profile {name} input {tensor} has shape {actual}, declared {list(dims)}")


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
        # errors="replace"：外部工具的输出编码不归我们管（中文区域下 MSVC 类工具可能吐 GBK）。
        # 输出只是证据，读不出来时退化成替换字符，不该让一次工具调用变成宿主崩溃。
        process = subprocess.run(command, shell=True, capture_output=True, text=True, errors="replace", timeout=300, check=False)
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

    def persist_failure(code, message, phase, role, *, correctness=None, hardware=None, total=0,
                        coverage=None, skipped_reason="not_run"):
        """Persist a structured terminal failure atomically instead of only stderr."""
        error = _typed_error(code, message, phase, role)
        terminal = correctness if correctness is not None else _not_run_correctness(
            total, skipped_reason=skipped_reason, coverage=coverage)
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
        pretest_enabled = _pretest_enabled()
    except Exception as error:
        persist_failure("OPERATOR_PRETEST_CONFIG_INVALID", str(error), "preflight", "backend")
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
        # The declared settling policy for the measured profiles. A matrix that does
        # not declare one falls back to the frozen defaults rather than to "no
        # settling", so an older mission cannot silently measure without it.
        settle_tolerance = matrix.get("settleTolerance")
        settle_tolerance = (float(settle_tolerance)
                            if isinstance(settle_tolerance, (int, float)) and 0 < float(settle_tolerance) < 1
                            else DEFAULT_SETTLE_TOLERANCE)
        max_settlements = matrix.get("maxSettlements")
        max_settlements = (int(max_settlements)
                           if isinstance(max_settlements, (int, float)) and int(max_settlements) > 0
                           else DEFAULT_MAX_SETTLEMENTS)
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
        # The declared prefix is validated with the rest of the spec: a malformed
        # prefix is a typed contract failure, never a silent fallback to the default
        # order that would look like a passing pre-test while measuring nothing.
        _validate_prefix_spec(correctness_spec, correctness_cases)
        _validate_tensor_spec(correctness_spec)
    except PrefixContractError as error:
        persist_failure("OPERATOR_CORRECTNESS_PREFIX_INVALID", str(error), "preflight", "contract",
                        total=correctness_cases, coverage=error.coverage, skipped_reason="prefix_invalid")
        raise
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
        correctness = _run_correctness(module, torch, correctness_cases, atol, rtol, test_spec, oracle_module, reference_cache, pretest_enabled)
    except PrefixContractError as error:
        # The prefix and the case names are both trusted-side facts, so a prefix that
        # names an absent case is a contract failure on the oracle side: no case is
        # attempted, nothing is learnable, and no candidate repair attempt is due.
        persist_failure("OPERATOR_PREFIX_CASE_MISSING", str(error), "correctness", "oracle",
                        total=correctness_cases, hardware=hardware, coverage=error.coverage,
                        skipped_reason="prefix_case_missing")
        raise
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
        benchmark_results = _benchmark_inputs(
            module, torch, benchmark_profiles, warmup, repeats, oracle_module,
            settle_tolerance=settle_tolerance, max_settlements=max_settlements,
        )
    except BenchmarkShapeError as error:
        # The baseline's own inputs contradict the frozen spec: an oracle contract
        # failure, never a verdict on the candidate.
        failure = _typed_error("OPERATOR_BENCHMARK_SHAPE_MISMATCH", str(error), "benchmark", "oracle")
        environment = _environment_record(task, matrix, hardware=hardware, diagnostics_mode=diagnostics_mode)
        record = _failed_result(task, failure, correctness, environment)
        _write_json_atomic(result_json, record)
        raise
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
            # Whether this reading reached a settled value, and how many whole
            # settlements it took. `settled: false` is a report that the number is
            # not evidence of anything, and the Accept Gate refuses to score it.
            "settled": benchmark.get("settled"),
            "settlements": benchmark.get("settlements"),
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
