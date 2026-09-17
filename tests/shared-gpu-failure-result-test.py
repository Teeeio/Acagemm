"""Hardware-free acceptance for typed failed-execution results in both runners.

Authority: docs/development/FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md (frozen).
This test drives the real ``main`` entry points of
``tools/local-c500-runner.py`` and ``tools/local-shared-gpu-runner.py`` with real
temporary candidate/oracle module files. Only the hardware boundaries are
doubles: ``torch``/CUDA, the ``mx-smi``/``nvidia-smi`` probe (module-level
``subprocess``/``shutil`` doubles, the same technique as
``tests/shared-gpu-target-probe-test.mjs``) and the Triton-only base benchmark
timer. No GPU, driver, nvidia-smi, triton or network call is executed, and the
shared runner's own probe/benchmark code still runs against the doubles.

Fixture identity is fixed: missionId MIS_FAILURE_ACCEPTANCE, candidateId
candidate-failed, runId request-failed, and task.payload agrees with the
top-level task fields. Every run works in its own OS temporary directory; the
production default data/bridge directories are never touched.

HARDWARE DOUBLE, not live evidence: the probe values below (the RTX 3060 /
551.78 / sm86 record and the MetaX C550 name) are inputs to the runners' real
probe parsers. They are not a GPU sample, a driver observation or a stability
claim. No GPU, driver, nvidia-smi, torch install or model is present or called.

Expected current state: red. The frozen producer contract is not implemented
yet, so the failed cases below reproduce the real defects the upstream freeze
names. The test is deliberately not weakened to pass on the pre-fix tree. Every
base failure branch must persist a structured result.json, and the terminal
correctness.json/result.json writes are monitored at their real final paths so
that an atomic write followed by a plain overwrite still fails the case.
"""

from __future__ import annotations

import builtins
import contextlib
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

# The test is run as a script; never leave __pycache__ behind anywhere.
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
BASE_RUNNER_PATH = ROOT / "tools" / "local-c500-runner.py"
SHARED_RUNNER_PATH = ROOT / "tools" / "local-shared-gpu-runner.py"
CONTRACT_PATH = ROOT / "docs" / "development" / "FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md"
CONTRACT_SHA256 = "55727780c161a2068b27702339df702737d9eaed78e5c2c29d6a1d72b182fbbb"

MISSION_ID = "MIS_FAILURE_ACCEPTANCE"
CANDIDATE_ID = "candidate-failed"
REQUEST_ID = "request-failed"
PATCH_DIGEST = "1" * 64
PACKAGE_DIGEST = "2" * 64
ENVIRONMENT_DIGEST = "3" * 64
ACCEPTANCE_DIGEST = "4" * 64
PREPARED_ARTIFACT_DIGEST = "5" * 64
CORRECTNESS_CASES = 4
REQUIRED_CATEGORIES = ["minimal", "representative", "boundary", "ragged"]
BENCHMARK_PROFILES = ["primary", "secondary"]

MISMATCH_FIRST_CASE = [1.0, 2.0]
MISMATCH_LATER_CASE = [5.0, 6.0]
THROWING_CASE = [3.0, 4.0]

# The exact task.payload package binding a failed execution must retain.
ADMISSION_ID = "admission-failure-acceptance"
WORKSPACE_ID = "workspace-failure-acceptance"
BUILD_ID = "build-failure-acceptance"
TARGET_ID = "local-shared-gpu"
ADAPTER_ID = "shared-gpu"
EXPECTED_EXECUTION_PACKAGE = {
    "packageDigest": PACKAGE_DIGEST,
    "admissionId": ADMISSION_ID,
    "preparedArtifactDigest": PREPARED_ARTIFACT_DIGEST,
    "environmentDigest": ENVIRONMENT_DIGEST,
    "acceptanceDigest": ACCEPTANCE_DIGEST,
    "workspaceId": WORKSPACE_ID,
    "target": TARGET_ID,
    "build": BUILD_ID,
    "adapter": ADAPTER_ID,
}

# Real error text the typed failure must still carry (never a generic wording).
REAL_MISMATCH_TEXT = "not close"
REAL_CANDIDATE_TEXT = "addcmul"
REAL_ORACLE_TEXT = "oracle reference failed"
REAL_BENCHMARK_TEXT = "simulated benchmark stage failure"

# HARDWARE DOUBLE (not a live sample): recorded real-world values used only so
# the shared adapter's real nvidia-smi parser is exercised.
GPU_LINE = "NVIDIA GeForce RTX 3060 Laptop GPU, 551.78, 6144"

# Identity recap for the registration manifest; fixtures declare it explicitly.
FIXTURES = {
    "missionId": MISSION_ID,
    "candidateId": CANDIDATE_ID,
    "runId": REQUEST_ID,
    "correctnessCases": CORRECTNESS_CASES,
    "requiredCategories": REQUIRED_CATEGORIES,
    "benchmarkProfiles": BENCHMARK_PROFILES,
    "candidateFile": "candidate_prepared.py",
    "oracleFile": "oracle_prepared.py",
}


# ---------------------------------------------------------------------------
# Hardware doubles: torch/CUDA and the driver probe.
# ---------------------------------------------------------------------------


class FakeTensor:
    """Minimal tensor double covering exactly the numeric calls the runner makes."""

    def __init__(self, values, dtype="torch.float32"):
        self._values = [float(value) for value in values]
        self.dtype = dtype
        self.shape = (len(self._values),)

    def tolist(self):
        return list(self._values)

    def is_floating_point(self):
        return self.dtype.startswith("torch.float")

    def float(self):
        return FakeTensor(self._values)

    def flatten(self):
        return FakeTensor(self._values)

    def abs(self):
        return FakeTensor([abs(value) for value in self._values])

    def square(self):
        return FakeTensor([value * value for value in self._values])

    def numel(self):
        return len(self._values)

    def item(self):
        if len(self._values) != 1:
            raise RuntimeError("item() requires a single element")
        return self._values[0]

    def max(self):
        return FakeTensor([max(self._values)] if self._values else [0.0])

    def __sub__(self, other):
        return FakeTensor([left - right for left, right in zip(self._values, other._values)])


def _fake_sqrt(tensor):
    return FakeTensor([math.sqrt(value) for value in tensor.tolist()])


def _fake_mean(tensor):
    values = tensor.tolist()
    return FakeTensor([sum(values) / len(values)] if values else [0.0])


def _fake_cosine_similarity(left, right, dim=0, eps=1e-8):
    left_values, right_values = left.tolist(), right.tolist()
    dot = sum(a * b for a, b in zip(left_values, right_values))
    left_norm = math.sqrt(sum(a * a for a in left_values))
    right_norm = math.sqrt(sum(b * b for b in right_values))
    cosine = 0.0 if left_norm == 0.0 or right_norm == 0.0 else dot / (left_norm * right_norm)
    return FakeTensor([cosine])


def _fake_assert_close(actual, expected, atol, rtol):
    if not isinstance(actual, FakeTensor) or not isinstance(expected, FakeTensor):
        raise AssertionError("the tensor double only compares FakeTensor values")
    if actual.shape != expected.shape:
        raise AssertionError(f"shape mismatch: {actual.shape} vs {expected.shape}")
    for index, (left, right) in enumerate(zip(actual.tolist(), expected.tolist())):
        if abs(left - right) > atol + rtol * abs(right):
            raise AssertionError(
                f"Tensor-likes are not close at element {index}: {left} vs {right} (atol={atol}, rtol={rtol})"
            )


class FakeEvent:
    def __init__(self, enable_timing=False):
        self.enable_timing = enable_timing

    def record(self):
        return None

    def synchronize(self):
        return None

    def elapsed_time(self, other):
        return 0.5


def _build_torch_double():
    module = types.ModuleType("torch")
    module.__version__ = "2.6.0-test-double"
    module.version = types.SimpleNamespace(cuda="12.4")
    module.Tensor = FakeTensor
    module.uint8 = "uint8"
    module.sqrt = _fake_sqrt
    module.mean = _fake_mean
    module.tensor = lambda values: FakeTensor(values)
    module.testing = types.SimpleNamespace(assert_close=_fake_assert_close)
    module.nn = types.SimpleNamespace(functional=types.SimpleNamespace(cosine_similarity=_fake_cosine_similarity))
    module.cuda = types.SimpleNamespace(
        is_available=lambda: True,
        current_device=lambda: 0,
        synchronize=lambda: None,
        get_device_name=lambda device=0: "MetaX C550",
        Event=FakeEvent,
    )
    return module


TORCH_DOUBLE = _build_torch_double()
sys.modules["torch"] = TORCH_DOUBLE
# Candidate/oracle modules import the same tensor double by name.
sys.modules["_dispatch_fake_torch"] = TORCH_DOUBLE


def fake_base_probe(torch_double, device):
    return {
        "tool": "/fake/mx-smi",
        "deviceIndex": int(device),
        "deviceName": "MetaX C550",
        "torchVersion": torch_double.__version__,
        "mxSmi": "mx-smi version: test-double\nDriver Version: 000.000",
    }


def fake_base_benchmark(module, torch_double, inputs, warmup, repeats):
    return {"p50Us": 100.0, "p95Us": 120.0, "minUs": 80.0, "maxUs": 130.0, "warmup": warmup, "samples": repeats}


def exploding_benchmark(*args, **kwargs):
    raise RuntimeError("simulated benchmark stage failure")


def _completed(command, returncode, stdout, stderr):
    return subprocess.CompletedProcess(args=command, returncode=returncode, stdout=stdout, stderr=stderr)


def _query_of(command):
    return next((str(part) for part in command if str(part).startswith("--query-gpu=")), "")


def fake_nvidia_run(command, **kwargs):
    if "compute_cap" in _query_of(command):
        return _completed(command, 0, "8.6\n", "")
    return _completed(command, 0, GPU_LINE + "\n", "")


def failing_nvidia_run(command, **kwargs):
    return _completed(command, 1, "", "simulated nvidia-smi failure")


# ---------------------------------------------------------------------------
# Real temporary candidate/oracle modules and task fixture.
# ---------------------------------------------------------------------------

OPERATOR_TEMPLATE = '''\
from _dispatch_fake_torch import tensor

MISMATCH_ON = __MISMATCH_ON__
FAIL_RUN_ON = __FAIL_RUN_ON__
FAIL_REFERENCE_ON = __FAIL_REFERENCE_ON__

CASES = [
    {"name": "case-1", "category": "minimal", "inputs": {"value": tensor([1.0, 2.0])}},
    {"name": "case-2", "category": "representative", "inputs": {"value": tensor([3.0, 4.0])}},
    {"name": "case-3", "category": "boundary", "inputs": {"value": tensor([5.0, 6.0])}},
    {"name": "case-4", "category": "ragged", "inputs": {"value": tensor([7.0, 8.0])}},
]


def get_inputs():
    return {"value": tensor([1.0, 2.0])}


def get_test_cases():
    return [
        {"name": case["name"], "category": case["category"], "inputs": {"value": tensor(case["inputs"]["value"].tolist())}}
        for case in CASES
    ]


def get_benchmark_inputs():
    return [
        {"name": "primary", "inputs": {"value": tensor([1.0, 2.0])}},
        {"name": "secondary", "inputs": {"value": tensor([9.0, 10.0])}},
    ]


def _double(values):
    return tensor([value * 2.0 for value in values])


def run(inputs):
    values = inputs["value"].tolist()
    if FAIL_RUN_ON is not None and values == FAIL_RUN_ON:
        raise TypeError("addcmul(): argument 'tensor2' (position 1) must be Tensor, not float")
    if MISMATCH_ON is not None and values == MISMATCH_ON:
        return tensor([-value for value in values])
    return _double(values)


def reference(inputs):
    values = inputs["value"].tolist()
    if FAIL_REFERENCE_ON is not None and values == FAIL_REFERENCE_ON:
        raise RuntimeError("oracle reference failed: simulated input-generation error")
    return _double(values)
'''


def operator_source(*, mismatch_on=None, fail_run_on=None, fail_reference_on=None):
    source = OPERATOR_TEMPLATE
    source = source.replace("__MISMATCH_ON__", repr(mismatch_on))
    source = source.replace("__FAIL_RUN_ON__", repr(fail_run_on))
    source = source.replace("__FAIL_REFERENCE_ON__", repr(fail_reference_on))
    return source


def task_fixture():
    candidate = {"id": CANDIDATE_ID, "digest": PATCH_DIGEST, "sourceRunId": "candidate-source-run"}
    payload = {
        "missionId": MISSION_ID,
        "requestId": REQUEST_ID,
        "candidate": dict(candidate),
        **EXPECTED_EXECUTION_PACKAGE,
    }
    return {
        "taskId": "benchmark-task-failure-acceptance",
        "requestId": REQUEST_ID,
        "missionId": MISSION_ID,
        "candidate": dict(candidate),
        "hardware": ["local-shared-gpu"],
        "metric": "latency_p50",
        "runPySource": CANDIDATE_ID,
        "matrix": {
            "profileId": "failure-acceptance-profile",
            "correctnessCases": CORRECTNESS_CASES,
            "warmup": 1,
            "repeats": 2,
            "environments": ["local-shared-gpu"],
            "testSpec": {
                "correctness": {"requiredCategories": list(REQUIRED_CATEGORIES), "atol": 1e-3, "rtol": 1e-3},
                "benchmark": {"requiredProfiles": list(BENCHMARK_PROFILES), "primaryProfile": "primary"},
            },
        },
        "payload": payload,
    }


def prepare_task(task_dir, *, mismatch_on=None, fail_run_on=None, fail_reference_on=None):
    oracle_path = task_dir / FIXTURES["oracleFile"]
    candidate_path = task_dir / FIXTURES["candidateFile"]
    oracle_path.write_text(
        operator_source(fail_reference_on=fail_reference_on), encoding="utf-8")
    candidate_path.write_text(
        operator_source(mismatch_on=mismatch_on, fail_run_on=fail_run_on), encoding="utf-8")
    (task_dir / "task.json").write_text(
        json.dumps(task_fixture(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"task_dir": task_dir, "oracle": oracle_path, "candidate": candidate_path}


# ---------------------------------------------------------------------------
# Harness helpers.
# ---------------------------------------------------------------------------

ENV_KEYS = [
    "OPERATOR_LOCAL_C500_TASK_DIR",
    "OPERATOR_LOCAL_C500_RESULT_JSON",
    "OPERATOR_LOCAL_C500_RUN_PY",
    "OPERATOR_LOCAL_C500_ORACLE_RUN_PY",
    "OPERATOR_LOCAL_C500_TASK_JSON",
    "OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR",
    "OPERATOR_GPU_NVIDIA_SMI",
    "OPERATOR_DIAGNOSTICS_MODE",
]


def load_module(name, path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def run_environment(paths, *, nvidia_smi="/fake/nvidia-smi"):
    saved = {key: os.environ.get(key) for key in ENV_KEYS}
    task_dir = paths["task_dir"]
    os.environ["OPERATOR_LOCAL_C500_TASK_DIR"] = str(task_dir)
    os.environ["OPERATOR_LOCAL_C500_TASK_JSON"] = str(task_dir / "task.json")
    os.environ["OPERATOR_LOCAL_C500_RESULT_JSON"] = str(task_dir / "result.json")
    os.environ["OPERATOR_LOCAL_C500_RUN_PY"] = str(paths["candidate"])
    os.environ["OPERATOR_LOCAL_C500_ORACLE_RUN_PY"] = str(paths["oracle"])
    # An explicit mock mode guarantees no real diagnostic tool is invoked.
    os.environ["OPERATOR_DIAGNOSTICS_MODE"] = "mock"
    os.environ.pop("OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR", None)
    if nvidia_smi is None:
        os.environ.pop("OPERATOR_GPU_NVIDIA_SMI", None)
    else:
        os.environ["OPERATOR_GPU_NVIDIA_SMI"] = nvidia_smi
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextlib.contextmanager
def argv(values):
    saved = sys.argv
    sys.argv = list(values)
    try:
        yield
    finally:
        sys.argv = saved


def run_base(paths, *, probe=None, benchmark=None, module_name="base_runner_under_test"):
    base = load_module(module_name, BASE_RUNNER_PATH)
    base._probe_c550 = probe or fake_base_probe
    base._benchmark_one = benchmark or fake_base_benchmark
    with run_environment(paths), argv(["local-c500-runner.py"]):
        return base.main()


def run_shared(paths, *, probe_run=None, benchmark=None, nvidia_smi="/fake/nvidia-smi",
               module_name="shared_runner_under_test"):
    shared = load_module(module_name, SHARED_RUNNER_PATH)
    # Explicit probe doubles on the adapter module, exactly like the existing
    # shared-gpu-target-probe-test; the adapter's real probe code still runs.
    shared.subprocess = types.SimpleNamespace(run=probe_run or fake_nvidia_run)
    shared.shutil = types.SimpleNamespace(which=lambda name: None)
    base = load_module(module_name + "_base", BASE_RUNNER_PATH)
    shared._load_base = lambda: base
    if benchmark is not None:
        shared._benchmark_one = benchmark
    with run_environment(paths, nvidia_smi=nvidia_smi), argv(["local-shared-gpu-runner.py"]):
        return shared.main()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


def expect_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def expect_typed_error(record, *, code, phase, role, label, real_error_text=None):
    expect(isinstance(record, dict), f"{label} must be a typed error object, got {record!r}")
    if code is None:
        expect(isinstance(record.get("code"), str) and record["code"].strip(),
               f"{label}.code must be a non-empty neutral code, got {record.get('code')!r}")
    else:
        expect_equal(record.get("code"), code, f"{label}.code")
    expect_equal(record.get("phase"), phase, f"{label}.phase")
    expect_equal(record.get("role"), role, f"{label}.role")
    expect_equal(record.get("retryable"), False, f"{label}.retryable")
    expect(isinstance(record.get("message"), str) and record["message"].strip(),
           f"{label}.message must be a non-empty string")
    if real_error_text is not None:
        expect(real_error_text in record["message"],
               f"{label}.message must carry the real error text {real_error_text!r}, got {record['message']!r}")
    expect("details" in record, f"{label}.details must be present")


def expect_failed_result_envelope(task_dir, *, code, phase, role, real_error_text, correctness_status, label):
    """Every failed execution must persist a structured, consistent result.json.

    Only a failed correctness carries the typed first failure in three places:
    ``result.error``, ``result.correctness.failure`` and the final failed case's
    ``failure`` must be the same typed value, and ``correctness.error`` and the
    final case's ``error`` must be the real (non-generic) message strings. A
    benchmark-stage exception preserves the already observed passed correctness,
    so there the result error stays benchmark-phase/backend while
    ``correctness.failure``/``correctness.error`` remain null/absent and are
    never populated from ``result.error``.
    """
    result_path = task_dir / "result.json"
    expect(result_path.is_file(), f"{label}: a failed execution must persist result.json, not leave only stderr")
    result = read_json(result_path)
    expect_equal(result.get("status"), "failed", f"{label}: result.status")
    expect_equal(result.get("benchmark"), [], f"{label}: a failed execution must never keep a benchmark row")
    expect_equal(result.get("publishable"), False, f"{label}: failed result.publishable")
    environment = result.get("environment")
    expect(isinstance(environment, dict) and environment,
           f"{label}: the result environment must retain the real probe record")
    failure = result.get("error")
    expect_typed_error(failure, code=code, phase=phase, role=role, label=f"{label}: result.error",
                       real_error_text=real_error_text)
    correctness = result.get("correctness")
    expect(isinstance(correctness, dict), f"{label}: result.correctness must be the typed correctness object")
    expect_equal(correctness.get("status"), correctness_status, f"{label}: result.correctness.status")
    expect_equal(correctness.get("total"), CORRECTNESS_CASES,
                 f"{label}: the requested total must survive into result.correctness")
    file_correctness = read_json(task_dir / "correctness.json")
    expect_equal(file_correctness.get("status"), correctness_status,
                 f"{label}: correctness.json and result.correctness must agree on status")
    for key in ("total", "executedCases", "passedCases", "failedCase", "failedCaseName", "failure"):
        expect_equal(file_correctness.get(key), correctness.get(key),
                     f"{label}: correctness.json.{key} must agree with result.correctness.{key}")
    if correctness_status == "failed":
        expect_equal(correctness.get("failure"), failure,
                     f"{label}: result.error and result.correctness.failure must be the same typed first failure")
        correctness_error = correctness.get("error")
        expect(isinstance(correctness_error, str) and real_error_text in correctness_error,
               f"{label}: result.correctness.error must be the real message string carrying "
               f"{real_error_text!r}, got {correctness_error!r}")
        cases = correctness.get("caseResults") or []
        expect(cases, f"{label}: a failed correctness must keep the attempted case prefix")
        final_case = cases[-1]
        expect_equal(final_case.get("failure"), failure,
                     f"{label}: the final failed case must carry the same typed first failure")
        final_case_error = final_case.get("error")
        expect(isinstance(final_case_error, str) and real_error_text in final_case_error,
               f"{label}: the final failed case error must be the real message string carrying "
               f"{real_error_text!r}, got {final_case_error!r}")
        expect_equal(file_correctness.get("failure"), failure,
                     f"{label}: the typed first failure must be the one persisted in correctness.json")
    else:
        # A preserved passed (or not_run) correctness must not be polluted by the
        # typed failure that lives only on the failed result envelope.
        expect(correctness.get("failure") is None,
               f"{label}: a {correctness_status} correctness must not carry correctness.failure, "
               f"got {correctness.get('failure')!r}")
        expect(correctness.get("error") is None,
               f"{label}: a {correctness_status} correctness must not carry correctness.error, "
               f"got {correctness.get('error')!r}")
    return result


@contextlib.contextmanager
def terminal_write_monitor(task_dir):
    """Observe how the real terminal correctness.json/result.json are written.

    Counting ``os.replace`` calls alone is not enough: a first atomic replace
    followed by a plain overwrite of the final path must still fail. So direct
    writes to the real final paths (``Path.write_text``, ``Path.open`` in a write
    mode, a raw ``open``) are recorded as violations, and an atomic replace is
    only accepted when its temporary file really existed with content in the
    destination directory.
    """
    targets = {
        str((Path(task_dir) / "correctness.json").resolve()): "correctness.json",
        str((Path(task_dir) / "result.json").resolve()): "result.json",
    }
    direct = []
    replacements = []
    sources_ok = {}
    real_write_text = Path.write_text
    real_path_open = Path.open
    real_builtin_open = builtins.open
    real_replace = os.replace

    def target_name(path):
        if isinstance(path, int):
            return None
        try:
            return targets.get(str(Path(path).resolve()))
        except (OSError, ValueError):
            return None

    def is_write_mode(mode):
        return any(flag in str(mode) for flag in ("w", "a", "x", "+"))

    def recording_write_text(self, data, *args, **kwargs):
        name = target_name(self)
        if name:
            direct.append(f"Path.write_text -> {name}")
        return real_write_text(self, data, *args, **kwargs)

    def recording_path_open(self, mode="r", *args, **kwargs):
        name = target_name(self)
        if name and is_write_mode(mode):
            direct.append(f"Path.open({mode!r}) -> {name}")
        return real_path_open(self, mode, *args, **kwargs)

    def recording_builtin_open(file, mode="r", *args, **kwargs):
        name = target_name(file)
        if name and is_write_mode(mode):
            direct.append(f"open({mode!r}) -> {name}")
        return real_builtin_open(file, mode, *args, **kwargs)

    def recording_replace(source, destination, *args, **kwargs):
        source_path, destination_path = Path(source), Path(destination)
        try:
            sources_ok[str(source_path)] = source_path.exists() and source_path.stat().st_size > 0
        except OSError:
            sources_ok[str(source_path)] = False
        replacements.append((source_path, destination_path))
        return real_replace(source, destination, *args, **kwargs)

    Path.write_text = recording_write_text
    Path.open = recording_path_open
    builtins.open = recording_builtin_open
    os.replace = recording_replace
    try:
        yield types.SimpleNamespace(direct=direct, replacements=replacements, sources_ok=sources_ok)
    finally:
        Path.write_text = real_write_text
        Path.open = real_path_open
        builtins.open = real_builtin_open
        os.replace = real_replace


def expect_atomic_terminal_writes(monitor, task_dir, names=("correctness.json", "result.json")):
    expect_equal(monitor.direct, [],
                 "the terminal correctness.json/result.json must never be written directly; "
                 "base records and shared normalization must both use temporary file + os.replace")
    by_name = {}
    for source, destination in monitor.replacements:
        by_name.setdefault(Path(destination).name, []).append((source, destination))
    resolved_task_dir = Path(task_dir).resolve()
    for name in names:
        expect(name in by_name, f"{name} must be written atomically (temporary file + os.replace)")
        for source, destination in by_name[name]:
            expect_equal(Path(destination).resolve().parent, resolved_task_dir,
                         f"{name} replacement destination directory")
            expect_equal(Path(source).resolve().parent, Path(destination).resolve().parent,
                         f"the {name} atomic temporary file must live in the destination directory")
            expect(Path(source).name != Path(destination).name,
                   f"the {name} write must use a temporary file name, never the final path")
            expect(monitor.sources_ok.get(str(source), False),
                   f"the {name} temporary file must exist with content at replace time")
    leftovers = sorted(path.name for path in Path(task_dir).rglob("*.tmp"))
    expect_equal(leftovers, [], "no partial temporary record may remain")


def expect_execution_package(result, label):
    package = result.get("executionPackage")
    expect_equal(package, EXPECTED_EXECUTION_PACKAGE,
                 f"{label}: a failed execution must retain the admitted executionPackage binding "
                 "(admissionId/preparedArtifactDigest/workspaceId/target/build/adapter and digests)")
    environment = result.get("environment") or {}
    expect_equal(environment.get("executionPackage"), package,
                 f"{label}: environment.executionPackage must agree with result.executionPackage")


# ---------------------------------------------------------------------------
# Cases.
# ---------------------------------------------------------------------------


def case_frozen_contract_identity():
    digest = hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest()
    expect_equal(digest, CONTRACT_SHA256, "frozen contract sha256")


def case_base_success_requested_counts():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir)
        status = run_base(paths)
        expect_equal(status, 0, "base success exit code")
        correctness = read_json(task_dir / "correctness.json")
        expect_equal(correctness.get("status"), "passed", "base success correctness.status")
        expect_equal(correctness.get("passed"), True, "base success correctness.passed")
        expect_equal(correctness.get("total"), CORRECTNESS_CASES, "base success correctness.total")
        expect_equal(correctness.get("executedCases"), CORRECTNESS_CASES, "base success correctness.executedCases")
        expect_equal(correctness.get("passedCases"), CORRECTNESS_CASES, "base success correctness.passedCases")
        expect_equal(len(correctness.get("caseResults") or []), CORRECTNESS_CASES, "base success caseResults")
        result = read_json(task_dir / "result.json")
        expect_equal(result["correctness"].get("status"), "passed", "base success result.correctness.status")
        expect_equal(len(result.get("benchmark") or []), len(BENCHMARK_PROFILES), "base success benchmark rows")


def case_base_first_case_mismatch():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, mismatch_on=MISMATCH_FIRST_CASE)
        status = run_base(paths)
        expect(status != 0, "a failed correctness must return a nonzero exit code")
        expect((task_dir / "correctness.json").is_file(), "a failed correctness must still persist correctness.json")
        correctness = read_json(task_dir / "correctness.json")
        expect_equal(correctness.get("status"), "failed", "first mismatch correctness.status")
        expect_equal(correctness.get("passed"), False, "first mismatch correctness.passed")
        expect_equal(correctness.get("total"), CORRECTNESS_CASES,
                     "total stays the requested case count, never the executed prefix")
        expect_equal(correctness.get("executedCases"), 1, "first mismatch executedCases")
        expect_equal(correctness.get("passedCases"), 0, "first mismatch passedCases")
        expect_equal(correctness.get("failedCase"), 1, "first mismatch failedCase")
        expect_equal(correctness.get("failedCaseName"), "case-1", "first mismatch failedCaseName")
        expect_equal(correctness.get("failedCaseCategory"), "minimal", "first mismatch failedCaseCategory")
        expect_typed_error(correctness.get("failure"), code="OPERATOR_CORRECTNESS_MISMATCH",
                           phase="correctness", role="candidate", label="first mismatch correctness.failure")
        cases = correctness.get("caseResults") or []
        expect_equal(len(cases), 1, "first mismatch caseResults")
        final_case = cases[-1]
        expect_equal(final_case.get("passed"), False, "first mismatch case passed")
        expect_equal(final_case.get("dtype"), "float32", "first mismatch case dtype")
        expect(isinstance(final_case.get("maxDiff"), (int, float)) and final_case["maxDiff"] > 0,
               "a computed mismatch must keep real numeric diagnostics, not a fabricated 0")
        expect("error" in final_case and "failure" in final_case, "each failed case must carry error and failure")
        expect_equal((final_case.get("failure") or {}).get("code"), "OPERATOR_CORRECTNESS_MISMATCH",
                     "first mismatch case failure code")
        expect_failed_result_envelope(task_dir, code="OPERATOR_CORRECTNESS_MISMATCH", phase="correctness",
                                      role="candidate", real_error_text=REAL_MISMATCH_TEXT,
                                      correctness_status="failed", label="first mismatch")


def case_base_later_case_mismatch():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, mismatch_on=MISMATCH_LATER_CASE)
        status = run_base(paths)
        expect(status != 0, "a later failed case must return a nonzero exit code")
        correctness = read_json(task_dir / "correctness.json")
        expect_equal(correctness.get("status"), "failed", "later mismatch correctness.status")
        expect_equal(correctness.get("passed"), False, "later mismatch correctness.passed")
        expect_equal(correctness.get("total"), CORRECTNESS_CASES, "later mismatch requested total")
        expect_equal(correctness.get("executedCases"), 3, "later mismatch executedCases")
        expect_equal(correctness.get("passedCases"), 2, "later mismatch passedCases")
        expect_equal(correctness.get("failedCase"), 3, "later mismatch failedCase")
        expect_equal(correctness.get("failedCaseName"), "case-3", "later mismatch failedCaseName")
        expect_typed_error(correctness.get("failure"), code="OPERATOR_CORRECTNESS_MISMATCH",
                           phase="correctness", role="candidate", label="later mismatch correctness.failure")
        cases = correctness.get("caseResults") or []
        expect_equal(len(cases), 3, "later mismatch caseResults is the attempted prefix")
        expect_equal([case.get("passed") for case in cases], [True, True, False],
                     "preceding successful cases must be preserved")
        expect_failed_result_envelope(task_dir, code="OPERATOR_CORRECTNESS_MISMATCH", phase="correctness",
                                      role="candidate", real_error_text=REAL_MISMATCH_TEXT,
                                      correctness_status="failed", label="later mismatch")


def case_base_candidate_exception():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, fail_run_on=THROWING_CASE)
        status = run_base(paths)
        expect(status != 0, "a candidate exception must return a nonzero exit code")
        expect((task_dir / "correctness.json").is_file(), "an attempted throwing case must persist correctness.json")
        correctness = read_json(task_dir / "correctness.json")
        expect_equal(correctness.get("status"), "failed", "candidate exception correctness.status")
        expect(correctness.get("status") != "not_run", "a throwing candidate case was attempted, not not_run")
        expect_equal(correctness.get("executedCases"), 2, "candidate exception executedCases")
        expect_equal(correctness.get("passedCases"), 1, "candidate exception passedCases")
        expect_equal(correctness.get("failedCase"), 2, "candidate exception failedCase")
        expect_equal(correctness.get("failedCaseName"), "case-2", "candidate exception failedCaseName")
        expect_typed_error(correctness.get("failure"), code="OPERATOR_CANDIDATE_EXCEPTION",
                           phase="correctness", role="candidate", label="candidate exception correctness.failure")
        cases = correctness.get("caseResults") or []
        expect_equal(len(cases), 2, "candidate exception attempted prefix")
        expect_equal(cases[0].get("passed"), True, "the preceding case must stay passed")
        final_case = cases[-1]
        expect_equal(final_case.get("passed"), False, "candidate exception final case passed")
        expect(final_case.get("maxDiff") is None and final_case.get("rmse") is None and final_case.get("cosDiff") is None,
               "metrics never computed for a throwing candidate must be null/absent, never a fabricated 0")
        expect_failed_result_envelope(task_dir, code="OPERATOR_CANDIDATE_EXCEPTION", phase="correctness",
                                      role="candidate", real_error_text=REAL_CANDIDATE_TEXT,
                                      correctness_status="failed", label="candidate exception")


def case_base_oracle_exception():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, fail_reference_on=THROWING_CASE)
        status = run_base(paths)
        expect(status != 0, "an oracle exception must return a nonzero exit code")
        expect((task_dir / "correctness.json").is_file(), "an attempted oracle failure must persist correctness.json")
        correctness = read_json(task_dir / "correctness.json")
        expect_equal(correctness.get("status"), "failed", "oracle exception correctness.status")
        expect_equal(correctness.get("executedCases"), 2, "oracle exception executedCases")
        expect_equal(correctness.get("passedCases"), 1, "oracle exception passedCases")
        expect_equal(correctness.get("failedCase"), 2, "oracle exception failedCase")
        expect_equal(correctness.get("failedCaseName"), "case-2", "oracle exception failedCaseName")
        expect_typed_error(correctness.get("failure"), code="OPERATOR_ORACLE_EXCEPTION",
                           phase="correctness", role="oracle", label="oracle exception correctness.failure")
        cases = correctness.get("caseResults") or []
        expect_equal(len(cases), 2, "oracle exception attempted prefix")
        expect_equal(cases[0].get("passed"), True, "the preceding case must stay passed")
        final_case = cases[-1]
        expect(final_case.get("maxDiff") is None and final_case.get("rmse") is None and final_case.get("cosDiff") is None,
               "an oracle failure must not fabricate numeric metrics")
        expect_failed_result_envelope(task_dir, code="OPERATOR_ORACLE_EXCEPTION", phase="correctness",
                                      role="oracle", real_error_text=REAL_ORACLE_TEXT,
                                      correctness_status="failed", label="oracle exception")


def case_base_benchmark_failure_preserves_correctness():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir)
        status = run_base(paths, benchmark=exploding_benchmark)
        expect(status != 0, "a benchmark stage exception must return a nonzero exit code")
        correctness = read_json(task_dir / "correctness.json")
        expect_equal(correctness.get("status"), "passed",
                     "a benchmark exception must preserve already observed passed correctness")
        expect_equal(correctness.get("passed"), True, "benchmark failure preserved correctness.passed")
        result = expect_failed_result_envelope(task_dir, code=None, phase="benchmark", role="backend",
                                               real_error_text=REAL_BENCHMARK_TEXT,
                                               correctness_status="passed", label="benchmark failure")
        expect(result["correctness"].get("passed") is not False,
               "a benchmark exception must not become a correctness mismatch")
        expect(result["error"].get("code") != "OPERATOR_CORRECTNESS_MISMATCH",
               "a benchmark exception must not be relabeled as OPERATOR_CORRECTNESS_MISMATCH")


def case_shared_success():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir)
        status = run_shared(paths)
        expect_equal(status, 0, "shared success exit code")
        result = read_json(task_dir / "result.json")
        expect_equal(result.get("schemaVersion"), "operator-studio.shared-gpu-result/v1", "shared result schemaVersion")
        expect_equal(result.get("publishable"), False, "shared success publishable")
        expect(result.get("status") != "failed", "shared success must not be reported as failed")
        correctness = result.get("correctness") or {}
        expect_equal(correctness.get("status"), "passed", "shared success correctness.status")
        expect_equal(correctness.get("total"), CORRECTNESS_CASES, "shared success correctness.total")
        expect_equal(correctness.get("executedCases"), CORRECTNESS_CASES, "shared success correctness.executedCases")
        expect_equal(len(result.get("benchmark") or []), len(BENCHMARK_PROFILES), "shared success benchmark rows")
        environment = result.get("environment") or {}
        expect_equal(environment.get("hardware"), "nvidia-gpu", "shared success environment.hardware")
        expect_equal(environment.get("executionMode"), "gpu", "shared success environment.executionMode")
        expect_equal(environment.get("liveHardware"), True, "shared success environment.liveHardware")
        probe = environment.get("targetProbe") or {}
        expect(probe.get("deviceName") and probe.get("driverVersion"),
               "the real target probe must survive into environment.targetProbe")
        expect_equal(environment.get("architecture"), "sm86", "shared success environment.architecture")
        evidence = result.get("experienceEvidence") or {}
        expect_equal(evidence.get("outcome"), "passed", "shared success evidence.outcome")
        expect_equal(evidence.get("missionId"), MISSION_ID, "shared success evidence.missionId")
        expect_equal(evidence.get("candidateId"), CANDIDATE_ID, "shared success evidence.candidateId")
        expect_equal(evidence.get("runId"), REQUEST_ID, "shared success evidence.runId")
        expect_equal(evidence.get("patchDigest"), PATCH_DIGEST, "shared success evidence.patchDigest")


def case_shared_candidate_mismatch_preserved():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, mismatch_on=THROWING_CASE)
        status = run_shared(paths)
        expect(status != 0, "a shared failed candidate must return a nonzero exit code")
        result = read_json(task_dir / "result.json")
        expect_equal(result.get("schemaVersion"), "operator-studio.shared-gpu-result/v1", "failed result schemaVersion")
        expect_equal(result.get("status"), "failed", "shared candidate failure result.status")
        expect_equal(result.get("publishable"), False, "shared candidate failure publishable")
        expect_equal(result.get("benchmark"), [], "a failed execution must not serialize a benchmark row")
        correctness = result.get("correctness") or {}
        expect_equal(correctness.get("status"), "failed", "shared failure correctness.status")
        expect_equal(correctness.get("passed"), False, "shared failure correctness.passed")
        expect_equal(correctness.get("total"), CORRECTNESS_CASES, "shared failure requested total")
        expect_equal(correctness.get("executedCases"), 2, "shared failure executedCases")
        expect_equal(correctness.get("passedCases"), 1, "shared failure passedCases")
        expect_equal(correctness.get("failedCase"), 2, "shared failure failedCase")
        expect_equal(correctness.get("failedCaseName"), "case-2", "shared failure failedCaseName")
        failure = correctness.get("failure")
        expect_typed_error(failure, code="OPERATOR_CORRECTNESS_MISMATCH", phase="correctness",
                           role="candidate", label="shared failure correctness.failure")
        expect_equal(result.get("error"), failure,
                     "result.error must carry the same typed first failure as correctness.failure")
        cases = correctness.get("caseResults") or []
        expect_equal(len(cases), 2, "shared failure attempted prefix")
        expect_equal(cases[-1].get("failure"), failure,
                     "the final failed case must carry the same typed first failure")
        environment = result.get("environment") or {}
        probe = environment.get("targetProbe") or {}
        expect(probe.get("deviceName") and probe.get("driverVersion"),
               "a real target probe must survive a failed correctness")
        expect_equal(environment.get("hardware"), "nvidia-gpu", "failed environment.hardware")
        expect_equal(environment.get("executionMode"), "gpu", "failed environment.executionMode")
        expect_equal(environment.get("liveHardware"), True, "failed environment.liveHardware")
        evidence = result.get("experienceEvidence") or {}
        expect_equal(evidence.get("outcome"), "failed", "failed evidence.outcome")
        expect_equal(evidence.get("operation"), "test", "failed evidence.operation")
        expect_equal(evidence.get("missionId"), MISSION_ID, "failed evidence.missionId")
        expect_equal(evidence.get("candidateId"), CANDIDATE_ID, "failed evidence.candidateId")
        expect_equal(evidence.get("runId"), REQUEST_ID, "failed evidence.runId must be payload.requestId")
        expect_equal(evidence.get("patchDigest"), PATCH_DIGEST, "failed evidence.patchDigest")
        expect_equal(evidence.get("packageDigest"), PACKAGE_DIGEST, "failed evidence.packageDigest")
        expect_equal(evidence.get("environmentDigest"), ENVIRONMENT_DIGEST, "failed evidence.environmentDigest")
        expect_equal(evidence.get("acceptanceDigest"), ACCEPTANCE_DIGEST, "failed evidence.acceptanceDigest")
        expect_equal(evidence.get("hardware"), "nvidia-gpu", "failed evidence.hardware")
        expect_equal(evidence.get("executionMode"), "gpu", "failed evidence.executionMode")
        expect_equal(evidence.get("liveHardware"), True, "failed evidence.liveHardware")
        expect_equal(evidence.get("architecture"), "sm86", "failed evidence.architecture comes from the probe")
        expect_execution_package(result, "shared failed candidate")
        expect_equal(evidence.get("packageDigest"), EXPECTED_EXECUTION_PACKAGE["packageDigest"],
                     "failed evidence.packageDigest must agree with executionPackage")
        expect_equal(evidence.get("environmentDigest"), EXPECTED_EXECUTION_PACKAGE["environmentDigest"],
                     "failed evidence.environmentDigest must agree with executionPackage")
        expect_equal(evidence.get("acceptanceDigest"), EXPECTED_EXECUTION_PACKAGE["acceptanceDigest"],
                     "failed evidence.acceptanceDigest must agree with executionPackage")


def case_shared_oracle_exception_not_learned():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, fail_reference_on=THROWING_CASE)
        status = run_shared(paths)
        expect(status != 0, "a shared oracle exception must return a nonzero exit code")
        result = read_json(task_dir / "result.json")
        expect_equal(result.get("status"), "failed", "shared oracle failure result.status")
        correctness = result.get("correctness") or {}
        expect_equal(correctness.get("status"), "failed", "shared oracle failure correctness.status")
        expect_equal(correctness.get("executedCases"), 2, "shared oracle failure executedCases")
        expect_equal(correctness.get("failedCase"), 2, "shared oracle failure failedCase")
        expect_equal(correctness.get("failedCaseName"), "case-2", "shared oracle failure failedCaseName")
        expect_typed_error(correctness.get("failure"), code="OPERATOR_ORACLE_EXCEPTION", phase="correctness",
                           role="oracle", label="shared oracle failure correctness.failure")
        evidence = result.get("experienceEvidence")
        expect(not evidence or evidence.get("outcome") != "failed",
               "an oracle failure must never become an eligible failed operator observation")


def case_shared_preflight_probe_failure_stale_result():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir)
        stale = {
            "schemaVersion": "operator-studio.shared-gpu-result/v1",
            "status": "completed",
            "correctness": {"status": "passed", "passed": True, "total": CORRECTNESS_CASES,
                            "executedCases": CORRECTNESS_CASES, "passedCases": CORRECTNESS_CASES, "caseResults": []},
            "benchmark": [{"profile": "primary", "value": 1.0}],
            "publishable": True,
            "environment": {"hardware": "nvidia-gpu"},
        }
        (task_dir / "result.json").write_text(json.dumps(stale, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        status = run_shared(paths, probe_run=failing_nvidia_run)
        expect(status != 0, "a probe failure must return a nonzero exit code")
        result = read_json(task_dir / "result.json")
        expect_equal(result.get("status"), "failed",
                     "a preflight/probe failure must not reuse the previous successful result in the same directory")
        expect_equal(result.get("publishable"), False, "probe failure publishable")
        expect_equal(result.get("benchmark"), [], "probe failure must not keep a stale benchmark row")
        expect_equal((result.get("correctness") or {}).get("status"), "not_run",
                     "a probe failure must report not_run correctness, not an operator failure")
        expect_execution_package(result, "shared preflight probe failure")
        evidence = result.get("experienceEvidence")
        expect(not evidence or evidence.get("outcome") != "failed",
               "a probe failure must never produce an eligible failed operator observation")


def case_shared_success_atomic_writes():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir)
        with terminal_write_monitor(task_dir) as monitor:
            status = run_shared(paths)
        expect_equal(status, 0, "shared success exit code")
        expect_atomic_terminal_writes(monitor, task_dir)
        result = read_json(task_dir / "result.json")
        expect(result.get("status") != "failed", "shared success atomic case must stay successful")
        expect_equal((result.get("correctness") or {}).get("status"), "passed",
                     "shared success atomic correctness.status")
        expect_equal(len(result.get("benchmark") or []), len(BENCHMARK_PROFILES),
                     "shared success atomic benchmark rows")


def case_shared_atomic_writes_and_preservation():
    with tempfile.TemporaryDirectory(prefix="shared-gpu-failure-result-") as directory:
        task_dir = Path(directory)
        paths = prepare_task(task_dir, fail_run_on=THROWING_CASE)
        with terminal_write_monitor(task_dir) as monitor:
            status = run_shared(paths)
        expect(status != 0, "a shared candidate exception must return a nonzero exit code")
        expect_atomic_terminal_writes(monitor, task_dir)
        result = read_json(task_dir / "result.json")
        expect_equal(result.get("status"), "failed", "atomic shared failure result.status")
        correctness = result.get("correctness") or {}
        expect_equal(correctness.get("status"), "failed", "atomic shared failure correctness.status")
        expect_equal(correctness.get("executedCases"), 2, "atomic shared failure executedCases")
        expect_typed_error(correctness.get("failure"), code="OPERATOR_CANDIDATE_EXCEPTION", phase="correctness",
                           role="candidate", real_error_text=REAL_CANDIDATE_TEXT,
                           label="shared normalization must preserve the typed failure, not replace it with generic not_run")
        expect_execution_package(result, "atomic shared failure")


CASES = [
    ("frozen-contract-sha256", case_frozen_contract_identity),
    ("base-success-requested-counts", case_base_success_requested_counts),
    ("base-first-case-mismatch", case_base_first_case_mismatch),
    ("base-later-case-mismatch", case_base_later_case_mismatch),
    ("base-candidate-exception", case_base_candidate_exception),
    ("base-oracle-exception", case_base_oracle_exception),
    ("base-benchmark-failure-preserves-correctness", case_base_benchmark_failure_preserves_correctness),
    ("shared-success", case_shared_success),
    ("shared-success-atomic-writes", case_shared_success_atomic_writes),
    ("shared-candidate-mismatch-preserved", case_shared_candidate_mismatch_preserved),
    ("shared-oracle-exception-not-learned", case_shared_oracle_exception_not_learned),
    ("shared-preflight-probe-failure-stale-result", case_shared_preflight_probe_failure_stale_result),
    ("shared-atomic-writes-and-preservation", case_shared_atomic_writes_and_preservation),
]

RESULT_MARKER = "__SHARED_GPU_FAILURE_RESULT__"


def main():
    results = []
    for name, function in CASES:
        try:
            function()
        except Exception as error:  # noqa: BLE001 - every case must be reported
            results.append({"name": name, "passed": False, "detail": f"{type(error).__name__}: {error}"})
        else:
            results.append({"name": name, "passed": True, "detail": ""})
    for item in results:
        line = f"[{'PASS' if item['passed'] else 'FAIL'}] {item['name']}"
        if not item["passed"]:
            line += f" :: {item['detail']}"
        print(line)
    summary = {
        "total": len(results),
        "passed": sum(1 for item in results if item["passed"]),
        "failed": sum(1 for item in results if not item["passed"]),
        "cases": results,
    }
    print(RESULT_MARKER + json.dumps(summary, ensure_ascii=False))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
