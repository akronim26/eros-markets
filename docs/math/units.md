# Risk math units and G0 proposal

Status: A001 implementation; proposed interface `risk-math-g0-draft-1`.
G0 has not been accepted. This document does not freeze Person B's signatures.
Selected economics: risk specification v1.1, economic baseline v1.0.

## Formula translation

The supplied `full-risk-analysis.pdf`, page 4, identities A1-A6, uses signed
claims `z`, collateral cash `b`, and mark `m`. The selected risk terminology is:

| Analysis notation | Selected representation | Exact conversion |
| --- | --- | --- |
| `z` claims | `positionLots` | `z = positionLots / 1000` |
| `b` collateral units | `cashQ` | `b = cashQ / (10^6 * Q)` |
| `m` mark | `qWad` | `m = qWad / 10^18` |
| `P` execution price | `tick` | `P = tick / 1000` |
| `F` funding per claim | `fundingFQPerLot` | `F = fundingFQPerLot / (1000 * Q)` |
| `Q` in analysis A3 | `oiAllLots` | The PDF's `Q` is OI in claims, **not** the cash scale; multiply by 1000. |
| `T` in analysis A3 | aggregate signed collateral | Not the selected spec's scheduled timestamp `T`. |

The selected risk spec section 2.1 and clearing PDF page 4 fix `Q = 10^18`
subunits per USDC atom. There are `10^6` atoms per USDC.

The dimensionally translated identities are:

```text
fillValueQ = lots * tick * Q
positionValueQ = 1000 * positionLots * priceWad
E0 = cashQ
E1 = cashQ + positionLots * (1000 * Q)
E(priceWad) = cashQ + 1000 * positionLots * priceWad
```

There is no further WAD division. One lot at one tick transfers one atom.
17 lots at tick 613 transfer 10,421 atoms. A 1,000-claim long with cash
`-480,000,000 * Q` has NO equity `-480,000,000 * Q`, YES equity
`520,000,000 * Q`, and mark equity `120,000,000 * Q` at 0.6.
The unit helpers convert values only; paired posting and coverage calculations
belong to A003 onward after G0.

Analysis page 5 A7-A11 distinguishes signed conservation from payable positive
claims. Both endpoint deficits must be covered. Its scalar cash-reserve special
case is not a replacement for the selected reserve account with a signed position.
The selected requirement remains `reserveValueQ[y] >= DbarQ[y] + budgetQ`.

## Bounds and rounding

| Input | Representation and accepted domain |
| --- | --- |
| Position | `int128`, inclusive `[-2^40, 2^40]` lots |
| Cash | `int256`, strict `-2^180 < cashQ < 2^180` |
| Live order quantity | `uint64`, nonzero; aggregate orders need wider sums |
| Trading tick | `uint16`, 1 through 999 |
| Settlement price | `uint256`, 0 through `10^18`, including endpoints |
| Live probability | Strictly inside `(0,10^18)`; calibration can further restrict it |
| Funding index / rate | `int256` Q/lot and Q/lot/second; checked products required later |
| Fees / deficits / budgets | `uint256` Q, never atoms |
| Time / epochs / versions | `uint64` seconds or counters; checked increment, never wrap |

The Python immutable records validate these boundaries. Solidity structs specify
the wire types; narrower economic bounds must be checked by the future calculation
libraries and posting functions. Do not infer validation from a struct declaration.
Default zero account epochs/versions are uninitialized values, not permission to
trade. A funding epoch ID is nonzero. Funding input timestamps must obey
`epochStart <= lastAccruedAt <= effectiveStopAt <= epochEnd`, with a nonempty epoch.

Signed floor and ceiling are mathematical directions for either denominator sign.
For example, `floor(-7/3) = -3` and `ceil(-7/3) = -2`. Zero denominators fail.
Reference integers widen without overflow; production checked/wide division belongs
to A009. Requirements and premium round up in Q; usable assets and payouts round
down. Only funding-rate selection explicitly quantizes toward zero. Transfer both
sides of a paired cash movement by the same exact amount. Atom conversion accepts
nonnegative Q only and retains the fractional remainder in its named ledger.

## Pure inputs and explicit outcomes

`AccountInput`, `OrderInput`, `FundingInput`, and `PayoffInput` have matching
Python/Solidity field order, with snake_case/camelCase naming respectively. None
contains storage, token custody, live feed access, or an order-book pointer.

| Boundary | NO | YES | INVALID |
| --- | --- | --- | --- |
| `settle(uint8 Y)` | 0 | 1 | Separate entry point; no numeric Y |
| Engine `FinalOutcome` | 1 | 2 | 3 |
| Source `OracleOutcome` | 2 | 1 | 3 |

Never cast enum ordinals across these boundaries. Use explicit mapping functions;
reject unset outcomes and binary Y outside 0/1. An external oracle's `Voided` state
must be routed explicitly by its adapter to INVALID; no unprovided enum ordinal is
invented here. INVALID prices require independently completed capture and remain
in `[0,WAD]`; accepting a typed payoff record is not authorization to settle.

## Existing book boundary requiring G0 reconciliation

`Book.sol` is unchanged. It uses a 24-bit slot plus an 8-bit generation public ID
and `uint96` order quantities. The packet describes different packed widths.
The risk pure inputs deliberately do not introduce a competing order-key format.
The later risk adapter needs an explicit checked size conversion and a documented
lot-scale mapping before integration can pass. Existing book comments describe
cost in 0.001 USDC; the selected risk lot/tick product is one USDC atom. Neither
interpretation is silently imposed on the book here. `RiskSnapshot.sol` is also
unchanged. No shared integration or adapter compatibility is claimed.

## Reproducible checks

Run from repository root:

```sh
python -m unittest discover -s reference/tests/a -p "test_a001.py"
bash scripts/check-task.sh A001
bash scripts/check-task.sh A002
bash scripts/check-gate.sh G0
```

The last command must fail until actual B001/B002, the G0 contract and combined
Solidity test exist. Passing a task does not accept a gate or authorize the next
block. Runners record actual commands, exit status, source commit/dirty state,
versions, hashes and counts under `artifacts/tasks/` or `artifacts/gates/`.
They never manufacture a merge SHA or reviewer approval.

Python uses only its standard library, with deterministic seed `0x45524f53` and
`PYTHONHASHSEED=0` in the runners. Foundry uses the isolated `risk` profile with
the same fixed fuzz seed. Compiler `0.8.30`, Prague EVM, optimizer 200 remain
the repository's pins. Dependency locks are the existing Git submodule commits:

| Dependency | Commit |
| --- | --- |
| forge-std | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` |
| solady | `2afba69bf67b78dd4abeadcc696052b3a6f71499` |

Repository CI pins Foundry v1.8.3; this machine currently reports v1.5.1. Evidence
records the actual toolchain. A local pass must not be reported as a v1.8.3 CI pass.
No deployment profile, RPC credentials, external addresses, leverage calibration,
or production authorization is introduced.
