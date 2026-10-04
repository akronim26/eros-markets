# E7: unanswered dispute → voidMarket at voidDeadline

Monad testnet, run started 2026-10-04T17:06:27.014Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E7`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e7 (truth YES, T 2026-10-04T17:18:00.000Z) | `0x6e969e02…` | `0xb550da9c908068da42b749dc139bb1722324ca2f307a87fd529f520b63e74da4` | 68170684 | 2026-10-04T17:07:08.000Z |
| dispute on OOv3 (the DVM never answers) | `0x6e969e02…` | `0xb1c80f217665bc4ae4a39e636ec3786fdb4d594ea8fc2ae7b02a4113ef760cd3` | 68173226 | 2026-10-04T17:19:56.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e7 oracle Final INVALID | state Final, outcome 3, finalReason 3 |
| PASS | e7 engine settled INVALID, claims open | engine finalOutcome 3, price 500000000000000000, claimsEnabled true |
| PASS | voided at the void deadline | voided true, finalReason 3, voidDeadline 1791139680 |
| PASS | the stuck bond is recorded (BondStuck) | BondStuck 11120000 atoms in 0x64d90247f9ecda6684adcd5d1b98e1b358e0ae98030ad5f1fa653d3f60e87a30 |
