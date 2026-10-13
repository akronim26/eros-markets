# Native market end-to-end rehearsal on a Monad-testnet fork

- Date: 2026-10-13. Environment: anvil fork of Monad testnet (chain 10143), forked at block ~70.49M with the **real** testnet registry, factory, oracle, TestUSDC and Kuru state.
- **Fork only, no public transactions.** Fork-only shortcuts:
  - The registry lister (`0xFf49…F190`) and the engine governance Timelock were impersonated. On the public chain these are the deployer key and a Timelock proposal with its 300 s delay.
  - Anvil keys stand in for the maker, user and INDEX signer.
  - Interval mining was set to 1 s for the recovery phase, because anvil otherwise mines only on transactions.
- Inputs: [`../20261013-deploy-fork`](../20261013-deploy-fork) (vault, tokens, Kuru books, rules) and [listing.json](listing.json). The AI, UMA, allow-list and monitor config are copied from listed market `0x86c6…1522`.

| Step | Command | Result |
| --- | --- | --- |
| List + bind (NM-D04/D05) | `forge script script/native/ListNativeMarket.s.sol --unlocked --sender <lister>` | Real `RegistryBookRiskEngine` `0xE7C1…D606` deployed through the factory; `bindMarket()` latched it; ~36.5M gas (Foundry estimate) |
| Activate | `activateMarket()` from the impersonated Timelock | success |
| Split + spot (NM-E02/E04/E06) | `scripts/native-market/spot.sh split / deposit / quote / buy` | Maker split 1,000 sets, quoted YES 0.550/0.580 and NO 0.420/0.450 × 200 claims; user bought 50 YES for 29 tUSDC (0 fees); balances reconcile |
| Native INDEX (NM-F08 rehearsal) | `node dist/scripts/native-publish.js <rpc> rules.json <engine> 8 10000 latest` | `verifyNativeListing` passed; engine and TS digests equal; sequences 1–9 accepted; INDEX TWAP **available = 0.565** after 60 s of coverage |
| Source loss (NM-G05/G06 behavior) | cancel team YES quotes, publish | Signed invalid-depth checkpoints (seq 10–17) accepted; INDEX became unavailable at once and coverage fell 58 → 0 s; no invented price |
| Recovery | re-quote 0.600/0.620, publish | Valid observations resumed; INDEX TWAP available = 0.61 |
| Same-second guard | publish while anvil mined no blocks | `SOURCE_SECOND_NOT_ADVANCED`: withheld instead of re-timestamping old data |

Not covered here: perp sampling, pricing activation or a perp fill (NM-G02–G04), and public-chain receipts.

## Native-priced perp on the same fork (NM-G01–G04 rehearsal)

| Step | Command | Result |
| --- | --- | --- |
| Fund perp accounts | `CollateralVault.deposit` + `allocate(engine, 500 tUSDC)` for maker and taker | Engine is registered in the real CollateralVault `0x5E53…05e4`. One allocate reverted during a concurrent publisher tx (stale gas estimate); the retry succeeded |
| Perp maker quotes | `perp.sh quote 600 620 150000` (post-only, fully backed) | Rested around the native INDEX of 0.61 |
| Keeper | `samplePerp()` each block while `native-publish.js` keeps INDEX fresh | Capture then later-block seal; PERP TWAP available 0.61 after ~17 samples; `activatePricing()` succeeded → `pricingMode = 1` |
| 1× perp fill | taker IOC buy 50,000 lots at 620 | Taker long 50 claims, cash 500 → 469 (50 × 0.62 = 31); maker short 50, cash 531; taker E1 = 469 + 50 = 519 |
| Close | `perp.sh close 600 50000 sell` (reduce-only IOC) | Taker flat, cash 499 (−1 = 50 × 0.02 spread) |
| Release + withdraw | `perp.sh release 499000000`; `CollateralVault.withdraw` | Wallet +499 tUSDC |

Native INDEX came only from the Kuru YES book. The perp PERP/BASIS came from sealed Eros book samples. Pricing used the testnet windows of chain 10143.

## Second market: real Timelock activation path (fork)

- A second rehearsal market went through `DeployNativeMarket` → `native-rules` → `ListNativeMarket` in one pass: engine `0x90E5…A84c`, vault bound.
- `ENGINE=… forge script script/native/ActivateNativeMarket.s.sol` simulated `activateMarket()` as the Timelock and printed `propose`/`execute` calldata.
- `propose` was sent from the lister wallet, which holds the Timelock PROPOSER, EXECUTOR and CANCELLER roles on public testnet (`minDelay` 300 s): success.
- An early `execute` reverted while the operation was still pending.
- After +301 s, `execute` succeeded and `engine.active() == true`.
- On the public chain, listing **and** activation therefore need only the lister key.

## Hourly rollover and recovery (fork; NM-G07 is IF-TIME, rehearsed anyway)

- `beginRollover()` before the hour boundary reverted. After time was advanced past the hour, `perp.sh rollover` (`beginRollover` → `rollPage(32)` → `finishRollover`) succeeded.
- **Finding 1:** right after the 36-minute time jump, INDEX was stale and the maker's sell quote and the taker's buy failed. That is correct: no new risk without a fresh price.
- **Finding 2:** a second publisher started while the first was still running and failed with `DuplicateOrOldSequence`. The duplicate writer was rejected and nothing conflicting was signed.
- **Finding 3 (fixed):** `ReentrancySentryOOG`. Plain `cast send` gas estimates went stale while the publisher and keeper changed engine state, so `placeOrder`, `samplePerp` and once `allocate` ran out of gas. `spot.sh` and `perp.sh` now estimate and send with a +30% gas limit.
- After the fix, the maker re-quoted, the keeper re-sealed (PERP valid after 16 samples), and the taker bought 20 claims at 0.62: cash 100 → 87.6 (20 × 0.62 = 12.4), E1 = 107.6, MARK available.
