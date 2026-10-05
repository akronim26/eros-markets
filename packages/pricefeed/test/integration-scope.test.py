#!/usr/bin/env python3
"""Versioned input gate must catch drift while allowing unrelated user documents."""
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

CHECK = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/check-integration-scope.py"))


class IntegrationScopeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.put(CHECK["HISTORICAL"], '{"historical":"unchanged"}\n')
        CHECK["git"](self.root, "add", CHECK["HISTORICAL"])
        CHECK["git"](self.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "historical fixture")
        self.put("contracts/src/Engine.sol", "contract Engine {}\n")
        source, exact = CHECK["inventories"](self.root)
        self.manifest = {"schemaVersion": 1, "scope": "LOCAL_CROSS_COMPONENT_INTEGRATION_2026_10_06",
            "historicalBaseline": CHECK["HISTORICAL"], **CHECK["historical_identity"](self.root),
            "humanGatesAccepted": False, "productionApproved": False, "externalChainTransactions": 0,
            "authorization": {"reference": "docs/integration/INTEGRATION_READINESS.md"},
            "inputRoots": CHECK["INPUT_ROOTS"], "inputFiles": CHECK["INPUT_FILES"], "submoduleCommits": {},
            "sourceTextNormalization": "UTF8_CRLF_TO_LF_ONLY",
            "normalizedSourceTextSha256": source, "exactRawFileSha256": exact}

    def tearDown(self):
        self.temporary.cleanup()

    def put(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding="utf8")

    def test_exact_inputs_and_unrelated_user_document(self):
        self.put("docs/requests/user-handoff.md", "unrelated user work\n")
        self.assertEqual(CHECK["check"](self.root, self.manifest), 1)

    def test_changed_source_rejected(self):
        self.put("contracts/src/Engine.sol", "contract Changed {}\n")
        with self.assertRaisesRegex(AssertionError, "integration input changed"):
            CHECK["check"](self.root, self.manifest)

    def test_new_source_rejected(self):
        self.put("oracle/src/New.sol", "contract New {}\n")
        with self.assertRaisesRegex(AssertionError, "inventory changed"):
            CHECK["check"](self.root, self.manifest)

    def test_missing_source_rejected(self):
        (self.root / "contracts/src/Engine.sol").unlink()
        with self.assertRaisesRegex(AssertionError, "inventory changed"):
            CHECK["check"](self.root, self.manifest)

    def test_historical_evidence_is_not_rebased(self):
        self.put(CHECK["HISTORICAL"], '{"historical":"rewritten"}')
        with self.assertRaisesRegex(AssertionError, "historical PF baseline changed"):
            CHECK["check"](self.root, self.manifest)

    def test_git_clone_source_checkout_line_endings(self):
        self.put("scripts/check-task.sh", "#!/usr/bin/env bash\nset -e\n")
        self.manifest["normalizedSourceTextSha256"]["scripts/check-task.sh"] = CHECK["source_digest"](self.root / "scripts/check-task.sh")
        CHECK["git"](self.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "contracts/src/Engine.sol", "scripts/check-task.sh")
        CHECK["git"](self.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        for ending in ("true", "false"):
            with tempfile.TemporaryDirectory() as clone:
                subprocess.run(["git", "-c", f"core.autocrlf={ending}", "clone", "-q", str(self.root), clone], check=True)
                cloned = Path(clone)
                raw = (cloned / "contracts/src/Engine.sol").read_bytes()
                self.assertEqual(b"\r\n" in raw, ending == "true")
                self.assertEqual(CHECK["check"](cloned, self.manifest), 2)

    def test_binary_fixture_mutation_rejected_without_normalization(self):
        path = "packages/pricefeed/fixtures/body.bin"
        target = self.root / path
        target.parent.mkdir(parents=True)
        target.write_bytes(b"body\r\n\0\xff")
        self.manifest["exactRawFileSha256"][path] = CHECK["digest"](target)
        self.assertEqual(CHECK["check"](self.root, self.manifest), 2)
        target.write_bytes(b"body\n\0\xff")
        with self.assertRaisesRegex(AssertionError, "integration input changed"):
            CHECK["check"](self.root, self.manifest)

    def test_text_body_fixture_remains_byte_exact(self):
        path = "packages/pricefeed/fixtures/body.json"
        target = self.root / path
        target.parent.mkdir(parents=True)
        target.write_bytes(b'{"body":"vendor"}\r\n')
        self.manifest["exactRawFileSha256"][path] = CHECK["digest"](target)
        self.assertEqual(CHECK["check"](self.root, self.manifest), 2)
        target.write_bytes(b'{"body":"vendor"}\n')
        with self.assertRaisesRegex(AssertionError, "integration input changed"):
            CHECK["check"](self.root, self.manifest)


if __name__ == "__main__":
    unittest.main()
