#!/usr/bin/env python3
"""Summarize completed real-source/local-chain evidence without changing it."""
import datetime, json
from pathlib import Path

package = Path(__file__).resolve().parents[1]
report = json.loads((package/'artifacts/demo/latest.json').read_text())
if not report.get('completed') or not report.get('evidenceIntegrity'):
    raise SystemExit('UNVERIFIED: demo is incomplete or archive integrity failed')
accepted = [attempt for attempt in report['attempts'] if 'accepted' in attempt]
if not accepted: raise SystemExit('UNAVAILABLE: no accepted live-source packet')
if not all(attempt['twap']['verified'] for attempt in accepted):
    raise SystemExit('FAIL: independent index verification missing')

def price(value):
    number = int(value); whole, fraction = divmod(number, 10**18)
    suffix = str(fraction).zfill(18).rstrip('0')
    return str(whole)+('.'+suffix if suffix else '')

last = accepted[-1]; twap = last['twap']; unavailable = len(report['attempts'])-len(accepted)
when = datetime.datetime.fromtimestamp(int(report['startedAtMs'])//1000, datetime.timezone.utc).isoformat()
rows = [f"| {attempt['accepted']['sequence']} | {attempt['accepted']['observedAt']} | {price(attempt['accepted']['priceWad'])} | {attempt['twap']['coveredSecs']} | {attempt['twap']['available']} |"
        for attempt in accepted]
text = f"""# Live Polymarket data into a local demo market

Result: **{report['result']}**. Started {when}.

Flow: real Polymarket event/market/book → validation → depth-N summary → raw test
signature → local `submitObservation` transaction → actual risk ingress/store →
receipt/event/sequence verification → independent 300-second index comparison.

- Source market: {report['sourceConfig']['mapping']['externalMarketId']}; selected
  outcome: {report['sourceConfig']['mapping']['outcomeLabel']}.
- Local chain: 31337; demo receiver: `{report['engineAddress']}`.
- Accepted live-source packets: **{len(accepted)}** of {len(report['attempts'])} attempts;
  unavailable attempts: {unavailable}.
- Latest depth midpoint: **{price(last['accepted']['priceWad'])}**.
- Latest engine index: available **{twap['available']}**, coverage **{twap['coveredSecs']}/300 seconds**,
  TWAP **{price(twap['twapWad']) if twap['available'] else 'unavailable'}**.
- All {len(accepted)} acceptance/index checks matched; archive integrity passed.
- External-chain transactions: **0**. The owned local chain was shut down.

## Evidence and limits

`latest.json` contains demo policies, exact signed observations, transaction hashes,
accepted events, source-body hashes and engine/reference index results.
`source-example.json` preserves the first actual complete book. Full raw captures
are in `{report['sourceArchive']}` (ignored local evidence archive).

Prices and timestamps came from actual public data, with no accelerated time or
fabricated backfill. Diagnostic N/spread/method, quote and time policies remain
unapproved for production. The demo receiver imports real `PriceIngress` and
`ObservationStore`; its initialization is a demo harness. It has no complete
margin/funding/settlement engine, book or oracle. This is local integration
evidence, not a listed production market or human gate acceptance.

## Accepted observations

| Sequence | Source Unix seconds | Depth midpoint | Covered seconds | Index available |
|---|---|---|---|---|
"""+'\n'.join(rows)+'\n'
(package/'artifacts/demo/REPORT.md').write_text(text)
print(f'PASS: report written for {len(accepted)} accepted packets; coverage {twap["coveredSecs"]}/300')
