import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("e2e_run", Path(__file__).with_name("run.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class EvidenceSourceTests(unittest.TestCase):
    def test_changed_runtime_helpers_sdks_and_assets_invalidate_browser_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs = ["frontend/src/lib/orders.mjs", "frontend/src/lib/runtime.js",
                      "packages/risk-sdk/src/margin.ts", "oracle/packages/oracle-sdk/src/browser.ts",
                      "frontend/public/logo.svg", "frontend/tsconfig.json", "frontend/postcss.config.mjs",
                      "scripts/e2e/sampler-coordination.mjs"]
            for name in inputs:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original")
            baseline = runner.browser_sources(root)
            self.assertEqual(set(baseline), set(inputs))
            for name in inputs:
                with self.subTest(name=name):
                    (root / name).write_text("modified")
                    changed = runner.browser_sources(root)
                    self.assertNotEqual(baseline[name], changed[name])
                    (root / name).write_text("original")

    def test_evidence_omits_private_environment_journals_and_installed_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in [".env", "frontend/.env.local", "tmp/signer.json", "frontend/node_modules/pkg/index.js"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("private fixture data")
            self.assertEqual(runner.browser_sources(root), {})


if __name__ == "__main__":
    unittest.main()
