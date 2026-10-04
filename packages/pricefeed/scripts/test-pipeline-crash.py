#!/usr/bin/env python3
"""Pinned owned-chain campaign. No external RPC/key/deployment arguments."""
import hashlib, json, os, re, subprocess
from pathlib import Path

package = Path(__file__).resolve().parents[1]
versions = {}
for variable, fallback, pattern in [('PRICEFEED_FORGE', 'forge', r'Version: 1\.8\.3(?:\s|$)'),
                                  ('PRICEFEED_ANVIL', 'anvil', r'Version: 1\.8\.3(?:\s|$)'),
                                  ('PRICEFEED_SOLC', 'solc', r'Version: 0\.8\.30\+')]:
    executable = os.environ.get(variable, fallback)
    result = subprocess.run([executable, '--version'], text=True, capture_output=True, check=True)
    if not re.search(pattern, result.stdout):
        raise SystemExit(f'UNVERIFIED: incorrect {variable} version: {result.stdout.strip()}')
    versions[variable] = result.stdout.strip()
subprocess.run(['npm', 'run', 'build'], cwd=package, check=True)
subprocess.run([os.environ.get('PRICEFEED_FORGE', 'forge'), 'build', '--root', 'test/demo',
                '--use', os.environ.get('PRICEFEED_SOLC', 'solc')], cwd=package, check=True)
environment = {**os.environ, 'PRICEFEED_TOOL_VERSIONS': json.dumps(versions),
               'PRICEFEED_BASE_COMMIT': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=package, text=True).strip()}
command = [str(package/'node_modules/node/bin/node'), 'dist/scripts/pipeline-crash-local.js']
result = subprocess.run(command, cwd=package, env=environment, text=True, capture_output=True)
target = package/'artifacts/verification'; target.mkdir(parents=True, exist_ok=True)
(target/'pipeline-crash.log').write_text(result.stdout + result.stderr)
report_path = target/'pipeline-crash.json'
if report_path.exists():
    report = json.loads(report_path.read_text())
    report.update(command=command, exitCode=result.returncode,
                  nodeVersion=subprocess.check_output([command[0], '--version'], text=True).strip(),
                  logSha256=hashlib.sha256((target/'pipeline-crash.log').read_bytes()).hexdigest())
    report['fileSha256'] = {str(p.relative_to(package)): hashlib.sha256(p.read_bytes()).hexdigest()
                           for folder in ['src', 'test', 'scripts'] for p in sorted((package/folder).glob('*'))
                           if p.suffix in ['.ts', '.py']}
    report_path.write_text(json.dumps(report, indent=2)+'\n')
print(result.stdout); print(result.stderr)
raise SystemExit(result.returncode)
