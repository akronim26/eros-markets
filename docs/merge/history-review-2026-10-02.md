# Repository history review — 2026-10-02

This read-only history report was delivered before beginning the integration edits.
`git fetch --all --prune` completed successfully; the remote heads matched the handoff.
The starting checkout was clean `feat/risk` at `ffc9f52`.

| Section / branch | Head or milestone | Completed work |
| --- | --- | --- |
| Book, `origin/feat/clob` | `5cbd0cb` | Bitmap price levels, FIFO/recycled orders, matching, LIMIT/IOC/POST_ONLY/reduce-only, batches, admission/snapshot hooks, protocol cancellation/depth, bounded matching and gas/differential/invariant/composition tests. `ff05f0c` makes the fill bound configurable. |
| A accounting lane | `61be284` | A001–A042 and A044: exact reference/Solidity math, custody, reserve capital, funding/premium, rollover, liquidation accounting, freeze, snapshot/payout/claims, SDK ledger reader, invariants and handoff. A043 was explicitly pending. |
| B risk lane | `fecd2fb` | B001–B044: margin/hazard/horizon math, price windows and ingress, configuration, reservations, admission, liquidation/lifecycle, finality/INVALID controllers, previews, SDK views and fixtures. Initial peer integration used stand-ins. |
| Initial A+B source merge, `origin/feat/risk` | `ffc9f52` | Merged A and B trees, but did not yet implement the real joined accounting bridge. |
| Main merge | `494dc72` | Merged the initial risk branch into the book branch. |
| `origin/main` | `c5db208` | Adds `2db4e08`/`c5db208` Monad 128 KiB configuration and `253ebd5` risk formatting. It does not contain the later joined engine. |
| `origin/integration/risk` | `71576ed` | 36 commits absent from main: A audit, provisional-port removal, real A+B composition (`41e32ec`), G0–G7 fixtures/evidence, combined invariants/end-to-end tests, gas, handoff and ABI exports. |
| `origin/feat/oracle` | `0e7a2af` | Main plus one 3,670-line implementation-plan document. No implemented oracle on that branch. |
| Frontend/indexer | Risk SDK and fixtures | Account/market/settlement decoders and accounting event replay exist. A real application/indexer join is not present. |

Main and integration diverge by **4 main-only / 36 integration-only commits**.
Main's formatting overlaps B files changed during integration; `foundry.toml`
also differs. Those changes need deliberate reconciliation before a main merge.
This review does not merge main, rewrite history, or remove branches.

At inspection, local `main` still pointed to `3cfa48d` and was 121 commits behind
`origin/main`. The local `origin/HEAD` symbolic reference still pointed to
`origin/feat/clob`. A local rename/push does not by itself change that reference.

## Handoff claims independently reproduced

On the integration baseline, local Forge 1.5.1 reproduced **609 passing tests and
8 failing BookGas tests**, excluding the three deliberately failing A audit
reproducers. The eight failures all reported unsupported cheatcode `0x04eedcdf`.
Python baseline: A 42, B 156, integration 7; audit 8 passed after installing its
missing NumPy dependency in an isolated temporary directory.

The review switches validation to the repository's existing CI pin, Forge 1.8.3.
New results and source-bound review evidence are separate from these historical
counts. See `toolchain-reproduction.md`, `A-integration-review.md`, and
`artifacts/reviews/A-on-B.md` for the follow-on work.

## What remains outside the local integration

The real book has ten documented seam mismatches, including per-fill atomic
posting, exact reservation epochs, unrest identity and forced reduction.
Oracle, price collector and factory remain counterpart work. Risk test results
use deterministic external mocks, not live integrations. Real production
composition size, Monad gas, calibration, addresses and release approvals remain open.
