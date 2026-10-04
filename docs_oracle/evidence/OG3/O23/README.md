# O23: Layer 1 no-write runs: NOT_READY and 429

Monad testnet, run started 2026-10-04T18:36:42.630Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts O23`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed not-ready (truth YES, T 2026-10-04T18:48:00.000Z) | `0xa94de3aa…` | `0x4b057608cb544e96e95f5b4be66a4760798caccfbff3964122cb1425a023228c` | 68188624 | 2026-10-04T18:37:26.000Z |
| listed http-429 (truth YES, T 2026-10-04T18:49:00.000Z) | `0x955bbe2a…` | `0xa6cec6be956ccaf101efefc142ceeb3f201adcf39ce693c7809383ae3b07c14f` | 68188803 | 2026-10-04T18:38:20.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | not-ready: requested, the listener ran and wrote nothing | requests 1; listener: "nowrite:0xa94de3aac8c801930f3789457b72ac254228cc91e5b29f31292825ff69fcb439:NOT_READY:NOT_FINAL"; state L2Pending, path 0 |
| PASS | http-429: requested, the listener ran and wrote nothing | requests 1; listener: "nowrite:0x955bbe2a7a7222d4020c068d2062306676eccf5db21b0021cbbd9f3c7586f701:ERROR:HTTP_429"; state L2Pending, path 0 |
