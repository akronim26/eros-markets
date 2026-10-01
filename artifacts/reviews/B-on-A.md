# B review of Person A cash and reserve transitions (B043)

Review status: BLOCKED — no Person A module exists on `feat/risk` (A001–A044 not merged).

Spec v1.1, economic baseline v1.0. This is a cross-review, not an external audit. B does not edit
A files; every finding goes to A as a reproducer. Nothing below was run against A code, because
there is no A code on this branch. Each item is a concrete reproducer to run at G6/G7 against A's
real modules (or against `contracts/test/harness/B/RiskHarness.sol` with A's port swapped in).

## Routes and protected liabilities to review

| # | Route / liability (A owner) | Required property (spec) | Reproducer to run | Result |
|---|---|---|---|---|
| 1 | Deposit / allocate (A017 CollateralVault) | received atoms == credited; fee-on-transfer rejected; allocation credits cashQ atom-for-atom (§2.3) | deposit 120 USDC with a 1% fee-on-transfer token -> revert; allocate 120,000,000 atoms -> cashQ += 120e6*Q exactly | NOT RUN (A absent) |
| 2 | Guarded release (A017 + B `_riskReleaseDecision`) | release cannot bypass B's decision; missing mark -> only exactly backed (§4.1) | bootstrap account with d0>0 requests release -> A must refuse because B returns INVALID_PRICE_OR_SIZE | NOT RUN |
| 3 | Paired posting (A018 Accounting) | dc = -dx*tick*Q both legs, fees credit exactly, no lone leg (§6.1) | 17 lots @613: +-17 lots, -/+10,421*Q; inject failure on leg 2 -> whole tx reverts | NOT RUN |
| 4 | Funding accrual (A022) | reserve payer/receiver slack identity; cushion += A - max(p,0) (§6.2) | reserve +40, traders +60/-100, dF = .01: R -0.4, Dbar +0.6, B -1 -> slack unchanged; a `Dbar += 1` implementation must fail this test | NOT RUN |
| 5 | Funding budget / OI change (A022) | affordable seconds at new OI, no reauthorization (§6.2) | rate .001/claim/s, OI 100->200 after 20 s, B 10: stop at the 40th further second | NOT RUN |
| 6 | Freshness stop (A022 + B S-7) | `_onFreshnessAdvance(old)` accrues to the old endpoint before it moves; no restart in a stopped epoch | gap at t+630 then fresh at t+700: funding cutoff stays t+630 for the epoch (B021 test, A side) | NOT RUN |
| 7 | Premium integral (A023) | neutral touches charge the same cumulative Q; ceil per segment (§6.3) | deficit 100->110 over 1 h at .0002/day = .000875 USDC; sync at 30 and 60 min == sync at 60 min only | NOT RUN |
| 8 | Premium surcharge / capitalization (A023) | 4x six-hour renewal only on new principal deficit; capitalize once at rollover | 4x case = .0035 USDC; repeated rollover page does not capitalize twice | NOT RUN |
| 9 | Account touch (A024) | removes exactly its cushion share; contribution replaced once | B027 G4 sequence (I-9) must be accepted; two touches in one action charge once | NOT RUN |
| 10 | Rollover (A025) | <= 32/page, frozen cutoff, clearing and cushion zero at commit; calls B `_riskEpochOpenedWithGuards()` | interrupted page retried: same totals; skipped hours accrue nothing | NOT RUN |
| 11 | Takeover (A028) | moves cash AND position; slack change max(e_y,0) per outcome; fee 0 (§3.1) | E = 0 account (cash -600, long 1,000 claims): reserve NO slack +0, YES slack +400 USDC | NOT RUN |
| 12 | Liquidation fee (A029) | one atom per lot, half reserve half keeper in Q, odd half-atom kept; waived amount honoured (M-19) | close 1 lot: keeper gets Q/2; withdraw keeper atoms -> 0 atoms, Q/2 retained | NOT RUN |
| 13 | Freeze (A030) | accrual cutoff = min(halt, epoch end, frozen rollover); OI includes reserve | B034/B037 fixtures with real freeze: OI 1,500,000 lots for long 1e6 + reserve 0.5e6 | NOT RUN |
| 14 | Floor sweep (A031) | frozen registry; takeover only via B predicate 2 | B029 suite with real FloorAccounting | NOT RUN |
| 15 | Snapshot/payout (A034/A035) | once per account; YES/NO/INVALID claims = golden G06 | Alice/Bob: NO 0/700, YES 520/0, INVALID(0.5) 20/200 USDC | NOT RUN |
| 16 | Fee escrow before LP residual (A035/A038) | protocol/keeper Q reclassified before reserve residual; fractions never LP dust | half-atom keeper liability survives LP redemption (verify_spec_vectors V17) | NOT RUN |
| 17 | Recovery calculator (A036) | baseline recoveryEnabled=false immutable; rho floor, P=0 safe | baseline finish with shortfall -> RECOVERY_REQUIRED, no haircut | NOT RUN |
| 18 | Claims (A037) | once-only, CEI, failed transfer keeps liability; must call B `_riskBeforeCashClaim()` (S-12) | blocked recipient does not block another; second claim no effect | NOT RUN |
| 19 | Reserve claims (A038) | matured notices against frozen denominator after all escrows | LP redeems before some trader claims; every trader still receives fixed entitlement | NOT RUN |

## Interface demands B places on A (from the B lane)

S-2, S-3 (QMath, MathTypes names), S-5 (every accounting-port function), S-7 (freshness hook),
S-9 (virtually settled views), S-10 (floor port), S-11 (epoch bounds, claim-state views), S-12
(cash-claim hook), S-13 (SDK accounting shape), I-9 (G4 call sequence). See
`docs/merge/B-assumptions.md`.

## Open critical defects

None can be stated: nothing was reviewable. This review must be redone on the merged G6 commit;
until then B043 stays blocked.
