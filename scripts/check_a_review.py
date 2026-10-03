"""Run unified technical regressions and retain historical review validation."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone


TECHNICAL_SUITES = {"A043": "test/reviews/*.t.sol", "B043": "test/reviews/B043Review.t.sol"}


def forge_environment():
    environment = {name: value for name, value in os.environ.items()
                   if not name.upper().startswith(("FOUNDRY_", "DAPP_"))}
    environment.update(FOUNDRY_PROFILE="risk", FOUNDRY_FUZZ_SEED="0x45524f53", FORGE_SNAPSHOT_EMIT="false")
    return environment


def validate_review(root):
    report = root / "artifacts/reviews/A-on-B.md"
    evidence = root / "artifacts/reviews/A-on-B.json"
    if not report.is_file() or not evidence.is_file():
        raise ValueError("A review report and source-bound evidence are required")
    review = json.loads(evidence.read_text(encoding="utf-8"))
    if "Review status: COMPLETE" not in report.read_text(encoding="utf-8"):
        raise ValueError("A review report is not complete")
    if review.get("reviewer") != "A" or review.get("status") != "complete":
        raise ValueError("A review evidence is not complete")
    if not re.fullmatch(r"[0-9a-f]{40}", review.get("source_commit", "")):
        raise ValueError("A review must identify its source commit")
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", review["source_commit"], "HEAD"],
                              cwd=root, capture_output=True, text=True)
    if ancestor.returncode:
        raise ValueError("A review source commit is not an ancestor of this checkout")
    reviewed_files = review.get("reviewed_files", {})
    required = {"artifacts/reviews/A-on-B.md"}
    for directory in ("contracts/src", "contracts/test/reviews"):
        required.update(path.relative_to(root).as_posix() for path in (root / directory).rglob("*.sol"))
    if not required.issubset(reviewed_files):
        raise ValueError("A review does not cover the current source and review regressions")
    for relative, expected in reviewed_files.items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError("invalid reviewed path: " + relative)
        if hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest() != expected:
            raise ValueError("reviewed source changed: " + relative)
    findings = review.get("findings")
    if not isinstance(findings, list):
        raise ValueError("A review must record its findings")
    unresolved = [item.get("id", "unknown") for item in findings
                  if item.get("severity") in ("Critical", "High") and item.get("status") != "resolved"]
    if unresolved:
        raise ValueError("unresolved critical/high findings: " + ", ".join(unresolved))
    return review


def source_hashes(root):
    paths = set()
    for directory in ("contracts/src", "contracts/test", "contracts/lib"):
        paths.update((root / directory).rglob("*.sol"))
    for relative in ("contracts/foundry.toml", "contracts/remappings.txt", ".gitmodules",
                     "scripts/check_a_review.py", "scripts/check-a-handoff.py",
                     "scripts/check-task.sh", "scripts/check-gate.sh", "reference/tests/a/test_a002.py"):
        if (root / relative).is_file():
            paths.add(root / relative)
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            for path in sorted(paths) if path.is_file()}


def forge_results(output):
    payload = json.loads(output)
    if not isinstance(payload, dict) or not payload:
        raise ValueError("Forge returned an empty or invalid suite")
    results = {}
    for name, suite in payload.items():
        tests = suite.get("test_results") if isinstance(suite, dict) else None
        if not isinstance(tests, dict) or not tests:
            raise ValueError("Forge returned an empty or invalid suite: " + name)
        if any(not isinstance(test, dict) or not isinstance(test.get("status"), str) for test in tests.values()):
            raise ValueError("Forge returned malformed test results: " + name)
        results[name] = {name: test["status"] for name, test in tests.items()}
    return results


def run_forge_suite(root, relative):
    command = ["forge", "test", "--match-path", relative, "--json"]
    report = {"status": "failed", "checks_run": 0, "skipped_count": 0,
              "command": command, "exit_code": 1, "forge_exit_code": None,
              "suite_results": {}, "failure_output": "", "reason": ""}
    try:
        run = subprocess.run(command, cwd=root / "contracts", capture_output=True, text=True,
                             env=forge_environment())
        report["forge_exit_code"] = run.returncode
        report["failure_output"] = (run.stdout + run.stderr)[-8000:]
        report["suite_results"] = forge_results(run.stdout)
        statuses = [status for suite in report["suite_results"].values() for status in suite.values()]
        report["checks_run"] = len(statuses)
        report["skipped_count"] = statuses.count("Skipped")
        if run.returncode or any(status != "Success" for status in statuses):
            raise ValueError("Forge regressions failed or were skipped")
        report.update(status="passed", exit_code=0, failure_output="", reason="All selected regressions passed")
    except (ValueError, OSError) as error:
        report["reason"] = str(error)
    return report


def run_technical_validation(root, task):
    if task not in TECHNICAL_SUITES:
        raise ValueError("Unsupported technical validation task: " + task)
    report = {"task": task, "validation_mode": "unified_team_technical_validation",
              "recorded_at": datetime.now(timezone.utc).isoformat(), "source_commit": None,
              "foundry_profile": "risk", "seed": "0x45524f53",
              "source_hashes": source_hashes(root), "independent_review": False, "independent_audit": False,
              "accepted": False, "merge_sha": None, "status": "failed", "exit_code": 1,
              "checks_run": 0, "skipped_count": 0, "reason": "",
              "evidence": f"artifacts/validation/{task}.json"}
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True)
        report["source_commit"] = commit.stdout.strip()
        if commit.returncode or not re.fullmatch(r"[0-9a-f]{40}", report["source_commit"]):
            raise ValueError("Technical evidence requires a valid source commit")
        if not any((root / "contracts").glob(TECHNICAL_SUITES[task])):
            raise ValueError("Technical regression suite is missing")
        report.update(run_forge_suite(root, TECHNICAL_SUITES[task]))
        if report["source_hashes"] != source_hashes(root):
            raise ValueError("Technical validation source changed during execution")
        if report["status"] == "passed":
            report["reason"] = "Source-bound unified-team technical validation; not independent review or acceptance"
    except (ValueError, OSError) as error:
        report.update(status="failed", exit_code=1, reason=str(error))
    evidence = root / report["evidence"]
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def validate_technical_validation(root, task):
    if task not in TECHNICAL_SUITES:
        raise ValueError("Unsupported technical validation task: " + task)
    path = root / f"artifacts/validation/{task}.json"
    if not path.is_file():
        raise ValueError("Missing source-bound technical evidence: " + task)
    report = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(report, dict) or report.get("task") != task
            or report.get("validation_mode") != "unified_team_technical_validation"
            or report.get("foundry_profile") != "risk" or report.get("seed") != "0x45524f53"
            or report.get("evidence") != f"artifacts/validation/{task}.json"
            or report.get("status") != "passed" or report.get("exit_code") != 0
            or report.get("forge_exit_code") != 0 or report.get("skipped_count") != 0
            or report.get("independent_review") is not False or report.get("independent_audit") is not False
            or report.get("accepted") is not False or report.get("merge_sha") is not None
            or report.get("command") != ["forge", "test", "--match-path", TECHNICAL_SUITES[task], "--json"]):
        raise ValueError("Technical evidence is not a passing unified validation: " + task)
    suites = report.get("suite_results")
    if (not isinstance(suites, dict) or not suites
            or any(not isinstance(suite, dict) or not suite for suite in suites.values())):
        raise ValueError("Technical evidence contains empty suites: " + task)
    statuses = [status for suite in suites.values() for status in suite.values()]
    if any(status != "Success" for status in statuses) or report.get("checks_run") != len(statuses):
        raise ValueError("Technical evidence contains unsuccessful checks: " + task)
    if not report.get("source_hashes") or report["source_hashes"] != source_hashes(root):
        raise ValueError("Technical validation source changed: " + task)
    if not isinstance(report.get("source_commit"), str) or not re.fullmatch(r"[0-9a-f]{40}", report["source_commit"]):
        raise ValueError("Technical evidence must identify its source commit")
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", report["source_commit"], "HEAD"],
                              cwd=root, capture_output=True, text=True)
    if ancestor.returncode:
        raise ValueError("Technical source commit is not an ancestor of this checkout")
    return report


def check_review(root):
    report = run_technical_validation(root, "A043")
    print(json.dumps(report))
    return report["exit_code"]
