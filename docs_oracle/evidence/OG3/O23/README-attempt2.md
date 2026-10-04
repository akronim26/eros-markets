# O23: Layer 1 no-write runs: NOT_READY and 429

Monad testnet, run started 2026-10-04T17:35:45.231Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts O23`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed not-ready (truth YES, T 2026-10-04T17:47:00.000Z) | `0x47e440b0…` | `0x99ad160c354cff2e96b4d1b57e9a3f8b452d9b48d2057fdf734f810159cd2633` | 68176529 | 2026-10-04T17:36:33.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | not-ready: no Layer 1 report written | state L2Pending, path 0 |
| PASS | http-429: no Layer 1 report written | state Open, path 0 |
