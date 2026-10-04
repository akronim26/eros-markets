# E2: provider down → panel → committee → public dispute → DVM true → Final

Monad testnet, run started 2026-10-04T17:05:16.013Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E2`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e2 (truth YES, T 2026-10-04T17:17:00.000Z) | `0x4aa4538e…` | `0x4d94ed418e702e64585bc76b2f3b42e5c340ff934d36c9ae1049a85b067727dd` | 68170477 | 2026-10-04T17:06:06.000Z |
| committee proposes YES | `0x4aa4538e…` | `0x2eb22143e7744047e83d24001d5da7f1a8fab5577455b66691a3730575480e90` | 68174157 | 2026-10-04T17:24:37.000Z |
| third party disputes YES on OOv3 | `0x4aa4538e…` | `0xa28a652be25ed3b3e6f3139c016f89ae5e448bd2dbf07b4ff6cfb18a1d08a109` | 68174252 | 2026-10-04T17:25:06.000Z |
| sandbox DVM answers true to YES | `0x4aa4538e…` | `0x7cc414229a3d99395e627d75727dde52e08ac8d3729d0d5e26ae1179d0c0e620` | 68174331 | 2026-10-04T17:25:30.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e2 oracle Final YES | state Final, outcome 1, finalReason 1 |
| PASS | e2 engine settled YES, claims open | engine finalOutcome 2, price 1000000000000000000, claimsEnabled true |
| PASS | path REVIEWED | path 3 |
| PASS | dispute visible to Disputes Live (indexer) | {"Dispute":[{"id":"0xabde73787c5e8563f098c106c7c266103dcc4da988cfdf72fc6ff2de00fec8e5"}]} |
