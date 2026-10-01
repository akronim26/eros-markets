"""Phase 1 audit: run the spec's 26 arithmetic checks and derive the constants used by
contracts/test/audit/AuditSpecVectors.t.sol independently with Fraction (no Solidity call)."""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
Q = 10**18
U = 1000 * Q  # PAYOFF_Q_PER_LOT


def pos_integral(a, b, t):
    a, b, t = F(a), F(b), F(t)
    end = a + b * t
    if a >= 0 and end >= 0:
        return (a + end) * t / 2
    if a <= 0 and end <= 0:
        return F(0)
    if a < 0:
        return end * end / (2 * b)
    return a * a / (-2 * b)


def ceil(x):
    return -(-x.numerator // x.denominator)


def deficits(cash, lots, bid_value=0, ask_lots=0, ask_value=0, fee=0):
    c = cash - fee
    return max(0, bid_value - c), max(0, -(c + lots * U - ask_lots * U + ask_value))


class SpecScript(unittest.TestCase):
    def test_verify_spec_vectors_26_checks(self):
        # The script rewrites spec_vector_results.json next to itself, so run a copy.
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "verify_spec_vectors.py"
            shutil.copy(ROOT / "docs/spec/verify_spec_vectors.py", script)
            run = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            out = json.loads((Path(tmp) / "spec_vector_results.json").read_text())
        self.assertEqual(out["status"], "passed")
        self.assertEqual(out["check_count"], 26)
        self.assertTrue(all(c["passed"] for c in out["checks"]))


class AuditConstants(unittest.TestCase):
    """Literals hard-coded in AuditSpecVectors.t.sol / AuditStateful.t.sol, re-derived here."""

    def sol(self, name):
        text = (ROOT / "contracts/test/audit/AuditSpecVectors.t.sol").read_text()
        m = re.search(rf"constant {name} = ([0-9_e]+);", text)
        self.assertIsNotNone(m, name)
        raw = m.group(1).replace("_", "")
        if "e" in raw:
            base, exp = raw.split("e")
            return int(base) * 10 ** int(exp)
        return int(raw)

    def test_v01_fill_value(self):
        self.assertEqual(17 * 613 * Q, self.sol("V01_VALUE_Q"))

    def test_v03_v04_bilateral_deficits(self):
        self.assertEqual(deficits(-480_000_000 * Q, 1_000_000), (480_000_000 * Q, 0))
        self.assertEqual(deficits(700_000_000 * Q, -1_000_000), (0, 300_000_000 * Q))

    def test_v07_oversized_ask(self):
        d0, d1 = deficits(0, 1000, ask_lots=2300, ask_value=2300 * 550 * Q)
        self.assertEqual((d0, d1), (0, 35_000 * Q))
        self.assertEqual(d1, self.sol("V07_YES_DEFICIT_Q"))

    def test_v11_budget_seconds(self):
        # r = 1 atom/lot/s; OI 100,000 -> 200,000 lots; B = 10 USDC.
        b = 10 * 10**6 * Q - 100_000 * Q * 20
        self.assertEqual(b, 8 * 10**6 * Q)
        self.assertEqual(b // (200_000 * Q), 40)

    def test_v12_variant_premium(self):
        # NO deficit 100 -> 103.6 USDC over 3600 s at (1+1) * 0.0001 / day.
        exact = pos_integral(100 * 10**6 * Q, 10**6 * 10**15, 3600) * F(10**14, Q) * 2 / 86400
        self.assertEqual(ceil(exact), self.sol("V12_PREMIUM_Q"))
        self.assertEqual(ceil(4 * exact), self.sol("V14_PREMIUM_Q"))

    def test_v12_spec_usdc(self):
        self.assertEqual(pos_integral(100, F(10, 3600), 3600) * F(2, 10000) / 86400, F(7, 8000))

    def test_settlement_fixture(self):
        alice, bob = (-480_000_000 * Q, 1_000_000), (700_000_000 * Q, -1_000_000)
        for p, want in [(F(0), (0, 700_000_000)), (F(1), (520_000_000, 0)), (F(1, 2), (20_000_000, 200_000_000))]:
            got = tuple(int(max(0, c + n * U * p) // Q) for c, n in (alice, bob))
            self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main()
