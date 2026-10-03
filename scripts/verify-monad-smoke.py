"""Read-only receipt and final-state verification of the controlled Monad smoke fixture."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys


HELPER_PATH = Path(__file__).with_name("verify-monad-deployment.py")
SPEC = importlib.util.spec_from_file_location("monad_deployment_verification", HELPER_PATH)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
helper.CONTRACTS.update({"TestnetRiskSmoke": "script/ExerciseTestnetRiskBook.s.sol",
                         "TestnetRiskTrader": "script/ExerciseTestnetRiskBook.s.sol"})


def word(value):
    return (helper.hex_bytes(value, "ABI address or bytes32").rjust(32, b"\x00")
            if isinstance(value, str) else value.to_bytes(32, "big"))


def verify(arguments, report):
    controller, engine, smoke = map(helper.address, (arguments.controller, arguments.engine, arguments.smoke))
    raw = arguments.receipts.read_bytes()
    hashes = json.loads(raw)
    helper.require(isinstance(hashes, list) and len(hashes) == 9,
                   "Expected ordered setup (5), trade (1), settlement (3) transaction hashes")
    hashes = ["0x" + helper.hex_bytes(value, "transaction hash", 32).hex() for value in hashes]
    helper.require(len(set(hashes)) == 9, "Duplicate smoke transaction hashes")
    endpoint = os.environ.get(arguments.rpc_env)
    helper.require(bool(endpoint), "RPC environment variable is absent or empty")
    rpc = helper.ReadOnlyRpc(endpoint, arguments.timeout)
    helper.require(helper.quantity(rpc.call("eth_chainId", []), "chain ID") == 10143, "RPC is not chain 10143")
    block = rpc.call("eth_getBlockByNumber", ["latest", False])
    block_number = helper.quantity(block["number"], "block number")
    report.update({"chain_id": 10143, "expected_controller": controller, "expected_engine": engine,
                   "smoke": smoke, "receipts_input_sha256": hashlib.sha256(raw).hexdigest(),
                   "block": {"number": block_number, "hash": block["hash"],
                             "timestamp": helper.quantity(block["timestamp"], "block timestamp")},
                   "contracts": {}, "views": {}, "transactions": []})
    artifacts = {}

    def artifact(name):
        if name not in artifacts:
            artifacts[name] = helper.load_artifact(name)
        return artifacts[name][0]

    def view(name, target, signature, argument=b""):
        compiled = artifact(name)
        function = next(item for item in compiled["abi"]
                        if item["type"] == "function" and item["name"] == signature.split("(")[0])
        helper.require(function["stateMutability"] in ("view", "pure"), "Non-view ABI method")
        data = helper.selector(compiled, signature) + argument
        result = rpc.call("eth_call", [{"to": target, "data": "0x" + data.hex()}, block["number"]])
        decoded = helper.decode_static(function["outputs"], helper.hex_bytes(result, "view result"))
        helper.require(len(decoded) == 1, "Unexpected view arity")
        report["views"][f"{name}@{target}.{signature}:{argument.hex()}"] = decoded[0]
        return decoded[0]

    def check(name, target, signature, expected, argument=b""):
        helper.require(view(name, target, signature, argument) == expected, f"Unexpected {name}.{signature}")

    check("TestnetRiskSmoke", smoke, "controller()", controller)
    check("TestnetRiskSmoke", smoke, "engine()", engine)
    for signature in ("funded()", "traded()", "completed()"):
        check("TestnetRiskSmoke", smoke, signature, True)
    buyer = view("TestnetRiskSmoke", smoke, "buyer()")
    seller = view("TestnetRiskSmoke", smoke, "seller()")
    token = view("TestnetRiskSmoke", smoke, "collateral()")
    authority = view("TestnetRiskSmoke", smoke, "authority()")
    vault = view("BookRiskEngine", engine, "collateralVault()")
    contracts = [("TestnetRiskSmoke", smoke), ("TestnetRiskTrader", buyer), ("TestnetRiskTrader", seller),
                 ("BookRiskEngine", engine), ("CollateralVault", vault),
                 ("TestnetRiskCollateral", token), ("TestnetResolutionAuthority", authority)]
    helper.require(len({target for _, target in contracts}) == 7, "Overlapping smoke contract addresses")
    for name, target in contracts:
        runtime = helper.hex_bytes(rpc.call("eth_getCode", [target, block["number"]]), "deployed runtime")
        report["contracts"][target] = {"name": name, **helper.inspect_runtime(artifact(name), runtime),
                                        "artifact_sha256": artifacts[name][1]}
    for actor, payout in ((buyer, 150000000), (seller, 50000000)):
        check("TestnetRiskTrader", actor, "controller()", smoke)
        check("TestnetRiskTrader", actor, "engine()", engine)
        check("TestnetRiskTrader", actor, "funded()", True)
        check("TestnetRiskCollateral", token, "balanceOf(address)", payout, word(actor))
        check("BookRiskEngine", engine, "traderClaimed(address)", True, word(actor))
    for name, target, signature, expected, argument in [
        ("TestnetRiskCollateral", token, "controller()", controller, b""),
        ("TestnetRiskCollateral", token, "decimals()", 6, b""),
        ("TestnetRiskCollateral", token, "balanceOf(address)", 0, word(vault)),
        ("TestnetResolutionAuthority", authority, "controller()", controller, b""),
        ("TestnetResolutionAuthority", authority, "engine()", engine, b""),
        ("CollateralVault", vault, "governor()", controller, b""),
        ("CollateralVault", vault, "token()", token, b""),
        ("CollateralVault", vault, "engines(address)", True, word(engine)),
        ("CollateralVault", vault, "recognizedAtoms()", 0, b""),
        ("BookRiskEngine", engine, "claimsEnabled()", True, b""),
        ("BookRiskEngine", engine, "allTraderClaimsPaid()", True, b""),
        ("BookRiskEngine", engine, "unpaidTraderClaims()", 0, b""),
        ("BookRiskEngine", engine, "participantCount()", 2, b""),
        ("BookRiskEngine", engine, "halted()", True, b""),
        ("BookRiskEngine", engine, "finalOutcome()", 2, b""),
        ("BookRiskEngine", engine, "settlementPriceWad()", 10**18, b""),
        ("BookRiskEngine", engine, "fundingFeatureEnabled()", False, b""),
        ("BookRiskEngine", engine, "recoveryEnabled()", False, b""),
    ]:
        check(name, target, signature, expected, argument)
    listing = view("BookRiskEngine", engine, "listing()")
    helper.require(all(listing[field] == controller for field in ("registry", "monitor", "governance", "indexSigner"))
                   and listing["token"] == token and listing["resolutionAuthority"] == authority,
                   "Listing dependency or controller mismatch")
    source = view("BookRiskEngine", engine, "sourceState(bytes32)", word(listing["indexSourceId"]))
    helper.require(source["configured"] and source["signer"] == controller
                   and source["rulesHash"] == listing["indexRulesHash"] and source["lastSequence"] == 11
                   and 0 < source["lastObservedAt"] <= report["block"]["timestamp"], "Invalid authenticated index source state")
    trade_signature = "executeTrade((bytes32,bytes32,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,bytes32)[],bytes[])"
    phases = [("TestnetRiskSmoke", None, None, b""),
              ("TestnetRiskCollateral", token, "mint(address,uint256)", word(buyer) + word(100000000)),
              ("TestnetRiskCollateral", token, "mint(address,uint256)", word(seller) + word(100000000)),
              ("TestnetRiskSmoke", smoke, "fund()", b""), ("BookRiskEngine", engine, "activateMarket()", b""),
              ("TestnetRiskSmoke", smoke, trade_signature, None),
              ("TestnetResolutionAuthority", authority, "halt()", b""),
              ("TestnetResolutionAuthority", authority, "finalize(uint8)", word(1)),
              ("TestnetRiskSmoke", smoke, "completeSettlement()", b"")]
    previous_location, previous_nonce = (-1, -1), -1
    for transaction_hash, (name, target, signature, argument) in zip(hashes, phases):
        transaction = rpc.call("eth_getTransactionByHash", [transaction_hash])
        receipt = rpc.call("eth_getTransactionReceipt", [transaction_hash])
        helper.require(isinstance(transaction, dict) and isinstance(receipt, dict), "Transaction is pending or absent")
        helper.require(transaction["hash"].lower() == receipt["transactionHash"].lower() == transaction_hash
                       and helper.address(transaction["from"]) == helper.address(receipt["from"]) == controller
                       and helper.quantity(transaction["chainId"], "transaction chain") == 10143
                       and helper.quantity(receipt["status"], "receipt status") == 1
                       and helper.quantity(transaction["value"], "transaction value") == 0, "Wrong or failed smoke transaction")
        location = (helper.quantity(receipt["blockNumber"], "receipt block"),
                    helper.quantity(receipt["transactionIndex"], "receipt index"))
        nonce = helper.quantity(transaction["nonce"], "nonce")
        helper.require(previous_location < location and previous_nonce < nonce and location[0] <= block_number
                       and transaction["blockHash"] == receipt["blockHash"]
                       and helper.quantity(transaction["blockNumber"], "transaction block") == location[0], "Wrong receipt order or block")
        previous_location, previous_nonce = location, nonce
        canonical = rpc.call("eth_getBlockByNumber", [receipt["blockNumber"], False])
        helper.require(canonical["hash"] == receipt["blockHash"], "Noncanonical receipt block")
        gas_limit, gas_used = (helper.quantity(transaction["gas"], "gas limit"), helper.quantity(receipt["gasUsed"], "gas used"))
        helper.require(0 < gas_used <= gas_limit <= helper.LIMITS["transaction_gas"], "Invalid gas allowance")
        data = helper.hex_bytes(transaction["input"], "transaction input")
        if target is None:
            creation = helper.hex_bytes(artifact(name)["bytecode"]["object"], "smoke initcode")
            helper.require(transaction.get("to") is None and receipt.get("to") is None
                           and helper.address(receipt["contractAddress"]) == smoke
                           and len(data) <= helper.LIMITS["initcode_bytes"]
                           and data == creation + word(engine) + word(controller), "Smoke deployment mismatch")
        else:
            prefix = helper.selector(artifact(name), signature)
            helper.require(helper.address(transaction["to"]) == helper.address(receipt["to"]) == target
                           and receipt.get("contractAddress") is None
                           and (data.startswith(prefix) and len(data) > 4 if argument is None else data == prefix + argument),
                           "Wrong smoke phase calldata or target")
        report["transactions"].append({"hash": transaction_hash, "phase": signature or "CREATE TestnetRiskSmoke",
                                       "block_number": location[0], "block_hash": receipt["blockHash"], "status": 1,
                                       "gas_limit": gas_limit, "gas_used": gas_used,
                                       "effective_gas_price_wei": helper.quantity(receipt["effectiveGasPrice"], "gas price")})
    helper.require(rpc.call("eth_getBlockByNumber", [block["number"], False])["hash"] == block["hash"],
                   "Observed block changed during verification")
    report["status"] = "verified_completed_testnet_smoke"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-env", default="ETH_RPC_URL")
    for name in ("smoke", "controller", "engine"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--receipts", type=Path, required=True, help="Ordered JSON array of nine transaction hashes")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-log", type=Path, action="append", default=[])
    parser.add_argument("--timeout", type=float, default=30)
    arguments = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", arguments.rpc_env):
        parser.error("--rpc-env must name an environment variable")
    protected = {Path(__file__).resolve(), HELPER_PATH.resolve(), arguments.receipts.resolve()}
    protected.update(path.resolve() for path in arguments.run_log)
    protected.update(helper.artifact_path(name).resolve() for name in helper.CONTRACTS)
    if arguments.output.resolve() in protected:
        parser.error("--output cannot overwrite a script, receipt list, artifact or run log")
    report = {"schema": "eros-monad-smoke-verification/1", "status": "failed", "broadcast_by_verifier": False,
              "observed_at_utc": datetime.now(timezone.utc).isoformat(), "rpc_env": arguments.rpc_env,
              "limitations": ["Trusted RPC observation is not independent chain authentication or finality",
                              "Exact artifact matching does not independently reproduce source or prove build freshness",
                              "Mock collateral and signed synthetic index are not production collateral or a live feed",
                              "Source state confirms ingress acceptance; this verifier does not independently recover signatures",
                              "Runtime digests are SHA-256, not Ethereum EXTCODEHASH; immutable AST IDs are not named",
                              "No gate acceptance, economic safety certification, deployment authorization or peer review is granted"]}
    try:
        report["source_head"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=helper.ROOT).decode().strip()
        report["working_tree_dirty"] = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=helper.ROOT))
        report["verifier_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        report["run_logs"] = [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in arguments.run_log]
        verify(arguments, report)
    except helper.VerificationError as error:
        report["error"] = str(error)
    except (OSError, ValueError, TypeError, KeyError, StopIteration, AttributeError, subprocess.SubprocessError):
        report["error"] = "Malformed or unavailable local input or RPC data"
    content = json.dumps(report, indent=2) + "\n"
    try:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(content, encoding="utf-8", newline="\n")
    except OSError:
        print("Cannot write verification report", file=sys.stderr)
        return 1
    print(content, end="")
    return 0 if report["status"] == "verified_completed_testnet_smoke" else 1


if __name__ == "__main__":
    raise SystemExit(main())
