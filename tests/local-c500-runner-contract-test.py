import importlib.util
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

print("[local-c500-runner-contract] generated correctness and benchmark profiles passed")
