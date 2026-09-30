# Risk implementation progress

## Current authorization (supersedes the previous stopping point)

The user now explicitly requests **all A work without waiting for B**, with a
later merge. Work proceeds through the A backlog using specified interfaces and
scripted decision inputs. Combined G0-G7 acceptance and independent review remain
pending; A tests do not count as an A+B pass. Uncommitted B work from the
interrupted scope expansion has been removed. Book code remains protected.
The historical W0 report below records the previous checkpoint; subsequent blocks
will be appended with their actual tests and commits.

### A003-A015: independent accounting math (implemented)

Added the Fraction ledger, order-aware coverage, fixed-epoch funding, clipped
premium integration, surcharge/capitalization, payout/fee/capital references and
directed integer bounds. Added pure Solidity QMath, LedgerMath, FundingMath,
PremiumMath, CoverageMath, FeeMath and SettlementMath. The independent exporter
produces 64 exact ledger and 32 premium vectors without calling Solidity.

Validation: 15 new Python reference tests pass; 13 Solidity math tests pass,
including two 1,000-run fuzz tests. Premium comparisons enforce the documented
strict <12-Q conservative bound; cumulative posting is touch-independent. No B
algorithms are implemented. These are A-local checks, not G1/G2 acceptance.

Updated: 2026-10-01. Scope: the supplied Person A packet, selected specification
v1.1 / economic baseline v1.0. Starting commit:
`3cfa48d69e799b73f92a9955fdc7932c08cd925f` on `feat/risk`.

## Scope and source decisions

- The user's request authorizes implementation, a progress file, and local commits.
  The order book is explicitly excluded. No production deployment is requested.
- The supplied `START_A.md`, task list and implementation plan define the Person A
  dependency sequence. A001/A002 precede shared G0; stateful work requires G2.
- `full-risk-analysis.pdf` pages 4-5 were rendered and inspected for ledger,
  endpoint-backing and reserve identities. `Eros_Risk_Clearing_Specification.pdf`
  page 4 was rendered and checked against `risk_spec.md` section 2.1.
- Formula names follow the selected risk spec: `cashQ`, `positionLots`, prices in
  WAD, funding in Q/lot. The analysis PDF's `Q` means OI, not the cash scale.
  [Unit mapping and reconciliation notes](docs/math/units.md) give the translation.
- No B-owned economic implementation, peer approval, accepted gate commit, live
  counterpart integration, calibration, or production result is claimed.

## Implemented changes

### A001: units and pure calculation inputs

- `reference/common/units.py`: exact lot/tick/atom/Q conversions, signed floor and
  ceiling, strict cash bounds, inclusive position bounds, checked versions,
  explicit binary/oracle outcome mappings and immutable validated input records.
- `contracts/src/math/MathTypes.sol`: matching constants, account/order/funding/
  payoff inputs, explicit outcome mappings and named signed-rounding policies.
  These are memory/input types, not vault storage. Production domain validators
  and arithmetic libraries remain assigned to later tasks.
- `reference/tests/a/test_a001.py`: 12 tests, including deterministic signed
  rounding comparisons against Python Fraction, 17 lots at tick 613, mark scaling,
  fractional payout rounding, boundary rejection and enum mismatch handling.
- `docs/math/units.md`: formula provenance, domains, rounding, dependency pins,
  runner usage and the book boundary requiring later reconciliation.

### A002: runners, exact result schema and reproducibility

- `scripts/check-task.sh`: isolated A/B discovery, nonempty-suite checks, test
  execution and machine-readable evidence. Missing, failing, skipped and expected-
  failing Python tests cannot pass. Solidity tasks require actual successful test
  results from Forge, not just a zero command exit. W7 specialized campaign/review
  checks fail explicitly until those deliverables exist.
- `scripts/check-gate.sh`: checks shared artifacts, both actual task lanes and the
  combined Solidity suite. Later gates require a reviewed predecessor commit.
  Technical passes never fabricate an accepted merge or reviewer identity.
- `reference/common/result_schema.json`: command/toolchain/source provenance,
  component status, hashes, test counts and exact rational/interval fixture values.
  Large values use decimal strings, never JSON floating-point numbers.
- `contracts/foundry.toml`: a separate `risk` test profile with deterministic seed
  `0x45524f53`. Existing compiler, default and CI book profiles remain unchanged.
- `reference/tests/a/test_a002.py`: runner smoke, negative-path and actual Forge
  execution checks in disposable directories. Temporary B/gate smoke scaffolding
  tests the runner only; it is not B001/B002 or shared G0 acceptance.

## Verification and commits

| Check | Actual result |
| --- | --- |
| `bash scripts/check-task.sh A001` | PASS, 12 tests, exit 0 |
| `bash scripts/check-task.sh A002` | PASS, 15 tests, exit 0 |
| `forge fmt --check src/math/MathTypes.sol` from `contracts/` | PASS, exit 0 |
| `forge build --sizes` from `contracts/` | PASS with warnings, exit 0 |
| `FORGE_SNAPSHOT_EMIT=false forge test --json` from `contracts/` | PASS, all 110 existing book tests in 9 suites, exit 0 |
| `bash scripts/check-gate.sh G0` | BLOCKED, missing real shared/B inputs, expected exit 2 |
| Protected book/snapshot tracked diff | Empty |

The 27 passing Python tests include actual Forge runner smoke and negative tests.
They are foundation verification, not a completed risk engine or G0 acceptance.
The reference arithmetic smoke scenarios supplied in `spec_vector_results.json`
were read as source context; no fresh execution of its NumPy verification script
or passing reference-engine gate is claimed.

Recorded evidence: [A001](artifacts/tasks/A001.json),
[A002](artifacts/tasks/A002.json), [G0](artifacts/gates/G0.json), and
[build/book regression/source hashes](artifacts/validation/W0.json).
The evidence records the actual source base and dirty worktree at execution time;
the corresponding tested implementation is captured in the task commits.

Scratch PDF renders/text and Python caches remain only on this machine, excluded
through `.git/info/exclude`. Automatic approval review blocked recursive scratch
deletion with `blocked by policy`; no source-file deletion was attempted afterward.

Local commits:

- `7c65d46`: `feat(risk): define A001 exact units and pure math inputs`.
- `10c56cc`: `test(risk): add A002 fail-closed task and gate runners`.
- Progress/evidence are committed separately after the implementation commits.

Local tools: Python 3.12, Foundry 1.5.1, Solc 0.8.30. Repository CI specifies
Foundry 1.8.3; these local results are not a claim to have run that CI toolchain.
The already pinned forge-std and solady submodules were initialized, without
changing their Git commits. Test evidence records dirty state honestly.

## Gates and remaining tasks

G0 is **pending**, not accepted. B001/B002 are absent from this repository:
`docs/math/risk-function-contracts.json`, `docs/ownership.json`,
`docs/counterpart-contracts.md`, `reference/fixtures/golden_cases.json`,
`docs/math/golden-case-rationale.md`, and both B unit suites.
The reconciled `docs/contracts/G0.json` and `contracts/test/gates/G0.t.sol` cannot
be finalized until both lanes agree. No passing gate SHA or reviewer is invented.

The book uses uint96 quantities and an 8-bit generation/24-bit slot ID, unlike
the packet's proposed packed book. Its cost comment also uses a different stated
cash unit. Later integration must reconcile these through a risk adapter and
counterpart agreement; `Book.sol`, `RiskSnapshot.sol`, book tests and snapshots
remain untouched.

| Task | Deliverable | Current state / prerequisite |
| --- | --- | --- |
| A001 | Units and pure input types | Implemented; local checks passed; G0 review pending |
| A002 | Runners and evidence schema | Implemented; 15 local checks passed; G0 review pending |
| A003 | Rational ledger and terminal equity | Not started; G0 |
| A004 | Order deficits and reserve calculations | Not started; G0, A003 |
| A005 | Funding transition reference | Not started; G0, A003-A004 |
| A006 | Clipped-affine premium integration | Not started; G0, A005 |
| A007 | Surcharge and epoch capitalization | Not started; G0, A006 |
| A008 | Payout, fee and capital arithmetic | Not started; G0, A003 |
| A009 | Directed integer primitives | Not started; G0, A003 |
| A010 | Solidity ledger/payoff primitives | Not started; G1 |
| A011 | Funding budget and cushion math | Not started; G1, A010 |
| A012 | Premium integral and tariff math | Not started; G1, A010 |
| A013 | Exposure, fee and reserve math | Not started; G1, A010 |
| A014 | Settlement and capital math | Not started; G1, A010 |
| A015 | Accounting differential tests | Not started; G1, A011-A014 |
| A016 | Storage and account registry | Not started; G2 |
| A017 | Collateral custody/allocation | Not started; G2, A016 |
| A018 | Paired posting and fees | Not started; G2, A016 |
| A019 | Live reserve coverage | Not started; G2, A018 |
| A020 | Reserve shares and backstop | Not started; G2, A017, A019 |
| A021 | Internal accounting ports | Not started; G2, A017-A020 |
| A022 | Stateful fixed-epoch funding | Not started; G3 |
| A023 | Stateful premium/surcharge | Not started; G3 |
| A024 | Account touch sequence | Not started; G3, A022-A023 |
| A025 | Bounded rollover | Not started; G3, A024 |
| A026 | Atomic clearing composition | Not started; G3, A024-A025 |
| A027 | Fee/withdrawal/conservation tests | Not started; G3, A026 |
| A028 | Authorized whole-account takeover | Not started; G4 |
| A029 | Liquidation fee and keeper escrow | Not started; G4, A028 |
| A030 | Epoch-to-halt freeze | Not started; G4 |
| A031 | Floor-sweep accounting | Not started; G4, A028, A030 |
| A032 | Events and reconciliation reader | Not started; G4, A029-A031 |
| A033 | Interrupted liquidation tests | Not started; G4, A028-A032 |
| A034 | Frozen account materialization | Not started; G5 |
| A035 | Payout preparation and escrow | Not started; G5, A034 |
| A036 | Disabled recovery calculator | Not started; G5, A035 |
| A037 | Once-only claims | Not started; G5, A035-A036 |
| A038 | Terminal reserve/fee release | Not started; G5, A037 |
| A039 | Batch payout/custody tests | Not started; G5, A034-A038 |
| A040 | Accounting invariant campaign | Not started; G6 |
| A041 | Accounting/sweep gas | Not started; G6, A040 |
| A042 | Custody and capital exit reconciliation | Not started; G6, A040 |
| A043 | Review B decision/callback boundaries | Not started; G6, A040 |
| A044 | Accounting handoff evidence | Not started; G6, A041-A043 |

G1-G7 remain not started. Real external counterpart joins remain untested.
The next integration action is to obtain the B001/B002 work, reconcile G0 against
these proposed types, and run the combined gate before A003-A009 begin.
