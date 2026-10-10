"""C500 runner. Import starts no hardware, compiler, process or Torch import."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

BASE_SOURCE = Path(__file__).resolve().parents[1] / "local-c500-runner.py"
_BASE = None
_TIMINGS = []


class C500Error(RuntimeError):
    def __init__(self, code, message, *, phase="preflight", role="backend", details=None):
        super().__init__(message)
        self.record = {"code": code, "message": message, "phase": phase, "role": role,
                       "retryable": False, "details": details or {}}


def _base():
    global _BASE
    if _BASE is None:
        spec = importlib.util.spec_from_file_location("metax_c500_fixed_engine", BASE_SOURCE)
        _BASE = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_BASE)
    return _BASE


def _sha(path):
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _version_policy(policy):
    if not isinstance(policy, dict):
        raise C500Error("METAX_C500_VERSION_POLICY_REQUIRED", "Supply actual C500 vendor-image versions.")
    for key in ("python", "torch", "maca", "driver"):
        if not isinstance(policy.get(key), str) or not policy[key].strip():
            raise C500Error("METAX_C500_VERSION_POLICY_REQUIRED", "Pin python, torch, maca and driver.", details={"missing": key})
    for key, value in policy.items():
        if key not in ("python", "torch", "maca", "driver", "triton", "compiler") or not isinstance(value, str) or not value.strip():
            raise C500Error("METAX_C500_VERSION_POLICY_INVALID", "Unknown or empty version pin.", details={"key": key})
    return policy


def _label_version(raw, label):
    match = re.search(r"\b" + re.escape(label) + r"\s*Version\s*:\s*([^\s|]+)", raw, re.I)
    return match.group(1) if match else None


def probe_runtime(torch=None, device=None, *, version_policy, mx_smi=None, compiler=None,
                  run=subprocess.run, system=platform.system):
    policy = _version_policy(version_policy)
    if system() != "Linux":
        raise C500Error("METAX_C500_PLATFORM_UNSUPPORTED", "C500 live execution requires Linux; CPU tests do not establish hardware support.")
    if torch is None:
        try:
            import torch
        except Exception as error:
            raise C500Error("METAX_C500_TORCH_UNAVAILABLE", str(error)) from error
    cuda = getattr(torch, "cuda", None)
    if cuda is None or not callable(getattr(cuda, "is_available", None)) or not cuda.is_available():
        raise C500Error("METAX_C500_RUNTIME_UNAVAILABLE", "MetaX Torch CUDA-compatible runtime is unavailable.")
    device = cuda.current_device() if device is None else device
    name = str(cuda.get_device_name(device))
    if not re.search(r"\bC500\b", name, re.I):
        raise C500Error("METAX_C500_DEVICE_MISMATCH", "Actual Torch device must be C500.", details={"deviceName": name})
    executable = mx_smi or shutil.which("mx-smi")
    if not executable:
        raise C500Error("METAX_C500_SMI_UNAVAILABLE", "mx-smi is required; a label is not hardware provenance.")
    result = run([executable], capture_output=True, text=True, timeout=20, check=False)
    raw = str(result.stdout or "").strip()
    if result.returncode != 0 or not re.search(r"\bC500\b", raw, re.I):
        raise C500Error("METAX_C500_SMI_INVALID", "mx-smi did not confirm C500.", details={"exitCode": result.returncode, "stderr": str(result.stderr or "")[:1000]})
    torch_version = str(getattr(torch, "__version__", ""))
    torch_maca = getattr(getattr(torch, "version", None), "maca", None)
    maca = _label_version(raw, "MACA") or (str(torch_maca) if torch_maca else None)
    if "metax" not in torch_version.lower() and not torch_maca:
        raise C500Error("METAX_C500_FRAMEWORK_UNKNOWN", "Torch lacks observed MetaX/MACA identity; NVIDIA/MUSA is not C500.")
    versions = {"python": platform.python_version(), "torch": torch_version,
                "maca": maca, "driver": _label_version(raw, "Driver"), "triton": None, "compiler": None}
    try:
        import triton
        versions["triton"] = str(triton.__version__)
    except ImportError:
        pass
    if "compiler" in policy:
        if not compiler:
            raise C500Error("METAX_C500_COMPILER_REQUIRED", "Configure the actual C500 compiler executable; its name/version is not guessed.")
        reply = run([compiler, "--version"], capture_output=True, text=True, timeout=20, check=False)
        if reply.returncode != 0:
            raise C500Error("METAX_C500_COMPILER_UNAVAILABLE", "Configured compiler version query failed.")
        versions["compiler"] = str(reply.stdout or reply.stderr or "").strip()
    for key, expected in policy.items():
        if versions.get(key) != expected:
            raise C500Error("METAX_C500_VERSION_MISMATCH", "Observed runtime differs from C500 pin.", details={"key": key, "expected": expected, "actual": versions.get(key)})
    for api in ("synchronize", "Event"):
        if not callable(getattr(cuda, api, None)):
            raise C500Error("METAX_C500_TIMER_UNSUPPORTED", "Unknown MACA fork: required Event/synchronize API is missing.", details={"api": api})
    try:
        start, end = cuda.Event(enable_timing=True), cuda.Event(enable_timing=True)
        cuda.synchronize()
        start.record(); end.record(); end.synchronize(); cuda.synchronize()
        elapsed = float(start.elapsed_time(end))
        if not math.isfinite(elapsed) or elapsed < 0:
            raise ValueError("non-finite or negative Event duration")
    except Exception as error:
        raise C500Error("METAX_C500_TIMER_UNSUPPORTED", "MACA Event preflight failed; no CPU-clock fallback.", details={"cause": str(error)}) from error
    return {"vendor": "metax", "deviceIndex": int(device), "deviceName": name,
            "versions": versions, "pythonExecutable": str(Path(sys.executable).resolve()),
            "mxSmiExecutable": str(executable), "rawMxSmi": raw[:16000],
            "compilerExecutable": compiler, "timer": {"kind": "maca-torch-event", "validated": True,
            "eventUnit": "ms", "reportedUnit": "us", "repeatsUnit": "count", "warmupUnit": "count"},
            "runnerDigest": _sha(__file__), "fixedEngineDigest": _sha(BASE_SOURCE)}


def benchmark_one(module, torch, inputs, warmup, repeats, *, settle_tolerance=None, max_settlements=None):
    # Exact counts, not Triton do_bench(rep=milliseconds). Each Event pair measures
    # one invocation on the current stream. Cross-stream kernels must join it.
    if isinstance(warmup, bool) or not isinstance(warmup, int) or warmup < 0 or isinstance(repeats, bool) or not isinstance(repeats, int) or repeats < 1:
        raise C500Error("METAX_C500_BENCHMARK_COUNTS_INVALID", "Warmup/repeats must be nonnegative/positive integer invocation counts.", phase="benchmark")
    tensor_type = getattr(torch, "Tensor", ())
    def tensors(value):
        if tensor_type and isinstance(value, tensor_type):
            yield value
        elif isinstance(value, dict):
            for item in value.values():
                yield from tensors(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                yield from tensors(item)
    if not any(getattr(getattr(t, "device", None), "type", None) == "cuda" for t in tensors(inputs)):
        raise C500Error("METAX_C500_INPUT_DEVICE_MISMATCH", "Benchmark inputs contain no MACA CUDA-compatible device tensor; CPU work cannot be labelled C500 performance.", phase="benchmark", role="oracle")
    def invoke():
        try:
            output = module.run(inputs)
        except C500Error:
            raise
        except Exception as error:
            raise C500Error("METAX_C500_BENCHMARK_INVOCATION_FAILED", str(error), phase="benchmark", role=getattr(module, "_operator_studio_role", "candidate")) from error
        if any(getattr(getattr(t, "device", None), "type", None) != "cuda" for t in tensors(output)):
            raise C500Error("METAX_C500_OUTPUT_DEVICE_MISMATCH", "Operator returned a CPU/foreign-device tensor.", phase="benchmark", role=getattr(module, "_operator_studio_role", "candidate"))
        return output
    def settle_once():
        for _ in range(warmup):
            invoke()
        torch.cuda.synchronize()
        values = []
        for _ in range(repeats):
            start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            start.record(); invoke(); end.record()
            end.synchronize(); torch.cuda.synchronize()
            value = float(start.elapsed_time(end)) * 1000.0
            if not math.isfinite(value) or value <= 0:
                raise C500Error("METAX_C500_TIMING_INVALID", "Invocation must have a positive finite device Event duration.", phase="benchmark")
            values.append(value)
        ordered = sorted(values)
        percentile = lambda fraction: ordered[int((len(ordered) - 1) * fraction)]
        return {"p50Us": percentile(.5), "p95Us": percentile(.95), "minUs": ordered[0], "maxUs": ordered[-1],
                "samples": len(values), "warmup": warmup, "timing": {"kind": "maca-torch-event", "samplesUnit": "count", "warmupUnit": "count"}}
    base = _base()
    stats, settled, settlements = base._settle_measurements(settle_once,
        base.DEFAULT_SETTLE_TOLERANCE if settle_tolerance is None else settle_tolerance,
        base.DEFAULT_MAX_SETTLEMENTS if max_settlements is None else max_settlements)
    _TIMINGS.append({"samplesPerSettlement": repeats, "warmupPerSettlement": warmup,
                     "settlements": settlements, "measuredInvocations": repeats * settlements})
    return {**stats, "settled": settled, "settlements": settlements}


def _inside(root, file):
    root, original = Path(root).resolve(), Path(file)
    if original.is_symlink():
        raise C500Error("METAX_C500_PACKAGE_PATH_INVALID", "Entrypoints cannot be symlinks.")
    file = original.resolve()
    if not file.is_relative_to(root) or not file.is_file():
        raise C500Error("METAX_C500_PACKAGE_PATH_INVALID", "Entrypoints must be regular files inside prepared package.")
    return file


class NativeLoadObserver:
    """Only candidate-owned extension loads count; oracle loads are excluded."""
    def __init__(self, root, required):
        self.root, self.required, self.calls = Path(root).resolve(), required, []
        self.originals, self.active = [], False

    def install(self):
        if not self.required:
            return
        try:
            import torch.utils.cpp_extension as extension
            for name in ("load", "load_inline"):
                original = getattr(extension, name, None)
                if not callable(original):
                    continue
                def observed(*args, _original=original, _api=name, **kwargs):
                    if not self.active:
                        return _original(*args, **kwargs)
                    call = {"api": _api, "outcome": "raised"}
                    try:
                        module = _original(*args, **kwargs)
                        path = Path(getattr(module, "__file__", "") or ".").resolve()
                        if path.suffix.lower() in (".so", ".pyd", ".dll") and path.is_file() and path.is_relative_to(self.root):
                            call.update({"outcome": "loaded", "path": str(path), "digest": _sha(path)})
                        else:
                            call["outcome"] = "unverified_artifact"
                        self.calls.append(call)
                        return module
                    except Exception as error:
                        call["error"] = str(error); self.calls.append(call); raise
                self.originals.append((extension, name, original))
                setattr(extension, name, observed)
        except ImportError as error:
            raise C500Error("METAX_C500_NATIVE_LOADER_UNSUPPORTED", "Native source needs the actual MetaX extension loader.", phase="build", details={"cause": str(error)}) from error
        if not self.originals:
            raise C500Error("METAX_C500_NATIVE_LOADER_UNSUPPORTED", "Unknown MACA loader API; no fallback is admitted.", phase="build")

    def call(self, function, *args):
        self.active = True
        try:
            return function(*args)
        finally:
            self.active = False

    def receipt(self):
        artifacts = [call for call in self.calls if call.get("outcome") == "loaded"]
        return {"required": self.required, "loadedExtension": bool(artifacts), "satisfied": not self.required or bool(artifacts), "artifacts": artifacts, "calls": self.calls}

    def close(self):
        for module, name, original in self.originals:
            setattr(module, name, original)


def load_operator(path, root, *, oracle=False, observer=None):
    file = _inside(root, path)
    sys.path.insert(0, str(Path(root).resolve()))
    spec = importlib.util.spec_from_file_location(f"metax_c500_{'oracle' if oracle else 'candidate'}_{time.time_ns()}", file)
    module = importlib.util.module_from_spec(spec)
    try:
        if observer and not oracle:
            observer.call(spec.loader.exec_module, module)
        else:
            spec.loader.exec_module(module)
    except C500Error:
        raise
    except Exception as error:
        raise C500Error("METAX_C500_ENTRYPOINT_LOAD_FAILED", str(error), phase="build", role="oracle" if oracle else "candidate") from error
    module._operator_studio_role = "oracle" if oracle else "candidate"
    required = ("run", "reference", "get_test_cases", "get_benchmark_inputs") if oracle else ("run",)
    for name in required:
        if not callable(getattr(module, name, None)):
            raise C500Error("METAX_C500_ENTRYPOINT_INVALID", f"{'Oracle' if oracle else 'Candidate'} lacks {name}.", role="oracle" if oracle else "candidate")
    if observer and not oracle:
        original = module.run
        module.run = lambda inputs: observer.call(original, inputs)
    return module


def _native_required(root, task=None):
    payload = (task or {}).get("payload", task or {})
    declared = payload.get("candidateNativeSources")
    if declared is not None:
        if not isinstance(declared, list) or any(not isinstance(p, str) for p in declared):
            raise C500Error("METAX_C500_NATIVE_CONTRACT_INVALID", "candidateNativeSources must list frozen candidate paths.")
        for path in declared:
            _inside(root, Path(root) / path)
        return bool(declared)
    return any(p.suffix.lower() in (".cu", ".cpp") for p in Path(root).rglob("*") if p.is_file())


def _environment(task, matrix, hardware=None, **kwargs):
    return {"requested": task.get("hardware") or matrix.get("environments") or ["C500"],
            "runtime": "metax-c500-runner/v1", "service": "python-metax-c500", "source": "metax-c500",
            "hardware": "C500", "target": {"platform": "metax-maca", "device": "gpu"},
            "liveHardware": bool(hardware) and not bool(hardware.get("testDouble")), "targetProbe": hardware, "publishable": False,
            "candidateDigest": (task.get("candidate") or {}).get("digest"),
            "diagnosticsMode": kwargs.get("diagnostics_mode"),
            "optionalDiagnostics": {"mctracer": kwargs.get("tracer_status"), "mcProfiler": kwargs.get("profiler_status")}}


def _unverified_diagnostic(name, *args, **kwargs):
    return {"status": "unavailable", "source": "unavailable", "simulated": False,
            "real": False, "attempted": False, "tool": name,
            "error": "MetaX C500 diagnostic tool compatibility has not been verified."}


def run_task(args, *, probe=probe_runtime):
    base = _base()
    original_ports = {name: getattr(base, name) for name in ("_probe_c550", "_environment_record", "_load_operator", "_benchmark_one", "_analysis_tool")}
    task_dir = Path(os.environ.get("OPERATOR_LOCAL_C500_TASK_DIR", "")).resolve()
    result_path = Path(args.result_json or os.environ.get("OPERATOR_LOCAL_C500_RESULT_JSON", str(task_dir / "result.json"))).resolve()
    task, observer, hardware = {}, None, None
    result_owned, execution_started = False, False
    _TIMINGS.clear()
    try:
        if not os.environ.get("OPERATOR_LOCAL_C500_TASK_DIR") or not task_dir.is_dir() or not result_path.is_relative_to(task_dir):
            raise C500Error("METAX_C500_TASK_CONFIG_INVALID", "Owned task root and in-root result path required.", role="contract")
        if result_path.exists():
            raise C500Error("METAX_C500_RESULT_REPLAY", "Existing terminal bytes cannot be reused or overwritten by a new execution.", role="contract")
        result_owned = True
        task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
        payload = task.get("payload", task)
        if task.get("hardware") != ["C500"] or task.get("matrix", {}).get("environments") != ["C500"]:
            raise C500Error("METAX_C500_TARGET_MISMATCH", "Task hardware and matrix must both be exactly C500.", role="contract")
        root = Path(os.environ.get("OPERATOR_PREPARED_PACKAGE_ROOT", str(task_dir))).resolve()
        candidate = _inside(root, args.run_py or os.environ.get("OPERATOR_LOCAL_C500_RUN_PY", str(task_dir / "run.py")))
        oracle_value = os.environ.get("OPERATOR_LOCAL_C500_ORACLE_RUN_PY")
        if not oracle_value:
            raise C500Error("METAX_C500_ORACLE_REQUIRED", "Separate frozen oracle.py is mandatory.", role="oracle")
        oracle = _inside(root, oracle_value)
        if candidate == oracle or os.path.samefile(candidate, oracle):
            raise C500Error("METAX_C500_ORACLE_INVALID", "Candidate cannot be its own oracle.", role="oracle")
        for file, field in ((candidate, "runPy"), (oracle, "oracleRunPy")):
            if isinstance(payload.get(field), str) and file.read_bytes() != payload[field].encode("utf-8"):
                raise C500Error("METAX_C500_SOURCE_CHANGED", "Staged source differs from frozen payload.", role="contract", details={"field": field})
        policy = _version_policy(json.loads(args.versions_json or os.environ.get("OPERATOR_METAX_C500_VERSIONS_JSON", "null")))
        import torch
        hardware = probe(torch, version_policy=policy, mx_smi=args.mx_smi, compiler=args.compiler or os.environ.get("OPERATOR_METAX_C500_COMPILER"))
        required = _native_required(root, task)
        if required and not policy.get("compiler"):
            raise C500Error("METAX_C500_COMPILER_REQUIRED", "Native source needs an explicit compiler pin.", phase="build")
        observer = NativeLoadObserver(root, required); observer.install()
        base._probe_c550 = lambda _torch, _device: hardware
        base._environment_record = _environment
        base._analysis_tool = _unverified_diagnostic
        base._load_operator = lambda file: load_operator(file, root, oracle=Path(file).resolve() == oracle, observer=observer)
        matrix = task.get("matrix") or {}
        base._benchmark_one = lambda module, runtime, inputs, warmup, repeats, **opts: benchmark_one(module, runtime, inputs, matrix.get("warmup", warmup), matrix.get("repeats", repeats), **opts)
        execution_started = True
        base._run(args)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        native = observer.receipt()
        if not native["satisfied"]:
            raise C500Error("METAX_C500_NATIVE_BUILD_MISSING", "Native source loaded no owned extension; PyTorch fallback is not native execution.", phase="build", role="candidate", details=native)
        result.update({"schemaVersion": "operator-studio.metax-c500-result/v1", "publishable": False,
                       "oracleDigest": _sha(oracle), "nativeBuild": native, "timing": list(_TIMINGS)})
        for reading in result.get("benchmark", []):
            reading["timing"] = {"kind": "maca-torch-event", "samplesUnit": "count", "warmupUnit": "count"}
        result["environment"]["oracleDigest"] = _sha(oracle)
        base._write_json_atomic(result_path, result)
        return 0
    except Exception as error:
        existing = {}
        if execution_started:
            try:
                existing = json.loads(result_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        total = (task.get("matrix") or {}).get("correctnessCases", 0)
        record = existing.get("error")
        if isinstance(error, C500Error) and (not record or record.get("code") in ("OPERATOR_MODULE_LOAD_FAILURE", "OPERATOR_BENCHMARK_FAILURE")):
            record = error.record
        if not record:
            record = {"code": "METAX_C500_RUNNER_FAILED", "message": str(error), "phase": "runner", "role": "backend", "retryable": False, "details": {}}
        correctness = existing.get("correctness") or base._not_run_correctness(total)
        result = {**existing, "schemaVersion": "operator-studio.metax-c500-result/v1", "status": "failed", "error": record,
                  "correctness": correctness, "benchmark": [], "publishable": False,
                  "environment": _environment(task, task.get("matrix") or {}, hardware)}
        if observer:
            result["nativeBuild"] = observer.receipt()
        package = base._execution_package(task)
        if package:
            result["executionPackage"] = package; result["environment"]["executionPackage"] = package
        if result_owned and task_dir.is_dir() and result_path.is_relative_to(task_dir):
            base._write_json_atomic(result_path, result)
        else:
            print(json.dumps(record), file=sys.stderr)
        return 1
    finally:
        if observer:
            observer.close()
        for name, port in original_ports.items():
            setattr(base, name, port)


def prepare_package(args):
    policy = _version_policy(json.loads(args.versions_json or "null"))
    observed = probe_runtime(version_policy=policy, mx_smi=args.mx_smi, compiler=args.compiler)
    root = Path(args.package_root).resolve()
    candidate, oracle = _inside(root, args.run_py), _inside(root, args.oracle_py)
    if candidate == oracle or os.path.samefile(candidate, oracle):
        raise C500Error("METAX_C500_ORACLE_INVALID", "Build/load requires an independent oracle.", role="oracle")
    declaration = {"candidateNativeSources": json.loads(args.native_sources_json)} if args.native_sources_json else None
    required = _native_required(root, declaration)
    if required and not policy.get("compiler"):
        raise C500Error("METAX_C500_COMPILER_REQUIRED", "Native build/load needs actual compiler pin.", phase="build")
    observer = NativeLoadObserver(root, required); observer.install()
    try:
        reference = load_operator(oracle, root, oracle=True)
        module = load_operator(candidate, root, observer=observer)
        profiles = reference.get_benchmark_inputs()
        if not isinstance(profiles, list) or not profiles:
            raise C500Error("METAX_C500_PREPARATION_INPUTS_INVALID", "Oracle must provide build/load smoke input.", role="oracle")
        first = profiles[0]
        inputs = first["inputs"] if "inputs" in first else first["make_inputs"]()
        module.run(inputs)
        import torch
        torch.cuda.synchronize()
        native = observer.receipt()
        if not native["satisfied"]:
            raise C500Error("METAX_C500_NATIVE_BUILD_MISSING", "Native candidate loaded no owned extension.", phase="build", role="candidate", details=native)
        # Admission only; no correctness verdict and no process-release claim.
        return {"status": "passed", "candidateLoaded": True, "oracleLoaded": True,
                "independentOracle": True, "targetProbe": observed, "nativeBuild": native,
                "oracleDigest": _sha(oracle), "candidateRunPyDigest": _sha(candidate)}
    finally:
        observer.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("run", "probe", "prepare-package"), default="run")
    for name in ("run-py", "result-json", "oracle-py", "package-root", "versions-json", "mx-smi", "compiler", "native-sources-json"):
        parser.add_argument("--" + name)
    parser.add_argument("--atol", type=float, default=1e-3)
    parser.add_argument("--rtol", type=float, default=1e-3)
    args = parser.parse_args()
    if args.stage == "run":
        return run_task(args)
    try:
        record = {"status": "ready", "observed": probe_runtime(version_policy=json.loads(args.versions_json or "null"), mx_smi=args.mx_smi, compiler=args.compiler)} if args.stage == "probe" else {"status": "ready", "buildLoad": prepare_package(args)}
        print(json.dumps(record)); return 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": error.record if isinstance(error, C500Error) else {"code": "METAX_C500_PREPARATION_FAILED", "message": str(error), "phase": "build", "role": "backend", "retryable": False, "details": {}}})); return 1


if __name__ == "__main__":
    raise SystemExit(main())
