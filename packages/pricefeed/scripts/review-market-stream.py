"""Independent read-only replay of a retained stream-probe REST archive.

Usage: python3 scripts/review-market-stream.py ARCHIVE PROBE_REPORT CONFIG
Raw WebSocket event counters are reported by the probe, not independently replayed.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


def review(archive, report_path, config_path):
    archive = Path(archive).resolve(strict=True)
    report = json.loads(Path(report_path).read_text())
    config = json.loads(Path(config_path).read_text())
    assert report['mode'] == 'READ_ONLY_MARKET_STREAM_PROBE'
    assert report['worker'] == config['key'] and not config['enabled']
    assert report['signaturesProduced'] == report['transactionsSent'] == 0
    assert report['productionApproved'] is False and report['coverageCertified'] is False
    archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert archive_sha == report['sourceArchiveSha256']
    db = sqlite3.connect(archive.as_uri() + '?mode=ro', uri=True)
    try:
        rows = db.execute('select payload,sha256 from captures order by id').fetchall()
    finally:
        db.close()
    assert rows
    counts, timestamps, previous = {}, 0, None
    for payload, sha in rows:
        assert hashlib.sha256(payload.encode()).hexdigest() == sha
        row = json.loads(payload)
        assert row['worker'] == config['key'] and row['category'] == config['category']
        inspection = row['inspection']
        assert inspection['engineObservation'] is None
        counts[inspection['status']] = counts.get(inspection['status'], 0) + 1
        for field in ['event', 'metadata', 'book']:
            capture = row.get(field)
            if capture is not None:
                assert json.loads(capture['body']) == capture['data']
        book, time = row.get('book'), inspection.get('time')
        if book is not None:
            raw = json.loads(book['body'])
            assert raw['asset_id'] == config['mapping']['outcomeTokenId']
            assert raw['market'].lower() == config['mapping']['conditionId'].lower()
        if time is not None:
            stamp = int(book['data']['timestamp'])
            assert stamp == int(time['sourceMs']) and stamp // 1000 == int(time['observedAt'])
            assert previous is None or stamp >= previous
            previous, timestamps = stamp, timestamps + 1
    assert len(rows) == report['captures'] and counts == report['inspections']
    assert report['stream']['connections'] >= 2 and report['stream']['pongs'] >= 2
    generations = [state['generation'] for state in report['states']]
    assert generations == sorted(generations)
    assert any(state['reason'] == 'STREAM_REQUESTED_RECONNECT' for state in report['states'])
    assert report['successful'] and report['evidenceValid'] and report['originalTimestamps']
    return {'method': 'Independent Python SQLite/checksum/raw-body/source-time replay; no TypeScript imports',
            'exitCode': 0, 'capturesChecked': len(rows), 'timestampsChecked': timestamps,
            'twoConnectionsWithDeliberateReconnect': True, 'originalTimestampsVerified': True,
            'sourceArchiveSha256': archive_sha,
            'limitations': ['Stream event counters come from the native-client probe; full raw WebSocket frames were not retained.',
                            'No price calibration, paid submissions or TWAP certification.']}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('ARCHIVE_REPORT_CONFIG_REQUIRED')
    print(json.dumps(review(*sys.argv[1:]), indent=2))
