import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("local_audit", Path(__file__).with_name("audit-local-run.py"))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


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


if __name__ == "__main__":
    unittest.main()
