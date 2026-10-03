"""Read-only verification of DeployTestnetRiskBook's six Monad testnet transactions.

Uses local Foundry artifacts and an RPC URL read only from the named environment
variable. Never builds, signs, broadcasts, imports wallets, or prints that URL.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = {
    "TestnetRiskCollateral": "test/mocks/integration/TestnetRiskFixtures.sol",
    "CollateralVault": "src/vaults/CollateralVault.sol",
    "TestnetResolutionAuthority": "test/mocks/integration/TestnetRiskFixtures.sol",
    "BookRiskEngine": "src/engine/BookRiskEngine.sol",
}
LIMITS = {"transaction_gas": 30000000, "initcode_bytes": 262144, "runtime_bytes": 131072}
READ_METHODS = frozenset({
    "eth_chainId", "eth_getBlockByNumber", "eth_getTransactionByHash",
    "eth_getTransactionReceipt", "eth_getCode", "eth_call",
})


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def hex_bytes(value, label, size=None):
    require(isinstance(value, str) and re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", value),
            f"Invalid {label} hexadecimal bytes")
    result = bytes.fromhex(value[2:])
    require(size is None or len(result) == size, f"Invalid {label} length")
    return result


def address(value):
    return "0x" + hex_bytes(value, "address", 20).hex()


def quantity(value, label):
    require(isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]+", value),
            f"Invalid {label} quantity")
    return int(value, 16)


class ReadOnlyRpc:
    def __init__(self, endpoint, timeout):
        parsed = urlsplit(endpoint)
        require(parsed.scheme in ("https", "http") and parsed.hostname,
                "RPC environment variable must contain an HTTP(S) URL")
        require(not parsed.username and not parsed.password and not parsed.fragment,
                "RPC user credentials and fragments are unsupported")
        require(math.isfinite(timeout) and timeout > 0, "Timeout must be positive and finite")
        self.endpoint = endpoint
        self.timeout = timeout
        self.sequence = 0

    def call(self, method, parameters):
        require(method in READ_METHODS, "RPC method is not read-only allowlisted")
        self.sequence += 1
        payload = json.dumps({"jsonrpc": "2.0", "id": self.sequence,
                              "method": method, "params": parameters}).encode()
        request = Request(self.endpoint, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                result = json.load(response)
        except HTTPError as error:
            raise VerificationError(f"{method}: HTTP {error.code}") from None
        except (URLError, OSError, ValueError):
            raise VerificationError(f"{method}: unavailable or malformed RPC response") from None
        require(isinstance(result, dict) and result.get("id") == self.sequence,
                f"{method}: malformed RPC envelope")
        require(result.get("error") is None and "result" in result,
                f"{method}: RPC returned an error or missing result")
        return result["result"]


def artifact_path(name):
    return ROOT / "contracts/out" / Path(CONTRACTS[name]).name / f"{name}.json"


def load_artifact(name):
    raw = artifact_path(name).read_bytes()
    artifact = json.loads(raw)
    metadata = artifact["metadata"]
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    settings = metadata["settings"]
    require(settings["compilationTarget"] == {CONTRACTS[name]: name}, "Wrong artifact compilation target")
    require(metadata["compiler"]["version"].startswith("0.8.30+")
            and settings["evmVersion"] == "prague"
            and settings["optimizer"].get("enabled") is True
            and settings["optimizer"].get("runs") == 200, "Unexpected compiler settings")
    return artifact, hashlib.sha256(raw).hexdigest()


def selector(artifact, signature):
    value = artifact["methodIdentifiers"].get(signature)
    return hex_bytes("0x" + (value or ""), "artifact function selector", 4)


def decode_static(parameters, data):
    offset = 0

    def decode(parameter):
        nonlocal offset
        kind = parameter["type"]
        if kind == "tuple":
            return {component["name"]: decode(component) for component in parameter["components"]}
        word = data[offset:offset + 32]
        require(len(word) == 32, "Truncated ABI data")
        offset += 32
        number = int.from_bytes(word, "big")
        if kind == "address":
            require(number < 2**160, "Noncanonical ABI address")
            return "0x" + word[12:].hex()
        if kind == "bool":
            require(number in (0, 1), "Noncanonical ABI boolean")
            return bool(number)
        if kind == "bytes32":
            return "0x" + word.hex()
        require(re.fullmatch(r"uint(?:8|16|32|64|128|256)", kind), "Unsupported non-static ABI type")
        require(number < 2**int(kind[4:]), "Noncanonical ABI unsigned integer")
        return number

    result = [decode(parameter) for parameter in parameters]
    require(offset == len(data), "Unexpected trailing ABI data")
    return result


def inspect_runtime(artifact, runtime):
    deployed = artifact["deployedBytecode"]
    template = hex_bytes(deployed["object"], "artifact runtime")
    require(0 < len(runtime) == len(template) <= LIMITS["runtime_bytes"], "Runtime length mismatch or limit")
    mask = bytearray(len(runtime))
    immutable_values = {}
    for identifier, references in deployed.get("immutableReferences", {}).items():
        values = []
        require(bool(references), "Empty immutable reference group")
        for reference in references:
            start, length = reference["start"], reference["length"]
            require(isinstance(start, int) and isinstance(length, int)
                    and 0 <= start < len(runtime) and 0 < length <= len(runtime) - start,
                    "Invalid immutable reference bounds")
            require(not any(mask[start:start + length]), "Overlapping immutable references")
            mask[start:start + length] = b"\x01" * length
            values.append("0x" + runtime[start:start + length].hex())
        require(len(set(values)) == 1, "Repeated immutable has inconsistent deployed values")
        immutable_values[identifier] = {"value": values[0], "references": references}
    require(all(actual == expected or mask[index]
                for index, (actual, expected) in enumerate(zip(runtime, template))),
            "Deployed runtime differs outside compiler immutable references")
    return {"runtime_bytes": len(runtime), "runtime_sha256": hashlib.sha256(runtime).hexdigest(),
            "artifact_runtime_sha256": hashlib.sha256(template).hexdigest(),
            "unmasked_runtime_match": True, "immutable_values_by_ast_id": immutable_values}


def verify(arguments, report):
    raw = arguments.broadcast.read_bytes()
    broadcast = json.loads(raw)
    entries = broadcast.get("transactions", [])
    require(broadcast.get("chain") == 10143 and len(entries) == 6,
            "Expected the six-transaction Monad testnet deployment broadcast")
    hashes = ["0x" + hex_bytes(entry.get("hash"), "mined transaction hash", 32).hex() for entry in entries]
    require(len(set(hashes)) == 6, "Duplicate transaction hashes")
    endpoint = os.environ.get(arguments.rpc_env)
    require(bool(endpoint), "RPC environment variable is absent or empty")
    rpc = ReadOnlyRpc(endpoint, arguments.timeout)
    require(quantity(rpc.call("eth_chainId", []), "chain ID") == 10143, "RPC is not chain 10143")
    block = rpc.call("eth_getBlockByNumber", ["latest", False])
    block_number = quantity(block["number"], "current block")
    block_hash = "0x" + hex_bytes(block["hash"], "block hash", 32).hex()
    report.update({"chain_id": 10143, "broadcast_sha256": hashlib.sha256(raw).hexdigest(),
                   "block": {"number": block_number, "hash": block_hash,
                             "timestamp": quantity(block["timestamp"], "block timestamp")},
                   "transactions": [], "contracts": {}, "views": {}})
    artifacts, addresses, constructors = {}, {}, {}
    deployer, previous_nonce = None, None
    for index, (entry, transaction_hash) in enumerate(zip(entries, hashes)):
        transaction = rpc.call("eth_getTransactionByHash", [transaction_hash])
        receipt = rpc.call("eth_getTransactionReceipt", [transaction_hash])
        require(isinstance(transaction, dict) and isinstance(receipt, dict), "Transaction is absent or pending")
        require(transaction["hash"].lower() == transaction_hash
                and receipt["transactionHash"].lower() == transaction_hash, "RPC transaction hash mismatch")
        require(quantity(receipt["status"], "receipt status") == 1, "Transaction reverted")
        require(quantity(transaction["chainId"], "transaction chain ID") == 10143, "Transaction chain mismatch")
        sender = address(transaction["from"])
        deployer = deployer or sender
        require(sender == deployer == address(entry["transaction"]["from"])
                and address(receipt["from"]) == deployer, "Deployment sender mismatch")
        nonce = quantity(transaction["nonce"], "nonce")
        require(previous_nonce is None or nonce == previous_nonce + 1, "Nonconsecutive deployment nonces")
        previous_nonce = nonce
        gas_limit = quantity(transaction["gas"], "transaction gas")
        gas_used = quantity(receipt["gasUsed"], "receipt gas used")
        require(0 < gas_used <= gas_limit <= LIMITS["transaction_gas"], "Transaction gas exceeds allowance")
        require(quantity(transaction["value"], "transaction value") == 0, "Unexpected transferred native value")
        mined_number = quantity(receipt["blockNumber"], "receipt block")
        require(mined_number <= block_number and transaction["blockHash"] == receipt["blockHash"]
                and quantity(transaction["blockNumber"], "transaction block") == mined_number,
                "Inconsistent mined transaction block")
        mined_block = rpc.call("eth_getBlockByNumber", [receipt["blockNumber"], False])
        require(mined_block["hash"] == receipt["blockHash"], "Receipt block is not canonical")
        transaction_input = hex_bytes(transaction["input"], "transaction input")
        require(transaction_input == hex_bytes(entry["transaction"]["input"], "broadcast input"),
                "Mined transaction input differs from broadcast")
        report["transactions"].append({"hash": transaction_hash, "block_number": mined_number,
                                       "block_hash": receipt["blockHash"], "status": 1,
                                       "gas_limit": gas_limit, "gas_used": gas_used,
                                       "effective_gas_price_wei": quantity(receipt["effectiveGasPrice"], "gas price")})
        if index < 4:
            name = list(CONTRACTS)[index]
            require(entry["transactionType"] == "CREATE" and entry["contractName"] == name
                    and transaction.get("to") is None and receipt.get("to") is None, "Wrong creation sequence")
            deployed_address = address(receipt["contractAddress"])
            require(deployed_address == address(entry["contractAddress"]), "Deployed address mismatch")
            artifact, artifact_hash = load_artifact(name)
            artifacts[name], addresses[name] = artifact, deployed_address
            creation = hex_bytes(artifact["bytecode"]["object"], "artifact creation")
            require(bool(creation) and transaction_input.startswith(creation)
                    and len(transaction_input) <= LIMITS["initcode_bytes"], "Initcode mismatch or size limit")
            constructor = next(item for item in artifact["abi"] if item["type"] == "constructor")
            constructors[name] = decode_static(constructor["inputs"], transaction_input[len(creation):])
            runtime = hex_bytes(rpc.call("eth_getCode", [deployed_address, block["number"]]), "deployed runtime")
            report["contracts"][name] = {"address": deployed_address, "artifact_sha256": artifact_hash,
                                         "source": CONTRACTS[name], "initcode_bytes": len(transaction_input),
                                         "initcode_sha256": hashlib.sha256(transaction_input).hexdigest(),
                                         **inspect_runtime(artifact, runtime)}
        else:
            name, signature = (("CollateralVault", "registerEngine(address)") if index == 4
                               else ("TestnetResolutionAuthority", "bind(address)"))
            expected_input = selector(artifacts[name], signature) + hex_bytes(addresses["BookRiskEngine"], "engine").rjust(32, b"\x00")
            require(entry["transactionType"] == "CALL" and entry["function"] == signature
                    and address(transaction["to"]) == addresses[name]
                    and address(receipt["to"]) == addresses[name] and receipt.get("contractAddress") is None
                    and transaction_input == expected_input, "Wrong registration call")
    report["deployer"] = deployer
    require(constructors["TestnetRiskCollateral"] == [deployer]
            and constructors["CollateralVault"] == [addresses["TestnetRiskCollateral"], deployer]
            and constructors["TestnetResolutionAuthority"] == [deployer], "Constructor controller/dependency mismatch")
    require(constructors["BookRiskEngine"][:2] == [addresses["CollateralVault"], deployer],
            "Engine constructor vault or treasury mismatch")

    def view(name, signature, encoded_argument=b""):
        artifact = artifacts[name]
        function = next(item for item in artifact["abi"]
                        if item["type"] == "function" and item["name"] == signature.split("(")[0])
        require(function["stateMutability"] in ("view", "pure"), "Non-view ABI function")
        data = selector(artifact, signature) + encoded_argument
        result = hex_bytes(rpc.call("eth_call", [{"to": addresses[name], "data": "0x" + data.hex()}, block["number"]]), "view result")
        decoded = decode_static(function["outputs"], result)
        require(len(decoded) == 1, "Unexpected view result arity")
        report["views"][f"{name}.{signature}"] = decoded[0]
        return decoded[0]

    checks = [
        ("TestnetRiskCollateral", "controller()", deployer),
        ("TestnetRiskCollateral", "decimals()", 6),
        ("CollateralVault", "governor()", deployer),
        ("CollateralVault", "token()", addresses["TestnetRiskCollateral"]),
        ("TestnetResolutionAuthority", "controller()", deployer),
        ("TestnetResolutionAuthority", "engine()", addresses["BookRiskEngine"]),
        ("BookRiskEngine", "collateralVault()", addresses["CollateralVault"]),
        ("BookRiskEngine", "treasury()", deployer),
        ("BookRiskEngine", "fundingFeatureEnabled()", False),
        ("BookRiskEngine", "recoveryEnabled()", False),
    ]
    for name, signature, expected in checks:
        require(view(name, signature) == expected, f"Unexpected {name}.{signature}")
    require(view("CollateralVault", "engines(address)", hex_bytes(addresses["BookRiskEngine"], "engine").rjust(32, b"\x00")) is True,
            "Engine is not registered in vault")
    listing = view("BookRiskEngine", "listing()")
    require(listing == constructors["BookRiskEngine"][2], "Listing differs from constructor configuration")
    for field in ("registry", "monitor", "governance", "indexSigner"):
        require(listing[field] == deployer, f"Unexpected listing {field}")
    require(listing["token"] == addresses["TestnetRiskCollateral"]
            and listing["resolutionAuthority"] == addresses["TestnetResolutionAuthority"]
            and listing["deploymentCapX"] == 1 and listing["maxTraders"] == 1024
            and listing["maxLiqLotsPerBlock"] == 0 and listing["fundingEnabled"] is False,
            "Unexpected cap-one test fixture configuration")
    require(rpc.call("eth_getBlockByNumber", [block["number"], False])["hash"].lower() == block_hash,
            "Observed block changed during verification; rerun")
    report["status"] = "verified_testnet_fixture"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-env", default="ETH_RPC_URL")
    parser.add_argument("--broadcast", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=30)
    arguments = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", arguments.rpc_env):
        parser.error("--rpc-env must name an environment variable, not contain a URL")
    protected = {Path(__file__).resolve(), arguments.broadcast.resolve()}
    protected.update(artifact_path(name).resolve() for name in CONTRACTS)
    if arguments.output.resolve() in protected:
        parser.error("--output must not overwrite a script, broadcast, or artifact input")
    report = {"schema": "eros-monad-deployment-verification/1", "status": "failed",
              "observed_at_utc": datetime.now(timezone.utc).isoformat(),
              "rpc_env": arguments.rpc_env, "broadcast_by_verifier": False, "limits": LIMITS,
              "limitations": [
                  "Read-only RPC observation; does not grant deployment, release, gate acceptance, or peer review",
                  "Chain ID and RPC responses do not independently authenticate public testnet or finality",
                  "Local artifact comparison does not prove fresh compilation or independently reproduce source",
                  "Runtime SHA-256 is a content digest, not Ethereum Keccak EXTCODEHASH",
                  "Immutable AST IDs and values are reported without assuming source-variable identities",
                  "The four top-level creations are checked; nested ReserveVault runtime is not independently compared",
                  "Mock collateral and controller oracle are test fixtures, not live feeds or production collateral",
                  "Successful deployment and binding do not prove activation, trading, settlement, or economic safety",
              ]}
    try:
        verify(arguments, report)
    except VerificationError as error:
        report["error"] = str(error)
    except (OSError, ValueError, TypeError, KeyError, StopIteration, AttributeError):
        report["error"] = "Malformed or unavailable local input or RPC data"
    content = json.dumps(report, indent=2) + "\n"
    try:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(content, encoding="utf-8", newline="\n")
    except OSError:
        print("Cannot write verification report", file=sys.stderr)
        return 1
    print(content, end="")
    return 0 if report["status"] == "verified_testnet_fixture" else 1


if __name__ == "__main__":
    raise SystemExit(main())
