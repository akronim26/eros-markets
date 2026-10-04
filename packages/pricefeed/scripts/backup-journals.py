#!/usr/bin/env python3
"""Private, offline diagnostic bundles. Never unlock keys or activate a restore."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time

JOURNALS = ['source', 'packets', 'signer', 'transactions', 'relay']
CUSTODY = ['observation-signer.json', 'signer-password', 'transaction-signer.json', 'transaction-password']
TABLES = {'source': ['writers', 'captures'], 'packets': ['packet_workers', 'packets'],
          'signer': ['signer_fences', 'signer_reservations'],
          'transactions': ['transaction_signer', 'transaction_reservations'],
          'relay': ['relay_nonce', 'relay_signer', 'relay_control', 'deliveries']}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_path(path, missing=False):
    path = Path(os.path.abspath(path))
    for parent in reversed(path.parents):
        require(stat.S_ISDIR(parent.lstat().st_mode), 'BACKUP_UNSAFE_PATH')
    parent = path.parent.stat()
    require(parent.st_uid == os.getuid() and parent.st_mode & 0o077 == 0, 'BACKUP_PRIVATE_PARENT_REQUIRED')
    if path.exists() or path.is_symlink():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(), 'BACKUP_UNSAFE_FILE')
    else:
        require(missing, 'BACKUP_FILE_MISSING')
    return path


def read_private(path, secret=False):
    path = private_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(info.st_nlink == 1 and info.st_uid == os.getuid() and stat.S_ISREG(info.st_mode), 'BACKUP_UNSAFE_FILE')
        require(not secret or info.st_mode & 0o077 == 0, 'BACKUP_PRIVATE_FILE_REQUIRED')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def write_private(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_path(path, True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def flush_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def database(path, readonly=True):
    private_path(path)
    for suffix in ('-wal', '-shm'):
        private_path(str(path) + suffix, True)
    return sqlite3.connect(path.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=1, isolation_level=None)


def verify_database(db, name):
    require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'BACKUP_DATABASE_CORRUPT')
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    require(set(TABLES[name]) <= names, 'BACKUP_SCHEMA_MISMATCH')
    db.row_factory = sqlite3.Row
    for table, formula in [('captures', lambda r: r['payload']), ('packets', lambda r: r['body']),
                           ('signer_reservations', lambda r: f"{r['identity']}:{r['digest']}:{r['signature'] or ''}"),
                           ('transaction_reservations', lambda r: f"{r['request']}:{r['raw'] or ''}:{r['tx_hash'] or ''}"),
                           ('deliveries', lambda r: r['body']), ('relay_budget_audit', lambda r: r['body']),
                           ('nonce_recoveries', lambda r: r['body'])]:
        if table in names:
            for row in db.execute('SELECT * FROM ' + table):
                require(digest(formula(row).encode()) == row['sha256'], 'BACKUP_RECORD_CORRUPT')
                if table == 'packets' and row['signature'] is not None:
                    require(digest(row['signature'].encode()) == row['signature_sha256'], 'BACKUP_RECORD_CORRUPT')
    return {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in sorted(names) if not table.startswith('sqlite_')}


def bundle_files(mode, custody):
    names = JOURNALS if mode == 'MONAD_TESTNET' else ['source']
    inputs = ['config', 'rules', 'abi', 'policy'] if mode == 'MONAD_TESTNET' else ['configs']
    return {*(f'journals/{n}.sqlite' for n in names), *(f'inputs/{n}.json' for n in inputs),
            *(f'control/{n}' for n in ['profile.json', 'service.json', 'supervision.json']),
            *(f'custody/{n}' for n in CUSTODY if custody)}


def backup(profile_file, destination, custody=False):
    profile_bytes = Path(profile_file).read_bytes()  # public profile; never a key path
    profile = json.loads(profile_bytes)
    mode = profile['mode']
    require(profile['schemaVersion'] == '1' and mode in ('READ_ONLY_COLLECTION', 'MONAD_TESTNET'), 'BACKUP_BAD_PROFILE')
    require(not custody or mode == 'MONAD_TESTNET', 'BACKUP_TESTNET_CUSTODY_ONLY')
    state = Path(profile['stateDirectory'])
    root = Path(profile['testnet']['journalDirectory']) if mode == 'MONAD_TESTNET' else state
    require(state.is_absolute() and root.is_absolute(), 'BACKUP_ABSOLUTE_PATH_REQUIRED')
    destination = Path(os.path.abspath(destination))
    for origin in [state, root, *([Path(profile['testnet']['keysDirectory'])] if mode == 'MONAD_TESTNET' else [])]:
        require(not destination.is_relative_to(origin), 'BACKUP_SEPARATE_DESTINATION_REQUIRED')
    require(not destination.exists() and not destination.is_symlink(), 'BACKUP_DESTINATION_EXISTS')
    private_path(destination, True)
    lock_path = private_path(state/'service.lock')
    lock = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    guards = []
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('BACKUP_SERVICE_RUNNING') from None
        names = JOURNALS if mode == 'MONAD_TESTNET' else ['source']
        for name in names:
            db = database(root/(name+'.sqlite'), False)
            guards.append(db)
            db.execute('BEGIN IMMEDIATE')  # Hold every journal against concurrent CLI writers.
            verify_database(db, name)
            table = {'source': 'writers', 'packets': 'packet_workers', 'relay': 'relay_nonce'}.get(name)
            if table:
                require(all(int(r[0]) <= time.time_ns()//1000000 for r in db.execute('SELECT until_ms FROM '+table)), 'BACKUP_ACTIVE_LEASE')
        controls = {'profile.json': profile_bytes, **{n: read_private(state/n) for n in ['service.json', 'supervision.json']}}
        supervision = json.loads(controls['supervision.json'])
        # math.json uses preserved field order and two-space pretty JSON.
        body = json.dumps(supervision['state'], indent=2, ensure_ascii=False).encode()
        require(digest(body) == supervision['sha256'], 'BACKUP_SUPERVISION_CORRUPT')
        marker = json.loads(controls['service.json'])
        require(marker['mode'] == mode and marker['inputs'] == profile['inputs'] and marker['testnet'] == profile['testnet'], 'BACKUP_MARKER_MISMATCH')
        expected_inputs = ['config', 'rules', 'abi', 'policy'] if mode == 'MONAD_TESTNET' else ['configs']
        require(set(profile['inputs']) == set(expected_inputs), 'BACKUP_INPUT_PIN_MISMATCH')
        inputs = {n: Path(profile['inputs'][n]['path']).read_bytes() for n in expected_inputs}
        require(all(digest(data) == profile['inputs'][n]['sha256'] for n, data in inputs.items()), 'BACKUP_INPUT_PIN_MISMATCH')
        destination.mkdir(mode=0o700)  # Existing parent required; never adopts partial state.
        checks = {}
        for name in names:
            target = destination/'journals'/(name+'.sqlite')
            write_private(target, b'')
            src = database(root/(name+'.sqlite'))
            dst = sqlite3.connect(target)
            try:
                deadline = time.monotonic()+60
                def progress(_status, _remaining, _total):
                    require(time.monotonic() < deadline, 'BACKUP_COPY_TIMEOUT')
                src.backup(dst, pages=256, progress=progress, sleep=0.01)
                checks[name] = verify_database(dst, name)
            finally:
                dst.close()
                src.close()
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        for name, data in controls.items():
            write_private(destination/'control'/name, data)
        for name, data in inputs.items():
            write_private(destination/'inputs'/(name+'.json'), data)
        if custody:
            for name in CUSTODY:
                write_private(destination/'custody'/name, read_private(Path(profile['testnet']['keysDirectory'])/name, True))
        require(Path(profile_file).read_bytes() == profile_bytes and all(read_private(state/n) == data for n, data in controls.items() if n != 'profile.json'), 'BACKUP_CONTROL_CHANGED')
        files = bundle_files(mode, custody)
        manifest = {'schemaVersion': '1', 'mode': mode, 'createdAtMs': str(time.time_ns()//1000000), 'custodyIncluded': custody,
                    'activationApproved': False, 'files': {n: digest(read_private(destination/n)) for n in sorted(files)}, 'databaseRows': checks}
        for folder in {destination/n.split('/')[0] for n in files}:
            flush_dir(folder)
        write_private(destination/'manifest.json', (json.dumps(manifest, indent=2)+'\n').encode())
        flush_dir(destination)
        flush_dir(destination.parent)
        return {'event': 'BACKUP_COMPLETE', 'manifestSha256': digest(read_private(destination/'manifest.json')), 'custodyIncluded': custody, 'activationApproved': False}
    finally:
        for db in reversed(guards):
            db.close()  # Rolls back only our empty write transactions; never edits a lease.
        os.close(lock)


def verify(bundle, expected):
    bundle = Path(os.path.abspath(bundle))
    raw = read_private(bundle/'manifest.json')
    require(bool(re.fullmatch('[a-f0-9]{64}', expected)) and digest(raw) == expected, 'BACKUP_MANIFEST_PIN_MISMATCH')
    manifest = json.loads(raw)
    require(manifest['schemaVersion'] == '1' and manifest['mode'] in ('READ_ONLY_COLLECTION', 'MONAD_TESTNET')
            and type(manifest['custodyIncluded']) is bool and manifest['activationApproved'] is False, 'BACKUP_BAD_MANIFEST')
    require(set(manifest['files']) == bundle_files(manifest['mode'], manifest['custodyIncluded']), 'BACKUP_INCOMPLETE_SET')
    for name, pinned in manifest['files'].items():
        require(digest(read_private(bundle/name)) == pinned, 'BACKUP_FILE_PIN_MISMATCH')
        if name.startswith('journals/'):
            db = database(bundle/name)
            try:
                require(verify_database(db, Path(name).stem) == manifest['databaseRows'][Path(name).stem], 'BACKUP_ROW_MISMATCH')
            finally:
                db.close()
    return manifest


def restore_review(bundle, expected, destination):
    manifest = verify(bundle, expected)
    destination = Path(os.path.abspath(destination))
    profile = json.loads(read_private(Path(bundle)/'control/profile.json'))
    for origin in [Path(bundle), Path(profile['stateDirectory']), *([Path(profile['testnet']['journalDirectory']), Path(profile['testnet']['keysDirectory'])] if profile['testnet'] else [])]:
        require(not destination.is_relative_to(origin), 'BACKUP_SEPARATE_DESTINATION_REQUIRED')
    require(not destination.exists() and not destination.is_symlink(), 'BACKUP_DESTINATION_EXISTS')
    private_path(destination, True)
    destination.mkdir(mode=0o700)
    for name in [*manifest['files'], 'manifest.json']:
        write_private(destination/name, read_private(Path(bundle)/name))
    verify(destination, expected)
    write_private(destination/'RESTORE_REVIEW_REQUIRED.json', b'{"activationApproved":false,"chainReconciliationRequired":true}\n')
    for folder in {destination/n.split('/')[0] for n in manifest['files']}:
        flush_dir(folder)
    flush_dir(destination)
    flush_dir(destination.parent)
    return {'event': 'RESTORE_CANDIDATE_VERIFIED', 'activationApproved': False, 'keysUnlocked': 0, 'transactionsSent': 0}


if __name__ == '__main__':
    try:
        args = sys.argv[1:]
        if len(args) in (3, 4) and args[0] == 'backup' and (len(args) == 3 or args[3] == '--include-testnet-custody'):
            result = backup(args[1], args[2], len(args) == 4)
        elif len(args) == 3 and args[0] == 'verify':
            verify(args[1], args[2]); result = {'event': 'BACKUP_VERIFIED', 'activationApproved': False}
        elif len(args) == 4 and args[0] == 'restore-review':
            result = restore_review(args[1], args[2], args[3])
        else:
            raise RuntimeError('BACKUP_BAD_ARGUMENTS')
        print(json.dumps(result))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('BACKUP_[A-Z_]+', str(error)) else 'BACKUP_FAILED'
        print(code, file=sys.stderr)
        raise SystemExit(1)
