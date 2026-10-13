# Live Polymarket data into a local demo market

Result: **LIVE_SOURCE_LOCAL_INGRESS_PASS**. Started 2026-10-02T16:51:21+00:00.

Flow: real Polymarket event/market/book → validation → depth-N summary → raw test
signature → local `submitObservation` transaction → actual risk ingress/store →
receipt/event/sequence verification → independent 300-second index comparison.

- Source market: 5170735; selected
  outcome: Yes.
- Local chain: 31337; demo receiver: `0x5fbdb2315678afecb367f032d93f642f64180aa3`.
- Accepted live-source packets: **36** of 36 attempts;
  unavailable attempts: 0.
- Latest depth midpoint: **0.765**.
- Latest engine index: available **True**, coverage **300/300 seconds**,
  TWAP **0.765**.
- All 36 acceptance/index checks matched; archive integrity passed.
- External-chain transactions: **0**. The owned local chain was shut down.

## Evidence and limits

`latest.json` contains demo policies, exact signed observations, transaction hashes,
accepted events, source-body hashes and engine/reference index results.
`source-example.json` preserves the first actual complete book. Full raw captures
are in `var/live-demo-1790959881522.sqlite` (ignored local evidence archive).

Prices and timestamps came from actual public data, with no accelerated time or
fabricated backfill. Diagnostic N/spread/method, quote and time policies remain
unapproved for production. The demo receiver imports real `PriceIngress` and
`ObservationStore`; its initialization is a demo harness. It has no complete
margin/funding/settlement engine, book or oracle. This is local integration
evidence, not a listed production market or human gate acceptance.

## Accepted observations

| Sequence | Source Unix seconds | Depth midpoint | Covered seconds | Index available |
|---|---|---|---|---|
| 1 | 1790959882 | 0.7669582 | 0 | False |
| 2 | 1790959891 | 0.7669582 | 10 | False |
| 3 | 1790959902 | 0.770025 | 20 | False |
| 4 | 1790959912 | 0.7604432 | 30 | False |
| 5 | 1790959921 | 0.7604432 | 40 | False |
| 6 | 1790959933 | 0.765 | 51 | False |
| 7 | 1790959941 | 0.765 | 60 | False |
| 8 | 1790959951 | 0.765 | 70 | False |
| 9 | 1790959961 | 0.765 | 80 | False |
| 10 | 1790959971 | 0.765 | 90 | False |
| 11 | 1790959982 | 0.765 | 100 | False |
| 12 | 1790959991 | 0.765 | 110 | False |
| 13 | 1790959999 | 0.765 | 120 | False |
| 14 | 1790960010 | 0.765 | 130 | False |
| 15 | 1790960022 | 0.765 | 140 | False |
| 16 | 1790960024 | 0.765 | 150 | False |
| 17 | 1790960041 | 0.765 | 160 | False |
| 18 | 1790960051 | 0.765 | 170 | False |
| 19 | 1790960061 | 0.765 | 180 | False |
| 20 | 1790960071 | 0.765 | 190 | False |
| 21 | 1790960082 | 0.765 | 200 | False |
| 22 | 1790960092 | 0.765 | 211 | False |
| 23 | 1790960097 | 0.765 | 220 | False |
| 24 | 1790960107 | 0.765 | 231 | False |
| 25 | 1790960122 | 0.765 | 240 | False |
| 26 | 1790960133 | 0.765 | 251 | False |
| 27 | 1790960141 | 0.765 | 260 | False |
| 28 | 1790960152 | 0.765 | 270 | False |
| 29 | 1790960162 | 0.765 | 280 | False |
| 30 | 1790960172 | 0.765 | 291 | False |
| 31 | 1790960182 | 0.765 | 300 | True |
| 32 | 1790960191 | 0.765 | 300 | True |
| 33 | 1790960201 | 0.765 | 300 | True |
| 34 | 1790960211 | 0.765 | 300 | True |
| 35 | 1790960221 | 0.765 | 300 | True |
| 36 | 1790960232 | 0.765 | 300 | True |
