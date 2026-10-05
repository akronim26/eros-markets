import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("local-stack.py")
SPEC = importlib.util.spec_from_file_location("local_stack", MODULE_PATH)
local_stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local_stack)


class LocalEnvironmentTests(unittest.TestCase):
    def test_trade_waits_for_a_recent_confirmed_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "sampler.json"
            report.write_text(json.dumps({"latestValidSample": {"observation": {"t": "100"}}}))
            with patch.object(local_stack, "rpc_call", return_value={"timestamp": hex(112)}):
                self.assertEqual(local_stack.wait_for_recent_sample("http://127.0.0.1:18556", report)["observation"]["t"], "100")

    def test_trade_refuses_stale_or_future_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "sampler.json"
            for timestamp in ["99", "113"]:
                report.write_text(json.dumps({"latestValidSample": {"observation": {"t": timestamp}}}))
                with patch.object(local_stack, "rpc_call", return_value={"timestamp": hex(112)}), patch.object(local_stack.time, "sleep"), self.assertRaisesRegex(RuntimeError, "No recent confirmed sample"):
                    local_stack.wait_for_recent_sample("http://127.0.0.1:18556", report)

    def test_trade_coordination_releases_lock_after_command_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "failed command"):
                with local_stack.sampling_lock(directory):
                    self.assertTrue((Path(directory) / "sampling.lock").exists())
                    raise RuntimeError("failed command")
            self.assertFalse((Path(directory) / "sampling.lock").exists())

    def test_trade_coordination_does_not_remove_a_changed_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sampling.lock"
            with self.assertRaisesRegex(RuntimeError, "OWNER_CHANGED"):
                with local_stack.sampling_lock(directory):
                    path.write_text("another owner", encoding="utf-8")
            self.assertEqual(path.read_text(), "another owner")

    def test_removes_shared_credentials_and_replaces_network_environment(self):
        inherited = {
            "PRIVATE_KEY": "discard",
            "CRE_ETH_PRIVATE_KEY": "discard",
            "ATTESTOR_PRIVATE_KEY": "discard",
            "WATCHDOG_PRIVATE_KEY": "discard",
            "GROQ_API_KEY": "discard",
            "SPORTSDATA_API_KEY_VALUE": "discard",
            "ENVIO_API_TOKEN": "discard",
            "ETH_RPC_URL": "https://example.invalid/private",
            "RPC_URL": "https://example.invalid/private",
            "MONAD_TESTNET_RPC": "https://example.invalid/private",
            "FOUNDRY_PROFILE": "production",
            "FORGE_SNAPSHOT_CHECK": "true",
            "PATH": "tools",
        }
        with patch.dict(os.environ, inherited, clear=True):
            environment = local_stack.local_environment("http://127.0.0.1:18546")
        self.assertNotIn("discard", environment.values())
        self.assertNotIn("https://example.invalid/private", environment.values())
        self.assertEqual(environment["PATH"], "tools")
        self.assertEqual(environment["FOUNDRY_PROFILE"], "integration")
        self.assertEqual(environment["FORGE_SNAPSHOT_EMIT"], "false")
        self.assertNotIn("FORGE_SNAPSHOT_CHECK", environment)
        for name in ("ETH_RPC_URL", "RPC_URL", "FOUNDRY_ETH_RPC_URL"):
            self.assertEqual(environment[name], "http://127.0.0.1:18546")

    def test_rpc_rejects_nonloopback_urls_before_any_network_request(self):
        rejected = (
            "https://example.invalid",
            "http://127.0.0.1.example.invalid:8545",
            "http://user:secret@127.0.0.1:8545",
            "http://127.0.0.1:8545/?target=example",
            "http://192.168.1.2:8545",
            "http://127.0.0.1:8545/path",
        )
        with patch.object(local_stack.urllib.request, "build_opener") as request:
            for endpoint in rejected:
                with self.subTest(endpoint=endpoint), self.assertRaisesRegex(RuntimeError, "Loopback"):
                    local_stack.rpc_call(endpoint, "eth_chainId")
            request.assert_not_called()

    def test_local_rpc_refuses_redirects_instead_of_forwarding_requests(self):
        with self.assertRaisesRegex(RuntimeError, "redirects are forbidden"):
            local_stack.NoRedirect().redirect_request(None, None, 307, "redirect", {}, "https://example.invalid")

    def test_forge_environment_routes_all_overrides_without_changing_services(self):
        direct = local_stack.local_environment("http://127.0.0.1:18546")
        isolated = local_stack.forge_environment(direct, "http://127.0.0.1:18547")
        for name in ("ETH_RPC_URL", "RPC_URL", "FOUNDRY_ETH_RPC_URL"):
            self.assertEqual(isolated[name], "http://127.0.0.1:18547")
            self.assertEqual(direct[name], "http://127.0.0.1:18546")
        self.assertEqual(isolated["FOUNDRY_PROFILE"], "integration")


class RunDirectoryTests(unittest.TestCase):
    def setUp(self):
        parent = local_stack.ROOT / "tmp"
        parent.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="local-stack-unit-", dir=parent)
        self.directory = Path(self.temporary.name).resolve()
        self.assertTrue(self.directory.is_relative_to(parent.resolve()))

    def tearDown(self):
        self.temporary.cleanup()

    def arguments(self, directory):
        return argparse.Namespace(directory=str(directory), rpc_port=18546, read_port=8787, keep_running=False, keep_failed=False)

    def test_run_rejects_directories_outside_ignored_tmp_without_spawning(self):
        with patch.object(local_stack, "require_free_port") as ports, patch.object(local_stack.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "ignored tmp"):
                local_stack.run(self.arguments(local_stack.ROOT / "docs"))
            ports.assert_not_called()
            spawn.assert_not_called()

    def test_run_rejects_proxy_port_conflicts_before_creating_a_run(self):
        arguments = self.arguments(self.directory)
        arguments.read_port = arguments.rpc_port + 1
        with patch.object(local_stack, "require_free_port") as ports, self.assertRaisesRegex(RuntimeError, "reserve RPC port"):
            local_stack.run(arguments)
        ports.assert_not_called()

    def test_run_refuses_existing_journals_and_never_deletes_them(self):
        journal = self.directory / "source.sqlite"
        content = b"existing publisher state must survive"
        journal.write_bytes(content)
        with patch.object(local_stack, "require_free_port") as ports, patch.object(local_stack.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "never reset"):
                local_stack.run(self.arguments(self.directory))
            ports.assert_not_called()
            spawn.assert_not_called()
        self.assertEqual(journal.read_bytes(), content)

    def test_stop_does_not_kill_reused_process_ids_or_remove_artifacts(self):
        journal = self.directory / "source.sqlite"
        journal.write_text("keep me", encoding="utf-8")
        record = {"directory": str(self.directory), "processes": [{"pid": 12345, "identity": "original"}]}
        with patch.object(local_stack, "process_identity", return_value="replacement"), patch.object(local_stack.subprocess, "run") as stop, patch.object(local_stack.os, "kill") as kill:
            local_stack.stop_recorded(record)
            stop.assert_not_called()
            kill.assert_not_called()
        self.assertEqual(journal.read_text(encoding="utf-8"), "keep me")

    def test_stop_only_targets_an_owned_matching_process(self):
        record = {"processes": [{"pid": 12345, "identity": "owned"}, {"pid": 23456, "identity": None}]}
        with patch.object(local_stack, "process_identity", return_value="owned"), patch.object(local_stack.subprocess, "run") as stop, patch.object(local_stack.os, "kill") as kill:
            local_stack.stop_recorded(record)
            if os.name == "nt":
                self.assertEqual(stop.call_count, 1)
                self.assertEqual(stop.call_args.args[0], ["taskkill", "/PID", "12345", "/T", "/F"])
                kill.assert_not_called()
            else:
                self.assertEqual(kill.call_count, 1)
                self.assertEqual(kill.call_args.args[0], 12345)
                stop.assert_not_called()


class LocalClockTests(unittest.TestCase):
    def test_warp_sets_and_checks_absolute_timestamp_with_fixed_block_clock(self):
        with patch.object(local_stack, "rpc_call", side_effect=[None, None, {"timestamp": "0x12d"}]) as request:
            self.assertEqual(local_stack.warp_to("http://127.0.0.1:18546", 301), 301)
        self.assertEqual([call.args[1] for call in request.call_args_list], [
            "evm_setNextBlockTimestamp", "evm_mine", "eth_getBlockByNumber",
        ])
        self.assertEqual(request.call_args_list[0].args[2], [301])

    def test_ineffective_warp_fails_instead_of_claiming_liveness_passed(self):
        with patch.object(local_stack, "rpc_call", side_effect=[None, None, {"timestamp": "0x1"}]), self.assertRaisesRegex(RuntimeError, "did not reach"):
            local_stack.warp_to("http://127.0.0.1:18546", 301)


if __name__ == "__main__":
    unittest.main()
