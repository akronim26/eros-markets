# Requests from Person B to Person A (integration/risk)

Raised during the A+B merge. Updated by Person A on 2026-10-02: the five requested ports are
implemented and committed. G0-G7 technical checks pass in order; final B delta review and
coordinator acceptance remain pending. Current choices are recorded in
[interface-reconciliation.md](../merge/interface-reconciliation.md).

1. **One lifecycle enum (spec §4.6): implemented.** File-level `AccountingState` in
   `contracts/src/math/MathTypes.sol` is used by A storage and re-exported through B's
   `RiskTypes.sol`. The bridge no longer converts duplicate types by ordinal (R-02).
2. **Market order epoch bump: implemented.** A owns `_bumpMarketOrderEpoch()` in `RiskStorage`;
   the bridge delegates to it. Halt metadata reads the authoritative epoch after A freeze (R-06).
3. **Claims complete: implemented.** Payout allocation increments `unpaidTraderClaims` only
   for nonzero atom entitlements. Successful payout marks `traderClaimed` once and decrements
   the counter; `allTraderClaimsPaid()` drives `ClearingPhase.COMPLETE` (R-10). LP, treasury and
   keeper withdrawals are independent of this trader-completion flag.
4. **Cash-claim hook: implemented.** The vault's authenticated `onCashClaim` callback invokes
   A's `_beforeCashClaim()`, which the bridge connects to B's `_riskBeforeCashClaim()`. This
   also covers direct `CollateralVault.claim` calls. `anyCashClaim` reflects successful cash
   payment; callback/transfer failure rolls it back. Conversion remains disabled (R-11).
5. **Reservation replace without its own decision: implemented.** A's `_replaceReservations`
   retains live/context/touch/epoch/coverage checks, and the bridge calls it after B's decision,
   without an extra RESERVATION authorization (R-16).
6. **Audit findings: fixes implemented and regressions pass.** A-F01 permits frozen
   settlement of preactivation allocations. A-F02 accumulates rational premium pieces before
   one segment ceiling. A-F03 separates `protocolFeeEscrowQ` from reserve `treasuryQ`, with the
   same immutable treasury beneficiary. The separate A-I01 global-vault fee-reclassification
   observation remains deferred; this is not a claim of exact conformance to that custody
   classification. See the dated addendum in [A-audit.md](../merge/A-audit.md).

Regression entry points:

- [A043IntegrationReview.t.sol](../../contracts/test/reviews/A043IntegrationReview.t.sol)
- [AClaimIntegrationReview.t.sol](../../contracts/test/reviews/AClaimIntegrationReview.t.sol)
- [AF01PreActivationLock.t.sol](../../contracts/test/audit/findings/AF01PreActivationLock.t.sol)
- [AF02PremiumRounding.t.sol](../../contracts/test/audit/findings/AF02PremiumRounding.t.sol)
- [AF03ProtocolFeeEscrow.t.sol](../../contracts/test/audit/findings/AF03ProtocolFeeEscrow.t.sol)
