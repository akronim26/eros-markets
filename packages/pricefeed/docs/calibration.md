# Category calibration and multi-market diagnostics

Original milestone 6 supplies diagnostic PF021/PF022/PF024 evidence. Production
N, spread, cadence, quote/precision/fee assumptions, duration/availability targets
and listing equivalence still need owner review. Category alone cannot admit a
market or select a risk template. No human PF gate is accepted by this work.

## What the tools do

`soak:readonly` runs independent workers through the existing CollectionService,
sharing one 100-ms request-start limiter with a 200-request queue bound. It requires
all three categories, disabled configs, null destinations and before-fee VWAP.
The duration is explicit (360–3,600 seconds), as is a midpoint at which workers
release their leases and the source journal is closed/reopened with a new owner.
This is graceful SQLite/worker restart inside **one OS process**, not a process
crash, backup restore or supervised deployment. It archives every unavailable and
invalid decision. Signals drain in-flight bounded requests; interrupted runs are
labeled and exit nonzero. Existing outputs are never overwritten.

`report:calibration` independently reruns the bot's calculator from that raw
archive for an explicit candidate grid. `verify:calibration` / `verify:soak` use
Python Fraction arithmetic and interval reconstruction, without bot imports, to
check all grid cells, raw-body equality, checksums, mapping/config identity,
source clocks, observed depths/spreads and report provenance. Changed results
fail replay. Keep both collector and offline analysis reports; their hashes bind
the final evidence. Financial values/timing intervals use integers or Fraction.
Percentile ranks use counts only; no floating-point price/depth calculation.

The example grid compares N = 5,000 / 100,000 / 500,000 / 1,000,000 lots
(5 / 100 / 500 / 1,000 claims), spread limits 0.02 / 0.05 / 0.10 WAD, fixed
delivery delays 0 / 5 / 10 seconds and a 1-second remaining margin. These are
explicit diagnostic scenarios, not runtime defaults or measured inclusion times.
The collector's own minimum headroom also applies before delivery projection.

For each usable decision, projected carry starts at collection completion plus
the assumed delivery delay. It ends at the floored vendor timestamp plus 30
seconds, or at the next projected decision, whichever comes first. Missing,
invalid and quarantined decisions cut previous projected carry; repeated vendor
timestamps never extend expiry. The report clips intervals to the last 300,000 ms.
This conservative **source-side projection is not indexTwap300**, a submitted
checkpoint, actual chain acceptance, or full-engine readiness. Actual invalid
checkpoint priority/coalescing and inclusion remain separate reviewed policies.

## Actual six-minute run — 05 October 2026 (local date)

Base commit: `cbbe4dd`. Three workers ran together for **360,458 ms** at a
five-second diagnostic polling interval, with **72 captures each / 216 total**.
At 180 seconds, 108 retained captures survived the graceful journal reopen;
another 108 followed. The independent review passed **108 grid cells**.
Crypto/politics reused their disabled examples. The original sports example was
closed; the disabled replacement was the Yes token of market 741099/event 92909,
“Will LeBron James retire before next NBA season?”. Its public event tags included
sports/NBA. No Eros semantics/horizon/exception mapping approval is implied.

At N=1,000,000 lots, spread=0.05 and an assumed five-second delivery delay:

| Diagnostic source | Healthy / total | Source-age p95 | Projected last-300-second availability |
|---|---:|---:|---:|
| BTC reaches $87,500 in October | 64 / 72 | 45.670 s | 289.987 / 300 s |
| LeBron retirement | 13 / 72 | 204.133 s | 59.843 / 300 s |
| Flávio Bolsonaro wins election | 72 / 72 | 3.718 s | 300 / 300 s |

The crypto failures were seven stale-source decisions and one headroom failure;
sports had 57 stale-source and two headroom failures. Books were plentiful:
the failure was source age, not a lack of displayed depth. Sports had 68 repeated
timestamps and only four advances; crypto had 18 repeats/54 advances; politics
had two repeats/70 advances. These describe the observed book clock, not proof
of trades or a general category guarantee. Quiet/stale and frequently changing
source periods both remain in the evidence. Dedicated longer quiet/active
campaigns under agreed operating targets remain open.

Tighter spread is a separate tradeoff. At N=1,000,000 lots and a ten-second
assumed delay, changing the limit from 0.05 to 0.02 reduced crypto projection
from 284.987 to 211.476 seconds and politics from 300 to 294.960 seconds.
At 0.05, reducing N did not repair the timestamp gaps in this run. Widening the
spread cannot solve stale clocks. Actual fills, fee schedules and quote/collateral
equivalence were not measured, and displayed depth is not guaranteed executable
liquidity. This external-index study does not calibrate the Eros own-perp book;
its independent spread/depth constraints still apply under risk ownership.

**Operating implication:** keep five seconds as a measured diagnostic candidate,
retain original timestamps and reject stale sources. Review actual listings for
continuous source-clock suitability before admitting them. Measure real signing,
RPC, inclusion/finality and safety margin against the 30-second budget before
selecting production cadence; the 5/10-second projections cannot supply those
measurements. No category-wide N/spread setting is selected here.

Compact tracked evidence is `artifacts/calibration/multi-market.json`, with the
disabled run inputs in `artifacts/calibration/inputs.json`. Raw SQLite, full
collector/comparison reports, discovery selection and TAP logs remain ignored
in `var/verification/calibration/`. Another checkout must rerun the public soak
for its own raw archive; hashes alone cannot replay missing bodies. Earlier
archives and the failed paid Monad coverage window remain unchanged.

## Reproduce

From this package with the pinned Node 24 on PATH (use fresh output paths):

```bash
npm run test:calibration
npm run soak:readonly -- artifacts/calibration/inputs.json config/calibration.example.json var/calibration-run/source.sqlite var/calibration-run/collector.json 360 180
npm run report:calibration -- artifacts/calibration/inputs.json config/calibration.example.json var/calibration-run/source.sqlite var/calibration-run/collector.json var/calibration-run/comparison.json
npm run verify:soak -- var/calibration-run/source.sqlite var/calibration-run/comparison.json artifacts/calibration/inputs.json config/calibration.example.json var/calibration-run/collector.json
```

Historical source IDs may become closed/stale; keep such outcomes visible and
prepare separate disabled diagnostic inputs rather than erasing evidence.
No keys/signers/relay adapters are loaded by either runner. **Zero signatures,
transactions or MON spend** occurred in this public run. Sustained paid Monad
coverage/gap recovery remains deferred/unpassed; original milestone 7 is next:
supervised deployment preparation with persistent storage and restart handling.
