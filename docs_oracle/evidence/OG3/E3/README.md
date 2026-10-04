# E3: DVM false → Review → other outcome → Final

Monad testnet, run started 2026-10-04T17:06:52.452Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E3`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e3 (truth NO, T 2026-10-04T17:18:00.000Z) | `0xdd289d09…` | `0x984f6f8f734122556baae7d2e61c1d7e62db2fbc1024eca2e8f9063e9583d1dd` | 68170777 | 2026-10-04T17:07:36.000Z |
| committee proposes YES | `0xdd289d09…` | `0xc36e410434da678dbe4d33703f345e8b6aba5fa56597038f8b60769706ba480f` | 68179039 | 2026-10-04T17:49:11.000Z |
| third party disputes YES on OOv3 | `0xdd289d09…` | `0x3283dff5b182266314851a800a85db0f37c228b3a8581bcf6981b75f00d9fe3a` | 68182211 | 2026-10-04T18:05:09.000Z |
| sandbox DVM answers false to YES | `0xdd289d09…` | `0x28fb05134369f86c9f37b1b29e5af7c216b52e823251472ef9e21d2e354f9b13` | 68182352 | 2026-10-04T18:05:52.000Z |
| committee proposes NO | `0xdd289d09…` | `0x47a23bca25e469c05dccad60683fce7754a6668e0a4cffa8c190ce425316659e` | 68183581 | 2026-10-04T18:12:03.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | rejectedMask set for YES | rejectedMask 2 |
| PASS | the rejected outcome is not proposed again | Error: console propose failed: |
| PASS | e3 oracle Final NO | state Final, outcome 2, finalReason 1 |
| PASS | e3 engine settled NO, claims open | engine finalOutcome 1, price 0, claimsEnabled true |
