"""CPU and injected NPU-port checks only. No driver, compiler or accelerator call."""
import contextlib
import importlib.util
import io
import json
import math
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("ascend910b_adapter", HERE / "runner.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class Events:
    def __init__(self, milliseconds=2.5):
        self.calls, self.milliseconds = [], milliseconds

    def synchronize(self, index):
        self.calls.append(("sync", index))

    def Event(self, enable_timing):
        assert enable_timing
        parent = self
        class Event:
            def record(self):
                parent.calls.append("record")
            def synchronize(self):
                parent.calls.append("event-sync")
            def elapsed_time(self, end):
                parent.calls.append("elapsed-ms")
                return parent.milliseconds
        return Event()


class DiscoveryTests(unittest.TestCase):
    def modules(self, name="Ascend910B2", count=4):
        npu = types.SimpleNamespace(is_available=lambda: True, device_count=lambda: count,
            current_device=lambda: 2, set_device=lambda index: None,
            get_device_name=lambda index: name, synchronize=lambda index: None, Event=Events().Event)
        torch = types.SimpleNamespace(__version__="test-torch")
        module = types.SimpleNamespace(npu=npu, __version__="test-npu")
        utils = types.SimpleNamespace()
        return npu, {"torch": torch, "torch_npu": module, "torch_npu.npu.utils": utils}

    def discover(self, modules, env=None):
        with patch.dict(os.environ, env or {}, clear=True), patch.object(adapter.platform, "system", return_value="Linux"), patch.object(adapter.importlib, "import_module", side_effect=modules.__getitem__):
            return adapter.discover_runtime()

    def test_selected_logical_device_not_zero(self):
        npu, modules = self.modules()
        with patch.object(npu, "set_device") as selected, patch.object(npu, "get_device_name", return_value="Ascend 910B2") as name:
            runtime = self.discover(modules)
        selected.assert_called_once_with(2)
        name.assert_called_once_with(2)
        self.assertEqual(runtime.index, 2)
        self.assertIsNone(runtime.probe["driverVersion"])
        self.assertNotIn("architecture", runtime.probe)

    def test_explicit_index(self):
        _, modules = self.modules()
        self.assertEqual(self.discover(modules, {"OPERATOR_ASCEND_DEVICE_INDEX": "3"}).index, 3)

    def test_wrong_target_and_invalid_index(self):
        for name in ("Ascend910", "Ascend910A", "Ascend910C", "CPU", "Ascend910Bad"):
            with self.subTest(name=name), self.assertRaises(adapter.AdapterError) as caught:
                self.discover(self.modules(name)[1])
            self.assertEqual(caught.exception.record["code"], "ASCEND_DEVICE_MISMATCH")
        for index in ("-1", "4", "banana"):
            with self.subTest(index=index), self.assertRaises(adapter.AdapterError):
                self.discover(self.modules()[1], {"OPERATOR_ASCEND_DEVICE_INDEX": index})

    def test_missing_api_unavailable_and_dependency(self):
        npu, modules = self.modules()
        del npu.Event
        with self.assertRaises(adapter.AdapterError) as caught:
            self.discover(modules)
        self.assertEqual(caught.exception.record["code"], "ASCEND_API_UNAVAILABLE")
        npu, modules = self.modules()
        npu.is_available = lambda: False
        with self.assertRaises(adapter.AdapterError) as caught:
            self.discover(modules)
        self.assertEqual(caught.exception.record["code"], "ASCEND_DEVICE_UNAVAILABLE")
        with self.assertRaises(adapter.AdapterError) as caught:
            self.discover({})
        self.assertEqual(caught.exception.record["code"], "ASCEND_DEPENDENCY_UNAVAILABLE")

    def test_hardware_disable_precedes_import(self):
        with patch.dict(os.environ, {"OPERATOR_HARDWARE_DISABLED": "1"}), patch.object(adapter.importlib, "import_module", side_effect=AssertionError("no imports")):
            with self.assertRaises(adapter.AdapterError) as caught:
                adapter.discover_runtime()
        self.assertEqual(caught.exception.record["code"], "ASCEND_HARDWARE_DISABLED")

    def test_metadata_preflight_never_imports_runtime(self):
        with patch.object(adapter.importlib, "import_module", side_effect=AssertionError("no runtime imports")):
            report = adapter.metadata_preflight()
        self.assertFalse(report["liveHardware"])
        self.assertFalse(report["deviceProbed"])
        self.assertFalse(report["publishable"])
        self.assertIn("unverified", report["compatibility"])


ORACLE = '''import torch
def get_test_cases():
    return [{"name": name, "category": category, "make_inputs": lambda n=n: {"x": torch.tensor([n, n + 1.])}}
            for n, name, category in [(1., "small", "minimal"), (2., "normal", "representative"), (3., "edge", "boundary")]]
def reference(inputs):
    return inputs["x"] * 2
def run(inputs):
    raise AssertionError("oracle.run is not the independent reference")
def get_benchmark_inputs():
    return [{"name": name, "inputs": {"x": torch.tensor([1., 2.])}} for name in ["primary", "small"]]
'''
CANDIDATE = 'def run(inputs):\n    return inputs["x"] * 2\n'


class CpuExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Importing CPU tensor operations only; never invoke torch.cuda or torch_npu.
        import torch
        cls.torch = torch
        for name in ("is_available", "device_count", "current_device", "set_device", "synchronize", "init", "_lazy_init"):
            guard = patch.object(torch.cuda, name, side_effect=AssertionError(f"CPU verification forbids CUDA {name}"))
            guard.start()
            cls.addClassCleanup(guard.stop)
        cls.parent = ROOT / "output" / "ascend910b-tests"
        cls.parent.mkdir(parents=True, exist_ok=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cpu-", dir=self.parent)
        self.root = Path(self.temp.name).resolve()
        assert self.root.is_relative_to(self.parent.resolve())
        self.addCleanup(self.temp.cleanup)
        # cpp_extension's real import may probe CUDA; compilation/load APIs are
        # fully injected here, not merely the compiler invocation.
        extension = types.ModuleType("torch.utils.cpp_extension")
        def forbidden_build(*args, **kwargs):
            raise AssertionError("CPU verification forbids real compilation")
        extension.load = forbidden_build
        extension.load_inline = forbidden_build
        injected = patch.dict(sys.modules, {"torch.utils.cpp_extension": extension})
        injected.start()
        self.addCleanup(injected.stop)
        self.events = Events()
        self.runtime = adapter.NpuRuntime(self.torch, self.events,
            {"deviceIndex": 0, "deviceName": "CPU SIMULATION, not an Ascend probe"}, device_type="cpu")
        self.candidate, self.oracle = self.root / "run.py", self.root / "oracle.py"
        self.candidate.write_text(CANDIDATE, encoding="utf-8")
        self.oracle.write_text(ORACLE, encoding="utf-8")
        self.task = {"matrix": {"correctnessCases": 3, "warmup": 1, "repeats": 2,
                     "environments": ["Ascend910B"], "maxSettlements": 3,
                     "testSpec": {"correctness": {"requiredCategories": ["minimal", "representative", "boundary"], "atol": 1e-6, "rtol": 1e-6},
                                  "benchmark": {"requiredProfiles": ["primary", "small"], "primaryProfile": "primary"}}},
                     "payload": {"missionId": "CPU-ONLY", "requestId": "cpu-request",
                                 "candidate": {"id": "cpu-candidate", "digest": "sha256:" + "1" * 64},
                                 "packageDigest": "sha256:" + "2" * 64, "acceptanceDigest": "sha256:" + "3" * 64,
                                 "environmentDigest": "sha256:" + "4" * 64, "preparedArtifactDigest": "sha256:" + "5" * 64}}

    def run_case(self, runtime_factory=None):
        (self.root / "task.json").write_text(json.dumps(self.task), encoding="utf-8")
        with patch.dict(os.environ, {"OPERATOR_HARDWARE_DISABLED": "1", "OPERATOR_DIAGNOSTICS_MODE": "unavailable"}), contextlib.redirect_stderr(io.StringIO()):
            code = adapter.execute(self.root, self.candidate, self.oracle, self.root / "result.json",
                                   runtime_factory=runtime_factory or (lambda: self.runtime))
        result = json.loads((self.root / "result.json").read_text(encoding="utf-8"))
        self.assertFalse(result["publishable"])
        self.assertFalse(result["environment"]["liveHardware"])
        self.assertNotIn("experienceEvidence", result)
        return code, result

    def test_complete_frozen_matrix_and_binding_cpu_simulation(self):
        code, result = self.run_case()
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(result["correctness"]["executedCases"], 3)
        self.assertEqual([row["profile"] for row in result["benchmark"]], ["primary", "small"])
        self.assertEqual(result["executionPackage"]["packageDigest"], self.task["payload"]["packageDigest"])
        self.assertEqual(result["executionPackage"]["acceptanceDigest"], self.task["payload"]["acceptanceDigest"])
        self.assertEqual(result["environment"]["executionMode"], "simulation")
        self.assertTrue(result["environment"]["simulated"])
        self.assertTrue(all(row["value"] == 2500. and row["samples"] == 2 and row["settlements"] == 2 for row in result["benchmark"]))
        self.assertEqual(result["tracer"]["status"], "unavailable")
        self.assertTrue((self.root / "environment-manifest.json").is_file())
        for i, call in enumerate(self.events.calls):
            if call == "elapsed-ms":
                self.assertEqual(self.events.calls[i - 1], "event-sync")

    def test_mismatch_preserves_executed_prefix_and_no_benchmark(self):
        self.candidate.write_text('def run(inputs):\n    x = inputs["x"]\n    return x * (2 if x[0].item() == 1 else 9)\n', encoding="utf-8")
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "OPERATOR_CORRECTNESS_MISMATCH")
        self.assertEqual(result["correctness"]["executedCases"], 2)
        self.assertEqual(result["correctness"]["passedCases"], 1)
        self.assertEqual(result["benchmark"], [])

    def test_candidate_exception_is_not_dependency_failure(self):
        self.candidate.write_text('def run(inputs):\n    raise RuntimeError("candidate-boom")\n', encoding="utf-8")
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "OPERATOR_CANDIDATE_EXCEPTION")
        self.assertEqual(result["error"]["role"], "candidate")
        self.assertIn("candidate-boom", result["error"]["message"])

    def test_oracle_failure_not_candidate_failure(self):
        self.oracle.write_text(ORACLE.replace('return inputs["x"] * 2', 'raise RuntimeError("oracle-boom")'), encoding="utf-8")
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["role"], "oracle")
        self.assertEqual(result["benchmark"], [])

    def test_missing_dependency_replaces_stale_success(self):
        (self.root / "result.json").write_text('{"status":"completed","publishable":true}', encoding="utf-8")
        def missing():
            adapter.fail("ASCEND_DEPENDENCY_UNAVAILABLE", "torch_npu missing")
        code, result = self.run_case(missing)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_DEPENDENCY_UNAVAILABLE")
        self.assertEqual(result["correctness"]["executedCases"], 0)
        self.assertEqual(result["benchmark"], [])

    def test_cpu_fallback_rejected_for_real_npu_contract(self):
        self.runtime.device_type = "npu"
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertIn("npu:0", result["error"]["message"])
        self.assertEqual(result["error"]["role"], "oracle")

    def test_same_oracle_and_escape_refused_before_runtime(self):
        self.oracle = self.candidate
        def forbidden():
            raise AssertionError("runtime should never be created")
        code, result = self.run_case(forbidden)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_ORACLE_REQUIRED")
        self.oracle = self.root / "oracle.py"
        self.candidate = self.root.parent / "outside.py"
        code, result = self.run_case(forbidden)
        self.assertEqual(result["error"]["code"], "ASCEND_PATH_INVALID")

    def test_entrypoint_digest_drift_fails(self):
        self.task["runPyDigest"] = "0" * 64
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_CANDIDATE_DIGEST_MISMATCH")

    def test_missing_cases_and_profile_not_reduced(self):
        self.task["matrix"]["correctnessCases"] = 4
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["role"], "oracle")
        self.task["matrix"]["correctnessCases"] = 3
        self.task["matrix"]["testSpec"]["benchmark"]["requiredProfiles"].append("missing")
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["correctness"]["passedCases"], 3)
        self.assertIn("missing", result["error"]["message"])

    def test_invalid_timer_preserves_correctness(self):
        for value in (0, -1, math.nan, math.inf):
            with self.subTest(value=value):
                self.events.milliseconds = value
                code, result = self.run_case()
                self.assertEqual(code, 1)
                self.assertEqual(result["correctness"]["passedCases"], 3)
                self.assertEqual(result["error"]["phase"], "benchmark")
                self.assertEqual(result["benchmark"], [])

    def test_native_source_without_load_cannot_pass(self):
        (self.root / "operator.cpp").write_text("// declared native source, no build", encoding="utf-8")
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_NATIVE_BUILD_MISSING")
        self.assertFalse(result["nativeBuild"]["satisfied"])
        self.assertEqual(result["correctness"]["passedCases"], 3)

    def test_swallowed_build_dependency_error_cannot_pass(self):
        (self.root / "operator.cpp").write_text("// no native build", encoding="utf-8")
        self.candidate.write_text('from operator_studio_ascend import load_npu_extension\ntry:\n    extension = load_npu_extension("candidate", ["operator.cpp"])\nexcept Exception:\n    pass\n' + CANDIDATE, encoding="utf-8")
        with patch.object(adapter.shutil, "which", return_value=None):
            code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_NATIVE_BUILD_MISSING")
        self.assertIn("compiler is unavailable", result["nativeBuild"]["errors"][0])

    def test_shape_dtype_mutation_and_profile_shape_rules_remain(self):
        self.task["matrix"]["testSpec"]["correctness"]["tensors"] = {
            "inputs": [{"name": "x", "shape": [2], "dtype": "float32"}],
            "outputs": [{"name": "output", "shape": [2], "dtype": "float32"}]}
        code, result = self.run_case()
        self.assertEqual(code, 0, result.get("error"))
        # Use the base's tensor schema rather than weaken a frozen declaration.
        for body in ('return inputs["x"][:1]', 'return inputs["x"].double() * 2',
                     'inputs["x"].add_(1)\n    return inputs["x"] * 2'):
            self.candidate.write_text('def run(inputs):\n    ' + body + '\n', encoding="utf-8")
            code, result = self.run_case()
            self.assertEqual(code, 1)
            self.assertEqual(result["benchmark"], [])
            self.assertEqual(result["error"]["code"], "OPERATOR_CORRECTNESS_MISMATCH")
            self.assertEqual(result["error"]["role"], "candidate")
        self.candidate.write_text(CANDIDATE, encoding="utf-8")
        self.task["matrix"]["testSpec"]["benchmark"]["shapes"] = [{"name": "primary", "inputShapes": {"x": [3]}}]
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "OPERATOR_BENCHMARK_SHAPE_MISMATCH")
        self.assertEqual(result["correctness"]["passedCases"], 3)

    def test_native_observer_preserves_throw_and_ignores_oracle(self):
        (self.root / "operator.cpp").write_text("// CPU fixture", encoding="utf-8")
        library = self.root / "fixture.so"
        library.write_bytes(b"CPU fixture, not a loadable library")
        with patch.object(self.torch.ops, "load_library", return_value=None):
            with adapter.NativeLoads(self.root, self.torch) as observer:
                self.torch.ops.load_library(str(library))
                self.assertFalse(observer.observation()["satisfied"])
                with observer.candidate():
                    self.torch.ops.load_library(str(library))
                self.assertTrue(observer.observation()["satisfied"])
                self.assertEqual(observer.observation()["loads"][0]["digest"], adapter.digest(library))
        with patch.object(self.torch.ops, "load_library", side_effect=RuntimeError("compiler/load failure")):
            with adapter.NativeLoads(self.root, self.torch) as observer, observer.candidate():
                with self.assertRaisesRegex(RuntimeError, "compiler/load failure"):
                    self.torch.ops.load_library(str(library))
                self.assertEqual(observer.errors, ["compiler/load failure"])

    def test_environment_restored_and_cache_is_task_owned(self):
        before, cwd = dict(os.environ), Path.cwd()
        code, _ = self.run_case()
        self.assertEqual(code, 0)
        self.assertEqual(dict(os.environ), before)
        self.assertEqual(Path.cwd(), cwd)
        self.assertTrue((self.root / ".ascend-cache" / "reference").is_dir())

    def test_cache_and_logs_precede_runtime_initialization(self):
        def check_runtime():
            for name in ("TORCH_EXTENSIONS_DIR", "ASCEND_CACHE_PATH", "ACL_OP_COMPILER_CACHE_DIR", "ASCEND_WORK_PATH", "ASCEND_PROCESS_LOG_PATH", "TMPDIR"):
                self.assertTrue(Path(os.environ[name]).resolve().is_relative_to(self.root), name)
            self.assertTrue(Path(tempfile.gettempdir()).is_relative_to(self.root))
            return self.runtime
        code, _ = self.run_case(check_runtime)
        self.assertEqual(code, 0)

    def test_same_run_entrypoint_drift_cannot_pass(self):
        self.candidate.write_text('from pathlib import Path\ndef run(inputs):\n    Path(__file__).write_text("changed")\n    return inputs["x"] * 2\n', encoding="utf-8")
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_INPUT_CHANGED_DURING_RUN")
        self.assertEqual(result["inputIntegrity"]["changedFiles"], [str(self.candidate)])

    def test_malformed_task_and_missing_oracle_env_persist_failure(self):
        self.task = []
        code, result = self.run_case()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_TASK_INVALID")
        (self.root / "task.json").write_text("{}", encoding="utf-8")
        with patch.dict(os.environ, {"OPERATOR_LOCAL_C500_TASK_DIR": str(self.root),
                "OPERATOR_LOCAL_C500_RUN_PY": str(self.candidate), "OPERATOR_LOCAL_C500_RESULT_JSON": str(self.root / "result.json")}, clear=True):
            self.assertEqual(adapter.main([]), 1)
        self.assertEqual(json.loads((self.root / "result.json").read_text())["error"]["code"], "ASCEND_ORACLE_REQUIRED")

    def test_prepared_dependency_drift_prevents_hardware_access(self):
        source = self.root / "helper.py"
        source.write_text("value = 2\n", encoding="utf-8")
        self.task["payload"]["implementationFiles"] = {"helper.py": "value = 1\n"}
        code, result = self.run_case(lambda: self.fail("No hardware before integrity check"))
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "ASCEND_PACKAGE_FILE_CHANGED")

    def test_cpp_loader_uses_installed_npu_link_metadata_and_no_cuda(self):
        source = self.root / "operator.cpp"
        source.write_text("// no compiler is invoked by this test", encoding="utf-8")
        calls = []
        metadata = types.SimpleNamespace(include_dirs=["installed-npu/include"],
                                        library_dirs=["installed-npu/lib"], libraries=["torch_npu"])
        fake_api = types.SimpleNamespace(is_ninja_available=lambda: True,
                                         load=lambda **kwargs: calls.append(kwargs) or "fixture")
        modules = {"torch.utils.cpp_extension": fake_api,
                   "torch_npu.utils.cpp_extension": types.SimpleNamespace(NpuExtension=lambda *args: metadata)}
        with patch.object(adapter.shutil, "which", return_value="/fixture/c++"), patch.object(adapter.importlib, "import_module", side_effect=modules.__getitem__):
            self.assertEqual(adapter.load_npu_extension(self.root, "cpu_fixture", ["operator.cpp"]), "fixture")
        self.assertFalse(calls[0]["with_cuda"])
        self.assertIn("-ltorch_npu", calls[0]["extra_ldflags"])
        self.assertTrue(Path(calls[0]["build_directory"]).is_relative_to(self.root))
        with patch.object(adapter.shutil, "which", return_value=None):
            with self.assertRaises(adapter.AdapterError) as caught:
                adapter.load_npu_extension(self.root, "cpu_fixture", ["operator.cpp"])
        self.assertEqual(caught.exception.record["code"], "ASCEND_COMPILER_UNAVAILABLE")
        with self.assertRaises(adapter.AdapterError):
            adapter.load_npu_extension(self.root, "cpu_fixture", ["../outside.cpp"])

    def test_terminal_json_writes_use_atomic_replace(self):
        replacements = []
        original = os.replace
        def replace(source, destination):
            replacements.append(Path(destination).name)
            return original(source, destination)
        with patch.object(os, "replace", side_effect=replace):
            code, _ = self.run_case()
        self.assertEqual(code, 0)
        for name in ("result.json", "correctness.json", "environment-manifest.json"):
            self.assertIn(name, replacements)


if __name__ == "__main__":
    unittest.main(verbosity=2)
