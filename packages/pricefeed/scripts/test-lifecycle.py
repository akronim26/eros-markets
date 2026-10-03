#!/usr/bin/env python3
"""Evidence for accelerated signed 24-hour history; no network or live deployment."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

package = Path(__file__).resolve().parents[1]
root = package.parents[1]
forge = os.environ.get('PRICEFEED_FORGE', 'forge')
solc = os.environ.get('PRICEFEED_SOLC', 'solc')
versions = {}
for name, executable, pattern in [('forge', forge, r'Version: 1\.8\.3(?:\s|$)'),
                                  ('solc', solc, r'Version: 0\.8\.30\+')]:
    try:
        output = subprocess.run([executable, '--version'], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'UNVERIFIED: cannot run pinned {name}: {error}')
    if not re.search(pattern, output):
        raise SystemExit(f'UNVERIFIED: incorrect {name} version: {output.strip()}')
    versions[name] = output.strip()
command = [forge, 'test', '--root', 'test/integration', '--use', solc,
           '--match-contract', 'PricefeedLifecycleTest', '--json']
result = subprocess.run(command, cwd=package, capture_output=True, text=True)
if result.returncode:
    print(result.stdout); print(result.stderr)
    raise SystemExit(result.returncode)
try:
    suites = json.loads(result.stdout)
    tests = {name: test['status'] for suite in suites.values() for name, test in suite['test_results'].items()}
except (ValueError, KeyError, TypeError) as error:
    raise SystemExit(f'UNVERIFIED: malformed Forge result: {error}')
if len(tests) != 4 or any(status != 'Success' for status in tests.values()):
    raise SystemExit(f'FAIL: expected four passing signed lifecycle tests: {tests}')
paths = ['packages/pricefeed/test/integration/test/PricefeedLifecycle.t.sol',
         'contracts/src/pricing/PriceIngress.sol', 'contracts/src/pricing/ObservationStore.sol',
         'contracts/src/settlement/InvalidPrice.sol', 'contracts/test/risk/B/B035.t.sol']
report = {'task': 'PF023', 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'baseGitSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
          'command': command, 'cwd': str(package), 'exitCode': result.returncode, 'tests': tests,
          'toolVersions': versions, 'fileSha256': {p: hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths},
          'source': 'deterministic fixtures, not Polymarket', 'clock': 'accelerated Foundry VM',
          'realComponents': ['PriceIngress', 'ObservationStore', 'InvalidPrice', 'RiskContextPort'],
          'scriptedCounterparts': ['MockResolutionAuthority', 'MockAccountingPort', 'MockBookAdapter'],
          'fixture': {'scheduledT': 1864000, 'earlyHaltAt': 1691200, 'cadenceSecs': 20,
                      'fullWindowSecs': 86400, 'fullPacketCount': 4321, 'exactTwapWad': '520000000000000000',
                      'gappedPacketCount': 4317, 'gappedCoverageSecs': 86330, 'thinCoverageSecs': 86380},
          'externalTransactions': 0, 'humanGatesAccepted': False, 'liveSoakClaimed': False}
target = package/'artifacts/verification/lifecycle.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(report, indent=2)+'\n')
print('PASS: four signed 24-hour lifecycle fixtures against real risk modules; no live-soak claim')
