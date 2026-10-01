# B checkpoint at G0 (after B001–B002)

**Gate status:** G0 not passed. `docs/spec/gate_status.json` records no merge SHA. Nothing here
marks it passed.

## What the B side satisfies alone

- `docs/math/risk-function-contracts.json`: 31 pure B functions, each with units, explicit domain,
  rounding direction (UP / DOWN / EXACT / TRUNC0) and unavailable/error result. Domain failures
  map to `FULL_BACKING_REQUIRED`; unavailable prices are never 0.
- `docs/ownership.json`: every write file of A001–A044, B001–B044 and the gate files has exactly one
  editor; counterpart paths (Book.sol etc.) are listed as not editable by A or B.
- `docs/counterpart-contracts.md`: CP-BOOK/PRICE/ORACLE/FACTORY/TOKEN/APP boundaries, plus the
  concrete Book.sol hook differences (assumption I-1).
- `reference/fixtures/golden_cases.json`: 20 hand-derived cases (exact ledger values and bracketed
  risk intervals); `docs/math/golden-case-rationale.md` explains each.
- Commands (exit 0 on this branch):
  - `python -m unittest discover -s reference/tests/b -p "test_b001.py"`
  - `python -m unittest discover -s reference/tests/b -p "test_b002.py"`

## Open G0 items that need Person A

1. Toolchain versions (assumption P-5): forge 1.3.5 local vs 1.8.3 in CI; Python 3.13 with NumPy;
   no TypeScript compiler installed. B chose nothing.
2. Units reconciliation: compare A001 `reference/common/units.py` / `MathTypes.sol` with the
   `unit_legend` and `boundary_conversions` in the B function contracts (Q, lots, wad, usdcWad,
   claimsWad).
3. Enum names: B uses spec §7.2 names (`Stage`, `AccountingState`, `PricingMode`, `FinalOutcome`,
   `RejectCode`, `StepStatus`, `AdmissionMode`). A001's `MathTypes.sol` should declare them once.
4. Golden-fixture schema: A's `reference/common/result_schema.json` (A002) must accept the
   `exact` / `interval` kinds used here.
5. `docs/spec/task_migration.json` is missing from the packet, so
   `validate_parallel_plan.py` fails (assumption P-4).

## Combined check to run at merge

```bash
git switch -c integration/w0 <A W0 head>
git merge <B W0 head: feat/risk at the B002 commit>
python -m unittest discover -s reference/tests/a -p "test_a00*.py"
python -m unittest discover -s reference/tests/b -p "test_b00*.py"
python docs/spec/verify_spec_vectors.py
bash scripts/check-gate.sh G0
```

Then diff A's unit constants against `docs/math/risk-function-contracts.json` `unit_legend` and
record the merge SHA in `docs/spec/gate_status.json` only after both reviewers agree.
