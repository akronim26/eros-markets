"""Real SQLite/WAL/flock/file drills; all keys and records are temporary fixtures."""
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1]/'scripts/backup-journals.py'
spec = importlib.util.spec_from_file_location('backup_journals', SCRIPT)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BackupDrills(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pricefeed-backup-')
        self.root = Path(self.temp.name)
        self.state = self.root/'state'; self.state.mkdir(mode=0o700)
        self.keys = self.root/'keys'; self.keys.mkdir(mode=0o700)
        self.profile_file = self.root/'profile.json'
        self.bundle = self.root/'backup'
        self.connections = []
        self.setup_profile(False)

    def tearDown(self):
        for db in self.connections:
            db.close()
        self.temp.cleanup()

    def setup_profile(self, monad):
        mode = 'MONAD_TESTNET' if monad else 'READ_ONLY_COLLECTION'
        inputs = {}
        for name in (['config', 'rules', 'abi', 'policy'] if monad else ['configs']):
            file = self.root/(name+'.json'); file.write_text('{}')
            inputs[name] = {'path': str(file), 'sha256': b.digest(file.read_bytes())}
        self.profile = {'schemaVersion': '1', 'mode': mode, 'stateDirectory': str(self.state), 'inputs': inputs,
                        'testnet': {'journalDirectory': str(self.state), 'keysDirectory': str(self.keys),
                                    'notAfterMs': '1', 'durationSeconds': 1} if monad else None}
        # Expired campaign remains preservable; backup must never renew it.
        self.profile_file.write_text(json.dumps(self.profile))
        (self.state/'service.lock').touch(mode=0o600, exist_ok=True)
        status = {'phase': 'OPERATOR_STOP', 'restarts': 3, 'reason': 'SERVICE_RESTART_LIMIT'}
        (self.state/'supervision.json').write_text(json.dumps({'state': status, 'sha256': b.digest(json.dumps(status, indent=2).encode())}))
        (self.state/'service.json').write_text(json.dumps({'mode': mode, 'inputs': inputs, 'testnet': self.profile['testnet'],
                                                        'campaignDeadlineMs': '1' if monad else None}))
        for name in (b.JOURNALS if monad else ['source']):
            file = self.state/(name+'.sqlite')
            if file.exists():
                continue
            db = sqlite3.connect(file)
            for table in b.TABLES[name]:
                if table == 'captures':
                    db.execute('CREATE TABLE captures (id INTEGER PRIMARY KEY, payload TEXT, sha256 TEXT)')
                elif table in ('writers', 'packet_workers', 'relay_nonce'):
                    db.execute('CREATE TABLE '+table+' (until_ms TEXT)')
                    db.execute('INSERT INTO '+table+" VALUES ('0')")
                elif table == 'packets':
                    db.execute('CREATE TABLE packets(body TEXT,sha256 TEXT,signature TEXT,signature_sha256 TEXT)')
                elif table == 'signer_reservations':
                    db.execute('CREATE TABLE signer_reservations(identity TEXT,digest TEXT,signature TEXT,sha256 TEXT)')
                elif table == 'transaction_reservations':
                    db.execute('CREATE TABLE transaction_reservations(request TEXT,raw TEXT,tx_hash TEXT,sha256 TEXT)')
                elif table == 'deliveries':
                    db.execute('CREATE TABLE deliveries(body TEXT,sha256 TEXT)')
                else:
                    db.execute('CREATE TABLE '+table+' (fixture TEXT)')
            db.commit(); db.close()
        for name in b.CUSTODY:
            file = self.keys/name
            file.write_bytes(b'public-test-only-placeholder-'+name.encode()); file.chmod(0o600)

    def make(self, custody=False):
        result = b.backup(self.profile_file, self.bundle, custody)
        b.verify(self.bundle, result['manifestSha256'])
        return result['manifestSha256']

    def test_committed_wal_rows_are_preserved_and_restore_never_activates(self):
        db = sqlite3.connect(self.state/'source.sqlite')
        db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
        payload = '{"fixture":"committed only in WAL"}'
        db.execute('INSERT INTO captures VALUES(1,?,?)', (payload, b.digest(payload.encode()))); db.commit()
        self.connections.append(db)
        self.assertGreater((self.state/'source.sqlite-wal').stat().st_size, 0)
        pin = self.make(); candidate = self.root/'candidate'
        result = b.restore_review(self.bundle, pin, candidate)
        self.assertFalse(result['activationApproved'])
        check = sqlite3.connect(candidate/'journals/source.sqlite')
        self.assertEqual(check.execute('SELECT payload FROM captures').fetchone()[0], payload); check.close()
        self.assertTrue((candidate/'RESTORE_REVIEW_REQUIRED.json').exists())
        self.assertEqual(json.loads((candidate/'control/supervision.json').read_text())['state']['phase'], 'OPERATOR_STOP')
        print('BACKUP_CASE '+json.dumps({'scenario':'wal-backup-and-isolated-restore','committedWalPreserved':True,'activationApproved':False,'transactionsSent':0}))

    def test_five_journal_set_and_both_custody_roles_are_preserved_without_unlock(self):
        self.setup_profile(True); pin = self.make(True)
        manifest = b.verify(self.bundle, pin)
        self.assertEqual(set(manifest['databaseRows']), set(b.JOURNALS))
        self.assertTrue(manifest['custodyIncluded'])
        for name in b.CUSTODY:
            self.assertEqual((self.bundle/'custody'/name).read_bytes(), (self.keys/name).read_bytes())
            self.assertEqual((self.bundle/'custody'/name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.bundle/'control/profile.json').read_text())['testnet']['notAfterMs'], '1')
        print('BACKUP_CASE '+json.dumps({'scenario':'five-journals-and-two-custody-roles','journals':5,'custodyFiles':4,'keysUnlocked':0,'campaignDeadlineRenewed':False}))

    def test_service_lock_and_active_leases_refuse_a_backup(self):
        with (self.state/'service.lock').open('r+') as locked:
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'BACKUP_SERVICE_RUNNING'):
                self.make()
        db = sqlite3.connect(self.state/'source.sqlite'); db.execute("UPDATE writers SET until_ms='999999999999999'"); db.commit(); db.close()
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_ACTIVE_LEASE'):
            self.make()
        self.assertFalse(self.bundle.exists())

    def test_independent_cli_writer_transaction_is_not_bypassed(self):
        db = sqlite3.connect(self.state/'source.sqlite'); db.execute('BEGIN IMMEDIATE'); self.connections.append(db)
        with self.assertRaises(sqlite3.OperationalError):
            self.make()
        self.assertFalse(self.bundle.exists())

    def test_missing_journal_and_corrupt_application_record_fail_before_bundle_creation(self):
        self.setup_profile(True); (self.state/'transactions.sqlite').unlink()
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_FILE_MISSING'):
            self.make()
        self.assertFalse(self.bundle.exists())
        self.setup_profile(True)
        db = sqlite3.connect(self.state/'source.sqlite'); db.execute("INSERT INTO captures VALUES(1,'{}','bad')"); db.commit(); db.close()
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_RECORD_CORRUPT'):
            self.make()

    def test_changed_or_mixed_files_and_manifest_tampering_fail_external_pin(self):
        pin = self.make()
        archive = self.bundle/'journals/source.sqlite'; original = archive.read_bytes(); archive.write_bytes(b'other snapshot')
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_FILE_PIN_MISMATCH'):
            b.verify(self.bundle, pin)
        archive.write_bytes(original)
        (self.bundle/'manifest.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_MANIFEST_PIN_MISMATCH'):
            b.verify(self.bundle, pin)

    def test_existing_destination_partial_failure_and_nested_destination_are_never_adopted(self):
        self.bundle.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_DESTINATION_EXISTS'):
            self.make()
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_SEPARATE_DESTINATION_REQUIRED'):
            b.backup(self.profile_file, self.state/'nested')

    def test_symlink_hardlink_and_public_custody_files_are_rejected(self):
        self.setup_profile(True)
        file = self.keys/'signer-password'; file.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_PRIVATE_FILE_REQUIRED'):
            b.read_private(file, True)
        file.chmod(0o600); os.link(file, self.keys/'alias')
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_UNSAFE_FILE'):
            b.read_private(file, True)
        alias = self.root/'alias'; alias.symlink_to(self.keys, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_UNSAFE_PATH'):
            b.read_private(alias/'transaction-password', True)

    def test_disk_full_leaves_no_complete_manifest_and_never_deletes_originals(self):
        before = (self.state/'source.sqlite').read_bytes()
        with patch.object(b, 'write_private', side_effect=OSError(errno.ENOSPC, 'fixture disk full')):
            with self.assertRaises(OSError):
                self.make()
        self.assertFalse((self.bundle/'manifest.json').exists())
        self.assertEqual((self.state/'source.sqlite').read_bytes(), before)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_DESTINATION_EXISTS'):
            self.make()

    def test_restore_refuses_existing_or_active_location_and_does_not_roll_back_current_history(self):
        pin = self.make(); before = (self.state/'source.sqlite').read_bytes()
        with self.assertRaises(RuntimeError):
            b.restore_review(self.bundle, pin, self.state)
        existing = self.root/'existing'; existing.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_DESTINATION_EXISTS'):
            b.restore_review(self.bundle, pin, existing)
        self.assertEqual((self.state/'source.sqlite').read_bytes(), before)

    def test_cli_errors_are_fixed_codes_without_paths_or_key_material(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'backup', '/private/secret-rpc-value', str(self.bundle)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1); self.assertEqual(result.stderr.strip(), 'BACKUP_FAILED')
        self.assertNotIn('/private/', result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
