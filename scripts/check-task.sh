#!/usr/bin/env bash
# Run from any directory. Python owns discovery/counting so an empty suite fails.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PYTHONHASHSEED=0
export PYTHONDONTWRITEBYTECODE=1
exec "${PYTHON:-python}" - "$root" "$@" <<'PY'
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import unittest
import tomllib
from datetime import datetime, timezone

root = Path(sys.argv[1]).resolve()
if len(sys.argv) != 3 or re.fullmatch(r"[AB](00[1-9]|0[1-3][0-9]|04[0-4])", sys.argv[2]) is None:
    print("usage: bash scripts/check-task.sh A001|...|A044|B001|...|B044", file=sys.stderr)
    sys.exit(2)
task = sys.argv[2]
lane, number = task[0], int(task[1:])
os.chdir(root)
sys.path.insert(0, str(root))
random.seed(0x45524F53)

def probe(command):
    try:
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except OSError:
        return None

record = {
    "schema_version": "1.0",
    "kind": "task",
    "id": task,
    "scope": "task_checks_only",
    "spec_version": "1.1",
    "economic_baseline": "1.0",
    "interface_version": "risk-integration-1",
    "recorded_at": datetime.now(timezone.utc).isoformat(),
    "source_commit": probe(["git", "rev-parse", "HEAD"]),
    "worktree_dirty": None,
    "toolchain": {"python": sys.version.split()[0], "forge": probe(["forge", "--version"]),
                  "solc_declared": "0.8.30", "foundry_profile": "risk",
                  "dependency_status": probe(["git", "submodule", "status"])},
    "seed": "0x45524f53",
    "python_hash_seed": "0",
    "fixture_hashes": {},
    "components": {"selected_suite": "real", "peer_lane": "not_exercised",
                   "external_counterparts": "not_exercised"},
    "commands": [],
    "test_count": 0,
    "skipped_count": 0,
    "status": "failed",
    "exit_code": 2,
    "reason": "",
    "checks": [],
    "artifacts": [f"artifacts/tasks/{task}.json"],
}
dirty = probe(["git", "status", "--porcelain", "--untracked-files=all"])
record["worktree_dirty"] = None if dirty is None else bool(dirty)

def hash_path(path):
    record["fixture_hashes"][path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()

for location in ("reference/common", "reference/fixtures", "reference/a", "contracts/src/math", "contracts/src/risk", "contracts/src/vaults", "contracts/src/settlement", "contracts/test/harness/A", "contracts/test/mocks/A", "contracts/test/risk/A", "contracts/test/invariant/A", "packages/risk-sdk"):
    directory = root / location
    if directory.exists():
        for path in sorted(directory.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                hash_path(path)
for location in ("contracts/foundry.toml", "scripts/check-task.sh", ".gitmodules"):
    if (root / location).is_file():
        hash_path(root / location)

try:
    if number <= 9:
        directory = root / "reference" / "tests" / lane.lower()
        pattern = f"test_{task.lower()}.py"
        suite_path = directory / pattern
        if not suite_path.is_file():
            raise ValueError(f"missing suite: {suite_path.relative_to(root).as_posix()}")
        hash_path(suite_path)
        command = [sys.executable, "-m", "unittest", "discover", "-s",
                   directory.relative_to(root).as_posix(), "-p", pattern]
        suite = unittest.TestLoader().discover(str(directory), pattern=pattern)
        if suite.countTestCases() == 0:
            raise ValueError(f"empty suite: {pattern}")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
        log = output.getvalue()
        print(log, end="")
        record["test_count"] = result.testsRun
        record["skipped_count"] = len(result.skipped)
        # A skipped, expected-failing or unexpectedly succeeding check is not acceptance.
        passed = result.wasSuccessful() and not result.skipped and not result.expectedFailures
        record["exit_code"] = 0 if passed else 1
        record["commands"].append({"argv": command, "cwd": ".", "exit_code": record["exit_code"],
                                   "execution": "in_process_unittest_discovery", "output": log})
    elif lane == "B" and number >= 40:
        # Integration fix: A002's runner had no B W7 configuration. Each B W7 task runs its own
        # suites plus the combined (real A + real B) suites that carry its evidence.
        def step(argv, cwd=".", env_extra=None):
            if os.name == "nt" and argv[0] == "tsc":
                import shutil
                shim = shutil.which("tsc")
                if not shim:
                    raise ValueError("TypeScript compiler not installed")
                argv = ["node", str(Path(shim).parent / "node_modules/typescript/bin/tsc"), *argv[1:]]
            env = {**os.environ, **(env_extra or {})}
            run = subprocess.run(argv, cwd=root / cwd, env=env, capture_output=True, text=True)
            print(run.stdout[-2000:], end=""); print(run.stderr[-2000:], end="", file=sys.stderr)
            record["commands"].append({"argv": argv, "cwd": cwd, "exit_code": run.returncode,
                                       "execution": "subprocess", "output": (run.stdout + run.stderr)[-4000:]})
            record["test_count"] += 1
            return run.returncode
        def forge(path):
            return step(["forge", "test", "--match-path", path], "contracts", {"FOUNDRY_PROFILE": "risk"})
        def need_json(path, forbid_live_pass=False):
            data = json.loads((root / path).read_text())
            if forbid_live_pass and any(c.get("live_status") == "PASS" for c in data.get("counterparts", [])):
                raise ValueError(path + ": a live counterpart PASS needs a real counterpart run")
            hash_path(root / path)
        codes = []
        if task == "B040":
            codes += [forge("test/integration/B/FullLifecycle.t.sol"), forge("test/integration/EndToEnd.t.sol")]
            need_json("artifacts/risk/counterpart-status.json", forbid_live_pass=True)
        elif task == "B041":
            codes += [forge("test/gas/B/AdapterGas.t.sol"), forge("test/gas/integration/EngineGas.t.sol")]
            need_json("artifacts/risk/gas-adapters.json"); need_json("artifacts/risk/gas-engine.json")
        elif task == "B042":
            out = "tmp/risk-sdk-b"
            codes.append(step(["tsc", "--noEmit", "--strict", "--target", "es2020", "--module", "commonjs",
                               "--moduleResolution", "node", "packages/risk-sdk/src/index.ts"]))
            codes.append(step(["tsc", "--noCheck", "--esModuleInterop", "--target", "es2020", "--module", "commonjs", "--outDir", out,
                               "packages/risk-sdk/src/index.ts", "packages/risk-sdk/test/read-model.test.ts"]))
            codes.append(step(["node", "--test", out + "/test/read-model.test.js"]))
            need_json("docs/app-state-fixtures.json")
        elif task == "B043":
            text = (root / "artifacts/reviews/B-on-A.md").read_text()
            if "Review status: COMPLETE" not in text:
                raise ValueError("B043: review is not complete")
            hash_path(root / "artifacts/reviews/B-on-A.md")
            codes.append(forge("test/reviews/B043Review.t.sol"))
        elif task == "B044":
            need_json("artifacts/risk/integration-release.json"); need_json("artifacts/risk/release-manifest.json")
            if not (root / "docs/runbooks/lifecycle.md").is_file():
                raise ValueError("missing docs/runbooks/lifecycle.md")
            codes.append(forge("test/integration/ReleaseDefaults.t.sol"))
        record["exit_code"] = 0 if all(c == 0 for c in codes) else 1
        record["components"].update(peer_lane="real", external_counterparts="mocked; live status in artifacts/risk/counterpart-status.json")
    elif lane == "A" and number >= 43:
        command = [sys.executable, "scripts/check-a-handoff.py", task]
        run = subprocess.run(command, cwd=root, capture_output=True, text=True)
        print(run.stdout, end=""); print(run.stderr, end="", file=sys.stderr)
        record["commands"].append({"argv": command, "cwd": ".", "exit_code": run.returncode,
                                   "execution": "subprocess", "output": run.stdout + run.stderr})
        record["exit_code"] = run.returncode
        report = json.loads(run.stdout)
        record["test_count"] = report["checks_run"]
        if report["status"] in ("pending_peer_merge", "pending_peer_review"):
            record["status"] = "blocked"
            record["reason"] = report["reason"]
    else:
        family = "math" if number <= 15 else "risk"
        campaigns = {"A040": "test/invariant/A/AccountingInvariants.t.sol",
                     "A041": "test/gas/A/AccountingGas.t.sol", "A042": "test/integration/A/CustodyExit.t.sol"}
        if number >= 40 and task not in campaigns:
            raise ValueError(f"{task}: campaign/review acceptance is not configured yet")
        relative = campaigns.get(task, f"test/{family}/{lane}/{task}.t.sol")
        suite_path = root / "contracts" / relative
        if not suite_path.is_file():
            raise ValueError(f"missing suite: contracts/{relative}")
        hash_path(suite_path)
        if task == "A040":
            reference_command = [sys.executable, "-m", "reference.a.integrated_traces"]
            reference_run = subprocess.run(reference_command,cwd=root,capture_output=True,text=True)
            record["commands"].append({"argv":reference_command,"cwd":".","exit_code":reference_run.returncode,
                "execution":"subprocess","output":reference_run.stdout+reference_run.stderr})
            if reference_run.returncode: raise ValueError("independent integrated reference failed")
        command = ["forge", "test", "--match-path", relative, "--json"]
        if task == "A041": command.append("-vv")
        env = {**os.environ, "FOUNDRY_PROFILE": "risk"}
        run = subprocess.run(command, cwd=root / "contracts", env=env, capture_output=True, text=True)
        print(run.stderr, end="", file=sys.stderr)
        record["exit_code"] = run.returncode
        try:
            payload = json.loads(run.stdout)
        except ValueError:
            if run.returncode == 0:
                raise ValueError("forge returned no machine-readable test results")
            payload = {}
        # Retain status, counterexamples, gas, decoded measurements and invariant
        # metrics without repeating thousands of raw EVM event topics in Git.
        for suite in payload.values():
            if isinstance(suite, dict):
                for test in suite.get("test_results", {}).values():
                    for key in ("logs", "traces", "labeled_addresses", "breakpoints"):
                        test.pop(key, None)
        output = json.dumps(payload) if payload else run.stdout
        print(output)
        record["commands"].append({"argv": command, "cwd": "contracts", "exit_code": run.returncode,
                                   "execution": "subprocess", "output": output + run.stderr,
                                   "raw_evm_logs_omitted": True})
        results = [test for suite in payload.values() if isinstance(suite, dict)
                   for test in suite.get("test_results", {}).values()]
        record["test_count"] = len(results)
        record["skipped_count"] = sum(test.get("status") == "Skipped" for test in results)
        if run.returncode == 0 and (not results or any(test.get("status") != "Success" for test in results)):
            raise ValueError("forge returned no successful complete suite; missing/skipped tests fail")
        if task == "A032" and run.returncode == 0:
            sdk_commands = [
                ["tsc", "--target", "es2020", "--module", "commonjs", "--strict", "--outDir", "tmp/risk-sdk", "packages/risk-sdk/src/accounting.ts", "packages/risk-sdk/test/accounting.test.ts"],
                ["node", "tmp/risk-sdk/test/accounting.test.js"]]
            # Windows npm installs the CLI as a .cmd shim; invoke its JS entry
            # through Node instead of passing user/source strings to a shell.
            if os.name == "nt":
                import shutil
                shim = shutil.which("tsc")
                if not shim: raise ValueError("TypeScript compiler not installed")
                sdk_commands[0] = ["node", str(Path(shim).parent / "node_modules/typescript/bin/tsc"), *sdk_commands[0][1:]]
            for sdk_command in sdk_commands:
                sdk_run = subprocess.run(sdk_command, cwd=root, capture_output=True, text=True)
                record["commands"].append({"argv":sdk_command,"cwd":".","exit_code":sdk_run.returncode,
                    "execution":"subprocess","output":sdk_run.stdout+sdk_run.stderr})
                if sdk_run.returncode: raise ValueError("SDK accounting reader check failed: "+sdk_run.stdout+sdk_run.stderr)
            record["test_count"] += 1
        if task == "A041" and run.returncode == 0:
            measurements = {}
            for test in results:
                for line in test.get("decoded_logs", []):
                    found = re.fullmatch(r"([a-z0-9_]+): ([0-9]+)", line.strip())
                    if found: measurements[found[1]] = int(found[2])
            if measurements.get("participant_count") != 1024:
                raise ValueError("missing full-bound gas measurements")
            bytecode = json.loads((root / "contracts/out/AccountingHarness.sol/AccountingHarness.json").read_text())["deployedBytecode"]["object"]
            gas = {"status":"measured_locally", "measurements":measurements,
                   "gas_model":"Foundry local Prague EVM; test-call gas, excludes transaction base; not a Monad/testnet gas certificate",
                   "harness_runtime_bytes":(len(bytecode.removeprefix("0x"))//2),
                   "harness_code_size_limit":tomllib.loads((root / "contracts/foundry.toml").read_text(encoding="utf-8"))["profile"]["risk"]["code_size_limit"], "production_composition_size":"real counterpart composition and chain deployment measurement pending",
                   "source_commit":record["source_commit"], "toolchain":record["toolchain"]}
            path=root / "artifacts/risk/gas-accounting.json"; path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps(gas,indent=2)+"\n")
        if task == "A042" and run.returncode == 0:
            path=root / "artifacts/risk/custody-reconciliation.json";path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps({"status":"A_local_pass", "tests":record["test_count"],
                "peer_decisions":"scripted_mock", "token":"deterministic MockUSDC with failure/tax/reentry tests",
                "real_counterpart_integration":"pending_merge", "source_commit":record["source_commit"]},indent=2)+"\n")
    if record["status"] != "blocked":
        record["status"] = "passed" if record["exit_code"] == 0 else "failed"
    if lane == "A" and 16 <= number <= 42:
        record["components"]["peer_lane"] = "scripted_mock"
except (OSError, ValueError, ImportError) as error:
    record["reason"] = str(error)
    record["exit_code"] = 2
    print(str(error), file=sys.stderr)

destination = root / record["artifacts"][0]
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
if number >= 40:
    acceptance=root / f"artifacts/acceptance/{task}.json";acceptance.parent.mkdir(parents=True,exist_ok=True)
    acceptance.write_text(json.dumps(record,indent=2)+"\n",encoding="utf-8")
print(f"{task}: {record['status']}; {record['test_count']} tests; {record['artifacts'][0]}")
sys.exit(record["exit_code"])
PY
