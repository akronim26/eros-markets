"""Reproducible, loopback-only real-contract integration with disposable fixture dependencies."""
import argparse
from contextlib import contextmanager
import datetime
import hashlib
import importlib.util
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
LIVE_LATEST = ROOT / "tmp" / "local-live-leverage-latest.json"
DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
HIDDEN = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
_OWNED_SPEC = importlib.util.spec_from_file_location("eros_integration_owned_process", Path(__file__).with_name("owned_process.py"))
_OWNED_MODULE = importlib.util.module_from_spec(_OWNED_SPEC)
sys.modules[_OWNED_SPEC.name] = _OWNED_MODULE
_OWNED_SPEC.loader.exec_module(_OWNED_MODULE)
OwnedProcess = _OWNED_MODULE.OwnedProcess

# Source and executable JavaScript used by this runner. Ignore docs, generated
# evidence and private environment files; none of their contents belongs here.
SOURCE_PATTERNS = (
    "contracts/src/**/*.sol", "contracts/test/**/*.sol", "contracts/foundry.toml",
    "oracle/src/**/*.sol", "oracle/test/**/*.sol", "oracle/script/integration/*.sol",
    "oracle/foundry.toml", "oracle/bun.lock", "oracle/package.json",
    "oracle/services/*/src/**/*.ts", "oracle/packages/oracle-sdk/src/**/*.ts",
    "oracle/packages/oracle-sdk/scripts/*.ts", "oracle/packages/oracle-sdk/package.json",
    "packages/pricefeed/src/**/*.ts", "packages/pricefeed/scripts/*.ts",
    "packages/pricefeed/scripts/*.py", "packages/pricefeed/dist/src/**/*.js",
    "packages/pricefeed/dist/scripts/**/*.js", "packages/pricefeed/package.json",
    "packages/pricefeed/package-lock.json", "scripts/integration/*.py",
    "artifacts/risk/*.json",
)
RUNTIME_ARTIFACT_NAMES = ("RegistryBookRiskEngine", "MarketRegistry", "CollateralVault", "MockUSDC", "RolloverBatcher")


def source_fingerprints(root=ROOT):
    files = {path for pattern in SOURCE_PATTERNS for path in root.glob(pattern) if path.is_file()}
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            for path in sorted(files)}


def archive_runtime_artifacts(directory, root=ROOT):
    """Bind artifacts after legitimate deployment compilation, before services load them."""
    files, archives = {}, {}
    destination = directory / "runtime-artifacts"
    destination.mkdir()
    for name in RUNTIME_ARTIFACT_NAMES:
        relative = f"oracle/out/{name}.sol/{name}.json"
        payload = (root / relative).read_bytes()
        artifact = json.loads(payload)
        if not isinstance(artifact.get("abi"), list) or not artifact["abi"]:
            raise RuntimeError(f"Missing runtime ABI: {name}")
        archived = destination / f"{name}.json"
        archived.write_bytes(payload)
        files[relative] = hashlib.sha256(payload).hexdigest()
        archives[relative] = archived.relative_to(directory).as_posix()
    write_json(directory / "runtime-artifact-hashes.json", {"phase": "after-deployment-before-enrollment-and-services",
                                                           "hashPolicy": "SHA256 of unmodified artifact bytes", "files": files, "archives": archives})
    return files


def verify_source_fingerprints(directory, expected, root=ROOT, runtime_artifacts=None):
    actual = source_fingerprints(root)
    changed = sorted(name for name in set(expected) | set(actual) if expected.get(name) != actual.get(name))
    artifacts = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() if (root / name).is_file() else None
                 for name in (runtime_artifacts or {})}
    changed += [name for name, digest in artifacts.items() if digest != runtime_artifacts[name]]
    write_json(directory / "source-integrity.json", {"passed": not changed, "changedFiles": changed,
                                                     "files": actual, "runtimeArtifacts": artifacts,
                                                     "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    if changed:
        raise RuntimeError("Runtime source changed during proof; inspect source-integrity.json")


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
    for attempt in range(100):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 99:
                raise
            time.sleep(0.01)


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
        # Query the kernel directly: spawning PowerShell can take longer than the
        # entire cleanup budget during dependency installation. Preserve the old
        # .NET UTC tick format so recorded runtimes remain usable.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, int(pid))  # QUERY_LIMITED_INFORMATION
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:  # PID no longer exists.
                return None
            raise ctypes.WinError(error)
        try:
            exit_code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                raise ctypes.WinError(ctypes.get_last_error())
            if exit_code.value != 259:  # STILL_ACTIVE
                return None
            times = [wintypes.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
                raise ctypes.WinError(ctypes.get_last_error())
            created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            return str(created + 504911232000000000)  # 0001-to-1601 epoch offset.
        finally:
            if not kernel.CloseHandle(handle):
                raise ctypes.WinError(ctypes.get_last_error())
    path = Path(f"/proc/{pid}/stat")
    if path.exists():
        try:
            fields = path.read_text().rsplit(") ", 1)[1].split()
            return None if fields[0] == "Z" else fields[19]
        except FileNotFoundError:
            return None
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat=", "-o", "lstart="], text=True, capture_output=True)
    fields = result.stdout.strip().split(None, 1)
    # macOS keeps an exited child as a zombie until its parent reaps it.
    # Match the /proc branch: an exited process is no longer a live owned root.
    if len(fields) != 2 or fields[0].startswith("Z"):
        return None
    return fields[1].strip()


def stop_recorded(record, timeout=10):
    """Verify recorded roots; legacy background launches do not own native jobs."""
    deadline = time.monotonic() + timeout
    outcomes = []
    for item in reversed(record.get("processes", [])):
        outcome = {"name": item.get("name"), "pid": item["pid"], "stopped": False, "errors": []}
        outcomes.append(outcome)
        try:
            if not item.get("identity"):
                raise RuntimeError("Recorded root identity is missing; no process was targeted")
            if process_identity(item["pid"]) != item["identity"]:
                outcome.update(stopped=True, reason="original root no longer exists; any reused PID was untouched")
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError("Recorded-root cleanup budget expired")
            if os.name == "nt":
                stopped = subprocess.run(["taskkill", "/PID", str(item["pid"]), "/T", "/F"], capture_output=True,
                                         creationflags=HIDDEN, timeout=max(.001, deadline - time.monotonic()))
                outcome["terminationExitCode"] = stopped.returncode
            else:
                import signal
                try:
                    os.kill(item["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
            force_at = min(deadline, time.monotonic() + 1)
            while process_identity(item["pid"]) == item["identity"]:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Recorded root still exists after bounded termination")
                if os.name != "nt" and time.monotonic() >= force_at:
                    try:
                        os.kill(item["pid"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    outcome["forced"] = True
                    force_at = deadline
                time.sleep(.05)
            outcome["stopped"] = True
        except Exception as error:
            outcome["errors"].append(f"{type(error).__name__}: {error}")
    result = {"stopped": all(item["stopped"] for item in outcomes), "processes": outcomes,
              "scope": "Recorded background roots only; Windows taskkill requests tree termination, but legacy untracked descendants are not independently verified.",
              "descendantsVerified": False}
    record["backgroundCleanup"] = result
    return result


def require_free_port(port):
    with socket.socket() as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError as error:
            raise RuntimeError(f"Port {port} is occupied; do not reset another developer's chain") from error


def run(args):
    leveraged = getattr(args, "scenario", "fully-backed") == "leveraged"
    live = getattr(args, "source", "fixture") == "polymarket"
    settle_leveraged = getattr(args, "settle_leveraged", False)
    if live and not leveraged:
        raise RuntimeError("Real-source integration requires --scenario leveraged")
    if live and args.keep_running:
        raise RuntimeError("Real-source proof closes and audits its journals; omit --keep-running")
    if settle_leveraged and (live or not leveraged or args.keep_running):
        raise RuntimeError("--settle-leveraged requires the controlled leveraged proof without --keep-running")
    duration = getattr(args, "max_duration_seconds", 7200)
    if not 1 <= duration <= 7200:
        raise RuntimeError("Live duration must be within the 7200-second budget")
    latest = LIVE_LATEST if live else LEVERAGE_LATEST if leveraged else LATEST
    if not 1024 <= args.rpc_port < 65535 or not 1024 <= args.read_port <= 65535 or args.read_port in {args.rpc_port, args.rpc_port + 1}:
        raise RuntimeError("Use distinct nonprivileged RPC/read ports and reserve RPC port + 1 for Forge")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    prefix = "local-live-leverage" if live else "local-leverage" if leveraged else "local-integration"
    directory = (ROOT / "tmp" / f"{prefix}-{stamp}").resolve() if not args.directory else Path(args.directory).resolve()
    if not directory.is_relative_to(ROOT / "tmp"):
        raise RuntimeError("Run directory must be within this repository's ignored tmp directory")
    if directory.exists() and any(directory.iterdir()):
        raise RuntimeError("Use a new empty run directory; never reset a publisher's existing journals")
    require_free_port(args.rpc_port)
    require_free_port(args.rpc_port + 1)
    if args.keep_running or live or settle_leveraged:
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
    cleanup_failures = []
    record = {"scope": "local-only", "scenario": "leveraged" if leveraged else "fully-backed", "sourceMode": "polymarket" if live else "fixture", "rpcUrl": rpc,
              "directory": str(directory), "processes": processes, "status": "starting", "sdkSmoke": leveraged and not live,
              "settleLeveraged": settle_leveraged}
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    record["sourceCommit"] = source
    source_status = subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True)
    record["workingTree"] = "dirty; see source-status.txt" if source_status.strip() else "clean"
    (directory / "source-status.txt").write_text(source_status, encoding="utf-8")
    launch_sources = source_fingerprints()
    write_json(directory / "launch-source-hashes.json", {
        "recordedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "baseCommit": source,
        "hashPolicy": "SHA256 of source/executable JS after CRLF to LF normalization only; no environment files.",
        "files": launch_sources,
    })

    def command(name, argv, cwd=ROOT, timeout=600, health=()):
        print(f"[{name}]", flush=True)
        command_environment = forge_environment(environment, forge_rpc) if str(argv[0]) == forge else environment
        if str(argv[0]) == bun:
            argv = [bun, "--no-env-file", *argv[1:]]
        log = directory / f"{name}.log"
        started = time.monotonic()
        started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        process, failure, cleanup = None, None, None
        try:
            with log.open("w", encoding="utf-8") as output:
                process = OwnedProcess([str(value) for value in argv], cwd=cwd, env=command_environment, stdout=output)
                deadline = started + timeout
                while process.poll() is None:
                    if any(service.poll() is not None for service in health):
                        raise RuntimeError(f"{name}: a required background service exited; inspect sampler/upkeep logs")
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f"{name}: exceeded {timeout} seconds")
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
        except BaseException as error:
            failure = {"type": type(error).__name__, "message": str(error)}
            cleanup = getattr(error, "owned_process_cleanup", None)
            raise
        finally:
            if process is not None:
                try:
                    cleanup = process.stop(timeout=10)
                except BaseException as error:
                    cleanup = {"stopped": False, "errors": [f"{type(error).__name__}: {error}"]}
            unconfirmed = cleanup is not None and cleanup.get("stopped") is not True
            if unconfirmed:
                cleanup_failures.append({"step": name, "pid": process.pid if process else None, "cleanup": cleanup})
            code = process.returncode if process is not None else None
            results.append({"step": name, "exitCode": (code or 1) if failure or unconfirmed else code,
                            "processExitCode": code, "failure": failure, "cleanup": cleanup, "log": str(log.relative_to(ROOT)),
                            "argv": [str(value) for value in argv], "cwd": str(cwd.relative_to(ROOT)),
                            "startedAtUtc": started_at, "durationSeconds": time.monotonic() - started})
            write_json(directory / "steps.json", results)
            if unconfirmed and failure is None:
                raise RuntimeError(f"{name}: owned command cleanup could not be verified; inspect steps.json")
        if process.returncode:
            raise RuntimeError(f"{name} failed; inspect {log}")

    def background(name, argv, cwd=ROOT):
        if str(argv[0]) == bun:
            argv = [bun, "--no-env-file", *argv[1:]]
        handle = (directory / f"{name}.log").open("w", encoding="utf-8")
        handles.append(handle)
        process = subprocess.Popen([str(value) for value in argv], cwd=cwd, env=environment, stdout=handle, stderr=subprocess.STDOUT,
                                   creationflags=HIDDEN, stdin=subprocess.DEVNULL)
        entry = {"name": name, "pid": process.pid, "identity": None}
        processes.append(entry)  # Retain an unverified launch even if its identity query fails.
        entry["identity"] = process_identity(process.pid)
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
        live_source = directory / "live-source.json"
        if live:
            if getattr(args, "source_config", None):
                shutil.copyfile(Path(args.source_config).resolve(), live_source)
            else:
                command("source-probe", [node, PRICEFEED / "dist/scripts/live-factory-integration.js", "--mode", "prepare",
                                         "--directory", directory / "live-pricefeed", "--output", live_source], PRICEFEED, timeout=1200)
            command("source-preflight", [node, PRICEFEED / "dist/scripts/live-factory-integration.js", "--mode", "validate",
                                         "--source", live_source, "--directory", directory / "live-pricefeed",
                                         "--output", directory / "source-preflight.json"], PRICEFEED, timeout=180)
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
        if not live:
            rpc_call(rpc, "anvil_setBlockTimestampInterval", [1])
        record["localClock"] = {"blockIntervalSeconds": 1, "timestampIncrementSeconds": None if live else 1,
                                "model": "wall-clock" if live else "controlled-fixture", "finalizedLagBlocks": 4,
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
        if live:
            scheduled = int(json.loads(live_source.read_text(encoding="utf-8"))["scheduledT"])
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
        if live:
            shutil.copyfile(live_source, ORACLE / "deployments/live-source-input.json")
            script("deploy", "runLive(string,bytes32)", ["deployments/live-source-input.json", configuration["markets"]["terminal"]["sourceRulesHash"]])
        else:
            script("deploy", deploy_signature, [configuration["markets"]["demo"]["sourceRulesHash"], configuration["markets"]["terminal"]["sourceRulesHash"], str(scheduled)])
        runtime_artifacts = archive_runtime_artifacts(directory)
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

        if live:
            publisher_report = directory / "live-pricefeed.json"
            actor_report = directory / "live-actors.json"
            control = directory / "live-control.json"
            write_json(control, {"pauseSampling": True})
            driver = PRICEFEED / "dist/scripts/live-factory-integration.js"
            publisher_process = background("live-pricefeed", [node, driver, "--mode", "run", "--rpc", rpc,
                "--manifest", raw_manifest, "--source", live_source, "--directory", directory / "live-pricefeed",
                "--output", publisher_report, "--control", control, "--abi", ORACLE / "out/RegistryBookRiskEngine.sol/RegistryBookRiskEngine.json",
                "--duration-seconds", duration, "--bun", bun], PRICEFEED)
            command("live-actors", [bun, "services/local-integration/src/live-actors.ts", manifest, actor_report,
                    control, publisher_report, str(duration)], ORACLE, timeout=duration + 30, health=(publisher_process,))
            command("snapshot-final", [bun, "services/local-integration/src/main.ts", manifest, "snapshot", directory / "snapshot-final.json"], ORACLE)
            command("events", [bun, "services/local-integration/src/main.ts", manifest, "events", directory / "events.json"], ORACLE)
            record.update(manifest=str(manifest), readUrl=f"http://127.0.0.1:{args.read_port}")
            environment["LOCAL_READ_PORT"] = str(args.read_port)
            api = background("read-api", [bun, "services/local-integration/src/main.ts", manifest, "serve"], ORACLE)
            for _attempt in range(60):
                if api.poll() is not None or publisher_process.poll() is not None:
                    raise RuntimeError("A live-source service exited before API verification")
                try:
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                    with opener.open(record["readUrl"] + "/health", timeout=2) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError("Live read API did not become healthy")
            command("api-check", [sys.executable, ROOT / "scripts/integration/probe-local-api.py", "--runtime", directory / "runtime.json"])
            write_json(control, {"pauseSampling": True, "stop": True})
            if publisher_process.wait(timeout=30) != 0:
                raise RuntimeError("Live publisher did not close its journals cleanly")
            command("pricefeed-audit", [node, driver, "--mode", "audit", "--rpc", rpc,
                    "--abi", ORACLE / "out/RegistryBookRiskEngine.sol/RegistryBookRiskEngine.json", "--directory", directory / "live-pricefeed",
                    "--report", publisher_report, "--output", directory / "pricefeed-audit.json"], PRICEFEED)
            command("pricefeed-independent-review", [sys.executable, PRICEFEED / "scripts/review-live-factory.py", directory / "pricefeed-audit.json"])
            independent_review = json.loads((directory / "pricefeed-independent-review.log").read_text(encoding="utf-8"))
            if independent_review.get("passed") is not True:
                raise RuntimeError("Independent authentic-source replay did not pass")
            write_json(directory / "independent-pricefeed-review.json", independent_review)
            command("receipt-audit", [sys.executable, ROOT / "scripts/integration/audit-live-run.py", directory])
            verify_source_fingerprints(directory, launch_sources, runtime_artifacts=runtime_artifacts)
            record.update(status="passed-and-stopped", manifest=str(manifest), liveProof=str(actor_report),
                          fixtures=["mintable collateral", "synthetic risk calibration", "mock assertion venue"],
                          productionReady=False, publicTransactions=0)
            if not stop_recorded(record)["stopped"]:
                raise RuntimeError("Background root cleanup could not be verified; inspect runtime.json")
            write_json(directory / "runtime.json", record); write_json(latest, record)
            print(json.dumps(record, indent=2)); return

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
        if leveraged:
            command("sdk-prepare", [bun, "packages/oracle-sdk/scripts/local-trader-smoke.ts", manifest, "prepare", directory / "sdk-prepare.json"], ORACLE)
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
        if leveraged:
            command("sdk-claim", [bun, "packages/oracle-sdk/scripts/local-trader-smoke.ts", manifest, "claim", directory / "sdk-claim.json"], ORACLE)
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
        if not settle_leveraged:
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
        if args.keep_running or settle_leveraged:
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
            command("api-check", [sys.executable, ROOT / "scripts/integration/probe-local-api.py", "--runtime", directory / "runtime.json"])
        if settle_leveraged:
            demo = deployed["markets"]["demo"]["engine"]
            # The fixture publisher deliberately fails closed once its demo halts.
            # Drain it while trading is still live, before taking the sampler lock:
            # an in-flight publication may need that same lock to finish cleanly.
            stop_marker.write_text("close publisher journals before controlled leveraged halt\n", encoding="utf-8")
            if watcher.wait(timeout=30) != 0:
                raise RuntimeError("Publisher did not close cleanly before leveraged halt")
            with sampling_lock(directory):
                script("begin-leveraged-settlement", "beginLeveragedSettlement(address)", [demo])
            timestamp = int(rpc_call(rpc, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
            observed = warp_to(rpc, timestamp + 301)
            write_json(directory / "leveraged-liveness-warp.json", {"before": timestamp, "requested": timestamp + 301, "observed": observed})
            script("resolve-leveraged-assertion", "resolveLeveragedAssertion(address)", [demo])
            command("keeper-leveraged", [bun, "services/keeper/src/local-integration.ts", raw_manifest,
                    directory / "keeper-leveraged-gas.json", directory / "keeper-leveraged-report.json", "demo"], ORACLE)
            command("snapshot-claimable", [bun, "services/local-integration/src/main.ts", manifest, "snapshot", directory / "snapshot-claimable.json"], ORACLE)
            script("claim-leveraged", "claimLeveraged(address)", [demo])
            command("snapshot-settled", [bun, "services/local-integration/src/main.ts", manifest, "snapshot", directory / "snapshot-settled.json"], ORACLE)
            command("events-settled", [bun, "services/local-integration/src/main.ts", manifest, "events", directory / "events-settled.json"], ORACLE)
            command("receipt-audit", [sys.executable, ROOT / "scripts" / "integration" / "audit-local-run.py", directory])
        verify_source_fingerprints(directory, launch_sources, runtime_artifacts=runtime_artifacts)
        if args.keep_running:
            record["status"] = "passed"
        else:
            if not stop_recorded(record)["stopped"]:
                raise RuntimeError("Background root cleanup could not be verified; inspect runtime.json")
            record["status"] = "passed-and-stopped"
        write_json(directory / "runtime.json", record)
        write_json(latest, record)
        print(json.dumps(record, indent=2))
    except BaseException:
        if not args.keep_failed:
            stop_recorded(record)
        unconfirmed_background = record.get("backgroundCleanup", {}).get("stopped") is False
        record["status"] = "failed-cleanup-unverified" if cleanup_failures or unconfirmed_background else "failed-debug-running" if args.keep_failed else "failed-and-stopped"
        if cleanup_failures:
            record["cleanupFailures"] = cleanup_failures
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
    parser.add_argument("--source", choices=["fixture", "polymarket"], default="fixture")
    parser.add_argument("--source-config", help="Previously probed real-source JSON, revalidated before use")
    parser.add_argument("--max-duration-seconds", type=int, default=7200)
    parser.add_argument("--rpc-port", type=int, default=18546)
    parser.add_argument("--read-port", type=int, default=8787)
    parser.add_argument("--keep-running", action="store_true")
    parser.add_argument("--settle-leveraged", action="store_true", help="Close the controlled leveraged demo and audit full owner payouts/reserve loss")
    parser.add_argument("--keep-failed", action="store_true", help="Keep an owned loopback chain for debugging a failed run")
    args = parser.parse_args()
    if args.action == "run":
        run(args)
    else:
        latest = LIVE_LATEST if args.source == "polymarket" else LEVERAGE_LATEST if args.scenario == "leveraged" else LATEST
        path = Path(args.directory) / "runtime.json" if args.directory else latest
        record = json.loads(path.read_text(encoding="utf-8"))
        if args.action == "stop":
            cleanup = stop_recorded(record)
            record["status"] = "stopped" if cleanup["stopped"] else "failed-cleanup-unverified"
            write_json(Path(record["directory"]) / "runtime.json", record)
            write_json(LIVE_LATEST if record.get("sourceMode") == "polymarket" else LEVERAGE_LATEST if record.get("scenario") == "leveraged" else LATEST, record)
            if not cleanup["stopped"]:
                raise RuntimeError("Background root cleanup could not be verified; inspect runtime.json")
        print(json.dumps(record, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"LOCAL INTEGRATION FAILED: {error}", file=sys.stderr)
        sys.exit(1)
