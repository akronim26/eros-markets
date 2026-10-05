import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("local_audit", Path(__file__).with_name("audit-local-run.py"))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class RolloverAuditBindingTests(unittest.TestCase):
    def test_legacy_manifests_do_not_claim_helper_evidence(self):
        contracts = {'contracts': {}}
        self.assertIsNone(audit.verify_upkeep_batches(Path('.'), contracts, {'receipts': [{'action': 'rollPage'}]}))
        with self.assertRaisesRegex(RuntimeError, 'absent'):
            audit.verify_upkeep_batches(Path('.'), contracts, {'receipts': [{'action': 'rollover'}]})

    def test_enrolled_helper_rejects_legacy_actions(self):
        with self.assertRaisesRegex(RuntimeError, 'legacy'):
            audit.verify_upkeep_batches(Path('.'), {'contracts': {'RolloverBatcher': {'address': 'fixture'}}},
                                        {'receipts': [{'action': 'beginRollover'}]})

    def test_cached_canonical_audit_binds_both_inputs_and_exact_receipt_set(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            report = {'receipts': [{'hash': '0x11', 'action': 'rollover'}]}
            (path / 'manifest.json').write_text('{}')
            (path / 'upkeep-report.json').write_text(json.dumps(report))
            result = {'mode': 'LOCAL_ROLLOVER_BATCH_AUDIT', 'passed': True, 'chainId': 31337, 'publicTransactions': 0,
                      'inputSha256': {name: hashlib.sha256((path / filename).read_bytes()).hexdigest()
                                      for name, filename in [('manifest', 'manifest.json'), ('upkeep', 'upkeep-report.json')]},
                      'batches': [{'hash': '0x11'}]}
            contracts = {'contracts': {'RolloverBatcher': {'address': 'fixture'}}}
            output = path / 'rollover-batch-audit.json'
            output.write_text(json.dumps(result))
            self.assertEqual(audit.verify_upkeep_batches(path, contracts, report), result)
            result['batches'].append({'hash': '0x11'})
            output.write_text(json.dumps(result))
            with self.assertRaisesRegex(RuntimeError, 'receipt set'):
                audit.verify_upkeep_batches(path, contracts, report)
            result['batches'].pop()
            output.write_text(json.dumps(result))
            (path / 'manifest.json').write_text('{"changed":true}')
            with self.assertRaisesRegex(RuntimeError, 'inputs changed'):
                audit.verify_upkeep_batches(path, contracts, report)


class ReceiptAuditTests(unittest.TestCase):
    def test_verifies_mined_positions_instead_of_trusting_script_simulation(self):
        snapshot = {"markets": [{"name": "demo", "reserveCoverage": {"recoveryEnabled": False}, "accounts": [
            {"name": "leveragedLong", "risk": {"positionLots": "100000", "cashQ": str(-40 * 10**24)}},
            {"name": "leveragedShort", "risk": {"positionLots": "-100000", "cashQ": str(60 * 10**24)}},
        ]}]}
        audit.verify_leveraged_positions(snapshot)
        snapshot["markets"][0]["accounts"][0]["risk"]["positionLots"] = "0"
        with self.assertRaisesRegex(RuntimeError, "Mined leveraged positions"):
            audit.verify_leveraged_positions(snapshot)

    def setUp(self):
        self.receipt = {"transactionHash": "0x11", "blockHash": "0x22", "blockNumber": "0x3", "status": "0x1", "gasUsed": "0x5208"}
        self.block = {"hash": "0x22"}
        self.transaction = {"gas": "0x7530"}

    def rpc(self, _endpoint, method, _params):
        return {"eth_getTransactionReceipt": self.receipt, "eth_getBlockByNumber": self.block,
                "eth_getTransactionByHash": self.transaction}[method]

    def test_validates_mined_receipt_and_block_and_keeps_integer_gas(self):
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc):
            result = audit.verify_receipts("http://127.0.0.1:18546", [self.receipt.copy()])
        self.assertEqual(result[0]["gasUsed"], 21000)
        self.assertEqual(result[0]["gasLimit"], 30000)
        self.assertEqual(result[0]["blockNumber"], 3)

    def test_rejects_missing_and_duplicate_receipts(self):
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc):
            with self.assertRaisesRegex(RuntimeError, "Missing"):
                audit.verify_receipts("http://127.0.0.1:18546", [])
            with self.assertRaisesRegex(RuntimeError, "duplicate"):
                audit.verify_receipts("http://127.0.0.1:18546", [self.receipt, self.receipt])

    def test_rejects_receipts_from_replaced_blocks(self):
        self.block["hash"] = "0xff"
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc), self.assertRaisesRegex(RuntimeError, "no longer canonical"):
            audit.verify_receipts("http://127.0.0.1:18546", [self.receipt])

    def test_rejects_reverted_transactions(self):
        self.receipt["status"] = "0x0"
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc), self.assertRaisesRegex(RuntimeError, "successful canonical"):
            audit.verify_receipts("http://127.0.0.1:18546", [self.receipt])

    def test_rejects_transactions_above_network_gas_cap(self):
        self.transaction["gas"] = hex(30_000_001)
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc), self.assertRaisesRegex(RuntimeError, "gas cap"):
            audit.verify_receipts("http://127.0.0.1:18546", [self.receipt])

    def test_rejects_rpc_receipt_substitution_and_forged_reported_gas_or_block(self):
        for field, value in [("transactionHash", "0xff"), ("blockNumber", "0x4"), ("gasUsed", "0x1"), ("gas", "999999")]:
            report = {**self.receipt, field: value}
            with self.subTest(field=field), patch.object(audit.STACK, "rpc_call", side_effect=self.rpc), self.assertRaises(RuntimeError):
                audit.verify_receipts("http://127.0.0.1:18546", [report])


class SdkReceiptAuditTests(unittest.TestCase):
    def fixture(self, phase="prepare"):
        self.contracts = {"contracts": {"MockUSDC": {"address": "0x" + "aa" * 20}, "CollateralVault": {"address": "0x" + "bb" * 20}},
                          "markets": {"terminal": {"engine": "0x" + "cc" * 20}}}
        self.receipts = {}
        self.transactions = {}
        reports = []
        for index, (operation, target, data) in enumerate(audit.sdk_recipe(self.contracts, phase)):
            number = index + (1 if phase == "prepare" else 20)
            tx_hash = "0x" + audit.word(number)
            block_hash = "0x" + audit.word(number + 100)
            actual = {"transactionHash": tx_hash, "blockHash": block_hash, "blockNumber": hex(number), "status": "0x1", "gasUsed": hex(21000), "logs": []}
            self.receipts[tx_hash] = actual
            self.transactions[tx_hash] = {"hash": tx_hash, "gas": hex(30000), "from": audit.SDK_OWNER, "to": target,
                                          "input": data or "0x1381e400" + audit.word(99), "nonce": hex(index if phase == "prepare" else 10)}
            if phase == "claim":
                actual["logs"] = [{"address": target, "topics": [audit.PAID_TOPIC, "0x" + "0" * 24 + "cc" * 20, "0x" + audit.word(audit.SDK_OWNER)],
                                   "data": "0x" + audit.word(1_000_000)}]
            reports.append({**{name: actual[name] for name in ["transactionHash", "blockHash"]}, "blockNumber": str(number),
                            "gas": "30000", "gasUsed": "21000", "status": "success", "operation": operation, "from": audit.SDK_OWNER, "to": target})
        self.wallet = 10_000_000 if phase == "prepare" else 11_000_000
        self.cash = 10**24
        self.free = self.claim = 0
        self.report = {"scope": "local-only", "chainId": 31337, "phase": phase, "owner": audit.SDK_OWNER, "passed": True,
                       "receipts": reports, "block": {"number": "30", "hash": "0x" + audit.word(130)},
                       "account": {"owner": audit.SDK_OWNER, "trader": 1, "walletAtoms": str(self.wallet), "freeAtoms": "0", "claimAtoms": "0",
                                   "risk": {"cashQ": str(self.cash), "positionLots": "0"}}}
        return self.report

    def rpc(self, _endpoint, method, params):
        if method == "eth_getTransactionReceipt":
            return self.receipts[params[0]]
        if method == "eth_getTransactionByHash":
            return self.transactions[params[0]]
        if method == "eth_getBlockByNumber":
            return {"hash": "0x" + audit.word(int(params[0], 16) + 100)}
        if method == "eth_call":
            self.assertEqual(params[1], "0x1e", "owner reads must stay on the report's canonical block")
            selector = params[0]["data"][:10]
            words = {"0x70a08231": [self.wallet], "0x52ecb1ef": [self.free], "0x4c13a47c": [self.claim],
                     "0x1e10b4d4": [1], "0xc89e5819": [1, 1800000000, 0, self.cash, 0]}[selector]
            return "0x" + "".join(audit.word(value) for value in words)
        self.fail(f"Unexpected RPC method: {method}")

    def verify(self, phase="prepare"):
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc):
            return audit.verify_sdk_report("http://127.0.0.1:18546", self.contracts, self.report, phase)

    def test_prepare_and_claim_reconcile_actual_transactions_and_block_pinned_owner_balances(self):
        for phase, count in [("prepare", 10), ("claim", 1)]:
            self.fixture(phase)
            self.assertEqual(len(self.verify(phase)), count)

    def test_forged_success_missing_operations_and_wrong_owner_cannot_pass(self):
        for change in [lambda report: report.update(passed=False), lambda report: report.update(owner="0x" + "de" * 20),
                       lambda report: report["receipts"].pop(), lambda report: report.update(chainId=10143)]:
            self.fixture()
            change(self.report)
            with self.assertRaises(RuntimeError):
                self.verify()

    def test_canonical_sender_target_nonce_and_encoded_beneficiary_are_checked(self):
        for field, value in [("from", "0x" + "de" * 20), ("to", "0x" + "de" * 20), ("nonce", "0x99"),
                             ("input", "0x40c10f19" + "de" * 32 + audit.word(11_000_000))]:
            self.fixture()
            first = next(iter(self.transactions.values()))
            first[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.verify()

    def test_sdk_receipt_gas_claims_do_not_override_canonical_rpc(self):
        self.fixture()
        self.report["receipts"][0]["gas"] = "1"
        with self.assertRaisesRegex(RuntimeError, "metadata differs"):
            self.verify()

    def test_claim_requires_exact_vault_paid_event_to_the_independent_owner(self):
        self.fixture("claim")
        next(iter(self.receipts.values()))["logs"][0]["topics"][2] = "0x" + "de" * 32
        with self.assertRaisesRegex(RuntimeError, "Paid event"):
            self.verify("claim")

    def test_snapshot_summary_cannot_invent_wallet_payout_or_suppress_remaining_claim(self):
        self.fixture("claim")
        self.wallet = 10_000_000
        with self.assertRaisesRegex(RuntimeError, "owner balances"):
            self.verify("claim")
        self.wallet = 11_000_000
        self.claim = 1_000_000
        with self.assertRaisesRegex(RuntimeError, "owner balances"):
            self.verify("claim")

    def test_snapshot_block_and_preparation_residual_collateral_are_bound(self):
        self.fixture()
        self.report["block"]["hash"] = "0x" + audit.word(999)
        with self.assertRaisesRegex(RuntimeError, "snapshot block"):
            self.verify()
        self.fixture()
        self.cash = 0
        self.report["account"]["risk"]["cashQ"] = "0"
        with self.assertRaisesRegex(RuntimeError, "account risk"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
