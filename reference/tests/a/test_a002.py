"""Exercise the runners in disposable repositories, never a counterfeit B lane."""

import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from unittest.mock import patch

from scripts.check_a_review import validate_review


ROOT = Path(__file__).resolve().parents[3]


def bash_path():
    # On Windows system32/bash may be an unconfigured WSL launcher. Prefer Git Bash.
    if os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        if candidate.is_file():
            return str(candidate)
    result = shutil.which("bash")
    if result is None:
        raise RuntimeError("Bash is required to verify the advertised shell entrypoints")
    return result


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="eros-runner-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        for name in ("check-task.sh", "check-gate.sh"):
            shutil.copyfile(ROOT / "scripts" / name, self.root / "scripts" / name)

    def write_suite(self, task, body):
        path = self.root / f"reference/tests/{task[0].lower()}/test_{task.lower()}.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(body), encoding="utf-8")

    def run_script(self, script, argument, *, cwd=None):
        return subprocess.run(
            [bash_path(), str(self.root / "scripts" / script), argument],
            cwd=cwd or self.root,
            env={**os.environ, "PYTHON": sys.executable},
            capture_output=True, text=True, timeout=60,
        )

    def task_record(self, task):
        return json.loads((self.root / f"artifacts/tasks/{task}.json").read_text(encoding="utf-8"))

    def test_a_and_b_are_discovered_independently(self):
        self.write_suite("A001", """
            import unittest
            class Smoke(unittest.TestCase):
                def test_a(self): self.assertEqual(17 * 613, 10421)
        """)
        self.write_suite("B001", """
            import unittest
            class Smoke(unittest.TestCase):
                def test_b(self): self.assertEqual(3 + 4, 7)
        """)
        for task in ("A001", "B001"):
            run = self.run_script("check-task.sh", task, cwd=ROOT)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            record = self.task_record(task)
            self.assertEqual(record["test_count"], 1)
            self.assertEqual(record["status"], "passed")
            self.assertIsNone(record["source_commit"])
            self.assertIn(f"reference/tests/{task[0].lower()}/test_{task.lower()}.py", record["fixture_hashes"])
        self.assertIn("test_a", self.task_record("A001")["commands"][0]["output"])
        self.assertNotIn("test_b", self.task_record("A001")["commands"][0]["output"])

    def test_failure_propagates_and_does_not_run_peer(self):
        self.write_suite("A001", """
            import unittest
            class Smoke(unittest.TestCase):
                def test_failure(self): self.fail('deliberate failure')
        """)
        self.write_suite("B001", "raise RuntimeError('must not import peer')")
        run = self.run_script("check-task.sh", "A001")
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        record = self.task_record("A001")
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["test_count"], 1)
        self.assertIn("deliberate failure", record["commands"][0]["output"])
        self.assertNotIn("must not import peer", run.stdout + run.stderr)

    def test_missing_suite_fails(self):
        run = self.run_script("check-task.sh", "B001")
        self.assertEqual(run.returncode, 2)
        self.assertEqual(self.task_record("B001")["test_count"], 0)
        self.assertIn("missing suite", run.stderr)

    def test_empty_suite_fails(self):
        self.write_suite("A001", "import unittest\n")
        run = self.run_script("check-task.sh", "A001")
        self.assertEqual(run.returncode, 2)
        self.assertIn("empty suite", run.stderr)

    def test_skipped_suite_is_not_accepted(self):
        self.write_suite("A001", """
            import unittest
            class Smoke(unittest.TestCase):
                @unittest.skip('deliberately unavailable')
                def test_skip(self): pass
        """)
        run = self.run_script("check-task.sh", "A001")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(self.task_record("A001")["skipped_count"], 1)

    def test_import_error_is_failed_evidence(self):
        self.write_suite("A001", "raise RuntimeError('broken fixture import')\n")
        run = self.run_script("check-task.sh", "A001")
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(self.task_record("A001")["status"], "failed")
        self.assertIn("broken fixture import", run.stdout + run.stderr)

    def test_expected_failure_does_not_count_as_acceptance(self):
        self.write_suite("A001", """
            import unittest
            class Smoke(unittest.TestCase):
                @unittest.expectedFailure
                def test_known_failure(self): self.fail('known failure is still a failure')
        """)
        run = self.run_script("check-task.sh", "A001")
        self.assertEqual(run.returncode, 1)
        self.assertEqual(self.task_record("A001")["status"], "failed")

    def test_unknown_identifiers_fail_without_execution(self):
        for task in ("A000", "A045", "C001", "A001;echo bad", "../A001"):
            run = self.run_script("check-task.sh", task)
            self.assertEqual(run.returncode, 2)
            self.assertIn("usage:", run.stderr)
        self.assertFalse((self.root / "artifacts").exists())

    def test_missing_solidity_suite_and_unconfigured_campaign_fail(self):
        for task in ("A010", "B039", "A040"):
            run = self.run_script("check-task.sh", task)
            self.assertEqual(run.returncode, 2)
            self.assertNotEqual(self.task_record(task)["status"], "passed")

    def prepare_solidity(self, relative, source):
        directory = self.root / "contracts"
        directory.mkdir(exist_ok=True)
        (directory / "foundry.toml").write_text(
            '[profile.default]\nsolc_version = "0.8.30"\nevm_version = "prague"\n',
            encoding="utf-8",
        )
        path = directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")

    def test_solidity_runner_executes_and_rejects_failure_or_empty_suite(self):
        source = '''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
contract RunnerSmoke {
    function testSmoke() public pure { assert(17 * 613 == 10421); }
}
'''
        self.prepare_solidity("test/math/A/A010.t.sol", source)
        run = self.run_script("check-task.sh", "A010")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.task_record("A010")["test_count"], 1)
        self.prepare_solidity("test/math/A/A010.t.sol", source.replace("17 * 613 == 10421", "false"))
        run = self.run_script("check-task.sh", "A010")
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.task_record("A010")["status"], "failed")
        self.assertEqual(self.task_record("A010")["test_count"], 1)
        self.prepare_solidity("test/math/A/A010.t.sol", source.replace("testSmoke", "notATest"))
        run = self.run_script("check-task.sh", "A010")
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.task_record("A010")["status"], "failed")

    def test_gate_executes_both_lanes_and_combined_suite_without_accepting_merge(self):
        # Disposable runner smoke scaffolding: not B001/B002 or G0 implementation.
        required = ("reference/common/units.py", "reference/common/result_schema.json",
                    "contracts/src/math/MathTypes.sol", "docs/math/units.md",
                    "docs/math/risk-function-contracts.json", "docs/ownership.json",
                    "docs/counterpart-contracts.md", "reference/fixtures/golden_cases.json",
                    "docs/math/golden-case-rationale.md", "docs/contracts/G0.json")
        for relative in required:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            # Solidity input is only needed for compiler discovery, not economic logic.
            content = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.30;\n" if path.suffix == ".sol" else "{}\n"
            path.write_text(content, encoding="utf-8")
        for task in ("A001", "A002", "B001", "B002"):
            self.write_suite(task, """
                import unittest
                class Smoke(unittest.TestCase):
                    def test_runner_fixture(self): self.assertTrue(True)
            """)
        self.prepare_solidity("test/gates/G0.t.sol", '''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
contract GateRunnerSmoke { function testRunnerSmoke() public pure { assert(true); } }
''')
        run = self.run_script("check-gate.sh", "G0")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        record = json.loads((self.root / "artifacts/gates/G0.json").read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "checks_passed")
        self.assertEqual(record["test_count"], 5)
        self.assertEqual(len(record["commands"]), 5)
        self.assertFalse(record["accepted"])
        self.assertIsNone(record["merge_sha"])
        self.assertEqual(record["reviewed_by"], [])
        self.assertFalse((self.root / "gate_status.json").exists())

    def test_gate_missing_real_inputs_never_passes(self):
        run = self.run_script("check-gate.sh", "G0")
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        record = json.loads((self.root / "artifacts/gates/G0.json").read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "blocked")
        self.assertIn("reference/tests/b/test_b001.py", record["reason"])
        self.assertIn("contracts/test/gates/G0.t.sol", record["reason"])
        self.assertFalse(record["accepted"])
        self.assertIsNone(record["merge_sha"])
        self.assertEqual(record["reviewed_by"], [])
        self.assertFalse((self.root / "gate_status.json").exists())

    def test_invalid_gate_fails(self):
        run = self.run_script("check-gate.sh", "G8")
        self.assertEqual(run.returncode, 2)
        self.assertIn("usage:", run.stderr)

    def test_risk_seed_does_not_override_book_profiles(self):
        config = tomllib.loads((ROOT / "contracts/foundry.toml").read_text(encoding="utf-8"))
        self.assertEqual(config["profile"]["default"]["solc_version"], "0.8.30")
        self.assertEqual(config["profile"]["default"]["evm_version"], "prague")
        self.assertEqual(config["profile"]["risk"]["fuzz"]["seed"], "0x45524f53")
        self.assertEqual(config["fuzz"]["runs"], 1000)
        self.assertEqual(config["profile"]["ci"]["fuzz"]["runs"], 10000)
        self.assertNotIn("rpc_endpoints", config)

    def test_schema_preserves_exact_values_and_execution_provenance(self):
        schema = json.loads((ROOT / "reference/common/result_schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        required = set(schema["required"])
        self.assertTrue({"source_commit", "worktree_dirty", "commands", "fixture_hashes", "components"} <= required)
        integer = schema["$defs"]["integerString"]
        self.assertEqual(integer["type"], "string")
        for exact in ("0", str(2**255 - 1), str(-(2**255))):
            self.assertIsNotNone(re.fullmatch(integer["pattern"], exact))
        for inexact in ("1.25", "1e18", "-0", "01"):
            self.assertIsNone(re.fullmatch(integer["pattern"], inexact))
        denominator = schema["$defs"]["rational"]["properties"]["denominator"]
        self.assertIsNone(re.fullmatch(denominator["pattern"], "0"))
        self.assertIsNone(re.fullmatch(denominator["pattern"], "-1"))
        self.assertEqual(schema["properties"]["accepted"], {"const": False})

    def prepare_review(self):
        paths = {
            "artifacts/reviews/A-on-B.md": "Review status: COMPLETE\n",
            "contracts/src/ReviewFixture.sol": "pragma solidity ^0.8.30;\n",
            "contracts/test/reviews/ReviewFixture.t.sol": "pragma solidity ^0.8.30;\n",
        }
        hashes = {}
        for relative, content in paths.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            hashes[relative] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        review = {"reviewer": "A", "status": "complete", "source_commit": "a" * 40,
                  "reviewed_files": hashes, "findings": []}
        path = self.root / "artifacts/reviews/A-on-B.json"
        path.write_text(json.dumps(review), encoding="utf-8")
        return review, path

    def test_peer_review_requires_report_and_evidence(self):
        with self.assertRaisesRegex(ValueError, "source-bound evidence"):
            validate_review(self.root)

    def test_peer_review_accepts_git_checkout_line_endings(self):
        review, _ = self.prepare_review()
        with patch("scripts.check_a_review.subprocess.run") as git:
            git.return_value.returncode = 0
            for newline in (b"\n", b"\r\n"):
                for relative in review["reviewed_files"]:
                    path = self.root / relative
                    path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", newline))
                self.assertEqual(validate_review(self.root)["reviewer"], "A")

    def test_peer_review_rejects_changed_or_unreviewed_source(self):
        self.prepare_review()
        with patch("scripts.check_a_review.subprocess.run") as git:
            git.return_value.returncode = 0
            self.assertEqual(validate_review(self.root)["reviewer"], "A")
            source = self.root / "contracts/src/ReviewFixture.sol"
            source.write_text("pragma solidity ^0.8.29;\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "reviewed source changed"):
                validate_review(self.root)
            self.prepare_review()
            (self.root / "contracts/src/New.sol").write_text("pragma solidity ^0.8.30;\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "does not cover"):
                validate_review(self.root)

    def test_peer_review_rejects_unresolved_high_and_unrelated_commit(self):
        review, path = self.prepare_review()
        review["findings"] = [{"id": "fixture", "severity": "High", "status": "open"}]
        path.write_text(json.dumps(review), encoding="utf-8")
        with patch("scripts.check_a_review.subprocess.run") as git:
            git.return_value.returncode = 0
            with self.assertRaisesRegex(ValueError, "unresolved critical/high"):
                validate_review(self.root)
            git.return_value.returncode = 1
            with self.assertRaisesRegex(ValueError, "not an ancestor"):
                validate_review(self.root)


if __name__ == "__main__":
    unittest.main()
