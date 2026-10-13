import importlib.util
import copy
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("probe_local_api", Path(__file__).with_name("probe-local-api.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_separate_scenario_pointers_and_explicit_run(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(probe.runtime_path(root, "leveraged").name, "local-leverage-latest.json")
        self.assertEqual(probe.runtime_path(root, "fully-backed").name, "local-integration-latest.json")
        explicit = root / "tmp" / "run" / "runtime.json"
        self.assertEqual(probe.runtime_path(root, "leveraged", explicit), explicit)
        with self.assertRaises(RuntimeError):
            probe.runtime_path(root, "leveraged", root / "runtime.json")

    def test_public_manifest_rejects_private_transports_at_any_depth(self):
        probe.check_public_manifest({"manifestVersion": 1, "contracts": {}})
        for value in [{}, {"manifestVersion": 1, "rpcUrl": "secret"},
                      {"manifestVersion": 1, "contracts": {"entry": {"privateKey": "secret"}}},
                      {"manifestVersion": 1, "contracts": {"entry": {"private_key": "secret"}}},
                      {"manifestVersion": 1, "contracts": {"entry": {"rpc_url": "secret"}}},
                      {"manifestVersion": 1, "contracts": {"entry": {"api_token": "secret"}}}]:
            with self.assertRaises(RuntimeError):
                probe.check_public_manifest(value)

    def test_exported_manifest_must_match_the_verified_snapshot_identities(self):
        market = {"name": "demo", "engine": "0xabc", "marketId": "0x123", "sourceId": "0x222", "listingHash": "0x456", "codehash": "0x789"}
        manifest = {"manifestVersion": 1, "chainId": 31337, "markets": [market], "accounts": {},
                    "sourceMode": "fixture", "riskScenario": "leveraged-fixture", "contracts": {"Vault": {"address": "0xabc"}},
                    "provenance": {"collateral": "fixture", "resolution": "fixture", "index": "fixture", "calibration": "synthetic"}}
        enrolled = {**copy.deepcopy(manifest), "rpcUrl": "http://127.0.0.1:18556"}
        runtime = {"sourceMode": "fixture"}
        snapshot = copy.deepcopy(manifest)
        snapshot["markets"][0]["engine"] = "0xABC"
        probe.check_manifest_snapshot(manifest, snapshot, enrolled, runtime)
        for field in ("name", "engine", "marketId", "sourceId", "listingHash", "codehash"):
            changed = copy.deepcopy(snapshot)
            changed["markets"][0][field] = "substituted"
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, "differs"):
                probe.check_manifest_snapshot(manifest, changed, enrolled, runtime)
        for chain in (143, 10143):
            with self.assertRaisesRegex(RuntimeError, "differs"):
                probe.check_manifest_snapshot(manifest, {**snapshot, "chainId": chain}, enrolled, runtime)
        for field, value in [("sourceMode", "polymarket"), ("provenance", {"calibration": "empirical"}),
                             ("riskScenario", "fully-backed"), ("sourceCommit", "substituted")]:
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, "differs"):
                probe.check_manifest_snapshot(manifest, {**snapshot, field: value}, enrolled, runtime)
        with self.assertRaisesRegex(RuntimeError, "enrollment"):
            probe.check_manifest_snapshot({**manifest, "contracts": {}}, snapshot, enrolled, runtime)
        with self.assertRaisesRegex(RuntimeError, "requested runtime"):
            probe.check_manifest_snapshot(manifest, snapshot, enrolled, {"sourceMode": "polymarket"})


if __name__ == "__main__":
    unittest.main()
