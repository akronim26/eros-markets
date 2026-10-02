#!/usr/bin/env python3
"""Export compact read-only capture evidence; never rewrites raw snapshots."""
import argparse, collections, hashlib, json, sqlite3
from pathlib import Path

args = argparse.ArgumentParser()
args.add_argument('--db', required=True)
args.add_argument('--out', default='artifacts/source-soak/latest.json')
options = args.parse_args()
database = Path(options.db).resolve()
connection = sqlite3.connect(database.as_uri()+'?mode=ro', uri=True)
records = connection.execute('SELECT payload,sha256 FROM captures ORDER BY id').fetchall()
connection.close()
if not records: raise SystemExit('UNVERIFIED: archive is empty')
if any(hashlib.sha256(payload.encode()).hexdigest()!=digest for payload,digest in records):
    raise SystemExit('FAIL: archive integrity mismatch')
categories = {}
for payload, digest in records:
    record = json.loads(payload); inspection = record['inspection']; category = record['category']
    group = categories.setdefault(category, {'samples': [], 'statusCounts': collections.Counter()})
    group['statusCounts'][inspection['status']] += 1
    raw = {kind: {'url': record[kind]['url'], 'receivedAtMs': record[kind]['receivedAtMs'],
                  'attempts': record[kind]['attempts'],
                  'bodySha256': hashlib.sha256(record[kind]['body'].encode()).hexdigest()}
           for kind in ['event','metadata','book'] if record.get(kind)}
    group['samples'].append({'atMs': record['atMs'], 'configDigest': record['configDigest'],
                            'status': inspection['status'], 'reason': inspection['reason'],
                            'sourceTime': inspection['time'], 'summary': inspection['summary'],
                            'rawEvidence': raw, 'archivePayloadSha256': digest})
output = Path(options.out); output.parent.mkdir(parents=True, exist_ok=True)
report = {'sourceArchive': options.db, 'archiveIntegrity': True, 'captureCount': len(records),
          'mode': 'disabled-market read-only diagnostics', 'categories': categories,
          'productionApproved': False, 'signaturesProduced': 0, 'transactionsSent': 0,
          'limitation': 'Short capture only; no continuous index coverage or production availability claim'}
output.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({category: dict(group['statusCounts']) for category,group in categories.items()}))
