# DRY: dry scenario: list → halt through the deployed services

Monad testnet, run started 2026-10-04T17:01:46.368Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts DRY`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed dry (truth YES, T 2026-10-04T17:13:00.000Z) | `0x858d339d…` | `0xeefc6ed3162b49e24203fc40a9097e1aecbd8ac5eb6cc547c7cbbdbb88fd830c` | 68169751 | 2026-10-04T17:02:26.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | keeper halted the market at T | haltedAt 1791133980, T 1791133980, state L1Pending |
