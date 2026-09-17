#!/usr/bin/env python3
"""Relocatable, offline packaging and verification of the closeout evidence.

Python standard library only. No network, no provider, no GPU, no model call,
no package install, no shell, and no deletion of any user path.

Two commands:

  build  --repo PATH --archives-root PATH --out NEW_DIRECTORY
      Assemble a self-contained, relocatable bundle from
      (a) the immutable input list `docs/development/evidence/closeout-20260915/inputs.json`
          inside `--repo`,
      (b) the Git-frozen reader plus four helper modules (read with
          `git show <sourceCommit>:<path>` when Git is usable, otherwise from the
          checked-out file), and
      (c) the eight byte-original ZIPs below `--archives-root` (the explicit
          `.operator-studio-local` base).
      Every input is rejected unless its SHA256 equals the SHA256 declared in
      inputs.json. `--out` must be a NEW directory; nothing outside it is touched.

  verify --bundle DIRECTORY --scratch NEW_DIRECTORY --report PATH
      Verify a relocated bundle with only this script, Python and Node.
      Every output path rule is checked first, before anything is written: the
      report must be a NEW file that lies outside both the bundle and the
      scratch, and the scratch must not overlap the bundle. A report path that
      violates this is never written -- the failure goes to stdout/stderr only,
      so an unsafe --report cannot corrupt the bundle being verified. Only after
      that: the whole payload membership/bytes/SHA256 is checked BEFORE any
      extraction or Node execution, all eight ZIPs are then checked per entry
      (traversal, absolute, drive-letter, duplicate, symlink, encrypted,
      CRC/size), only then is the payload extracted into a fresh scratch
      directory, and only then is the unmodified accepted reader executed with
      the bundled helper repo and the explicit extracted run roots.

`MANIFEST.sha256` is a relative-path SHA256 list of every payload file; the
manifest itself is not listed. Historical failures are never skipped: an archive
whose `replay` is null is still hash- and entry-verified, it is simply not a
successful-run replay input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
import zlib

SCHEMA_INPUTS = "acagemm.closeout-inputs/v1"
SCHEMA_REPORT = "acagemm.portable-evidence-report/v1"
MANIFEST_NAME = "MANIFEST.sha256"
BUNDLE_INPUTS_NAME = "inputs.json"
BUNDLE_SCRIPT_NAME = "portable-evidence.py"
BUNDLE_REPO_DIR = "repo"
BUNDLE_ARCHIVES_DIR = "archives"

REPLAY_GROUPS = ("smoke", "n20", "coverage")
REQUIRED_STRICT_N20_RUNS = 20
SENTINEL_MODELS = frozenset(("unknown", "null", "undefined", "<synthetic>"))

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
MANIFEST_LINE_RE = re.compile(r"^([0-9a-fA-F]{64})[ \t]+(.+?)[ \t]*$")
DRIVE_RE = re.compile(r"^[A-Za-z]:")

CHUNK = 1 << 20


class PortableError(Exception):
    """A contract violation that must abort the current command."""


# ---------------------------------------------------------------------------
# Hashing / small helpers
# ---------------------------------------------------------------------------
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str, *, want_bytes: bool = False):
    digest = hashlib.sha256()
    total = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            total += len(chunk)
            digest.update(chunk)
    return (digest.hexdigest(), total) if want_bytes else digest.hexdigest()


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def is_hex64(value) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.match(value))


def is_commit_id(value) -> bool:
    return isinstance(value, str) and bool(COMMIT_RE.match(value))


def normalized_path(path: str) -> str:
    """Absolute, symlink-resolved, case-folded path, for safety comparisons only.

    `realpath` collapses directory symlinks and `normcase` folds case, so two
    spellings that reach the same location compare equal and an alias cannot
    smuggle a path past the bundle/scratch/report overlap checks. I/O always
    uses the caller's original path.
    """
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def path_within(child: str, parent: str) -> bool:
    """True when normalised `child` equals or lies below normalised `parent`."""
    child_normal = os.path.normcase(child)
    parent_normal = os.path.normcase(parent)
    if child_normal == parent_normal:
        return True
    if not parent_normal.endswith(os.sep):
        parent_normal += os.sep
    return child_normal.startswith(parent_normal)


def write_json(path: str, document) -> None:
    # Never creates directories: the caller must name an existing location, so a
    # typo cannot silently scatter new directories across the host.
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")


def emit_stdout(document) -> None:
    # ASCII-escaped on purpose: a host console whose codec cannot represent a
    # relocated path must not turn a successful build/verify into a crash.
    text = json.dumps(document, ensure_ascii=True, indent=2) + "\n"
    try:
        sys.stdout.write(text)
    except UnicodeEncodeError:
        sys.stdout.buffer.write(text.encode("ascii", "backslashreplace"))


# ---------------------------------------------------------------------------
# Name safety (shared by manifest paths and ZIP members)
# ---------------------------------------------------------------------------
def _reject_unsafe(relative: str, *, kind: str) -> str:
    if not relative:
        raise PortableError(f"{kind} is empty")
    if any(ord(character) < 32 for character in relative):
        raise PortableError(f"{kind} contains a control character: {relative!r}")
    if "\\" in relative:
        raise PortableError(f"{kind} contains a backslash separator: {relative!r}")
    if relative.startswith("/"):
        raise PortableError(f"{kind} is absolute: {relative!r}")
    if DRIVE_RE.match(relative):
        raise PortableError(f"{kind} carries a drive letter: {relative!r}")
    for part in relative.split("/"):
        if part in ("", ".", ".."):
            raise PortableError(f"{kind} has an invalid segment {part!r}: {relative!r}")
        if part != part.strip():
            raise PortableError(f"{kind} segment has surrounding whitespace: {relative!r}")
    return relative


def safe_manifest_path(relative: str) -> str:
    """Validate a bundle-relative POSIX path used inside MANIFEST.sha256."""
    return _reject_unsafe(relative, kind="manifest path")


def safe_member_name(raw_name: str) -> str:
    """Validate a ZIP member name; directory entries keep their trailing slash."""
    stripped = raw_name[:-1] if raw_name.endswith("/") else raw_name
    safe = _reject_unsafe(stripped, kind="archive member")
    return safe + "/" if raw_name.endswith("/") else safe


def is_unsafe_member(raw_name: str) -> str | None:
    try:
        safe_member_name(raw_name)
    except PortableError as error:
        return str(error)
    return None


# ---------------------------------------------------------------------------
# Immutable inputs.json
# ---------------------------------------------------------------------------
def load_inputs(path: str) -> dict:
    if not os.path.isfile(path):
        raise PortableError(f"immutable inputs list is missing: {path}")
    try:
        document = json.loads(read_bytes(path).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise PortableError(f"immutable inputs list is not readable JSON: {error}") from error
    if not isinstance(document, dict):
        raise PortableError("immutable inputs list is not a JSON object")
    if document.get("schemaVersion") != SCHEMA_INPUTS:
        raise PortableError(
            f"immutable inputs schemaVersion is {document.get('schemaVersion')!r}, expected {SCHEMA_INPUTS!r}"
        )
    if not is_commit_id(document.get("sourceCommit")):
        raise PortableError("immutable inputs sourceCommit is not a 40-char lowercase frozen commit id")
    reader = document.get("reader")
    if not isinstance(reader, dict) or not isinstance(reader.get("path"), str) or not is_hex64(reader.get("sha256")):
        raise PortableError("immutable inputs reader must declare {path, sha256}")
    safe_manifest_path(reader["path"])
    helpers = document.get("helpers")
    if not isinstance(helpers, list) or not helpers:
        raise PortableError("immutable inputs must declare at least one helper")
    for index, helper in enumerate(helpers):
        if not isinstance(helper, dict) or not isinstance(helper.get("path"), str) or not is_hex64(helper.get("sha256")):
            raise PortableError(f"immutable inputs helper[{index}] must declare {{path, sha256}}")
        safe_manifest_path(helper["path"])
    archives = document.get("archives")
    if not isinstance(archives, list) or not archives:
        raise PortableError("immutable inputs must declare at least one archive")
    for index, archive in enumerate(archives):
        if not isinstance(archive, dict) or not isinstance(archive.get("path"), str) or not is_hex64(archive.get("sha256")):
            raise PortableError(f"immutable inputs archive[{index}] must declare {{path, sha256}}")
        safe_manifest_path(archive["path"])
        if archive.get("replay") is not None and archive["replay"] not in REPLAY_GROUPS:
            raise PortableError(f"immutable inputs archive[{index}] replay is not a known group: {archive['replay']!r}")
    expectations = document.get("expectations")
    if not isinstance(expectations, dict) or not expectations:
        raise PortableError("immutable inputs must declare expectations")
    for group, expected in expectations.items():
        if group not in REPLAY_GROUPS:
            raise PortableError(f"immutable inputs expectations has an unknown group: {group!r}")
        if not isinstance(expected, dict):
            raise PortableError(f"immutable inputs expectations.{group} is not an object")
        for field in ("runs", "candidates", "modelRuns"):
            if not isinstance(expected.get(field), int) or expected[field] < 0:
                raise PortableError(f"immutable inputs expectations.{group}.{field} is not a non-negative integer")
        if not isinstance(expected.get("strictN20"), bool):
            raise PortableError(f"immutable inputs expectations.{group}.strictN20 is not a boolean")
    for group in expectations:
        matches = [archive for archive in archives if archive.get("replay") == group]
        if len(matches) != 1:
            raise PortableError(
                f"immutable inputs must bind exactly one archive to replay group {group!r} (found {len(matches)})"
            )
    return document


def helper_paths(inputs: dict) -> list:
    return [entry["path"] for entry in inputs["helpers"]]


def all_code_inputs(inputs: dict) -> list:
    return [inputs["reader"]] + list(inputs["helpers"])


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
def parse_manifest(path: str) -> dict:
    if not os.path.isfile(path):
        raise PortableError(f"bundle manifest is missing: {path}")
    entries = {}
    text = read_bytes(path).decode("utf-8")
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        match = MANIFEST_LINE_RE.match(line)
        if not match:
            raise PortableError(f"bundle manifest line {number} is not '<sha256>  <relative path>'")
        digest = match.group(1).lower()
        try:
            relative = safe_manifest_path(match.group(2))
        except PortableError as error:
            raise PortableError(f"bundle manifest line {number}: {error}") from error
        if relative == MANIFEST_NAME:
            raise PortableError("bundle manifest must not list itself")
        if relative in entries:
            raise PortableError(f"bundle manifest lists {relative!r} more than once")
        entries[relative] = digest
    if not entries:
        raise PortableError("bundle manifest is empty")
    return entries


def walk_bundle_files(root: str) -> dict:
    """Every regular file below the bundle root, as POSIX relative paths."""
    found = {}
    for current, directory_names, file_names in os.walk(root):
        directory_names.sort()
        for name in sorted(file_names):
            absolute = os.path.join(current, name)
            if os.path.islink(absolute):
                raise PortableError(f"bundle contains a symlink: {absolute}")
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            safe_manifest_path(relative)
            if relative == MANIFEST_NAME:
                continue
            found[relative] = absolute
    return found


def write_manifest(root: str) -> int:
    files = walk_bundle_files(root)
    lines = []
    for relative in sorted(files):
        lines.append(f"{sha256_file(files[relative])}  {relative}")
    with open(os.path.join(root, MANIFEST_NAME), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")
    return len(lines)


def check_manifest(bundle: str):
    """Membership + bytes + SHA256 of the entire payload. Returns (entries, problems)."""
    problems = []
    try:
        declared = parse_manifest(os.path.join(bundle, MANIFEST_NAME))
    except PortableError as error:
        return None, [str(error)]
    try:
        actual = walk_bundle_files(bundle)
    except PortableError as error:
        return declared, [str(error)]
    for relative in sorted(set(declared) - set(actual)):
        problems.append(f"manifest lists a missing payload file: {relative}")
    for relative in sorted(set(actual) - set(declared)):
        problems.append(f"bundle contains an unlisted extra file: {relative}")
    for relative in sorted(set(declared) & set(actual)):
        digest = sha256_file(actual[relative])
        if digest != declared[relative]:
            problems.append(f"payload file bytes differ from the manifest SHA256: {relative}")
    return declared, problems


# ---------------------------------------------------------------------------
# ZIP inspection / extraction
# ---------------------------------------------------------------------------
def inspect_archive(path: str, *, deep: bool) -> dict:
    """Validate every member of one archive. Never extracts."""
    result = {
        "entries": 0,
        "files": 0,
        "directories": 0,
        "uncompressedBytes": 0,
        "reasons": [],
    }
    if not os.path.isfile(path):
        result["reasons"].append(f"archive is missing: {path}")
        result["integrity"] = False
        return result
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            seen = set()
            for info in infos:
                result["entries"] += 1
                raw_name = info.filename
                unsafe = is_unsafe_member(raw_name)
                if unsafe:
                    result["reasons"].append(unsafe)
                    continue
                if raw_name in seen:
                    result["reasons"].append(f"archive member name is duplicated: {raw_name!r}")
                    continue
                seen.add(raw_name)
                mode = (info.external_attr >> 16) & 0xF000
                if mode == 0xA000:
                    result["reasons"].append(f"archive member is a symlink: {raw_name!r}")
                    continue
                if info.flag_bits & 0x1:
                    result["reasons"].append(f"archive member is encrypted: {raw_name!r}")
                    continue
                if raw_name.endswith("/"):
                    result["directories"] += 1
                    continue
                result["files"] += 1
                result["uncompressedBytes"] += info.file_size
                if not deep:
                    continue
                crc = 0
                total = 0
                try:
                    with archive.open(info) as handle:
                        while True:
                            chunk = handle.read(CHUNK)
                            if not chunk:
                                break
                            total += len(chunk)
                            crc = zlib.crc32(chunk, crc)
                except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError) as error:
                    result["reasons"].append(f"archive member {raw_name!r} is unreadable: {error}")
                    continue
                crc &= 0xFFFFFFFF
                if total != info.file_size:
                    result["reasons"].append(
                        f"archive member {raw_name!r} length {total} != declared {info.file_size}"
                    )
                elif crc != info.CRC:
                    result["reasons"].append(f"archive member {raw_name!r} CRC does not match its header")
    except (zipfile.BadZipFile, OSError) as error:
        result["reasons"].append(f"archive is not a readable ZIP: {error}")
    result["reasons"] = result["reasons"][:64]
    result["integrity"] = not result["reasons"]
    return result


def extract_archive(path: str, target: str) -> dict:
    """Extract a previously validated archive, re-checking every member name."""
    os.makedirs(target, exist_ok=False)
    target_real = os.path.realpath(target)
    written = 0
    total = 0
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            relative = safe_member_name(info.filename)
            destination = os.path.join(target, *relative.rstrip("/").split("/"))
            destination_real = os.path.realpath(destination)
            if destination_real != target_real and not destination_real.startswith(target_real + os.sep):
                raise PortableError(f"refusing to extract outside the scratch target: {info.filename!r}")
            if relative.endswith("/"):
                os.makedirs(destination, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with archive.open(info) as source, open(destination, "wb") as sink:
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    sink.write(chunk)
            written += 1
    return {"files": written, "bytes": total}


def run_roots_under(directory: str) -> list:
    return sorted(
        os.path.join(directory, name)
        for name in os.listdir(directory)
        if os.path.isdir(os.path.join(directory, name))
    )


# ---------------------------------------------------------------------------
# Node subprocess environment
# ---------------------------------------------------------------------------
def node_environment() -> dict:
    """A deliberately reduced environment: no Git, proxy or npm routing."""
    environment = {}
    dropped_prefixes = ("git_", "npm_", "node_")
    dropped_names = {
        "http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy",
        "node_options", "node_path", "node_extra_ca_certs",
    }
    for key, value in os.environ.items():
        lowered = key.lower()
        if lowered in dropped_names or lowered.startswith(dropped_prefixes):
            continue
        environment[key] = value
    return environment


def which_node() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for candidate in ("node.exe", "node"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return os.path.abspath(candidate)
    return None


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def read_frozen_input(repo: str, commit: str, relative: str, expected_sha: str):
    """Return (bytes, source, actual_sha); prefers the Git-frozen blob."""
    attempts = []
    blob = None
    try:
        completed = subprocess.run(
            ["git", "-C", repo, "show", f"{commit}:{relative}"],
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout:
            blob = completed.stdout
    except OSError:
        blob = None
    if blob is not None:
        digest = sha256_bytes(blob)
        attempts.append(("git", digest))
        if digest == expected_sha:
            return blob, "git", digest
    working = os.path.join(repo, *relative.split("/"))
    if os.path.isfile(working):
        data = read_bytes(working)
        digest = sha256_bytes(data)
        attempts.append(("worktree", digest))
        if digest == expected_sha:
            return data, "worktree", digest
    detail = ", ".join(f"{source}={digest}" for source, digest in attempts) or "no readable source"
    raise PortableError(
        f"frozen input {relative} does not match its declared SHA256 {expected_sha} ({detail})"
    )


def cmd_build(args) -> int:
    repo = os.path.abspath(args.repo)
    archives_root = os.path.abspath(args.archives_root)
    out = os.path.abspath(args.out)
    summary = {"command": "build", "ok": False, "out": out, "inputs": [], "archives": []}
    try:
        if not os.path.isdir(repo):
            raise PortableError(f"--repo is not a directory: {repo}")
        if not os.path.isdir(archives_root):
            raise PortableError(f"--archives-root is not a directory: {archives_root}")
        if os.path.lexists(out):
            raise PortableError(f"--out must be a NEW directory, it already exists: {out}")
        inputs_path = os.path.join(repo, "docs", "development", "evidence", "closeout-20260915", BUNDLE_INPUTS_NAME)
        inputs_bytes = read_bytes(inputs_path)
        inputs = load_inputs(inputs_path)
        commit = inputs["sourceCommit"]

        code_payload = []
        for entry in all_code_inputs(inputs):
            data, source, digest = read_frozen_input(repo, commit, entry["path"], entry["sha256"])
            code_payload.append({"relative": entry["path"], "data": data, "source": source, "sha256": digest})
            summary["inputs"].append({"path": entry["path"], "sha256": digest, "source": source, "kind": "code"})

        archive_payload = []
        for entry in inputs["archives"]:
            absolute = os.path.join(archives_root, *entry["path"].split("/"))
            if not os.path.isfile(absolute):
                raise PortableError(f"archive is missing below --archives-root: {entry['path']}")
            digest = sha256_file(absolute)
            if digest != entry["sha256"]:
                raise PortableError(
                    f"archive {entry['path']} does not match its declared SHA256 "
                    f"{entry['sha256']} (actual {digest})"
                )
            shape = inspect_archive(absolute, deep=False)
            if not shape["integrity"]:
                raise PortableError(f"archive {entry['path']} is unsafe: {shape['reasons'][0]}")
            archive_payload.append({"relative": entry["path"], "absolute": absolute, "sha256": digest})
            summary["archives"].append({
                "path": entry["path"],
                "sha256": digest,
                "replay": entry.get("replay"),
                "files": shape["files"],
                "uncompressedBytes": shape["uncompressedBytes"],
            })

        # Every input is verified before a single byte is written.
        script_bytes = read_bytes(os.path.abspath(__file__))
        os.makedirs(out, exist_ok=False)
        write_bytes(os.path.join(out, BUNDLE_SCRIPT_NAME), script_bytes)
        write_bytes(os.path.join(out, BUNDLE_INPUTS_NAME), inputs_bytes)
        for item in code_payload:
            write_bytes(os.path.join(out, BUNDLE_REPO_DIR, *item["relative"].split("/")), item["data"])
        for item in archive_payload:
            destination = os.path.join(out, BUNDLE_ARCHIVES_DIR, *item["relative"].split("/"))
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            shutil.copyfile(item["absolute"], destination)
        manifest_entries = write_manifest(out)
        summary["ok"] = True
        summary["manifestEntries"] = manifest_entries
        summary["sourceCommit"] = commit
        summary["codeInputs"] = len(code_payload)
        summary["archiveInputs"] = len(archive_payload)
        summary["note"] = (
            "Bundle assembled from SHA256-verified frozen inputs only; the builder checked archive member "
            "names but the relocated verify command is the authority for payload hashes, per-entry integrity "
            "and reader replay."
        )
    except PortableError as error:
        summary["error"] = str(error)
        emit_stdout(summary)
        return 1
    except OSError as error:
        summary["error"] = f"I/O failure: {error}"
        emit_stdout(summary)
        return 1
    emit_stdout(summary)
    return 0


def write_bytes(path: str, data: bytes) -> None:
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
def _expected_group_map(inputs: dict) -> dict:
    mapping = {}
    for archive in inputs["archives"]:
        group = archive.get("replay")
        if group:
            mapping[group] = archive
    return mapping


def _bounded_check(report: dict, name: str, passed: bool, evidence: str) -> None:
    report["checks"].append({"name": name, "passed": bool(passed), "evidence": evidence})


def validate_verify_paths(bundle: str, scratch: str, report_path: str):
    """Check every bundle/scratch/report path rule before anything is written.

    Returns `(problems, report_writable)`.

    * `problems` is empty when every rule holds.
    * `report_writable` is False when the `--report` path itself is unusable: it
      lies inside the bundle or the scratch, it already exists as a file,
      directory or symlink, or its parent directory is missing. In that case no
      report may be written at all -- writing it could overwrite a file of the
      very bundle under verification.

    The comparison uses `normalized_path`, so directory symlinks and case
    aliases cannot bypass it.
    """
    problems = []
    report_writable = True

    if not os.path.isdir(bundle):
        problems.append(f"--bundle is not a directory: {bundle}")
    if os.path.lexists(scratch):
        problems.append(f"--scratch must be a NEW directory, it already exists: {scratch}")

    report_parent = os.path.dirname(report_path)
    if not report_parent or not os.path.isdir(report_parent):
        problems.append(f"--report parent directory does not exist: {report_parent or report_path}")
        report_writable = False
    if os.path.isdir(report_path):
        problems.append(f"--report must be a file path, not an existing directory: {report_path}")
        report_writable = False
    elif os.path.lexists(report_path):
        problems.append(f"--report must be a NEW file, it already exists: {report_path}")
        report_writable = False

    bundle_real = normalized_path(bundle)
    scratch_real = normalized_path(scratch)
    report_real = normalized_path(report_path)
    if path_within(scratch_real, bundle_real):
        problems.append(f"--scratch must not be inside --bundle: {scratch} is inside {bundle}")
    if path_within(bundle_real, scratch_real):
        problems.append(f"--bundle must not be inside --scratch: {bundle} is inside {scratch}")
    if path_within(report_real, bundle_real):
        problems.append(f"--report must not be inside --bundle: {report_path} is inside {bundle}")
        report_writable = False
    if path_within(report_real, scratch_real):
        problems.append(f"--report must not be inside --scratch: {report_path} is inside {scratch}")
        report_writable = False

    return problems, report_writable


def cmd_verify(args) -> int:
    bundle = os.path.abspath(args.bundle)
    scratch = os.path.abspath(args.scratch)
    report_path = os.path.abspath(args.report)
    report = {
        "schemaVersion": SCHEMA_REPORT,
        "mode": "offline-portable-verify",
        "ok": False,
        "bundle": bundle,
        "scratch": scratch,
        "sourceCommit": None,
        "manifestEntries": None,
        "inputs": {"reader": None, "helpers": [], "archives": []},
        "archiveShapes": [],
        "extraction": [],
        "groups": {},
        "readerInvocations": [],
        "node": None,
        "mismatches": [],
        "failures": [],
        "checks": [],
        "notes": [
            "Payload membership/bytes/SHA256 is checked before any extraction or Node execution.",
            "All eight archives are hash- and entry-verified; only archives whose inputs.json replay field names a "
            "group are successful-run replay inputs. Failed/unknown history is verified, never skipped.",
            "Historical absolute path strings inside the originals are preserved byte-for-byte and are never "
            "dereferenced; verification depends only on the relocated bundle.",
            "User configuration, credentials and unrelated repository files are not part of the bundle.",
            "Bundle, scratch and report path relationships are validated before anything is written; an unsafe "
            "--report path is refused without being written.",
        ],
    }

    # Every path relationship is settled first. If the report path itself is
    # unusable it is never written, not even for the failure it just detected.
    path_problems, report_writable = validate_verify_paths(bundle, scratch, report_path)

    def write_report() -> None:
        if not report_writable:
            return
        try:
            write_json(report_path, report)
        except OSError as error:
            sys.stderr.write(f"could not write report {report_path}: {error}\n")

    def fail(message: str) -> int:
        report["failures"].append(message)
        _bounded_check(report, "verify", False, message)
        report["ok"] = False
        write_report()
        emit_stdout(bounded_summary(report))
        return 1

    if path_problems:
        for problem in path_problems:
            report["failures"].append(problem)
            sys.stderr.write(f"{problem}\n")
        _bounded_check(report, "path_safety", False, path_problems[0])
        report["ok"] = False
        write_report()
        emit_stdout(bounded_summary(report))
        return 1
    _bounded_check(
        report, "path_safety", True,
        "--report is a new file outside --bundle and --scratch, and --scratch does not overlap --bundle",
    )

    try:
        bundle_inputs_path = os.path.join(bundle, BUNDLE_INPUTS_NAME)
        inputs = load_inputs(bundle_inputs_path)
        report["sourceCommit"] = inputs["sourceCommit"]

        # --- 1. whole-payload manifest: membership, bytes, SHA256 -------------
        declared, manifest_problems = check_manifest(bundle)
        if declared is None:
            return fail(f"bundle manifest is unusable: {manifest_problems[0]}")
        report["manifestEntries"] = len(declared)
        if manifest_problems:
            for problem in manifest_problems[:32]:
                report["mismatches"].append(problem)
            _bounded_check(report, "payload_manifest", False, manifest_problems[0])
            return fail(f"payload manifest check failed ({len(manifest_problems)} problem(s))")
        _bounded_check(report, "payload_manifest", True, f"{len(declared)} payload file(s) match MANIFEST.sha256")

        # --- 2. every inputs.json SHA256 is re-checked inside the bundle ------
        missing = []
        sha_problems = []
        for entry in all_code_inputs(inputs):
            relative = f"{BUNDLE_REPO_DIR}/{entry['path']}"
            absolute = os.path.join(bundle, BUNDLE_REPO_DIR, *entry["path"].split("/"))
            if relative not in declared or not os.path.isfile(absolute):
                missing.append(relative)
                continue
            digest = sha256_file(absolute)
            record = {"path": entry["path"], "bundlePath": relative, "declaredSha256": entry["sha256"],
                      "actualSha256": digest, "sha256Match": digest == entry["sha256"]}
            if entry is inputs["reader"]:
                report["inputs"]["reader"] = record
            else:
                report["inputs"]["helpers"].append(record)
            if digest != entry["sha256"]:
                sha_problems.append(f"{relative} actual {digest} != declared {entry['sha256']}")
        report["inputs"]["reader"] = report["inputs"]["reader"] or None
        for entry in inputs["archives"]:
            relative = f"{BUNDLE_ARCHIVES_DIR}/{entry['path']}"
            absolute = os.path.join(bundle, BUNDLE_ARCHIVES_DIR, *entry["path"].split("/"))
            if relative not in declared or not os.path.isfile(absolute):
                missing.append(relative)
                continue
            digest = sha256_file(absolute)
            record = {"path": entry["path"], "bundlePath": relative, "replay": entry.get("replay"),
                      "declaredSha256": entry["sha256"], "actualSha256": digest,
                      "sha256Match": digest == entry["sha256"]}
            report["inputs"]["archives"].append(record)
            if digest != entry["sha256"]:
                sha_problems.append(f"{relative} actual {digest} != declared {entry['sha256']}")
        if missing or sha_problems:
            for problem in (missing + sha_problems)[:32]:
                report["mismatches"].append(problem)
            first = (missing + sha_problems)[0]
            _bounded_check(report, "inputs_sha256", False, first)
            return fail(f"frozen input SHA256/membership check failed ({len(missing) + len(sha_problems)} problem(s))")
        if report["inputs"]["reader"] is None:
            return fail("bundle does not carry the frozen reader at its declared path")
        _bounded_check(
            report, "inputs_sha256", True,
            f"reader + {len(report['inputs']['helpers'])} helper(s) + {len(report['inputs']['archives'])} archive(s) "
            "match the SHA256 declared in inputs.json",
        )

        # --- 3. per-entry integrity of ALL archives (no extraction yet) -------
        shapes = []
        unsafe = []
        for record in report["inputs"]["archives"]:
            absolute = os.path.join(bundle, BUNDLE_ARCHIVES_DIR, *record["path"].split("/"))
            shape = inspect_archive(absolute, deep=True)
            shape.update({"path": record["path"], "replay": record["replay"], "sha256": record["actualSha256"]})
            shapes.append(shape)
            report["archiveShapes"].append({
                "path": shape["path"], "replay": shape["replay"], "sha256": shape["sha256"],
                "entries": shape["entries"], "files": shape["files"], "directories": shape["directories"],
                "uncompressedBytes": shape["uncompressedBytes"], "integrity": shape["integrity"],
                "reasons": shape["reasons"],
            })
            if not shape["integrity"]:
                unsafe.append(f"{record['path']}: {shape['reasons'][0]}")
        if unsafe:
            for problem in unsafe[:32]:
                report["mismatches"].append(problem)
            _bounded_check(report, "archive_integrity", False, unsafe[0])
            return fail(f"archive entry integrity failed for {len(unsafe)} archive(s); nothing was extracted")
        _bounded_check(
            report, "archive_integrity", True,
            "all " + str(len(shapes)) + " archive(s) pass SHA256, member-name safety and per-entry CRC/size checks",
        )

        # --- 4. only now: extract into the fresh scratch -----------------------
        os.makedirs(scratch, exist_ok=False)
        extracted_root = os.path.join(scratch, "extracted")
        os.makedirs(extracted_root, exist_ok=True)
        group_run_roots = {}
        for shape in shapes:
            # One distinct scratch directory per archive, derived from its full
            # relative path so no two inputs can collide.
            stem = shape["path"]
            if stem.lower().endswith(".zip"):
                stem = stem[: -len(".zip")]
            target = os.path.join(extracted_root, stem.replace("/", "__"))
            outcome = extract_archive(os.path.join(bundle, BUNDLE_ARCHIVES_DIR, *shape["path"].split("/")), target)
            report["extraction"].append({"archive": shape["path"], "directory": os.path.relpath(target, scratch).replace(os.sep, "/"),
                                         "files": outcome["files"], "bytes": outcome["bytes"]})
            if shape["replay"]:
                group_run_roots[shape["replay"]] = run_roots_under(target)
        _bounded_check(
            report, "archive_extraction", True,
            f"{len(report['extraction'])} archive(s) extracted into a fresh scratch with original bytes preserved",
        )

        node = which_node()
        if not node:
            return fail("Node is not available on PATH; the reader cannot be replayed")
        version = subprocess.run([node, "--version"], capture_output=True, check=False,
                                 env=node_environment(), cwd=scratch)
        report["node"] = {
            "path": node,
            "version": (version.stdout or b"").decode("utf-8", "replace").strip() or None,
            "versionExitCode": version.returncode,
        }
        if version.returncode != 0:
            return fail("Node is present but 'node --version' failed")

        reader_relative = f"{BUNDLE_REPO_DIR}/{inputs['reader']['path']}"
        reader_absolute = os.path.join(bundle, BUNDLE_REPO_DIR, *inputs["reader"]["path"].split("/"))
        repo_root = os.path.join(bundle, BUNDLE_REPO_DIR)
        reader_dir = os.path.join(scratch, "reader")
        os.makedirs(reader_dir, exist_ok=True)

        expected_map = _expected_group_map(inputs)
        for group in sorted(inputs["expectations"]):
            expected = inputs["expectations"][group]
            roots = group_run_roots.get(group) or []
            entry = {"group": group, "expected": expected, "runRoots": len(roots), "observed": None,
                     "checks": [], "passed": False}
            report["groups"][group] = entry
            if not roots:
                entry["checks"].append({"name": "run_roots", "passed": False,
                                        "evidence": f"replay group {group} yielded no extracted run root"})
                report["failures"].append(f"replay group {group} yielded no extracted run root")
                continue
            argv = [node, reader_absolute, "--repo", repo_root] + roots
            display = [os.path.basename(node), f"<bundle>/{reader_relative}", "--repo", "<bundle>/" + BUNDLE_REPO_DIR]
            display += [f"<scratch>/{os.path.relpath(root, scratch).replace(os.sep, '/')}" for root in roots]
            completed = subprocess.run(argv, capture_output=True, check=False,
                                       env=node_environment(), cwd=scratch, timeout=args.timeout_seconds)
            stdout_path = os.path.join(reader_dir, f"{group}.stdout.json")
            stderr_path = os.path.join(reader_dir, f"{group}.stderr.txt")
            write_bytes(stdout_path, completed.stdout)
            write_bytes(stderr_path, completed.stderr)
            invocation = {
                "group": group,
                "argv": display,
                "exitCode": completed.returncode,
                "timedOut": False,
                "stdoutFile": os.path.relpath(stdout_path, scratch).replace(os.sep, "/"),
                "stdoutBytes": len(completed.stdout),
                "stdoutSha256": sha256_bytes(completed.stdout),
                "stderrFile": os.path.relpath(stderr_path, scratch).replace(os.sep, "/"),
                "stderrBytes": len(completed.stderr),
                "stderrSha256": sha256_bytes(completed.stderr),
                "parsed": False,
            }
            report["readerInvocations"].append(invocation)
            try:
                parsed = json.loads(completed.stdout.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as error:
                invocation["parseError"] = str(error)
                entry["checks"].append({"name": "reader_json", "passed": False,
                                        "evidence": f"reader stdout is not one JSON document: {error}"})
                report["failures"].append(f"reader invocation for {group} did not emit parseable JSON")
                continue
            invocation["parsed"] = True
            if not isinstance(parsed, dict):
                entry["checks"].append({"name": "reader_json", "passed": False,
                                        "evidence": "reader stdout is not a JSON object"})
                report["failures"].append(f"reader invocation for {group} did not emit a JSON object")
                continue
            observed, group_checks, group_failures = evaluate_group(group, expected, completed.returncode, parsed)
            entry["observed"] = observed
            entry["checks"] = group_checks
            entry["passed"] = not group_failures
            report["failures"].extend(group_failures)

        # --- 5. group expectations -------------------------------------------
        for group in sorted(inputs["expectations"]):
            entry = report["groups"].get(group)
            name = f"group_expectations:{group}"
            if entry is None:
                _bounded_check(report, name, False, "no verification outcome was produced for this group")
                continue
            evidence = "; ".join(
                f"{check['name']}={'ok' if check['passed'] else 'FAIL'}" for check in entry["checks"]
            ) or "no check ran"
            _bounded_check(report, name, bool(entry["passed"]), evidence)

        groups_ok = all(report["groups"].get(group, {}).get("passed") for group in inputs["expectations"])
        replays_ok = len(report["readerInvocations"]) == len(expected_map)
        replay_groups = sorted(expected_map)
        strict_groups = [group for group in replay_groups
                         if report["groups"].get(group, {}).get("observed", {})
                         and report["groups"][group]["observed"].get("strictN20Eligible")]
        declared_strict_groups = [group for group in replay_groups if inputs["expectations"][group]["strictN20"]]
        _bounded_check(
            report, "strict_n20_scope", strict_groups == declared_strict_groups,
            f"strictN20Eligible groups observed: {strict_groups or 'none'}; "
            f"declared by inputs.json: {declared_strict_groups or 'none'}",
        )
        ok = groups_ok and replays_ok and not report["failures"]
        report["ok"] = bool(ok)
        report["strictN20EligibleGroups"] = strict_groups
        report["result"] = {
            "ok": bool(ok),
            "exitCode": 0 if ok else 1,
            "groups": {group: bool(report["groups"].get(group, {}).get("passed")) for group in inputs["expectations"]},
            "replayInvocations": len(report["readerInvocations"]),
        }
        _bounded_check(report, "verify", bool(ok),
                       "all payload, archive, extraction and reader replay checks passed" if ok
                       else f"{len(report['failures'])} failure(s) retained in this report")
        write_report()
        emit_stdout(bounded_summary(report))
        return 0 if ok else 1
    except PortableError as error:
        return fail(str(error))
    except subprocess.TimeoutExpired as error:
        report["failures"].append(
            f"Node reader subprocess exceeded {args.timeout_seconds}s: {error}"
        )
        _bounded_check(report, "reader_timeout", False, f"timeout after {args.timeout_seconds}s")
        report["ok"] = False
        write_report()
        emit_stdout(bounded_summary(report))
        return 1
    except OSError as error:
        return fail(f"I/O failure: {error}")


def evaluate_group(group: str, expected: dict, exit_code: int, parsed: dict):
    """Recompute the group's runs/candidates/models/strict-N20 from the reader output."""
    checks = []
    failures = []
    coverage = parsed.get("coverage") if isinstance(parsed.get("coverage"), dict) else {}
    result = parsed.get("result") if isinstance(parsed.get("result"), dict) else {}
    strict = parsed.get("strictN20") if isinstance(parsed.get("strictN20"), dict) else {}
    models = coverage.get("models") if isinstance(coverage.get("models"), list) else []
    observed = {
        "invocations": coverage.get("invocations"),
        "candidateTasks": coverage.get("candidateTasks"),
        "distinctCandidateDigests": coverage.get("distinctCandidateDigests"),
        "modelRuns": coverage.get("modelRuns"),
        "models": models,
        "familyCount": coverage.get("familyCount"),
        "runCount": result.get("runCount"),
        "fullSuccessRuns": result.get("fullSuccessRuns"),
        "verifiedRuns": result.get("verifiedRuns"),
        "readerOk": result.get("ok"),
        "strictN20Eligible": strict.get("eligible"),
        "strictN20RequiredRuns": strict.get("requiredRuns"),
        "exitCode": exit_code,
    }

    def compare(name: str, actual, wanted) -> None:
        passed = actual == wanted
        checks.append({"name": name, "passed": passed, "evidence": f"observed={actual!r} expected={wanted!r}"})
        if not passed:
            failures.append(f"group {group}: {name} observed {actual!r} but inputs.json expects {wanted!r}")

    compare("reader_exit_code", exit_code, 0)
    compare("reader_ok", result.get("ok"), True)
    compare("invocations", coverage.get("invocations"), expected["runs"])
    compare("run_count", result.get("runCount"), expected["runs"])
    compare("verified_runs", result.get("verifiedRuns"), expected["runs"])
    compare("full_success_runs", result.get("fullSuccessRuns"), expected["runs"])
    compare("candidates", coverage.get("candidateTasks"), expected["candidates"])
    compare("distinct_candidate_digests", coverage.get("distinctCandidateDigests"), expected["candidates"])
    compare("model_runs", coverage.get("modelRuns"), expected["modelRuns"])
    compare("strict_n20", strict.get("eligible"), expected["strictN20"])
    compare("strict_n20_required_runs", strict.get("requiredRuns"), REQUIRED_STRICT_N20_RUNS)
    usable = [model for model in models
              if isinstance(model, str) and model.strip()
              and model.strip().lower() not in SENTINEL_MODELS]
    models_ok = bool(usable) and len(usable) == len(models)
    checks.append({"name": "observed_models", "passed": models_ok,
                   "evidence": f"models={models!r}"})
    if not models_ok:
        failures.append(f"group {group}: no usable concrete observed model label was reported")
    families = coverage.get("families") if isinstance(coverage.get("families"), list) else []
    checks.append({"name": "families", "passed": bool(families), "evidence": f"families={families!r}"})
    if not families:
        failures.append(f"group {group}: reader reported no verified family identity")
    return observed, checks, failures


def bounded_summary(report: dict) -> dict:
    """A small stdout document; the full report stays in the --report file."""
    return {
        "schemaVersion": report["schemaVersion"],
        "mode": report["mode"],
        "ok": report["ok"],
        "sourceCommit": report["sourceCommit"],
        "manifestEntries": report["manifestEntries"],
        "node": report.get("node"),
        "groups": {
            group: {
                "passed": entry.get("passed"),
                "runRoots": entry.get("runRoots"),
                "observed": entry.get("observed"),
            }
            for group, entry in report["groups"].items()
        },
        "readerInvocations": [
            {"group": item["group"], "exitCode": item["exitCode"], "stdoutBytes": item["stdoutBytes"],
             "stdoutFile": item["stdoutFile"]}
            for item in report["readerInvocations"]
        ],
        "archiveIntegrity": [
            {"path": shape["path"], "replay": shape["replay"], "integrity": shape["integrity"],
             "files": shape["files"]}
            for shape in report.get("archiveShapes", [])
        ],
        "failures": report["failures"][:32],
        "checks": report["checks"],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="portable-evidence.py",
        description=(
            "Offline, relocatable packaging and verification of the closeout evidence. "
            "Standard library only; no network, provider, GPU, model call or install."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", metavar="{build,verify}")

    builder = subparsers.add_parser(
        "build",
        help="assemble a relocatable bundle from SHA256-verified frozen inputs",
        description=(
            "Assemble a NEW directory containing this script, the frozen inputs.json, the reader and four "
            "helper modules at their repository-relative paths, the eight byte-original ZIPs and a "
            "relative-path SHA256 manifest. Every input is rejected unless its SHA256 matches inputs.json."
        ),
    )
    builder.add_argument("--repo", required=True, metavar="PATH", help="repository holding inputs.json and the frozen code")
    builder.add_argument("--archives-root", required=True, metavar="PATH",
                         help="explicit .operator-studio-local base holding the eight original ZIPs")
    builder.add_argument("--out", required=True, metavar="NEW_DIRECTORY", help="new, not yet existing bundle directory")
    builder.set_defaults(handler=cmd_build)

    verifier = subparsers.add_parser(
        "verify",
        help="verify and replay a relocated bundle without the source checkout",
        description=(
            "Check the whole payload membership/bytes/SHA256, then every archive entry, then extract into a "
            "fresh scratch directory and replay the unmodified reader with the bundled helper repo. "
            "Requires only Python and Node."
        ),
    )
    verifier.add_argument("--bundle", required=True, metavar="DIRECTORY", help="relocated bundle produced by build")
    verifier.add_argument("--scratch", required=True, metavar="NEW_DIRECTORY",
                          help="new, not yet existing scratch directory receiving the extracted originals; "
                               "must not overlap --bundle")
    verifier.add_argument("--report", required=True, metavar="PATH",
                          help="new JSON report file outside --bundle and --scratch; an unsafe path is refused "
                               "without being written")
    verifier.add_argument("--timeout-seconds", type=int, default=1800, metavar="N",
                          help="per-reader-invocation timeout in seconds (default 1800)")
    verifier.set_defaults(handler=cmd_verify)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 2
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
