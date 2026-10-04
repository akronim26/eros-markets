# E1: Layer 1 to Final with a 2-minute liveness

Monad testnet, run started 2026-10-04T18:35:42.637Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E1`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e1 (truth YES, T 2026-10-04T18:47:00.000Z) | `0x81db889d…` | `0x4f5b090f8dedd2a29b2346cf9635f69a1cf361c2d0fc644215183ca2a9b45a94` | 68188426 | 2026-10-04T18:36:26.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e1 oracle Final YES | state Final, outcome 1, finalReason 1 |
| PASS | e1 engine settled YES, claims open | engine finalOutcome 2, price 1000000000000000000, claimsEnabled true |
