#!/usr/bin/env python3
"""Pinned, local-only tests importing the real ingress without editing it."""
import hashlib, json, os, re, subprocess
from pathlib import Path

package = Path(__file__).resolve().parents[1]
forge = os.environ.get('PRICEFEED_FORGE', 'forge')
solc = os.environ.get('PRICEFEED_SOLC', 'solc')

def version(executable, pattern):
    try:
        result = subprocess.run([executable, '--version'], capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'UNVERIFIED: cannot run {executable}: {error}')
    if not re.search(pattern, result.stdout):
        raise SystemExit(f'UNVERIFIED: incorrect pinned tool version: {result.stdout.strip()}')
    return result.stdout.strip()

versions = {'forge': version(forge, r'Version: 1\.8\.3(?:\s|$)'),
            'solc': version(solc, r'Version: 0\.8\.30\+')}
command = [forge, 'test', '--root', 'test/integration', '--use', solc,
           '--match-contract', '^(PricefeedIngressTest|PricefeedLifecycleTest)$', '--json']
result = subprocess.run(command, cwd=package, capture_output=True, text=True)
if result.returncode:
    print(result.stdout); print(result.stderr)
    raise SystemExit(result.returncode)
try:
    suites = json.loads(result.stdout)
    tests = [test for suite in suites.values() for test in suite['test_results'].values()]
except (ValueError, KeyError, TypeError) as error:
    raise SystemExit(f'UNVERIFIED: cannot parse Forge results: {error}')
if len(tests) != 8 or any(test['status'] != 'Success' for test in tests):
    raise SystemExit('UNVERIFIED: expected eight passing owned ingress/lifecycle tests')
report = {'command': command, 'exitCode': result.returncode, 'tests': len(tests),
          'toolVersions': versions, 'environment': 'local test VM only',
          'riskImplementation': 'real PriceIngress, ObservationStore and InvalidPrice imports; package-owned test compositions',
          'testGroups': {'wireAndShortWindow': 4, 'signed24HourLifecycle': 4},
          'scriptedCounterparts': ['MockResolutionAuthority', 'MockAccountingPort', 'MockBookAdapter'],
          'clock': 'accelerated Foundry VM, not live-source elapsed time',
          'wireFixtureSha256': hashlib.sha256((package/'fixtures/wire.json').read_bytes()).hexdigest(),
          'liveTransactions': 0, 'humanGatesAccepted': False}
output = package/'artifacts/verification'
output.mkdir(parents=True, exist_ok=True)
(output/'engine.json').write_text(json.dumps(report, indent=2)+'\n')
print(f'PASS: {len(tests)} local tests against actual risk ingress/store; no live transactions')
