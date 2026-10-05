"""Reproducible, loopback-only real-contract integration with disposable fixture dependencies."""
import argparse
from contextlib import contextmanager
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
ORACLE = ROOT / "oracle"
PRICEFEED = ROOT / "packages" / "pricefeed"
LATEST = ROOT / "tmp" / "local-integration-latest.json"
LEVERAGE_LATEST = ROOT / "tmp" / "local-leverage-latest.json"
DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
HIDDEN = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise RuntimeError("Local RPC redirects are forbidden")


def executable(variable, pinned, fallback):
    value = os.environ.get(variable) or (str(pinned) if pinned.exists() else shutil.which(fallback))
    if not value:
        raise RuntimeError(f"Install {fallback} or set {variable}")
    return str(Path(value).resolve())


def local_environment(rpc):
    environment = dict(os.environ)
    for name in list(environment):
        if re.search(r"PRIVATE_KEY|API_KEY|API_TOKEN|RPC_URL|MONAD_.*RPC|FOUNDRY_PROFILE|FORGE_SNAPSHOT", name, re.I):
            environment.pop(name, None)
    environment.update(ETH_RPC_URL=rpc, RPC_URL=rpc, FOUNDRY_ETH_RPC_URL=rpc,
                       FOUNDRY_PROFILE="integration", FORGE_SNAPSHOT_EMIT="false")
    return environment


def forge_environment(environment, rpc):
    isolated = dict(environment)
    isolated.update(ETH_RPC_URL=rpc, RPC_URL=rpc, FOUNDRY_ETH_RPC_URL=rpc)
    return isolated


def rpc_call(rpc, method, params=None):
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", rpc):
        raise RuntimeError("Loopback RPC only")
    request = urllib.request.Request(rpc, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode(),
                                    headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=10) as response:
        payload = json.load(response)
    if "error" in payload:
        raise RuntimeError(f"Local RPC {method}: {payload['error']}")
    return payload["result"]


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


@contextmanager
def sampling_lock(directory):
    """Coordinate only disposable fixture publication/sampling with the two-order trade."""
    path = Path(directory) / "sampling.lock"
    identity = json.dumps({"pid": os.getpid(), "nonce": uuid4().hex})
    deadline = time.monotonic() + 30
    while True:
        try:
            with path.open("x", encoding="utf-8") as handle:
                handle.write(identity)
            break
        except (FileExistsError, PermissionError):
            if time.monotonic() >= deadline:
                raise RuntimeError("LOCAL_SAMPLING_LOCK_TIMEOUT")
            time.sleep(0.05)
    try:
        yield
    finally:
        if path.read_text(encoding="utf-8") != identity:
            raise RuntimeError("LOCAL_SAMPLING_LOCK_OWNER_CHANGED")
        path.unlink()


def wait_for_recent_sample(rpc, report):
    """Leave time inside the unchanged 30-second carry for the local two-order trade."""
    for _attempt in range(45):
        try:
            sample = json.loads(Path(report).read_text(encoding="utf-8")).get("latestValidSample")
        except (OSError, json.JSONDecodeError):
            sample = None
        at = int(rpc_call(rpc, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
        if sample and 0 <= at - int(sample["observation"]["t"]) <= 12:
            return sample
        time.sleep(1)
    raise RuntimeError("No recent confirmed sample before coordinated trade")


def warp_to(rpc, timestamp):
    rpc_call(rpc, "evm_setNextBlockTimestamp", [timestamp])
    rpc_call(rpc, "evm_mine")
    observed = int(rpc_call(rpc, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
    if observed < timestamp:
        raise RuntimeError("Local clock did not reach the requested fixture timestamp")
    return observed


def process_identity(pid):
    if os.name == "nt":
        command = f"$p=Get-Process -Id {int(pid)} -ErrorAction SilentlyContinue; if($p){{$p.StartTime.ToUniversalTime().Ticks}}"
        result = subprocess.run(["powershell", "-NoProfile", "-Command", command], text=True, capture_output=True, creationflags=HIDDEN)
        return result.stdout.strip() or None
    path = Path(f"/proc/{pid}/stat")
    if path.exists():
        return path.read_text().rsplit(") ", 1)[1].split()[19]
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, capture_output=True)
    return result.stdout.strip() or None


def stop_recorded(record):
    for item in reversed(record.get("processes", [])):
        if item.get("identity") and process_identity(item["pid"]) == item["identity"]:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(item["pid"]), "/T", "/F"], capture_output=True, creationflags=HIDDEN)
            else:
                import signal
                os.kill(item["pid"], signal.SIGTERM)


def require_free_port(port):
    with socket.socket() as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError as error:
            raise RuntimeError(f"Port {port} is occupied; do not reset another developer's chain") from error


def run(args):
    leveraged = getattr(args, "scenario", "fully-backed") == "leveraged"
    latest = LEVERAGE_LATEST if leveraged else LATEST
    if not 1024 <= args.rpc_port < 65535 or not 1024 <= args.read_port <= 65535 or args.read_port in {args.rpc_port, args.rpc_port + 1}:
        raise RuntimeError("Use distinct nonprivileged RPC/read ports and reserve RPC port + 1 for Forge")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    prefix = "local-leverage" if leveraged else "local-integration"
    directory = (ROOT / "tmp" / f"{prefix}-{stamp}").resolve() if not args.directory else Path(args.directory).resolve()
    if not directory.is_relative_to(ROOT / "tmp"):
        raise RuntimeError("Run directory must be within this repository's ignored tmp directory")
    if directory.exists() and any(directory.iterdir()):
        raise RuntimeError("Use a new empty run directory; never reset a publisher's existing journals")
    require_free_port(args.rpc_port)
    require_free_port(args.rpc_port + 1)
    if args.keep_running:
        require_free_port(args.read_port)
    directory.mkdir(parents=True, exist_ok=True)
    rpc = f"http://127.0.0.1:{args.rpc_port}"
    forge_rpc = f"http://127.0.0.1:{args.rpc_port + 1}"
    extension = ".exe" if os.name == "nt" else ""
    forge = executable("LOCAL_FORGE", ROOT / "tmp" / "foundry-v1.8.3" / f"forge{extension}", "forge")
    anvil = executable("LOCAL_ANVIL", ROOT / "tmp" / "foundry-v1.8.3" / f"anvil{extension}", "anvil")
    bun = executable("LOCAL_BUN", Path("__not_a_tool__"), "bun")
    node = Path(executable("LOCAL_NODE", PRICEFEED / "node_modules" / "node" / "bin" / f"node{extension}", "node"))
    environment = local_environment(rpc)
    processes = []
    handles = []
    results = []
    record = {"scope": "local-only", "scenario": "leveraged" if leveraged else "fully-backed", "rpcUrl": rpc,
              "directory": str(directory), "processes": processes, "status": "starting"}
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    record["sourceCommit"] = source
    source_status = subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True)
    record["workingTree"] = "dirty; see source-status.txt" if source_status.strip() else "clean"
    (directory / "source-status.txt").write_text(source_status, encoding="utf-8")

    def command(name, argv, cwd=ROOT, timeout=600, health=()):
        print(f"[{name}]", flush=True)
        command_environment = forge_environment(environment, forge_rpc) if str(argv[0]) == forge else environment
        if str(argv[0]) == bun:
            argv = [bun, "--no-env-file", *argv[1:]]
        log = directory / f"{name}.log"
        with log.open("w", encoding="utf-8") as output:
            process = subprocess.Popen([str(value) for value in argv], cwd=cwd, env=command_environment, stdout=output, stderr=subprocess.STDOUT,
                                       creationflags=HIDDEN, stdin=subprocess.DEVNULL)
            deadline = time.monotonic() + timeout
            try:
                while process.poll() is None:
                    if any(service.poll() is not None for service in health):
                        raise RuntimeError(f"{name}: a required background service exited; inspect sampler/upkeep logs")
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f"{name}: exceeded {timeout} seconds")
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
        results.append({"step": name, "exitCode": process.returncode, "log": str(log.relative_to(ROOT))})
        write_json(directory / "steps.json", results)
        if process.returncode:
            raise RuntimeError(f"{name} failed; inspect {log}")

    def background(name, argv, cwd=ROOT):
        if str(argv[0]) == bun:
            argv = [bun, "--no-env-file", *argv[1:]]
        handle = (directory / f"{name}.log").open("w", encoding="utf-8")
        handles.append(handle)
        process = subprocess.Popen([str(value) for value in argv], cwd=cwd, env=environment, stdout=handle, stderr=subprocess.STDOUT,
                                   creationflags=HIDDEN, stdin=subprocess.DEVNULL)
        identity = process_identity(process.pid)
        processes.append({"name": name, "pid": process.pid, "identity": identity})
        write_json(directory / "runtime.json", record)
        write_json(latest, record)
        return process

    try:
        for name, path in [("forge", forge), ("anvil", anvil)]:
            version = subprocess.check_output([path, "--version"], text=True)
            if not re.search(r"Version: 1\.8\.3(?:\s|$)", version):
                raise RuntimeError(f"{name} must be pinned to 1.8.3")
        if subprocess.check_output([str(node), "--version"], text=True).strip() != "v24.21.0":
            raise RuntimeError("Pricefeed requires Node 24.21.0; run npm ci in packages/pricefeed")
        if subprocess.check_output([bun, "--version"], text=True).strip() != "1.3.13":
            raise RuntimeError("Oracle requires Bun 1.3.13")
        node_process = background("anvil", [anvil, "--network", "monad", "--hardfork", "monad:MonadTen", "--chain-id", "31337",
                    "--host", "127.0.0.1", "--port", str(args.rpc_port), "--gas-limit", "30000000", "--code-size-limit", "131072",
                    "--block-time", "1", "--slots-in-an-epoch", "2", "--silent", "--accounts", "20" if leveraged else "10"])
        for _attempt in range(100):
            if node_process.poll() is not None:
                raise RuntimeError("Anvil exited during startup")
            try:
                if int(rpc_call(rpc, "eth_chainId"), 16) == 31337:
                    break
            except (OSError, RuntimeError):
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("Anvil did not become ready")
        rpc_call(rpc, "anvil_setBlockTimestampInterval", [1])
        record["localClock"] = {"blockIntervalSeconds": 1, "timestampIncrementSeconds": 1, "finalizedLagBlocks": 4,
                                "publicLatencyBenchmark": False}
        proxy = background("forge-rpc", [sys.executable, ROOT / "scripts" / "integration" / "forge-local-rpc.py",
                           "--upstream", rpc, "--port", str(args.rpc_port + 1)])
        for _attempt in range(40):
            if proxy.poll() is not None:
                raise RuntimeError("Local Forge RPC adapter exited")
            try:
                if int(rpc_call(forge_rpc, "eth_chainId"), 16) == 31337:
                    break
            except (OSError, RuntimeError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("Local Forge RPC adapter did not become ready")
        command("forge-rpc-config", [forge, "config", "--rpc-url", forge_rpc, "--json"], ORACLE)
        configured = json.loads((directory / "forge-rpc-config.log").read_text(encoding="utf-8"))
        if configured["eth_rpc_url"] != forge_rpc:
            raise RuntimeError("Forge configuration bypasses the local diagnostic adapter")
        scheduled = int(rpc_call(rpc, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16) + (29 if leveraged else 2) * 86400
        fixture = directory / "fixture.json"
        driver = PRICEFEED / "dist" / "scripts" / "local-factory-integration.js"
        command("fixture", [node, driver, "--mode", "prepare", "--scheduled-t", scheduled, "--output", fixture], PRICEFEED)
        configuration = json.loads(fixture.read_text(encoding="utf-8"))
        raw_manifest = ORACLE / "deployments" / "local-integration.json"

        def script(name, signature, values):
            command(name, [forge, "script", "script/integration/LocalIntegration.s.sol:LocalIntegration", "--sig", signature, *values,
                          "--rpc-url", forge_rpc, "--unlocked", "--sender", DEPLOYER, "--broadcast", "--slow", "--network", "monad",
                          "--hardfork", "monad:MonadTen", "--gas-estimate-multiplier", "100", "--skip", "UmaImports", "--skip", "test/uma", "--offline"], ORACLE)
            broadcast = ORACLE / "broadcast" / "LocalIntegration.s.sol" / "31337" / f"{signature.split('(')[0]}-latest.json"
            if broadcast.exists():
                shutil.copyfile(broadcast, directory / f"{name}-receipts.json")
            else:
                raise RuntimeError(f"Missing {name} broadcast receipt file")

        deploy_signature = "runLeveraged(bytes32,bytes32,uint64)" if leveraged else "run(bytes32,bytes32,uint64)"
        script("deploy", deploy_signature, [configuration["markets"]["demo"]["sourceRulesHash"], configuration["markets"]["terminal"]["sourceRulesHash"], str(scheduled)])
        shutil.copyfile(raw_manifest, directory / "contracts.json")
        raw_manifest = directory / "contracts.json"
        deployed = json.loads(raw_manifest.read_text(encoding="utf-8"))
        manifest = directory / "manifest.json"
        command("enroll", [bun, "services/local-integration/src/enroll.ts", raw_manifest, rpc, manifest, source], ORACLE)
        shutil.copyfile(raw_manifest, directory / "contracts-simulation.json")
        enrolled = json.loads(manifest.read_text(encoding="utf-8"))
        for market in enrolled["markets"]:
            deployed["markets"][market["name"]]["listingHash"] = market["listingHash"]
            deployed["markets"][market["name"]]["codehash"] = market["codehash"]
        deployed["manifestOrigin"] = "mined-chain-verified; simulation candidate retained separately"
        write_json(raw_manifest, deployed)

        def publisher(mode, name):
            command(name, [node, driver, "--mode", mode, "--rpc", rpc, "--manifest", raw_manifest, "--fixture", fixture,
                          "--abi", ORACLE / "out" / "RegistryBookRiskEngine.sol" / "RegistryBookRiskEngine.json",
                          "--directory", directory / "pricefeed", "--output", directory / f"{name}.json"], PRICEFEED,
                    timeout=7200 if mode == "mature" else 600, health=(sampler, upkeep) if mode == "mature" else ())

        publisher("verify", "pricefeed-verify")
        publisher_args = [node, driver, "--mode", "watch", "--rpc", rpc, "--manifest", raw_manifest, "--fixture", fixture,
                          "--abi", ORACLE / "out" / "RegistryBookRiskEngine.sol" / "RegistryBookRiskEngine.json", "--directory", directory / "pricefeed"]
        upkeep_args = [bun, "services/local-integration/src/upkeep.ts", manifest, directory / "upkeep-journal.json", directory / "upkeep-report.json"]
        trading_publisher = background("fixture-publisher-trading", [*publisher_args, "--output", directory / "publisher-trading.json"], PRICEFEED)
        time.sleep(2)
        for market in ["demo", "terminal"]:
            if trading_publisher.poll() is not None:
                raise RuntimeError("Fixture publisher exited before trading")
            command(f"upkeep-before-{market}", [*upkeep_args, "--once"], ORACLE)
            script(f"trade-{market}", "trade(address)", [deployed["markets"][market]["engine"]])
        upkeep = background("epoch-upkeep", upkeep_args, ORACLE)
        sampler = background("book-sampler", [bun, "services/local-integration/src/sampler.ts", manifest, directory / "sampler-journal.json", directory / "sampler-report.json"], ORACLE)
        command("snapshot-traded", [bun, "services/local-integration/src/main.ts", manifest, "snapshot", directory / "snapshot-traded.json"], ORACLE)
        for _attempt in range(60):
            if upkeep.poll() is not None:
                raise RuntimeError("Epoch upkeep exited during initialization")
            upkeep_report = json.loads((directory / "upkeep-report.json").read_text(encoding="utf-8"))
            if all(upkeep_report["markets"][market]["initialized"] for market in ["demo", "terminal"]):
                break
            time.sleep(1)
        else:
            raise RuntimeError("Epoch upkeep did not discover the fixture owners' existing quotes")
        initial_epochs = {market: int(upkeep_report["markets"][market]["marketOrderEpoch"]) for market in ["demo", "terminal"]}
        stop_marker = directory / "pricefeed" / "stop-watcher"
        stop_marker.write_text("orchestrator requests a graceful journal close\n", encoding="utf-8")
        if trading_publisher.wait(timeout=30) != 0:
            raise RuntimeError("Trading publisher did not close cleanly")
        stop_marker.unlink()
        timestamp = int(rpc_call(rpc, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
        warp_to(rpc, (timestamp // 3600 + 1) * 3600 + 1)
        publisher("warmup", "refresh-rollover")
        trading_publisher = background("fixture-publisher-after-rollover", [*publisher_args, "--output", directory / "publisher-trading.json"], PRICEFEED)
        for _attempt in range(180):
            if upkeep.poll() is not None or trading_publisher.poll() is not None:
                raise RuntimeError("Epoch maintenance or publisher exited during rollover")
            upkeep_report = json.loads((directory / "upkeep-report.json").read_text(encoding="utf-8"))
            ready = not upkeep_report["pending"]
            for market in ["demo", "terminal"]:
                memory = upkeep_report["markets"][market]
                state = upkeep_report["states"].get(market, {})
                ready = ready and int(memory["marketOrderEpoch"]) > initial_epochs[market] and "quoteEpoch" not in memory and state.get("work") == 0
            if ready:
                write_json(directory / "rollover-check.json", {"passed": True, "initialEpochs": initial_epochs,
                           "markets": upkeep_report["markets"], "states": upkeep_report["states"], "receipts": upkeep_report["receipts"]})
                break
            time.sleep(1)
        else:
            raise RuntimeError("Bounded hourly rollover and owner re-quoting did not finish")
        terminal = deployed["markets"]["terminal"]["engine"]
        script("begin-settlement", "beginSettlement(address)", [terminal])
        stop_marker.write_text("orchestrator requests a graceful journal close\n", encoding="utf-8")
        if trading_publisher.wait(timeout=30) != 0:
            raise RuntimeError("Trading publisher did not close cleanly")
        stop_marker.unlink()
        timestamp = int(rpc_call(rpc, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
        observed = warp_to(rpc, timestamp + 301)
        write_json(directory / "liveness-warp.json", {"before": timestamp, "requested": timestamp + 301, "observed": observed})
        script("resolve-assertion", "resolveAssertion(address)", [terminal])
        command("keeper", [bun, "services/keeper/src/local-integration.ts", raw_manifest, directory / "keeper-gas.json", directory / "keeper-report.json"], ORACLE)
        script("claim", "claim(address)", [terminal])
        if leveraged:
            script("fund-leveraged", "fundLeveraged(address)", [deployed["markets"]["demo"]["engine"]])
        publisher("warmup", "refresh-final")
        if leveraged:
            publisher("mature", "leverage-readiness")
        watcher = background("fixture-publisher", [node, driver, "--mode", "watch", "--rpc", rpc, "--manifest", raw_manifest, "--fixture", fixture,
                        "--abi", ORACLE / "out" / "RegistryBookRiskEngine.sol" / "RegistryBookRiskEngine.json", "--directory", directory / "pricefeed",
                        "--output", directory / "publisher-live.json"], PRICEFEED)
        steady_services = [watcher, upkeep, sampler]
        if leveraged:
            wait_for_recent_sample(rpc, directory / "sampler-report.json")
            with sampling_lock(directory):
                script("trade-leveraged", "tradeLeveraged(address)", [deployed["markets"]["demo"]["engine"]])
            liquidation_args = [bun, "services/local-integration/src/liquidator.ts", manifest,
                                directory / "liquidator-journal.json", directory / "liquidator-report.json"]
            command("liquidator-check", [*liquidation_args, "--once"], ORACLE)
            steady_services.append(background("liquidator", liquidation_args, ORACLE))
        command("snapshot-final", [bun, "services/local-integration/src/main.ts", manifest, "snapshot", directory / "snapshot-final.json"], ORACLE)
        command("events", [bun, "services/local-integration/src/main.ts", manifest, "events", directory / "events.json"], ORACLE)
        command("receipt-audit", [sys.executable, ROOT / "scripts" / "integration" / "audit-local-run.py", directory])
        snapshot = json.loads((directory / "snapshot-final.json").read_text(encoding="utf-8"))
        states = {market["name"]: market for market in snapshot["markets"]}
        if states["demo"]["halt"]["halted"] or not states["terminal"]["settlement"]["claimsEnabled"]:
            raise RuntimeError("Final demo/terminal lifecycle mismatch")
        if int(snapshot["custodyAtoms"]) < int(snapshot["recognizedAtoms"]):
            raise RuntimeError("Local custody deficit")
        record.update(status="validating-services", manifest=str(manifest), readUrl=f"http://127.0.0.1:{args.read_port}",
                      fixtures=["mintable collateral", "synthetic localhost source", "scripted evidence and mock assertion venue", "local zero-delay governance"],
                      productionReady=False, credentialsUsed="disposable local fixtures only")
        for _attempt in range(90):
            if any(service.poll() is not None for service in steady_services):
                raise RuntimeError("A required local service exited")
            sampler_report = directory / "sampler-report.json"
            try:
                sampled = json.loads(sampler_report.read_text(encoding="utf-8"))
                if sampled["counters"]["validPerpObservations"] > 0 and int(sampled["latestValidSample"]["blockNumber"]) >= int(snapshot["block"]["number"]):
                    record["validBookSample"] = sampled["latestValidSample"]
                    break
            except (OSError, json.JSONDecodeError):
                pass
            time.sleep(2)
        else:
            raise RuntimeError("No valid real-book PERP observation after final warmup; do not claim a working sampler")
        if args.keep_running:
            environment["LOCAL_READ_PORT"] = str(args.read_port)
            api = background("read-api", [bun, "services/local-integration/src/main.ts", manifest, "serve"], ORACLE)
            for _attempt in range(60):
                if api.poll() is not None or any(service.poll() is not None for service in steady_services):
                    raise RuntimeError("A background service exited during startup")
                try:
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                    with opener.open(record["readUrl"] + "/health", timeout=2) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("Read API did not become healthy")
            record["status"] = "passed"
        else:
            stop_recorded(record)
            record["status"] = "passed-and-stopped"
        write_json(directory / "runtime.json", record)
        write_json(latest, record)
        print(json.dumps(record, indent=2))
    except BaseException:
        if not args.keep_failed:
            stop_recorded(record)
        record["status"] = "failed-debug-running" if args.keep_failed else "failed-and-stopped"
        write_json(directory / "runtime.json", record)
        write_json(latest, record)
        raise
    finally:
        for handle in handles:
            handle.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "status", "stop"])
    parser.add_argument("--directory")
    parser.add_argument("--scenario", choices=["fully-backed", "leveraged"], default="fully-backed")
    parser.add_argument("--rpc-port", type=int, default=18546)
    parser.add_argument("--read-port", type=int, default=8787)
    parser.add_argument("--keep-running", action="store_true")
    parser.add_argument("--keep-failed", action="store_true", help="Keep an owned loopback chain for debugging a failed run")
    args = parser.parse_args()
    if args.action == "run":
        run(args)
    else:
        latest = LEVERAGE_LATEST if args.scenario == "leveraged" else LATEST
        path = Path(args.directory) / "runtime.json" if args.directory else latest
        record = json.loads(path.read_text(encoding="utf-8"))
        if args.action == "stop":
            stop_recorded(record)
            record["status"] = "stopped"
            write_json(Path(record["directory"]) / "runtime.json", record)
            write_json(LEVERAGE_LATEST if record.get("scenario") == "leveraged" else LATEST, record)
        print(json.dumps(record, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"LOCAL INTEGRATION FAILED: {error}", file=sys.stderr)
        sys.exit(1)
