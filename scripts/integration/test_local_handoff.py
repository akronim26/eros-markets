import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("export-local-handoff.py")
SPEC = importlib.util.spec_from_file_location("local_handoff", MODULE_PATH)
local_handoff = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local_handoff)


class SourceAllowlistTests(unittest.TestCase):
    def test_accepts_only_scoped_source_files_including_public_fixture_key_code(self):
        for path in (
            "oracle/services/keeper/src/config.ts",
            "oracle/services/panel-runner/src/models/client.ts",
            "oracle/services/keeper/test/fixture-keys.ts",
            "oracle/services/local-integration/package.json",
            "oracle/services/panel-runner/src/prompts/templates/.gitattributes",
            "scripts/integration/test_local_handoff.py",
            "oracle/bun.lock",
        ):
            with self.subTest(path=path):
                self.assertTrue(local_handoff.allowed(path))

    def test_rejects_private_runtime_and_unknown_binary_artifacts(self):
        for path in (
            "oracle/services/keeper/.env", "oracle/services/keeper/.env.local",
            "oracle/services/keeper/testnet-keys.env", "oracle/services/keeper/credentials.json",
            "oracle/services/keeper/provider-tokens.json", "oracle/services/keeper/private-key.txt",
            "oracle/services/keeper/keystore/account.json", "oracle/services/keeper/wallet.json",
            "oracle/services/keeper/keys/sender.json", "oracle/services/keeper/source.sqlite",
            "oracle/services/keeper/private.pem", "oracle/services/keeper/backup.zip",
            "oracle/services/keeper/run.log", "oracle/services/keeper/notes.dat",
            "oracle/services/keeper/node_modules/library/index.ts",
            "scripts/integration/__pycache__/local-stack.pyc", "oracle/services/keeper/var/report.json",
            "docs/requests/unrelated.md", "PRIVATE_KEY.env",
        ):
            with self.subTest(path=path):
                self.assertFalse(local_handoff.allowed(path))

    def test_rejects_absolute_and_noncanonical_paths(self):
        for path in ("/tmp/config.ts", "C:/tmp/config.ts", "../config.ts", "oracle/services/keeper/../config.ts",
                     "oracle//services/keeper/config.ts", "oracle\\services\\keeper\\config.ts", "", "."):
            with self.subTest(path=path):
                self.assertFalse(local_handoff.allowed(path))


class SourcePathTests(unittest.TestCase):
    def setUp(self):
        parent = local_handoff.ROOT / "tmp"
        parent.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="handoff-unit-", dir=parent)
        self.directory = Path(self.temporary.name).resolve()
        self.assertTrue(self.directory.is_relative_to(parent.resolve()))
        self.root = self.directory / "repository"
        self.root.mkdir()
        self.source = self.root / "source.ts"
        self.source.write_text("export const fixture = true\n", encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_regular_source_and_deleted_tracked_paths_are_safe(self):
        self.assertEqual(local_handoff.source_path("source.ts", self.root), self.source)
        missing = local_handoff.source_path("deleted.ts", self.root, allow_missing=True)
        self.assertFalse(missing.exists())
        with self.assertRaises(FileNotFoundError):
            local_handoff.source_path("deleted.ts", self.root)
        with self.assertRaises(ValueError):
            local_handoff.source_path(".", self.root)

    def symlink(self, target, link, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            self.skipTest(f"Symlink creation unavailable on this platform: {error}")

    def test_rejects_file_symlinks_even_when_the_target_is_inside_the_repository(self):
        link = self.root / "linked.ts"
        self.symlink(self.source, link)
        with self.assertRaisesRegex(ValueError, "linked"):
            local_handoff.source_path("linked.ts", self.root)

    def test_rejects_an_ancestor_link_to_an_outside_directory(self):
        outside = self.directory / "outside"
        outside.mkdir()
        (outside / "config.ts").write_text("fixture", encoding="utf-8")
        self.symlink(outside, self.root / "linked", directory=True)
        with self.assertRaisesRegex(ValueError, "linked"):
            local_handoff.source_path("linked/config.ts", self.root)

    def test_rejects_broken_symlinks_even_for_deleted_file_mode(self):
        self.symlink(self.directory / "missing", self.root / "broken.ts")
        with self.assertRaisesRegex(ValueError, "linked"):
            local_handoff.source_path("broken.ts", self.root, allow_missing=True)


if __name__ == "__main__":
    unittest.main()
