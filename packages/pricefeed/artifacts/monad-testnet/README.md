# Standalone pricefeed receiver — Monad testnet, 04 October 2026

Receiver: `0xd2d82fed32fb9a911300e7d928607755bd101773` (chain 10143).
Transaction: `0xd3d23d6a6c301ebe79431987d900690ea623ad1dddf6364bd234664def2a77ea`.
User signed creation with the browser wallet; agent prepared and verified it.
All build/deployment work stayed in `/tmp/eros-pricefeed-monad`.

Public evidence only. No private key, encrypted key or unlock material is included.

| File | Purpose |
|---|---|
| receiver-deployment.json | Actual address, signer, code/ABI/input hashes and source archive hash |
| market-config.json | Pinned disabled diagnostic configuration for existing preflight/monitor |
| receiver-abi.json / receiver-artifact.json | Concrete ABI and compiler build artifact |
| receiver-source.tar.gz | Exact public receiver/test/dependency/config snapshots, excluding secrets/tools |
| rules.json | Candidate diagnostic source-rules manifest |
| receiver-tests.json / preparation.json | Ten passing local Monad-VM tests and source/evidence hashes |
| rpc-estimate.json | Real public RPC deployment gas/fee estimate; no broadcast |
| page-checks.json | Local HTTP route/host/token checks; no wallet automation claimed |
| deployment-receipt.json | Successful canonical/finalized contract-creation receipt |
| preflight.json | Actual deployed runtime/listing/source checks at a named finalized block |
| live-monitor.json | Four actual read-only checkpoints; clean exit and journal integrity |
| publication-policy.json | Selected finite pilot's sender, gas/fee and total reservation caps |
| publication-pilot.json | Three actual finalized observations, raw public captures, receipts, cost and immutable new-process restart proof |
| publication-fraction-review.json | Independent offline exact price/depth/source-time recomputation |

The receiver imports unchanged real PriceIngress/ObservationStore. It has no
CLOB/accounting/oracle and is explicitly diagnostic. Seven-day recording schedule,
politics mapping and N/spread are test inputs. The source collector must revalidate
metadata before publication. The subsequent publication pilot finalized three
authentic observations with sequences 1–3 and sender nonces 0–2. The first two
were preserved identically after restarting the process. Cost: 0.2448 test MON.
Sustained 300-second coverage and reviewed production release remain pending.

The latest package suite passes 318 tests, including 12 new testnet publication tests.
The ten receiver tests are separate and must not be added to that suite count.
