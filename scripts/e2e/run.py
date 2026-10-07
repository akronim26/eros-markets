#!/usr/bin/env python3
"""Local complete-flow evidence, with a separate public/human validation boundary."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof-directory", type=Path, help="Reuse a passed, source-matching contract proof")
    parser.add_argument("--ui-directory", type=Path, help="Use a fresh, passed, running fully-backed local stack")
    parser.add_argument("--rpc-port", type=int, default=18566)
    parser.add_argument("--read-port", type=int, default=8798)
    parser.add_argument("--web-port", type=int, default=3111)
    parser.add_argument("--keep-ui", action="store_true", help="Preserve owned UI services after failure for diagnosis")
    args = parser.parse_args()
    directory = ROOT / "tmp" / ("e2e-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S"))
    directory.mkdir(parents=True)
    report = {"scope": "local-fixture", "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "status": "running", "stages": [], "publicGates": {
                  "privyEmbeddedWallet": "human-required", "externalWallet": "human-required",
                  "hostedServices": "not-tested", "matchingIndexer": "not-tested",
                  "realSourceSettlement": "requires-resolved-event", "delegatedPolicies": "not-tested"}}
    print(f"E2E evidence: {directory}", flush=True)
    env = dict(os.environ)
    # Never forward deployment credentials to the test/browser process.
    for key in list(env):
        if any(part in key.upper() for part in ("PRIVATE_KEY", "API_KEY", "API_TOKEN", "RPC_URL", "PRIVY_SECRET")):
            env.pop(key)
    env.update(RAYON_NUM_THREADS=env.get("RAYON_NUM_THREADS", "4"))
    ui = None
    server = None
    server_log = None

    def save():
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        (ROOT / "tmp/e2e-latest.json").write_text(json.dumps({"directory": str(directory), "status": report["status"]}, indent=2) + "\n")

    def browser_sources():
        patterns = ("frontend/src/**/*.ts", "frontend/src/**/*.tsx", "frontend/src/**/*.json", "frontend/src/**/*.css",
                    "frontend/e2e/**/*.ts", "frontend/e2e/**/*.tsx", "frontend/e2e/**/*.mjs", "frontend/playwright.config.mjs",
                    "frontend/next.config.ts", "frontend/package*.json", "scripts/e2e/*.py")
        files = {p for pattern in patterns for p in ROOT.glob(pattern) if p.is_file()}
        return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}

    def run(name, command, cwd=ROOT, timeout=7200):
        stage = {"name": name, "status": "running", "startedAt": time.time(), "log": f"{name}.log"}
        report["stages"].append(stage); save(); print(f"[{name}]", flush=True)
        with (directory / stage["log"]).open("w") as log:
            process = subprocess.Popen([str(x) for x in command], cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
                if code:
                    raise RuntimeError(f"{name} exited {code}; see {directory / stage['log']}")
                stage["status"] = "passed"
            except BaseException:
                stage["status"] = "failed"
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try: process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL); process.wait()
                raise
            finally:
                stage["seconds"] = round(time.time() - stage["startedAt"], 2); save()

    def checked_run(path, settled):
        path = path.resolve()
        if not path.is_relative_to(ROOT / "tmp"):
            raise RuntimeError("Fixture evidence must live in repository tmp/")
        record = json.loads((path / "runtime.json").read_text())
        if record["status"] not in ("passed", "passed-and-stopped") or record["scope"] != "local-only":
            raise RuntimeError("Local stack did not pass")
        if settled and (not record.get("settleLeveraged") or record["scenario"] != "leveraged"):
            raise RuntimeError("Contract proof must include leveraged settlement")
        # Validate source fingerprints rather than silently reusing stale evidence.
        spec = importlib.util.spec_from_file_location("local_stack", ROOT / "scripts/integration/local-stack.py")
        stack = importlib.util.module_from_spec(spec); spec.loader.exec_module(stack)
        saved = json.loads((path / "source-integrity.json").read_text())
        if not saved["passed"] or saved["files"] != stack.source_fingerprints():
            raise RuntimeError("Backend sources changed since the selected local proof; run a fresh proof")
        return record

    try:
        if not shutil.which("node") or not shutil.which("npm"):
            raise RuntimeError("Node 22+ and npm must be on PATH")
        run("frontend-typecheck", ["npm", "run", "typecheck"], FRONTEND, 180)
        run("frontend-unit", ["npm", "test"], FRONTEND, 180)
        run("frontend-integration", ["npm", "run", "test:integration"], FRONTEND, 180)
        ui = args.ui_directory or directory / "browser-stack"
        if not args.ui_directory:
            run("browser-fixture", [sys.executable, "scripts/integration/local-stack.py", "run", "--scenario", "fully-backed",
                                    "--directory", ui, "--rpc-port", args.rpc_port, "--read-port", args.read_port, "--keep-running"])
        record = checked_run(ui, False)
        if record["status"] != "passed" or record["scenario"] != "fully-backed":
            raise RuntimeError("Browser fixture must be a running fully-backed stack")
        report["browserFixture"] = str(ui.resolve())
        env.update(EROS_E2E_DIRECTORY=str(directory), EROS_E2E_STACK=str(ui.resolve()),
                   EROS_E2E_MANIFEST=str((ui / "public-manifest.json").resolve()), EROS_E2E_RPC_URL=record["rpcUrl"],
                   EROS_E2E_BASE_URL=f"http://127.0.0.1:{args.web_port}")
        report["browserSourceHashes"] = browser_sources(); save()
        run("browser-build", ["npm", "run", "build", "--", "--webpack"], FRONTEND, 600)
        server_log = (directory / "web-server.log").open("w")
        server = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", str(args.web_port)],
                                  cwd=FRONTEND, env=env, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(90):
            if server.poll() is not None: raise RuntimeError("Isolated Next server exited")
            try:
                with urllib.request.urlopen(env["EROS_E2E_BASE_URL"], timeout=2) as response:
                    if response.status == 200: break
            except OSError: time.sleep(1)
        else: raise RuntimeError("Isolated Next server did not become healthy")
        run("browser-lifecycle", ["npx", "--no-install", "playwright", "test"], FRONTEND, 1200)
        if report["browserSourceHashes"] != browser_sources():
            raise RuntimeError("Frontend/framework sources changed while the browser build and test were running")
        run("browser-fixture-stop", [sys.executable, "scripts/integration/local-stack.py", "stop", "--directory", ui], timeout=60)
        proof = args.proof_directory or directory / "contract-proof"
        if not args.proof_directory:
            run("contract-lifecycle", [sys.executable, "scripts/integration/local-stack.py", "run", "--scenario", "leveraged",
                                      "--settle-leveraged", "--directory", proof, "--rpc-port", args.rpc_port, "--read-port", args.read_port])
        checked_run(proof, True)
        report["contractEvidence"] = str(proof)
        report["status"] = "local-passed-public-pending"
    except BaseException as error:
        report["status"] = "failed"; report["error"] = str(error)
        raise
    finally:
        if server and server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
            try: server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL); server.wait()
        if server_log: server_log.close()
        if ui and (ui / "runtime.json").exists() and not (args.keep_ui and report["status"] == "failed"):
            cleanup = subprocess.run([sys.executable, "scripts/integration/local-stack.py", "stop", "--directory", str(ui)], cwd=ROOT, env=env,
                                     capture_output=True, text=True, timeout=60)
            (directory / "cleanup.log").write_text(cleanup.stdout + cleanup.stderr)
            report["cleanup"] = "passed" if cleanup.returncode == 0 else "failed"
            if cleanup.returncode: report["status"] = "failed-cleanup"
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat(); save()
        print(json.dumps({"status": report["status"], "report": str(directory / "report.json")}), flush=True)
        if report.get("cleanup") == "failed":
            raise RuntimeError("E2E cleanup failed; inspect cleanup.log and runtime.json")


if __name__ == "__main__":
    main()
