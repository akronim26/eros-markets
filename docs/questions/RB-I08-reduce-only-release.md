# RB-I08: collateral release during REDUCE_ONLY

Date: 2026-10-03. Status: DECISION CONFIRMED by the user; existing behavior retained.

## Confirmed decision

The user selected: **keep safe excess-collateral releases available**. Both monitor-triggered
and scheduled REDUCE_ONLY retain releases for flat accounts and accounts with positions when
the existing price, order-aware IM/full-backing, accounting-readiness and coverage checks pass.
No production behavior change is needed. This does not authorize stale pricing, new funding,
release of required collateral, bypassing a rollover/halt, or restrictions on free-vault withdrawals.

The narrow clarification is recorded in `docs/spec/risk_spec.md` section 5.1. Regressions are in
`contracts/test/reviews/ReduceOnlyReleasePolicy.t.sol`: monitor/time, flat/long/short, same-block
preview/execution, order-aware collateral, stale-price rejection, independent free withdrawal
and rollover readiness. The focused run passes **7/7**, recorded in `tmp/rb-i08-policy.log`;
the broader final CI run remains separate evidence.
This policy decision is not independent teammate review, a review fingerprint or G7 acceptance.

## Historical ambiguity

`docs/spec/risk_spec.md` section 5.1 describes REDUCE_ONLY as permitting "top-up and
safe reduction only". Its sections 2.3 and 4.3 separately require collateral release
to pass current stage, order-aware initial margin and coverage checks. They do not
explicitly say whether a release of surplus collateral that preserves those checks
counts as a permitted risk reduction during this stage.

`contracts/src/risk/RiskContextPort.sol::_riskReleaseDecision` rejects halted markets,
insufficient coverage, unavailable required prices and deficient final-day backing.
It does not reject solely because the derived stage is REDUCE_ONLY. Consequently an
otherwise permitted release remains possible after a monitor restriction or during
the scheduled final hour. Free-vault withdrawals are a separate operation and do not
release market collateral.

## Original decision request (resolved)

Choose explicitly whether market collateral releases during REDUCE_ONLY must:

1. remain available when the existing current-price, order-aware IM/full-backing,
   accounting-readiness and coverage checks pass; or
2. return the stage rejection even if those economic checks pass.

The decision should cover both monitor-triggered and scheduled restrictions, flat
accounts as well as accounts with positions, and preview/execution parity. It must
not block free-vault withdrawals or imply that a stale mark becomes usable.

The user selected option 1. Historical wording above explains why clarification was requested;
it is not an outstanding request to change the release predicate.
