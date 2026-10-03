"""Read-only Monad testnet network, artifact-size and deployment-gas preflight.

This program never signs, broadcasts, imports wallets, or builds contracts.
Official limits: https://docs.monad.xyz/developer-essentials/differences
Gas rules: https://docs.monad.xyz/developer-essentials/summary
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RPC = "https://testnet-rpc.monad.xyz"
DEFAULT_ARTIFACT = ROOT / "contracts/out/BookRiskEngine.sol/BookRiskEngine.json"
RUNTIME_LIMIT = 131072
INITCODE_LIMIT = 262144
TRANSACTION_GAS_LIMIT = 30000000
READ_METHODS = frozenset({
    "eth_chainId", "web3_clientVersion", "eth_getBlockByNumber", "eth_gasPrice", "eth_estimateGas"
})


class PreflightError(Exception):
    pass


class ReadOnlyRpc:
    def __init__(self, endpoint, timeout):
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise PreflightError("RPC must be an HTTP or HTTPS URL")
        if parsed.username is not None or parsed.password is not None or parsed.fragment:
            raise PreflightError("RPC user credentials and URL fragments are not supported")
        if not math.isfinite(timeout) or timeout <= 0:
            raise PreflightError("RPC timeout must be positive and finite")
        self.endpoint = endpoint
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.timeout = timeout
        self.sequence = 0

    def call(self, method, parameters):
        if method not in READ_METHODS:
            raise PreflightError("Only allowlisted read-only RPC methods are supported")
        self.sequence += 1
        payload = json.dumps({
            "jsonrpc": "2.0", "id": self.sequence, "method": method, "params": parameters
        }).encode("utf-8")
        request = Request(self.endpoint, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                result = json.load(response)
        except HTTPError as error:
            raise PreflightError(f"{method}: HTTP {error.code}") from error
        except URLError as error:
            raise PreflightError(f"{method}: RPC connection failed") from error
        if not isinstance(result, dict) or result.get("id") != self.sequence:
            raise PreflightError(f"{method}: malformed RPC response")
        if result.get("error") is not None:
            error = result["error"]
            raise PreflightError(f"{method}: {json.dumps(error, sort_keys=True)}")
        if "result" not in result:
            raise PreflightError(f"{method}: missing RPC result")
        return result["result"]


def quantity(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]+", value):
        raise PreflightError(f"{label} must be an RPC hexadecimal quantity")
    return int(value, 16)


def hex_bytes(value, label):
    if not isinstance(value, str):
        raise PreflightError(f"{label} must be hexadecimal bytes")
    encoded = value.strip()
    if encoded.startswith("0x"):
        encoded = encoded[2:]
    if len(encoded) % 2 or not re.fullmatch(r"[0-9a-fA-F]*", encoded):
        raise PreflightError(f"{label} contains invalid hex or unresolved library links")
    return bytes.fromhex(encoded)


def artifact_bytecode(artifact, key):
    value = artifact.get(key)
    if isinstance(value, dict):
        value = value.get("object")
    result = hex_bytes(value, key)
    if not result:
        raise PreflightError(f"{key} is empty; an abstract or unbuilt contract cannot be deployed")
    return result


def inspect_artifact(path, constructor_arguments):
    raw = path.read_bytes()
    artifact = json.loads(raw)
    if not isinstance(artifact, dict):
        raise PreflightError("Foundry artifact must be a JSON object")
    metadata = artifact.get("metadata")
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if not isinstance(metadata, dict):
        raise PreflightError("Foundry artifact must include compiler metadata")
    settings = metadata.get("settings", {})
    compiler_metadata = metadata.get("compiler", {})
    if not isinstance(settings, dict) or not isinstance(compiler_metadata, dict):
        raise PreflightError("Compiler metadata settings and version must be objects")
    target = settings.get("compilationTarget", {})
    if target != {"src/engine/BookRiskEngine.sol": "BookRiskEngine"}:
        raise PreflightError("Artifact is not the concrete src/engine/BookRiskEngine.sol production path")
    compiler = compiler_metadata.get("version", "")
    optimizer = settings.get("optimizer", {})
    if (not isinstance(compiler, str) or not isinstance(optimizer, dict)
            or not compiler.startswith("0.8.30+") or settings.get("evmVersion") != "prague"
            or optimizer.get("enabled") is not True or optimizer.get("runs") != 200):
        raise PreflightError("Artifact must use pinned solc 0.8.30, Prague, optimizer enabled with 200 runs")
    creation = artifact_bytecode(artifact, "bytecode")
    runtime = artifact_bytecode(artifact, "deployedBytecode")
    initcode = creation + constructor_arguments
    if len(runtime) > RUNTIME_LIMIT:
        raise PreflightError(f"Runtime {len(runtime)} bytes exceeds {RUNTIME_LIMIT}")
    if len(initcode) > INITCODE_LIMIT:
        raise PreflightError(f"Initcode plus constructor arguments {len(initcode)} bytes exceeds {INITCODE_LIMIT}")
    return initcode, {
        "path": str(path.resolve()),
        "artifact_sha256": hashlib.sha256(raw).hexdigest(),
        "compiler": compiler,
        "evm_version": settings["evmVersion"],
        "optimizer_runs": optimizer["runs"],
        "compilation_target": target,
        "runtime_template_bytes": len(runtime),
        "runtime_template_sha256": hashlib.sha256(runtime).hexdigest(),
        "creation_bytes": len(creation),
        "constructor_argument_bytes": len(constructor_arguments),
        "initcode_bytes": len(initcode),
        "initcode_sha256": hashlib.sha256(initcode).hexdigest(),
        "runtime_note": "Artifact immutable placeholders are not the final deployed runtime code hash",
    }


def preflight(arguments, report):
    rpc = ReadOnlyRpc(arguments.rpc, arguments.timeout)
    report["rpc_origin"] = rpc.origin
    report["rpc_endpoint_sha256"] = hashlib.sha256(arguments.rpc.encode("utf-8")).hexdigest()
    chain_id = quantity(rpc.call("eth_chainId", []), "chain ID")
    report["chain_id"] = chain_id
    if chain_id != 10143 and not (arguments.allow_local_chain and chain_id == 31337):
        raise PreflightError("Refusing chain other than Monad testnet 10143 or explicitly allowed local 31337")
    report["network_scope"] = "testnet-chain-id" if chain_id == 10143 else "explicit-local-chain-id"
    report["client_version"] = rpc.call("web3_clientVersion", [])
    block = rpc.call("eth_getBlockByNumber", ["latest", False])
    if not isinstance(block, dict):
        raise PreflightError("RPC returned no latest block")
    report["block"] = {
        "number": quantity(block.get("number"), "block number"),
        "hash": block.get("hash"),
        "timestamp": quantity(block.get("timestamp"), "block timestamp"),
        "gas_limit": quantity(block.get("gasLimit"), "block gas limit"),
        "base_fee_per_gas_wei": quantity(block.get("baseFeePerGas"), "base fee"),
    }
    report["suggested_gas_price_wei"] = quantity(rpc.call("eth_gasPrice", []), "gas price")
    if arguments.network_only:
        report["status"] = "network_ok"
        return
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", arguments.sender):
        raise PreflightError("--from must be a 20-byte hexadecimal address")
    if arguments.constructor_args_file is not None:
        encoded = arguments.constructor_args_file.read_text(encoding="utf-8")
    elif arguments.constructor_args is not None:
        encoded = arguments.constructor_args
    else:
        raise PreflightError("Full preflight requires --constructor-args or --constructor-args-file")
    constructor_arguments = hex_bytes(encoded, "constructor arguments")
    if not constructor_arguments or len(constructor_arguments) % 32:
        raise PreflightError("Constructor arguments must be nonempty ABI-encoded whole words without a selector")
    initcode, report["artifact"] = inspect_artifact(arguments.artifact, constructor_arguments)
    allowance = min(TRANSACTION_GAS_LIMIT, report["block"]["gas_limit"])
    transaction = {"from": arguments.sender, "data": "0x" + initcode.hex(), "gas": hex(allowance)}
    report["estimate_request"] = {
        "from": arguments.sender, "block_number": report["block"]["number"], "gas_allowance": allowance
    }
    estimate = quantity(rpc.call("eth_estimateGas", [transaction, block["number"]]), "gas estimate")
    report["estimated_gas"] = estimate
    if estimate == 0 or estimate > allowance:
        raise PreflightError(f"Gas estimate {estimate} is outside the supported transaction allowance {allowance}")
    report["remaining_gas_headroom"] = allowance - estimate
    report["estimated_cost_at_quoted_gas_price_wei"] = estimate * report["suggested_gas_price_wei"]
    report["status"] = "estimate_ok"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", default=DEFAULT_RPC)
    parser.add_argument("--network-only", action="store_true")
    parser.add_argument("--allow-local-chain", action="store_true", help="Additionally allow chain ID 31337")
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    constructor = parser.add_mutually_exclusive_group()
    constructor.add_argument("--constructor-args", help="ABI-encoded arguments, without a function selector")
    constructor.add_argument("--constructor-args-file", type=Path)
    parser.add_argument("--from", dest="sender", default="0x000000000000000000000000000000000000dEaD")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--output", type=Path, help="Optional local JSON report; never a transaction")
    arguments = parser.parse_args(argv)
    if arguments.output is not None:
        protected = {Path(__file__).resolve(), arguments.artifact.resolve()}
        if arguments.constructor_args_file is not None:
            protected.add(arguments.constructor_args_file.resolve())
        if arguments.output.resolve() in protected:
            parser.error("--output must not overwrite the script, artifact, or constructor arguments")
    report = {
        "schema": "eros-monad-preflight/1",
        "observed_at_utc": datetime.now(timezone.utc).isoformat(),
        "mode": "network_only" if arguments.network_only else "deployment_estimate",
        "status": "failed",
        "broadcast": False,
        "limits": {"runtime_bytes": RUNTIME_LIMIT, "initcode_bytes": INITCODE_LIMIT,
                   "transaction_gas": TRANSACTION_GAS_LIMIT},
        "limitations": [
            "Read-only checks do not deploy, fund, activate, authorize a release, or grant peer review",
            "Chain ID alone does not distinguish public testnet from a local fork using the same ID",
            "Rebuild the pinned source: artifact metadata and hashes alone do not prove build freshness",
            "Estimation requires constructor dependencies at this RPC state and is not a deployment receipt",
            "Monad charges the transaction gas limit; do not use an unnecessarily large broadcast limit",
        ],
        "sources": [
            "https://docs.monad.xyz/developer-essentials/testnet",
            "https://docs.monad.xyz/developer-essentials/differences",
            "https://docs.monad.xyz/developer-essentials/summary",
            "https://docs.monad.xyz/tooling-and-infra/toolkits/foundry",
        ],
    }
    try:
        preflight(arguments, report)
    except (PreflightError, OSError, ValueError, TypeError) as error:
        report["error"] = str(error)
    content = json.dumps(report, indent=2) + "\n"
    if arguments.output is not None:
        try:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_text(content, encoding="utf-8", newline="\n")
        except OSError as error:
            print(f"Cannot write report: {error}", file=sys.stderr)
            return 1
    print(content, end="")
    return 0 if report["status"] in ("network_ok", "estimate_ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
