#!/usr/bin/env python3
"""Reproducible OS-kill journal drills, with scripted source/chain counterparts."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

package = Path(__file__).resolve().parents[1]
stages = ['COLLECTED', 'ALLOCATED', 'SIGNING', 'SIGNER_RESERVED', 'SIGNER_SIGNED',
          'SIGNED', 'PREPARING', 'TX_SIGNED', 'READY', 'UNKNOWN', 'BROADCAST', 'MINED', 'FINALIZED']
build = subprocess.run(['npm', 'run', 'build'], cwd=package, text=True, capture_output=True)
if build.returncode:
    print(build.stdout); print(build.stderr)
    raise SystemExit(build.returncode)
command = [str(package/'node_modules/node/bin/node'), '--test', '--test-isolation=none',
           '--test-reporter=tap', 'dist/test/recovery.test.js', 'dist/test/local-relay.test.js']
result = subprocess.run(command, cwd=package, text=True, capture_output=True)
counts = {}
for name in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
    matches = re.findall(rf'^# {name} (\d+)\s*$', result.stdout, re.M)
    counts[name] = int(matches[-1]) if matches else None
cases = [json.loads(line.split('RECOVERY_CASE ', 1)[1]) for line in result.stdout.splitlines()
         if line.startswith('RECOVERY_CASE ')]
valid = (result.returncode == 0 and counts['tests'] and counts['tests'] == counts['pass']
         and all(counts[key] == 0 for key in ['fail', 'cancelled', 'skipped', 'todo'])
         and [case['stage'] for case in cases] == stages)
for case in cases:
    valid = valid and (case['sequences'] == ['1', '2'] and case['nonces'] == ['0', '1']
                       and case['broadcastCalls'] == 2 and case['finalState'] == 'FINALIZED'
                       and case['sourceEvidenceValid'] and case['packetEvidenceValid']
                       and case['immutableTransactionRetry'] and case['externalTransactions'] == 0)
target = package/'artifacts/verification'; target.mkdir(parents=True, exist_ok=True)
log = result.stdout + result.stderr
(target/'recovery.tap').write_text(log)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
report = {'tasks': ['PF016', 'PF018', 'PF024', 'PF025'],
          'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=package, text=True).strip(),
          'workingTreeChanges': subprocess.check_output(['git', 'status', '--porcelain'], cwd=package, text=True).splitlines(),
          'buildExitCode': build.returncode, 'command': command, 'exitCode': result.returncode,
          'verified': bool(valid), 'counts': counts, 'cases': cases,
          'tapSha256': sha(target/'recovery.tap'),
          'fileSha256': {str(p.relative_to(package)): sha(p) for folder in ['src', 'test', 'scripts']
                         for p in sorted((package/folder).glob('*')) if p.suffix in ['.ts', '.py']},
          'realComponents': ['Worker', 'Journal', 'PacketStore', 'LocalTestSigner', 'LocalRelay', 'OS SIGKILL'],
          'scriptedComponents': ['source captures', 'transaction signer ledger', 'chain acceptance/receipts/blocks'],
          'clock': 'fixed fixture clock, advances 11 seconds for lease-expired restart; 40 for expiry drill',
          'externalTransactions': 0, 'productionApproved': False, 'humanGateAcceptance': False,
          'limitations': ['Not real Polymarket or a real EVM/RPC crash campaign.',
                          'Does not certify supervisor deployment, disk/power loss or production finality.',
                          'Independent transaction-signer reservations in this campaign are test fixtures, not a production backend.',
                          'Coordinated loss/restore of all archives and signer history remains outside this evidence.']}
(target/'recovery.json').write_text(json.dumps(report, indent=2)+'\n')
print('\n'.join(result.stdout.splitlines()[-9:]))
if not valid:
    print(log)
    raise SystemExit(result.returncode or 1)
print('PASS: thirteen SIGKILL boundaries plus lease/restore/expiry/shared-account regressions; fixture counterparts')
