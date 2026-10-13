#!/usr/bin/env python3
"""Compile and run the explicitly local demo; no production RPC argument exists."""
import json, os, re, subprocess, sys
from pathlib import Path

package = Path(__file__).resolve().parents[1]
versions = {}
for variable, fallback, pattern in [('PRICEFEED_FORGE','forge',r'Version: 1\.8\.3(?:\s|$)'),
    ('PRICEFEED_SOLC','solc',r'Version: 0\.8\.30\+'),
    ('PRICEFEED_ANVIL','anvil',r'Version: 1\.8\.3(?:\s|$)')]:
    executable = os.environ.get(variable, fallback)
    try: result = subprocess.run([executable,'--version'],text=True,capture_output=True,check=True)
    except (OSError,subprocess.CalledProcessError): raise SystemExit(f'UNVERIFIED: set {variable} to the pinned executable')
    if not re.search(pattern,result.stdout): raise SystemExit(f'UNVERIFIED: incorrect {variable} version: {result.stdout.strip()}')
    versions[variable] = result.stdout.strip()
subprocess.run([os.environ.get('PRICEFEED_FORGE','forge'),'build','--root','test/demo',
    '--use',os.environ.get('PRICEFEED_SOLC','solc')],cwd=package,check=True)
arguments = sys.argv[1:]
runner = 'demo-live'
if arguments and arguments[0] == '--pipeline':
    runner = 'pipeline-local'
    arguments = arguments[1:]
environment = {**os.environ, 'PRICEFEED_TOOL_VERSIONS': json.dumps(versions)}
raise SystemExit(subprocess.run(['node',f'dist/scripts/{runner}.js',*arguments],cwd=package,env=environment).returncode)
