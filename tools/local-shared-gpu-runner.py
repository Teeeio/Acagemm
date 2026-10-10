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

# ---------------------------------------------------------------------------
# 构建环境自举
# ---------------------------------------------------------------------------
#
# 这台机器上「自定义 CUDA kernel 候选能不能真编出来」取决于两件与 CUDA 本身无关的事，
# 而它们都必须在**解释器启动之前**成立：
#
#   1. TMP/TEMP 指向纯 ASCII 路径。用户目录非 ASCII，8.3 短名 `C:\Users\棉被暖~3\...`
#      会让 nvcc 拉起 MSVC 时直接失败：
#      `nvcc fatal : Could not set up the environment for Microsoft Visual Studio`。
#   2. PYTHONUTF8=1。torch 按区域编码（cp936）写 build.ninja，ninja 按 UTF-8 读，
#      中文区域下构建第一步就炸。CPython 的 UTF-8 模式在启动瞬间定死（sys.flags.utf8_mode），
#      进程内改不了，所以只能重新 exec 一次自己。
#   3. PATH 里要有解释器自己所在的 venv 目录。torch 只按 PATH 找 `ninja`
#      （verify_ninja_availability），而生产是用绝对路径直接拉起 `Scripts\python.exe`
#      的，PATH 里从来没有 Scripts——ninja 就装在同一个目录里也照样看不见。这一条不需要
#      重启进程，但必须在 main() 之前生效（main() 里 import torch 之后才用到）。
#
# 放在运行器里而不是 Node 的 spawn 处：两条派生分支里 Windows job-object 那条不接受 env
# 参数，而生产走的正是那条。又因为候选是在**本进程内** exec 的（_load_package_operator），
# PYTHONUTF8 必须落在本进程上，不能只传给某个子进程。
#
# 自举失败时**照常继续**：这两件事只决定 native 构建能不能成，不是任何 Mission 的前提。
# 拿不到 ASCII 临时目录时就按改动前的样子跑，而不是把一个便利变成一个新的失败模式。
_ENV_RELAUNCH_FLAG = "OPERATOR_SHARED_GPU_ENV_RELAUNCHED"


def _is_ascii(value) -> bool:
    try:
        str(value).encode("ascii")
    except UnicodeEncodeError:
        return False
    return True


def _build_temp_root():
    """ASCII 临时目录。可以在仓库外，但**不能**在仓库内——仓库路径本身含中文。"""
    override = os.environ.get("OPERATOR_GPU_BUILD_TMP", "").strip()
    candidates = [override] if override else []
    drive = os.environ.get("SystemDrive", "").strip()
    if not override and drive:
        candidates.append(drive + "\\acagemm-build-tmp")
    for value in candidates:
        if not value or not _is_ascii(value):
            continue
        try:
            resolved = str(Path(value).resolve())
        except OSError:
            continue
        if _is_ascii(resolved):
            return Path(resolved)
    return None


def _ensure_toolchain_path():
    """把解释器自己所在的 venv 目录放到 PATH 最前面。

    同一个 venv 里装了 ninja，但 torch 只在 PATH 上找 `ninja`，而生产是用绝对路径直接
    拉起 `Scripts\\python.exe` 的，PATH 里从来没有 Scripts。结果是每个自定义 C++/CUDA
    扩展候选都停在 `RuntimeError: Ninja is required to load C++ extensions`，而且停在
    写 build.ninja 之前——扩展目录建好了，里面一个文件都没有。候选若把异常吞掉再退回
    纯 PyTorch，正确性与计时全都照过，只是 kernel 从未参与。

    这里补上的正是 activate 本来会做的事：不新增依赖，不改任何冻结契约，也不放宽门限。
    """
    directory = os.path.normcase(os.path.normpath(str(Path(sys.executable).resolve().parent)))
    parts = [part for part in os.environ.get("PATH", "").split(os.pathsep) if part.strip()]
    if directory in {os.path.normcase(os.path.normpath(part)) for part in parts}:
        return
    os.environ["PATH"] = os.pathsep.join([str(Path(sys.executable).resolve().parent), *parts])


def _bootstrap_build_environment():
    """返回子进程退出码；返回 None 表示就在本进程继续。"""
    if os.environ.get(_ENV_RELAUNCH_FLAG):
        # 已经重启过一次。这一次无论环境如何都照常跑，避免 exec 成环。
        return None
    root = _build_temp_root()
    if root is None:
        return None
    temp_ready = all(os.environ.get(name, "") and _is_ascii(os.environ.get(name, "")) for name in ("TMP", "TEMP"))
    if temp_ready and getattr(sys.flags, "utf8_mode", 0):
        return None
    try:
        root.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ)
        environment["TMP"] = str(root)
        environment["TEMP"] = str(root)
        environment["PYTHONUTF8"] = "1"
        environment[_ENV_RELAUNCH_FLAG] = "1"
        return subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]],
            env=environment, cwd=os.getcwd(), check=False,
        ).returncode
    except OSError as error:
        print(f"shared GPU build environment bootstrap skipped: {error}", file=sys.stderr)
        return None


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


# The base runner supplies the settling policy and the rule that enforces it; this
# module only supplies the timing primitive. `main()` sets this before installing
# `_benchmark_one`, so the injected sampler cannot measure without it.
_BASE_RUNNER = None


def _benchmark_one(module, torch, inputs, warmup, repeats, *,
                   settle_tolerance=None, max_settlements=None):
    """CUDA-event settlement of one profile, repeated until two consecutive ones agree.

    Note it is `repeats` that the settling loop takes, not a cheaper probe count: the
    scored settlement must be the declared one, so the number the Gate reads is always
    a full contract settlement and never a reduced one.
    """
    def settle_once():
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

    base = _BASE_RUNNER or _load_base()
    stats, settled, settlements = base._settle_measurements(
        settle_once,
        settle_tolerance if settle_tolerance is not None else base.DEFAULT_SETTLE_TOLERANCE,
        max_settlements if max_settlements is not None else base.DEFAULT_MAX_SETTLEMENTS,
    )
    return {**stats, "settled": settled, "settlements": settlements}


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


# ---------------------------------------------------------------------------
# 原生编译要求
# ---------------------------------------------------------------------------
#
# 原生扩展语言（`client-runtime/operator-language.mjs` 的 `sourceExtensions: ['.cu', '.cpp']`）
# 要求候选工作区里存在 operator.cu，而准备阶段把 `implementationFiles` 原样写进任务目录——
# 「这个候选要被编译」因此是候选自己带进来的事实，不需要再传一个语言参数进来。
#
# 编译发生在**本进程内**：候选的 run.py 由 `_load_package_operator` exec_module，它自己调
# torch.utils.cpp_extension.load 去编译。只有运行器看得见「编译到底有没有发生」，这也正是
# 它必须在这里、而不是在生成侧被检查的原因。
#
# 为什么非查不可：判过的案不是「什么真的跑了」的证据。把 load() 包在 try/except 里、失败就
# 退回纯 PyTorch 的候选，正确性照过、benchmark 甚至更快，判决写着 full_success，而候选自己的
# build_directory 里一个文件都没有。两侧各自的检查都成立——生成侧查 diff 有没有碰到
# operator.cu，执行侧查正确性和计时——没有任何一处查过编译。
#
# 判据是两条取并集：有过一次成功的扩展加载，**或**本次运行新写出了一个编译产物。
#   * 只看文件会误判缓存命中：torch 复用同源构建时不再写盘，而那份产物确实是编出来的；
#   * 只看 load() 会漏掉不经 torch 的构建路线（适配器允许 CMakeLists.txt）。
# 两条都不成立的候选，就是既没编译、也没留下任何编译痕迹。
NATIVE_SOURCE_SUFFIXES = (".cu", ".cpp")
NATIVE_ARTIFACT_SUFFIXES = (".pyd", ".so", ".dll")
NATIVE_BUILD_MISSING = "OPERATOR_NATIVE_BUILD_MISSING"

# 一次运行为一个进程，但候选与 oracle 都会过 _load_operator，所以状态按运行重置。
_NATIVE_BUILD_STATE = {"installed": False, "unavailable": None, "calls": []}


def _compiled_module_file(module):
    """扩展模块背后真实存在的那份编译产物；取不到就返回 None。"""
    path = getattr(module, "__file__", None)
    if not path:
        return None
    candidate = Path(str(path))
    if candidate.suffix.lower() not in NATIVE_ARTIFACT_SUFFIXES:
        return None
    try:
        return str(candidate) if candidate.is_file() else None
    except OSError:
        return None


def _observed_extension_loader(original, api):
    def observed(*args, **kwargs):
        record = {
            "api": api,
            "name": kwargs.get("name") or (args[0] if args else None),
            "buildDirectory": kwargs.get("build_directory"),
        }
        try:
            module = original(*args, **kwargs)
        except BaseException as error:  # noqa: BLE001 - 记录后原样抛出
            record["outcome"] = "raised"
            record["error"] = f"{type(error).__name__}: {error}"
            _NATIVE_BUILD_STATE["calls"].append(record)
            raise
        record["outcome"] = "returned"
        record["moduleFile"] = _compiled_module_file(module)
        _NATIVE_BUILD_STATE["calls"].append(record)
        return module
    observed._operator_studio_observed = True
    return observed


def _install_native_build_observer():
    """包住 torch 的两个扩展加载入口，记录每次调用的结果。

    候选通常在 import 期间调用 load()，而它 import 的时机在 exec_module 之内，所以现在包一定
    早于候选拿到那个函数对象。包住之后，候选**自己吞掉**的异常也留下记录：这是「它为什么没编
    出来」唯一还能拿到的现场。观察不到就照实说观察不到，不假装观察到。
    """
    try:
        import torch.utils.cpp_extension as cpp_extension
    except Exception as error:  # noqa: BLE001
        _NATIVE_BUILD_STATE["unavailable"] = f"{type(error).__name__}: {error}"
        return False
    for api in ("load", "load_inline"):
        original = getattr(cpp_extension, api, None)
        if not callable(original) or getattr(original, "_operator_studio_observed", False):
            continue
        setattr(cpp_extension, api, _observed_extension_loader(original, api))
    _NATIVE_BUILD_STATE["installed"] = True
    return True


def _native_source_files(root):
    try:
        return sorted(
            str(path) for path in Path(root).rglob("*")
            if path.is_file() and path.suffix.lower() in NATIVE_SOURCE_SUFFIXES
        )
    except OSError:
        return []


def _fresh_compiled_artifacts(root, since):
    """本次运行写出（mtime 不早于 since）的编译产物：旧文件不能算成本次的证据。"""
    found = []
    try:
        entries = list(Path(root).rglob("*"))
    except OSError:
        return found
    for path in entries:
        if path.suffix.lower() not in NATIVE_ARTIFACT_SUFFIXES:
            continue
        try:
            if path.is_file() and path.stat().st_mtime >= since:
                found.append(str(path))
        except OSError:
            continue
    return sorted(found)


def _prepare_native_build_observation(task_dir):
    """有原生源文件才装观察器：没有就不必为一个用不到的答案 import torch。"""
    if _native_source_files(task_dir):
        _install_native_build_observer()


def _native_build_observation(task_dir, started_at):
    sources = _native_source_files(task_dir)
    loaded = [
        call for call in _NATIVE_BUILD_STATE["calls"]
        if call.get("outcome") == "returned" and call.get("moduleFile")
    ]
    artifacts = _fresh_compiled_artifacts(task_dir, started_at) if sources else []
    observation = {
        "required": bool(sources),
        "sourceFiles": sources,
        "observerInstalled": bool(_NATIVE_BUILD_STATE["installed"]),
        "calls": [dict(call) for call in _NATIVE_BUILD_STATE["calls"]],
        "loadedExtension": bool(loaded),
        "compiledArtifacts": artifacts,
        "satisfied": not sources or bool(loaded) or bool(artifacts),
    }
    if _NATIVE_BUILD_STATE["unavailable"]:
        observation["observerUnavailable"] = _NATIVE_BUILD_STATE["unavailable"]
    return observation


def _apply_native_build_requirement(result, observation):
    """原生源文件在、编译痕迹不在，就不是这个语言的通过。

    只改判**没有失败**的结果：已经带着 typed failure 的记录一律原样保留，绝不被这里的判断覆盖。
    正确性与计时数字保留不动——它们确实发生过，而「在没有 kernel 的情况下发生」正是要留下的
    证据；error.details 里写明它们不是这个语言的读数。

    判据写成「不是 failed」而不是「是 passed」：基础运行器成功时写的是 `status: "completed"`
    （`local-c500-runner.py`），`passed` 是 correctness 子记录的状态。按后者写，这段判断会永远
    不触发——而那正是这个特性本身要防的那种缺陷（写得像、也从没生效过）。runner 的集成重放
    就是在这里抓到它的。
    """
    result["nativeBuild"] = observation
    if observation["satisfied"] or result.get("status") == "failed":
        return result
    swallowed = [call.get("error") for call in observation["calls"] if call.get("outcome") == "raised"]
    result["status"] = "failed"
    result["error"] = {
        "code": NATIVE_BUILD_MISSING,
        "message": (
            "The candidate ships native extension source but this run produced no compiled extension: "
            "no torch extension load returned a compiled module, and no compiled artifact was written "
            "under the task directory. run.py must build and load the extension with the target machine "
            "toolchain; falling back to a pure-PyTorch implementation is not this language's contract."
        ),
        "phase": "build",
        "role": "candidate",
        "retryable": False,
        "details": {
            "sourceFiles": observation["sourceFiles"],
            "observerInstalled": observation["observerInstalled"],
            "calls": observation["calls"],
            "swallowedFailures": swallowed,
            "note": (
                "Correctness and benchmark readings, when present, were produced without a compiled "
                "extension and are not this implementation language's readings."
            ),
        },
    }
    if observation.get("observerUnavailable"):
        result["error"]["details"]["observerUnavailable"] = observation["observerUnavailable"]
    return result


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


def _failure_result(task_dir: Path, result_path: Path, error, *, candidate=None, oracle=None, runner=None):
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
    correctness = (runner or _load_base())._not_run_correctness(requested_total)
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
    global _BASE_RUNNER
    runner = _load_base()
    _BASE_RUNNER = runner
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
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_RUNNER_CONFIG_INVALID", "message": "task/result paths are required", "phase": "preflight", "role": "contract", "retryable": False, "details": {}}, runner=runner)
    if not oracle_value or oracle is None or not oracle.is_file():
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_ORACLE_REQUIRED", "message": "An independent oracle file is required for every shared-GPU task.", "phase": "preflight", "role": "oracle", "retryable": False, "details": {}} , candidate=candidate, runner=runner)
    if candidate == oracle:
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_ORACLE_INVALID", "message": "Candidate and oracle must be different prepared files.", "phase": "preflight", "role": "oracle", "retryable": False, "details": {}}, candidate=candidate, oracle=oracle, runner=runner)
    # The adapter owns the task directory. Reject host paths even if an env var
    # is tampered with after package admission.
    try:
        candidate.relative_to(task_dir)
        oracle.relative_to(task_dir)
    except ValueError:
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_PATH_INVALID", "message": "Runner inputs must reside inside the prepared package directory.", "phase": "preflight", "role": "contract", "retryable": False, "details": {}}, candidate=candidate, oracle=oracle, runner=runner)
    # The adapter owns this directory: drop any stale terminal record first so a
    # previous success can never mask a preflight or execution failure.
    try:
        if result_path.is_file():
            result_path.unlink()
    except OSError:
        pass
    # 观察器必须在候选执行之前装好（候选的 run.py 在 import 期间就会去编译），
    # 起点则取在候选执行之前，用来把「本次运行新写出的产物」和旧文件分开。
    started_at = time.time()
    _prepare_native_build_observation(task_dir)
    runner._load_operator = lambda file: _load_package_operator(file, package_root=task_dir, oracle=(Path(file).resolve() == oracle))
    status = runner.main()
    if not result_path.is_file():
        # Base runner catches failures and returns 1 without a result file.
        return _failure_result(task_dir, result_path, {"code": "SHARED_GPU_RUNNER_FAILED", "message": "Shared-GPU runner terminated without a result record.", "phase": "runner", "role": "backend", "retryable": False, "details": {"exitCode": status}}, candidate=candidate, oracle=oracle, runner=runner)
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
        task_path = Path(os.environ.get("OPERATOR_LOCAL_C500_TASK_JSON", ""))
        if not task_path.is_file():
            task_path = task_dir / "task.json"
        task = json.loads(task_path.read_text(encoding="utf-8")) if task_path.is_file() else {}
        # 先判编译，再归一化：归一化会按最终 status 决定要不要留经验证据，而一条
        # 「kernel 从未编出来」的记录不该进经验库。
        _apply_native_build_requirement(result, _native_build_observation(task_dir, started_at))
        _normalize_result(result, task if isinstance(task, dict) else {})
        _write_json(result_path, result)
    except Exception as error:
        print(f"shared GPU result normalization failed: {error}", file=sys.stderr)
        return 1
    return status


if __name__ == "__main__":
    # PATH 先修：自举复制的是当前 os.environ，改在自举之后就只能影响父进程了。
    _ensure_toolchain_path()
    # 自举必须在 main() 之前：main() 会 import torch 并 exec 候选，那时 UTF-8 模式已经定死。
    _bootstrap_status = _bootstrap_build_environment()
    raise SystemExit(main() if _bootstrap_status is None else _bootstrap_status)
