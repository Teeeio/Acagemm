"""Ascend910B execution port; scheduling and acceptance remain in Client Runtime."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tools" / "local-c500-runner.py"
BACKEND = "local-ascend910b"
SCHEMA = "operator-studio.ascend910b-result/v1"
NATIVE_SUFFIXES = {".cpp", ".cc", ".cxx", ".c", ".asc", ".cce"}


class AdapterError(RuntimeError):
    def __init__(self, code, message, phase="preflight", role="backend"):
        super().__init__(message)
        self.record = dict(code=code, message=message, phase=phase, role=role,
                           retryable=False, details={})


def fail(code, message, phase="preflight", role="backend"):
    raise AdapterError(code, message, phase, role)


def load_base():
    spec = importlib.util.spec_from_file_location("ascend910b_base_runner", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inside(value, root):
    path = Path(value).resolve()
    if not path.is_relative_to(root.resolve()):
        fail("ASCEND_PATH_INVALID", f"Path must stay inside the prepared task: {value}", role="contract")
    return path


def digest(path):
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def metadata_preflight():
    """No torch import, subprocess, device initialization or cache creation."""
    packages = {}
    for name in ("torch", "torch-npu", "ninja"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    missing = [name for name in ("torch", "torch-npu") if not packages[name]]
    return {
        "schemaVersion": "operator-studio.ascend910b-preflight/v1",
        "status": "blocked" if missing or platform.system() != "Linux" else "metadata_only",
        "platform": platform.system(), "machine": platform.machine(), "pythonVersion": platform.python_version(),
        "packages": packages, "missingDependencies": missing,
        "tools": {name: shutil.which(name) for name in ("npu-smi", "c++", "cmake", "bisheng")},
        "cannRoot": os.environ.get("ASCEND_HOME_PATH") or os.environ.get("ASCEND_TOOLKIT_HOME"),
        "compatibility": "unverified; check the installed release's TorchNPU/PyTorch/CANN/Python matrix",
        "deviceProbed": False, "liveHardware": False, "publishable": False,
    }


class NpuRuntime:
    """CPU tests explicitly construct simulated runtimes; CLI has no simulation mode."""
    def __init__(self, torch, npu, probe, *, live=False, device_type="npu"):
        self.torch, self.npu, self.probe = torch, npu, probe
        self.live, self.device_type = live, device_type
        self.index = int(probe["deviceIndex"])

    def sync(self):
        self.npu.synchronize(self.index)

    def check_tensors(self, value, label):
        count = 0
        def visit(item):
            nonlocal count
            if isinstance(item, self.torch.Tensor):
                count += 1
                device = item.device
                if device.type != self.device_type or (self.device_type == "npu" and device.index != self.index):
                    raise RuntimeError(f"{label} must use {self.device_type}:{self.index}; got {device}")
            elif isinstance(item, dict):
                for child in item.values():
                    visit(child)
            elif isinstance(item, (list, tuple)):
                for child in item:
                    visit(child)
        visit(value)
        if not count:
            raise RuntimeError(f"{label} must contain at least one device tensor")


def discover_runtime():
    if os.environ.get("OPERATOR_HARDWARE_DISABLED") == "1":
        fail("ASCEND_HARDWARE_DISABLED", "Hardware execution is disabled.")
    if platform.system() != "Linux":
        fail("ASCEND_PLATFORM_UNSUPPORTED", "The live Ascend910B adapter requires Linux.")
    try:
        torch = importlib.import_module("torch")
        torch_npu = importlib.import_module("torch_npu")
    except Exception as error:
        fail("ASCEND_DEPENDENCY_UNAVAILABLE", f"Cannot import torch/torch_npu: {error}")
    npu = getattr(torch_npu, "npu", None)
    required = ("is_available", "device_count", "current_device", "set_device", "get_device_name", "synchronize", "Event")
    missing = [name for name in required if not callable(getattr(npu, name, None))]
    if missing:
        fail("ASCEND_API_UNAVAILABLE", f"Installed torch_npu lacks required APIs: {', '.join(missing)}")
    try:
        if not npu.is_available():
            fail("ASCEND_DEVICE_UNAVAILABLE", "torch_npu.npu.is_available() is false.", "probe")
        requested = os.environ.get("OPERATOR_ASCEND_DEVICE_INDEX")
        index = int(requested) if requested is not None else int(npu.current_device())
        count = int(npu.device_count())
        if index < 0 or index >= count:
            fail("ASCEND_DEVICE_INDEX_INVALID", f"Logical NPU index {index} is outside [0, {count}).", "probe")
        npu.set_device(index)
        name = str(npu.get_device_name(index))
        # Accept reported 910B SKU suffixes, never 910/910A/910C or a host default.
        if not re.fullmatch(r"Ascend910B(?:[1-9][0-9]*[A-Za-z]?)?", re.sub(r"[ _-]", "", name), re.I):
            fail("ASCEND_DEVICE_MISMATCH", f"Expected Ascend910B; selected device reports {name!r}.", "probe")
        npu.synchronize(index)
    except AdapterError:
        raise
    except Exception as error:
        fail("ASCEND_PROBE_FAILED", str(error), "probe")
    versions, notes = {}, []
    try:
        utils = importlib.import_module("torch_npu.npu.utils")
        getter = getattr(utils, "get_cann_version", None)
        for kind in ("CANN", "RUNTIME", "COMPILER", "DRIVER"):
            try:
                versions[kind.lower()] = str(getter(kind)) if callable(getter) else None
            except Exception as error:
                versions[kind.lower()] = None
                notes.append(f"{kind}: {error}")
    except Exception as error:
        notes.append(str(error))
    probe = {
        "tool": "torch_npu.npu", "deviceIndex": index, "deviceName": name,
        "visibleDeviceCount": count, "torchVersion": str(torch.__version__),
        "torchNpuVersion": str(getattr(torch_npu, "__version__", "unknown")),
        "versions": versions, "versionNotes": notes,
        "driverVersion": versions.get("driver"),
        "architectureNote": "No architecture mapping inferred from the device name.",
        "compatibility": "API probe passed; release compatibility and native compilation require target-machine validation",
    }
    return NpuRuntime(torch, npu, probe, live=True)


def to_cpu(torch, value):
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: to_cpu(torch, item) for key, item in value.items()}
    if isinstance(value, tuple):
        return tuple(to_cpu(torch, item) for item in value)
    if isinstance(value, list):
        return [to_cpu(torch, item) for item in value]
    return value


def load_npu_extension(task_root, name, sources, *, extra_cflags=None, extra_ldflags=None):
    """JIT a C++ TorchNPU binding using installed NpuExtension link metadata.

    Ascend C device sources require the admitted bridge's release-specific build
    recipe; they are not treated as generic C++ or silently sent to CUDA.
    """
    root = Path(task_root).resolve()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        fail("ASCEND_BUILD_CONFIG_INVALID", "Extension name must be a Python identifier.", "build", "candidate")
    if not isinstance(sources, (list, tuple)) or not sources:
        fail("ASCEND_BUILD_CONFIG_INVALID", "C++ sources must be a non-empty list.", "build", "candidate")
    resolved = [inside(root / item, root) for item in sources]
    if any(not item.is_file() or item.suffix.lower() not in (".cpp", ".cc", ".cxx") for item in resolved):
        fail("ASCEND_BUILD_SOURCE_UNSUPPORTED", "The C++ bridge loader accepts .cpp/.cc/.cxx only; use a version-matched Ascend C recipe for device sources.", "build", "candidate")
    compiler = os.environ.get("CXX") or "c++"
    if not shutil.which(compiler):
        fail("ASCEND_COMPILER_UNAVAILABLE", f"C++ compiler is unavailable: {compiler}", "build")
    try:
        extension_api = importlib.import_module("torch_npu.utils.cpp_extension")
        torch_api = importlib.import_module("torch.utils.cpp_extension")
        if not torch_api.is_ninja_available():
            fail("ASCEND_BUILD_DEPENDENCY_UNAVAILABLE", "The installed PyTorch JIT extension loader requires ninja.", "build")
        metadata = extension_api.NpuExtension(name, [str(item) for item in resolved])
    except AdapterError:
        raise
    except Exception as error:
        fail("ASCEND_BUILD_DEPENDENCY_UNAVAILABLE", f"Installed TorchNPU extension API is unavailable: {error}", "build")
    build_dir = inside(root / ".ascend-cache" / "native" / name, root)
    build_dir.mkdir(parents=True, exist_ok=True)
    ldflags = [f"-L{path}" for path in metadata.library_dirs]
    ldflags += [f"-Wl,-rpath,{path}" for path in metadata.library_dirs]
    ldflags += [f"-l{library}" for library in metadata.libraries]
    return torch_api.load(name=name, sources=[str(item) for item in resolved],
                          extra_include_paths=metadata.include_dirs, extra_cflags=list(extra_cflags or []),
                          extra_ldflags=ldflags + list(extra_ldflags or []), build_directory=str(build_dir),
                          with_cuda=False, verbose=True)


class NativeLoads:
    """Observe actual task-owned library loads during candidate work, not oracle work."""
    def __init__(self, root, torch):
        self.root, self.torch = root, torch
        self.role = None
        self.loads, self.errors, self.restores = [], [], []
        self.sources = [str(p.relative_to(root)) for p in root.rglob("*")
                        if p.is_file() and p.suffix.lower() in NATIVE_SUFFIXES and ".ascend-cache" not in p.parts]

    @contextlib.contextmanager
    def candidate(self):
        previous = self.role
        self.role = "candidate"
        try:
            yield
        finally:
            self.role = previous

    def record(self, path, api):
        if self.role != "candidate":
            return
        path = inside(path, self.root)
        if not path.is_file() or path.suffix.lower() not in (".so", ".pyd", ".dll"):
            fail("ASCEND_NATIVE_LOAD_INVALID", f"Loader did not return a task-owned native module: {path}", "build", "candidate")
        # Hashing an extension can be expensive. Record the actual load here;
        # materialize its digest after all scored measurements have finished.
        self.loads.append({"api": api, "path": str(path.relative_to(self.root))})

    def __enter__(self):
        if not self.sources:
            return self
        try:
            extension = importlib.import_module("torch.utils.cpp_extension")
        except Exception as error:
            fail("ASCEND_BUILD_DEPENDENCY_UNAVAILABLE", f"Native loader observation requires PyTorch extension API: {error}", "build")
        def install(owner, name, wrapper):
            original = getattr(owner, name)
            setattr(owner, name, wrapper(original))
            self.restores.append((owner, name, original))
        def extension_load(original):
            def call(*args, **kwargs):
                if self.role != "candidate":
                    return original(*args, **kwargs)
                # A task-private default also keeps legitimate torch cache hits source-bound.
                build_dir = kwargs.get("build_directory")
                if build_dir is not None:
                    inside(build_dir, self.root)
                try:
                    result = original(*args, **kwargs)
                    self.record(getattr(result, "__file__", result if isinstance(result, str) else ""), "cpp_extension.load")
                    return result
                except Exception as error:
                    self.errors.append(str(error))
                    raise
            return call
        def library_load(original):
            def call(path, *args, **kwargs):
                if self.role == "candidate":
                    inside(path, self.root)
                try:
                    result = original(path, *args, **kwargs)
                    self.record(path, "torch.ops.load_library")
                    return result
                except Exception as error:
                    if self.role == "candidate":
                        self.errors.append(str(error))
                    raise
            return call
        install(extension, "load", extension_load)
        install(extension, "load_inline", extension_load)
        install(self.torch.ops, "load_library", library_load)
        return self

    def __exit__(self, *_):
        for owner, name, original in reversed(self.restores):
            setattr(owner, name, original)

    def observation(self):
        loads = []
        for item in self.loads:
            path = inside(self.root / item["path"], self.root)
            try:
                observed_digest = digest(path)
            except OSError:
                observed_digest = None
            loads.append({**item, "digest": observed_digest})
        return {"required": bool(self.sources), "sourceFiles": self.sources,
                "satisfied": not self.sources or bool(loads) and all(item["digest"] for item in loads), "loads": loads, "errors": self.errors,
                "scope": "candidate task-owned library load; not proof of kernel dispatch"}


def benchmark_one(base, runtime, module, inputs, warmup, repeats, *, settle_tolerance=None, max_settlements=None):
    runtime.check_tensors(inputs, "Benchmark inputs")
    # Output placement checks belong after the timing interval. No observer
    # executes inside the scored candidate call, and no extra invocation occurs.
    operation = getattr(module, "_ascend_measured_run", module.run)
    def measure():
        for _ in range(max(0, warmup)):
            module.run(inputs)
        runtime.sync()
        samples = []
        for _ in range(max(1, repeats)):
            start, end = runtime.npu.Event(enable_timing=True), runtime.npu.Event(enable_timing=True)
            start.record()
            output = operation(inputs)
            end.record()
            end.synchronize()
            value = float(start.elapsed_time(end)) * 1000.0
            runtime.check_tensors(output, "Measured output")
            if not math.isfinite(value) or value <= 0:
                fail("ASCEND_TIMING_INVALID", f"NPU event returned invalid microseconds: {value}", "benchmark")
            samples.append(value)
        return {"p50Us": base._percentile(samples, .5), "p95Us": base._percentile(samples, .95),
                "minUs": min(samples), "maxUs": max(samples), "warmup": warmup, "samples": repeats}
    stats, settled, count = base._settle_measurements(measure,
        settle_tolerance if settle_tolerance is not None else base.DEFAULT_SETTLE_TOLERANCE,
        max_settlements if max_settlements is not None else base.DEFAULT_MAX_SETTLEMENTS)
    return {**stats, "settled": settled, "settlements": count}


def unavailable_diagnostics(*args, **kwargs):
    # Never launch retained MetaX tools or a second copy of the candidate on NPU.
    return {"status": "unavailable", "source": "unavailable", "simulated": False,
            "real": False, "reason": "Ascend profiling is not configured by this adapter.", "artifacts": []}


def execute(task_dir, candidate, oracle, result_path, *, runtime_factory=discover_runtime):
    base = load_base()
    root = Path(task_dir).resolve()
    result_path = inside(result_path, root)
    if result_path != root / "result.json" or not root.is_dir():
        fail("ASCEND_CONFIG_INVALID", "Existing task directory and task/result.json are required.", role="contract")
    task, runtime, observation = {}, None, None
    input_digests = {}
    error_record = None
    try:
        result_path.unlink(missing_ok=True)
        task = json.loads((root / "task.json").read_text(encoding="utf-8"))
        if not isinstance(task, dict):
            fail("ASCEND_TASK_INVALID", "task.json must be an object.", role="contract")
        if not oracle:
            fail("ASCEND_ORACLE_REQUIRED", "An independent prepared oracle file is required.", role="oracle")
        if not candidate:
            fail("ASCEND_CANDIDATE_REQUIRED", "Prepared candidate entrypoint is missing.", role="candidate")
        candidate, oracle = inside(candidate, root), inside(oracle, root)
        if candidate == oracle or not oracle.is_file():
            fail("ASCEND_ORACLE_REQUIRED", "An independent prepared oracle file is required.", role="oracle")
        if not candidate.is_file():
            fail("ASCEND_CANDIDATE_REQUIRED", "Prepared candidate entrypoint is missing.", role="candidate")
        if os.path.samefile(candidate, oracle):
            fail("ASCEND_ORACLE_REQUIRED", "Candidate and oracle cannot be the same inode.", role="oracle")
        input_digests = {str(item): digest(item) for item in (candidate, oracle)}
        implementations = (task.get("payload") or {}).get("implementationFiles", {}) if isinstance(task.get("payload"), dict) else {}
        if not isinstance(implementations, dict):
            fail("ASCEND_PACKAGE_FILES_INVALID", "implementationFiles must be an object.", role="contract")
        for name, content in implementations.items():
            source = inside(root / name, root)
            expected = "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest() if isinstance(content, str) else None
            if not expected or not source.is_file() or digest(source) != expected:
                fail("ASCEND_PACKAGE_FILE_CHANGED", f"Prepared file differs from the task payload: {name}", role="contract")
            input_digests[str(source)] = expected
        bound_digest = task.get("runPyDigest")
        if bound_digest and digest(candidate).removeprefix("sha256:") != str(bound_digest).removeprefix("sha256:"):
            fail("ASCEND_CANDIDATE_DIGEST_MISMATCH", "Prepared entrypoint differs from task.runPyDigest.", role="contract")
        if os.environ.get("OPERATOR_HARDWARE_DISABLED") == "1" and runtime_factory is discover_runtime:
            fail("ASCEND_HARDWARE_DISABLED", "Hardware execution is disabled.")
        cache = root / ".ascend-cache"
        if runtime_factory is discover_runtime and platform.system() == "Linux" and not re.fullmatch(r"[A-Za-z0-9_./-]+", str(cache)):
            fail("ASCEND_CACHE_PATH_INVALID", "CANN requires an ASCII task/cache path containing only letters, digits, '_', '-', '.' and '/'.", role="contract")
        for name in ("tmp", "torch-extensions", "opp", "xdg", "work", "logs"):
            inside(cache / name, root).mkdir(parents=True, exist_ok=True)
        environment = {
            "OPERATOR_LOCAL_C500_TASK_DIR": str(root), "OPERATOR_LOCAL_C500_RUN_PY": str(candidate),
            "OPERATOR_LOCAL_C500_ORACLE_RUN_PY": str(oracle), "OPERATOR_LOCAL_C500_RESULT_JSON": str(result_path),
            # Cross-device cache reuse cannot use the retained CUDA/MACA cache identity.
            "OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR": str(cache / "reference"),
            "TORCH_EXTENSIONS_DIR": str(cache / "torch-extensions"), "TMPDIR": str(cache / "tmp"),
            "TMP": str(cache / "tmp"), "TEMP": str(cache / "tmp"),
            "ASCEND_CACHE_PATH": str(cache / "opp"), "ACL_OP_COMPILER_CACHE_DIR": str(cache / "opp"),
            "ASCEND_WORK_PATH": str(cache / "work"), "ASCEND_PROCESS_LOG_PATH": str(cache / "logs"),
            "XDG_CACHE_HOME": str(cache / "xdg"),
        }
        old_env, old_path = {key: os.environ.get(key) for key in environment}, list(sys.path)
        helper_name = "operator_studio_ascend"
        previous_helper = sys.modules.get(helper_name)
        previous_tempdir = tempfile.tempdir
        previous_dir = Path.cwd()
        try:
            os.environ.update(environment)
            tempfile.tempdir = str(cache / "tmp")
            os.chdir(root)
            # Cache/log paths must precede import and the first NPU initialization.
            runtime = runtime_factory()
            runtime_key = hashlib.sha256(json.dumps(runtime.probe, sort_keys=True).encode("utf-8")).hexdigest()
            os.environ["OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR"] = str(cache / "reference" / runtime_key)
            sys.path.insert(0, str(root))
            helper = ModuleType(helper_name)
            sys.modules[helper_name] = helper
            with NativeLoads(root, runtime.torch) as native:
                def observed_build(name, sources, **options):
                    try:
                        return load_npu_extension(root, name, sources, **options)
                    except Exception as error:
                        if str(error) not in native.errors:
                            native.errors.append(str(error))
                        raise
                helper.load_npu_extension = observed_build
                def load_operator(filename):
                    path = inside(filename, root)
                    is_oracle = path == oracle
                    spec = importlib.util.spec_from_file_location(f"ascend_{'oracle' if is_oracle else 'candidate'}_{time.time_ns()}", path)
                    module = importlib.util.module_from_spec(spec)
                    with contextlib.nullcontext() if is_oracle else native.candidate():
                        spec.loader.exec_module(module)
                    required = ("reference", "get_test_cases", "get_benchmark_inputs") if is_oracle else ("run",)
                    if any(not callable(getattr(module, name, None)) for name in required):
                        fail("ASCEND_MODULE_CONTRACT_INVALID", f"Required functions: {', '.join(required)}", role="oracle" if is_oracle else "candidate")
                    # The oracle's independent reference is also its benchmark, never candidate.run.
                    operation = module.reference if is_oracle else module.run
                    def measured_run(inputs):
                        with contextlib.nullcontext() if is_oracle else native.candidate():
                            return operation(inputs)
                    def checked_run(inputs):
                        runtime.check_tensors(inputs, "Oracle-owned inputs")
                        output = measured_run(inputs)
                        runtime.check_tensors(output, "Oracle output" if is_oracle else "Candidate output")
                        return output
                    module.run = checked_run
                    module._ascend_measured_run = measured_run
                    return module
                original_metrics = base._case_metrics
                base._load_operator = load_operator
                base._torch_and_device = lambda: (runtime.torch, runtime.index)
                base._probe_c550 = lambda *_: runtime.probe
                base._sync = lambda _: runtime.sync()
                base._case_metrics = lambda torch, actual, expected: original_metrics(torch, to_cpu(torch, actual), to_cpu(torch, expected))
                base._assert_close = lambda torch, actual, expected, atol, rtol: torch.testing.assert_close(to_cpu(torch, actual), to_cpu(torch, expected), atol=atol, rtol=rtol)
                base._benchmark_one = lambda module, torch, inputs, warmup, repeats, **options: benchmark_one(base, runtime, module, inputs, warmup, repeats, **options)
                base._analysis_tool = unavailable_diagnostics
                # Input placement belongs to the independent oracle, including lazy
                # make_inputs. Reuse the base's exact case/profile plan unchanged.
                original_cases, original_profiles = base._named_cases, base._named_benchmark_profiles
                def validate_inputs(items):
                    for item in items:
                        if "inputs" in item:
                            runtime.check_tensors(item["inputs"], "Oracle-owned inputs")
                        elif callable(item.get("make_inputs")):
                            make = item["make_inputs"]
                            def checked_make(make=make):
                                inputs = make()
                                runtime.check_tensors(inputs, "Oracle-owned inputs")
                                return inputs
                            item = {**item, "make_inputs": checked_make}
                        yield item
                base._named_cases = lambda *args, **kwargs: list(validate_inputs(original_cases(*args, **kwargs)))
                base._named_benchmark_profiles = lambda *args, **kwargs: list(validate_inputs(original_profiles(*args, **kwargs)))
                try:
                    base._run(SimpleNamespace(run_py=str(candidate), result_json=str(result_path), atol=1e-3, rtol=1e-3))
                finally:
                    observation = native.observation()
        finally:
            os.chdir(previous_dir)
            tempfile.tempdir = previous_tempdir
            sys.path[:] = old_path
            if previous_helper is None:
                sys.modules.pop(helper_name, None)
            else:
                sys.modules[helper_name] = previous_helper
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    except Exception as error:
        error_record = error.record if isinstance(error, AdapterError) else {
            "code": "ASCEND_RUNNER_FAILED", "message": str(error), "phase": "runner", "role": "backend", "retryable": False, "details": {}}
    if not isinstance(task, dict):
        task = {}
    try:
        result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.is_file() else None
        if not isinstance(result, dict):
            raise ValueError("missing result")
    except (OSError, ValueError):
        matrix = task.get("matrix") if isinstance(task, dict) and isinstance(task.get("matrix"), dict) else {}
        total = matrix.get("correctnessCases", 0)
        total = total if isinstance(total, int) else 0
        result = {"status": "failed", "error": error_record or {"code": "ASCEND_RESULT_MISSING", "message": "Base runner did not persist a result.", "phase": "runner", "role": "backend", "retryable": False, "details": {}},
                  "correctness": base._not_run_correctness(total), "benchmark": [], "environment": {}}
    if error_record and result.get("status") != "failed":
        result.update(status="failed", error=error_record)
    if error_record and result.get("error") != error_record:
        result["adapterError"] = error_record
    drifted = []
    for name, expected in input_digests.items():
        try:
            unchanged = Path(name).is_file() and digest(name) == expected
        except OSError:
            unchanged = False
        if not unchanged:
            drifted.append(name)
    if drifted:
        result["inputIntegrity"] = {"status": "failed", "changedFiles": drifted}
        if result.get("status") != "failed":
            result.update(status="failed", error={"code": "ASCEND_INPUT_CHANGED_DURING_RUN", "message": "Prepared candidate/oracle/dependency bytes changed during execution.", "phase": "execution", "role": "contract", "retryable": False, "details": result["inputIntegrity"]})
    if observation:
        result["nativeBuild"] = observation
        if not observation["satisfied"] and result.get("status") != "failed":
            result.update(status="failed", error={"code": "ASCEND_NATIVE_BUILD_MISSING", "message": "Native sources require an observed task-owned library load by the candidate.", "phase": "build", "role": "candidate", "retryable": False, "details": observation})
    env = result.setdefault("environment", {})
    env.update(runtime="ascend910b-runner/v1", service="ascend910b-adapter", source=BACKEND,
               hardware="Ascend910B", executionMode="simulation" if runtime and not runtime.live else "npu",
               liveHardware=bool(runtime and runtime.live), simulated=bool(runtime and not runtime.live),
               publishable=False, targetProbe=runtime.probe if runtime else None)
    result.update(schemaVersion=SCHEMA, publishable=False)
    result.pop("experienceEvidence", None)  # Integration owns qualification; no synthetic learned verdict.
    package = base._execution_package(task)
    if package:
        result["executionPackage"] = package
        env["executionPackage"] = package
    env["manifest"] = {"pythonVersion": platform.python_version(), "platform": platform.system(),
                       "runnerDigest": digest(__file__), "baseRunnerDigest": digest(SOURCE),
                       "candidateEntrypointDigest": input_digests.get(str(candidate)),
                       "oracleEntrypointDigest": input_digests.get(str(oracle)),
                       "timing": "torch_npu.npu.Event milliseconds converted to microseconds; end-event synchronization",
                       "comparison": "unchanged base rules on CPU copies; outside scored timing", "nativeBuild": observation}
    base._write_json_atomic(root / "environment-manifest.json", env)
    base._write_json_atomic(root / "correctness.json", result["correctness"])
    base._write_json_atomic(result_path, result)
    return 0 if result["status"] == "completed" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--probe-device", action="store_true")
    args = parser.parse_args(argv)
    if args.probe_device and not args.preflight:
        parser.error("--probe-device requires --preflight")
    if args.preflight:
        report = metadata_preflight()
        if args.probe_device:
            try:
                runtime = discover_runtime()
                report.update(status="device_probed", deviceProbed=True, liveHardware=True, targetProbe=runtime.probe)
            except AdapterError as error:
                report.update(status="blocked", error=error.record)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if report["status"] == "blocked" else 0
    values = [os.environ.get("OPERATOR_LOCAL_C500_" + name) for name in ("TASK_DIR", "RUN_PY", "ORACLE_RUN_PY", "RESULT_JSON")]
    if not values[0] or not values[3]:
        # No safe output root: stderr only, supervisor still owns the exit receipt.
        print("ASCEND_CONFIG_INVALID: task, candidate, independent oracle and result paths are required", file=sys.stderr)
        return 1
    try:
        return execute(*values)
    except Exception as error:
        print(f"ASCEND_TERMINAL_WRITE_FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
