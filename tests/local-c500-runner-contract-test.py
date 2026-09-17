import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch


runner_path = Path(__file__).resolve().parents[1] / "tools" / "local-c500-runner.py"
assert "contentDigest" in runner_path.read_text(encoding="utf-8")
spec = importlib.util.spec_from_file_location("local_c500_runner", runner_path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FakeCuda:
    @staticmethod
    def synchronize():
        return None


class FakeTesting:
    @staticmethod
    def assert_close(actual, expected, atol, rtol):
        assert actual == expected


class FakeTorch:
    cuda = FakeCuda()
    testing = FakeTesting()


class GeneratedOperator:
    @staticmethod
    def get_inputs():
        return {"value": 1}

    @staticmethod
    def get_test_cases():
        return [
            {"name": "minimal", "category": "minimal", "inputs": {"value": 1}},
            {"name": "representative", "category": "representative", "inputs": {"value": 2}},
            {"name": "boundary", "category": "boundary", "inputs": {"value": 3}},
            {"name": "ragged", "category": "ragged", "inputs": {"value": 4}},
        ]

    @staticmethod
    def get_benchmark_inputs():
        return [
            {"name": "primary", "inputs": {"value": 2}},
            {"name": "small", "inputs": {"value": 1}},
            {"name": "boundary", "inputs": {"value": 4}},
        ]

    @staticmethod
    def run(inputs):
        return inputs["value"]

    reference = run


test_spec = {
    "correctness": {"requiredCategories": ["minimal", "representative", "boundary", "ragged"]},
    "benchmark": {"requiredProfiles": ["primary", "small", "boundary"], "primaryProfile": "primary"},
}
correctness = runner._run_correctness(GeneratedOperator, FakeTorch, 4, 1e-3, 1e-3, test_spec)
assert correctness["passed"] is True
assert correctness["caseNames"] == ["minimal", "representative", "boundary", "ragged"]
profiles = runner._named_benchmark_profiles(GeneratedOperator, test_spec)
assert [profile["name"] for profile in profiles] == ["primary", "small", "boundary"]


class SelfConsistentButWrongCandidate(GeneratedOperator):
    @staticmethod
    def run(inputs):
        return -1

    reference = run


caught = runner._run_correctness(SelfConsistentButWrongCandidate, FakeTorch, 4, 1e-3, 1e-3, test_spec, GeneratedOperator)
assert caught["passed"] is False
assert caught["failedCaseName"] == "minimal"

cache_context = {
    "profileId": "paged-mqa-logits-triton-v01",
    "testSpec": test_spec,
    "seed": 20260827,
    "oracleDigest": "a" * 64,
    "pythonVersion": "3.12.11",
    "torchVersion": "2.8.0+metax3.3.0.2",
    "deviceName": "MetaX C550",
}
cache_case = {"name": "mqa_s1-float32", "category": "fixed-profile"}
cache_key = runner._reference_cache_key(cache_case, {"value": 1}, FakeTorch, cache_context)
assert cache_key == runner._reference_cache_key(cache_case, {"value": 1}, FakeTorch, cache_context)
assert cache_key != runner._reference_cache_key(cache_case, {"value": 1}, FakeTorch, {**cache_context, "oracleDigest": "b" * 64})
assert cache_key != runner._reference_cache_key(cache_case, {"value": 1}, FakeTorch, {**cache_context, "deviceName": "MetaX C500"})

with tempfile.TemporaryDirectory() as temporary_directory:
    missing = runner._analysis_tool(
        "definitely-missing-analysis-tool",
        "OPERATOR_TEST_MISSING_TOOL_COMMAND",
        '"{tool}"',
        {},
        Path(temporary_directory) / "missing",
    )
    assert missing["status"] == "unavailable"
    assert missing["attempted"] is True

    os.environ["OPERATOR_TEST_FAILING_TOOL_COMMAND"] = f'"{sys.executable}" -c "import sys; sys.exit(7)"'
    failed = runner._analysis_tool(
        "definitely-missing-analysis-tool",
        "OPERATOR_TEST_FAILING_TOOL_COMMAND",
        '"{tool}"',
        {},
        Path(temporary_directory) / "failed",
    )
    assert failed["status"] == "failed"
    assert failed["exitCode"] == 7
    del os.environ["OPERATOR_TEST_FAILING_TOOL_COMMAND"]

with tempfile.TemporaryDirectory() as status_directory:
    directory = Path(status_directory)
    runner._write_runner_status(directory, 10, "before", "complete old record")
    target = directory / "runner-status.json"
    original = target.read_bytes()
    # Unclassified permission failures are not silently retried or swallowed.
    error = PermissionError("not a classified Windows sharing error")
    with patch.object(runner.os, "replace", side_effect=error) as replace, patch.object(runner.time, "sleep", side_effect=AssertionError("unexpected retry")):
        try:
            runner._write_runner_status(directory, 20, "after", "complete new record")
        except PermissionError as caught:
            assert caught is error
        else:
            raise AssertionError("Expected the original write error")
        assert replace.call_count == 1
    assert target.read_bytes() == original

    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL

        def deny_replace():
            # Share reads/writes, but not deletion/replacement. No GPU/Agent.
            handle = kernel.CreateFileW(str(target), 0x80000000, 3, None, 3, 128, None)
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            return handle

        handle = deny_replace()
        observed = []

        def release_later():
            try:
                time.sleep(0.12)
                observed.append(target.read_bytes())
            finally:
                kernel.CloseHandle(handle)

        thread = threading.Thread(target=release_later)
        thread.start()
        try:
            runner._write_runner_status(directory, 20, "after", "complete new record")
        finally:
            thread.join(timeout=5)
        assert not thread.is_alive()
        assert observed == [original], "the old complete JSON survives until replacement"
        assert json.loads(target.read_text(encoding="utf-8"))["progress"] == 20

        # A permanent lock must still fail within the bounded retry window.
        original = target.read_bytes()
        handle = deny_replace()
        started = time.monotonic()
        try:
            try:
                runner._write_runner_status(directory, 30, "blocked", "must not appear")
            except PermissionError as caught:
                assert caught.winerror in (5, 32, 33)
            else:
                raise AssertionError("A persistent sharing violation must fail closed")
        finally:
            kernel.CloseHandle(handle)
        assert 0.9 <= time.monotonic() - started < 5
        assert target.read_bytes() == original
        print("[local-c500-runner-contract] real Windows short/permanent locks and atomic status passed")

print("[local-c500-runner-contract] generated correctness, benchmark profiles and status failure boundaries passed")
