import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("integrated_preflight", Path(__file__).with_name("preflight-integrated.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class IntegratedPreflightBoundaryTest(unittest.TestCase):
    def test_loopback_rehearsal_boundary(self):
        for endpoint in ("http://127.0.0.1:18580", "http://localhost:18580/", "http://[::1]:18580"):
            self.assertEqual(preflight.local_endpoint(endpoint), endpoint)
        for endpoint in ("https://127.0.0.1", "http://testnet-rpc.monad.xyz", "http://127.0.0.1@public.example",
                         "http://localhost/proxy", "http://localhost?remote=true", "http://localhost#remote"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                preflight.local_endpoint(endpoint)

    def test_rehearsal_missing_explicit_local_rpc_or_config_never_launches(self):
        with patch.object(preflight.subprocess, "run") as launch:
            for args in (["--rehearse-local", "--output", "tmp/unused.json"],
                         ["--rehearse-local", "--config", "input.json", "--rpc", "https://testnet-rpc.monad.xyz", "--output", "tmp/unused.json"]):
                with self.assertRaises(SystemExit):
                    preflight.main(args)
            launch.assert_not_called()

    def test_report_cannot_overwrite_input_or_write_outside_tmp(self):
        with patch.object(preflight.subprocess, "run") as launch:
            for args in (["--output", "oracle/deployments/monad-testnet.json"],
                         ["--config", "tmp/input.json", "--output", "tmp/input.json"]):
                with self.assertRaises(SystemExit):
                    preflight.main(args)
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
