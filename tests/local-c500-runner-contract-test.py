import importlib.util
import os
import sys
import tempfile
from pathlib import Path


runner_path = Path(__file__).resolve().parents[1] / "tools" / "local-c500-runner.py"
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

print("[local-c500-runner-contract] generated correctness and benchmark profiles passed")
