# E5: L2 deadline → Open → permissionless proposal → Final, reward paid

Monad testnet, run started 2026-10-04T17:09:01.035Z. Status: **pass**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E5`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e5 (truth YES, T 2026-10-04T17:21:00.000Z) | `0xcc43a177…` | `0xe8996844235e0d31c396b5cfa4504a2d052074271790b3e4a75987c283afbccb` | 68171225 | 2026-10-04T17:09:51.000Z |
| permissionless proposal YES with own bond | `0xcc43a177…` | `0xade99a820023f03acb7d0e6147b1aac4a5174bb40036746765ec6cb5b956952a` | 68175499 | 2026-10-04T17:31:22.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | e5 oracle Final YES | state Final, outcome 1, finalReason 1 |
| PASS | e5 engine settled YES, claims open | engine finalOutcome 2, price 1000000000000000000, claimsEnabled true |
| PASS | path PERMISSIONLESS, reward 1 USDC | path 4, rewardAtoms 1000000 |
| PASS | reward paid to the proposer (RewardPaid, no IOU) | RewardPaid 1000000 to 0xCbf737ea4D798a74a2988fC3294910d5a581A85c in 0x35665aee2bab059181ae655a6920ba8822dbb5e0019ef0970da5023e81769a67 |
| PASS | bond returned to the proposer by OOv3 | 11120000 atoms from OOv3 in 0x35665aee2bab059181ae655a6920ba8822dbb5e0019ef0970da5023e81769a67 |
