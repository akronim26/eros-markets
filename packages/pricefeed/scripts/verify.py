#!/usr/bin/env python3
"""Evidence for local checks. A zero-test runner is a failure, never acceptance."""
import datetime, hashlib, json, re, subprocess
from pathlib import Path

package = Path(__file__).resolve().parents[1]
checks = []
for name in ['typecheck', 'test:reference', 'test', 'check:wire', 'check:scope', 'test:engine']:
    result = subprocess.run(['npm', 'run', name], cwd=package, text=True, capture_output=True)
    print(result.stdout if name != 'test' or result.returncode else '\n'.join(result.stdout.splitlines()[-9:]))
    if result.stderr: print(result.stderr)
    check = {'command': ['npm', 'run', name], 'exitCode': result.returncode}
    if name == 'test':
        count = re.search(r'(?m)^# tests (\d+)\s*$', result.stdout)
        totals = {label: re.search(rf'(?m)^# {label} (\d+)\s*$', result.stdout)
                  for label in ['fail','cancelled','skipped','todo']}
        check['tests'] = int(count[1]) if count else 0
        if not count or int(count[1]) == 0 or any(not total or int(total[1]) != 0 for total in totals.values()):
            check['exitCode'] = result.returncode or 1
            check['reason'] = 'nonempty passing TAP test suite required'
    checks.append(check)
    if check['exitCode']: break
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=package, text=True).strip()
dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', 'packages/pricefeed'], cwd=package.parents[1], text=True).splitlines()
sources = {str(path.relative_to(package)): hashlib.sha256(path.read_bytes()).hexdigest()
           for folder in ['src', 'test', 'scripts', 'config', 'fixtures', 'reference']
           for path in (package/folder).rglob('*') if path.is_file()
           and not any(part in {'out', 'cache', '__pycache__'} for part in path.parts)}
report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'headCommit': head, 'workingTreeChanges': dirty, 'checks': checks,
          'sourceSha256': sources, 'humanGatesAccepted': False,
          'productionReady': False, 'liveTransactions': 0}
output = package/'artifacts/verification'; output.mkdir(parents=True, exist_ok=True)
(output/'checks.json').write_text(json.dumps(report, indent=2)+'\n')
raise SystemExit(next((check['exitCode'] for check in checks if check['exitCode']), 0))
