# Risk + Book integration tracker

Updated **2026-10-03** · branch `integration/risk` · spec **1.1** / economics **1.0**.
This is the shared planning index, not a replacement for the spec, source-bound reviews or evidence.
Update it when behavior, counterpart status, validation or deployed addresses change.

## 1. Current decision and boundaries

- **Completed:** authorized controlled Monad testnet evaluation, chain **10143**. Foundation,
  setup, direct real-book trade, manual YES settlement and cash exit verified; this test market is **closed**.
- **Not approved:** production/mainnet release, leverage, production feeds/oracle calibration, or G7 acceptance.
- Real Book + A accounting/custody + B risk are composed in `BookRiskEngine`; no unrestricted
  test feed or fault-injection helpers are exposed. It is **fully backed 1x bootstrap-only**:
  the production PERP book-depth sampler is missing.
- RB-I01 repair is implemented but awaiting independent teammate review. RB-I02 maker remainder
  liveness remains open. Existing A043 fingerprints are stale after the new source; do not self-approve.
- User confirmed testnet and funded the evaluation deployer with 10 test MON. No credentials belong here.

## 2. Architecture and module map

```text
User order -> Book (matching, IDs, FIFO, cancel)
           -> internal IBookRiskHooks -> BookRiskAdapter / risk controllers
           -> RiskAccountingBridge -> A accounting (sole cash/position/reserve postings)
CollateralVault <-> isolated engine allocation / settlement and fee escrows
Signed INDEX -> PriceIngress -> ObservationStore -> risk pricing / bootstrap admission
Pinned resolution authority -> halt/finality -> bounded snapshot/payout scans -> cash claims
```

Paths below are relative to the repository root.

| Area | Primary implementation |
|---|---|
| Concrete composition | [BookRiskEngine.sol](../../contracts/src/engine/BookRiskEngine.sol), [RiskAccountingBridge.sol](../../contracts/src/engine/RiskAccountingBridge.sol) |
| Matching and seam | `contracts/src/Book.sol`, `contracts/src/interfaces/IBookRiskHooks.sol`, `contracts/src/risk/BookRiskAdapter.sol` |
| Admission / reservations | `contracts/src/risk/{OrderAdmission,OrderRisk,OrderLifecycle,TradePreview}.sol` |
| Ledger / accrual | `contracts/src/risk/{Accounting,AccountSync,FundingAccounting,PremiumAccounting,ReserveAccounting}.sol` |
| Custody / LP | `contracts/src/vaults/{CollateralVault,ReserveVault,BackstopPool}.sol` |
| Lifecycle / liquidation | `contracts/src/risk/{ClearingCore,RiskLifecycle,EpochRollover,FreezeAccounting,RiskLiquidation,LiquidationBookAdapter}.sol` |
| Pricing | `contracts/src/pricing/{PriceIngress,ObservationStore,RiskPricing,SourceGuards}.sol` |
| Finality / claims | `contracts/src/settlement/{ResolutionIngress,SettlementController,SnapshotLedger,PayoutLedger,ReserveClaims}.sol` |
| Pure arithmetic / reference | `contracts/src/math/`, `reference/a/`, `reference/b/` |
| Read models | `contracts/src/risk/RiskView.sol`, `packages/risk-sdk/`, `docs/app-state-fixtures.json` |

## 3. Feature status

“Implemented” means source exists; it does not imply production acceptance or live validation.

| Feature | Status | Remaining condition / limit |
|---|---|---|
| Real matching, IDs, FIFO, cancel, risk hooks | Implemented and locally integrated | Book internals remain book-team owned; RB-I02 open |
| Reduce-only / forced multi-maker taker | RB-I01 repaired `f2ebc61` | Independent teammate review required; do not restore stale authorization |
| Partial reduce-only maker remainder | **OPEN RB-I02** | Position-version change makes remaining maker order stale |
| Exact cash/position/reserve accounting | Implemented; full local suite passes | Preserve paired atomicity and all custody/coverage invariants |
| Reservations / cancel / rollback | Implemented; real-book regressions and invariants | Preserve generation, trader ownership and market/account epochs |
| Margin, coverage and cap checks | Implemented | Concrete engine is uncalibrated, cap 1, full backing |
| Premium | Exact cumulative-segment rounding; load 1 | No claim of production hazard calibration |
| Funding | Implemented and tested, **disabled in evaluation** | Enabling requires separate reviewed release evidence |
| Vault cash, fees and trader claims | Implemented, including A-I01 global fractional fee Q | Fractional Q stays distinct from withdrawable atoms |
| Reserve LP | Pre-activation shares; terminal redemption implemented | Seven-day notice; COMPLETE does not imply LP/fee withdrawals |
| Halt, rollover, floor and bounded settlement | Implemented | Testnet finality is manual fixture-controlled, not oracle consensus |
| Liquidation / pair / takeover | Implemented and locally tested | Concrete fixture has max liquidation lots/block 0; no calibrated throughput claim |
| Signed independent INDEX ingress | Implemented; signature/domain/staleness tests | Testnet uses synthetic controller-signed observations, not live collector |
| PERP book-depth observations | **OPEN** | No concrete bounded stale-aware sampler; normal PERP mode not qualified |
| Resolution oracle | Implementation on `origin/feat/oracle:ccbdb50` | Not merged or jointly tested with current real engine; no merge authorized this turn |
| Registry / factory | Oracle branch has real MarketRegistry and StubMarketFactory | Real engine factory + listing/auth join remains open |
| App / indexer | Risk SDK and fixtures available | Actual consumer and ownership coordination TBD |
| Conversion / recovery | Conversion disabled; concrete recovery disabled | Not an evaluation release feature |
| Monad size / deployment gas | Concrete sizes fit; live foundation receipts/code verified | Engine receipt gas 27,904,929; broader operational gas qualification open |

## 4. Validation and coverage evidence

| Scope | Recorded result / provenance |
|---|---|
| Current full local risk suite at `5b82d9f` | **727 passed**, 117 suites, 0 failed/skipped (`tmp/full-risk-final.log`); prior `47149e5` baseline was 719/116; not all-path Monad certification |
| Python A / B / audit / integration | **46 / 156 / 8 / 7 passed**, total 217 |
| Real A+B+Book | `contracts/test/integration/RealBookIntegration.t.sol`: **23 passed** |
| Concrete signed ingress + book + cash settlement | `contracts/test/integration/BookRiskEngine.t.sol`: **9 passed** |
| Controlled test collateral / resolution fixtures | `contracts/test/integration/TestnetRiskFixtures.t.sol`: **8 passed** |
| Stateful real-book invariant suite | `contracts/test/invariant/integration/RealBookInvariants.t.sol`, `47149e5`: **48 runs × 64 depth**, zero reverts; fuzz **1,000**; deterministic path adds eight actual fills |
| Focused validation bundles | Recorded 28-test targeted and 60-test real-book bundles overlap suites above; **do not sum them** |
| Testnet exercise regressions | `contracts/test/integration/TestnetRiskSmoke.t.sol`: **8 passed under MonadTen**, `tmp/monad-smoke-tests.log`; also included in the current 727-test full suite |
| Monad deployment rehearsal | [preflight JSON](../../artifacts/risk/monad-testnet-preflight-2026-10-03.json): exit 0, `1077dfa`, chain 10143, MonadTen, no broadcast |
| Live foundation deployment | [deployment JSON](../../artifacts/risk/monad-testnet-deployment.json): six successful receipts; four top-level runtime comparisons and role/binding checks; nested ReserveVault runtime not independently compared |
| Live trade/settlement/cash exit | [smoke JSON](../../artifacts/risk/monad-testnet-smoke.json): nine successful phase receipts, seven runtime comparisons, exact actor payouts 150/50 test tokens, zero vault balances, all trader claims paid at block 67,852,827 |
| Historical merged baseline | [merge-validation JSON](../../artifacts/risk/merge-validation-2026-10-03.json): 692 tests at earlier merged source, not current certification |
| Current gates at `5b82d9f` | G0-G6 **exit 0**, counts **68/152/117/78/77/63/55**; G7 **exit 2 after six tests** because A043 does not cover current source/review regressions |
| Separately verified downstream checks | A044/B040/B041/B042/B043/B044 **exit 0**, **44/2/2/3/1/1** tests; direct `test/gates/G7.t.sol` **6 passed**, exit 0; not an ordered G7 pass or new peer review (B043 is a technical harness) |
| Current consolidated evidence | [real-book-validation-2026-10-03.json](../../artifacts/risk/real-book-validation-2026-10-03.json), evidence commit `20330d8`, validated source `5b82d9f` |
| Reviews / acceptance | [A043](../../artifacts/reviews/A-on-B.md) stale; [B review](../../artifacts/reviews/B-on-A.md) source-specific; [G7](../spec/gate_status.json) has empty `reviewed_by`, null `merge_sha`, human acceptance blocked; no self-refresh |

Historical `gas-engine.json`, `invariant-campaign.json`, and the 641-test `review-validation.json`
retain their original source/toolchain scope. They are not new Monad measurements. Passing
characterization tests do not close a finding; passing tests do not replace independent review.

## 5. Reproduction, defaults and ABI contract

- Forge **1.8.3**, solc **0.8.30**, compiler EVM **Prague**, optimizer **200**;
  [foundry.toml](../../contracts/foundry.toml). Use `FORGE_SNAPSHOT_EMIT=false` to preserve book snapshots.
- Local risk profile: fuzz **1,000**, seed `0x45524f53`, invariants **48 × 64**, fail on revert;
  CI profile is **10,000** fuzz / **256 × 128** invariants, not silently claimed as freshly rerun.
- Monad evaluation execution: `--network monad`, hardfork `monad:MonadTen`; compiler Prague unchanged.
  Local test code-size allowances are not deployment limits.
- Units: 6-decimal atoms; one atom = `1e18 Q`; lot = 0.001 claim; tick = 0.001;
  winning payoff per lot = **1,000 atoms = `1e21 Q`**.
- Listing fixture: scheduled 10 days; max traders 1,024; max order lots `2^32`; depth 500 lots;
  spread/bootstrap band 0.05; max liquidation lots/block 0; INVALID grace 3,600 seconds, fallback 0.5,
  void interval 30 days. These are explicit **test inputs**, not calibrated production parameters.
- Controller is fixture token minter, resolution forwarder controller, signed-INDEX signer,
  governance/monitor/registry field and treasury. The registry field is not a registry implementation.
- Current ABI export/check **PASS**: `artifacts/risk/book-risk-engine-abi.json` **285** entries
  (concrete constructor/public book), `engine-abi.json` **254** (abstract, not deployment), and
  `vault-abi.json` **35** in the same directory. Formatter check also passed.
- Reference interfaces: `contracts/src/interfaces/{IBookRiskHooks,IResolutionIngress,IPriceSource,IMarketConfig}.sol`.
  Oracle enum is NONE/YES/NO/INVALID = 0/1/2/3; **Voided calls settleInvalid**, not enum 4.

## 6. Testnet deployment ledger

| Item | Value / status |
|---|---|
| Chain | Monad testnet **10143**; no mainnet authorization |
| Public deployer | [0x76765dc99c2C9aeD0b2C23b39960f0de0aC5DA46](https://testnet.monadscan.com/address/0x76765dc99c2C9aeD0b2C23b39960f0de0aC5DA46) |
| Concrete engine | [0x4aE742676984D2C383645E4745Eaf3943b67DE72](https://testnet.monadscan.com/address/0x4aE742676984D2C383645E4745Eaf3943b67DE72) |
| Test collateral | [0x57649a7424df6e96fa4b20598f70f2e7b5d29e62](https://testnet.monadscan.com/address/0x57649a7424df6e96fa4b20598f70f2e7b5d29e62) |
| Collateral vault | [0x1611cb4223833a3f72c37718210d18415475e498](https://testnet.monadscan.com/address/0x1611cb4223833a3f72c37718210d18415475e498) |
| Manual resolution authority | [0x476d707343f8e238ed719d852d817318c576913a](https://testnet.monadscan.com/address/0x476d707343f8e238ed719d852d817318c576913a) |
| Controlled smoke coordinator | [0x0D54dd5411d2a036Bc40aD854aB14289FF9075AF](https://testnet.monadscan.com/address/0x0D54dd5411d2a036Bc40aD854aB14289FF9075AF) |
| Engine creation / vault registration / authority bind | [create](https://testnet.monadscan.com/tx/0x4875c968e2be0c2d1366a15d8ea2955c6b40d83fcdd803b13b371659c029c0d1) / [register](https://testnet.monadscan.com/tx/0x8649b0daebdf54bf26524f2bf80a4bf5b31c56720d689948f1067b4d0afea522) / [bind](https://testnet.monadscan.com/tx/0x017754717bc7e9e47da4b6c83952f1bd8639e97ef014da73b4ca11efe1495014); all six foundation receipts in deployment JSON |
| Concrete runtime / creation / constructor / total initcode | **114,546 / 123,665 / 928 / 124,593 bytes** at `1077dfa` |
| Verified Monad limits | Runtime **131,072**; initcode **262,144** bytes; transaction gas **30,000,000** |
| Engine deployment receipt gas used | **27,904,929**; historical simulation plan 27,683,989 and six-transaction sum 30,414,787 are distinct |
| Deployment / exercise / offline trade source | `contracts/script/{DeployTestnetRiskBook,ExerciseTestnetRiskBook,PrepareTestnetTrade}.s.sol` |
| Live evidence record | [monad-testnet-deployment.json](../../artifacts/risk/monad-testnet-deployment.json), read-only verification after actual broadcast |
| Setup / direct trade | Setup **PASS**; [trade PASS](https://testnet.monadscan.com/tx/0x0bbc3efecc17f366040d259759767d3e608a7a8d29521763271c886cff8d5dce) |
| Halt / YES finality / settlement-cash-exit | [halt](https://testnet.monadscan.com/tx/0x0f33901e3c005a114aaef028c59a7e518d3c8e7b67a37c9bdeb581cefb81c66b) / [finalize](https://testnet.monadscan.com/tx/0xf9a6e5b76a848ff111a390e207d2c8eddb87e45f8a4e1b9883ca793beea4127a) / [settle and withdraw](https://testnet.monadscan.com/tx/0x9193a7ce574c51bb2e83f7f2be521add1b9bfb70098b0cca16382ba2743b6f25), all **PASS** |
| Final custody / claims | Buyer/seller controlled actors hold **150,000,000 / 50,000,000 atoms** (150/50 test tokens); vault token/recognized atoms **0**, unpaid trader claims **0**, market **closed** |
| Total actual receipts / gas / fees | **15 successful**, **40,887,693 gas**, **4.223887319407733183 test MON**; deployer remaining **5.776112680592266817 test MON**; no further broadcast planned |

The dependencies are controller-only test collateral and manual finality plus synthetic signed INDEX.
These are not real USDC payouts. Trusted-RPC/runtime comparisons do not independently authenticate
chain finality or reproduce source; this one scenario does not certify funding, liquidation, LP exits or INVALID.
Do not publish RPC endpoint credentials, signer secrets, keystores or passwords. Deployment alone does
not fund/activate the market; the separate controlled setup/trade now did so. The original fork-based
trade window expired during estimation with **no broadcast**. Offline preparation now signs 11 samples
spaced 30 seconds across 300 seconds; submit promptly without weakening freshness checks.
See the [testnet runbook](../runbooks/monad-risk-book-testnet.md),
[release manifest](../../artifacts/risk/release-manifest.json) and [counterpart status](../../artifacts/risk/counterpart-status.json).
Chain constraints: [Monad differences](https://docs.monad.xyz/developer-essentials/differences),
[summary](https://docs.monad.xyz/developer-essentials/summary), [Foundry](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry).

## 7. Ownership, open work and acceptance

The existing teams are **Risk & Clearing (A+B)**, **order book**, and **resolution oracle**.
Price collector, real factory integration and frontend ownership remain **TBD/coordinated**, not invented teams.

| Next bounded item | Owner / acceptance evidence |
|---|---|
| Controlled testnet evaluation | **Completed:** receipts/code, real-book trade, manual YES finality, exact 150/50 actor cash exit and zero vault/claim liabilities recorded; no production approval |
| Review RB-I01 `f2ebc61` and new concrete composition | Independent Risk teammate: disposition, adversarial reduction/version/rollback evidence, source fingerprints and affected gates refreshed only by actual reviewer |
| Resolve RB-I02 | Book team + Risk seam coordination: intended maker remainder semantics agreed; multi-fill/cancel/epoch/health/coverage regressions, no stale authorization bypass |
| Design bounded PERP depth sampler | Book team owns book internals; Risk validates pricing seam: deterministic bounded depth, stale-order exclusion, authenticity/freshness, manipulation and no-liquidity tests |
| Join actual oracle branch | Oracle team + Risk: inspect `ccbdb50`, reconcile current interfaces and clocks, test halt/YES/NO/INVALID/Voided/conflicts/rollback on real engine; separately authorize integration |
| Wire actual registry/factory | Coordination TBD with existing teams: real MarketFactory, immutable listing hash/roles/registration and atomic deployment verified |
| Production qualification | Risk A+B and counterparts: calibrated sources/bounds, current CI campaigns and chain gas, production role design, independent reviews, human G7/release acceptance |

Oracle source exists at `origin/feat/oracle:oracle/src/ResolutionOracle.sol` and `MarketRegistry.sol`.
Its `docs_oracle/gates.json` records OG0/OG1 passed; OG2/OG3/OG3b not started. Those are the oracle
team's records, not this branch's independent audit or joint integration pass. `StubMarketFactory`
and `ResolutionEngineStub` are not substitutes for the real engine/factory acceptance above.

## 8. Change-impact checklist

- Identify item ID, owner, exact source range, spec rule and whether economics/ABI/storage/defaults change.
- Preserve book/oracle internals ownership; request counterpart changes instead of silently patching them.
- Update independent expected-value tests and relevant book/accounting/settlement invariants.
- Run targeted tests, full applicable suites and affected gates; retain exact exit codes/toolchain/source.
- Recheck current concrete size/initcode and Monad gas when source/compiler/configuration changes.
- Obtain the other Risk teammate's economic review; never reuse stale hashes or self-approve.
- Update manifest, counterpart status, this tracker and the turn log; distinguish historical/live evidence.
- Keep production blocked until real counterpart acceptance and human release/G7 decision are recorded.

## 9. Changelog

- `13ca730` / `96cf262` / `16f0d90`: main book hooks merged; 17 real-book regressions and 692-test baseline recorded.
- `f2ebc61`: RB-I01 taker continuation and restored-health liquidation stop repair; peer review pending.
- `1077dfa`: guarded concrete 1x engine, controlled testnet fixtures/deploy tooling; MonadTen rehearsal passed.
- `47149e5`: stateful real-book custody/reservation invariants; full local risk 719 and Python 217 pass.
- `5b82d9f` / 2026-10-03: six foundation and nine lifecycle transactions verified, terminal cash exit
  150/50; eight MonadTen regressions and full risk 727/117 passed; centralized this tracker.
- `20330d8`: consolidated source-bound/live evidence; separately verified downstream checks pass,
  while ordered G7 remains blocked on actual independent review and human acceptance.
