# A-side accounting implementation and merge runbook

Scope: all A production modules are abstract composition components plus custody,
locked-share and backstop contracts. `AccountingHarness`, `MockRiskDecision` and
`MockUSDC` are test-only. Do not deploy the harness as a risk engine.

## Reproduce local evidence

```sh
python -m unittest discover -s reference/tests/a -p 'test_a00*.py'
python -m reference.a.export_vectors
python -m reference.a.integrated_traces
FOUNDRY_PROFILE=risk forge test --root contracts --match-path 'test/math/A/*.t.sol'
FOUNDRY_PROFILE=risk forge test --root contracts --match-path 'test/risk/A/*.t.sol'
bash scripts/check-task.sh A040
bash scripts/check-task.sh A041
bash scripts/check-task.sh A042
bash scripts/check-task.sh A043
bash scripts/check-task.sh A044
```

A043 intentionally reports pending until B's actual sources can be reviewed.
G0-G7 are combined gates and remain pending the later merge. A's local passes
are neither combined acceptance nor release approval. Current task evidence is
under `artifacts/tasks`, W7 evidence under `artifacts/acceptance`.

## Composition and role boundaries

Use the single inheritance chain ending in `ReserveClaims`; it includes
`ClearingCore`, accrual, takeover, floor/freeze and all settlement accounting.
The constructor takes the collateral vault, reserve treasury, scheduled T and
immutable recovery/funding flags. Baseline flags are false. The constructor
creates one locked ReserveVault. Register the engine in CollateralVault through
the pinned governor before allocating funds. Users deposit real six-decimal
tokens and allocate from their own free balances. Direct token transfers are
unrecognized surplus. Every credit verifies the received amount.

B supplies internal `_riskContext` and `_riskAccept`. These are not public ledger
setters. A computes all cash/position changes, supplies candidate values to B,
and posts the matched amounts only after approval. B must implement role/intent
authentication, time-derived admissions, full-backing bootstrap, IM/MM/caps,
generation-safe book hooks, price history and finality. None is guessed by A.
The matcher/orchestrator owns its canonical Fill event; A emits PairedPosting
and exact AccountBalance/MarketBalance events for accounting replay.

## Accrual and sweeps

Before a quantity mutation, advance global funding using old OI and the previous
continuous freshness cutoff. Touch both accounts, retire only their funding
payer cushion, and post cumulative premium differences. Segment origins change
only on principal/position changes. Premium's directed bound is <12 Q per genuine
segment, with no dependence on neutral-touch frequency.

At epoch end B begins rollover. Process 1-32 accounts per page. Market allocation,
release, fills and account enrollment are blocked until completion. Finalize
clearing/cushion at zero, then open the next epoch at completion time. No processing
gap or skipped historical epoch is charged. An immutable funding feature flag
prevents the baseline listing from later turning funding on.

At the backing floor, B calls `_beginFloor` and advances bounded pages. Clock
alone does not mark reconciliation complete. Healthy accounts remain; deficient
whole accounts transfer cash and position together into reserve. An economic halt
overrides rollover/floor work. `_freeze` does constant work, records the true halt
and a separate legal accrual cutoff, and enables a separate snapshot sweep.
Previously touched rollover accounts are not charged a second time.

## Settlement and exits

1. B authenticates finality and supplies its immutable payoff price and finality ID.
   An early INVALID may remain price-pending until B's listed window policy resolves.
2. Complete snapshot pages, including zero-position cash holders. Check net lots,
   funding clearing/cushion, both cover inequalities and signed cash conservation.
3. Scan positive claims. Baseline underfunding reports recovery required; no live
   haircut toggle exists. Any bound backstop contribution must become real custody
   before allocation. A separate prelisted recovery profile fixes pro-rata payouts.
4. Allocate every trader's atom-floor claim into locked vault escrow in pages.
   Neither the engine nor direct vault claims can pay before final preparation.
5. Allocate LP entitlements from the frozen total-share denominator in pages.
   Reclassify protocol fees, keeper liabilities, fractional and aggregate dust.
   Enable claims only when every liability is classified.
6. Claims pay the fixed owner. Failed transfers restore liabilities and do not
   block other owners. LPs require their fixed-share seven-day notice; additional
   preactivation shares require renewal of a notice covering the new share count.
   LP redemption is safe before traders click claim because traders already have
   separate escrow. Keeper fractions remain in their own Q ledgers. Treasury
   withdraws only whole atoms and retains its fractional Q.

Live conservation uses booked account cash plus reserve cash, protocol fees,
keeper payables and fundingClearingQ. After payouts are allocated, frozen account
balances are historical: reconcile outstanding LP/treasury/keeper liabilities
against remaining engine allocation, and trader escrows separately in the vault.

## Limits and measurements

1024 traders, 256 reserve shareholders and 32-account pages are enforced. Total OI
is capped at 2^40 lots to keep worst-case takeover inventory within the reserve's
position domain. Funding tariffs are bounded, hourly and immutable within an epoch.
Gas reports use actual local Foundry/Prague measurements; they are not Monad page
pricing or testnet transaction ceilings. Final A+B runtime size, calibration,
source/token addresses, counterpart ABI checks and independent audit remain release
work. The existing book source/tests/snapshots stay unchanged in this branch.

The aggregate harness uses Foundry's IS_TEST marker and is excluded from production
size reports. Its runtime size is still measured separately in the gas artifact;
the risk profile permits 65,536 bytes for testing. This is not an EIP-170-compliant
production deployment. Gas sweeps exercise 1024 funded accounts with open positions
and an active funding/premium epoch. A's math and SDK tests need Python, Forge,
Node and TypeScript; all pinned compiler/dependency versions appear in evidence.
