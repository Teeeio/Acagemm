"""CPU-only contract tests. All CUDA/SMI/native loaders below are labelled doubles."""
import argparse
import importlib.util
import json
import math
import os
import platform
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("c500_under_test", ROOT / "tools/metax-c500/runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
base = runner._base()


class Event:
    def __init__(self, owner, **kwargs):
        self.owner = owner
        assert kwargs == {"enable_timing": True}

    def record(self):
        self.owner.recorded += 1

    def synchronize(self):
        self.owner.end_sync += 1

    def elapsed_time(self, end):
        return self.owner.elapsed


class CudaDouble:
    def __init__(self, name="MetaX C500", elapsed=.002):
        self.name, self.elapsed = name, elapsed
        self.recorded = self.end_sync = self.sync = 0

    def is_available(self): return True
    def current_device(self): return 0
    def get_device_name(self, _): return self.name
    def synchronize(self): self.sync += 1
    def Event(self, **kwargs): return Event(self, **kwargs)


class DeviceTensorDouble:
    device = types.SimpleNamespace(type="cuda")
    dtype = "int64"
    shape = (1,)
    def is_floating_point(self): return False


def torch_double(name="MetaX C500"):
    def close(actual, expected, atol, rtol):
        if not math.isclose(actual, expected, abs_tol=atol, rel_tol=rtol):
            raise AssertionError(f"{actual} != {expected}")
    return types.SimpleNamespace(__version__="fixture+metax", cuda=CudaDouble(name),
                                 version=types.SimpleNamespace(maca="fixture-maca"),
                                 Tensor=DeviceTensorDouble, testing=types.SimpleNamespace(assert_close=close))


POLICY = {"python": platform.python_version(), "torch": "fixture+metax",
          "maca": "fixture-maca", "driver": "fixture-driver"}
SMI = "MetaX C500\nDriver Version: fixture-driver\nMACA Version: fixture-maca"


def probe(torch=None, **kwargs):
    return runner.probe_runtime(torch or torch_double(), version_policy=kwargs.get("version_policy", POLICY),
        mx_smi="/fixture/mx-smi", run=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=SMI, stderr=""),
        system=lambda: "Linux")


class RunnerTests(unittest.TestCase):
    def test_identity_version_and_timer_probe(self):
        result = probe()
        self.assertEqual(result["deviceName"], "MetaX C500")
        self.assertEqual(result["versions"]["maca"], "fixture-maca")
        self.assertTrue(result["timer"]["validated"])
        self.assertEqual(result["timer"]["eventUnit"], "ms")
        self.assertTrue(result["runnerDigest"].startswith("sha256:"))

    def test_other_devices_and_unpinned_versions_refused(self):
        for name in ("C550", "C5000", "NVIDIA RTX", "Moore Threads MUSA"):
            with self.subTest(name=name), self.assertRaises(runner.C500Error) as failure:
                probe(torch_double(name))
            self.assertEqual(failure.exception.record["code"], "METAX_C500_DEVICE_MISMATCH")
        with self.assertRaises(runner.C500Error) as failure:
            probe(version_policy={**POLICY, "driver": "wrong"})
        self.assertEqual(failure.exception.record["code"], "METAX_C500_VERSION_MISMATCH")
        with self.assertRaises(runner.C500Error):
            runner.probe_runtime(version_policy={}, system=lambda: "Linux")

    def test_unknown_fork_and_missing_metadata_refused(self):
        torch = torch_double()
        torch.cuda.Event = None
        with self.assertRaises(runner.C500Error) as failure:
            probe(torch)
        self.assertEqual(failure.exception.record["code"], "METAX_C500_TIMER_UNSUPPORTED")
        torch = torch_double()
        torch.__version__ = "fixture-cuda"
        torch.version.maca = None
        with self.assertRaises(runner.C500Error) as failure:
            probe(torch)
        self.assertEqual(failure.exception.record["code"], "METAX_C500_FRAMEWORK_UNKNOWN")
        with self.assertRaises(runner.C500Error) as failure:
            runner.probe_runtime(torch_double(), version_policy=POLICY, mx_smi="/fixture/mx-smi",
                run=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="C500", stderr=""),
                system=lambda: "Linux")
        self.assertEqual(failure.exception.record["code"], "METAX_C500_VERSION_MISMATCH")

    def test_counts_units_sync_and_settlement_use_actual_calls(self):
        calls = []
        torch = torch_double()
        stats = runner.benchmark_one(types.SimpleNamespace(run=lambda x: calls.append(x)),
                                     torch, {"x": 1, "gpu": DeviceTensorDouble()}, 3, 7, max_settlements=3)
        self.assertTrue(stats["settled"])
        self.assertEqual(stats["settlements"], 2)
        self.assertEqual(len(calls), 2 * (3 + 7))
        self.assertEqual(stats["samples"], 7)
        self.assertEqual(stats["p50Us"], 2)
        self.assertEqual(torch.cuda.end_sync, 14)
        self.assertEqual(torch.cuda.sync, 16)
        self.assertEqual(runner._TIMINGS[-1]["measuredInvocations"], 14)

    def test_bad_time_and_invalid_count_never_produce_measurement(self):
        for value in (float("nan"), -1, 0):
            torch = torch_double(); torch.cuda.elapsed = value
            with self.subTest(value=value), self.assertRaises(runner.C500Error):
                runner.benchmark_one(types.SimpleNamespace(run=lambda _: None), torch, {"gpu": DeviceTensorDouble()}, 0, 2)
        for count in (0, -1, True, 1.5):
            with self.subTest(count=count), self.assertRaises(runner.C500Error):
                runner.benchmark_one(types.SimpleNamespace(run=lambda _: None), torch_double(), {}, 0, count)

    def test_original_full_correctness_and_oracle_exception_roles(self):
        cases = [{"name": f"c{i}", "category": "representative", "inputs": {"x": i}} for i in range(24)]
        calls = []
        oracle = types.SimpleNamespace(get_test_cases=lambda: cases, reference=lambda x: x["x"] + 1)
        candidate = types.SimpleNamespace(run=lambda x: calls.append(x["x"]) or x["x"] + 1)
        result = base._run_correctness(candidate, torch_double(), 24, 1e-5, 1e-5, {}, oracle)
        self.assertEqual(result["executedCases"], 24)
        self.assertEqual(result["passedCases"], 24)
        self.assertEqual(calls, list(range(24)))
        candidate.run = lambda x: x["x"] + (2 if x["x"] == 23 else 1)
        result = base._run_correctness(candidate, torch_double(), 24, 1e-5, 1e-5, {}, oracle)
        self.assertEqual(result["failure"]["role"], "candidate")
        self.assertEqual(result["failedCase"], 24)
        def broken_reference(_): raise RuntimeError("oracle fixture fault")
        oracle.reference = broken_reference
        result = base._run_correctness(candidate, torch_double(), 24, 1e-5, 1e-5, {}, oracle)
        self.assertEqual(result["failure"]["role"], "oracle")

    def test_original_required_profiles_not_reduced(self):
        oracle = types.SimpleNamespace(get_benchmark_inputs=lambda: [
            {"name": "large", "inputs": {"x": 1}}, {"name": "small", "inputs": {"x": 2}}])
        spec = {"benchmark": {"requiredProfiles": ["large", "small"], "primaryProfile": "large"}}
        profiles = base._named_benchmark_profiles(oracle, spec)
        self.assertEqual([p["name"] for p in profiles], ["large", "small"])
        oracle.get_benchmark_inputs = lambda: [{"name": "large", "inputs": {}}]
        with self.assertRaises(Exception):
            base._named_benchmark_profiles(oracle, spec)

    def task_fixture(self, directory, candidate="def run(x): return x['x'] + 1\n"):
        root = Path(directory)
        oracle = "import torch\ndef run(x): return x['x'] + 1\nreference = run\ndef get_test_cases(): return [{'name': f'c{i}', 'category': 'representative', 'inputs': {'x': i, 'gpu': torch.Tensor()}} for i in range(24)]\ndef get_benchmark_inputs(): return [{'name': 'large', 'inputs': {'x': 1, 'gpu': torch.Tensor()}}, {'name': 'small', 'inputs': {'x': 2, 'gpu': torch.Tensor()}}]\n"
        (root / "run.py").write_bytes(candidate.encode("utf-8"))
        (root / "oracle.py").write_bytes(oracle.encode("utf-8"))
        task = {"hardware": ["C500"], "candidate": {"digest": "sha256:" + "a"*64},
                "matrix": {"environments": ["C500"], "correctnessCases": 24, "warmup": 0, "repeats": 3,
                           "testSpec": {"correctness": {}, "benchmark": {"requiredProfiles": ["large", "small"], "primaryProfile": "large"}}},
                "payload": {"runPy": candidate, "oracleRunPy": oracle, "packageDigest": "sha256:"+"b"*64}}
        (root / "task.json").write_text(json.dumps(task), encoding="utf-8")
        environment = {"OPERATOR_LOCAL_C500_TASK_DIR": str(root), "OPERATOR_LOCAL_C500_RUN_PY": str(root/"run.py"),
            "OPERATOR_LOCAL_C500_ORACLE_RUN_PY": str(root/"oracle.py"), "OPERATOR_LOCAL_C500_RESULT_JSON": str(root/"result.json"),
            base.DIAGNOSTICS_MODE_ENV: "mock"}
        args = argparse.Namespace(run_py=None, result_json=None, versions_json=json.dumps(POLICY), mx_smi=None,
                                  compiler=None, atol=1e-3, rtol=1e-3)
        return root, environment, args

    def test_wrapper_full_run_and_failed_candidate_return_bound_results(self):
        for bad in (False, True):
            with tempfile.TemporaryDirectory(dir=ROOT/"tools/metax-c500") as directory:
                candidate = "def run(x): return x['x'] + 99\n" if bad else "def run(x): return x['x'] + 1\n"
                root, env, args = self.task_fixture(directory, candidate)
                with patch.dict(os.environ, env), patch.dict(sys.modules, {"torch": torch_double()}):
                    status = runner.run_task(args, probe=lambda *a, **kw: {**probe(torch_double()), "testDouble": True})
                result = json.loads((root/"result.json").read_text("utf-8"))
                self.assertEqual(status, 1 if bad else 0)
                self.assertFalse(result["publishable"])
                self.assertFalse(result["environment"]["publishable"])
                self.assertFalse(result["environment"]["liveHardware"])
                self.assertEqual(result["environment"]["hardware"], "C500")
                self.assertEqual(result["executionPackage"]["packageDigest"], "sha256:"+"b"*64)
                if bad:
                    self.assertEqual(result["error"]["role"], "candidate")
                    self.assertEqual(result["benchmark"], [])
                else:
                    self.assertEqual(result["correctness"]["executedCases"], 24)
                    self.assertEqual([b["profile"] for b in result["benchmark"]], ["large", "small"])
                    self.assertTrue(all(b["samples"] == 3 and b["warmup"] == 0 for b in result["benchmark"]))
                    self.assertEqual(result["oracleDigest"], runner._sha(root/"oracle.py"))

    def test_benchmark_failure_preserves_full_correctness_and_candidate_role(self):
        candidate = "COUNT = 0\ndef run(x):\n global COUNT\n COUNT += 1\n if COUNT > 24: raise RuntimeError('benchmark fixture fault')\n return x['x'] + 1\n"
        with tempfile.TemporaryDirectory(dir=ROOT/"tools/metax-c500") as directory:
            root, env, args = self.task_fixture(directory, candidate)
            with patch.dict(os.environ, env), patch.dict(sys.modules, {"torch": torch_double()}):
                self.assertEqual(runner.run_task(args, probe=lambda *a, **kw: {**probe(torch_double()), "testDouble": True}), 1)
            result = json.loads((root/"result.json").read_text("utf-8"))
            self.assertEqual(result["correctness"]["passedCases"], 24)
            self.assertEqual(result["error"]["phase"], "benchmark")
            self.assertEqual(result["error"]["role"], "candidate")
            self.assertEqual(result["benchmark"], [])

    def test_missing_or_changed_oracle_fails_before_probe(self):
        for condition in ("missing", "same", "changed"):
            with tempfile.TemporaryDirectory(dir=ROOT/"tools/metax-c500") as directory:
                root, env, args = self.task_fixture(directory)
                if condition == "missing": env["OPERATOR_LOCAL_C500_ORACLE_RUN_PY"] = ""
                if condition == "same": env["OPERATOR_LOCAL_C500_ORACLE_RUN_PY"] = str(root/"run.py")
                if condition == "changed": (root/"oracle.py").write_text("raise RuntimeError('must not execute')", encoding="utf-8")
                calls = []
                with patch.dict(os.environ, env):
                    self.assertEqual(runner.run_task(args, probe=lambda *a, **kw: calls.append(1)), 1)
                result = json.loads((root/"result.json").read_text("utf-8"))
                self.assertEqual(calls, [])
                self.assertEqual(result["correctness"]["status"], "not_run")
                self.assertEqual(result["benchmark"], [])

    def test_cpu_only_benchmark_and_existing_result_replay_refused(self):
        with self.assertRaises(runner.C500Error) as failure:
            runner.benchmark_one(types.SimpleNamespace(run=lambda _: 1), torch_double(), {"x": 1}, 0, 2)
        self.assertEqual(failure.exception.record["code"], "METAX_C500_INPUT_DEVICE_MISMATCH")
        with tempfile.TemporaryDirectory(dir=ROOT/"tools/metax-c500") as directory:
            root, env, args = self.task_fixture(directory)
            old = b'{"status":"completed","oldEvidence":true}'
            (root/"result.json").write_bytes(old)
            with patch.dict(os.environ, env):
                self.assertEqual(runner.run_task(args, probe=lambda *a, **kw: self.fail("must not probe")), 1)
            self.assertEqual((root/"result.json").read_bytes(), old)

    def test_native_fallback_and_oracle_load_do_not_count(self):
        with tempfile.TemporaryDirectory(dir=ROOT/"tools/metax-c500") as directory:
            root = Path(directory); artifact = root/"fixture.so"; artifact.write_bytes(b"not a real extension: CPU fixture")
            module = types.SimpleNamespace(__file__=str(artifact))
            extension = types.ModuleType("torch.utils.cpp_extension")
            extension.load = lambda *a, **kw: module
            utility = types.ModuleType("torch.utils"); utility.cpp_extension = extension
            torch = types.ModuleType("torch"); torch.utils = utility
            with patch.dict(sys.modules, {"torch": torch, "torch.utils": utility, "torch.utils.cpp_extension": extension}):
                observer = runner.NativeLoadObserver(root, True); observer.install()
                extension.load()  # oracle side, deliberately outside observer.call
                self.assertFalse(observer.receipt()["satisfied"])
                observer.call(extension.load)
                self.assertTrue(observer.receipt()["satisfied"])
                self.assertEqual(observer.receipt()["artifacts"][0]["digest"], runner._sha(artifact))
                observer.close()


if __name__ == "__main__":
    unittest.main()
