"""B001: risk function contracts and ownership map are complete and unambiguous."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = json.loads((ROOT / "docs/math/risk-function-contracts.json").read_text())
OWNERSHIP = json.loads((ROOT / "docs/ownership.json").read_text())
COUNTERPART = (ROOT / "docs/counterpart-contracts.md").read_text()
TASKS_A = json.loads((ROOT / "docs/spec/tasks_A.json").read_text())
TASKS_B = json.loads((ROOT / "docs/spec/tasks_B.json").read_text())

B_LIBRARIES = ["HorizonMath", "HazardMath", "MarginMath", "OrderAdmissionMath",
               "PricingMath", "LiquidationMath", "LifecycleMath"]


class FunctionContracts(unittest.TestCase):
    def test_every_function_has_domain_rounding_and_error(self):
        rounding_words = set(CONTRACTS["rounding_legend"])
        for fn in CONTRACTS["functions"]:
            with self.subTest(fn=fn["name"]):
                self.assertTrue(fn["inputs"], "inputs listed")
                self.assertTrue(fn["outputs"], "outputs listed")
                for io in fn["inputs"] + fn["outputs"]:
                    self.assertIn("unit", io, f"{io['name']} has a unit")
                self.assertIn("rounding", fn)
                self.assertTrue(any(w in fn["rounding"] for w in rounding_words),
                                f"rounding uses a legend word: {fn['rounding']}")
                self.assertIn("error", fn, "unavailable/error result stated")
                self.assertTrue(fn["error"].strip())
                self.assertTrue(fn.get("domain", "").strip(), "explicit domain stated")

    def test_names_unique(self):
        names = [f["name"] for f in CONTRACTS["functions"]]
        self.assertEqual(len(names), len(set(names)))

    def test_every_b_library_has_functions(self):
        for lib in B_LIBRARIES:
            with self.subTest(lib=lib):
                self.assertTrue(any(fn["module"].startswith(lib) for fn in CONTRACTS["functions"]))

    def test_domain_failures_force_full_backing(self):
        text = CONTRACTS["common_unavailable_results"]["FULL_BACKING_REQUIRED"]
        for cond in ["a0+a1>=1", "a_adv>=epsilon", "epsilon' rounds to 0", "missing/expired calibration"]:
            self.assertIn(cond, text)

    def test_directions_match_claude_md(self):
        by = {f["name"]: f for f in CONTRACTS["functions"]}
        self.assertIn("UP", by["hazardUpper"]["rounding"])
        self.assertIn("eps' DOWN", by["tailFactor"]["rounding"])
        self.assertIn("k UP", by["tailFactor"]["rounding"])
        self.assertIn("UP", by["sideMargin"]["rounding"])
        self.assertIn("TRUNC0", by["fundingRate"]["rounding"])
        self.assertIn("x == 0 returns zeros", by["sideMargin"]["error"])
        self.assertIn("divides by x or by equity", by["sideMargin"]["never"])

    def test_no_double_wad_division(self):
        conv = {c["from"]: c for c in CONTRACTS["boundary_conversions"]}
        self.assertIn("no second WAD division", conv["qWad mark"]["rule"])
        self.assertEqual(conv["tick"]["rule"], "tick * 1e15")


class Ownership(unittest.TestCase):
    def test_no_duplicate_writers(self):
        for entry in OWNERSHIP["files"]:
            with self.subTest(path=entry["path"]):
                self.assertIsInstance(entry["sole_editor"], str)

    def test_every_task_file_is_mapped_to_its_owner(self):
        mapped = {e["path"]: e["sole_editor"] for e in OWNERSHIP["files"]}
        for t in TASKS_A + TASKS_B:
            for f in t["write_files"]:
                self.assertEqual(mapped.get(f), t["owner"], f)

    def test_counterparts_are_outside_the_team(self):
        ids = {c["id"] for c in OWNERSHIP["counterparts"]}
        for cp in ["CP-BOOK", "CP-PRICE", "CP-ORACLE", "CP-FACTORY", "CP-TOKEN", "CP-APP"]:
            self.assertIn(cp, ids)
            self.assertIn(cp, COUNTERPART)
        book = next(c for c in OWNERSHIP["counterparts"] if c["id"] == "CP-BOOK")
        self.assertIn("contracts/src/Book.sol", book["paths"])

    def test_scope_excludes_clob_and_uma_internals(self):
        self.assertIn("no CLOB", COUNTERPART)
        self.assertIn("UMA", COUNTERPART)
        self.assertIn("BLOCKED_BY_COUNTERPART", COUNTERPART)


if __name__ == "__main__":
    unittest.main()
