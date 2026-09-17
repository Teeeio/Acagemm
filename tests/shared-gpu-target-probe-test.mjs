// Hardware-free contract test for driver-resolved architecture in the shared-GPU runner.
// A Python child imports the real runner and replaces subprocess/shutil with explicit
// doubles, so no GPU, driver, torch install or nvidia-smi process is ever touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePythonExecutable } from '../client-runtime/platform-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'tools', 'local-shared-gpu-runner.py');
const python = resolvePythonExecutable({ rootDir: root });
const EXPECTED_CHECKS = 15;
const MARKER = '__SHARED_GPU_PROBE_RESULTS__';

const harness = String.raw`
import importlib.util
import json
import os
import sys
import types
import traceback
from pathlib import Path

RUNNER = Path(sys.argv[1]).resolve()
results = []


def record(name, check):
    try:
        check()
    except Exception as error:  # noqa: BLE001 - the summary must report every failure
        results.append({"name": name, "passed": False, "detail": f"{type(error).__name__}: {error}\n{traceback.format_exc()}"})
    else:
        results.append({"name": name, "passed": True, "detail": ""})


spec = importlib.util.spec_from_file_location("shared_gpu_runner_under_test", RUNNER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Completed:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


GPU_LINE = "NVIDIA GeForce RTX 3060 Laptop GPU, 551.78, 6144"


class FakeTorch:
    __version__ = "2.4.1"
    version = types.SimpleNamespace(cuda="12.1")


def install_subprocess(run):
    module.subprocess = types.SimpleNamespace(run=run)


def install_shutil(which_result):
    module.shutil = types.SimpleNamespace(which=lambda name: which_result)


def set_nvidia_smi(value):
    if value is None:
        os.environ.pop("OPERATOR_GPU_NVIDIA_SMI", None)
    else:
        os.environ["OPERATOR_GPU_NVIDIA_SMI"] = value


def assert_eq(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def fake_run_for(compute_cap):
    def run(cmd, **kwargs):
        query = next((str(part) for part in cmd if str(part).startswith("--query-gpu=")), "")
        if "compute_cap" in query:
            if isinstance(compute_cap, Exception):
                raise compute_cap
            if compute_cap is None:
                return Completed(stdout="", stderr="unsupported", returncode=0)
            return Completed(stdout=compute_cap, returncode=0)
        return Completed(stdout=GPU_LINE + "\n", returncode=0)
    return run


def failing_run(returncode, stderr):
    def run(cmd, **kwargs):
        query = next((str(part) for part in cmd if str(part).startswith("--query-gpu=")), "")
        if "compute_cap" in query:
            return Completed(stdout="", stderr=stderr, returncode=returncode)
        return Completed(stdout=GPU_LINE + "\n", returncode=0)
    return run


def run_main_with_probe(probe_value=None, legacy=False):
    result_path = Path(os.environ["OPERATOR_LOCAL_C500_RESULT_JSON"])

    def base_main():
        hardware = "nvidia-gpu" if legacy else (
            probe_value if probe_value is not None else module._probe_nvidia(FakeTorch, 0)
        )
        payload = {
            "schemaVersion": "operator-studio.shared-gpu-result/v1",
            "status": "completed",
            "correctness": {"status": "passed", "passed": True, "total": 0, "executedCases": 0, "passedCases": 0, "caseResults": []},
            "benchmark": [],
            "environment": {"requested": ["local-shared-gpu"], "hardware": hardware},
            "publishable": False,
        }
        result_path.write_text(json.dumps(payload), encoding="utf-8")
        return 0

    base = types.SimpleNamespace(main=base_main)
    module._load_base = lambda: base
    return module.main()


def read_result():
    return json.loads(Path(os.environ["OPERATOR_LOCAL_C500_RESULT_JSON"]).read_text(encoding="utf-8"))


def resolve_sm86():
    set_nvidia_smi("/fake/nvidia-smi")
    install_subprocess(fake_run_for("8.6\n"))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, "sm86", "driver compute_cap 8.6")
    assert_eq(note, None, "note")


def resolve_sm75():
    install_subprocess(fake_run_for("7.5\n"))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, "sm75", "driver compute_cap 7.5")
    assert_eq(note, None, "note")


def resolve_unsupported():
    install_subprocess(fake_run_for(None))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, None, "unsupported compute_cap output")
    if "did not expose compute_cap" not in str(note):
        raise AssertionError(f"note must explain the missing compute_cap: {note!r}")


def resolve_error():
    install_subprocess(failing_run(1, "unknown query"))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, None, "driver query failure")
    if "did not expose compute_cap" not in str(note):
        raise AssertionError(f"unexpected note: {note!r}")


def resolve_malformed():
    install_subprocess(fake_run_for("not-a-number\n"))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, None, "malformed compute_cap")
    if "unexpected compute_cap value" not in str(note):
        raise AssertionError(f"unexpected note: {note!r}")


def resolve_no_decimal():
    install_subprocess(fake_run_for("86\n"))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, None, "compute_cap without major.minor")
    if "unexpected compute_cap value" not in str(note):
        raise AssertionError(f"unexpected note: {note!r}")


def resolve_exception():
    install_subprocess(fake_run_for(RuntimeError("spawn failed")))
    architecture, note = module._resolve_architecture("/fake/nvidia-smi")
    assert_eq(architecture, None, "exploding probe")
    if "compute capability query failed" not in str(note):
        raise AssertionError(f"unexpected note: {note!r}")


def probe_success():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")
    install_subprocess(fake_run_for("8.6\n"))
    result = module._probe_nvidia(FakeTorch, 0)
    assert_eq(result["tool"], "/fake/nvidia-smi", "tool")
    assert_eq(result["deviceName"], "NVIDIA GeForce RTX 3060 Laptop GPU", "deviceName")
    assert_eq(result["driverVersion"], "551.78", "driverVersion")
    assert_eq(result["memoryMiB"], 6144, "memoryMiB")
    assert_eq(result["torchVersion"], "2.4.1", "torchVersion")
    assert_eq(result["cudaVersion"], "12.1", "cudaVersion")
    assert_eq(result["architecture"], "sm86", "architecture")
    if "architectureNote" in result:
        raise AssertionError("a resolved architecture must not carry a fallback note")


def probe_never_infers_from_name():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")
    def run(cmd, **kwargs):
        query = next((str(part) for part in cmd if str(part).startswith("--query-gpu=")), "")
        if "compute_cap" in query:
            return Completed(stdout="", returncode=0)
        return Completed(stdout="NVIDIA H100 80GB HBM3, 550.54, 81559\n", returncode=0)
    install_subprocess(run)
    result = module._probe_nvidia(FakeTorch, 0)
    assert_eq(result["deviceName"], "NVIDIA H100 80GB HBM3", "deviceName")
    if "architecture" in result:
        raise AssertionError("architecture must never be guessed from the device name")
    if "architectureNote" not in result:
        raise AssertionError("an unresolved architecture requires an explicit note")


def probe_invalid_record():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")
    install_subprocess(lambda cmd, **kwargs: Completed(stdout="NoCommasHere\n", returncode=0))
    try:
        module._probe_nvidia(FakeTorch, 0)
    except RuntimeError as error:
        if "invalid GPU record" not in str(error):
            raise AssertionError(f"unexpected error: {error}")
    else:
        raise AssertionError("an invalid nvidia-smi row must fail closed")


def probe_failure():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")
    install_subprocess(lambda cmd, **kwargs: Completed(stdout="", stderr="driver error", returncode=9))
    try:
        module._probe_nvidia(FakeTorch, 0)
    except RuntimeError as error:
        if "nvidia-smi failed" not in str(error):
            raise AssertionError(f"unexpected error: {error}")
    else:
        raise AssertionError("a failing nvidia-smi must fail closed")


def probe_missing_executable():
    set_nvidia_smi(None)
    install_shutil(None)

    def must_not_spawn(cmd, **kwargs):
        raise AssertionError("no process may be spawned without an nvidia-smi executable")

    install_subprocess(must_not_spawn)
    try:
        module._probe_nvidia(FakeTorch, 0)
    except RuntimeError as error:
        if "unavailable" not in str(error):
            raise AssertionError(f"unexpected error: {error}")
    else:
        raise AssertionError("a missing nvidia-smi must fail closed")


def main_resolved():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")
    install_subprocess(fake_run_for("8.6\n"))
    status = run_main_with_probe()
    assert_eq(status, 0, "exit status")
    result = read_result()
    environment = result["environment"]
    assert_eq(environment["hardware"], "nvidia-gpu", "vendor dimension stays categorical")
    assert_eq(environment["architecture"], "sm86", "environment architecture")
    assert_eq(environment["device"], "NVIDIA GeForce RTX 3060 Laptop GPU", "environment device")
    assert_eq(environment["driverVersion"], "551.78", "environment driverVersion")
    assert_eq(environment["executionMode"], "gpu", "environment executionMode")
    assert_eq(environment["publishable"], False, "environment publishable")
    assert_eq(result["publishable"], False, "result publishable")
    probe = environment["targetProbe"]
    assert_eq(probe["architecture"], "sm86", "targetProbe architecture")
    assert_eq(probe["deviceName"], "NVIDIA GeForce RTX 3060 Laptop GPU", "targetProbe device")
    evidence = result["experienceEvidence"]
    assert_eq(evidence["hardware"], "nvidia-gpu", "evidence hardware")
    assert_eq(evidence["architecture"], "sm86", "evidence architecture")
    assert_eq(evidence["executionMode"], "gpu", "evidence executionMode")
    assert_eq(evidence["liveHardware"], True, "evidence liveHardware")
    assert_eq(evidence["operation"], "test", "evidence operation")


def main_unresolved():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")

    def run(cmd, **kwargs):
        query = next((str(part) for part in cmd if str(part).startswith("--query-gpu=")), "")
        if "compute_cap" in query:
            return Completed(stdout="", returncode=0)
        return Completed(stdout="NVIDIA H100 80GB HBM3, 550.54, 81559\n", returncode=0)

    install_subprocess(run)
    status = run_main_with_probe()
    assert_eq(status, 0, "exit status")
    result = read_result()
    environment = result["environment"]
    assert_eq(environment["hardware"], "nvidia-gpu", "vendor dimension")
    if "architecture" in environment:
        raise AssertionError("unresolved architecture must stay undeclared")
    if "compute_cap" not in str(environment.get("architectureNote")):
        raise AssertionError("unresolved architecture needs an explicit note")
    assert_eq(environment["targetProbe"]["deviceName"], "NVIDIA H100 80GB HBM3", "targetProbe device")
    evidence = result.get("experienceEvidence") or {}
    if "architecture" in evidence:
        raise AssertionError("evidence must not claim an architecture the driver never confirmed")


def main_legacy_probe():
    set_nvidia_smi("/fake/nvidia-smi")
    install_shutil("/fake/nvidia-smi")
    install_subprocess(fake_run_for("8.6\n"))
    status = run_main_with_probe(legacy=True)
    assert_eq(status, 0, "exit status")
    result = read_result()
    environment = result["environment"]
    assert_eq(environment["hardware"], "nvidia-gpu", "legacy vendor string survives")
    if "architecture" in environment:
        raise AssertionError("a legacy string probe cannot yield an architecture")
    assert_eq(environment["architectureNote"], "architecture was not resolved", "fallback note")
    assert_eq(environment["targetProbe"], None, "no probe object existed to preserve")
    evidence = result.get("experienceEvidence") or {}
    if "architecture" in evidence:
        raise AssertionError("legacy evidence must not gain an architecture")


record("_resolve_architecture maps driver compute_cap 8.6 to sm86", resolve_sm86)
record("_resolve_architecture maps another driver compute_cap to its own sm value", resolve_sm75)
record("unsupported compute_cap output leaves architecture undeclared with a note", resolve_unsupported)
record("a failing compute_cap query leaves architecture undeclared with a note", resolve_error)
record("a malformed compute_cap value is rejected instead of guessed", resolve_malformed)
record("a compute_cap without major.minor is rejected instead of guessed", resolve_no_decimal)
record("an exploding compute_cap probe degrades to an undeclared architecture", resolve_exception)
record("_probe_nvidia keeps driver facts and resolves sm86 from compute_cap", probe_success)
record("_probe_nvidia never infers architecture from the device name", probe_never_infers_from_name)
record("_probe_nvidia rejects an invalid GPU record", probe_invalid_record)
record("_probe_nvidia fails closed when nvidia-smi errors", probe_failure)
record("_probe_nvidia fails closed when nvidia-smi is unavailable", probe_missing_executable)
record("main normalization preserves the driver probe and stamps evidence architecture", main_resolved)
record("main normalization leaves architecture undeclared without driver compute_cap", main_unresolved)
record("main normalization keeps a legacy string probe undeclared", main_legacy_probe)

print("__SHARED_GPU_PROBE_RESULTS__" + json.dumps({"checks": results, "ok": all(item["passed"] for item in results)}))
`;

const workRoot = path.join(root, '.operator-studio-local');
await mkdir(workRoot, { recursive: true });
const work = await mkdtemp(path.join(workRoot, 'shared-gpu-target-probe-'));
const harnessPath = path.join(work, 'probe_harness.py');
const candidatePath = path.join(work, 'candidate.py');
const oraclePath = path.join(work, 'oracle.py');
const taskPath = path.join(work, 'task.json');
const resultPath = path.join(work, 'result.json');

const digest = (char) => 'sha256:' + char.repeat(64);
try {
  await Promise.all([
    writeFile(harnessPath, harness, 'utf8'),
    writeFile(candidatePath, 'def run(inputs):\n    return inputs\n', 'utf8'),
    writeFile(oraclePath, 'def run(inputs):\n    return inputs\n', 'utf8'),
    writeFile(taskPath, JSON.stringify({
      payload: {
        missionId: 'mission-probe', requestId: 'run-probe',
        candidate: { id: 'candidate-probe', digest: digest('a') },
        packageDigest: digest('b'), environmentDigest: digest('c'), acceptanceDigest: digest('d'),
        admissionId: 'admission-probe', preparedArtifactDigest: digest('e'), workspaceId: 'mission-probe',
      },
    }), 'utf8'),
  ]);

  const child = spawnSync(python, ['-I', '-B', harnessPath, runner], {
    cwd: work,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      OPERATOR_LOCAL_C500_TASK_DIR: work,
      OPERATOR_LOCAL_C500_RUN_PY: candidatePath,
      OPERATOR_LOCAL_C500_ORACLE_RUN_PY: oraclePath,
      OPERATOR_LOCAL_C500_RESULT_JSON: resultPath,
      OPERATOR_LOCAL_C500_TASK_JSON: taskPath,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);

  const line = String(child.stdout).split(/\r?\n/).find((entry) => entry.startsWith(MARKER));
  assert.ok(line, `probe summary marker missing from child output:\n${child.stdout}\n${child.stderr}`);
  const summary = JSON.parse(line.slice(MARKER.length));
  const failed = summary.checks.filter((item) => !item.passed);
  assert.equal(summary.checks.length, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} probe checks`);
  assert.deepEqual(failed, [], `probe checks failed:\n${failed.map((item) => `${item.name}\n${item.detail}`).join('\n')}`);
  assert.equal(summary.ok, true);
  console.log(`[shared-gpu-target-probe] ${summary.checks.length} hardware-free driver-probe checks passed`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
