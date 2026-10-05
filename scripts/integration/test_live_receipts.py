import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('live_audit', Path(__file__).with_name('audit-live-run.py'))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class LiveStateEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.actors = {'engine': '0x11', 'listingHash': '0x22', 'trade': {'blockHash': '0x33'},
                       'postTradeSample': {'transactionHash': '0x44'}}
        self.snapshot = {'block': {'hash': '0x55'}}
        self.source = {'passed': True, 'canonicalReceiptsVerified': True}
        self.state = {'mode': 'LOCAL_LIVE_STATE_AUDIT', 'passed': True, 'chainId': 31337,
                      'publicTransactions': 0, 'canonicalOwnerStatesVerified': True,
                      'collateralAndCashVerifiedFromTransactions': True,
                      'engine': '0x11', 'listingHash': '0x22', 'trade': {'block': {'hash': '0x33'}},
                      'finalState': {'block': {'hash': '0x55'}}, 'actualPostTradeSample': {'hash': '0x44'},
                      'inputSha256': {}}
        for name, filename, value in [('manifest', 'manifest.json', {'chainId': 31337}),
                                       ('actors', 'live-actors.json', self.actors),
                                       ('snapshot', 'snapshot-final.json', self.snapshot),
                                       ('pricefeed', 'pricefeed-audit.json', self.source)]:
            path = self.directory / filename
            path.write_text(json.dumps(value), encoding='utf-8')
            self.state['inputSha256'][name] = hashlib.sha256(path.read_bytes()).hexdigest()

    def save(self):
        (self.directory / 'live-state-audit.json').write_text(json.dumps(self.state), encoding='utf-8')

    def check(self):
        return audit.check_state_audit(self.directory, self.actors, self.snapshot, self.source)

    def test_accepts_exact_input_bound_canonical_state_evidence(self):
        self.save()
        self.assertEqual(self.check(), self.state)

    def test_refuses_cached_proof_when_any_input_changes(self):
        self.save()
        for filename in ['manifest.json', 'live-actors.json', 'snapshot-final.json', 'pricefeed-audit.json']:
            path = self.directory / filename
            content = path.read_bytes()
            path.write_bytes(content + b' ')
            with self.subTest(filename=filename), self.assertRaisesRegex(RuntimeError, 'input changed'):
                self.check()
            path.write_bytes(content)

    def test_refuses_incomplete_or_different_chain_evidence(self):
        for key, value in [('passed', False), ('canonicalOwnerStatesVerified', False),
                           ('collateralAndCashVerifiedFromTransactions', False), ('chainId', 10143),
                           ('publicTransactions', 1)]:
            old = self.state[key]
            self.state[key] = value
            self.save()
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'missing or incomplete'):
                self.check()
            self.state[key] = old

    def test_refuses_mismatched_checkpoint_or_source_assertion(self):
        for container, key in [(self.state, 'engine'), (self.state, 'listingHash'),
                               (self.state['trade']['block'], 'hash'),
                               (self.state['finalState']['block'], 'hash'),
                               (self.state['actualPostTradeSample'], 'hash')]:
            old = container[key]
            container[key] = '0xff'
            self.save()
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'checkpoints do not bind'):
                self.check()
            container[key] = old
        self.save()
        self.source['canonicalReceiptsVerified'] = False
        with self.assertRaisesRegex(RuntimeError, 'checkpoints do not bind'):
            self.check()

    def test_invokes_read_only_bun_auditor_with_explicit_inputs_and_no_env_loading(self):
        with patch.dict(audit.os.environ, {'LOCAL_BUN': 'pinned-bun'}), patch.object(audit.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            audit.ensure_state_audit(self.directory)
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ['pinned-bun', '--no-env-file', 'services/local-integration/src/audit-live.ts'])
        self.assertEqual(command[3:], [str(self.directory / name) for name in
                                      ['manifest.json', 'live-actors.json', 'snapshot-final.json', 'pricefeed-audit.json', 'live-state-audit.json']])
        self.assertEqual(run.call_args.kwargs['cwd'], Path(__file__).resolve().parents[2] / 'oracle')
        self.assertTrue(run.call_args.kwargs['capture_output'])

    def test_preserves_bun_failure_and_never_substitutes_report_only_checks(self):
        result = SimpleNamespace(returncode=1, stdout='partial output\n', stderr='LIVE_AUDIT_ACTUAL_POSITION_MISMATCH')
        with patch.dict(audit.os.environ, {'LOCAL_BUN': 'pinned-bun'}), patch.object(audit.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'Canonical live-state audit failed'):
                audit.ensure_state_audit(self.directory)
        self.assertIn('ACTUAL_POSITION_MISMATCH', (self.directory / 'live-state-audit.log').read_text())
        self.assertFalse((self.directory / 'live-state-audit.json').exists())

    def test_existing_evidence_skips_reexecution_but_still_requires_binding_check(self):
        self.save()
        with patch.object(audit.subprocess, 'run') as run:
            audit.ensure_state_audit(self.directory)
        run.assert_not_called()
        self.assertEqual(self.check(), self.state)


if __name__ == '__main__':
    unittest.main()
