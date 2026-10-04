# E4: YES and NO rejected → Voided → INVALID

Monad testnet, run started 2026-10-04T17:07:46.038Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E4`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e4 (truth YES, T 2026-10-04T17:19:00.000Z) | `0x8834a12f…` | `0x8e5cb88eaa2399040e5336fb606eaa30228a7c0096d2476626983ecb040d22a6` | 68171016 | 2026-10-04T17:08:48.000Z |
| committee proposes YES | `0x8834a12f…` | `0x2ee1107445a71eec1fc424a158acb13567b49165cf331d01237d03986ffeb46a` | 68174633 | 2026-10-04T17:27:01.000Z |
| third party disputes YES on OOv3 | `0x8834a12f…` | `0x009f1d8979a7a0b8eea1efa131473a76523ab428888be0beb0847d45101f9d7c` | 68174787 | 2026-10-04T17:27:47.000Z |
| sandbox DVM answers false to YES | `0x8834a12f…` | `0x1d88e000e2ca657c2032debca0a9b5193c84bf1087f0818861946d024f2c67d8` | 68174861 | 2026-10-04T17:28:10.000Z |
| committee proposes NO | `0x8834a12f…` | `0x5bc37670e3c74e41e0191de9651ac52ee20276a681d2ab571d7dab0e3f071bb8` | 68175291 | 2026-10-04T17:30:19.000Z |
| third party disputes NO on OOv3 | `0x8834a12f…` | `0x54516d4a24f4a3dec99eee9782ff88aff035039f7cd66c8ca453a254d02d14f5` | 68175815 | 2026-10-04T17:32:58.000Z |
| sandbox DVM answers false to NO | `0x8834a12f…` | `0x8d5dbeb953a786950e0f8483ed7bb8d38d310607f83bc8175e93e70c87aa027d` | 68176158 | 2026-10-04T17:34:41.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e4 oracle Final INVALID | state Final, outcome 3, finalReason 2 |
| PASS | e4 engine settled INVALID, claims open | engine finalOutcome 3, price 500000000000000000, claimsEnabled true |
| PASS | Voided after both outcomes were rejected | rejectedMask 6, finalReason 2 |
| PASS | INVALID payouts at the listed fallback price | price 500000000000000000 |
