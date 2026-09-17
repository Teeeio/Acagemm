"""Root read-only audit of retained failed-candidate feedback. No writes or execution.

This supplements the existing full E2E reader for same-round correctness recovery.
No failed candidates means not_observed, never proof of the failure feedback path.
"""
import hashlib
import json
import pathlib
import sys


def read(p):
    return json.loads(pathlib.Path(p).read_text(encoding="utf-8-sig"))


def digest(x):
    return x.removeprefix("sha256:").lower() if isinstance(x, str) else None


def section(prompt, name):
    start = "----- BEGIN " + name + " -----"
    end = "----- END " + name + " -----"
    assert prompt.count(start) == 1 and prompt.count(end) == 1, "prompt section identity"
    return json.loads(prompt.split(start, 1)[1].split(end, 1)[0].strip())


def inspect(root):
    root = pathlib.Path(root)
    queue = [json.loads(x) for x in (root / "runtime/operator-test-queue.jsonl").read_text(encoding="utf-8").splitlines() if x]
    experiences = read(root / "runtime/experiences/experiences.json")["records"]
    audits = [read(p) for p in (root / "bridge/prompt-audits").glob("*.json")]
    archives = []
    for p in root.glob("*-state.json"):
        archives.extend(read(p).get("state", {}).get("runHistory", []))
    rows = []
    for task in queue:
        result = task.get("result") or {}
        error = result.get("error") or {}
        if task.get("status") != "failed" or task.get("payload", {}).get("purpose") != "candidate":
            continue
        if error.get("code") not in ["OPERATOR_CORRECTNESS_MISMATCH", "OPERATOR_CANDIDATE_EXCEPTION"]:
            continue
        pl = task["payload"]
        ev = result["experienceEvidence"]
        row = {"taskId": task["taskId"], "candidateId": pl["candidate"]["id"], "requestId": pl["requestId"], "errorCode": error["code"], "issues": []}
        checks = []
        checks.append((task.get("resourceRelease", {}).get("confirmed") is True, "queue release"))
        prepared = result.get("executionPackage", {}).get("preparedArtifactDigest")
        checks.append((bool(prepared) and pl.get("preparedArtifactDigest") == prepared, "request preparedArtifactDigest"))
        checks.append((result.get("publishable") is False and ev.get("outcome") == "failed", "failed development identity"))
        matches = [e for e in experiences if e.get("source") == "execution" and e.get("evidence", {}).get("missionId") == pl["missionId"] and e["evidence"].get("candidateId") == pl["candidate"]["id"] and e["evidence"].get("runId") == pl["requestId"] and digest(e["evidence"].get("patchDigest")) == digest(pl["candidate"].get("digest"))]
        checks.append((len(matches) == 1, "unique failed execution experience"))
        rounds = [r for r in archives if r.get("queueRequestId") == pl["requestId"] and r.get("candidateId") == pl["candidate"]["id"] and digest(r.get("candidateDigest")) == digest(pl["candidate"].get("digest"))]
        checks.append((len(rounds) == 1, "unique archived source round"))
        if len(rounds) == 1:
            source = rounds[0]
            facts = source.get("roundFacts") or {}
            checks.append((facts.get("correctness", {}).get("status") == "failed" and facts.get("failure", {}).get("code") == error["code"], "typed failed round facts"))
            relevant = [a for a in audits if a.get("missionId") == pl["missionId"] and ((a.get("roundFacts") or {}).get("previous") or {}).get("queueRequestId") == pl["requestId"] and a["roundFacts"]["previous"].get("runId") == source.get("runId") and a.get("runId") != source.get("runId")]
            checks.append((bool(relevant), "actual subsequent audit"))
            if relevant:
                audit = min(relevant, key=lambda a: a.get("createdAt", ""))
                row["continuationRunId"] = audit["runId"]
                prompt = audit["prompt"]
                checks.append((audit.get("deliveryStage") == "prepared-before-send" and audit.get("roundFacts") == facts, "frozen facts sidecar"))
                checks.append((audit.get("promptDigest") == "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest() and audit.get("promptBytes") == len(prompt.encode("utf-8")), "prompt bytes and digest"))
                try:
                    checks.append((section(prompt, "MISSION ITERATION CONTEXT") == facts, "facts in actual prompt"))
                    if len(matches) == 1:
                        experience = matches[0]
                        row["experienceId"] = experience["id"]
                        row["experienceVersion"] = experience["version"]
                        selected = [e for e in audit.get("selection", {}).get("selected", []) if e.get("id") == experience["id"] and e.get("version") == experience["version"] and e.get("source") == "execution"]
                        checks.append((len(selected) == 1, "failed experience selected"))
                        block = section(prompt, "UNTRUSTED EXPERIENCE DATA")
                        items = [e for e in block["items"] if e.get("id") == experience["id"] and e.get("version") == experience["version"]]
                        checks.append((len(items) == 1 and items[0].get("content") == experience["content"] and block["versions"].get(experience["id"]) == experience["version"] and block.get("contextId") == audit.get("selection", {}).get("contextId"), "complete failed experience in prompt"))
                except (AssertionError, KeyError, ValueError) as exc:
                    checks.append((False, "prompt block: " + str(exc)))
        row["issues"] = [label for ok, label in checks if not ok]
        row["passed"] = not row["issues"]
        rows.append(row)
    return {"runRoot": str(root), "eligibleFailedCandidates": len(rows), "observed": bool(rows), "rows": rows, "passed": all(x["passed"] for x in rows)}


reports = []
for root in sys.argv[1:]:
    try:
        reports.append(inspect(root))
    except Exception as exc:
        reports.append({"runRoot": root, "passed": False, "error": str(exc)})
summary = {"schemaVersion": "operator-studio.live-failed-feedback-audit/v1", "mode": "read-only-retained-originals", "runs": reports, "eligibleFailedCandidates": sum(x.get("eligibleFailedCandidates", 0) for x in reports), "passed": bool(reports) and all(x["passed"] for x in reports)}
print(json.dumps(summary, ensure_ascii=False, indent=2))
sys.exit(0 if summary["passed"] else 1)
