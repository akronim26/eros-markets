# E6: early check → EarlyReview → committee → Final before T

Monad testnet, run started 2026-10-04T17:10:16.049Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E6`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e6 (truth NO, T 2026-10-04T18:41:00.000Z) | `0xcb7d6bbc…` | `0x039bc3184750ae3f27539024cb5096e54c22aee5134ea8b712ac28d4d8e808e9` | 68171444 | 2026-10-04T17:10:58.000Z |
| monitor: reduce-only, requestEarlyCheck | `0xcb7d6bbc…` | `0x508db505b9d0a042d13d3db01b79c9702ccedabfaf6d0387905e88b3dff7d995` | 68171454 | 2026-10-04T17:11:01.000Z |
| monitor: reduce-only, requestEarlyCheck | `0xcb7d6bbc…` | `0xb25a108bc54fa006e462b60bdda4153d898f1c01d50406251578bbe765a170af` | 68171460 | 2026-10-04T17:11:02.000Z |
| committee proposes NO (early) | `0xcb7d6bbc…` | `0xa27d7adcc44c180d9c187dc9c00600177d7f1a2d6574c3980aaefff447d984ed` | 68172995 | 2026-10-04T17:18:46.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e6 oracle Final NO | state Final, outcome 2, finalReason 1 |
| PASS | e6 engine settled NO, claims open | engine finalOutcome 1, price 0, claimsEnabled true |
| PASS | halted and Final before T | haltedAt 1791134326, Final by 1791135583, T 1791139260 |
