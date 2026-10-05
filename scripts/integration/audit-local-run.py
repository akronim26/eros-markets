"""Reconcile local script evidence with canonical RPC receipts, never public networks."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location("local_stack", Path(__file__).with_name("local-stack.py"))
STACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STACK)

SDK_OWNER = "0xdd2fd4581271e230360230f9337d5c0430bf44c0"  # Disposable Anvil actor 18.
PAID_TOPIC = "0x9def4e2802183d68ce90a6a226a2962b59298616c27165f12c4fbc5c84cdd778"


def quantity(value):
    if isinstance(value, bool):
        raise RuntimeError("Invalid receipt integer")
    if isinstance(value, int):
        return value
    return int(value, 16 if value.startswith("0x") else 10)


def word(value):
    return f"{int(value, 16) if isinstance(value, str) and value.startswith('0x') else int(value):064x}"


def verify_receipts(rpc, receipts):
    if not receipts:
        raise RuntimeError("Missing transaction receipts")
    canonical = []
    seen = set()
    for receipt in receipts:
        transaction_hash = receipt.get("transactionHash", receipt.get("hash"))
        if not transaction_hash or transaction_hash.lower() in seen:
            raise RuntimeError("Missing or duplicate transaction hash")
        seen.add(transaction_hash.lower())
        actual = STACK.rpc_call(rpc, "eth_getTransactionReceipt", [transaction_hash])
        if not actual or actual["transactionHash"].lower() != transaction_hash.lower() or actual["blockHash"].lower() != receipt["blockHash"].lower() or actual["status"] != "0x1":
            raise RuntimeError("Receipt is not a successful canonical transaction")
        block = STACK.rpc_call(rpc, "eth_getBlockByNumber", [actual["blockNumber"], False])
        if not block or block["hash"] != actual["blockHash"]:
            raise RuntimeError("Receipt block is no longer canonical")
        transaction = STACK.rpc_call(rpc, "eth_getTransactionByHash", [transaction_hash])
        if not transaction or int(actual["gasUsed"], 16) > 30_000_000 or int(transaction["gas"], 16) > 30_000_000:
            raise RuntimeError("Local transaction exceeded the intended gas cap")
        if (("blockNumber" in receipt and quantity(receipt["blockNumber"]) != quantity(actual["blockNumber"]))
                or ("gasUsed" in receipt and quantity(receipt["gasUsed"]) != quantity(actual["gasUsed"]))
                or ("gas" in receipt and quantity(receipt["gas"]) != quantity(transaction["gas"]))):
            raise RuntimeError("Reported receipt metadata differs from canonical RPC")
        if "gasLimit" in receipt and quantity(receipt["gasLimit"]) != quantity(transaction["gas"]):
            raise RuntimeError("Reported gas limit differs from canonical RPC")
        canonical.append({"hash": actual["transactionHash"], "blockNumber": int(actual["blockNumber"], 16),
                          "blockHash": actual["blockHash"], "gasUsed": int(actual["gasUsed"], 16), "gasLimit": int(transaction["gas"], 16)})
    return canonical


def verify_upkeep_batches(directory, contracts, upkeep):
    if not contracts['contracts'].get('RolloverBatcher'):
        if any(entry.get('action') == 'rollover' or entry.get('rolloverBatch') for entry in upkeep['receipts']):
            raise RuntimeError('Upkeep used a helper absent from its deployment')
        return None
    if any(entry.get('action') in ['beginRollover', 'rollPage', 'finishRollover'] for entry in upkeep['receipts']):
        raise RuntimeError('Enrolled helper proof used the legacy rollover path')
    output = directory / 'rollover-batch-audit.json'
    if not output.exists():
        bun = os.environ.get('LOCAL_BUN') or shutil.which('bun')
        if not bun:
            raise RuntimeError('Bun is required for the canonical rollover batch audit')
        oracle = Path(__file__).resolve().parents[2] / 'oracle'
        result = subprocess.run([bun, '--no-env-file', 'services/local-integration/src/audit-rollover.ts',
                                 str(directory / 'manifest.json'), str(directory / 'upkeep-report.json'), str(output)],
                                cwd=oracle, capture_output=True, text=True, timeout=600,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (directory / 'rollover-batch-audit.log').write_text(result.stdout + result.stderr, encoding='utf-8')
        if result.returncode:
            raise RuntimeError('Canonical rollover batch audit failed; inspect rollover-batch-audit.log')
    audit = json.loads(output.read_text())
    if (audit.get('mode') != 'LOCAL_ROLLOVER_BATCH_AUDIT' or audit.get('passed') is not True
            or audit.get('chainId') != 31337 or audit.get('publicTransactions') != 0):
        raise RuntimeError('Invalid canonical rollover batch audit')
    for name, filename in [('manifest', 'manifest.json'), ('upkeep', 'upkeep-report.json')]:
        if audit['inputSha256'][name] != hashlib.sha256((directory / filename).read_bytes()).hexdigest():
            raise RuntimeError('Rollover audit inputs changed after verification')
    expected = {entry['hash'].lower() for entry in upkeep['receipts'] if entry.get('action') == 'rollover'}
    actual = [entry['hash'].lower() for entry in audit['batches']]
    if not expected or expected != set(actual) or len(actual) != len(set(actual)):
        raise RuntimeError('Rollover audit receipt set mismatch')
    return audit


def sdk_recipe(contracts, phase):
    token = contracts["contracts"]["MockUSDC"]["address"].lower()
    vault = contracts["contracts"]["CollateralVault"]["address"].lower()
    engine = contracts["markets"]["terminal"]["engine"].lower()
    if phase == "claim":
        return [("claim", vault, "0x21c0b342" + word(engine) + word(SDK_OWNER))]
    place = lambda tick: "0xd4cc35a2" + "".join(word(value) for value in [2, 1, 0, tick, 1000, 8, 0])
    return [
        ("mint", token, "0x40c10f19" + word(SDK_OWNER) + word(11_000_000)),
        ("approve", token, "0x095ea7b3" + word(vault) + word(11_000_000)),
        ("deposit", vault, "0xb6b55f25" + word(11_000_000)),
        ("allocate", vault, "0x6ca163de" + word(engine) + word(6_000_000) + word(0)),
        ("placeOrder", engine, place(499)),
        ("cancel", engine, None),
        ("placeOrder", engine, place(498)),
        ("cancelAll", engine, "0x18cb2b18"),
        ("release", engine, "0x37bdc99b" + word(5_000_000)),
        ("withdraw", vault, "0x2e1a7d4d" + word(10_000_000)),
    ]


def verify_sdk_report(rpc, contracts, report, phase):
    if (report.get("scope") != "local-only" or report.get("chainId") != 31337 or report.get("phase") != phase
            or report.get("passed") is not True or report.get("owner", "").lower() != SDK_OWNER):
        raise RuntimeError("Invalid SDK owner or report scope")
    recipe = sdk_recipe(contracts, phase)
    receipts = report.get("receipts", [])
    if len(receipts) != len(recipe):
        raise RuntimeError("Incomplete SDK lifecycle receipts")
    canonical = verify_receipts(rpc, receipts)
    for index, (receipt, (operation, target, calldata)) in enumerate(zip(receipts, recipe)):
        transaction = STACK.rpc_call(rpc, "eth_getTransactionByHash", [receipt["transactionHash"]])
        actual = STACK.rpc_call(rpc, "eth_getTransactionReceipt", [receipt["transactionHash"]])
        data = str(transaction.get("input", "")).lower()
        if (receipt.get("operation") != operation or receipt.get("from", "").lower() != SDK_OWNER
                or receipt.get("to", "").lower() != target or receipt.get("status") != "success"
                or transaction.get("from", "").lower() != SDK_OWNER or transaction.get("to", "").lower() != target
                or quantity(transaction["nonce"]) != (index if phase == "prepare" else 10)):
            raise RuntimeError("SDK sender, target or operation mismatch")
        if calldata is None:
            if not data.startswith("0x1381e400") or len(data) != 74 or not 0 < int(data[10:], 16) <= 0xffffffff:
                raise RuntimeError("Invalid SDK cancellation calldata")
        elif data != calldata:
            raise RuntimeError("SDK canonical calldata mismatch")
        if phase == "claim":
            engine = contracts["markets"]["terminal"]["engine"].lower()
            paid = [log for log in actual.get("logs", []) if log["address"].lower() == target
                    and [topic.lower() for topic in log["topics"]] == [PAID_TOPIC, "0x" + word(engine), "0x" + word(SDK_OWNER)]
                    and log["data"].lower() == "0x" + word(1_000_000)]
            if len(paid) != 1:
                raise RuntimeError("SDK claim has no canonical direct-owner Paid event")
    snapshot_block = quantity(report["block"]["number"])
    block = STACK.rpc_call(rpc, "eth_getBlockByNumber", [hex(snapshot_block), False])
    if (not block or block["hash"].lower() != report["block"]["hash"].lower()
            or snapshot_block < max(row["blockNumber"] for row in canonical)):
        raise RuntimeError("SDK account snapshot block is not canonical")
    token = contracts["contracts"]["MockUSDC"]["address"]
    vault = contracts["contracts"]["CollateralVault"]["address"]
    engine = contracts["markets"]["terminal"]["engine"]

    def read(address, data):
        value = STACK.rpc_call(rpc, "eth_call", [{"to": address, "data": data}, hex(snapshot_block)])
        if not isinstance(value, str) or len(value) < 66 or (len(value) - 2) % 64:
            raise RuntimeError("Invalid SDK account read")
        return [int(value[start:start + 64], 16) for start in range(2, len(value), 64)]

    wallet_atoms = read(token, "0x70a08231" + word(SDK_OWNER))[0]
    free_atoms = read(vault, "0x52ecb1ef" + word(SDK_OWNER))[0]
    claim_atoms = read(vault, "0x4c13a47c" + word(engine) + word(SDK_OWNER))[0]
    trader = read(engine, "0x1e10b4d4" + word(SDK_OWNER))[0]
    account = report["account"]
    if (trader == 0 or account["owner"].lower() != SDK_OWNER or quantity(account["trader"]) != trader
            or wallet_atoms != (10_000_000 if phase == "prepare" else 11_000_000) or free_atoms != 0 or claim_atoms != 0
            or quantity(account["walletAtoms"]) != wallet_atoms or quantity(account["freeAtoms"]) != free_atoms
            or quantity(account["claimAtoms"]) != claim_atoms):
        raise RuntimeError("SDK canonical owner balances mismatch")
    risk = read(engine, "0xc89e5819" + word(trader))
    signed = lambda value: value - (1 << 256) if value >= 1 << 255 else value
    if (len(risk) < 5 or signed(risk[4]) != 0 or quantity(account["risk"]["positionLots"]) != 0
            or quantity(account["risk"]["cashQ"]) != signed(risk[3])
            or (phase == "prepare" and signed(risk[3]) != 10**24)):
        raise RuntimeError("SDK canonical account risk mismatch")
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


def verify_leveraged_settlement(rpc, contracts, before, after, claim_broadcast, keeper_receipts):
    """Recompute NO claims from immutable frozen accounts and actual owner receipts."""
    engine = contracts["markets"]["demo"]["engine"].lower()
    vault = contracts["contracts"]["CollateralVault"]["address"].lower()
    token = contracts["contracts"]["MockUSDC"]["address"].lower()
    owners = {
        "buyer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "seller": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
        "leveragedLong": "0x1cbd3b2770909d4e10f157cabc84c7264073c9ec",
        "leveragedShort": "0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097",
    }
    expected_lots = dict(zip(owners, (10_000, -10_000, 100_000, -100_000)))
    checkpoints = []
    for snapshot in (before, after):
        height = quantity(snapshot["block"]["number"])
        block = STACK.rpc_call(rpc, "eth_getBlockByNumber", [hex(height), False])
        if not block or block["hash"].lower() != snapshot["block"]["hash"].lower():
            raise RuntimeError("Leveraged settlement snapshot is not canonical")
        checkpoints.append(height)
    if checkpoints[0] >= checkpoints[1]:
        raise RuntimeError("Leveraged settlement snapshots are out of order")

    def read(target, data, height):
        value = STACK.rpc_call(rpc, "eth_call", [{"to": target, "data": data}, hex(height)])
        if not value.startswith("0x") or (len(value) - 2) % 64 or len(value) <= 2:
            raise RuntimeError("Malformed settlement contract read")
        return [int(value[start:start + 64], 16) for start in range(2, len(value), 64)]

    signed = lambda value: value - (1 << 256) if value >= 1 << 255 else value
    stages = [next(m for m in snapshot["markets"] if m["name"] == "demo") for snapshot in (before, after)]
    states = [read(engine, "0x1ce63bbc", height) for height in checkpoints]
    for state in states:
        if len(state) != 15 or state[2] != 1 or state[3] != 1 or state[5] != 0 or state[9] != 4 or state[12:15] != [1, 1, 0]:
            raise RuntimeError("Leveraged NO settlement is not fully prepared without recovery")
    if states[0][0] != 3 or states[1][0] != 4:
        raise RuntimeError("Leveraged claims did not complete")
    claims = {}
    deficit = dust = 0
    for name, owner in owners.items():
        frozen = read(engine, "0xd0516650" + word(owner), checkpoints[0])
        if len(frozen) != 2 or signed(frozen[0]) != expected_lots[name]:
            raise RuntimeError("Leveraged frozen exposure mismatch")
        equity = signed(frozen[1])  # Final NO price is zero; funding/premiums are already frozen.
        claim = max(equity, 0) // 10**18
        deficit += max(-equity, 0)
        dust += max(equity, 0) % 10**18
        claims[owner] = claim
        wallet_values = []
        for index, (stage, height) in enumerate(zip(stages, checkpoints)):
            account = next(a for a in stage["accounts"] if a["name"] == name)
            if account["owner"].lower() != owner:
                raise RuntimeError("Leveraged claim owner changed")
            wallet = read(token, "0x70a08231" + word(owner), height)[0]
            escrow = read(vault, "0x4c13a47c" + word(engine) + word(owner), height)[0]
            if (quantity(account["walletAtoms"]) != wallet or quantity(account["claimAtoms"]) != escrow
                    or escrow != (claim if index == 0 else 0)):
                raise RuntimeError("Leveraged canonical owner claim mismatch")
            wallet_values.append(wallet)
        if wallet_values[1] - wallet_values[0] != claim:
            raise RuntimeError("Leveraged owner did not receive the full payout")
    if deficit < 40 * 10**24 or claims[owners["leveragedLong"]] != 0 or claims[owners["leveragedShort"]] <= 59_000_000:
        raise RuntimeError("Leveraged bad-debt scenario was not exercised")
    residual = read(engine, "0x9c793af9", checkpoints[1])[0]
    reserve_value = read(engine, "0xefe6980a", checkpoints[1])
    if len(reserve_value) != 2 or signed(reserve_value[0]) != 0 or residual >= read(engine, "0x477b6f9e", checkpoints[1])[0]:
        raise RuntimeError("Leveraged reserve seed loss was not exercised")
    frozen_reserve = signed(reserve_value[1])
    if residual + deficit != frozen_reserve + dust:
        raise RuntimeError("Reserve residual does not reconcile with frozen trader deficits")
    for state, stage in zip(states, stages):
        if state[11] != deficit or quantity(stage["settlement"]["totalDeficitQ"]) != deficit or state[10] != sum(claims.values()):
            raise RuntimeError("Frontend deficit/payout reporting differs from frozen ledger")
    market_atoms = read(vault, "0xa704e33a" + word(engine), checkpoints[1])[0]
    debit_q = read(vault, "0x6185798e" + word(engine), checkpoints[1])[0]
    if market_atoms * 10**18 - debit_q != residual:
        raise RuntimeError("Final reserve custody does not reconcile")
    if read(token, "0x70a08231" + word(vault), checkpoints[1])[0] < read(vault, "0x94313932", checkpoints[1])[0]:
        raise RuntimeError("Settlement vault custody deficit")

    paid_owners = set()
    for row in claim_broadcast["receipts"]:
        receipt = STACK.rpc_call(rpc, "eth_getTransactionReceipt", [row["transactionHash"]])
        tx = STACK.rpc_call(rpc, "eth_getTransactionByHash", [row["transactionHash"]])
        owner = tx["from"].lower()
        if (owner not in claims or not claims[owner] or owner in paid_owners or tx["to"].lower() != engine
                or tx["input"].lower() != "0xb1f6959c" + word(owner) or quantity(tx["value"]) != 0
                or not checkpoints[0] < quantity(receipt["blockNumber"]) <= checkpoints[1]):
            raise RuntimeError("Leveraged claims must be distinct direct-owner transactions")
        paid = [log for log in receipt["logs"] if log["address"].lower() == vault
                and [topic.lower() for topic in log["topics"]] == [PAID_TOPIC, "0x" + word(engine), "0x" + word(owner)]
                and log["data"].lower() == "0x" + word(claims[owner])]
        if len(paid) != 1:
            raise RuntimeError("Leveraged owner payout event mismatch")
        paid_owners.add(owner)
    if paid_owners != {owner for owner, amount in claims.items() if amount}:
        raise RuntimeError("Missing leveraged owner payout")
    event_topic = "0x347a378a068fbbe495bd8612faa361487aeff3a52d82e40a28d048fc4ef70ac0"
    events = []
    for row in keeper_receipts:
        receipt = STACK.rpc_call(rpc, "eth_getTransactionReceipt", [row["hash"]])
        events.extend(log for log in receipt["logs"] if log["address"].lower() == engine and log["topics"][0].lower() == event_topic)
    if len(events) != 1:
        raise RuntimeError("Missing unique leveraged ClaimsEnabled event")
    if ([topic.lower() for topic in events[0]["topics"]] != [event_topic, contracts["markets"]["demo"]["marketId"].lower()]
            or states[0][6] != states[1][6]):
        raise RuntimeError("ClaimsEnabled market/snapshot binding mismatch")
    fields = [int(events[0]["data"][start:start + 64], 16) for start in range(2, len(events[0]["data"]), 64)]
    contribution = max(deficit - dust, 0) // 10**18
    if len(fields) != 5 or fields != [states[0][6], 1, 0, sum(claims.values()), contribution]:
        raise RuntimeError("ClaimsEnabled misreports the payout or reserve contribution")
    for height, snapshot in zip(checkpoints, (before, after)):
        block = STACK.rpc_call(rpc, "eth_getBlockByNumber", [hex(height), False])
        if not block or block["hash"].lower() != snapshot["block"]["hash"].lower():
            raise RuntimeError("Leveraged settlement checkpoint changed during audit")
    return {"passed": True, "outcome": "NO", "totalDeficitQ": str(deficit), "reserveContributionAtoms": str(contribution),
            "reserveResidualQ": str(residual), "fullOwnerClaimsAtoms": {owner: str(amount) for owner, amount in claims.items()},
            "claimableBlock": checkpoints[0], "completeBlock": checkpoints[1], "source": "canonical frozen accounts, custody and direct-owner receipts"}


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
    if runtime.get("settleLeveraged"):
        expected.update({"begin-leveraged-settlement": ("requestReduceOnly", contracts["markets"]["demo"]["engine"]),
                         "resolve-leveraged-assertion": ("setResult", contracts["contracts"]["MockAssertionVenue"]["address"]),
                         "claim-leveraged": ("claimTrader", contracts["markets"]["demo"]["engine"])})
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
    settlement_proof = None
    leveraged_keeper_receipts = []
    if runtime.get("settleLeveraged"):
        extra_keeper = json.loads((directory / "keeper-leveraged-report.json").read_text())
        if extra_keeper.get("target") != "demo":
            raise RuntimeError("Leveraged keeper targeted the wrong market")
        leveraged_keeper_receipts = verify_receipts(rpc, extra_keeper["receipts"])
        settlement_proof = verify_leveraged_settlement(rpc, contracts,
            json.loads((directory / "snapshot-claimable.json").read_text()), json.loads((directory / "snapshot-settled.json").read_text()),
            json.loads((directory / "claim-leveraged-receipts.json").read_text()), leveraged_keeper_receipts)
    upkeep = json.loads((directory / "upkeep-report.json").read_text()) if (directory / "upkeep-report.json").exists() else None
    upkeep_receipts = verify_receipts(rpc, upkeep["receipts"]) if upkeep and upkeep["receipts"] else []
    rollover_proof = verify_upkeep_batches(directory, contracts, upkeep) if upkeep_receipts else None
    sdk_paths = {phase: directory / f"sdk-{phase}.json" for phase in ["prepare", "claim"]}
    sdk_receipts = {}
    if runtime.get("sdkSmoke") or any(path.exists() for path in sdk_paths.values()):
        if not all(path.exists() for path in sdk_paths.values()):
            raise RuntimeError("Missing SDK prepare or claim report")
        reports = {phase: json.loads(path.read_text()) for phase, path in sdk_paths.items()}
        if quantity(reports["prepare"]["block"]["number"]) >= quantity(reports["claim"]["block"]["number"]):
            raise RuntimeError("SDK lifecycle phases are out of order")
        sdk_receipts = {phase: verify_sdk_report(rpc, contracts, report, phase) for phase, report in reports.items()}
    all_hashes = [row["hash"].lower() for rows in [*verified.values(), keeper_receipts, leveraged_keeper_receipts, upkeep_receipts, *sdk_receipts.values()] for row in rows]
    if len(all_hashes) != len(set(all_hashes)):
        raise RuntimeError("A transaction was counted in multiple evidence steps")
    summary = {"scope": "local-only", "chainId": 31337, "canonicalScriptReceipts": sum(len(rows) for rows in verified.values()),
               "canonicalKeeperReceipts": len(keeper["receipts"]), "maxScriptGasLimit": max(row["gasLimit"] for rows in verified.values() for row in rows),
               "canonicalUpkeepReceipts": len(upkeep_receipts), "scriptSteps": verified, "keeperReceipts": keeper_receipts,
               "upkeepReceipts": upkeep_receipts, "canonicalSdkReceipts": sum(len(rows) for rows in sdk_receipts.values()),
               "sdkReceipts": sdk_receipts, "canonicalLeveragedKeeperReceipts": len(leveraged_keeper_receipts),
               "leveragedKeeperReceipts": leveraged_keeper_receipts, "leveragedSettlement": settlement_proof,
               "rolloverBatches": rollover_proof, "publicTransactions": 0, "passed": True}
    STACK.write_json(directory / "receipt-audit.json", summary)
    print(json.dumps({name: value for name, value in summary.items() if name not in {"scriptSteps", "keeperReceipts", "leveragedKeeperReceipts", "upkeepReceipts", "sdkReceipts"}}, indent=2))


if __name__ == "__main__":
    main()
