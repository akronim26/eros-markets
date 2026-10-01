# Requests from Person B to Person A (integration/risk)

Raised during the A+B merge. None blocks a gate today; each has a documented interim
resolution in docs/merge/interface-reconciliation.md. Person A owns the changes.

1. **One lifecycle enum (spec §4.6).** `RiskStorage.Work` duplicates spec `AccountingState`
   (same ordinals). Please rename it to `AccountingState` in `MathTypes` so both lanes use one
   type. Interim: B converts by ordinal (R-02).
2. **Market order epoch bump.** Please add an A-owned `_bumpMarketOrderEpoch()` (B invalidates
   all resting orders at the backing floor and at halt). Interim: the bridge increments
   `marketOrderEpoch` directly (R-06).
3. **Claims complete.** A037 has no "all entitlements claimed" indicator, so `ClearingPhase.COMPLETE`
   is never reported. Please add a counter of unpaid trader entitlements (R-10).
4. **Cash-claim hook.** `claimTrader` should call a `_beforeCashClaim()` virtual hook so a future
   conversion extension can fence cash claims (R-11). Conversion stays disabled in v1.
5. **Reservation replace without its own decision.** `_setReservations` asks B for a RESERVATION
   decision that B already made; a port variant that only replaces the contribution (keeping the
   live gate and coverage assertion) would remove one authorization round trip (R-16).
6. **Audit findings** A-F01 (Medium), A-F02 and A-F03 (Low): see docs/merge/A-audit.md. Left open
   per the integration rule (only Critical/High are fixed during the merge).
