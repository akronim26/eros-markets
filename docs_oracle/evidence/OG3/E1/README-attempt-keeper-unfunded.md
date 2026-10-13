# E1: Layer 1 to Final with a 2-minute liveness

Monad testnet, run started 2026-10-04T17:35:42.216Z. Status: **error: Error: 0x209e5fae: timed out waiting for Layer 1 proposal (state L2Pending)**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E1`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e1 (truth YES, T 2026-10-04T17:47:00.000Z) | `0x209e5fae…` | `0x60e866c4a44f79ea60ccb57876cd094a07bed81f6fdbd5cdbef17e1209b482f3` | 68176521 | 2026-10-04T17:36:31.000Z |

| Result | Check | Detail |
| --- | --- | --- |
