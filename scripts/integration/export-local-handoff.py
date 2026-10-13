"""Export an allowlisted source handoff, excluding named private/runtime artifacts."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = (
    "oracle/services/local-integration/", "oracle/services/keeper/", "oracle/services/panel-runner/",
    "oracle/services/watchdog/", "oracle/services/committee-console/", "oracle/services/snapshotter/",
    "oracle/packages/oracle-sdk/", "oracle/workflows/", "scripts/integration/",
    "oracle/services/market-ops/",
)
EXACT = {
    "oracle/.gitignore", "oracle/bun.lock", "oracle/package.json", "oracle/.gitattributes",
    "oracle/script/integration/LocalIntegration.s.sol", "oracle/test/integration/LocalIntegrationSafety.t.sol",
    "packages/pricefeed/scripts/local-factory-fixture.ts", "packages/pricefeed/scripts/local-factory-integration.ts",
    "packages/pricefeed/test/local-factory-fixture.test.ts",
    "packages/pricefeed/scripts/local-sampling-lock.ts",
    "docs/merge/STATUS.md", "docs/integration/REAL_FACTORY_INTEGRATION.md", "RISK_PROGRESS.md",
    "docs/integration/LEVERAGE_INTEGRATION.md",
    "contracts/src/engine/BookRiskEngine.sol", "contracts/src/engine/RiskAccountingBridge.sol",
    "contracts/src/risk/RiskContextPort.sol", "contracts/src/factory/MarketFactory.sol", "contracts/src/factory/EngineCodeParts.sol",
    "oracle/script/integration/DeployRealFactory.s.sol", "oracle/test/integration/FactoryGas.t.sol",
    "oracle/test/integration/RealMarketFactory.t.sol", "oracle/test/integration/RealMarketFixture.sol",
    "oracle/test/integration/LeveragedFactory.t.sol", "artifacts/risk/book-risk-engine-abi.json",
    "artifacts/risk/engine-abi.json", "artifacts/risk/vault-abi.json", "artifacts/gates/G3.json",
    "artifacts/integration/reserve-funded-leverage.json",
}
EXACT.update(f"artifacts/tasks/{lane}{number:03d}.json" for lane in "AB" for number in range(16, 22))
SOURCE_SUFFIXES = {".ts", ".py", ".md", ".json", ".yaml", ".yml", ".toml", ".sol", ".lock", ".txt"}
SOURCE_DOTFILES = {".gitattributes", ".gitignore"}
EXCLUDED_DIRECTORIES = {
    "node_modules", "__pycache__", "dist", "var", "snapshots", ".envio", "logs", "runtime",
    "keystore", "keystores", "credentials", "secrets", "wallets", "private",
}
SECRET_NAME = re.compile(r"(?:^|[-_.])(credentials?|keystores?|private[-_]?keys?|api[-_]?keys?|passwords?|secrets?)(?:$|[-_.])", re.I)
RUNTIME_JSON_NAME = re.compile(r"(?:^|[-_.])(wallets?|keys?|tokens?|journal|runtime|session)(?:$|[-_.])", re.I)


def relative_parts(path):
    candidate = PurePosixPath(path)
    if not path or not candidate.parts or "\\" in path or ":" in path or candidate.is_absolute() or path != candidate.as_posix() or ".." in candidate.parts:
        raise ValueError(f"Only canonical repository-relative paths can be exported: {path}")
    return candidate.parts


def allowed(path):
    try:
        parts = relative_parts(path)
    except ValueError:
        return False
    lowered = tuple(part.lower() for part in parts)
    if any(part in EXCLUDED_DIRECTORIES or part.startswith(".env") for part in lowered):
        return False
    suffix = PurePosixPath(path).suffix.lower()
    if suffix not in SOURCE_SUFFIXES and parts[-1] not in SOURCE_DOTFILES:
        return False
    if any(SECRET_NAME.search(part) for part in lowered):
        return False
    if suffix in {".json", ".yaml", ".yml", ".txt"} and RUNTIME_JSON_NAME.search(PurePosixPath(path).stem):
        return False
    if "keys" in lowered[:-1] and not ("test" in lowered and "fixtures" in lowered):
        return False
    return path in EXACT or path.startswith(ALLOWED)


def source_path(path, root=None, allow_missing=False):
    root = Path(root or ROOT).absolute()
    candidate = root
    for part in relative_parts(path):
        candidate /= part
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ValueError(f"Refusing linked source path or ancestor: {path}")
    resolved_root = root.resolve(strict=True)
    resolved = candidate.resolve(strict=not allow_missing)
    if not resolved.is_relative_to(resolved_root):
        raise ValueError(f"Source path resolves outside the repository: {path}")
    if candidate.exists() and not candidate.is_file():
        raise ValueError(f"Only regular source files can be exported: {path}")
    return candidate


def main():
    def git(*arguments):
        return subprocess.check_output(["git", *arguments], cwd=ROOT)

    tracked = git("diff", "--name-only", "HEAD").decode().splitlines()
    unexpected = [path for path in tracked if not allowed(path)]
    if unexpected:
        raise SystemExit(f"Review out-of-scope tracked changes before export: {unexpected}")
    additions = [path for path in git("ls-files", "--others", "--exclude-standard").decode().splitlines() if allowed(path)]
    prompts = git("ls-files", "oracle/services/panel-runner/src/prompts/templates/*.txt").decode().splitlines()
    for path in prompts:
        if source_path(path).read_bytes() != git("show", f"HEAD:{path}"):
            raise SystemExit(f"Canonical prompt bytes differ from the pinned source: {path}")
    tracked_files = [path for path in tracked if source_path(path, allow_missing=True).exists()]
    additions = sorted(set([*additions, *prompts, *tracked_files]))
    sources = {path: source_path(path).read_bytes() for path in [*additions, "LOCAL_INTEGRATION_HANDOFF.md"]}
    source = git("rev-parse", "HEAD").decode().strip()
    patch = git("diff", "--binary", "HEAD", "--", *tracked) if tracked else b""
    archive = source_path("tmp/local-integration-handoff.zip", allow_missing=True)
    archive.parent.mkdir(parents=True, exist_ok=True)
    hashes = {path: hashlib.sha256(contents).hexdigest() for path, contents in sources.items()}
    instructions = f"""# Apply the uncommitted local integration handoff

Base commit: {source}

1. Fetch the repository and check out this exact base commit on your own working branch.
2. Initialize its submodules. Preserve any existing work; use a clean checkout.
3. Apply tracked.patch with `git apply --check tracked.patch` then `git apply tracked.patch`.
4. Copy the contents of additions/ to the repository root, preserving paths. This contains
   both new and changed source files so SHA-256 bytes do not depend on checkout line endings.
   It also installs canonical LF prompt fixtures; attributes alone cannot rewrite old CRLF files.
5. Copy LOCAL_INTEGRATION_HANDOFF.md to the repository root but do not commit it.
   Add /LOCAL_INTEGRATION_HANDOFF.md to .git/info/exclude on your machine if desired.
6. Read the handoff and run the documented installation and local tests.

Dependency/cache folders and named private dotenv, credential, keystore and runtime-journal
artifacts are excluded. Symlinks and linked ancestors are refused. This filename/type policy
is not a secret-content audit: review source and tracked.patch for accidentally embedded
credentials before sharing. Disposable public fixture keys are intentionally present in tests.
Reproduce your own local addresses; do not connect to someone else's chain using a new
manifest. The handoff Markdown remains intentionally uncommitted.
This source bundle is not a security audit or a public deployment authorization.
"""
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("tracked.patch", patch)
        bundle.writestr("APPLY.md", instructions)
        bundle.writestr("source-manifest.json", json.dumps({"baseCommit": source, "patchSha256": hashlib.sha256(patch).hexdigest(), "sha256": hashes}, indent=2) + "\n")
        for path in additions:
            bundle.writestr("additions/" + path, sources[path])
        bundle.writestr("LOCAL_INTEGRATION_HANDOFF.md", sources["LOCAL_INTEGRATION_HANDOFF.md"])
    print(json.dumps({"archive": str(archive), "baseCommit": source, "sourceFiles": len(hashes),
                      "exclusionPolicy": "allowlisted source types; named private/runtime artifacts and links refused",
                      "secretContentAuditPerformed": False}))


if __name__ == "__main__":
    main()
