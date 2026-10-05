"""Reconcile local script evidence with canonical RPC receipts, never public networks."""
import importlib.util
import json
from pathlib import Path
import sys

SPEC = importlib.util.spec_from_file_location("local_stack", Path(__file__).with_name("local-stack.py"))
STACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STACK)


def verify_receipts(rpc, receipts):
    if not receipts:
        raise RuntimeError("Missing transaction receipts")
    canonical = []
    seen = set()
    for receipt in receipts:
        transaction_hash = receipt.get("transactionHash", receipt.get("hash"))
        if not transaction_hash or transaction_hash in seen:
            raise RuntimeError("Missing or duplicate transaction hash")
        seen.add(transaction_hash)
        actual = STACK.rpc_call(rpc, "eth_getTransactionReceipt", [transaction_hash])
        if not actual or actual["blockHash"] != receipt["blockHash"] or actual["status"] != "0x1":
            raise RuntimeError("Receipt is not a successful canonical transaction")
        block = STACK.rpc_call(rpc, "eth_getBlockByNumber", [actual["blockNumber"], False])
        if not block or block["hash"] != actual["blockHash"]:
            raise RuntimeError("Receipt block is no longer canonical")
        transaction = STACK.rpc_call(rpc, "eth_getTransactionByHash", [transaction_hash])
        if not transaction or int(actual["gasUsed"], 16) > 30_000_000 or int(transaction["gas"], 16) > 30_000_000:
            raise RuntimeError("Local transaction exceeded the intended gas cap")
        canonical.append({"hash": actual["transactionHash"], "blockNumber": int(actual["blockNumber"], 16),
                          "blockHash": actual["blockHash"], "gasUsed": int(actual["gasUsed"], 16), "gasLimit": int(transaction["gas"], 16)})
    return canonical


def verify_leveraged_positions(snapshot):
    demo = next(market for market in snapshot["markets"] if market["name"] == "demo")
    accounts = {account["name"]: account["risk"] for account in demo["accounts"]}
    for name, lots, cash in [("leveragedLong", 100_000, -40 * 10**24), ("leveragedShort", -100_000, 60 * 10**24)]:
        actual = accounts.get(name)
        if not actual or int(actual["positionLots"]) != lots or int(actual["cashQ"]) != cash:
            raise RuntimeError("Mined leveraged positions do not match the funded 5x trade")
    if demo["reserveCoverage"]["recoveryEnabled"] is not False:
        raise RuntimeError("Leveraged fixture unexpectedly enabled payout recovery")


def main():
    directory = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(json.loads(STACK.LATEST.read_text())["directory"])
    runtime = json.loads((directory / "runtime.json").read_text())
    rpc = runtime["rpcUrl"]
    if int(STACK.rpc_call(rpc, "eth_chainId"), 16) != 31337:
        raise RuntimeError("Local chain required")
    contracts = json.loads((directory / "contracts.json").read_text())
    expected = {
        "deploy": (None, None),
        "trade-demo": ("placeOrder", contracts["markets"]["demo"]["engine"]),
        "trade-terminal": ("placeOrder", contracts["markets"]["terminal"]["engine"]),
        "begin-settlement": ("requestReduceOnly", contracts["markets"]["terminal"]["engine"]),
        "resolve-assertion": ("setResult", contracts["contracts"]["MockAssertionVenue"]["address"]),
        "claim": ("claimTrader", contracts["markets"]["terminal"]["engine"]),
    }
    verified = {}
    if runtime.get("scenario") == "leveraged":
        verify_leveraged_positions(json.loads((directory / "snapshot-final.json").read_text()))
        expected["fund-leveraged"] = ("mint", contracts["contracts"]["MockUSDC"]["address"])
        expected["trade-leveraged"] = ("placeOrder", contracts["markets"]["demo"]["engine"])
    for step, (function, target) in expected.items():
        record = json.loads((directory / f"{step}-receipts.json").read_text())
        if not record["transactions"] or len(record["transactions"]) != len(record["receipts"]):
            raise RuntimeError(f"Incomplete {step} broadcast")
        first = record["transactions"][0]
        if function is None:
            if first.get("transactionType") != "CREATE":
                raise RuntimeError("Deployment evidence is not contract creation")
        elif not str(first.get("function", "")).startswith(function + "(") or str(first["transaction"].get("to", "")).lower() != target.lower():
            raise RuntimeError(f"Wrong selector or target in {step} evidence")
        if {entry["hash"].lower() for entry in record["transactions"]} != {entry["transactionHash"].lower() for entry in record["receipts"]}:
            raise RuntimeError(f"Transaction/receipt identity mismatch in {step}")
        verified[step] = verify_receipts(rpc, record["receipts"])
    keeper = json.loads((directory / "keeper-report.json").read_text())
    keeper_receipts = verify_receipts(rpc, keeper["receipts"])
    upkeep = json.loads((directory / "upkeep-report.json").read_text()) if (directory / "upkeep-report.json").exists() else None
    upkeep_receipts = verify_receipts(rpc, upkeep["receipts"]) if upkeep and upkeep["receipts"] else []
    all_hashes = [row["hash"] for rows in [*verified.values(), keeper_receipts, upkeep_receipts] for row in rows]
    if len(all_hashes) != len(set(all_hashes)):
        raise RuntimeError("A transaction was counted in multiple evidence steps")
    summary = {"scope": "local-only", "chainId": 31337, "canonicalScriptReceipts": sum(len(rows) for rows in verified.values()),
               "canonicalKeeperReceipts": len(keeper["receipts"]), "maxScriptGasLimit": max(row["gasLimit"] for rows in verified.values() for row in rows),
               "canonicalUpkeepReceipts": len(upkeep_receipts), "scriptSteps": verified, "keeperReceipts": keeper_receipts,
               "upkeepReceipts": upkeep_receipts, "publicTransactions": 0, "passed": True}
    STACK.write_json(directory / "receipt-audit.json", summary)
    print(json.dumps({name: value for name, value in summary.items() if name not in {"scriptSteps", "keeperReceipts", "upkeepReceipts"}}, indent=2))


if __name__ == "__main__":
    main()
