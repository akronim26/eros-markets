import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
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
        with patch.object(local_stack, "process_identity", side_effect=["owned", None]), patch.object(local_stack.subprocess, "run") as stop, patch.object(local_stack.os, "kill") as kill:
            result = local_stack.stop_recorded(record)
            if os.name == "nt":
                self.assertEqual(stop.call_count, 1)
                self.assertEqual(stop.call_args.args[0], ["taskkill", "/PID", "12345", "/T", "/F"])
                kill.assert_not_called()
            else:
                self.assertEqual(kill.call_count, 1)
                self.assertEqual(kill.call_args.args[0], 12345)
                stop.assert_not_called()
        self.assertFalse(result["stopped"])
        self.assertIn("identity is missing", result["processes"][0]["errors"][0])

    def test_stubborn_recorded_root_is_reported_unverified_after_budget(self):
        record = {"processes": [{"pid": 12345, "identity": "owned"}]}
        with patch.object(local_stack, "process_identity", return_value="owned"), \
                patch.object(local_stack.subprocess, "run"), patch.object(local_stack.os, "kill"):
            result = local_stack.stop_recorded(record, timeout=.02)
        self.assertFalse(result["stopped"])
        self.assertIn("still exists", result["processes"][0]["errors"][0])
        self.assertFalse(result["descendantsVerified"])

    def test_identity_query_failure_does_not_target_process_or_claim_stop(self):
        record = {"processes": [{"pid": 12345, "identity": "owned"}]}
        with patch.object(local_stack, "process_identity", side_effect=RuntimeError("identity denied")), \
                patch.object(local_stack.subprocess, "run") as stop, patch.object(local_stack.os, "kill") as kill:
            result = local_stack.stop_recorded(record)
        self.assertFalse(result["stopped"])
        self.assertIn("identity denied", result["processes"][0]["errors"][0])
        stop.assert_not_called()
        kill.assert_not_called()

    def test_actual_owned_background_leaf_is_stopped_and_waited(self):
        process = local_stack.subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)"],
                                              stdin=local_stack.subprocess.DEVNULL, stdout=local_stack.subprocess.DEVNULL,
                                              stderr=local_stack.subprocess.DEVNULL, creationflags=local_stack.HIDDEN)
        try:
            identity = local_stack.process_identity(process.pid)
            self.assertTrue(identity)
            result = local_stack.stop_recorded({"processes": [{"pid": process.pid, "identity": identity}]}, timeout=5)
            self.assertTrue(result["stopped"], result)
            process.wait(timeout=1)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    def failed_source_command(self, error):
        arguments = self.arguments(self.directory)
        arguments.scenario, arguments.source = "leveraged", "polymarket"

        def output(argv, **_kwargs):
            if argv[0] == "git":
                return "base-commit\n" if argv[1] == "rev-parse" else ""
            return {"forge": "forge Version: 1.8.3\n", "anvil": "anvil Version: 1.8.3\n",
                    "node": "v24.21.0\n", "bun": "1.3.13\n"}[str(argv[0])]

        with patch.object(local_stack, "require_free_port"), \
                patch.object(local_stack, "LIVE_LATEST", self.directory / "test-latest.json"), \
                patch.object(local_stack, "executable", side_effect=lambda _variable, _pinned, fallback: fallback), \
                patch.object(local_stack, "source_fingerprints", return_value={"fixture": "hash"}), \
                patch.object(local_stack.subprocess, "check_output", side_effect=output), \
                patch.object(local_stack, "OwnedProcess", side_effect=error), \
                self.assertRaises(FileNotFoundError):
            local_stack.run(arguments)
        steps = json.loads((self.directory / "steps.json").read_text())
        return steps, json.loads((self.directory / "runtime.json").read_text())

    def test_failed_source_command_is_retained_even_when_process_cannot_start(self):
        steps, runtime = self.failed_source_command(FileNotFoundError("test missing executable"))
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["step"], "source-probe")
        self.assertEqual(steps[0]["exitCode"], 1)
        self.assertIsNone(steps[0]["processExitCode"])
        self.assertEqual(steps[0]["failure"]["type"], "FileNotFoundError")
        self.assertEqual(runtime["status"], "failed-and-stopped")

    def test_unconfirmed_startup_cleanup_preserves_failure_without_claiming_stopped(self):
        error = FileNotFoundError("original startup failure")
        error.owned_process_cleanup = {"stopped": False, "errors": ["injected cleanup failure"]}
        steps, runtime = self.failed_source_command(error)
        self.assertEqual(steps[0]["failure"]["message"], "original startup failure")
        self.assertFalse(steps[0]["cleanup"]["stopped"])
        self.assertEqual(runtime["status"], "failed-cleanup-unverified")
        self.assertEqual(runtime["cleanupFailures"][0]["step"], "source-probe")


class SourceEvidenceTests(unittest.TestCase):
    def test_runtime_abi_is_bound_after_compilation_and_tampering_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in local_stack.RUNTIME_ARTIFACT_NAMES:
                path = root / f"oracle/out/{name}.sol/{name}.json"
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({"abi": [{"type": "function", "name": "original"}]}), encoding="utf-8")
            run = root / "run"
            run.mkdir()
            bound = local_stack.archive_runtime_artifacts(run, root)
            source = local_stack.source_fingerprints(root)
            local_stack.verify_source_fingerprints(run, source, root, bound)
            changed = root / "oracle/out/RegistryBookRiskEngine.sol/RegistryBookRiskEngine.json"
            changed.write_text('{"abi": []}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "source changed"):
                local_stack.verify_source_fingerprints(run, source, root, bound)
            archived = json.loads((run / "runtime-artifacts/RegistryBookRiskEngine.json").read_text())
            self.assertEqual(archived["abi"][0]["name"], "original")

    def test_runtime_inputs_are_bound_without_environment_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "oracle/src/integration/RolloverBatcher.sol"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"contract Example {}\r\n")
            abi = root / "artifacts/risk/book-risk-engine-abi.json"
            abi.parent.mkdir(parents=True)
            abi.write_text('{"abi": []}', encoding="utf-8")
            (root / ".env").write_text("PRIVATE_KEY=never-read", encoding="utf-8")
            initial = local_stack.source_fingerprints(root)
            self.assertEqual(list(initial), ["artifacts/risk/book-risk-engine-abi.json", "oracle/src/integration/RolloverBatcher.sol"])
            source.write_bytes(b"contract Example {}\n")
            local_stack.verify_source_fingerprints(root, initial, root)
            source.write_bytes(b"contract Changed {}\n")
            with self.assertRaisesRegex(RuntimeError, "source changed"):
                local_stack.verify_source_fingerprints(root, initial, root)
            report = json.loads((root / "source-integrity.json").read_text())
            self.assertFalse(report["passed"])
            self.assertEqual(report["changedFiles"], ["oracle/src/integration/RolloverBatcher.sol"])

    def test_added_and_deleted_runtime_code_invalidates_the_launch_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "scripts/integration/runtime.py"
            script.parent.mkdir(parents=True)
            script.write_text("pass\n", encoding="utf-8")
            initial = local_stack.source_fingerprints(root)
            script.rename(script.with_name("replacement.py"))
            with self.assertRaisesRegex(RuntimeError, "source changed"):
                local_stack.verify_source_fingerprints(root, initial, root)
            self.assertEqual(json.loads((root / "source-integrity.json").read_text())["changedFiles"],
                             ["scripts/integration/replacement.py", "scripts/integration/runtime.py"])


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
