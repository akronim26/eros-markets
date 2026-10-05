#!/usr/bin/env python3
"""Check the versioned integration inputs without changing historical PF scope."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
BASELINE = "packages/pricefeed/config/integration-scope-2026-10-06.json"
HISTORICAL = "artifacts/pricefeed-reverification/protected-files-before.json"
INPUT_ROOTS = ["contracts/src", "contracts/test", "contracts/script", "oracle/abi", "oracle/src", "oracle/test",
               "oracle/script", "oracle/e2e", "oracle/packages", "oracle/services",
               "oracle/validation", "oracle/vectors", "oracle/listings", "scripts/integration", "packages/risk-sdk",
               "packages/pricefeed/src", "packages/pricefeed/scripts", "packages/pricefeed/test",
               "packages/pricefeed/config", "packages/pricefeed/fixtures", "packages/pricefeed/reference"]
INPUT_FILES = [".gitmodules", ".env.example", "contracts/foundry.toml", "contracts/foundry.lock", "oracle/foundry.toml",
               "oracle/foundry.lock", "oracle/package.json", "oracle/bun.lock",
               "scripts/check-task.sh",
               "packages/pricefeed/package.json", "packages/pricefeed/package-lock.json",
               "packages/pricefeed/tsconfig.json"]


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root).decode("utf8").strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_text(path):
    """Normalize checkout line endings only for declared source/config formats."""
    if path.as_posix() in {"oracle/validation/dataset/raw/MANIFEST.json", "oracle/validation/dataset/crypto-price/raw/MANIFEST.json"}:
        return True  # Hash inventories are metadata; their referenced raw bodies remain byte-exact.
    if any(part in {"raw", "raw-bodies", "bodies", "archive", "archives", "custody", "signed", "signed-payloads"} for part in path.parts):
        return False
    if path.stem in {"body", "raw", "signed", "payload"} or path.name.startswith(("raw-", "body-", "signed-", "payload-")):
        return False
    return path.suffix in {".ts", ".sol", ".py", ".sh", ".toml", ".md", ".html", ".example", ".lock", ".json", ".txt", ".log"} or path.name in {".gitmodules", ".gitignore", ".gitattributes", "SHA256SUMS"}


def source_digest(path):
    raw = path.read_bytes()
    assert b"\0" not in raw, f"binary content in source text: {path}"
    raw.decode("utf8")  # Do not reinterpret arbitrary binary as source text.
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def inventories(root):
    source, exact = {}, {}
    for path in input_files(root):
        if source_text(Path(path)):
            source[path] = source_digest(root / path)
        else:
            exact[path] = digest(root / path)
    return source, exact


def historical_identity(root):
    blob = git(root, "rev-parse", f"HEAD:{HISTORICAL}")
    canonical = subprocess.check_output(["git", "cat-file", "blob", blob], cwd=root)
    return {"historicalBaselineBlob": blob,
            "historicalBaselineSha256": hashlib.sha256(canonical).hexdigest(),
            "historicalBaselineHashSource": "EXACT_GIT_BLOB_BYTES",
            "historicalBaselineRawSha256AtCapture": digest(root / HISTORICAL)}


def input_files(root):
    paths = git(root, "ls-files", "-co", "--exclude-standard", "-z", "--", *INPUT_ROOTS, *INPUT_FILES)
    return sorted(set(path for path in paths.split("\0") if path and path != BASELINE))


def submodules(root):
    result = {}
    for line in git(root, "ls-files", "--stage").splitlines():
        header, path = line.split("\t", 1)
        mode, commit, _ = header.split()
        if mode == "160000":
            result[path] = commit
    return result


def check(root, manifest):
    assert manifest["schemaVersion"] == 1 and manifest["scope"] == "LOCAL_CROSS_COMPONENT_INTEGRATION_2026_10_06"
    assert manifest["historicalBaseline"] == HISTORICAL
    assert manifest["historicalBaselineHashSource"] == "EXACT_GIT_BLOB_BYTES"
    blob = git(root, "rev-parse", f"HEAD:{HISTORICAL}")
    assert blob == manifest["historicalBaselineBlob"], "historical PF baseline changed"
    canonical = subprocess.check_output(["git", "cat-file", "blob", blob], cwd=root)
    assert hashlib.sha256(canonical).hexdigest() == manifest["historicalBaselineSha256"], "historical PF baseline changed"
    assert (root / HISTORICAL).read_bytes().replace(b"\r\n", b"\n") == canonical.replace(b"\r\n", b"\n"), "historical PF baseline changed"
    assert manifest["humanGatesAccepted"] is False and manifest["productionApproved"] is False
    assert manifest["externalChainTransactions"] == 0
    assert manifest["authorization"]["reference"] == "docs/integration/INTEGRATION_READINESS.md"
    assert manifest["inputRoots"] == INPUT_ROOTS and manifest["inputFiles"] == INPUT_FILES
    assert manifest["sourceTextNormalization"] == "UTF8_CRLF_TO_LF_ONLY"
    source, exact = manifest["normalizedSourceTextSha256"], manifest["exactRawFileSha256"]
    assert not set(source).intersection(exact), "ambiguous source/raw hash inventory"
    expected = {**source, **exact}
    actual = input_files(root)
    assert actual == sorted(expected), "integration input inventory changed; review and version its baseline"
    for path in actual:
        target = (root / path).resolve()
        assert target.is_relative_to(root.resolve()) and target.is_file(), f"missing or external input: {path}"
        assert source_text(Path(path)) == (path in source), f"source/raw classification changed: {path}"
        actual_hash = source_digest(target) if path in source else digest(target)
        assert actual_hash == expected[path], f"integration input changed: {path}"
    assert submodules(root) == manifest["submoduleCommits"], "dependency gitlinks changed"
    for path, commit in manifest["submoduleCommits"].items():
        directory = root / path
        assert git(directory, "rev-parse", "HEAD") == commit, f"dependency checkout changed: {path}"
        assert not git(directory, "status", "--porcelain", "--untracked-files=normal"), f"dependency worktree changed: {path}"
    return len(actual)


if __name__ == "__main__":
    assert len(sys.argv) == 1, "usage: check-integration-scope.py (fixed versioned manifest; no baseline rewrite option)"
    count = check(ROOT, json.loads((ROOT / BASELINE).read_text(encoding="utf8")))
    print(f"PASS: {count} versioned integration input hashes and dependency revisions; historical PF baseline preserved; no PF or production approval")
