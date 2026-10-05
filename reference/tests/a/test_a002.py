"""Exercise the runners in disposable repositories, never a counterfeit B lane."""

import json
import contextlib
import hashlib
import io
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

from scripts import check_a_review
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
        for name in ("check-task.sh", "check-gate.sh", "check_a_review.py"):
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

    def prepare_sdk_compiler(self, installed_version=None):
        directory = self.root / "packages/risk-sdk"
        directory.mkdir(parents=True)
        for name in ("package.json", "package-lock.json"):
            shutil.copyfile(ROOT / "packages/risk-sdk" / name, directory / name)
        if installed_version is not None:
            compiler = directory / "node_modules/typescript/bin/tsc"
            compiler.parent.mkdir(parents=True)
            compiler.write_text("process.stderr.write('local compiler fixture failure'); process.exit(7);\n", encoding="utf-8")
            (compiler.parent.parent / "package.json").write_text(
                json.dumps({"version": installed_version}), encoding="utf-8")

    def test_sdk_missing_local_compiler_fails_without_global_fallback(self):
        self.prepare_sdk_compiler()
        run = self.run_script("check-task.sh", "B042")
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        record = self.task_record("B042")
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["test_count"], 0)
        self.assertIn("npm ci --prefix packages/risk-sdk", record["reason"])

    def test_sdk_wrong_local_compiler_version_fails(self):
        self.prepare_sdk_compiler("5.9.2")
        run = self.run_script("check-task.sh", "B042")
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        record = self.task_record("B042")
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["test_count"], 0)
        self.assertIn("expected 5.9.3", record["reason"])

    def test_sdk_local_compiler_and_lock_are_recorded_without_vendor_hashes(self):
        self.prepare_sdk_compiler("5.9.3")
        fixture = self.root / "docs/app-state-fixtures.json"
        fixture.parent.mkdir()
        fixture.write_text("{}\n", encoding="utf-8")
        run = self.run_script("check-task.sh", "B042")
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        record = self.task_record("B042")
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["toolchain"]["typescript"], "5.9.3")
        command = record["commands"][0]
        self.assertEqual(command["argv"][0], "node")
        self.assertEqual(Path(command["argv"][1]), self.root / "packages/risk-sdk/node_modules/typescript/bin/tsc")
        self.assertEqual(command["exit_code"], 7)
        self.assertIn("local compiler fixture failure", command["output"])
        for name in ("package.json", "package-lock.json"):
            self.assertIn(f"packages/risk-sdk/{name}", record["fixture_hashes"])
        self.assertFalse(any("node_modules" in name for name in record["fixture_hashes"]))

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


class UnifiedValidationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="eros-unified-runner-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stdout = json.dumps({"test/reviews/B043Review.t.sol:ReviewFixture": {
            "test_results": {"testRegression()": {"status": "Success"}}}})
        self.forge_exit = 0
        self.commands = []
        self.forge_environments = []
        self.mutate_during_run = False
        self.ancestor_exit = 0
        self.task_result = {"status": "passed", "exit_code": 0, "test_count": 1, "skipped_count": 0}
        self.node_stdout = "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
        self.reference_stderr = "Ran 1 test in 0.001s\n\nOK\n"
        for relative in ("contracts/src/Fixture.sol", "contracts/test/reviews/B043Review.t.sol",
                         "contracts/test/harness/Fixture.sol", "contracts/foundry.toml"):
            self.write(relative, "fixture\n")
        for name in ("check_a_review.py", "check-a-handoff.py", "check-task.sh", "check-gate.sh"):
            self.write("scripts/" + name, (ROOT / "scripts" / name).read_text(encoding="utf-8"))
        self.subprocess = patch("subprocess.run", side_effect=self.fake_run)
        self.subprocess.start()
        self.addCleanup(self.subprocess.stop)

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def fake_run(self, command, **kwargs):
        self.commands.append(command)
        if command[:3] == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(command, 0, "a" * 40 + "\n", "")
        if command[:2] == ["git", "merge-base"]:
            return subprocess.CompletedProcess(command, self.ancestor_exit, "", "")
        if command[:2] == ["git", "status"] or command[:2] == ["git", "submodule"]:
            return subprocess.CompletedProcess(command, 0, "", "")
        if command == ["forge", "--version"]:
            return subprocess.CompletedProcess(command, 0, "forge fixture\n", "")
        if command[:2] == ["forge", "test"]:
            self.forge_environments.append(kwargs.get("env", {}))
            if self.mutate_during_run:
                self.write("contracts/src/Fixture.sol", "changed during execution\n")
            return subprocess.CompletedProcess(command, self.forge_exit, self.stdout, "")
        if command[0] == "node":
            return subprocess.CompletedProcess(command, 0, self.node_stdout if command[1] == "--test" else "", "")
        if command[:3] == [sys.executable, "-m", "unittest"]:
            return subprocess.CompletedProcess(command, 0, "", self.reference_stderr)
        if len(command) == 3 and command[1] == "scripts/check-task.sh":
            self.write(f"artifacts/tasks/{command[2]}.json", json.dumps(self.task_result))
            return subprocess.CompletedProcess(command, 0, "", "")
        raise AssertionError("Unexpected subprocess: " + repr(command))

    def execute_script(self, name, arguments):
        path = self.root / "scripts" / name
        source = path.read_text(encoding="utf-8")
        if name.endswith(".sh"):
            source = source.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        old_directory = Path.cwd()
        old_path = list(sys.path)
        try:
            with patch.object(sys, "argv", [str(path), *arguments]), \
                    patch.dict(sys.modules, {"check_a_review": check_a_review}), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    exec(compile(source, str(path), "exec"), {"__file__": str(path), "__name__": "__main__"})
                except SystemExit as error:
                    return error.code
                return 0
        finally:
            os.chdir(old_directory)
            sys.path[:] = old_path

    def test_unified_runs_both_historical_regression_paths_without_review_signatures(self):
        for task, expected in (("A043", "test/reviews/*.t.sol"), ("B043", "test/reviews/B043Review.t.sol")):
            with self.subTest(task=task):
                report = check_a_review.run_technical_validation(self.root, task)
                self.assertEqual(report["status"], "passed")
                self.assertEqual(report["checks_run"], 1)
                self.assertEqual(report["command"], ["forge", "test", "--match-path", expected, "--json"])
                self.assertEqual(report["validation_mode"], "unified_team_technical_validation")
                self.assertFalse(report["independent_review"])
                self.assertFalse(report["independent_audit"])
                self.assertFalse(report["accepted"])
                self.assertIsNone(report["merge_sha"])
                self.assertEqual(report["source_commit"], "a" * 40)
                self.assertIn("contracts/test/harness/Fixture.sol", report["source_hashes"])
                self.assertEqual(check_a_review.validate_technical_validation(self.root, task), report)
        self.assertFalse((self.root / "artifacts/reviews").exists())

    def test_unified_rejects_failed_empty_skipped_and_malformed_results(self):
        mixed = json.loads(self.stdout)
        mixed["emptySuite"] = {"test_results": {}}
        for output, code in (("{}", 0), ("[]", 0), ("not json", 0),
                             (json.dumps(mixed), 0),
                             ('{"suite":{"test_results":{}}}', 0),
                             ('{"suite":{"test_results":{"test()":{"status":"Skipped"}}}}', 0),
                             ('{"suite":{"test_results":{"test()":{"status":"Failure"}}}}', 0),
                             ('{"suite":{"test_results":{"test()":null}}}', 0),
                             (self.stdout, 1)):
            with self.subTest(output=output, code=code):
                self.stdout, self.forge_exit = output, code
                report = check_a_review.run_technical_validation(self.root, "A043")
                self.assertEqual(report["status"], "failed")
                self.assertNotEqual(report["exit_code"], 0)
                with self.assertRaises(ValueError):
                    check_a_review.validate_technical_validation(self.root, "A043")

    def test_unified_rejects_source_changes_during_execution(self):
        self.mutate_during_run = True
        report = check_a_review.run_technical_validation(self.root, "A043")
        self.assertEqual(report["status"], "failed")
        self.assertIn("changed", report["reason"])

    def test_unified_evidence_rejects_changed_added_or_deleted_inputs(self):
        for relative in ("contracts/src/Fixture.sol", "contracts/test/harness/Fixture.sol", "scripts/check-task.sh"):
            check_a_review.run_technical_validation(self.root, "A043")
            self.write(relative, "changed\n")
            with self.assertRaisesRegex(ValueError, "source"):
                check_a_review.validate_technical_validation(self.root, "A043")
        check_a_review.run_technical_validation(self.root, "A043")
        added = self.write("contracts/test/reviews/Added.t.sol", "new\n")
        with self.assertRaisesRegex(ValueError, "source"):
            check_a_review.validate_technical_validation(self.root, "A043")
        check_a_review.run_technical_validation(self.root, "A043")
        added.unlink()
        with self.assertRaisesRegex(ValueError, "source"):
            check_a_review.validate_technical_validation(self.root, "A043")

    def test_unified_preserves_historical_review_files_and_rejects_unrelated_evidence(self):
        historical = self.write("artifacts/reviews/A-on-B.json", '{"historical":"untouched"}\n')
        report = self.write("artifacts/reviews/B-on-A.md", "Historical review\n")
        check_a_review.run_technical_validation(self.root, "A043")
        self.assertEqual(historical.read_text(), '{"historical":"untouched"}\n')
        self.assertEqual(report.read_text(), "Historical review\n")
        self.ancestor_exit = 1
        with self.assertRaisesRegex(ValueError, "ancestor"):
            check_a_review.validate_technical_validation(self.root, "A043")

    def test_unified_a043_entrypoint_emits_technical_result(self):
        self.assertEqual(self.execute_script("check-a-handoff.py", ["A043"]), 0)
        evidence = json.loads((self.root / "artifacts/validation/A043.json").read_text())
        self.assertEqual(evidence["status"], "passed")

    def test_unified_b043_entrypoint_keeps_suite_and_fails_empty_results(self):
        self.assertEqual(self.execute_script("check-task.sh", [str(self.root), "B043"]), 0)
        record = json.loads((self.root / "artifacts/tasks/B043.json").read_text())
        self.assertEqual(record["test_count"], 1)
        self.assertIn("artifacts/validation/B043.json", record["artifacts"])
        self.stdout = "{}"
        self.assertNotEqual(self.execute_script("check-task.sh", [str(self.root), "B043"]), 0)
        self.assertEqual(json.loads((self.root / "artifacts/tasks/B043.json").read_text())["status"], "failed")

    def test_unified_other_b_handoff_forge_suites_reject_empty_or_skipped_results(self):
        self.write("artifacts/risk/counterpart-status.json", "{}")
        for output in ("{}", '{"suite":{"test_results":{"test()":{"status":"Skipped"}}}}'):
            self.stdout = output
            self.assertNotEqual(self.execute_script("check-task.sh", [str(self.root), "B040"]), 0)

    def test_unified_sdk_suite_rejects_empty_skipped_cancelled_or_incomplete_results(self):
        self.write("packages/risk-sdk/package.json", '{"devDependencies":{"typescript":"5.9.3"}}')
        self.write("packages/risk-sdk/node_modules/typescript/package.json", '{"version":"5.9.3"}')
        self.write("packages/risk-sdk/node_modules/typescript/bin/tsc", "fixture\n")
        self.write("docs/app-state-fixtures.json", "{}")
        self.assertEqual(self.execute_script("check-task.sh", [str(self.root), "B042"]), 0)
        success = self.node_stdout
        for output in ("", success.replace("tests 1", "tests 0").replace("pass 1", "pass 0"),
                       success.replace("pass 1", "pass 0").replace("skipped 0", "skipped 1"),
                       success.replace("cancelled 0", "cancelled 1"), success.replace("todo 0", "todo 1"),
                       success.replace("pass 1", "pass 0")):
            self.node_stdout = output
            self.assertNotEqual(self.execute_script("check-task.sh", [str(self.root), "B042"]), 0)

    def test_unified_a044_requires_current_passing_technical_evidence(self):
        for number in range(1, 44):
            self.write(f"artifacts/tasks/A{number:03d}.json", json.dumps({
                "status": "passed", "exit_code": 0, "test_count": 1, "skipped_count": 0}))
        self.write("docs/runbooks/accounting.md", "runbook\n")
        check_a_review.run_technical_validation(self.root, "A043")
        self.assertEqual(self.execute_script("check-a-handoff.py", ["A044"]), 0)
        manifest = json.loads((self.root / "artifacts/risk/accounting-release.json").read_text())
        self.assertEqual(manifest["status"], "UNIFIED_TECHNICAL_HANDOFF")
        self.assertFalse(manifest["production_approved"])
        self.assertFalse(manifest["independent_audit"])
        for record in ({"status": "blocked", "exit_code": 2, "test_count": 0},
                       {"status": "passed", "exit_code": 0, "test_count": 0},
                       {"status": "passed", "exit_code": 0, "test_count": 1, "skipped_count": 1}):
            self.write("artifacts/tasks/A043.json", json.dumps(record))
            self.assertNotEqual(self.execute_script("check-a-handoff.py", ["A044"]), 0)
        self.write("artifacts/tasks/A043.json", json.dumps(self.task_result))
        self.write("contracts/src/Fixture.sol", "changed\n")
        self.assertNotEqual(self.execute_script("check-a-handoff.py", ["A044"]), 0)

    def prepare_gate(self, gate="G7"):
        for relative in ("reference/common/units.py", "reference/common/result_schema.json",
                         "contracts/src/math/MathTypes.sol", "docs/math/units.md",
                         "docs/math/risk-function-contracts.json", "docs/ownership.json",
                         "docs/counterpart-contracts.md", "reference/fixtures/golden_cases.json",
                         "docs/math/golden-case-rationale.md", f"docs/contracts/{gate}.json",
                         f"contracts/test/gates/{gate}.t.sol"):
            self.write(relative, "{}\n")
        if gate == "G1":
            self.write("reference/integration/combined_trace.py", "fixture\n")
            self.write("reference/tests/integration/test_g1.py", "fixture\n")
            for lane in "ab":
                for number in range(3, 10):
                    self.write(f"reference/tests/{lane}/test_{lane}{number:03d}.py", "fixture\n")
        self.write("docs/spec/gate_status.json", json.dumps({"gates": [{
            "id": f"G{int(gate[1]) - 1}", "status": "passed", "merge_sha": "a" * 40, "reviewed_by": []}]}))
        for task in ("A043", "B043"):
            check_a_review.run_technical_validation(self.root, task)

    def test_unified_g7_keeps_all_tasks_and_never_self_accepts_without_peer_identities(self):
        self.prepare_gate()
        self.assertEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G7"]), 0)
        record = json.loads((self.root / "artifacts/gates/G7.json").read_text())
        tasks = [command[2] for command in self.commands if len(command) == 3 and command[1] == "scripts/check-task.sh"]
        self.assertEqual(tasks, [f"{lane}{number:03d}" for lane in "AB" for number in range(40, 45)])
        self.assertEqual(record["status"], "checks_passed")
        self.assertFalse(record["accepted"])
        self.assertIsNone(record["merge_sha"])
        self.assertEqual(record["reviewed_by"], [])

    def test_unified_g7_still_rejects_missing_or_unrelated_predecessor(self):
        self.prepare_gate()
        self.ancestor_exit = 1
        self.assertNotEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G7"]), 0)
        self.ancestor_exit = 0
        self.write("docs/spec/gate_status.json", '{"gates":[]}')
        self.assertNotEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G7"]), 0)

    def test_unified_g7_rejects_bad_task_records_or_missing_technical_evidence(self):
        self.prepare_gate()
        for record in ({"status": "failed", "exit_code": 1, "test_count": 1},
                       {"status": "passed", "exit_code": 0, "test_count": 0},
                       {"status": "passed", "exit_code": 0, "test_count": 1, "skipped_count": 1}):
            self.task_result = record
            self.assertNotEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G7"]), 0)
        self.task_result = {"status": "passed", "exit_code": 0, "test_count": 1, "skipped_count": 0}
        (self.root / "artifacts/validation/B043.json").unlink()
        self.assertNotEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G7"]), 0)

    def test_unified_rejects_malformed_or_relabeled_stored_evidence(self):
        report = check_a_review.run_technical_validation(self.root, "A043")
        for value in ([], {}, {**report, "independent_review": True}, {**report, "accepted": True},
                      {**report, "source_commit": None}, {**report, "checks_run": 2},
                      {**report, "evidence": "artifacts/reviews/A-on-B.json"},
                      {**report, "suite_results": {}}, {**report, "command": ["forge", "test"]}):
            self.write("artifacts/validation/A043.json", json.dumps(value))
            with self.assertRaises(ValueError):
                check_a_review.validate_technical_validation(self.root, "A043")

    def test_unified_forge_environment_blocks_inherited_filters_and_config_overrides(self):
        self.write("contracts/test/math/A/A010.t.sol", "fixture\n")
        self.write("artifacts/risk/counterpart-status.json", "{}")
        self.prepare_gate()
        self.forge_environments.clear()
        overrides = {name: "untrusted-override" for name in (
            "FOUNDRY_MATCH_TEST", "FOUNDRY_NO_MATCH_TEST", "FOUNDRY_MATCH_CONTRACT",
            "FOUNDRY_NO_MATCH_CONTRACT", "FOUNDRY_MATCH_PATH", "FOUNDRY_NO_MATCH_PATH",
            "FOUNDRY_CONFIG", "FOUNDRY_PROFILE", "FOUNDRY_FUZZ_SEED", "FOUNDRY_FUZZ_RUNS",
            "DAPP_MATCH_TEST", "DAPP_NO_MATCH_TEST", "DAPP_CONFIG", "DAPP_TEST_NUMBER")}
        overrides.update(FORGE_SNAPSHOT_CHECK="true", FORGE_SNAPSHOT_EMIT="true", GOV_TEST_MARKER="retained")
        with patch.dict(os.environ, overrides):
            self.assertEqual(check_a_review.run_technical_validation(self.root, "A043")["status"], "passed")
            for task in ("B040", "A010"):
                self.assertEqual(self.execute_script("check-task.sh", [str(self.root), task]), 0)
            self.assertEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G7"]), 0)
        self.assertEqual(len(self.forge_environments), 5)
        pinned = {"FOUNDRY_PROFILE": "risk", "FOUNDRY_FUZZ_SEED": "0x45524f53"}
        for environment in self.forge_environments:
            self.assertEqual({name: value for name, value in environment.items()
                              if name.upper().startswith(("FOUNDRY_", "DAPP_"))}, pinned)
            self.assertEqual(environment["FORGE_SNAPSHOT_EMIT"], "false")
            self.assertEqual(environment["FORGE_SNAPSHOT_CHECK"], "true")
            self.assertEqual(environment["GOV_TEST_MARKER"], "retained")

    def test_unified_g1_reference_rejects_skips_expected_failures_and_missing_success(self):
        self.prepare_gate("G1")
        self.assertEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G1"]), 0)
        for summary in ("OK (skipped=1)", "OK (expected failures=1)", "FAILED (failures=1)", ""):
            self.reference_stderr = "Ran 1 test in 0.001s\n\n" + summary + "\n"
            self.assertNotEqual(self.execute_script("check-gate.sh", [str(self.root), "bash", "G1"]), 0)

    def test_unified_forge_rejects_global_config_without_reading_or_changing_it(self):
        homes = [self.root / name for name in ("python-home", "shell-home", "windows-home")]
        with patch.object(Path, "home", return_value=homes[0]), \
                patch.dict(os.environ, {"HOME": str(homes[1]), "USERPROFILE": str(homes[2])}):
            self.assertEqual(check_a_review.forge_environment()["FOUNDRY_PROFILE"], "risk")
            for home in homes:
                config = home / ".foundry/foundry.toml"
                config.parent.mkdir(parents=True, exist_ok=True)
                config.write_text("private-fixture-contents\n", encoding="utf-8")
                with patch.object(Path, "read_text", side_effect=AssertionError("Must not read user settings")), \
                        patch.object(Path, "read_bytes", side_effect=AssertionError("Must not read user settings")):
                    with self.assertRaisesRegex(ValueError, "Global Foundry configuration") as raised:
                        check_a_review.forge_environment()
                self.assertNotIn(str(home), str(raised.exception))
                self.assertEqual(config.read_text(encoding="utf-8"), "private-fixture-contents\n")
                config.unlink()


if __name__ == "__main__":
    unittest.main()
