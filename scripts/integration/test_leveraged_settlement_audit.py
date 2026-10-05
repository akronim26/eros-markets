import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("settlement_audit", Path(__file__).with_name("audit-local-run.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class LeveragedSettlementAuditTests(unittest.TestCase):
    def setUp(self):
        self.engine, self.vault, self.token = ["0x" + byte * 40 for byte in "abc"]
        self.market = "0x"+"dd"*32
        self.contracts = {"markets": {"demo": {"engine": self.engine, "marketId": self.market}}, "contracts": {
            "CollateralVault": {"address": self.vault}, "MockUSDC": {"address": self.token}}}
        self.names = ["buyer", "seller", "leveragedLong", "leveragedShort"]
        self.owners = ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
                       "0x1cbd3b2770909d4e10f157cabc84c7264073c9ec", "0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097"]
        q = 10**24
        self.cash = [95*q, 105*q, -40*q-9*10**17, 60*q-7*10**17]
        self.claims = [max(value, 0)//10**18 for value in self.cash]
        self.deficit = -self.cash[2]
        self.reserve = 100_000*q + 16*10**17
        self.residual = self.reserve - self.deficit + 3*10**17
        self.wallets = [105_000_000, 95_000_000, 0, 0]
        self.states = [[phase, 1, 1, 1, 0, 0, 77, 4, 8, 4, sum(self.claims), self.deficit, 1, 1, 0] for phase in (3, 4)]
        self.snapshots = [{"block": {"number": str(block), "hash": hex(block)}, "markets": [{"name": "demo",
            "settlement": {"totalDeficitQ": str(self.deficit)}, "accounts": [
                {"name": name, "owner": owner, "walletAtoms": str(self.wallets[i]+(self.claims[i] if stage else 0)),
                 "claimAtoms": str(0 if stage else self.claims[i])} for i, (name, owner) in enumerate(zip(self.names, self.owners))]}]}
            for stage, block in enumerate((100, 110))]
        self.tx = {}
        self.receipts = {}
        self.broadcast = {"receipts": []}
        for index, (owner, amount) in enumerate(zip(self.owners, self.claims)):
            if not amount:
                continue
            tx_hash = hex(101+index)
            self.tx[tx_hash] = {"from": owner, "to": self.engine, "input": "0xb1f6959c"+audit.word(owner), "value": "0x0"}
            self.receipts[tx_hash] = {"blockNumber": hex(101+index), "logs": [{"address": self.vault,
                "topics": [audit.PAID_TOPIC, "0x"+audit.word(self.engine), "0x"+audit.word(owner)], "data": "0x"+audit.word(amount)}]}
            self.broadcast["receipts"].append({"transactionHash": tx_hash})
        event = "0x347a378a068fbbe495bd8612faa361487aeff3a52d82e40a28d048fc4ef70ac0"
        self.receipts["keeper"] = {"logs": [{"address": self.engine, "topics": [event, self.market],
            "data": self.encode([77, 1, 0, sum(self.claims), 40_000_000])}]}

    @staticmethod
    def encode(values):
        return "0x"+"".join(audit.word(value % (1 << 256)) for value in values)

    def rpc(self, _rpc, method, params):
        if method == "eth_getBlockByNumber":
            return {"hash": params[0]}
        if method == "eth_getTransactionReceipt":
            return self.receipts[params[0]]
        if method == "eth_getTransactionByHash":
            return self.tx[params[0]]
        self.assertEqual(method, "eth_call")
        call, block = params
        self.assertIn(block, ("0x64", "0x6e"), "all reads must use one of the canonical checkpoints")
        stage = int(block == "0x6e")
        selector = call["data"][:10]
        if selector in ("0xd0516650", "0x4c13a47c", "0x70a08231"):
            owner = "0x"+call["data"][-40:]
            if owner == self.vault:
                return self.encode([self.residual//10**18])
            index = self.owners.index(owner)
            if selector == "0xd0516650":
                return self.encode([[10_000, -10_000, 100_000, -100_000][index], self.cash[index]])
            if selector == "0x4c13a47c":
                return self.encode([0 if stage else self.claims[index]])
            return self.encode([self.wallets[index]+(self.claims[index] if stage else 0)])
        values = {"0x1ce63bbc": self.states[stage], "0x9c793af9": [self.residual], "0xefe6980a": [0, self.reserve],
                  "0xa704e33a": [self.residual//10**18], "0x6185798e": [0], "0x94313932": [self.residual//10**18], "0x477b6f9e": [100_000*10**24]}
        return self.encode(values[selector])

    def verify(self):
        with patch.object(audit.STACK, "rpc_call", side_effect=self.rpc):
            return audit.verify_leveraged_settlement("http://127.0.0.1:18546", self.contracts,
                *self.snapshots, self.broadcast, [{"hash": "keeper"}])

    def test_exact_premiums_and_fractional_dust_do_not_reduce_winner_entitlement(self):
        report = self.verify()
        self.assertEqual(report["totalDeficitQ"], str(self.deficit))
        self.assertEqual(report["reserveContributionAtoms"], "40000000")
        self.assertEqual(report["fullOwnerClaimsAtoms"][self.owners[3]], "59999999")

    def test_forged_zero_deficit_or_incomplete_accounting_cannot_pass(self):
        for index, wrong in ((11, 0), (12, 0), (13, 0), (14, 1)):
            original = copy.deepcopy(self.states)
            self.states[0][index] = wrong
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                self.verify()
            self.states = original

    def test_wrong_sender_or_beneficiary_cannot_pass(self):
        first = next(iter(self.tx.values()))
        first["from"] = "0x"+"d"*40
        with self.assertRaisesRegex(RuntimeError, "direct-owner"):
            self.verify()

    def test_reported_success_cannot_hide_missing_owner_receipt(self):
        self.broadcast["receipts"].pop()
        with self.assertRaisesRegex(RuntimeError, "Missing leveraged"):
            self.verify()

    def test_forged_snapshot_balance_and_event_contribution_are_rejected(self):
        self.snapshots[1]["markets"][0]["accounts"][3]["walletAtoms"] = "60000000"
        with self.assertRaisesRegex(RuntimeError, "canonical owner"):
            self.verify()
        self.setUp()
        self.receipts["keeper"]["logs"][0]["data"] = self.encode([77, 1, 0, sum(self.claims), 0])
        with self.assertRaisesRegex(RuntimeError, "misreports"):
            self.verify()

    def test_event_from_another_market_or_snapshot_is_rejected(self):
        self.receipts["keeper"]["logs"][0]["topics"][1] = "0x"+"ee"*32
        with self.assertRaisesRegex(RuntimeError, "binding"):
            self.verify()
        self.setUp()
        self.receipts["keeper"]["logs"][0]["data"] = self.encode([78, 1, 0, sum(self.claims), 40_000_000])
        with self.assertRaisesRegex(RuntimeError, "misreports"):
            self.verify()

    def test_reorg_during_block_pinned_reads_invalidates_the_audit(self):
        calls = 0
        original = self.rpc
        def reorg(endpoint, method, params):
            nonlocal calls
            if method == "eth_getBlockByNumber":
                calls += 1
                if calls > 2:
                    return {"hash": "0xff"}
            return original(endpoint, method, params)
        self.rpc = reorg
        with self.assertRaisesRegex(RuntimeError, "changed during audit"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
