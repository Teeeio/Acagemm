// Independent Phase 2 acceptance for runner-produced diagnostic facts.
//
// Authority: docs/development/P2_EVIDENCE_ACCEPTANCE.md (upstream-owned) and
// TEAM_HANDOFF.md 6.12. The Node parent starts one isolated Python child
// (`-I -B`, bytecode disabled) that imports the real production runner and
// replaces subprocess/shutil plus every hardware/torch port with explicit
// doubles. No GPU, driver, torch install, mx-smi, mctracer or mcProfiler
// process is ever touched; artifacts stay under the project-ignored
// .operator-studio-local/ directory and only the test's own directory is
// removed in finally.
//
// There is no real tool-output parser in the runner phase. `_diagnostic_result`
// therefore receives the raw collection envelope and must never trust a
// self-declared `parsed` channel: a tool process that exits 0 while its stdout
// claims kernel events/metrics still yields empty events/metrics, and the raw
// artifact is retained. Qualified real content is carried by the domain
// envelope contract in evidence-decision-test.mjs, not fabricated here.
//
// The harness records a failure when the runner does not yet expose the frozen
// helpers. That is the honest hand-off state until the Phase 2 runner work is
// integrated; it is never a reason to loosen an assertion.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePythonExecutable } from '../client-runtime/platform-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The base runner owns _analysis_tool; the shared-GPU adapter delegates to it.
const runner = path.join(root, 'tools', 'local-c500-runner.py');
const python = resolvePythonExecutable({ rootDir: root });
const EXPECTED_CHECKS = 24;
const MARKER = '__DIAGNOSTIC_RUNNER_RESULTS__';

const harness = String.raw`
import importlib.util
import inspect
import json
import os
import sys
import traceback
import types
from pathlib import Path

RUNNER = Path(sys.argv[1]).resolve()
ARTIFACT_ROOT = Path(sys.argv[2]).resolve()
results = []

MCTRACER_ENV = "OPERATOR_LOCAL_C500_MCTRACER_COMMAND"
MCPROFILER_ENV = "OPERATOR_LOCAL_C500_MCPROFILER_COMMAND"
FROZEN_BINDING_FIELDS = ("candidateDigest", "runId", "taskId", "sourceRunId", "semanticDigest")


def record(name, check):
    try:
        check()
    except Exception as error:  # noqa: BLE001 - the summary must report every failure
        results.append({"name": name, "passed": False, "detail": f"{type(error).__name__}: {error}\n{traceback.format_exc()}"})
    else:
        results.append({"name": name, "passed": True, "detail": ""})


spec = importlib.util.spec_from_file_location("operator_studio_runner_under_test", RUNNER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Completed:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def gpu_forbidden(*args, **kwargs):
    raise AssertionError("a hardware/torch port was touched by a hardware-free diagnostic test")


def install_fake_torch():
    fake = types.SimpleNamespace(
        __version__="0.0.0-test-double",
        version=types.SimpleNamespace(cuda=None),
        cuda=types.SimpleNamespace(
            is_available=gpu_forbidden,
            synchronize=gpu_forbidden,
            current_device=gpu_forbidden,
            Event=gpu_forbidden,
            get_device_name=gpu_forbidden,
        ),
    )
    sys.modules["torch"] = fake


def install_subprocess(run):
    module.subprocess = types.SimpleNamespace(run=run, Popen=gpu_forbidden, call=gpu_forbidden, check_output=gpu_forbidden)


def install_shutil(which_result):
    module.shutil = types.SimpleNamespace(which=lambda name: which_result)


def must_not_spawn(*args, **kwargs):
    raise AssertionError("no real analysis-tool process may be spawned in this case")


def reset(mode=None):
    os.environ.pop(MCTRACER_ENV, None)
    os.environ.pop(MCPROFILER_ENV, None)
    if mode is None:
        os.environ.pop("OPERATOR_DIAGNOSTICS_MODE", None)
    else:
        os.environ["OPERATOR_DIAGNOSTICS_MODE"] = mode


def fresh_dir(name):
    path = ARTIFACT_ROOT / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def artifacts_of(envelope):
    for key in ("artifacts", "rawArtifacts", "artifactPaths", "artifactDir", "artifact_dir"):
        value = envelope.get(key)
        if value:
            return value
    return None


def call_analysis(name, env_name, template, values, artifact_dir):
    fn = getattr(module, "_analysis_tool", None)
    if fn is None:
        raise AssertionError("the production runner must expose _analysis_tool")
    parameters = list(inspect.signature(fn).parameters)
    args = [name, env_name, template, values, artifact_dir]
    if len(parameters) > len(args):
        args.append(os.environ.get("OPERATOR_DIAGNOSTICS_MODE", "unavailable"))
    return fn(*args)


def call_diagnostic(kind, collection, binding):
    fn = getattr(module, "_diagnostic_result", None)
    if fn is None:
        raise AssertionError("the production runner must expose _diagnostic_result(kind, collection, binding)")
    parameters = list(inspect.signature(fn).parameters)
    if len(parameters) >= 3:
        return fn(kind, collection, binding)
    return fn(kind, collection)


def call_diagnostics_binding(request_id, payload):
    fn = getattr(module, "_diagnostics_binding", None)
    if fn is None:
        raise AssertionError("the production runner must expose _diagnostics_binding(task)")
    # Exercise the actual backend task envelope; runId is payload.requestId.
    return fn({"taskId": payload.get("taskId"), "payload": {
        "requestId": request_id,
        "candidate": {"digest": payload.get("candidateDigest"), "sourceRunId": payload.get("sourceRunId")},
        "semanticBinding": {"semanticDigest": payload.get("semanticDigest")},
    }})


def diagnostic_envelope(kind, value):
    envelope = require_dict(value, f"_diagnostic_result({kind})")
    nested = envelope.get(kind)
    if isinstance(nested, dict):
        envelope = nested
    return envelope


def require_dict(value, label):
    if not isinstance(value, dict):
        raise AssertionError(f"{label}: expected a dict envelope, got {type(value).__name__}")
    return value


def has_any_measurement(events):
    # Detects promoted measurement content regardless of the category label, so a
    # fabricated event cannot slip through by omitting its category.
    for event in events or []:
        if not isinstance(event, dict):
            continue
        start, duration = event.get("startUs"), event.get("durationUs")
        if isinstance(start, bool) or isinstance(duration, bool):
            continue
        if isinstance(start, (int, float)) and isinstance(duration, (int, float)) and start >= 0 and duration > 0:
            return True
    return False


def assert_no_trace_measurement(envelope, label):
    if has_any_measurement(envelope.get("events")):
        raise AssertionError(f"{label}: raw tool output must never be promoted into kernel trace measurements")


def assert_no_profiler_measurement(envelope, label):
    metrics = envelope.get("metrics")
    if metrics in (None, {}):
        return
    if not isinstance(metrics, dict):
        raise AssertionError(f"{label}: profiler metrics must be a mapping, got {type(metrics).__name__}")
    for key in ("kernelDurationUs", "occupancy", "bandwidth", "achievedOccupancy", "dramBandwidthGbps",
                "p50Us", "p95Us", "latencyUs", "p50", "p95"):
        if metrics.get(key) is not None:
            raise AssertionError(f"{label}: benchmark/raw value {key} must never masquerade as profiler measurement")


def collection(status="completed", source="mctracer", simulated=False, artifact_dir=None,
               stdout=None, benchmark=None, **extra):
    record = {
        "status": status,
        "source": source,
        "tool": source,
        "attempted": True,
        "simulated": simulated,
        "artifacts": [str(Path(artifact_dir) / "stdout.txt")] if artifact_dir else ["/artifacts/analysis/stdout.txt"],
        "benchmark": benchmark if benchmark is not None else {"p50Us": 41.8, "p95Us": 52.0},
    }
    if artifact_dir:
        record["artifactDir"] = str(artifact_dir)
    record.update(extra)
    return record


def collected(name, status="completed", source="mctracer", simulated=False, stdout="", benchmark=None, **extra):
    # The raw collection is exactly what _analysis_tool produced: a status/
    # artifact record holding raw tool stdout. There is no parsed channel.
    directory = fresh_dir(name)
    if stdout is not None:
        (directory / "stdout.txt").write_text(stdout, encoding="utf-8")
    return collection(status=status, source=source, simulated=simulated,
                      artifact_dir=directory, stdout=stdout, benchmark=benchmark, **extra)


def assert_eq(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


install_fake_torch()


# ---------------------------------------------------------------------------
# _analysis_tool: real command completion / failure / unavailability / mock
# ---------------------------------------------------------------------------

def analysis_completed_real():
    reset()
    os.environ[MCTRACER_ENV] = "{tool} --out {artifactDir}"
    install_shutil("/fake/mctracer")
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return Completed(stdout='{"events": []}\n', stderr="", returncode=0)

    install_subprocess(run)
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool} --out {artifactDir}", {}, fresh_dir("analysis_completed"))
    require_dict(envelope, "_analysis_tool")
    assert_eq(envelope.get("status"), "completed", "completed real command status")
    if envelope.get("simulated") is True:
        raise AssertionError("a completed real tool must never be marked simulated")
    if str(envelope.get("source") or "").lower() == "mock":
        raise AssertionError("a completed real tool must never claim mock provenance")
    if not calls:
        raise AssertionError("the configured real tool command must actually execute")
    if artifacts_of(envelope) is None:
        raise AssertionError("a completed collection must retain its artifacts")
    artifact_dir = envelope.get("artifactDir") or envelope.get("artifact_dir")
    if artifact_dir and not Path(artifact_dir).is_dir():
        raise AssertionError("the retained artifact directory must exist")


def analysis_failed_exit_code():
    reset()
    os.environ[MCTRACER_ENV] = "{tool} --out {artifactDir}"
    install_shutil("/fake/mctracer")
    install_subprocess(lambda command, **kwargs: Completed(stdout="", stderr="tool exploded", returncode=3))
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_failed_exit"))
    require_dict(envelope, "_analysis_tool")
    if envelope.get("status") == "completed":
        raise AssertionError("a failing tool process must never be reported as completed")
    if envelope.get("simulated") is True:
        raise AssertionError("a real failing tool is not a mock")
    if not envelope.get("error"):
        raise AssertionError("a failing tool must retain an explicit error reason")


def analysis_failed_exception():
    reset()
    os.environ[MCTRACER_ENV] = "{tool}"
    install_shutil("/fake/mctracer")

    def run(command, **kwargs):
        raise RuntimeError("spawn failed")

    install_subprocess(run)
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_failed_exception"))
    require_dict(envelope, "_analysis_tool")
    if envelope.get("status") == "completed":
        raise AssertionError("an exploding tool invocation must never be reported as completed")
    if not envelope.get("error"):
        raise AssertionError("an exploding tool invocation must retain an explicit error reason")


def analysis_unavailable_default():
    reset()
    install_shutil(None)
    install_subprocess(must_not_spawn)
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_unavailable"))
    require_dict(envelope, "_analysis_tool")
    assert_eq(envelope.get("status"), "unavailable", "default unavailable fallback")
    if envelope.get("simulated") is True:
        raise AssertionError("the default fallback is unavailable, not mock")
    if str(envelope.get("source") or "").lower() == "mock":
        raise AssertionError("the default fallback must not claim mock provenance")
    if artifacts_of(envelope) is None:
        raise AssertionError("an unavailable collection must still retain its artifact directory")


def analysis_configured_but_not_on_path():
    reset()
    os.environ[MCTRACER_ENV] = "/opt/custom/mctracer --out {artifactDir}"
    install_shutil(None)
    calls = []
    install_subprocess(lambda command, **kwargs: calls.append(command) or Completed(stdout="ok", returncode=0))
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_configured"))
    require_dict(envelope, "_analysis_tool")
    assert_eq(envelope.get("status"), "completed", "an explicitly configured tool must still execute without a PATH hit")
    if not calls:
        raise AssertionError("the configured command must execute even when which() finds nothing")


def analysis_explicit_mock_does_not_spawn():
    reset("mock")
    os.environ[MCTRACER_ENV] = "/fake/mctracer --out {artifactDir}"
    install_shutil("/fake/mctracer")
    install_subprocess(must_not_spawn)
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_mock"))
    require_dict(envelope, "_analysis_tool")
    assert_eq(envelope.get("status"), "mocked", "explicit mock status")
    assert_eq(envelope.get("source"), "mock", "explicit mock source")
    assert_eq(envelope.get("simulated"), True, "explicit mock simulated flag")


def analysis_default_mode_is_not_mock():
    reset()
    install_shutil(None)
    install_subprocess(must_not_spawn)
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_default_mode"))
    require_dict(envelope, "_analysis_tool")
    if envelope.get("status") == "mocked" or str(envelope.get("source") or "").lower() == "mock":
        raise AssertionError("unset OPERATOR_DIAGNOSTICS_MODE must default to unavailable, not mock")


def analysis_mock_never_produces_real_status():
    reset("mock")
    os.environ[MCTRACER_ENV] = "/fake/mctracer"
    install_shutil("/fake/mctracer")
    install_subprocess(must_not_spawn)
    envelope = call_analysis("mctracer", MCTRACER_ENV, "{tool}", {}, fresh_dir("analysis_mock_status"))
    if envelope.get("status") == "completed":
        raise AssertionError("explicit mock must never be reported as a completed real collection")


# ---------------------------------------------------------------------------
# _diagnostic_result(kind, collection, binding): raw collection, no parser
# ---------------------------------------------------------------------------

def diagnostic_raw_output_never_becomes_tracer_events():
    reset()
    claimed = '{"events": [{"category": "kernel", "name": "paged_decode_kernel", "startUs": 0, "durationUs": 12.5}]}'
    raw = collected("raw_tracer", source="mctracer", stdout=claimed)
    artifact = Path(raw["artifacts"][0])
    envelope = diagnostic_envelope("tracer", call_diagnostic("tracer", raw, None))
    assert_eq(envelope.get("format"), "operator-trace/v1", "tracer envelope format")
    assert_eq(envelope.get("status"), "completed", "a successful tool collection keeps its completed status")
    assert_no_trace_measurement(envelope, "self-declared parsed tracer output")
    if not artifact.is_file():
        raise AssertionError("the original raw artifact must be retained, not consumed or deleted")


def diagnostic_raw_output_never_becomes_profiler_metrics():
    reset()
    claimed = '{"metrics": {"kernelDurationUs": 12.5, "occupancy": 0.62, "bandwidth": 412.5}}'
    raw = collected("raw_profiler", source="mcProfiler", stdout=claimed)
    artifact = Path(raw["artifacts"][0])
    envelope = diagnostic_envelope("profiler", call_diagnostic("profiler", raw, None))
    assert_eq(envelope.get("format"), "operator-profile/v1", "profiler envelope format")
    assert_no_profiler_measurement(envelope, "self-declared parsed profiler output")
    if not artifact.is_file():
        raise AssertionError("the original raw artifact must be retained, not consumed or deleted")


def diagnostic_status_ok_is_not_upgraded():
    reset()
    envelope = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("raw_status_ok", status="ok", stdout="{}"), None))
    if envelope.get("status") == "completed":
        raise AssertionError("a raw status of ok must never be upgraded to a real completed collection")
    assert_no_trace_measurement(envelope, "status ok")


def diagnostic_unknown_source_not_promoted():
    reset()
    raw = collected("raw_unknown_source", source=None, stdout='{"events": []}')
    raw["source"] = None
    envelope = diagnostic_envelope("tracer", call_diagnostic("tracer", raw, None))
    source = envelope.get("source")
    if str(source or "").lower() in ("mctracer", "mcprofiler"):
        raise AssertionError(f"a missing/unknown raw source must not be promoted to a real tool source, got {source!r}")


def diagnostic_benchmark_never_becomes_profile():
    reset()
    benchmark = {"p50Us": 41.8, "p95Us": 52.0, "latencyUs": 41.8}
    envelope = diagnostic_envelope("profiler", call_diagnostic(
        "profiler", collected("bench_profile", source="mcProfiler", stdout="", benchmark=benchmark), None))
    assert_no_profiler_measurement(envelope, "benchmark-only profiler input")


def diagnostic_benchmark_never_becomes_trace_events():
    reset()
    benchmark = {"p50Us": 41.8, "p95Us": 52.0}
    envelope = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("bench_trace", source="mctracer", stdout="", benchmark=benchmark), None))
    assert_no_trace_measurement(envelope, "benchmark-only tracer input")


def diagnostic_unavailable_status_wins_over_content():
    reset()
    claimed = '{"events": [{"category": "kernel", "name": "k", "startUs": 0, "durationUs": 12.5}]}'
    envelope = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("unavail_tracer", status="unavailable", source="mctracer", stdout=claimed), None))
    assert_eq(envelope.get("status"), "unavailable", "unavailable status is authoritative")
    assert_no_trace_measurement(envelope, "content under an unavailable status")


def diagnostic_mock_provenance():
    reset()
    envelope = diagnostic_envelope("profiler", call_diagnostic(
        "profiler", collected("mock_profiler", status="mocked", source="mock", simulated=True,
                              stdout='{"metrics": {"kernelDurationUs": 12.5}}'), None))
    assert_eq(envelope.get("status"), "mocked", "mock status")
    assert_eq(envelope.get("simulated"), True, "mock simulated flag")
    if str(envelope.get("source") or "").lower() != "mock":
        raise AssertionError("mock provenance must be explicit in the envelope")
    assert_no_profiler_measurement(envelope, "mock profiler content")


def diagnostic_tool_only_trace_has_no_kernel_events():
    reset()
    claimed = '{"events": [{"category": "tool", "name": "mctracer", "startUs": 0, "durationUs": 12.5}]}'
    envelope = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("tool_only", source="mctracer", stdout=claimed), None))
    assert_no_trace_measurement(envelope, "tool-only trace events")


def diagnostic_kind_separation():
    reset()
    tracer = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("kind_tracer", source="mctracer", stdout="{}"), None))
    profiler = diagnostic_envelope("profiler", call_diagnostic(
        "profiler", collected("kind_profiler", source="mcProfiler", stdout="{}"), None))
    if isinstance(tracer.get("metrics"), dict) and tracer["metrics"].get("kernelDurationUs") is not None:
        raise AssertionError("a tracer envelope must never carry profiler metrics")
    assert_no_profiler_measurement(tracer, "tracer kind")
    assert_no_trace_measurement(profiler, "profiler kind")


def diagnostic_binding_retained_exactly():
    reset()
    frozen = {
        "candidateDigest": "sha256:" + "a" * 64,
        "runId": "run-p2",
        "taskId": "backend-task-p2",
        "sourceRunId": "run-p2-source",
        "semanticDigest": None,
    }
    envelope = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("binding_exact", source="mctracer", stdout="{}"), frozen))
    if envelope.get("binding") != frozen:
        raise AssertionError(f"the frozen five-field binding must be retained exactly, got {envelope.get('binding')!r}")


def diagnostic_binding_missing_is_not_fabricated():
    reset()
    envelope = diagnostic_envelope("tracer", call_diagnostic(
        "tracer", collected("binding_missing", source="mctracer", stdout="{}"), None))
    binding_value = envelope.get("binding")
    if binding_value != dict.fromkeys(FROZEN_BINDING_FIELDS):
        raise AssertionError(f"a missing binding must stay unknown, got {binding_value!r}")


def diagnostic_unknown_kind_fails_closed():
    reset()
    try:
        value = call_diagnostic("kernel-summary", collected("unknown_kind"), None)
    except Exception:
        return
    envelope = value if isinstance(value, dict) else {}
    if envelope.get("format") in ("operator-trace/v1", "operator-profile/v1"):
        raise AssertionError("an unknown diagnostic kind must not produce a valid diagnostic format")


def diagnostic_inputs_not_mutated():
    reset()
    raw = collected("inputs_unchanged", source="mctracer", stdout='{"events": []}')
    binding_value = {
        "candidateDigest": "sha256:" + "a" * 64, "runId": "run-p2", "taskId": "backend-task-p2",
        "sourceRunId": "run-p2-source", "semanticDigest": None,
    }
    before = json.dumps(raw, sort_keys=True)
    binding_before = json.dumps(binding_value, sort_keys=True)
    call_diagnostic("tracer", raw, binding_value)
    if json.dumps(raw, sort_keys=True) != before:
        raise AssertionError("_diagnostic_result must not mutate the collection")
    if json.dumps(binding_value, sort_keys=True) != binding_before:
        raise AssertionError("_diagnostic_result must not mutate the binding")


# ---------------------------------------------------------------------------
# _diagnostics_binding: frozen five fields, runId from the queue requestId
# ---------------------------------------------------------------------------

def diagnostics_binding_frozen_fields():
    reset()
    payload = {
        "requestId": "queue-request-42",
        "taskId": "backend-task-42",
        "candidateDigest": "sha256:" + "a" * 64,
        "sourceRunId": "run-src-42",
        "semanticDigest": None,
    }
    result = call_diagnostics_binding("queue-request-42", payload)
    result = require_dict(result, "_diagnostics_binding")
    if set(result.keys()) != set(FROZEN_BINDING_FIELDS):
        raise AssertionError(f"binding must expose exactly the frozen fields {sorted(FROZEN_BINDING_FIELDS)}, got {sorted(result.keys())}")
    assert_eq(result.get("runId"), "queue-request-42", "runId must be the queue requestId passed in")
    # Unknown observations stay explicit null; known fields are copied without
    # inventing an identity the caller never supplied.
    if result.get("candidateDigest") != payload["candidateDigest"]:
        raise AssertionError(f"candidateDigest must be copied exactly or stay null, got {result.get('candidateDigest')!r}")
    if result.get("sourceRunId") != payload["sourceRunId"]:
        raise AssertionError(f"sourceRunId must be copied exactly or stay null, got {result.get('sourceRunId')!r}")
    if result.get("taskId") != payload["taskId"]:
        raise AssertionError(f"backend taskId must be copied exactly or stay null, got {result.get('taskId')!r}")
    if result.get("semanticDigest") is not None:
        raise AssertionError(f"a missing semanticDigest must stay explicit null, got {result.get('semanticDigest')!r}")
    for required in ("missionId", "candidateId"):
        if required in result:
            raise AssertionError(f"the binding must not require/invent the non-frozen field {required}")


def diagnostics_binding_run_id_is_queue_not_backend():
    reset()
    result = call_diagnostics_binding("queue-request-42", {"requestId": "queue-request-42", "taskId": "backend-task-42"})
    result = require_dict(result, "_diagnostics_binding")
    if result.get("runId") == "backend-task-42":
        raise AssertionError("the backend taskId must never be crossed into the diagnostic runId")
    assert_eq(result.get("runId"), "queue-request-42", "runId stays the queue requestId")


record("_analysis_tool completes a real configured command without touching hardware", analysis_completed_real)
record("_analysis_tool reports a nonzero tool exit as failed, not completed", analysis_failed_exit_code)
record("_analysis_tool reports an exploding tool invocation as failed", analysis_failed_exception)
record("_analysis_tool falls back to unavailable by default and never spawns", analysis_unavailable_default)
record("_analysis_tool still executes an explicitly configured tool missing from PATH", analysis_configured_but_not_on_path)
record("_analysis_tool explicit mock is mocked/mock/simulated and never spawns", analysis_explicit_mock_does_not_spawn)
record("_analysis_tool defaults to unavailable rather than mock", analysis_default_mode_is_not_mock)
record("explicit mock never claims a completed real collection", analysis_mock_never_produces_real_status)
record("_diagnostic_result never promotes self-declared raw tracer output into kernel events", diagnostic_raw_output_never_becomes_tracer_events)
record("_diagnostic_result never promotes self-declared raw profiler output into metrics", diagnostic_raw_output_never_becomes_profiler_metrics)
record("_diagnostic_result never upgrades a raw status of ok to completed", diagnostic_status_ok_is_not_upgraded)
record("_diagnostic_result never promotes a missing/unknown raw source to a real tool", diagnostic_unknown_source_not_promoted)
record("_diagnostic_result never promotes benchmark latency to profiler metrics", diagnostic_benchmark_never_becomes_profile)
record("_diagnostic_result never synthesizes trace events from benchmark values", diagnostic_benchmark_never_becomes_trace_events)
record("_diagnostic_result status wins over contradictory collected content", diagnostic_unavailable_status_wins_over_content)
record("_diagnostic_result keeps mock provenance explicit", diagnostic_mock_provenance)
record("_diagnostic_result never presents tool-only events as kernel measurements", diagnostic_tool_only_trace_has_no_kernel_events)
record("_diagnostic_result separates tracer and profiler content", diagnostic_kind_separation)
record("_diagnostic_result retains the frozen binding exactly", diagnostic_binding_retained_exactly)
record("_diagnostic_result never fabricates a missing binding", diagnostic_binding_missing_is_not_fabricated)
record("_diagnostic_result fails closed for an unknown kind", diagnostic_unknown_kind_fails_closed)
record("_diagnostic_result does not mutate collection or binding", diagnostic_inputs_not_mutated)
record("_diagnostics_binding exposes the frozen five fields with runId from requestId", diagnostics_binding_frozen_fields)
record("_diagnostics_binding runId is the queue requestId, never the backend taskId", diagnostics_binding_run_id_is_queue_not_backend)

print("__DIAGNOSTIC_RUNNER_RESULTS__" + json.dumps({"checks": results, "ok": all(item["passed"] for item in results)}))
`;

const ignoredRoot = path.join(root, '.operator-studio-local');
await mkdir(ignoredRoot, { recursive: true });
const work = await mkdtemp(path.join(ignoredRoot, 'diagnostic-runner-'));
const harnessPath = path.join(work, 'diagnostic_harness.py');
const artifactRoot = path.join(work, 'artifacts');

try {
  await writeFile(harnessPath, harness, 'utf8');
  const childEnvironment = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete childEnvironment.OPERATOR_DIAGNOSTICS_MODE;
  delete childEnvironment.OPERATOR_LOCAL_C500_MCTRACER_COMMAND;
  delete childEnvironment.OPERATOR_LOCAL_C500_MCPROFILER_COMMAND;
  const child = spawnSync(python, ['-I', '-B', harnessPath, runner, artifactRoot], {
    cwd: work,
    env: childEnvironment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);

  const line = String(child.stdout).split(/\r?\n/).find((entry) => entry.startsWith(MARKER));
  assert.ok(line, `diagnostic summary marker missing from child output:\n${child.stdout}\n${child.stderr}`);
  const summary = JSON.parse(line.slice(MARKER.length));
  const failed = summary.checks.filter((item) => !item.passed);
  assert.equal(summary.checks.length, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} diagnostic-runner checks`);
  assert.deepEqual(
    failed,
    [],
    `diagnostic-runner checks failed:\n${failed.map((item) => `${item.name}\n${item.detail}`).join('\n')}`,
  );
  assert.equal(summary.ok, true);
  console.log(`[diagnostic-runner] ${summary.checks.length} hardware-free runner fact-production checks passed`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
