#!/usr/bin/env python3
"""Verify the preserved baseline; never writes other component files."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parents[3]
baseline=root/'artifacts/pricefeed-reverification/protected-files-before.json'
if not baseline.exists(): raise SystemExit('UNVERIFIED: original protected-file baseline missing')
before=json.loads(baseline.read_text())
# The user removed the untracked source PDF when committing. It is a review
# input, not a protected component. Never recreate it or revise its old hash.
before={p:h for p,h in before.items() if p!='polymarket-event-price-feed-implementation-plan.pdf'}
changed=[p for p,h in before.items() if not (root/p).is_file() or hashlib.sha256((root/p).read_bytes()).hexdigest()!=h]
if changed: raise SystemExit('Protected component files changed: '+', '.join(changed))
diff=subprocess.check_output(['git','diff','--name-only','HEAD'],cwd=root,text=True).splitlines()
outside=[p for p in diff if not p.startswith('packages/pricefeed/')]
if outside: raise SystemExit('Uncommitted changes outside pricefeed: '+', '.join(outside))
print(f'PASS: {len(before)} protected file hashes unchanged; working diff confined to packages/pricefeed/')
