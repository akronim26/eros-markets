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
