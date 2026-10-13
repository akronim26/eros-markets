#!/usr/bin/env python3
"""Declared local workloads with actual bot classes and scripted venue/RPC."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess

package = Path(__file__).resolve().parents[1]
expected = {'independent-collection', 'slow-rpc-two-rounds', 'queued-expiry-and-recovery',
            'rpc-timeout-late-completion', 'continuous-queue-expiry', 'provider-backpressure', '100-worker-drain'}
build = subprocess.run(['npm', 'run', 'build'], cwd=package, text=True, capture_output=True)
if build.returncode:
    print(build.stdout); print(build.stderr)
    raise SystemExit(build.returncode)
command = [str(package/'node_modules/node/bin/node'), '--test', '--test-isolation=none', '--test-reporter=tap',
           'dist/test/load.test.js', 'dist/test/pipeline.test.js', 'dist/test/service.test.js']
result = subprocess.run(command, cwd=package, text=True, capture_output=True)
counts = {}
for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
    matches = re.findall(rf'^# {key} (\d+)\s*$', result.stdout, re.M)
    counts[key] = int(matches[-1]) if matches else None
cases = [json.loads(line.split('LOAD_CASE ', 1)[1]) for line in result.stdout.splitlines() if line.startswith('LOAD_CASE ')]
valid = (result.returncode == 0 and counts['tests'] and counts['tests'] == counts['pass']
         and all(counts[key] == 0 for key in ['fail', 'cancelled', 'skipped', 'todo'])
         and len(cases) == 7 and {case['scenario'] for case in cases} == expected)
for case in cases:
    case['minHeadroomAtBroadcastMs'] = min(map(int, case['headroomAtBroadcastMs']), default=None)
    case['maxSourceAgeAtBroadcastMs'] = max(map(int, case['sourceAgeAtBroadcastMs']), default=None)
    case['maxElapsedSinceSigningAtSimulationMs'] = max(map(int, case['elapsedSinceSigningAtSimulationMs']), default=None)
    valid = valid and (case['externalTransactions'] == 0 and case['sourceEvidenceValid']
                       and case['packetEvidenceValid'] and case['sourceActive'] == 0 and case['rpcActive'] == 0)
target = package/'artifacts/verification';target.mkdir(parents=True, exist_ok=True)
log = result.stdout + result.stderr;(target/'load.tap').write_text(log)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
report = {'tasks': ['PF012', 'PF018', 'PF024', 'PF025'],
          'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=package, text=True).strip(),
          'buildExitCode': build.returncode, 'command': command, 'exitCode': result.returncode,
          'verified': bool(valid), 'counts': counts, 'cases': cases, 'tapSha256': sha(target/'load.tap'),
          'fileSha256': {str(p.relative_to(package)): sha(p) for folder in ['src','test','scripts']
                         for p in sorted((package/folder).glob('*')) if p.suffix in ['.ts','.py']},
          'workload': {'workerCounts': [3,8,12,20,25,100], 'categories': ['crypto','sports','politics'],
                       'limiterIntervalMs': 1, 'providerBurstLimit': 4, 'sourceDelayMs': [0,1],
                       'rpcDelayMs': [0,3], 'rpcTimeoutMs': 2000, 'leaseMs': 60000,
                       'minimumHeadroomMs': 1000, 'injectedExpiryOffsetMs': 31000},
          'realComponents': ['Worker', 'RequestLimiter', 'CollectionService', 'Journal', 'PacketStore',
                             'LocalTestSigner', 'LocalRelay', 'LocalPipeline'],
          'scriptedComponents': ['source REST captures', 'RPC simulation/broadcast/blocks/receipts'],
          'clock': 'monotonic elapsed ms plus explicit offset in two expiry cases',
          'externalTransactions': 0, 'productionApproved': False, 'humanGateAcceptance': False,
          'limitations': ['Short synthetic workloads, not real Polymarket load, Monad throughput or an availability soak.',
                          'All timing includes fixture setup, source requests, crypto/SQLite and processing; no isolated production throughput claim.',
                          'Elapsed since signing at simulation includes queue/retry and local processing, not a pure queue-length measurement.',
                          'Source freshness is asserted at fixture broadcast; actual network inclusion, finality and cross-IP rate limits are unmeasured.',
                          'Independent collection tests do not prove collection is decoupled from publication in the joined service.']}
(target/'load.json').write_text(json.dumps(report, indent=2)+'\n')
print('\n'.join(result.stdout.splitlines()[-9:]))
if not valid:
    print(log)
    raise SystemExit(result.returncode or 1)
print('PASS: seven declared load/slow-RPC scenarios plus pipeline/service regressions; fixture capacity only')
