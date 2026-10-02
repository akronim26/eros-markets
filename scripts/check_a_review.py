"""Check that A's completed review covers the source and passing regressions."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


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


def check_review(root):
    try:
        review = validate_review(root)
    except (ValueError, OSError) as error:
        print(json.dumps({"status": "pending_peer_review", "checks_run": 0, "reason": str(error)}))
        return 2
    command = ["forge", "test", "--match-path", "test/reviews/*.t.sol", "--json"]
    run = subprocess.run(command, cwd=root / "contracts", capture_output=True, text=True,
                         env={**os.environ, "FOUNDRY_PROFILE": "risk", "FORGE_SNAPSHOT_EMIT": "false"})
    try:
        payload = json.loads(run.stdout)
        results = [test for suite in payload.values() if isinstance(suite, dict)
                   for test in suite.get("test_results", {}).values()]
    except ValueError:
        results = []
    passed = run.returncode == 0 and bool(results) and all(test.get("status") == "Success" for test in results)
    print(json.dumps({"status": "passed" if passed else "failed", "checks_run": len(results),
                      "reason": "Source-bound A review and regression checks" if passed else "Review regressions failed or were empty",
                      "reviewed_files": len(review["reviewed_files"]), "command": command,
                      "exit_code": run.returncode, "failure_output": "" if passed else (run.stdout + run.stderr)[-8000:]}))
    return 0 if passed else 1
