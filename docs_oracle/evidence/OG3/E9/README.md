# E9: exclusive group: racing YES reports, a single Final YES

Monad testnet, run started 2026-10-04T17:13:40.726Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E9`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e9-home-gt-4 (truth YES, group 0x128b1532) | `0x12726c7f…` | `0xf2718c26ab3af36ae615490c1e4207668707669094450151bf92094938af0064` | 68172109 | 2026-10-04T17:14:19.000Z |
| listed e9-away-gt-4 (truth NO, group 0x128b1532) | `0x2776dddc…` | `0x01547ea7844a0091bf6599829051e4bf2f4bcc95680a9fad9cc220a822efb8d3` | 68172273 | 2026-10-04T17:15:08.000Z |
| listed e9-away-gt-9 (truth NO, group 0x128b1532) | `0xf9e80322…` | `0x828b862fd3f9724d9654aa7b1f407ab2d7b03f2e4074403e0e7036ff6bf2ce85` | 68172458 | 2026-10-04T17:16:04.000Z |
| a second YES report in the group (sim relayer through the mock forwarder) | `0x2776dddc…` | `0xc1f352b1e2bc285d6fa0b2279843448b3c1883e2054cfce135bbcdf3d3c77ac3` | 68175350 | 2026-10-04T17:30:37.000Z |
| group conflict applied: assertProposal on the racing market by KEEPER_1 (the keeper skips it: it returns false) | `0x2776dddc…` | `0x50e08e8423183adc728a3423b7cea889e04bca8c03305d9c7478bea58a7374b0` | 68186138 | 2026-10-04T18:24:55.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e9-home-gt-4 oracle Final YES | state Final, outcome 1, finalReason 1 |
| PASS | e9-home-gt-4 engine settled YES, claims open | engine finalOutcome 2, price 1000000000000000000, claimsEnabled true |
| PASS | e9-away-gt-9 oracle Final NO | state Final, outcome 2, finalReason 1 |
| PASS | e9-away-gt-9 engine settled NO, claims open | engine finalOutcome 1, price 0, claimsEnabled true |
| PASS | single Final YES in the group (ORC-7) | finalYes 0x12726c7fd3a7a9533ad46da75fedef8546f18f0b7a06ed8337fe552af4501aa7; racing market state Review outcome 0 |
