# Risk + Book integration tracker

**GOV-01 workflow update (2026-10-03):** Risk and Order Book are one team. Mandatory
A/B peer review is retired; older review-pending changelog entries are historical, not current
approval dependencies. RB-I11's strict INDEX-prefix seal is implemented in `dcb6b0e`; 21 sampler
tests pass. G7 migration `bee683b` plus guard `e05bbbb` passes 17 mocked runner regressions;
full CI passes 832/130 suites. Ordered G0-G7 all exit 0 at metadata commit `c91acf7`. The user's
authorized G7 acceptance is recorded for that source at **2026-10-03 17:39:11 UTC**, without
peer signatures or a main merge/new deployment. See `docs/merge/UNIFIED_WORKFLOW.md`.

Updated **2026-10-03** · branch `integration/risk` · spec **1.1** / economics **1.0**.
This is the shared planning index, not a replacement for the spec, source-bound reviews or evidence.
Update it when behavior, counterpart status, validation or deployed addresses change.

## 1. Current decision and boundaries

- **Completed:** authorized controlled Monad testnet evaluation, chain **10143**. Foundation,
  setup, direct real-book trade, manual YES settlement and cash exit verified; this test market is **closed**.
- **Accepted:** non-oracle G7 integration at `c91acf7` after all required gates passed; recorded from the user's explicit conditional authorization, not invented peer approval.
- **Not approved:** a main merge, new deployment, production/mainnet release, leverage or production feeds/oracle calibration.
- Real Book + A accounting/custody + B risk are composed in `BookRiskEngine`; no unrestricted
  test feed or fault-injection helpers are exposed. The source retains **fully backed 1x** defaults;
  a bounded book-derived PERP sampler is being validated and is not part of the old live deployment.
- RB-I01 and RB-I02 repairs are implemented. Historical A043 fingerprints remain unchanged;
  migrated G7 must retain source-bound adversarial tests without inventing peer approval.
- **RB-I11 implemented:** require a strictly newer authenticated INDEX checkpoint before
  publishing captured PERP, retaining original timestamp, expiry and invalidation guards.
  **RB-I12 implemented:** local smoke reads the actual matching cap and completes both payout
  phases. Solidity `dcb6b0e` passes full CI; candidate `e05bbbb` passes final Monad/reference/SDK/
  format/ABI checks. Ordered gates at `c91acf7` pass; user-authorized G7 acceptance is recorded.
- The current user-authorized turn includes Book internals and all Risk & Clearing work, but excludes
  oracle implementation/integration. The approved sampler policy must preserve fresh-INDEX bootstrap
  placement, matching and cancellation before PERP warm-up. See [current fix ledger](NON_ORACLE_FIXES.md).
- User confirmed testnet and funded the evaluation deployer with 10 test MON. No credentials belong here.

## 2. Architecture and module map

```text
User order -> Book (matching, IDs, FIFO, cancel)
           -> internal IBookRiskHooks -> BookRiskAdapter / risk controllers
           -> RiskAccountingBridge -> A accounting (sole cash/position/reserve postings)
CollateralVault <-> isolated engine allocation / settlement and fee escrows
Signed INDEX -> PriceIngress -> ObservationStore -> risk pricing / bootstrap admission
Actual bounded Book depth -> capture / later-block + sealed-INDEX promotion -> PERP and BASIS (not deployed)
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
| Pricing | `contracts/src/pricing/{PriceIngress,ObservationStore,RiskPricing,SourceGuards,BookDepthSampler}.sol` |
| Finality / claims | `contracts/src/settlement/{ResolutionIngress,SettlementController,SnapshotLedger,PayoutLedger,ReserveClaims}.sol` |
| Pure arithmetic / reference | `contracts/src/math/`, `reference/a/`, `reference/b/` |
| Read models | `contracts/src/risk/RiskView.sol`, `packages/risk-sdk/`, `docs/app-state-fixtures.json` |

## 3. Feature status

“Implemented” means source exists; it does not imply production acceptance or live validation.

| Feature | Status | Remaining condition / limit |
|---|---|---|
| Real matching, IDs, FIFO, cancel, risk hooks | Implemented; full CI 832/130, Monad 99/11 and G0-G7 pass; G7 accepted at `c91acf7` | Integration acceptance is not production-counterpart acceptance or redeployment |
| Reduce-only / forced multi-maker taker | RB-I01 repaired `f2ebc61` | Refresh only active self-posting authorization; preserve unrelated stale versions |
| Partial reduce-only maker remainder | RB-I02 repaired `857b5c0`; 11 regressions pass | Refresh only the exact surviving successfully posted node |
| Canonical participant identity | RB-I03 mapping `bd9d5b9`; four new identity tests plus A016 pass | O(1) concrete consumer committed in `3942100` |
| Bootstrap execution-price band | RB-I04 repaired `93e971e`; five regressions pass | Candidate-only pruning; normal-mark reduction exceptions unchanged |
| Reduce-only maker admission | RB-I06 repaired `9c3a2e0`; four regressions pass | Ordinary resting makers cannot open exposure in monitor/scheduled reduce-only stages |
| Profile/listing arithmetic domains | RB-I07 repaired `0c93b63`; seven domain tests pass | Hazard, bootstrap-band and spread domain bounds; historical full CI/G0-G6 pass |
| Exact cash/position/reserve accounting | Implemented; current full CI 832/130 passes at unchanged Solidity `dcb6b0e` | Preserve paired atomicity and custody/coverage invariants; gates/acceptance separate |
| Reservations / cancel / rollback | Implemented; real-book regressions and invariants | Preserve generation, trader ownership and market/account epochs |
| Margin, coverage and cap checks | Implemented | Concrete engine is uncalibrated, cap 1, full backing |
| Premium | Exact cumulative-segment rounding; load 1 | No claim of production hazard calibration |
| Funding | Implemented and tested, **disabled in evaluation** | Enabling requires separate reviewed release evidence |
| Vault cash, fees and trader claims | Implemented, including A-I01 global fractional fee Q | Fractional Q stays distinct from withdrawable atoms |
| Reserve LP | Pre-activation shares; terminal redemption implemented | Seven-day notice; COMPLETE does not imply LP/fee withdrawals |
| Halt, rollover, floor and bounded settlement | Implemented | Testnet finality is manual fixture-controlled, not oracle consensus |
| Liquidation / pair / takeover | Implemented and locally tested | Concrete fixture has max liquidation lots/block 0; no calibrated throughput claim |
| Signed independent INDEX ingress | Implemented; signature/domain/staleness tests | Testnet uses synthetic controller-signed observations, not live collector |
| PERP book-depth observations | RB-I05 `3942100` plus RB-I11 `dcb6b0e`; 21 current sampler tests pass | Exact-N VWAP, 64 total examined nodes, no reduce-only depth, later-block sealed-prefix promotion; not live or production-qualified |
| Resolution oracle | Implementation on `origin/feat/oracle:ccbdb50` | Not merged or jointly tested with current real engine; no merge authorized this turn |
| Registry / factory | Oracle branch has real MarketRegistry and StubMarketFactory | Real engine factory + listing/auth join remains open |
| App / indexer | Risk SDK and fixtures available | Actual consumer and ownership coordination TBD |
| Conversion / recovery | Conversion disabled; concrete recovery disabled | Not an evaluation release feature |
| Concrete matching / aggregate batch bounds | RB-I09 implemented in `be3db1e`; seven batch tests pass | Concrete matching cap 8; action count at most 8 and aggregate declared non-POST_ONLY matching steps at most 8; sampler separately examines at most 64 |
| Monad size / deployment gas | Current runtime/creation/args/initcode 120,402/129,644/928/130,572 bytes; read-only estimate 27,853,253 gas at block 67,886,057 | Historical public fixture dependencies/listing, not fresh deployment configuration or receipt |
| REDUCE_ONLY collateral release | RB-I08 user decision recorded in `4a050df`; seven policy tests pass | Existing safe-excess guarded-release behavior retained; free-vault withdrawals remain separate, no production predicate change |
| SDK compiler reproducibility | RB-I10 exact local TypeScript 5.9.3 pin in `56787d2` | Three new Python runner tests and G0 technical rerun pass; no global compiler fallback |
| Published BASIS / INDEX coherence | RB-I11 implemented `dcb6b0e`; 21 sampler tests pass | Strictly newer authenticated INDEX seals capture prefix; valid waiting capture keeps its original expiry, no retrospective ObservationStore rewrite |
| Local complete smoke workflow | RB-I12 implemented `29c5f87`; 2 regressions and standalone offline script pass | Chain 31337 only; mock collateral/oracle, no RPC, no broadcast or public-chain receipt |

## 4. Validation and coverage evidence

| Scope | Recorded result / provenance |
|---|---|
| Previous full local risk suite at `5b82d9f` | **727 passed**, 117 suites, 0 failed/skipped (`tmp/full-risk-final.log`); prior `47149e5` baseline was 719/116; not current-delta or all-path Monad certification |
| New full local risk suite at `1654b9f` | **818 passed**, **128 suites**, zero failed/skipped (`tmp/non-oracle-full-risk.log`), fuzz **1,000**, invariants **48 x 64**; predates additional RB-I08/RB-I10 work, not a final all-work count |
| Full CI suite at `4a050df` | **825 passed**, **129 suites**, zero failed/skipped (`tmp/non-oracle-full-ci.log`); fuzz **10,000**, seed **0x45524f53**, invariants **256 x 128**; **1,469.81 seconds**, snapshot checking enabled; includes RB-I08 tests, does not close RB-I11 |
| Current full CI | Unchanged Solidity `dcb6b0e`: **832 tests / 130 suites**, zero failed/skipped, **1,461.88 seconds**, 10,000 fuzz, seed `0x45524f53`, invariants 256 x 128, strict snapshots; `tmp/unified-full-ci.log` |
| Current RB-I11 / RB-I12 and Monad validation | **21/21** sampler and **2/2** local smoke tests pass; final candidate `e05bbbb` MonadTen bundle **99 tests / 11 suites** in **3.04 seconds**, `tmp/unified-monad-final.log`; overlapping, not additive counts |
| Current Python / SDK | **66/156/8/7**, total **237**, including 17 mocked GOV runner regressions in A; SDK strict build/accounting reader and six Node tests pass |
| Current format / ABI | Both exit **0**; entries **294/256/35**, concrete source SHA256 `40e05c0e8034dcdba2a14fc19a97f2323412e69f92dc2146cac913ef8695cbb3` |
| Current read-only creation estimate | [estimate JSON](../../artifacts/risk/unified-deployment-estimate-2026-10-03.json), chain 10143 block **67,886,057**, gas **27,853,253**, headroom **2,146,747**; runtime/creation/args/initcode **120,402/129,644/928/130,572 bytes**; historical fixture dependencies, no broadcast |
| Current ordered gates | All **G0-G7 exit 0**, zero skipped, at `c91acf75ae9770f0bf5ae2238b4018202d57acd8`; counts **88/152/117/78/77/63/55/156**. G0 adds 17 GOV regressions; G7 counts actual Forge tests, not subprocesses. Counts overlap CI |
| Source-bound technical review checks | A043 **68**, B043 **3**, passing current technical checks; no independent peer signature or audit claimed |
| Current integration acceptance | User-authorized G7 acceptance recorded **2026-10-03 17:39:11 UTC** in `docs/spec/gate_status.json`, source `c91acf7`, `reviewed_by: []`. Runner artifacts retain false/null acceptance fields; no main merge/deployment |
| RB-I12 standalone local script | `tmp/rb-i12-local-script-green.log`: exit 0, chain 31337, no RPC/broadcast. Aggregate **45,478,303 gas** spans multiple virtual transactions, not one Monad transaction |
| Earlier non-oracle targeted regressions | RB-I02 **11/11**; RB-I03 **4 new identity + 1 A016**; RB-I04 **5/5**; RB-I06 **4/4**; RB-I07 **7/7**; RB-I05 **16/16** pass. `tmp/rb-i05-green.log` combined bundle **83/83** overlaps these suites; not additive to full-suite counts |
| Historical Monad targeted bundle | `tmp/non-oracle-monad-final.log` at `1654b9f`: **92/92**, **10 suites**, including 16 sampler, 7 batch-bound, 9 concrete-engine, 7 other mock-composition, 8 fixture, 8 smoke and 37 gas cases; supersedes the overlapping earlier 90-test bundle |
| RB-I09 failed original bound | Original 64-maker call: **58,109,534 gas** under default Prague and **30,994,601** under MonadTen; the latter exceeds 30M before intrinsic gas. Repaired concrete cap is 8, not a claim that 64 now fits |
| Full-history benchmarks at `1654b9f` | Three wrapped 1,024-entry rings; cold MonadTen call gas: eight-maker normal fill **8,077,028**, eight matching actions **11,722,715**, seven max-size POST_ONLY actions plus eight-fill IOC **16,619,933**; excludes intrinsic gas, not live receipts |
| Distinct-account sampling benchmarks | 64 distinct accounts; MonadTen call gas: view **3,143,792**, capture **3,383,491**, promotion **3,290,777**; committed in `1654b9f`, not live receipts |
| Earlier read-only deployment estimate | [estimate JSON](../../artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json): `be3db1e`, runtime/creation/args/initcode **120,253/129,495/928/130,423 bytes**, estimated gas **27,820,847** at block **67,865,259**; no broadcast and not an estimate of `dcb6b0e` |
| Historical Python after RB-I10 | **49 / 156 / 8 / 7 passed**, total **220**; current GOV runner coverage increases A by 17 to 66 and total to 237 |
| RB-I08 safe-release policy | `4a050df`, `tmp/rb-i08-policy.log`: **7/7** pass; monitor/time restrictions, flat/long/short accounts, preview/execution and retained safety guards |
| Real A+B+Book | `contracts/test/integration/RealBookIntegration.t.sol`: **23 passed** |
| Concrete signed ingress + book + cash settlement | `contracts/test/integration/BookRiskEngine.t.sol`: **9 passed** |
| Controlled test collateral / resolution fixtures | `contracts/test/integration/TestnetRiskFixtures.t.sol`: **8 passed** |
| Stateful real-book invariant suite | `contracts/test/invariant/integration/RealBookInvariants.t.sol`, `47149e5`: **48 runs × 64 depth**, zero reverts; fuzz **1,000**; deterministic path adds eight actual fills |
| Focused validation bundles | Recorded 28-test targeted and 60-test real-book bundles overlap suites above; **do not sum them** |
| Testnet exercise regressions | `contracts/test/integration/TestnetRiskSmoke.t.sol`: **8 passed under MonadTen**, `tmp/monad-smoke-tests.log`; included in the historical 727-test full suite at `5b82d9f` and rerun in the newer 92-test Monad bundle |
| Monad deployment rehearsal | [preflight JSON](../../artifacts/risk/monad-testnet-preflight-2026-10-03.json): exit 0, `1077dfa`, chain 10143, MonadTen, no broadcast |
| Live foundation deployment | [deployment JSON](../../artifacts/risk/monad-testnet-deployment.json): six successful receipts; four top-level runtime comparisons and role/binding checks; nested ReserveVault runtime not independently compared |
| Live trade/settlement/cash exit | [smoke JSON](../../artifacts/risk/monad-testnet-smoke.json): nine successful phase receipts, seven runtime comparisons, exact actor payouts 150/50 test tokens, zero vault balances, all trader claims paid at block 67,852,827 |
| Historical merged baseline | [merge-validation JSON](../../artifacts/risk/merge-validation-2026-10-03.json): 692 tests at earlier merged source, not current certification |
| Previous gates at `5b82d9f` | G0-G6 **exit 0**, counts **68/152/117/78/77/63/55**; G7 **exit 2 after six tests** because A043 did not cover that source/review delta; retained historical result |
| Historical ordered gates at `4a050df` | G0-G6 **exit 0**, counts **71/152/117/78/77/63/55**; G7 **exit 2 after six tests** at stale source-bound A043 review. GOV-01 later retires peer signatures; do not relabel this historical result |
| Separately verified downstream checks at `4a050df` | A044/B040/B041/B042/B043/B044 **exit 0**, **44/2/2/3/1/1** tests; direct G7 Solidity **6 tests / 2 suites**, exit 0; not an ordered G7 pass or new peer review (B043 is a technical harness) |
| Format / ABI checks at `4a050df` | `forge fmt --check` and ABI export/check **exit 0**; entries **294/256/35**, then-unchanged source digest; historical, separate from the current-source checks above |
| Previous consolidated evidence | [real-book-validation-2026-10-03.json](../../artifacts/risk/real-book-validation-2026-10-03.json), evidence commit `20330d8`, validated source `5b82d9f`; does not certify the current delta |
| Workflow / acceptance | Historical [A043](../../artifacts/reviews/A-on-B.md) and [B review](../../artifacts/reviews/B-on-A.md) stay unchanged. GOV-02 and all ordered gates pass; user-authorized G7 integration acceptance is recorded, without main/deployment authorization |

Historical `gas-engine.json`, `invariant-campaign.json`, and the 641-test `review-validation.json`
retain their original source/toolchain scope. They are not new Monad measurements. Passing
characterization tests do not close a finding; technical checks are not an independent security audit.

## 5. Reproduction, defaults and ABI contract

- Forge **1.8.3**, solc **0.8.30**, compiler EVM **Prague**, optimizer **200**;
  [foundry.toml](../../contracts/foundry.toml). Use `FORGE_SNAPSHOT_EMIT=false` to preserve book snapshots.
- Local risk profile: fuzz **1,000**, seed `0x45524f53`, invariants **48 × 64**, fail on revert;
  Current CI profile **10,000** fuzz / **256 × 128** invariants at Solidity `dcb6b0e`: **832/832** pass.
  Command: `FOUNDRY_PROFILE=ci FORGE_SNAPSHOT_EMIT=false FORGE_SNAPSHOT_CHECK=true forge test --fuzz-seed 0x45524f53 -vv`.
- Monad evaluation execution: `--network monad`, hardfork `monad:MonadTen`; compiler Prague unchanged.
  Local test code-size allowances are not deployment limits.
- Current concrete `maxFills()` is **8**. `maxBatchActions()` is `min(32, maxFills)`, hence **8**;
  cancel/place counts share that bound and declared non-POST_ONLY matching steps sum to at most **8**.
  POST_ONLY placements count as actions but consume no matching steps. Query these limits rather
  than reusing the old deployed engine's 64-step allowance. PERP sampling retains a separate 64-node cap.
- Units: 6-decimal atoms; one atom = `1e18 Q`; lot = 0.001 claim; tick = 0.001;
  winning payoff per lot = **1,000 atoms = `1e21 Q`**.
- Listing fixture: scheduled 10 days; max traders 1,024; max order lots `2^32`; depth 500 lots;
  spread/bootstrap band 0.05; max liquidation lots/block 0; INVALID grace 3,600 seconds, fallback 0.5,
  void interval 30 days. These are explicit **test inputs**, not calibrated production parameters.
- Controller is fixture token minter, resolution forwarder controller, signed-INDEX signer,
  governance/monitor/registry field and treasury. The registry field is not a registry implementation.
- Current ABI export/check exits **0**: `artifacts/risk/book-risk-engine-abi.json` **294** entries
  (concrete constructor/public book), `engine-abi.json` **256** (abstract, not deployment), and
  `vault-abi.json` **35** in the same directory. This supersedes the baseline 285/254/35 counts;
  `forge fmt --check` also exits **0**. Current exports are regenerated and source-bound after RB-I11.
- Actual env inputs, CLI-only arguments, safe blank current addresses and verified historical
  addresses are centralized in [configuration inventory](../runbooks/RISK_BOOK_ENV_AND_ADDRESSES.md).
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

Risk & Clearing and Order Book are now one unified team; resolution oracle remains excluded.
Price collector, real factory integration and frontend ownership remain **TBD/coordinated**, not invented teams.

| Next bounded item | Owner / acceptance evidence |
|---|---|
| Controlled testnet evaluation | **Completed:** receipts/code, real-book trade, manual YES finality, exact 150/50 actor cash exit and zero vault/claim liabilities recorded; no production approval |
| Current-source technical evidence | Complete: full CI, Monad/reference/SDK/ABI/format, read-only fixture creation estimate and ordered G0-G7 pass; [aggregate evidence](../../artifacts/risk/unified-integration-2026-10-03.json) retains exact source scope |
| G7 integration acceptance | Recorded at `c91acf7` under the user's explicit conditional authorization after all required checks passed; no peer signatures, main update or production deployment implied |
| RB-I08 release semantics | Complete: user-selected safe excess release, `4a050df`, seven tests; retain custody, backing, work-state and current-price guards |
| RB-I09 operational gas | Matching/batch bounds and historical benchmarks retained; current final Monad bundle and separately recorded 27,853,253-gas read-only creation estimate pass |
| RB-I10 SDK tooling | Complete: `56787d2` pins TypeScript 5.9.3; three Python runner regressions, G0 and 220-test Python baseline recorded |
| RB-I11 INDEX-prefix seal | Implemented `dcb6b0e`, 21 sampler tests pass; retain valid waiting captures and all invalidation guards, document below-30-second continuous feed cadence |
| RB-I12 local smoke | Implemented `29c5f87`, two regressions and standalone offline script pass; local mocked dependencies only |
| Join actual oracle branch | Oracle team + Risk: inspect `ccbdb50`, reconcile current interfaces and clocks, test halt/YES/NO/INVALID/Voided/conflicts/rollback on real engine; separately authorize integration |
| Wire actual registry/factory | Coordination TBD with existing teams: real MarketFactory, immutable listing hash/roles/registration and atomic deployment verified |
| Production qualification | Unified team and authorized counterparts: actual sources/bounds, chain gas, production roles and security/release decision. Recorded G7 integration acceptance is not production/mainnet authorization |

Oracle source exists at `origin/feat/oracle:oracle/src/ResolutionOracle.sol` and `MarketRegistry.sol`.
Its `docs_oracle/gates.json` records OG0/OG1 passed; OG2/OG3/OG3b not started. Those are the oracle
team's records, not this branch's independent audit or joint integration pass. `StubMarketFactory`
and `ResolutionEngineStub` are not substitutes for the real engine/factory acceptance above.

## 8. Change-impact checklist

- Identify item ID, owner, exact source range, spec rule and whether economics/ABI/storage/defaults change.
- Follow the current explicit scope: coordinated Book and Risk edits are authorized; oracle internals/integration remain excluded.
- Update independent expected-value tests and relevant book/accounting/settlement invariants.
- Run targeted tests, full applicable suites and affected gates; retain exact exit codes/toolchain/source.
- Recheck current concrete size/initcode and Monad gas when source/compiler/configuration changes.
- Follow unified technical validation; preserve historical reviewer hashes and never claim independent audit approval.
- Update manifest, counterpart status, this tracker and the turn log; distinguish historical/live evidence.
- Record conditional G7 acceptance only after its checks pass; keep production blocked on actual counterpart and separate release requirements.

## 9. Changelog

- `13ca730` / `96cf262` / `16f0d90`: main book hooks merged; 17 real-book regressions and 692-test baseline recorded.
- `f2ebc61`: RB-I01 taker continuation and restored-health liquidation stop repair; peer review pending.
- `1077dfa`: guarded concrete 1x engine, controlled testnet fixtures/deploy tooling; MonadTen rehearsal passed.
- `47149e5`: stateful real-book custody/reservation invariants; full local risk 719 and Python 217 pass.
- `5b82d9f` / 2026-10-03: six foundation and nine lifecycle transactions verified, terminal cash exit
  150/50; eight MonadTen regressions and full risk 727/117 passed; centralized this tracker.
- `20330d8`: consolidated source-bound/live evidence; separately verified downstream checks pass,
  while ordered G7 remains blocked on actual independent review and human acceptance.
- Historical non-oracle repair turn through `4a050df`: `bd9d5b9` canonical participant IDs; `857b5c0` maker remainder versions;
  `93e971e` actual bootstrap fill-price band; `9c3a2e0` reduce-only maker stage;
  `0c93b63` hazard/listing domains; `3942100` bounded PERP sampler; `be3db1e` measured matching/batch
  bounds; `1654b9f` full-history operational gas fixtures. Risk **818/128 suites**, Monad **92/10 suites**,
  ABI **294/256/35** and read-only new-source deployment estimate pass. `56787d2` pins the SDK
  compiler (Python total **220**); `4a050df` records approved safe releases with seven passing tests.
  Full CI at `4a050df` passes **825/129 suites**, fuzz **10,000**, invariants **256 x 128**;
  ordered G0-G6 exit0 (**71/152/117/78/77/63/55**), while G7 exits2 at stale A043 review.
  Format/ABI and separate downstream technical checks pass. Independent teammate review and
  human G7 acceptance remain pending. **RB-I11 remains open, policy
  confirmation pending and not implemented**; the historical deployment stays closed.
- `9081be0` GOV-01 retires mandatory A/B review; preceding changelog review/policy blockers
  describe the old workflow, not current requirements. `29c5f87` repairs the local smoke;
  `dcb6b0e` implements the selected RB-I11 seal with 21 passing sampler tests. Local smoke
  tests 2/2, standalone offline script exit 0, and affected Monad bundle 99/11 suites pass.
  GOV-02 `bee683b` plus guard `e05bbbb` pass 17 mocked runner regressions. Full CI 832/130,
  final Monad 99/11, Python 237, SDK, format/ABI and current read-only estimate pass. Ordered
  G0-G7 at `c91acf7` all exit 0, counts 88/152/117/78/77/63/55/156, zero skipped. The user's
  conditional G7 acceptance is recorded at 2026-10-03 17:39:11 UTC for that source; runner
  artifacts do not self-accept. No main update or replacement deployment is authorized or recorded.
