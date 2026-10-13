# Native market progress report (commit by commit)

Branch `feat/native-market`. Baseline `df8b01c` (`feat/pricefeed`). Period 2026-10-13 02:03–07:07 local (UTC+5:30); on-chain times are UTC.
Plan: [NATIVE_MARKET_PLAN.md](NATIVE_MARKET_PLAN.md) · Tracker: [NATIVE_MARKET_TRACKER.md](NATIVE_MARKET_TRACKER.md) · Runbook: [../runbooks/NATIVE_MARKET_DEMO.md](../runbooks/NATIVE_MARKET_DEMO.md)

## Summary

**Status: core complete (52/52 core tracker tasks) and running on public Monad testnet (chain 10143).**

| Requirement | Status |
| --- | --- |
| Fully backed YES/NO vault | ✅ |
| Kuru YES/NO spot books | ✅ |
| Native INDEX feeding the existing Eros engine | ✅ |
| Native-priced 1× perp | ✅ |
| Oracle resolution and redemption | ✅, including one public early YES settlement |

- **30 commits**, all local; nothing pushed.
- **Tracker:** all 52 core tasks DONE (frontend-only items excluded from scope); 22 optional ("if time") tasks deferred.
- **What remains** is operations and paperwork, not features. See "Open items" at the end.

Trust and scope labels for everything below:
- test collateral (tUSDC);
- team-controlled liquidity and simulated trading;
- one INDEX signer key;
- sandbox UMA adjudication;
- 1×, funding off.

## Phase 1: Plan and Kuru compatibility

| Commit | Time | Tasks | What changed | Validation |
| --- | --- | --- | --- | --- |
| `f51e563` | 02:03 | NM-B01–B04 | Added the native-market plan, the 10-hour tracker (48 core / 26 if-time tasks) and `scripts/native-market/kuru-fork-spike.sh` | Kuru spike on an anvil fork of Monad testnet: market creation is permissionless with Eros TestUSDC as quote; deposit, post, fill, cancel and withdraw work; units match Eros 1:1 (1 size unit = 1 lot, 1 price unit = 1 tick); wallet totals reconcile to the Kuru fee |

## Phase 2: Contracts (vault and tokens)

| Commit | Time | Tasks | What changed | Validation |
| --- | --- | --- | --- | --- |
| `260745b` | 02:10 | NM-C01–C08 | `OutcomeToken` (vault-only mint/burn, no Permit2 allowance) and `NativeOutcomeVault`: `bindMarket` to the registry-selected engine, `split` (exact backing, cap, closes at T or halt), `merge`, `syncResolution` (YES = 1, NO = 0, INVALID = engine price once ready), `redeem` (single floor). Registry `MarketCore` ABI mirror. | `forge test` (ci profile) 35/35: 32 unit/fuzz tests + 3 invariants (supply = sets; custody identity; payouts ≤ backing); 10,000 fuzz runs; 32,768 invariant calls each |
| `2deb124` | 02:11 | NM-C09 | Native ABIs added to `scripts/export-risk-abis.py` | Export `--check` current for all 5 ABIs (forge 1.8.3); existing exports unchanged |
| `270d133` | 02:11 | — | Tracker: C01–C09 recorded | — |

## Phase 3: Native price observer

| Commit | Time | Tasks | What changed | Validation |
| --- | --- | --- | --- | --- |
| `094c538` | 02:21 | NM-F02–F06, NM-E01 | `packages/pricefeed/src/native/`: Kuru `getL2Book` decoder; exact unit conversion; pinned-block snapshot (block hash rechecked); `EROS_KURU_NATIVE_INDEX_RULES_V1` rules hash; collector reusing `summarizeBook`. `native-observe` probe CLI. | 8/8 tests with hand-computed VWAPs (e.g. 50 @ 0.600 + 50 @ 0.610 → 0.605). Real Kuru bytes on a fork decoded to 0.4/0.6/0.5; N + 1 lots → invalid depth |
| `a813015` | 02:22 | NM-F07 | `prepareNativeObservation` (existing `PreparedPacket`/wire) and `verifyNativeListing` | 13/13: packets pass through the unchanged `PacketStore` and `signPrepared`, and the signature recovers |

## Phase 4: Settlement against the real stack (local)

| Commit | Time | Tasks | What changed | Validation |
| --- | --- | --- | --- | --- |
| `9185a9c` | 02:26 | NM-C02, NM-H02, NM-H03 | `oracle/test/integration/NativeSettlement.t.sol`: vault bound to a real registry/engine/oracle | 7/7: binding and mismatches; early YES; scheduled NO; rejected proposal; INVALID 0.5 fallback; **INVALID 0.63 from 24 h of signed INDEX history matches the engine exactly** |
| `d4790a2`, `933c28a` | 02:26–02:27 | — | Tracker evidence and label fixes | — |

## Phase 5: Deployment tooling and fork rehearsals

| Commit | Time | Tasks | What changed | Validation |
| --- | --- | --- | --- | --- |
| `f7d7a39` | 02:30 | NM-D02, NM-D03, NM-F02 | `DeployNativeMarket.s.sol` (vault + 2 Kuru books; refuses to redeploy) and the `native-rules` CLI (rules hash + ListMarket fields) | Fork: books wired correctly; unbound vault closed; `NotListed` on the real registry; rerun refused |
| `f453fcb` | 02:41 | NM-D04, D05, E02, E04, E06, F08 | `ListNativeMarket.s.sol` (oracle config copied from a listed market), `native-publish` (Kuru → signed INDEX → engine), `spot.sh` | Fork on real testnet state: real engine listed and bound; Kuru trade; INDEX 0.565; quote removal → invalid depth → INDEX unavailable; re-quote → 0.61 |
| `0a13ab6` | 02:45 | NM-G01–G04 | `perp.sh` (fund, quote, keeper, trade, close, release) | Fork: `activatePricing` → NORMAL; 1× long 50 @ 0.62 reconciled; close, release, withdraw |
| `af52b44` | 02:45 | — | Tracker: fork evidence | — |
| `42e2d16` | 02:48 | NM-D04, NM-G01 | `ActivateNativeMarket.s.sol` (Timelock propose/execute via `GovernanceOp`) | Fork: lister holds PROPOSER/EXECUTOR; early execute reverted; execute after 300 s → active |
| `a55e27d` | 02:56 | NM-G04, NM-G07 | +30% gas-limit margin in the CLIs; `perp.sh rollover` | **Bug found:** `ReentrancySentryOOG` from stale gas estimates. Fork: rollover, stale-INDEX block, duplicate publisher rejected, recovery fill |
| `978d128` | 02:57 | NM-F08 | +30% gas margin for publisher submissions | Fork publish rounds accepted |
| `2cec0b1` | 02:58 | NM-J01, G05, G07 | Public demo runbook | — |
| `1df1fab` | 03:14 | NM-E07, J06, F08 | `arb.sh` (split-sell / buy-merge), one-command `fork-rehearsal.sh`; publisher withholds on inconsistent reads | Fork, exit 0 twice: both arbitrage directions realized exactly +0.200 tUSDC on 20 sets. **Bug found:** a publisher crash on `L2_BLOCK_MISMATCH` |
| `a57e4a5` | 03:19 | — | Tracker | — |
| `2885548` | 03:46 | NM-J05 | Regression record | Contracts (ci) 928/928; oracle integration 122/124, and those 2 also fail on the baseline; native suites pass |

## Phase 6: Public Monad testnet

| Commit | Time | Tasks | What changed | Validation / on-chain evidence |
| --- | --- | --- | --- | --- |
| `cdd3645` | 04:11 | NM-D02 | Deploy script writes its record only on broadcast | **Bug found** before spending anything: a dry run had written the output file and blocked the real broadcast (lister nonce unchanged) |
| `6437a99` | 04:27 | A, B, D, E, F, G | **BTC > $82,500 market live.** `keeper-daemon.sh`; evidence `artifacts/native-market/public-20261012-btc-82500/` | Vault `0x17f4…706a`; books YES `0x91e1…30F9` / NO `0x6A40…7AAb`; engine `0xE7C1…D606`. Listing needed `--gas-estimate-multiplier 105` (30M per-tx gas cap). Timelock activation; trader 50 YES @ 0.52; INDEX 0.5; pricing active after 8 samples; 1× long 20 @ 0.51 |
| `3c95076` | 04:34 | NM-G07 | Evidence | First hourly rollover handled unattended at 23:00:21Z |
| `67210b3` | 04:36 | NM-B03, E02, E06, G04 | Evidence | Public cancel; NO trade; merge of 20 sets (+20 tUSDC); perp close, release, withdraw |
| `f9b471c` | 04:50 | NM-H01, H02 | `ResolveNativeEarly.s.sol` (monitor → panel → committee → assertion → finalize) | Fork: Final/YES; engine YES; vault payout 1e18 |
| `74c8468` | 05:05 | NM-H01, H02, H07, J06 | **First public native settlement**; evidence `artifacts/native-market/public-20261012-block-70528000/` | Block-height market: listed 23:13Z, traded, block finalized 23:26:32Z, early YES finalized 23:33:54Z, vault synced, 20 YES → 20 tUSDC, 20 NO → 0 |

## Phase 7: Frontend listing and market simulation

| Commit | Time | Tasks | What changed | Validation |
| --- | --- | --- | --- | --- |
| `5a514b7` | 05:53 | NM-D06, NM-I02 | Native engines in the frontend manifest and metadata; source-aware labels; keeper re-quotes only when a side is empty | Headless browser on testnet: native BTC page TRADING with Mark/Index 0.500, its own perp book, chart "YES · Eros native (Kuru)"; no page errors; tsc 0; frontend tests 127/134, the same 7 fail on the baseline |
| `9e80f35` | 06:16 | demo tooling | `native-sim.ts`: fair-value maker (Kraken BTC model, inventory skew, no Eros price input) + noise/momentum/contrarian takers | Fork: YES 0.343–0.357 following BTC; 21 taker trades |
| `442bd3f` | 06:22 | demo tooling | Starting-skew fix | — |
| `b9efd53` | 07:07 | demo tooling | Make-before-break re-quoting; startup cancels own open orders (`s_orders`); taker setup failures non-fatal | **Bug found on the public run:** chart gaps from cancel-then-repost. Fork after the fix: 14 observations, 0 invalid, INDEX continuous |

## Public operations without a code commit

| Time (UTC) | Action | Result |
| --- | --- | --- |
| 22:40–23:08 | BTC market deploy, list, activate, spot, publisher, perp | See `6437a99` / `67210b3` evidence |
| 23:12–23:35 | Block-height market lifecycle | See `74c8468` evidence |
| 00:50–01:05 | Simulation run 1 (15 min, 3 takers) | YES 0.30 → 0.37 following BTC; 3 chart gaps (fixed in `b9efd53`) |
| 01:56–02:07 | Simulation run 2 (10 min) | 19 prices, 1 invalid (startup only); INDEX 0.482 → 0.497 continuous; ~30 taker trades; maker ran out of MON at the end |
| ~02:20 | Liquidity increase | YES book 935 bid / 919 ask claims and NO book 919 / 950, across 4 levels each (was ~130–150 at 1 level); 100-claim impact 0.487/0.507; 500-claim impact 0.4842/0.5101 |

## Current live state (Monad testnet)

- **BTC > $82,500 market:**
  - native INDEX ≈ 0.497;
  - Kuru depth about 920–950 claims per side;
  - vault fully backed (sets = tUSDC held);
  - resolves at 2026-10-14T23:00Z.
- **Block-height market:** resolved YES and redeemed; archived in the frontend.
- **Processes on this laptop:**
  - INDEX publisher (`native-publish.js`, 30 s);
  - keeper loop (`keeper-daemon.sh`, 90 s + hourly rollover);
  - frontend dev server.
- **Measured costs** at ~102 gwei; Monad charges the gas limit:

  | Item | Cost |
  | --- | --- |
  | Publisher | ~3.1 MON/h |
  | Keeper | ~3.0 MON/h (`samplePerp` ≈ 0.063 MON) |
  | Kuru order | ≈ 0.047 MON |
  | Kuru taker trade | ≈ 0.029 MON |
  | `createMarket` | ≈ 29.3M gas |

## Bugs found and fixed

1. **Stale gas estimates caused out-of-gas.** Fixed with a +30% limit (`a55e27d`, `978d128`).
2. **Publisher crashed on an inconsistent read.** It now withholds the round and retries (`1df1fab`).
3. **A dry run blocked the real deploy.** Dry runs now write a separate record (`cdd3645`).
4. **`createMarket` exceeded the 30M per-transaction gas cap.** Runbook updated to use a 1.05× multiplier (`6437a99`).
5. **Keeper re-quotes stacked perp depth every hour.** It now re-quotes only when a side is empty (`5a514b7`).
6. **Simulator chart gaps and leftover-order crossing.** Fixed with make-before-break and startup cleanup (`b9efd53`).

## Open items (frontend excluded)

| Item | State |
| --- | --- |
| G05 source-loss evidence | Happened publicly during simulation run 1; record in the tracker |
| D01 manifest schema | Deployment JSON exists; add a formal schema |
| E07 public arbitrage | Proven on fork; one public `arb.sh` run |
| F10 pricefeed regression | Rerun with bundled Node 24 and record |
| J05 final regression | Rerun all suites |
| J01 / J02 durable operations | Bots run on a laptop; move to `market-supervisor.mjs` or an always-on host |
| J07 demo freeze | Final runbook, evidence bundle, limitations |
| Native perp maker | Perp quotes (0.49/0.51) don't follow native INDEX (~0.50 now, 0.30–0.37 earlier), so PERP becomes unavailable when INDEX moves away |
| Funding | Spot maker ~0.66 MON, observer ~5 MON (~1.5 h), keeper ~31 MON |

## Phase 8: Closing the remaining core tasks (frontend excluded)

| Commit | Tasks | What changed | Validation |
| --- | --- | --- | --- |
| `5a028e3` | NM-D01, NM-D06 | Strict native deployment manifest (schema v1) and the read-only `native-verify` chain verifier | Manifest tests 2/2; both public deployments pass 19/19 checks |
| `bf00b1e` | NM-G04, NM-G05 | Keeper keeps perp quotes centred on native INDEX; the simulator rate-limits its moves | **Finding:** the BTC engine is `REDUCE_ONLY`, because simulation run 1 tripped the 0.10/300 s movement guard by design. Only the monitor can clear it. |
| `0477906` | NM-J01, NM-J02 | `ops.sh` check/start/stop/status: verification-gated start, bounded restart supervisors, flock single writer, mode-600 config, no secrets in argv; publisher reads its RPC URL from the environment | Live migration with INDEX uninterrupted (0.497); `ps` shows no keys or tokens; a second start is refused |
| `8089f7c` | NM-E07, G05, F10 | Evidence: public arbitrage, source-loss and movement guard; pricefeed regression | Arbitrage: buy-merge and split-sell each realized exactly +0.200 tUSDC on testnet. Pricefeed 527/527 (Node 24.21) |
| `951fd3a` | NM-J07 | Demo freeze in runbook §9 (identities, sequence, procedures, limitations) | — |
| this commit | NM-J05 | Final regression record | Contracts 928/928; pricefeed 527/527; oracle 122/124 (the 2 failures exist on the baseline); ABI 5/5 |

**Operational follow-ups (not code):**
- **Clear the movement latch:** the monitor calls `clearReduceOnly` on the BTC engine to re-enable perp trading.
- **Top up the observer:** about 1 h of runway at 60 s publishing.
